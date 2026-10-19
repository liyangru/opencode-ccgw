// server.mjs — ccgw: local OpenCode-backed gateway for Claude Code / Codex /
// Claude Desktop / any Anthropic- or OpenAI-compatible client.
//
//   client -> this server -> OpenCode V2 HTTP API -> free models
//
// Every request runs as a real (throwaway) OpenCode session. Client tools are
// exposed to OpenCode through a per-request stdio MCP bridge; tool calls are
// captured, the OpenCode turn is interrupted, and the calls are handed back to
// the client for execution (tool results return in the client's next request).
// Sessions are not deleted per request — deleting one seconds after creating
// it races with UI clients syncing new sessions (desktop "Session not found"
// toasts); idle sessions are swept instead (see sweepOldSessions).
//
// Endpoints:
//   POST /v1/messages              Anthropic Messages (incl. ?beta=true)
//   POST /v1/messages/count_tokens
//   POST /v1/chat/completions      OpenAI Chat Completions
//   POST /v1/responses             OpenAI Responses (Codex)
//   GET  /v1/models                model list (Anthropic or OpenAI shape)
//   GET  /health
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"
import {
  OpenCode,
  installGatewayPlugin,
  discoverService,
  runTurn,
  putBridge,
  deleteBridge,
  sweepOldSessions,
  writeManifest,
  removeManifest,
  buildNameMap,
  planBridgeTools,
  unpackDispatcherCalls,
  sleep,
} from "./engine.mjs"
import {
  parseAnthropic,
  parseOpenAI,
  parseResponses,
  applyToolChoice,
  renderPrompt,
  anthropicNonStream,
  openaiNonStream,
  responsesNonStream,
  makeAnthropicStream,
  makeOpenAIStream,
  makeResponsesStream,
  modelsAnthropic,
  modelsOpenAI,
  countTokensApprox,
} from "./formats.mjs"
import { describeRanked, fallbackChain as fallbackChainFn, isFreeModel, loadRankConfig, pickModel, rankFree } from "./ranking.mjs"
import { classifyError } from "./errors.mjs"
import { loadCooldowns, saveCooldowns } from './cooldowns.mjs'
import {attachEgress,readEgressKey} from './egress.mjs'
import { rotateEgress, waitForIdle, loadState, loadConfig, planRotate, DEFAULT_CONFIG } from './nord-rotate.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.CCGW_PORT || 8317)
const HOST = process.env.CCGW_HOST || "127.0.0.1"
const PIN = process.env.CCGW_MODEL || "" // optional explicit model pin; empty = auto (top-ranked free)
const FALLBACK_MODEL = "deepseek-v4.1-flash-free" // last resort when no free model list is known
const SCRATCH = process.env.CCGW_SCRATCH || path.join(os.tmpdir(), "ccgw-scratch")
const LOG_FILE = process.env.CCGW_LOG || path.join(__dirname, "ccgw.log")
const TOKEN = process.env.CCGW_TOKEN || ""
const MAX_CONCURRENCY = Number(process.env.CCGW_MAX_CONCURRENCY || 3)
const TURN_TIMEOUT = Number(process.env.CCGW_TURN_TIMEOUT || 180000)
// Free models spend part of the output budget on hidden reasoning. A client
// asking for a tiny max_tokens (e.g. 16) otherwise makes the upstream fail with
// "Response still truncated ...", which used to walk the whole model chain.
const MIN_OUTPUT_BUDGET = 512
const MAX_OUTPUT_BUDGET = 8192
const KEEP_SESSIONS = process.env.CCGW_KEEP_SESSIONS === "1"
const STATE_FILE = process.env.CCGW_STATE_FILE || path.join(__dirname,'.ccgw-state.json')
let egress = null

fs.mkdirSync(SCRATCH, { recursive: true })
installGatewayPlugin(SCRATCH)

// ---------------------------------------------------------------------------
// Account pool + live model list
//
// One OpenCode service per account. With CCGW_ACCOUNTS_FILE set (accounts.json
// listing {name, url, serviceFile}), requests are spread round-robin across
// accounts; an account that hits a rate limit or goes down is put on cooldown
// and the turn is retried on the next account before anything has been sent
// to the client. Without the file, the gateway behaves exactly like before:
// one discovered service, no rotation.

const ACCOUNTS_FILE = process.env.CCGW_ACCOUNTS_FILE || ""
const COOLDOWN_SECONDS = Number(process.env.CCGW_COOLDOWN_SECONDS || 300)
const DOWN_COOLDOWN_SECONDS = Number(process.env.CCGW_DOWN_COOLDOWN_SECONDS || 30)
// A geo-blocked model is refused for this exit region only; a short cooldown
// keeps sibling requests from re-hitting the same wall while the egress
// rotator looks for a region where the model is served.
const GEO_COOLDOWN_SECONDS = Number(process.env.CCGW_GEO_COOLDOWN_SECONDS || 180)

