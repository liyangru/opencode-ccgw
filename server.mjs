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
  resolveModel,
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

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.CCGW_PORT || 8317)
const HOST = process.env.CCGW_HOST || "127.0.0.1"
const FALLBACK_MODEL = process.env.CCGW_MODEL || "deepseek-v4.1-flash-free"
const SCRATCH = process.env.CCGW_SCRATCH || path.join(os.tmpdir(), "ccgw-scratch")
const LOG_FILE = process.env.CCGW_LOG || path.join(__dirname, "ccgw.log")
const TOKEN = process.env.CCGW_TOKEN || ""
const MAX_CONCURRENCY = Number(process.env.CCGW_MAX_CONCURRENCY || 3)
const TURN_TIMEOUT = Number(process.env.CCGW_TURN_TIMEOUT || 180000)
const KEEP_SESSIONS = process.env.CCGW_KEEP_SESSIONS === "1"

fs.mkdirSync(SCRATCH, { recursive: true })

// ---------------------------------------------------------------------------
// OpenCode client + live model list

const { baseUrl, password } = discoverService()
console.log("[ccgw] OpenCode service:", baseUrl, password ? "(auth ok)" : "(no password found!)")
const oc = new OpenCode({ baseUrl, password })
oc.startEventStream((e) => console.log("[ccgw] event stream error:", e.message))

// The desktop app may restart the background service on a new port. If the
// event stream drops and stays down, re-run discovery and reconnect.
let rediscovering = false
setInterval(async () => {
  if (oc.connected || rediscovering) return
  rediscovering = true
  try {
    const d = discoverService()
    if (d.baseUrl !== oc.baseUrl || d.password !== password) {
      console.log("[ccgw] service moved:", oc.baseUrl, "->", d.baseUrl)
      oc.baseUrl = d.baseUrl
      oc.auth = "Basic " + Buffer.from("opencode:" + (d.password || "")).toString("base64")
      oc.stopEventStream()
      await sleep(150)
      oc.startEventStream((e) => console.log("[ccgw] event stream error:", e.message))
    }
  } catch (e) {
    console.log("[ccgw] rediscovery failed:", e.message)
  } finally {
    rediscovering = false
  }
}, 15000)

// Throwaway sessions are cleaned up by an idle sweep instead of per request:
// deleting a session seconds after creating it races with clients that sync
// sessions (the desktop app prefetches every session.created event and toasts
// "Session not found" when its fetch lands after the delete).
if (!KEEP_SESSIONS) {
  const sweep = () =>
    sweepOldSessions(oc, { dir: SCRATCH, log: (m) => logLine({ phase: "sweep", msg: m }) })
      .then((n) => {
        if (n) console.log("[ccgw] swept", n, "idle session(s)")
      })
      .catch(() => {})
  sweep()
  const every = Number(process.env.CCGW_SWEEP_INTERVAL_MINUTES || 10)
  if (every > 0) setInterval(sweep, every * 60 * 1000).unref()
}

let modelCache = { at: 0, ids: [], list: [] }
async function knownModels() {
  if (Date.now() - modelCache.at < 60000 && modelCache.ids.length) return modelCache
  try {
    const r = await oc.req("GET", "/api/model?location[directory]=" + encodeURIComponent(SCRATCH))
    const data = r.json?.data || []
    modelCache = {
      at: Date.now(),
      ids: data.map((m) => m.id),
      list: data.map((m) => ({ id: m.id, name: m.name || m.id, providerID: m.providerID || "opencode" })),
    }
  } catch (e) {
    console.log("[ccgw] model list fetch failed:", e.message)
  }
  return modelCache
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
  const auth = req.headers["authorization"] || ""
  const xk = req.headers["x-api-key"] || ""
  return auth === "Bearer " + TOKEN || xk === TOKEN || auth === "Basic " + Buffer.from("opencode:" + TOKEN).toString("base64")
}

// ---------------------------------------------------------------------------
// One gateway turn

async function handleTurn({ dialect, body, req, res }) {
  const reqId = crypto.randomBytes(6).toString("hex")
  const t0 = Date.now()

  const canon = dialect === "anthropic" ? parseAnthropic(body) : dialect === "openai" ? parseOpenAI(body) : parseResponses(body)
  applyToolChoice(canon, body.tool_choice)

  const models = await knownModels()
  const model = resolveModel(canon.model, models.ids, FALLBACK_MODEL)
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
  try {
    await sem.acquire()
    try {
      if (bridgeName) {
        await putBridge(oc, SCRATCH, bridgeName, manifest.file, { log: (_, m) => logLine({ reqId, phase: "bridge", msg: m }) })
      }
      result = await runTurn(oc, {
        dir: SCRATCH,
        model: { providerID: "opencode", id: model },
        promptText,
        bridgeName,
        sanToOrig: nameMap?.sanToOrig,
        onTextDelta: (d) => stream?.onDelta(d),
        signal: ac.signal,
        timeoutMs: TURN_TIMEOUT,
        title: "ccgw " + dialect + " " + reqId,
        log: (_, m) => logLine({ reqId, phase: "turn", msg: m }),
      })
      sid = result.sessionID
    } finally {
      sem.release()
    }
  } catch (e) {
    error = e
  } finally {
    res.removeListener("close", onClose)
    if (manifest) removeManifest(manifest.dir)
    if (bridgeName) {
      try {
        await deleteBridge(oc, SCRATCH, bridgeName)
      } catch {}
    }
  }

  const durationMs = Date.now() - t0
  if (error || result?.error) {
    const message = String(error?.message || result?.error?.message || "turn failed")
    logLine({ reqId, dialect, requestedModel: canon.model, model, stream: canon.stream, tools: canon.tools.length, bridge: bridgeName, sessionID: sid, durationMs, error: message })
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
    dialect,
    requestedModel: canon.model,
    model,
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
    if (req.method === "GET" && (p === "/health" || p === "/")) {
      const models = await knownModels()
      return json(res, 200, {
        ok: true,
        opencode: oc.baseUrl,
        eventStream: oc.connected,
        models: models.ids,
        defaultModel: FALLBACK_MODEL,
        scratch: SCRATCH,
      })
    }

    if (req.method === "GET" && p === "/v1/models") {
      const models = await knownModels()
      const now = Math.floor(Date.now() / 1000)
      const wantsAnthropic = !!req.headers["anthropic-version"] || url.searchParams.get("format") === "anthropic"
      return json(res, 200, wantsAnthropic ? modelsAnthropic(models.list, now) : modelsOpenAI(models.list, now))
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
  console.log("[ccgw] default model:", FALLBACK_MODEL)
  console.log("[ccgw] log:", LOG_FILE)
})

process.on("SIGINT", () => {
  console.log("[ccgw] shutting down")
  oc.stopEventStream()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500)
})
