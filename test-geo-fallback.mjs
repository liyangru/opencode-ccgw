// Regression: a per-model geo restriction ("This model is not available in your
// country") used to be classified as a terminal admission refusal, so the
// request failed and clients (Claude Desktop) rendered it as "the configured
// API key was rejected". It is a model-level fault and must walk the chain.
// Contract tests use a local OpenCode HTTP/SSE fixture; no model service is called.
import assert from "node:assert/strict"
import { test } from "node:test"
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = path.dirname(fileURLToPath(import.meta.url))
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function fixture(error, run, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccgw-geo-test-"))
  const subscribers = new Map()
  let turns = 0
  let serial = 0
  const sessions = new Map()
  const hits = []
  const makeUpstream = () => http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://localhost")
    if (u.pathname === "/__probe") { res.writeHead(200, { "content-type": "text/plain" }); res.end("fixture"); return }
    const account = u.pathname.split("/")[1]
    const route = u.pathname.slice(account.length + 1)
    const json = (body) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)) }
    if (route === "/api/event") {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(": connected\n\n")
      subscribers.set(account, res)
      req.on("close", () => subscribers.delete(account))
    } else if (route === "/api/model") {
      json({ data: (options.models || ["deepseek-v4.1-flash-free"]).map((id) => ({ id, providerID: "opencode", enabled: true, cost: [{ input: 0, output: 0 }] })) })
    } else if (route === "/api/plugin") {
      json({ data: [{ id: 'ccgw-output-budget-v1', state: { status: 'active' } }] })
    } else if (req.method === "POST" && route === "/api/session") {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const input = JSON.parse(Buffer.concat(chunks).toString())
      const id = "ses_fixture_" + (++serial)
      sessions.set(id, input.model?.id)
      json({ data: { id } })
    } else if (req.method === "POST" && /\/prompt$/.test(route)) {
      req.resume()
      const sessionID = route.split("/")[3]
      turns++
      const model = sessions.get(sessionID)
      hits.push({ account, model })
      const failure = typeof error === "function" ? error({ account, model, turn: turns }) : error
      json({})
      setTimeout(() => {
        const send = (type, data) => subscribers.get(account)?.write("data: " + JSON.stringify({ type, data: { sessionID, ...data } }) + "\n\n")
        if (failure) send("session.execution.failed", { error: failure })
        else {
          send("session.text.delta", { delta: "FIXTURE_OK" })
          send("session.execution.succeeded", {})
        }
      }, 5)
    } else { req.resume(); json({}) }
  })
  let upstream = null
  let upstreamPort = 0
  for (let attempt = 0; attempt < 5; attempt++) {
    upstream = makeUpstream()
    upstreamPort = await listen(upstream)
    const probe = await fetch(`http://127.0.0.1:${upstreamPort}/__probe`).then((r) => r.text()).catch(() => "")
    if (probe === "fixture") break
    upstream.closeAllConnections?.()
    await new Promise((resolve) => upstream.close(resolve))
    upstream = null
  }
  if (!upstream?.listening) throw new Error("fixture upstream could not bind a reachable port")
  const reservation = http.createServer()
  const gatewayPort = await listen(reservation)
  await new Promise((resolve) => reservation.close(resolve))
  const accountsFile = path.join(dir, "accounts.json")
  fs.writeFileSync(accountsFile, JSON.stringify({ accounts: (options.accounts || ["a", "b"]).map((name) => ({ name, url: `http://127.0.0.1:${upstreamPort}/${name}` })) }))
  const child = spawn(process.execPath, [path.join(root, "server.mjs")], {
    cwd: root,
    env: { ...process.env, CCGW_PORT: String(gatewayPort), CCGW_ACCOUNTS_FILE: accountsFile,
      CCGW_SCRATCH: path.join(dir, "scratch"), CCGW_LOG: path.join(dir, "gateway.log"),
      CCGW_KEEP_SESSIONS: "1", CCGW_TOKEN: "fixture-only", CCGW_TURN_TIMEOUT: "3000",
      CCGW_STATE_FILE: path.join(dir, 'cooldowns.json'),
      CCGW_NORD_ROTATE: "off", CCGW_NORD_STATE: path.join(dir, "nord-rotate.state.json"),
      ...(options.env || {}) },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  child.stdout.on("data", (x) => { output += x })
  child.stderr.on("data", (x) => { output += x })
  const base = `http://127.0.0.1:${gatewayPort}`
  try {
    const deadline = Date.now() + 8000
    while (true) {
      if (child.exitCode !== null) throw new Error(output)
      try {
        const h = await (await fetch(base + "/health")).json()
        if (h.accounts.every((a) => a.eventStream)) break
      } catch {}
      if (Date.now() >= deadline) throw new Error("Fixture startup timed out: " + output)
      await delay(30)
    }
    await run({
      turns: () => turns,
      hits: () => hits,
      log: () => fs.readFileSync(path.join(dir, "gateway.log"), "utf8"),
      health: async () => (await fetch(base + "/health")).json(),
      post: (route, body) => fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    })
  } finally {
    child.kill()
    if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve))
    upstream.closeAllConnections()
    await new Promise((resolve) => upstream.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const geoError = { type: 'permission_error', status: 403, message: 'This model is not available in your country' }

test('a geo-blocked model falls through the chain instead of failing the request', async () => {
  await fixture(({ turn }) => (turn === 1 ? geoError : null), async (f) => {
    const r = await f.post('/v1/messages', { model: 'claude-opus-5', max_tokens: 64, messages: [{ role: 'user', content: 'diagnostic' }] })
    assert.equal(r.status, 200)
    assert.match(await r.text(), /FIXTURE_OK/)
    assert.deepEqual(f.hits().map((h) => h.model), ['glm-5.3-flash-free', 'deepseek-v4.1-flash-free'])
    // The geo block must not be reported to the client as a key problem.
    assert.doesNotMatch(await f.log(), /"errorKind":"access_denied"/)
  }, { models: ['deepseek-v4.1-flash-free', 'glm-5.3-flash-free'] })
})

test('streaming survives a geo block on the first model', async () => {
  await fixture(({ turn }) => (turn === 1 ? geoError : null), async (f) => {
    const r = await f.post('/v1/messages', { model: 'claude-haiku-4-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'diagnostic' }] })
    assert.equal(r.status, 200)
    const text = await r.text()
    assert.match(text, /FIXTURE_OK/)
    assert.deepEqual(f.hits().map((h) => h.model), ['mimo-v2.6-flash-free', 'deepseek-v4.1-flash-free'])
  }, { models: ['deepseek-v4.1-flash-free', 'mimo-v2.6-flash-free'] })
})

test('a geo block on every model still fails with the real upstream reason', async () => {
  await fixture(geoError, async (f) => {
    const r = await f.post('/v1/messages', { model: 'claude-opus-5', max_tokens: 64, messages: [{ role: 'user', content: 'diagnostic' }] })
    assert.equal(r.status, 403)
    const body = await r.json()
    assert.match(body.error.message, /not available in your country/)
    // Both models were tried before giving up.
    assert.deepEqual(f.hits().map((h) => h.model), ['glm-5.3-flash-free', 'deepseek-v4.1-flash-free'])
  }, { models: ['deepseek-v4.1-flash-free', 'glm-5.3-flash-free'] })
})

test('the free-tier app gate stays terminal (not treated as a model fault)', async () => {
  await fixture({ type: 'FreeTierError', status: 403, message: "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building." }, async (f) => {
    const r = await f.post('/v1/messages', { model: 'claude-opus-5', max_tokens: 64, messages: [{ role: 'user', content: 'diagnostic' }] })
    assert.equal(r.status, 403)
    assert.equal(f.hits().length, 1)
  }, { models: ['deepseek-v4.1-flash-free', 'glm-5.3-flash-free'] })
})