function loadAccounts() {
  if (ACCOUNTS_FILE && fs.existsSync(ACCOUNTS_FILE)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"))
      const base = path.dirname(ACCOUNTS_FILE)
      const list = []
      for (const a of Array.isArray(cfg.accounts) ? cfg.accounts : []) {
        if (!a || !a.url) continue
        let password = ""
        if (a.serviceFile) {
          const sf = path.isAbsolute(a.serviceFile) ? a.serviceFile : path.join(base, a.serviceFile)
          try {
            password = JSON.parse(fs.readFileSync(sf, "utf8")).password || ""
          } catch {}
        }
        list.push({ name: String(a.name || "acct" + (list.length + 1)), baseUrl: String(a.url).replace(/\/+$/, ""), password, email: a.email || "", identity: a.identity || "", credentialId: a.credentialId || "" })
      }
      if (list.length) return { pool: true, list }
      console.log("[ccgw] accounts file has no usable entries; using single service")
    } catch (e) {
      console.log("[ccgw] accounts file unusable, falling back to single service:", e.message)
    }
  }
  const d = discoverService()
  return { pool: false, list: [{ name: "default", baseUrl: d.baseUrl, password: d.password }] }
}

const poolCfg = loadAccounts()
const POOL = poolCfg.pool
const accounts = poolCfg.list.map((a) => ({
  name: a.name,
  client: new OpenCode({ baseUrl: a.baseUrl, password: a.password }),
  password: a.password,
  email: a.email || "",
  identity: a.identity || "",
  credentialId: a.credentialId || "",
  coolingUntil: 0,
  rateLimits: new Map(),
  fails: 0,
  lastError: null,
  lastLimited: false,
  modelCache: { at: 0, ids: [], list: [] },
}))
loadCooldowns(STATE_FILE, accounts)
function persistCooldowns() {
  try { saveCooldowns(STATE_FILE,accounts) }
  catch { console.error('[ccgw] 无法保存限流冷却状态，请检查运行目录的写入权限') }
}
for (const a of accounts) {
  console.log("[ccgw] account " + a.name + (a.email ? " <" + a.email + ">" : "") + " -> " + a.client.baseUrl + " " + (a.password ? "(auth ok)" : "(no password)"))
  a.client.startEventStream((e) => console.log("[ccgw] " + a.name + ": event stream error:", e.message))
}
console.log("[ccgw] mode:", POOL ? "account pool (" + accounts.length + " instance(s))" : "single service")

// Single-account mode only: the desktop app may restart its background service
// on a new port; if the event stream drops and stays down, rediscover. Pool
// accounts point at fixed headless servers and reconnect on their own.
if (!POOL) {
  const primary = accounts[0]
  let rediscovering = false
  setInterval(async () => {
    if (primary.client.connected || rediscovering) return
    rediscovering = true
    try {
      const d = discoverService()
      if (d.baseUrl !== primary.client.baseUrl || d.password !== primary.password) {
        console.log("[ccgw] service moved:", primary.client.baseUrl, "->", d.baseUrl)
        primary.client.baseUrl = d.baseUrl
        primary.password = d.password
        primary.client.auth = "Basic " + Buffer.from("opencode:" + (d.password || "")).toString("base64")
        primary.client.stopEventStream()
        await sleep(150)
        primary.client.startEventStream((e) => console.log("[ccgw] event stream error:", e.message))
      }
    } catch (e) {
      console.log("[ccgw] rediscovery failed:", e.message)
    } finally {
      rediscovering = false
    }
  }, 15000)
}

// Throwaway sessions are cleaned up by an idle sweep instead of per request:
// deleting a session seconds after creating it races with clients that sync
// sessions (the desktop app prefetches every session.created event and toasts
// "Session not found" when its fetch lands after the delete). Each account has
// its own session store, so sweep them all.
if (!KEEP_SESSIONS) {
  const sweepAll = async () => {
    for (const a of accounts) {
      try {
        const n = await sweepOldSessions(a.client, { dir: SCRATCH, log: (m) => logLine({ phase: "sweep", msg: a.name + ": " + m }) })
        if (n) console.log("[ccgw] " + a.name + ": swept", n, "idle session(s)")
      } catch {}
    }
  }
  sweepAll()
  const every = Number(process.env.CCGW_SWEEP_INTERVAL_MINUTES || 10)
  if (every > 0) setInterval(sweepAll, every * 60 * 1000).unref()
}

async function accountModels(a) {
  if (Date.now() - a.modelCache.at < 60000 && a.modelCache.ids.length) return a.modelCache
  try {
    const r = await a.client.req("GET", "/api/model?location[directory]=" + encodeURIComponent(SCRATCH), undefined, { timeoutMs: 5000 })
    // This bridge runs the native OpenCode provider. Other locally configured
    // providers (including ccgw itself) are not part of that upstream catalog.
    const data = (r.json?.data || []).filter((m) => m.providerID === 'opencode')
    a.modelCache = {
      at: Date.now(),
      ids: data.map((m) => m.id),
      list: data.map((m) => ({
        id: m.id,
        name: m.name || m.id,
        providerID: m.providerID || "opencode",
        free: m.enabled !== false && isFreeModel(m.id, m),
        input: Array.isArray(m.capabilities?.input) ? m.capabilities.input : null,
        context: m.limit?.context || null,
      })),
    }
  } catch (e) {
    console.log("[ccgw] " + a.name + ": model list fetch failed:", e.message)
  }
  return a.modelCache
}

// Union of every account's model list (in practice the lists are identical;
// the union keeps routing correct while accounts are cooling down or booting).
async function knownModels() {
  const byId = new Map()
  for (const a of accounts) {
    const c = await accountModels(a)
    for (const m of c.list) {
      const prev = byId.get(m.id)
      if (prev) {
        prev.free = prev.free || m.free
        if (Array.isArray(prev.input) && Array.isArray(m.input)) prev.input = [...new Set([...prev.input, ...m.input])]
        else if (!prev.input && m.input) prev.input = m.input
        if (!prev.context && m.context) prev.context = m.context
        continue
      }
      byId.set(m.id, { ...m })
    }
  }
  const list = [...byId.values()]
  return { ids: list.map((m) => m.id), list }
}

