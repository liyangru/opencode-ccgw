// node test-budget.mjs [--native]
// The native check starts an isolated official CLI and a localhost model mock.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"
import { pathToFileURL } from "node:url"
import * as engine from "./engine.mjs"

function serviceDouble({ plugins = [{ id: "ccgw-output-budget-v1", state: { status: "active" } }] } = {}) {
  const calls = []
  let listener
  const oc = {
    calls,
    subscribe(fn) { listener = fn; return () => { listener = undefined } },
    async reqOrThrow(method, endpoint, body) {
      calls.push({ method, endpoint, body })
      if (endpoint.startsWith("/api/plugin")) return { data: plugins }
      if (endpoint === "/api/session") return { data: { id: "ses_test" } }
      if (endpoint.endsWith("/prompt")) {
        listener?.({ type: "session.execution.succeeded", data: { sessionID: "ses_test" } })
        return null
      }
      throw new Error(`Unexpected ${method} ${endpoint}`)
    },
    async req() { return { ok: true, status: 204 } },
  }
  return oc
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ccgw-budget-test-"))
const opts = { dir: scratch, model: { providerID: "local", id: "diagnostic" }, promptText: "Budget test", timeoutMs: 5000 }
try {
  const oc = serviceDouble()
  await engine.runTurn(oc, { ...opts, maxOutputTokens: 64 })
  assert.deepEqual(oc.calls.find(x => x.endpoint === "/api/session").body.metadata,
    { ccgw: { managed: true, maxOutputTokens: 64 } }, "The request budget must reach native session metadata")
  console.log("PASS request budget reaches session metadata")
  const noBudget = serviceDouble()
  await engine.runTurn(noBudget, opts)
  assert.deepEqual(noBudget.calls.find(x => x.endpoint === "/api/session").body.metadata,
    { ccgw: { managed: true } }, "Every gateway session must opt into gateway-owned retry policy")
  for (const plugins of [[], [{ id: "ccgw-output-budget-v1", state: { status: "failed", error: "bad hook" } }]]) {
    const missing = serviceDouble({ plugins })
    await assert.rejects(engine.runTurn(missing, { ...opts, maxOutputTokens: 64 }), /gateway.*plugin.*active/i)
    assert.equal(missing.calls.some(x => x.endpoint === "/api/session" || x.endpoint.endsWith("/prompt")), false,
      "A missing budget plugin must fail before any model call")
  }
  for (const maxOutputTokens of [0, -1, 0.5, "64", NaN, Infinity]) {
    const invalid = serviceDouble()
    await assert.rejects(engine.runTurn(invalid, { ...opts, maxOutputTokens }), /positive.*integer/i)
    assert.equal(invalid.calls.length, 0)
  }
  console.log("PASS invalid budget and inactive plugin fail before model generation")
  assert.equal(typeof engine.installGatewayPlugin, "function", "The gateway must install its scoped plugin")
  const pluginPath = engine.installGatewayPlugin(scratch)
  const plugin = (await import(pathToFileURL(pluginPath).href)).default
  const hooks = new Map()
  const metadata = new Map([
    ["small", { ccgw: { managed: true, maxOutputTokens: 64 } }],
    ["large", { ccgw: { managed: true, maxOutputTokens: 8192 } }],
    ["unlimited", { ccgw: { managed: true } }],
    ["native", {}],
  ])
  await plugin.setup({ session: {
    async hook(name, fn) { hooks.set(name, fn) },
    async get({ sessionID }) { return { metadata: metadata.get(sessionID) } },
  } })
  const events = [
    { sessionID: "small", options: { maxTokens: 12000 } },
    { sessionID: "large", options: { maxTokens: 12000 } },
    { sessionID: "native", options: { maxTokens: 12000 } },
    { sessionID: "large", options: { maxTokens: 4096 } },
    { sessionID: "unlimited", options: { maxTokens: 12000 } },
  ]
  await Promise.all(events.map(event => hooks.get("context")(event)))
  assert.deepEqual(events.map(x => x.options.maxTokens), [64, 8192, 12000, 4096, 12000])
  assert.equal(metadata.get("small").ccgw.maxOutputTokens, 64, "A hook must not mutate session budget metadata")
  for (const sessionID of ["small", "unlimited", "native"]) {
    const event = { sessionID, decision: { retry: true, delay: 5000 } }
    await hooks.get("retry")(event)
    assert.deepEqual(event.decision, sessionID === "native" ? { retry: true, delay: 5000 } : { retry: false })
  }
  console.log("PASS concurrent budget isolation, model cap, and scoped retry ownership")
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}

if (process.argv.includes("--native")) await nativeCheck()

async function nativeCheck() {
  const cli = process.env.CCGW_NATIVE_CLI || path.join(process.env.APPDATA || "", "ai.opencode.desktop", "cli", "2.0.32-x64", "opencode-cli.exe")
  assert.ok(fs.existsSync(cli), "Set CCGW_NATIVE_CLI to the official OpenCode V2 executable")
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccgw-budget-native-"))
  const location = path.join(home, "scratch")
  fs.mkdirSync(location, { recursive: true })
  engine.installGatewayPlugin(location)
  const captures = []
  const mock = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    let body
    try { body = JSON.parse(Buffer.concat(chunks).toString()) } catch {}
    if (!Array.isArray(body?.messages)) {
      res.writeHead(200, { "content-type": "application/json" }).end('{"data":[]}')
      return
    }
    captures.push({ sessionID: req.headers["x-opencode-session-id"], body })
    if (JSON.stringify(body.messages).includes("BUDGET_RATE_LIMIT")) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "900" })
        .end(JSON.stringify({ error: { type: "rate_limit_error", message: "Local rate limit fixture" } }))
      return
    }
    res.writeHead(200, { "content-type": "text/event-stream" })
    const frame = (delta, finish_reason = null) => "data: " + JSON.stringify({
      id: "chatcmpl_local", object: "chat.completion.chunk", created: 1, model: "diagnostic",
      choices: [{ index: 0, delta, finish_reason }],
    }) + "\n\n"
    res.end(frame({ role: "assistant", content: "LOCAL_BUDGET_OK" }) + frame({}, "stop") + "data: [DONE]\n\n")
  })
  await new Promise(resolve => mock.listen(0, "127.0.0.1", resolve))
  // Reserve a free loopback port before starting the isolated CLI.
  const reservation = http.createServer()
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve))
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  const env = { ...process.env, HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, "AppData/Roaming"), LOCALAPPDATA: path.join(home, "AppData/Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_CACHE_HOME: path.join(home, ".cache"), XDG_STATE_HOME: path.join(home, ".local/state") }
  for (const key of Object.keys(env)) if (/API_KEY|TOKEN|PASSWORD|SECRET|OPENCODE_CONFIG/i.test(key)) delete env[key]
  env.OPENCODE_SERVER_PASSWORD = "local-budget-fixture"
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    plugins: [], model: "capture/diagnostic", providers: { capture: {
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: "local-only" },
      models: { diagnostic: { capabilities: { tools: true, input: ["text"], output: ["text"] },
        cost: { input: 0, output: 0 }, limit: { context: 200000, output: 12000 } } },
    } },
  })
  const child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
    { cwd: home, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  let startup = ""
  child.stdout.on("data", chunk => { startup = (startup + chunk).slice(-6000) })
  child.stderr.on("data", chunk => { startup = (startup + chunk).slice(-6000) })
  const oc = new engine.OpenCode({ baseUrl: `http://127.0.0.1:${port}`, password: "local-budget-fixture" })
  try {
    const readyBy = Date.now() + 30000
    let ready = false
    while (Date.now() < readyBy) {
      try { if ((await oc.req("GET", "/api/info")).ok) { ready = true; break } } catch {}
      if (child.exitCode !== null) throw new Error("Native CLI exited: " + startup)
      await engine.sleep(100)
    }
    assert.ok(ready, "Native CLI must become ready: " + startup)
    await engine.ensureGatewayPlugin(oc, location)
    const plugins = await oc.reqOrThrow("GET", "/api/plugin?" + new URLSearchParams({ "location[directory]": location }))
    assert.ok(plugins.data.some(x => x.id === "ccgw-output-budget-v1" && x.state.status === "active"),
      "Official CLI must load the scratch plugin: " + JSON.stringify(plugins))
    oc.startEventStream()
    const eventsBy = Date.now() + 5000
    while (!oc.connected && Date.now() < eventsBy) await engine.sleep(50)
    assert.ok(oc.connected, "Native event stream must connect")
    const baseOpts = { dir: location, model: { providerID: "capture", id: "diagnostic" }, timeoutMs: 15000 }
    const turns = await Promise.all([
      engine.runTurn(oc, { ...baseOpts, title: "ccgw budget small", promptText: "BUDGET_SMALL", maxOutputTokens: 64 }),
      engine.runTurn(oc, { ...baseOpts, title: "ccgw budget large", promptText: "BUDGET_LARGE", maxOutputTokens: 8192 }),
      engine.runTurn(oc, { ...baseOpts, title: "ccgw budget default", promptText: "BUDGET_DEFAULT" }),
    ])
    assert.deepEqual(turns.map(x => x.text), ["LOCAL_BUDGET_OK", "LOCAL_BUDGET_OK", "LOCAL_BUDGET_OK"])
    const wireBudgets = turns.map(turn => {
      const requests = captures.filter(x => x.sessionID === turn.sessionID)
      assert.equal(requests.length, 1, "Each native turn must make exactly one local model request")
      assert.equal(requests[0].body.metadata?.ccgw, undefined, "Local routing metadata must not reach the provider")
      assert.equal(JSON.stringify(requests[0].body).includes('"maxOutputTokens"'), false, "Session budget metadata must stay local")
      return requests[0].body.max_tokens ?? requests[0].body.max_completion_tokens
    })
    assert.deepEqual(wireBudgets, [64, 8192, 12000], "Actual outgoing native provider requests must use independent budgets")
    const wireField = captures.find(x => x.sessionID === turns[0].sessionID).body.max_tokens === undefined ? "max_completion_tokens" : "max_tokens"
    console.log("PASS official CLI concurrent wire " + wireField + ": " + wireBudgets.join(", "))
    const beforeMissing = captures.length
    const noPlugin = path.join(home, "unmanaged-location")
    fs.mkdirSync(noPlugin)
    await assert.rejects(engine.runTurn(oc, { ...baseOpts, dir: noPlugin, promptText: "MUST_NOT_CALL", maxOutputTokens: 64 }), /plugin.*active/i)
    assert.equal(captures.length, beforeMissing)
    const started = Date.now()
    let retryEvents = 0
    const unsub = oc.subscribe(event => { if (event.type === "session.retry.scheduled") retryEvents++ })
    const limited = await engine.runTurn(oc, { ...baseOpts, title: "ccgw rate limit", promptText: "BUDGET_RATE_LIMIT", maxOutputTokens: 96 })
    unsub()
    assert.ok(limited.error, "Native rate limiting must be returned as an error")
    assert.equal(captures.filter(x => x.sessionID === limited.sessionID).length, 1, "A 429 must not trigger hidden native retry attempts")
    assert.equal(retryEvents, 0, "Gateway-owned retry must suppress native retry schedules")
    assert.ok(Date.now() - started < 10000, "A 900-second Retry-After must not stall the gateway native turn")
    console.log("PASS official CLI 429 performs one attempt and returns immediately")
  } finally {
    oc.stopEventStream()
    child.kill()
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once("exit", resolve) })
    mock.closeAllConnections()
    await new Promise(resolve => mock.close(resolve))
    fs.rmSync(home, { recursive: true, force: true })
  }
}
