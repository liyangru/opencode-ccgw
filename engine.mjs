// engine.mjs — OpenCode V2 service client + turn orchestration for ccgw.
//
// Talks to the running OpenCode background service over its HTTP API:
//  - discovers the service URL + password (service.json / CLI)
//  - maintains one SSE subscription to /api/event
//  - registers a per-request stdio MCP bridge exposing the client's tools
//  - creates a throwaway session per request, prompts it, streams events
//  - captures bridge tool calls + interrupts the turn (client executes tools)
//  - cleans up (idle-session sweep via sweepOldSessions, MCP delete,
//    manifest removal)
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const BRIDGE_PATH = path.join(__dirname, "bridge.mjs")

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Service discovery

export function discoverService() {
  const home = os.homedir()
  const svcFile = process.env.CCGW_SERVICE_FILE || path.join(home, ".config", "opencode", "service.json")
  let password = ""
  try {
    password = JSON.parse(fs.readFileSync(svcFile, "utf8")).password || ""
  } catch {}
  let url = process.env.CCGW_OPENCODE_URL || ""
  if (!url) url = discoverViaCli()
  if (!url) url = "http://127.0.0.1:49374"
  return { baseUrl: url.replace(/\/+$/, ""), password }
}

function discoverViaCli() {
  const candidates = []
  const appdata = process.env.APPDATA
  if (appdata) {
    const cliRoot = path.join(appdata, "ai.opencode.desktop", "cli")
    try {
      for (const d of fs.readdirSync(cliRoot)) {
        const exe = path.join(cliRoot, d, "opencode-cli.exe")
        if (fs.existsSync(exe)) candidates.push({ exe, v: d })
      }
    } catch {}
  }
  candidates.sort((a, b) => b.v.localeCompare(a.v, undefined, { numeric: true }))
  for (const c of candidates) {
    try {
      const r = spawnSync(c.exe, ["service", "status"], { encoding: "utf8", timeout: 15000, windowsHide: true })
      const m = /(https?:\/\/[^\s"']+)/.exec((r.stdout || "") + (r.stderr || ""))
      if (m) return m[1]
    } catch {}
  }
  return null
}

// ---------------------------------------------------------------------------
// OpenCode HTTP client

export class OpenCode {
  constructor({ baseUrl, password }) {
    this.baseUrl = baseUrl
    this.auth = "Basic " + Buffer.from("opencode:" + (password || "")).toString("base64")
    this.listeners = new Set()
    this._running = false
    this._abort = null
    this.lastEventAt = 0
    this.connected = false
  }

  async req(method, p, body) {
    const res = await fetch(this.baseUrl + p, {
      method,
      headers: {
        Authorization: this.auth,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {}
    return { status: res.status, ok: res.ok, text, json }
  }

  async reqOrThrow(method, p, body) {
    const r = await this.req(method, p, body)
    if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${r.text.slice(0, 300)}`)
    return r.json
  }

  startEventStream(onError) {
    if (this._running) return
    this._running = true
    const loop = async () => {
      while (this._running) {
        try {
          const ac = new AbortController()
          this._abort = ac
          const res = await fetch(this.baseUrl + "/api/event", {
            headers: { Authorization: this.auth, Accept: "text/event-stream" },
            signal: ac.signal,
          })
          if (!res.ok) throw new Error("event stream -> " + res.status)
          this.connected = true
          const reader = res.body.getReader()
          const dec = new TextDecoder()
          let buf = ""
          let dataLines = []
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buf += dec.decode(value, { stream: true })
            let i
            while ((i = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, i).replace(/\r$/, "")
              buf = buf.slice(i + 1)
              if (line === "") {
                if (dataLines.length) {
                  this._dispatch(dataLines.join("\n"))
                  dataLines = []
                }
                continue
              }
              if (line.startsWith("data:")) dataLines.push(line.slice(5).trim())
            }
          }
          throw new Error("event stream closed")
        } catch (e) {
          this.connected = false
          if (!this._running) break
          if (onError) onError(e)
          await sleep(1000)
        }
      }
    }
    loop()
  }

  stopEventStream() {
    this._running = false
    try {
      this._abort?.abort()
    } catch {}
  }

  _dispatch(data) {
    let ev
    try {
      ev = JSON.parse(data)
    } catch {
      return
    }
    this.lastEventAt = Date.now()
    for (const l of this.listeners) {
      try {
        l(ev)
      } catch {}
    }
  }

  subscribe(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}

// ---------------------------------------------------------------------------
// Locations / MCP bridge helpers

function withLocation(baseUrl, p, dir) {
  const u = new URL(baseUrl + p)
  if (dir) u.searchParams.set("location[directory]", dir)
  return u
}

export async function listMcp(oc, dir) {
  const r = await fetch(withLocation(oc.baseUrl, "/api/mcp", dir), { headers: { Authorization: oc.auth } })
  if (!r.ok) return []
  try {
    return (await r.json()).data || []
  } catch {
    return []
  }
}

// Register the bridge MCP server and wait until OpenCode reports it connected
// AND the location's tool catalog has been rebuilt (command.updated event), so
// sessions created afterwards actually see the bridge tools.
export async function putBridge(oc, dir, name, manifestPath, { timeoutMs = 15000, log } = {}) {
  const putStart = Date.now()
  let catalogRebuilt = 0
  const unsub = oc.subscribe((ev) => {
    if (ev?.type === "command.updated" && Date.now() >= putStart) catalogRebuilt++
  })
  try {
    const r = await fetch(withLocation(oc.baseUrl, `/api/experimental/mcp/${name}`, dir), {
      method: "PUT",
      headers: { Authorization: oc.auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        config: {
          type: "local",
          command: [process.execPath, BRIDGE_PATH, manifestPath],
          codemode: false,
        },
      }),
    })
    if (r.status !== 204 && !r.ok) throw new Error("mcp put -> " + r.status + " " + (await r.text()).slice(0, 200))
    let connectedAt = 0
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const data = await listMcp(oc, dir)
      const s = data.find((x) => x.name === name)
      const st = s?.status?.status
      if (st === "connected") {
        connectedAt = Date.now()
        break
      }
      if (st === "failed") throw new Error("mcp bridge failed to start: " + JSON.stringify(s).slice(0, 200))
      await sleep(250)
    }
    if (!connectedAt) throw new Error("mcp bridge not connected in time")
    // After connect, OpenCode rebuilds the location tool catalog
    // (mcp.status.changed -> mcp.resources.changed -> command.updated).
    // Sessions created before that rebuild completes do NOT see the tools.
    const evDeadline = Date.now() + 4000
    while (catalogRebuilt === 0 && Date.now() < evDeadline) await sleep(100)
    if (catalogRebuilt === 0 && log) log({}, "putBridge: no command.updated seen, falling back to settle delay")
    const minSettle = connectedAt + 600
    if (Date.now() < minSettle) await sleep(minSettle - Date.now())
    await sleep(250)
    return true
  } finally {
    unsub()
  }
}

export async function deleteBridge(oc, dir, name) {
  const r = await fetch(withLocation(oc.baseUrl, `/api/experimental/mcp/${name}`, dir), {
    method: "DELETE",
    headers: { Authorization: oc.auth },
  })
  return r.status
}

export async function deleteSession(oc, sid) {
  const r = await oc.req("DELETE", `/api/session/${sid}`)
  return r.status
}

// Deferred cleanup for throwaway sessions. Deleting a session the moment its
// turn ends races with clients that sync sessions live: the OpenCode desktop
// app prefetches every session.created event, and a fetch that lands after
// the delete surfaces a "Session not found" toast. Sweep sessions that have
// been idle for a while instead (CCGW_SESSION_MIN_AGE_MINUTES, default 15).
export async function sweepOldSessions(oc, { dir, minAgeMinutes, log } = {}) {
  const minAge = Number(minAgeMinutes ?? process.env.CCGW_SESSION_MIN_AGE_MINUTES ?? 15)
  if (!(minAge > 0)) return 0
  const norm = (p) => String(p || "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase()
  const want = norm(dir)
  try {
    const r = await oc.req("GET", "/api/session")
    const list = Array.isArray(r.json?.data) ? r.json.data : []
    const now = Date.now()
    let swept = 0
    for (const s of list) {
      if (!s?.id || norm(s.location?.directory) !== want) continue
      const title = String(s.title || "")
      if (title && !title.startsWith("ccgw ")) continue // leave non-ccgw sessions alone
      const last = Math.max(s.time?.updated || 0, s.time?.viewed || 0)
      if (!last || now - last < minAge * 60000) continue
      const status = await deleteSession(oc, s.id)
      if (status >= 200 && status < 300) {
        swept++
        log?.(`swept ${s.id} (${title || "untitled"})`)
      }
    }
    return swept
  } catch (e) {
    log?.(`sweep failed: ${e.message}`)
    return 0
  }
}

// Prepare a manifest + temp dir for one request's tools.
export function writeManifest(tools) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccgw-"))
  const file = path.join(dir, "manifest.json")
  fs.writeFileSync(file, JSON.stringify({ tools }))
  return { dir, file }
}

export function removeManifest(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {}
}

// Sanitize client tool names into MCP-safe names. Returns maps both ways.
export function buildNameMap(tools) {
  const used = new Set()
  const origToSan = new Map()
  const sanToOrig = new Map()
  for (const t of tools) {
    const original = String(t.name || "")
    let s = original.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60)
    if (!s || /^[0-9]/.test(s)) s = "t_" + s
    let base = s
    let n = 1
    while (used.has(s)) s = `${base}_${n++}`
    used.add(s)
    origToSan.set(original, s)
    sanToOrig.set(s, original)
  }
  return { origToSan, sanToOrig }
}

// ---------------------------------------------------------------------------
// Turn orchestration

export const READ_ONLY_PERMISSIONS = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
]

/*
 * runTurn — execute one model turn against OpenCode.
 *
 * opts:
 *  - oc: OpenCode client
 *  - dir: session location directory (scratch)
 *  - model: { providerID, id, variant? }
 *  - promptText: the single user prompt (rendered transcript)
 *  - bridgeName: MCP bridge server name for this request (null/undefined = no tools)
 *  - sanToOrig: Map sanitized-name -> original client tool name
 *  - onTextDelta(text)
 *  - onToolCall({id, name, input, raw})  (name = original client tool name)
 *  - signal: AbortSignal (client disconnect)
 *  - timeoutMs
 *  - log(contextObj, msg)
 *
 * returns { text, toolCalls, finish, error, sessionID, usage }
 */
export async function runTurn(oc, opts) {
  const {
    dir,
    model,
    promptText,
    bridgeName,
    sanToOrig,
    onTextDelta,
    onToolCall,
    signal,
    timeoutMs = 180000,
    log = () => {},
    title = "ccgw",
  } = opts

  const permissions = [...READ_ONLY_PERMISSIONS]
  if (bridgeName) permissions.push({ action: bridgeName + "_*", resource: "*", effect: "allow" })

  const sess = await oc.reqOrThrow("POST", "/api/session", {
    title,
    model,
    location: { directory: dir },
    permissions,
  })
  const sid = sess.data?.id
  if (!sid) throw new Error("no session id in create response")

  const state = {
    text: "",
    toolCalls: [],
    callsById: new Map(),
    finish: null,
    error: null,
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    usageSnapshot: null,
    streamed: false,
    toolCalledAt: 0,
    done: false,
    interruptedByUs: false,
    firstTokenAt: 0,
  }

  let settle
  const finished = new Promise((r) => (settle = r))
  let settled = false
  const doSettle = () => {
    if (settled) return
    settled = true
    settle()
  }

  let graceTimer = null
  let timeoutTimer = null
  let abortHandler = null

  const prefix = bridgeName ? bridgeName + "_" : null

  const nameById = new Map()

  const pickEntry = (id, fullName) => {
    let entry = state.callsById.get(id)
    if (!entry) {
      const san = fullName.slice(prefix.length)
      const original = sanToOrig?.get(san) || san
      entry = { id, name: original, sanitized: san, input: undefined, raw: undefined }
      state.callsById.set(id, entry)
      state.toolCalls.push(entry)
    }
    return entry
  }

  // The tool name only arrives on session.tool.input.started; input.ended and
  // tool.called reference the call by id, so track id -> full name.
  const resolveFullName = (d) => {
    if (typeof d.name === "string" && prefix && d.name.startsWith(prefix)) return d.name
    return nameById.get(d.id) || null
  }

  const normalizeEntry = (entry) => {
    if (typeof entry.input === "string") {
      try {
        entry.input = JSON.parse(entry.input)
      } catch {}
    }
    if (entry.raw === undefined && entry.input !== undefined) {
      try {
        entry.raw = JSON.stringify(entry.input)
      } catch {}
    }
    return entry
  }

  const unsub = oc.subscribe((ev) => {
    const d = ev?.data
    if (!d || d.sessionID !== sid) return
    switch (ev.type) {
      case "session.text.delta": {
        if (!state.firstTokenAt) state.firstTokenAt = Date.now()
        state.text += d.delta || ""
        try {
          onTextDelta?.(d.delta || "")
        } catch {}
        break
      }
      case "session.text.ended":
        break
      case "session.tool.input.started": {
        if (prefix && typeof d.name === "string" && d.name.startsWith(prefix)) {
          nameById.set(d.id, d.name)
          pickEntry(d.id, d.name)
        }
        break
      }
      case "session.tool.input.ended": {
        if (prefix) {
          const full = resolveFullName(d)
          if (full) {
            const entry = pickEntry(d.id, full)
            if (d.text !== undefined) entry.raw = d.text
            if (entry.input === undefined && d.text) {
              try {
                entry.input = JSON.parse(d.text)
              } catch {}
            }
            normalizeEntry(entry)
            log({}, "tool call captured: " + entry.name + " " + (d.text || "").slice(0, 200))
          }
        }
        break
      }
      case "session.tool.called": {
        if (prefix) {
          const full = resolveFullName(d)
          if (full) {
            const entry = pickEntry(d.id, full)
            if (d.input !== undefined) entry.input = d.input
            normalizeEntry(entry)
            // Execution of the held bridge call has begun: inputs for all
            // parallel calls are complete by now. Fallback trigger in case
            // session.step.streamed never arrives.
            state.toolCalledAt = Date.now()
            maybeFinish()
          }
        }
        break
      }
      case "session.step.streamed": {
        state.streamed = true
        maybeFinish()
        break
      }
      case "session.step.ended": {
        state.finish = d.finish || state.finish
        const t = d.tokens
        if (t) {
          state.usage.input += t.input || 0
          state.usage.output += t.output || 0
          state.usage.reasoning += t.reasoning || 0
          state.usage.cacheRead += t.cache?.read || 0
          state.usage.cacheWrite += t.cache?.write || 0
        }
        break
      }
      case "session.usage.updated": {
        // Fallback snapshot; tool turns are often interrupted before
        // session.step.ended, so this may be the only usage we see.
        const t = d.tokens
        if (t) {
          state.usageSnapshot = {
            input: t.input || 0,
            output: t.output || 0,
            reasoning: t.reasoning || 0,
            cacheRead: t.cache?.read || 0,
            cacheWrite: t.cache?.write || 0,
          }
        }
        break
      }
      case "session.execution.succeeded":
        state.done = true
        doSettle()
        break
      case "session.execution.failed": {
        state.error = d.error || { type: "unknown", message: "execution failed" }
        state.done = true
        doSettle()
        break
      }
      case "session.execution.interrupted": {
        state.done = true
        doSettle()
        break
      }
      default:
        break
    }
  })

  function maybeFinish() {
    if (settled) return
    if (state.toolCalls.length > 0 && (state.streamed || state.toolCalledAt)) {
      // Model finished streaming and issued bridge tool calls. Give a short
      // grace period for any parallel calls, then interrupt so the held MCP
      // calls are abandoned cleanly.
      if (!graceTimer) {
        graceTimer = setTimeout(async () => {
          state.interruptedByUs = true
          try {
            await oc.req("POST", `/api/session/${sid}/interrupt`, {})
          } catch {}
          doSettle()
        }, 350)
      }
    }
  }

  async function abortTurn(reason) {
    if (settled) return
    state.error = state.error || { type: reason, message: reason }
    state.interruptedByUs = true
    try {
      await oc.req("POST", `/api/session/${sid}/interrupt`, {})
    } catch {}
    doSettle()
  }

  if (signal) {
    abortHandler = () => abortTurn("client disconnected")
    if (signal.aborted) abortHandler()
    else signal.addEventListener("abort", abortHandler, { once: true })
  }

  timeoutTimer = setTimeout(() => abortTurn("timeout"), timeoutMs)

  try {
    await oc.reqOrThrow("POST", `/api/session/${sid}/prompt`, { text: promptText })
    await finished
  } finally {
    clearTimeout(timeoutTimer)
    if (graceTimer) clearTimeout(graceTimer)
    if (abortHandler && signal) signal.removeEventListener("abort", abortHandler)
    unsub()
  }

  for (const c of state.toolCalls) {
    try {
      onToolCall?.(c)
    } catch {}
  }

  const usage = state.usage.input || state.usage.output ? state.usage : state.usageSnapshot || state.usage

  return {
    text: state.text,
    toolCalls: state.toolCalls.map((c) => ({ id: c.id, name: c.name, input: c.input, raw: c.raw })),
    finish: state.error ? "error" : state.toolCalls.length > 0 ? "tool-calls" : state.finish || "stop",
    error: state.error,
    sessionID: sid,
    usage,
  }
}