// ---------------------------------------------------------------------------
// Account selection: round-robin, skipping cooling accounts

let rr = 0
function readyAt(a, model) {
  return Math.max(a.coolingUntil, a.rateLimits.get(model)?.until || 0)
}

function pickAccount(tried, model) {
  const now = Date.now()
  const candidates = accounts.filter((a) => !tried.has(a.name) && readyAt(a, model) <= now)
  if (!candidates.length) return null
  const pick = candidates[rr % candidates.length]
  rr++
  return pick
}

function coolDown(a, reason, seconds, model, retryAfterSeconds) {
  // consecutive failures double the cooldown (a fully spent quota should not
  // be retried every few minutes); markOk() resets it after a success
  const previous = model ? a.rateLimits.get(model) : null
  const fails = model ? previous?.fails || 0 : a.fails
  const secs = retryAfterSeconds || Math.min(seconds * 2 ** Math.min(fails, 10), 1800)
  if (model) a.rateLimits.set(model, { until: Math.max(previous?.until || 0, Date.now() + secs * 1000), fails: fails + 1, message: reason })
  else {
    a.coolingUntil = Math.max(a.coolingUntil, Date.now() + secs * 1000)
    a.fails++
  }
  a.lastError = reason
  a.lastLimited = !!model
  console.log("[ccgw] cooldown " + a.name + " for " + secs + "s: " + reason)
  logLine({ phase: "cooldown", account: a.name, model: model || null, seconds: secs, source: retryAfterSeconds ? "provider-retry-after" : "local-backoff", msg: reason })
  notePoolState()
  persistCooldowns()
}

function markOk(a, model, started) {
  // A successful in-flight request must not clear another request's newer failure.
  if (a.coolingUntil === started.networkUntil) {
    a.fails = 0
    a.coolingUntil = 0
  }
  if (a.rateLimits.get(model) === started.rateLimit) a.rateLimits.delete(model)
  if (a.coolingUntil <= Date.now() && ![...a.rateLimits.values()].some((r) => r.until > Date.now())) {
    a.lastError = null
    a.lastLimited = false
  }
  notePoolState()
  persistCooldowns()
}

// A 429 is scoped conservatively to the requested account/model pair.
// One model's limit is not evidence that every model or the whole IP is limited.
let lastQuotaState = false
function poolState() {
  const now = Date.now()
  const cooling = accounts.filter((a) => a.coolingUntil > now || [...a.rateLimits.values()].some((r) => r.until > now))
  const knownFree = [...new Set(accounts.flatMap((a) => a.modelCache.list.filter((m) => m.free).map((m) => m.id)))]
  const limitedModels = knownFree.filter((id) => accounts.every((a) => (a.rateLimits.get(id)?.until || 0) > now))
  const quotaExhausted = accounts.length > 0 && knownFree.length > 0 && limitedModels.length === knownFree.length
  // total/loggedIn/anonymous count INSTANCES, not distinct accounts: one account
  // may be logged in on several instances, and that does not stack quota.
  const loggedIn = accounts.filter((a) => a.identity).length
  const distinctAccounts = new Set(accounts.map((a) => a.email).filter(Boolean)).size
  return { total: accounts.length, loggedIn, distinctAccounts, anonymous: accounts.length - loggedIn, cooling: cooling.length, quotaExhausted, limitedModels }
}

function retrySeconds(model) {
  return Math.max(0, Math.ceil((Math.min(...accounts.map((a) => readyAt(a, model))) - Date.now()) / 1000))
}

function coolingError(model) {
  const seconds = Math.max(1, retrySeconds(model))
  const limited = accounts.some((a) => (a.rateLimits.get(model)?.until || 0) > Date.now())
  return Object.assign(new Error(`No ready OpenCode instance for ${model}. Retry in ${seconds}s (local gateway cooldown, not the provider's quota reset time).`), {
    status: limited ? 429 : 503, retryAfterSeconds: seconds,
  })
}
function notePoolState() {
  const s = poolState()
  if (s.quotaExhausted === lastQuotaState) return
  lastQuotaState = s.quotaExhausted
  if (s.quotaExhausted) {
    console.log("[ccgw] [net] all known free models rate-limited across " + accounts.length + " instance(s)")
    logLine({ phase: "net", event: "quota-exhausted", accounts: accounts.map((a) => a.name) })
  } else {
    console.log("[ccgw] [net] quota state cleared")
    logLine({ phase: "net", event: "quota-cleared" })
  }
}

// ---------------------------------------------------------------------------
// Exit rotation (Nord): a per-IP rate limit or an IP-level admission ban is
// fixed by leaving through a different Nord node (user instruction 2026-10-19:
// when quota is exhausted or the IP is refused, switch nodes automatically).
// nord-rotate.mjs owns the guard (min interval, hourly cap, optional config
// file); this file only decides when the signal is real.

