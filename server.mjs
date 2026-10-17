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
  discoverService,
  runTurn,
  putBridge,
  deleteBridge,
  sweepOldSessions,
  writeManifest,
  removeManifest,
  buildNameMap,
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
import { isFreeModel, loadRankOrder, pickModel, rankFree } from "./ranking.mjs"

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
const KEEP_SESSIONS = process.env.CCGW_KEEP_SESSIONS === "1"

fs.mkdirSync(SCRATCH, { recursive: true })

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
  fails: 0,
  lastError: null,
  lastLimited: false,
  modelCache: { at: 0, ids: [], list: [] },
}))
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
    const r = await a.client.req("GET", "/api/model?location[directory]=" + encodeURIComponent(SCRATCH))
    const data = r.json?.data || []
    a.modelCache = {
      at: Date.now(),
      ids: data.map((m) => m.id),
      list: data.map((m) => ({
        id: m.id,
        name: m.name || m.id,
        providerID: m.providerID || "opencode",
        free: m.enabled !== false && isFreeModel(m.id, m),
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

const RATE_LIMIT_RE = /429|too many requests|rate.?limit|quota|usage limit|usage exceeded|limit reached|limit exceeded|hit your limit|free (tier|usage)|slow down|try again (later|in)|subscribe|capacity/i
const UNAVAILABLE_RE = /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|EHOSTUNREACH|ECONNABORTED|networkerror/i

let rr = 0
function pickAccount(tried) {
  const now = Date.now()
  const fresh = accounts.filter((a) => !tried.has(a.name))
  const avail = fresh.filter((a) => a.coolingUntil <= now)
  const candidates = avail.length ? avail : fresh
  const pick = candidates[rr % candidates.length]
  rr++
  return pick
}

function coolDown(a, reason, seconds, limited = false) {
  // consecutive failures double the cooldown (a fully spent quota should not
  // be retried every few minutes); markOk() resets it after a success
  const secs = Math.min(seconds * 2 ** a.fails, 1800)
  a.coolingUntil = Math.max(a.coolingUntil, Date.now() + secs * 1000)
  a.fails++
  a.lastError = reason
  a.lastLimited = limited
  console.log("[ccgw] cooldown " + a.name + " for " + secs + "s: " + reason)
  logLine({ phase: "cooldown", account: a.name, seconds: secs, msg: reason })
  notePoolState()
}

function markOk(a) {
  a.fails = 0
  a.lastError = null
  a.lastLimited = false
  a.coolingUntil = 0
  notePoolState()
}

// Pool-level quota state: every account rate-limited at once is the signal
// net-guard.ps1 (zero-window) listens for - it switches the machine's egress
// to NordVPN when the whole pool is dry. Harmless when nobody watches /health.
let lastQuotaState = false
function poolState() {
  const now = Date.now()
  const cooling = accounts.filter((a) => a.coolingUntil > now)
  const quotaExhausted =
    accounts.length > 0 && cooling.length === accounts.length && accounts.every((a) => a.lastLimited)
  // total/loggedIn/anonymous count INSTANCES, not distinct accounts: one account
  // may be logged in on several instances, and that does not stack quota.
  const loggedIn = accounts.filter((a) => a.identity).length
  const distinctAccounts = new Set(accounts.map((a) => a.email).filter(Boolean)).size
  return { total: accounts.length, loggedIn, distinctAccounts, anonymous: accounts.length - loggedIn, cooling: cooling.length, quotaExhausted }
}
function notePoolState() {
  const s = poolState()
  if (s.quotaExhausted === lastQuotaState) return
  lastQuotaState = s.quotaExhausted
  if (s.quotaExhausted) {
    console.log("[ccgw] [net] all " + accounts.length + " instance(s) rate-limited - quota exhausted signal")
    logLine({ phase: "net", event: "quota-exhausted", accounts: accounts.map((a) => a.name) })
  } else {
    console.log("[ccgw] [net] quota state cleared")
    logLine({ phase: "net", event: "quota-cleared" })
  }
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
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function json(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) })
  res.end(body)
}

function errorShape(dialect, message, status = 500) {
  if (dialect === "anthropic") return { type: "error", error: { type: status === 400 ? "invalid_request_error" : "api_error", message } }
  if (dialect === "openai") return { error: { message, type: "server_error", param: null, code: null } }
  return { error: { message, type: "server_error", code: status } }
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

  // Temp cleaners may delete the scratch dir while the gateway runs; recreate
  // it so model listing, bridge registration and session creation keep working.
  try { fs.mkdirSync(SCRATCH, { recursive: true }) } catch {}

  const canon = dialect === "anthropic" ? parseAnthropic(body) : dialect === "openai" ? parseOpenAI(body) : parseResponses(body)
  applyToolChoice(canon, body.tool_choice)

  const models = await knownModels()
  const ranked = rankFree(models.list, loadRankOrder())
  const freeSet = new Set(models.list.filter((m) => m.free).map((m) => m.id))
  const pick = pickModel({ requested: canon.model, ids: new Set(models.ids), freeSet, ranked, pin: PIN, fallback: FALLBACK_MODEL })
  const model = pick.model
  const inputTokens = countTokensApprox(canon)

  let bridgeName = null
  let manifest = null
  let nameMap = null
  if (canon.tools.length) {
    bridgeName = "gw" + crypto.randomBytes(6).toString("hex")
    nameMap = buildNameMap(canon.tools)
    const sandboxTools = canon.tools.map((t) => ({
      name: nameMap.origToSan.get(t.name),
      description: t.description,
      inputSchema: t.inputSchema,
    }))
    manifest = writeManifest(sandboxTools)
  }

  const promptText = renderPrompt(canon, bridgeName, nameMap?.origToSan)

  let stream = null
  if (canon.stream) {
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

  const ac = new AbortController()
  const onClose = () => {
    if (!res.writableFinished) ac.abort()
  }
  res.on("close", onClose)

  let sid = null
  let result = null
  let error = null
  let account = null
  let emitted = false
  const tried = new Set()
  try {
    await sem.acquire()
    try {
      for (let attempt = 0; attempt < accounts.length; attempt++) {
        const a = pickAccount(tried)
        tried.add(a.name)
        account = a
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
            model: { providerID: "opencode", id: model },
            promptText,
            bridgeName,
            sanToOrig: nameMap?.sanToOrig,
            onTextDelta: (d) => {
              if (stream) {
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

        const failMsg = e ? String(e.message || e) : r?.error ? String(r.error.message || r.error) : null
        if (!failMsg) {
          result = r
          sid = r.sessionID
          markOk(a)
          break
        }

        const clientGone = ac.signal.aborted
        const limited = RATE_LIMIT_RE.test(failMsg)
        const down = UNAVAILABLE_RE.test(failMsg)
        if (!clientGone) {
          if (limited) coolDown(a, "rate-limited: " + failMsg.slice(0, 160), COOLDOWN_SECONDS, true)
          else if (down) coolDown(a, "unreachable: " + failMsg.slice(0, 160), DOWN_COOLDOWN_SECONDS)
        }
        const rotatable = !clientGone && !emitted && attempt < accounts.length - 1 && (limited || down)
        if (rotatable) {
          logLine({ reqId, phase: "rotate", account: a.name, msg: "failed (" + (limited ? "rate limited" : "unreachable") + "), trying next account: " + failMsg.slice(0, 160) })
          continue
        }
        error = e || new Error(failMsg)
        break
      }
    } finally {
      sem.release()
    }
  } catch (e) {
    error = e
  } finally {
    res.removeListener("close", onClose)
    if (manifest) removeManifest(manifest.dir)
  }

  const durationMs = Date.now() - t0
  if (error || result?.error) {
    const message = String(error?.message || result?.error?.message || "turn failed")
    logLine({ reqId, account: account?.name, dialect, requestedModel: canon.model, model, modelSource: pick.source, stream: canon.stream, tools: canon.tools.length, bridge: bridgeName, sessionID: sid, durationMs, error: message })
    if (stream) {
      stream.fail(error || new Error(message))
      res.end()
    } else {
      json(res, error ? 502 : 500, errorShape(dialect, message, error ? 502 : 500))
    }
    return
  }

  const toolNames = result.toolCalls.map((c) => c.name)
  logLine({
    reqId,
    account: account?.name,
    dialect,
    requestedModel: canon.model,
    model,
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

  if (stream) {
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
      const ranked = rankFree(models.list, loadRankOrder())
      return json(res, 200, {
        ok: true,
        opencode: accounts[0].client.baseUrl,
        eventStream: accounts[0].client.connected,
        models: models.ids,
        freeRanked: ranked,
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
          coolingSeconds: Math.max(0, Math.ceil((a.coolingUntil - Date.now()) / 1000)),
          fails: a.fails,
          lastError: a.lastError,
        })),
        pool: poolState(),
      })
    }

    if (req.method === "GET" && p === "/v1/models") {
      const models = await knownModels()
      const ranked = rankFree(models.list, loadRankOrder())
      const byId = new Map(models.list.map((m) => [m.id, m]))
      const freeList = ranked.map((id) => byId.get(id)).filter(Boolean)
      const now = Math.floor(Date.now() / 1000)
      const wantsAnthropic = !!req.headers["anthropic-version"] || url.searchParams.get("format") === "anthropic"
      return json(res, 200, wantsAnthropic ? modelsAnthropic(freeList, now) : modelsOpenAI(freeList, now))
    }

    if (!authed(req)) return json(res, 401, errorShape(p.includes("messages") ? "anthropic" : "openai", "unauthorized", 401))

    if (req.method === "POST" && (p === "/v1/messages" || p === "/v1/messages/beta")) {
      const body = JSON.parse(await readBody(req))
      return handleTurn({ dialect: "anthropic", body, req, res })
    }

    if (req.method === "POST" && p === "/v1/messages/count_tokens") {
      const body = JSON.parse(await readBody(req))
      const canon = parseAnthropic(body)
      applyToolChoice(canon, body.tool_choice)
      return json(res, 200, { input_tokens: countTokensApprox(canon) })
    }

    if (req.method === "POST" && p === "/v1/chat/completions") {
      const body = JSON.parse(await readBody(req))
      return handleTurn({ dialect: "openai", body, req, res })
    }

    if (req.method === "POST" && p === "/v1/responses") {
      const body = JSON.parse(await readBody(req))
      return handleTurn({ dialect: "responses", body, req, res })
    }

    json(res, 404, { error: { message: "not found: " + req.method + " " + p } })
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: { message: String(e?.message || e) } })
    else res.end()
  }
})

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