let nordRotating = false
// How many turns are talking to upstream right now. A Nord disconnect tears
// down the tunnel under every one of them, so a rotation waits for the others
// to finish (bounded by CCGW_NORD_DRAIN_MS) instead of cutting a live stream.
let activeTurns = 0
const NORD_DRAIN_MS = Math.max(0, Number(process.env.CCGW_NORD_DRAIN_MS ?? 15000) || 0)
let accessDenials = []
function poolWideLimited(model) {
  const now = Date.now()
  return (
    accounts.length > 0 &&
    accounts.some((a) => (a.rateLimits.get(model)?.until || 0) > now) &&
    accounts.every((a) => readyAt(a, model) > now)
  )
}

// Read-only view of the rotation guard for /health: a monitor can alert on a
// stuck or exhausted guard without parsing ccgw.log.
function nordStatus() {
  let state = { events: [] }
  let cfg = DEFAULT_CONFIG
  try { state = loadState() } catch {}
  try { cfg = loadConfig() } catch {}
  const d = planRotate(state, Date.now(), cfg)
  const last = [...(state.events || [])].reverse().find((e) => e.ok) || null
  return {
    rotating: nordRotating,
    activeTurns,
    drainMs: NORD_DRAIN_MS,
    lastGroup: state.lastGroup || null,
    lastAt: state.lastAt || null,
    lastIp: last?.ip || null,
    guard: { ok: !!d.ok, reason: d.reason || null, waitSec: d.waitSec || null, inHour: d.inHour ?? null },
  }
}

function rotateEgressAndReset(reason) {
  // Rotate once, then drop local rate-limit cooldowns: they were recorded
  // against the old exit IP, and the next attempt is exactly what decides
  // whether the new node has fresh quota. Network-level cooldowns (instance
  // unreachable) are left alone - they are unrelated to the exit IP.
  if (nordRotating) return Promise.resolve({ rotated: false, reason: "in-flight" })
  nordRotating = true
  return (async () => {
    // This request counts as one active turn; anything above that is another
    // turn whose upstream socket would die with the tunnel. Wait for it, and
    // if it does not finish in time, skip the rotation entirely rather than
    // cutting a live (possibly streaming) response. The next request retries.
    const drain = await waitForIdle(() => activeTurns, { idleAt: 1, timeoutMs: NORD_DRAIN_MS })
    if (!drain.drained) {
      logLine({ phase: "nord-rotate", event: "deferred", reason, activeTurns, waitedMs: drain.waitedMs, msg: "other turns are still running; rotation skipped so their upstream connection is not cut" })
      return { rotated: false, reason: "busy" }
    }
    if (drain.waitedMs > 0) {
      logLine({ phase: "nord-rotate", event: "drained", reason, waitedMs: drain.waitedMs, msg: "waited for in-flight turns before rotating the exit" })
    }
    const r = await rotateEgress({ reason, log: (evt, msg) => logLine({ phase: "nord-rotate", event: evt, msg }) })
    if (!r?.rotated) return r
    let cleared = 0
    for (const a of accounts) {
      cleared += a.rateLimits.size
      a.rateLimits.clear()
    }
    accessDenials = []
    if (cleared) {
      notePoolState()
      persistCooldowns()
    }
    logLine({ phase: "nord-rotate", event: "cooldowns-cleared", reason, group: r.group || null, ip: r.ip || null, cleared, msg: "new exit IP; local rate-limit cooldowns cleared so the next request retries immediately" })
    return r
  })()
    .catch((e) => {
      logLine({ phase: "nord-rotate", event: "error", reason, msg: String(e?.message || e) })
      return { rotated: false, reason: "error" }
    })
    .finally(() => {
      nordRotating = false
    })
}

// ---------------------------------------------------------------------------
// Small utilities

class Semaphore {
  constructor(n) {
    this.n = n
    this.q = []
  }
  async acquire() {
    if (this.n > 0) {
      this.n--
      return
    }
    await new Promise((r) => this.q.push(r))
  }
  release() {
    const r = this.q.shift()
    if (r) r()
    else this.n++
  }
}
const sem = new Semaphore(MAX_CONCURRENCY)

function logLine(obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj })
  fs.appendFile(LOG_FILE, line + "\n", () => {})
}

function readBody(req, limit = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on("data", (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error("request body too large"))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    // Tolerate a UTF-8 BOM some clients/shells prepend to JSON bodies.
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "")))
    req.on("error", reject)
  })
}

function json(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) })
  res.end(body)
}

function errorShape(dialect, message, status = 500, code = null) {
  const failure = classifyError({ message, status })
  const type = status === 400 ? "invalid_request_error" : failure.type
  if (dialect === "anthropic") return { type: "error", error: { type, message } }
  return { error: { message, type, ...(dialect === "openai" ? { param: null } : {}), code: code ?? failure.code } }
}

function authed(req) {
  if (!TOKEN) return true
  // Local, direct requests stay key-free so this machine's own clients keep
  // working. Traffic carrying forwarding headers (cloudflared tunnel, reverse
  // proxies) counts as remote even though it lands on loopback.
  const remote = req.socket.remoteAddress || ""
  const local = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1"
  const forwarded = req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]
  if (local && !forwarded) return true
  const auth = req.headers["authorization"] || ""
  const xk = req.headers["x-api-key"] || ""
  return auth === "Bearer " + TOKEN || xk === TOKEN || auth === "Basic " + Buffer.from("opencode:" + TOKEN).toString("base64")
}

// ---------------------------------------------------------------------------
// One gateway turn

async function handleTurn({ dialect, body, req, res }) {
  const reqId = crypto.randomBytes(6).toString("hex")
  const t0 = Date.now()
  const ac = new AbortController()
  const onClose = () => {
    if (!res.writableFinished) ac.abort()
  }
  res.once('close', onClose)
  if (req.aborted || res.destroyed) { ac.abort(); return }

  // Temp cleaners may delete the scratch dir while the gateway runs; recreate
  // it so model listing, bridge registration and session creation keep working.
  try { fs.mkdirSync(SCRATCH, { recursive: true }) } catch {}

  const canon = dialect === "anthropic" ? parseAnthropic(body) : dialect === "openai" ? parseOpenAI(body) : parseResponses(body)
  applyToolChoice(canon, body.tool_choice)
  // An empty conversation used to be forwarded upstream, where the model would
  // answer from whatever session state it had. Every supported API requires at
  // least one message; reject it before touching the pool.
  if (!canon.messages.length) {
    return json(res, 400, errorShape(dialect, "messages: at least one message is required", 400, "invalid_request"))
  }

  const models = await knownModels()
  if (ac.signal.aborted || res.destroyed) return
  const rankCfg = loadRankConfig()
  const ranked = rankFree(models.list, rankCfg.order)
  const freeSet = new Set(models.list.filter((m) => m.free).map((m) => m.id))
  const pick = pickModel({ requested: canon.model, ids: new Set(models.ids), freeSet, ranked, slots: rankCfg.slots, pin: PIN, fallback: FALLBACK_MODEL, hasFiles: !!canon.files?.length, visionTrusted: rankCfg.visionTrusted })
  const model = pick.model
  const supportsImage = (id) => !!models.list.find(m=>m.id===id)?.input?.includes('image')
  if(canon.files?.length && !supportsImage(model)) {
    return json(res,400,{error:{type:'invalid_request_error',message:'所选模型不支持图片，请选择支持图片的模型：glm-5.3-flash-free / nemotron-3.5-super-vl-free / mimo-v2.6-flash-free。'}})
  }
  const inputTokens = countTokensApprox(canon)

  let bridgeName = null
  let manifest = null
  let nameMap = null
  let routing = null
  let dispatcherOriginal = null
  if (canon.tools.length) {
    bridgeName = "gw" + crypto.randomBytes(6).toString("hex")
    // Client tool lists can exceed the upstream limits (name length 64, list
    // size 128): name-map with the bridge prefix budgeted, and route any
    // overflow through one dispatcher tool.
    const plan = planBridgeTools(canon.tools)
    const bridgeTools = plan.dispatcher ? [...plan.direct, plan.dispatcher] : plan.direct
    nameMap = buildNameMap(bridgeTools, { prefix: bridgeName })
    if (plan.dispatcher) {
      dispatcherOriginal = plan.dispatcher.name
      routing = { overflow: new Set(plan.overflow.map((t) => t.name)), dispatcher: nameMap.origToSan.get(plan.dispatcher.name) }
    }
    const sandboxTools = bridgeTools.map((t) => ({
      name: nameMap.origToSan.get(t.name),
      description: t.description,
      inputSchema: t.inputSchema,
    }))
    manifest = writeManifest(sandboxTools)
  }

  const promptText = renderPrompt(canon, bridgeName, nameMap?.origToSan, routing)

  // Model-level fallback chain (see ranking.mjs fallbackChain()).
  const fallback = fallbackChainFn({
    ranked, model, source: pick.source,
    imageOk: supportsImage, hasFiles: !!canon.files?.length,
    visionTrusted: rankCfg.visionTrusted,
  })

  let stream = null
  const startStream = () => {
    if (!canon.stream || stream) return
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    })
    res.flushHeaders?.()
    const send = (eventName, data) => {
      if (res.writableEnded) return
      let frame = ""
      if (eventName) frame += "event: " + eventName + "\n"
      frame += "data: " + (typeof data === "string" ? data : JSON.stringify(data)) + "\n\n"
      res.write(frame)
    }
    stream =
      dialect === "anthropic"
        ? makeAnthropicStream(send, canon.model || model, inputTokens)
        : dialect === "openai"
          ? makeOpenAIStream(send, canon.model || model, inputTokens)
          : makeResponsesStream(send, canon.model || model, inputTokens)
  }

  let sid = null
  let result = null
  let error = null
  let account = null
  let emitted = false
  const tried = new Set()
  // At most one Nord exit rotation (and one same-model retry on the new exit)
  // per request: a second rate limit after rotating is not a stale-IP signal.
  let nordRetried = false
  // Geo restrictions ("not available in your country") are exit-country
  // specific: count them so a chain that is blocked end to end can rotate the
  // exit once and replay itself instead of failing the request.
  let geoBlocks = 0
  let activeModel = model
  // The model that actually served the turn (may differ from the requested slot
  // after a model-level fallback). activeModel is cleared on success, so keep a
  // copy for the log line.
  let usedModel = null
  // Give the upstream room for hidden reasoning even when the client asks for a
  // tiny response. The client-facing text is still what the model returns.
  let outputBudget = canon.maxOutputTokens ? Math.max(Number(canon.maxOutputTokens) || 0, MIN_OUTPUT_BUDGET) : undefined
  let outputRetries = 0
  try {
    // A rotation replaces the tunnel under new connections too; wait for an
    // in-progress rotation to settle before dialing upstream (bounded so a
    // hung rotation cannot pin the request forever).
    for (let i = 0; nordRotating && i < 150; i++) {
      if (ac.signal.aborted) throw new Error("Client disconnected")
      await sleep(200)
    }
    await sem.acquire()
    activeTurns++
    try {
      // Outer loop: the model actually used may move down the fallback chain
      // when the upstream reports a model as unavailable.
      const modelQueue = [...fallback]
      for (;;) {
        // Inner loop: rotate across the accounts for the current model.
        for (let attempt = 0; attempt < accounts.length; attempt++) {
        if (ac.signal.aborted) throw new Error("Client disconnected")
        const a = pickAccount(tried, activeModel)
        if (!a) {
          // A truncation retry must never turn into a model-chain walk.
          if (outputRetries > 0) {
            error = new Error("output token limit: no account available to retry the same model")
            break
          }
          // Every account is cooling for this model. Before walking the model
          // chain, try the remedy the user asked for: a different Nord node
          // (fresh exit IP) and one retry of the same model on it.
          // (clientGone is not assigned yet at this point in the loop body.)
          if (!nordRetried && !ac.signal.aborted && !emitted && poolWideLimited(activeModel)) {
            nordRetried = true
            const rot = await rotateEgressAndReset("model-cooldown")
            if (rot.rotated) {
              logLine({ reqId, phase: "nord-rotate", event: "retry", model: activeModel, group: rot.group || null, msg: "every account cooling for this model; retrying it on the new exit" })
              // The fresh tunnel needs a moment before it carries traffic; an
              // immediate retry used to die with ECONNRESET mid-handshake.
              await sleep(2000)
              tried.clear()
              attempt = -1
              continue
            }
          }
          // No account is usable for this model: either every account was
          // already tried for it, or all of them are cooling for it. If the
          // chain has another model, advance to it (per-model cooldowns differ);
          // otherwise fail. Never break out with neither error nor progress --
          // that spins the outer loop forever.
          if (modelQueue.length > 1) {
            const next = modelQueue[1]
            logLine({ reqId, phase: "model-fallback", account: null, from: activeModel, to: next, msg: "no account available for this model, trying next ranked model" })
            activeModel = next
            modelQueue.shift()
            tried.clear()
            attempt = -1
            continue
          }
          error = coolingError(activeModel)
          break
        }
        tried.add(a.name)
        account = a
        const started = { networkUntil: a.coolingUntil, rateLimit: a.rateLimits.get(activeModel) }
        let r = null
        let e = null
        let bridgeOk = false
        try {
          if (bridgeName) {
            await putBridge(a.client, SCRATCH, bridgeName, manifest.file, { log: (_, m) => logLine({ reqId, phase: "bridge", account: a.name, msg: m }) })
            bridgeOk = true
          }
          r = await runTurn(a.client, {
            dir: SCRATCH,
            model: { providerID: "opencode", id: activeModel },
            promptText,
            maxOutputTokens: outputBudget,
            files: canon.files,
            bridgeName,
            sanToOrig: nameMap?.sanToOrig,
            onTextDelta: (d) => {
              if (canon.stream && d) {
                startStream()
                emitted = true
                stream.onDelta(d)
              }
            },
            signal: ac.signal,
            timeoutMs: TURN_TIMEOUT,
            title: "ccgw " + dialect + " " + reqId,
            log: (_, m) => logLine({ reqId, phase: "turn", account: a.name, msg: m }),
          })
        } catch (err) {
          e = err
        } finally {
          if (bridgeOk) {
            try {
              await deleteBridge(a.client, SCRATCH, bridgeName)
            } catch {}
          }
        }

        if (r?.sessionID) sid = r.sessionID
        const failMsg = e ? String(e.message || e) : r?.error ? String(r.error.message || r.error) : null
        if (!failMsg) {
          result = r
          sid = r.sessionID
          usedModel = activeModel
          markOk(a, activeModel, started)
          activeModel = null // success: leave both loops
          break
        }

        const clientGone = ac.signal.aborted
        const failure = classifyError(e || r?.error || new Error(failMsg))
        // Output-limit truncation is not a model/account failure. Retry the same
        // model with a larger budget instead of walking the ranked chain (which
        // used to burn six models and ~20s on a max_tokens:16 request).
        if (failure.code === "output_limit" && !clientGone && !emitted) {
          const current = outputBudget || 0
          const bumped = Math.min(Math.max(current * 4, MIN_OUTPUT_BUDGET), MAX_OUTPUT_BUDGET)
          if (outputRetries < 2 && bumped > current) {
            logLine({ reqId, phase: "output-budget", account: a.name, from: current, to: bumped, msg: "upstream truncated at the output token limit; retrying the same model with a larger budget" })
            outputBudget = bumped
            outputRetries++
            tried.delete(a.name)
            attempt--
            continue
          }
          error = e || r?.error || new Error(failMsg)
          break
        }
        const limited = failure.kind === "rate_limit"
        const down = failure.kind === "network"
        if (!clientGone) {
          if (limited) coolDown(a, "rate-limited: " + failMsg.slice(0, 160), COOLDOWN_SECONDS, activeModel, failure.retryAfterSeconds)
          else if (down) coolDown(a, "unreachable: " + failMsg.slice(0, 160), DOWN_COOLDOWN_SECONDS)
          else {
            // Admission/authentication refusals are not evidence of exhausted quota.
            if (failure.code === "model_geo_blocked") {
              // Geo-restricted from the current exit: park this model briefly
              // and let the model-level chain walk on to the next ranked model.
              // If the whole chain ends up blocked, the exit is the problem and
              // the retry below moves to another Nord node.
              geoBlocks++
              coolDown(a, "geo-blocked: " + failMsg.slice(0, 160), GEO_COOLDOWN_SECONDS, activeModel, failure.retryAfterSeconds)
            }
            a.lastError = failMsg.slice(0, 160)
            a.lastLimited = false
            notePoolState()
            // A refusal storm ("can only be used from within OpenCode",
            // abusive-traffic IP block) is a network-level gate: rotate nodes in
            // the background once it repeats. Geo restrictions do not count
            // here - they are model-level and handled by the chain walk plus the
            // exit retry below.
            if (failure.kind === "access_denied") {
              const now = Date.now()
              accessDenials = accessDenials.filter((t) => now - t < 600_000)
              accessDenials.push(now)
              if (accessDenials.length >= 3 && !nordRetried) {
                nordRetried = true
                logLine({ reqId, phase: "nord-rotate", event: "trigger", reason: "access-denied", count: accessDenials.length, msg: "admission refusals repeated; rotating the exit in the background" })
                void rotateEgressAndReset("access-denied")
              }
            }
          }
        }
        const modelUnavailable = failure.kind === "upstream"
        const rotatable = !clientGone && !emitted && attempt < accounts.length - 1 && (limited || down)
        if (rotatable) {
          logLine({ reqId, phase: "rotate", account: a.name, msg: "failed (" + (limited ? "rate limited" : "unreachable") + "), trying next account: " + failMsg.slice(0, 160) })
          continue
        }

        // No account left to try for this model. A model-level refusal (e.g.
        // "Endpoint is unavailable") is not a quota or admission problem, so move
        // down the ranked list instead of failing the request; 429/403 are
        // terminal for this request by design.
        if (!clientGone && !emitted && modelUnavailable && modelQueue.length > 1) {
          const next = modelQueue[1]
          logLine({ reqId, phase: "model-fallback", account: a.name, from: activeModel, to: next, msg: "upstream refused the model (" + failMsg.slice(0, 120) + "), trying next ranked model" })
          activeModel = next
          modelQueue.shift()
          tried.clear()
          attempt = -1
          continue
        }
        // Pool-wide rate limit for this model (every account is cooling for
        // it): the user's remedy is a different Nord node. Rotate once and
        // retry this model on the new exit before failing the request.
        if (limited && !nordRetried && !emitted && !clientGone && poolWideLimited(activeModel)) {
          nordRetried = true
          const rot = await rotateEgressAndReset("rate-limit")
          if (rot.rotated) {
            logLine({ reqId, phase: "nord-rotate", event: "retry", model: activeModel, group: rot.group || null, msg: "pool-wide rate limit; retrying the same model on the new exit" })
            await sleep(2000) // let the fresh Nord tunnel settle before retrying
            tried.clear()
            attempt = -1
            continue
          }
        }
        // The ranked chain is exhausted and at least one refusal was a geo
        // restriction: the exit is in the wrong country for these models. Rotate
        // once (clears the per-account geo parks) and replay the whole chain on
        // the new node instead of failing the request. Only a geo/rate-limit
        // failure at the end of the chain can be fixed by another exit; an auth
        // or parameter error would burn a rotation for nothing.
        const exitFixable = failure.code === "model_geo_blocked" || limited
        if (geoBlocks > 0 && exitFixable && modelQueue.length === 1 && !nordRetried && !emitted && !clientGone) {
          nordRetried = true
          const rot = await rotateEgressAndReset("geo-blocked")
          if (rot.rotated) {
            logLine({ reqId, phase: "nord-rotate", event: "retry", reason: "geo-blocked", count: geoBlocks, group: rot.group || null, msg: "every model was refused from this exit; replaying the ranked chain on the new node" })
            await sleep(2000) // let the fresh Nord tunnel settle before replaying
            geoBlocks = 0
            modelQueue.splice(0, modelQueue.length, ...fallback)
            activeModel = model
            tried.clear()
            attempt = -1
            continue
          }
        }
        error = e || r?.error || new Error(failMsg)
        break
        }
        if (activeModel === null || error) break
      }
    } finally {
      activeTurns--
      sem.release()
    }
    // Dispatcher calls stand for client tools that were not registered
    // individually (the request exceeded the upstream tool count).
    if (result && dispatcherOriginal) {
      result.toolCalls = unpackDispatcherCalls(result.toolCalls || [], dispatcherOriginal)
    }
  } catch (e) {
    error = e
  } finally {
    res.removeListener("close", onClose)
    if (manifest) removeManifest(manifest.dir)
  }

  const durationMs = Date.now() - t0
  if (ac.signal.aborted || res.destroyed) return
  if (error || result?.error) {
    const failure = classifyError(error || result?.error)
    const message = failure.message
    logLine({ reqId, account: account?.name, dialect, requestedModel: canon.model, model: usedModel || activeModel || model, modelSource: pick.source, stream: canon.stream, tools: canon.tools.length, bridge: bridgeName, sessionID: sid, durationMs, error: message, upstreamStatus: failure.status, errorKind: failure.kind, errorCode: failure.code })
    if (stream) {
      stream.fail(failure)
      res.end()
    } else {
      const seconds = failure.status === 429 || failure.status === 503
        ? retrySeconds(model) || failure.retryAfterSeconds : undefined
      if (seconds) res.setHeader("Retry-After", String(Math.max(1, Math.ceil(seconds))))
      json(res, failure.status, errorShape(dialect, message, failure.status, failure.code))
    }
    return
  }

  const toolNames = result.toolCalls.map((c) => c.name)
  logLine({
    reqId,
    account: account?.name,
    dialect,
    requestedModel: canon.model,
    model: usedModel || model,
    modelSource: pick.source,
    stream: canon.stream,
    tools: canon.tools.length,
    bridge: bridgeName,
    sessionID: sid,
    toolCalls: toolNames,
    textLen: result.text.length,
    usage: result.usage,
    durationMs,
  })

  if (canon.stream) {
    startStream()
    stream.finish(result)
    res.end()
  } else if (dialect === "anthropic") {
    json(res, 200, anthropicNonStream(result, canon.model || model, inputTokens))
  } else if (dialect === "openai") {
    json(res, 200, openaiNonStream(result, canon.model || model, inputTokens))
  } else {
    json(res, 200, responsesNonStream(result, canon.model || model, inputTokens))
  }
}

// ---------------------------------------------------------------------------
// HTTP server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost")
  const p = url.pathname
  try {
    if (!authed(req)) return json(res, 401, errorShape(p.includes("messages") ? "anthropic" : "openai", "unauthorized", 401))

    if (req.method === "GET" && (p === "/health" || p === "/")) {
      const models = await knownModels()
      const rankCfg = loadRankConfig()
      const ranked = rankFree(models.list, rankCfg.order)
      return json(res, 200, {
        ok: true,
        opencode: accounts[0].client.baseUrl,
        eventStream: accounts[0].client.connected,
        models: models.ids,
        freeRanked: describeRanked(models.list, ranked),
        modelSlots: rankCfg.slots,
        modelPin: PIN || null,
        defaultModel: PIN && models.ids.includes(PIN) ? PIN : ranked[0] || FALLBACK_MODEL,
        scratch: SCRATCH,
        accounts: accounts.map((a) => ({
          name: a.name,
          url: a.client.baseUrl,
          identity: a.identity || null,
          credentialId: a.credentialId || null,
          email: a.email || null,
          eventStream: a.client.connected,
          coolingSeconds: Math.max(0, Math.ceil((Math.max(a.coolingUntil, ...[...a.rateLimits.values()].map((r) => r.until)) - Date.now()) / 1000)),
          modelCooldowns: Object.fromEntries([...a.rateLimits].filter(([, r]) => r.until > Date.now()).map(([id, r]) => [id, { retryAfterSeconds: Math.max(1, Math.ceil((r.until - Date.now()) / 1000)), source: "gateway-cooldown" }])),
          fails: a.fails,
          lastError: a.lastError,
        })),
        pool: poolState(),
        egress: egress?.state() || null,
        nord: nordStatus(),
      })
    }

    if (req.method === "GET" && p === "/v1/models") {
      const models = await knownModels()
      const rankCfg = loadRankConfig()
      const ranked = rankFree(models.list, rankCfg.order)
      const byId = new Map(models.list.map((m) => [m.id, m]))
      const freeList = ranked
        .map((id, i) => {
          const m = byId.get(id)
          return m ? { ...m, rank: i + 1 } : null
        })
        .filter(Boolean)
      const now = Math.floor(Date.now() / 1000)
      const wantsAnthropic = !!req.headers["anthropic-version"] || url.searchParams.get("format") === "anthropic"
      return json(res, 200, wantsAnthropic ? modelsAnthropic(freeList, now) : modelsOpenAI(freeList, now))
    }

    if (!authed(req)) return json(res, 401, errorShape(p.includes("messages") ? "anthropic" : "openai", "unauthorized", 401))

    if (req.method === "POST" && (p === "/v1/messages" || p === "/v1/messages/beta")) {
      const body = JSON.parse(await readBody(req))
      return await handleTurn({ dialect: "anthropic", body, req, res })
    }

    if (req.method === "POST" && p === "/v1/messages/count_tokens") {
      const body = JSON.parse(await readBody(req))
      const canon = parseAnthropic(body)
      applyToolChoice(canon, body.tool_choice)
      return json(res, 200, { input_tokens: countTokensApprox(canon) })
    }

    if (req.method === "POST" && p === "/v1/chat/completions") {
      const body = JSON.parse(await readBody(req))
      return await handleTurn({ dialect: "openai", body, req, res })
    }

    if (req.method === "POST" && p === "/v1/responses") {
      const body = JSON.parse(await readBody(req))
      return await handleTurn({ dialect: "responses", body, req, res })
    }

    json(res, 404, { error: { message: "not found: " + req.method + " " + p } })
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: { message: String(e?.message || e) } })
    else res.end()
  }
})

if(process.env.CCGW_EGRESS_FAMILY)egress=attachEgress(server,{key:readEgressKey(process.env.CCGW_EGRESS_KEY_DIR),family:Number(process.env.CCGW_EGRESS_FAMILY)})

server.listen(PORT, HOST, () => {
  console.log("[ccgw] listening on http://" + HOST + ":" + PORT)
  console.log("[ccgw] scratch:", SCRATCH)
  console.log("[ccgw] model selection: top-ranked free" + (PIN ? " (pinned: " + PIN + ")" : " (auto)"))
  console.log("[ccgw] log:", LOG_FILE)
})

process.on("SIGINT", () => {
  console.log("[ccgw] shutting down")
  for (const a of accounts) a.client.stopEventStream()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500)
})
