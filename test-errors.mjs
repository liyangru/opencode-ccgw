// Contract tests use a local OpenCode HTTP/SSE fixture; no model service is called.
import assert from "node:assert/strict"
import { test } from "node:test"
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { classifyError, isModelLevelRefusal } from "./errors.mjs"

const root = path.dirname(fileURLToPath(import.meta.url))
const denied = "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building."
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(fn, ms = 2000) {
  const deadline = Date.now() + ms
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() >= deadline) return null
    await delay(20)
  }
}

async function fixture(error, run, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccgw-error-test-"))
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
      json({ data: (options.models || ["deepseek-v4.1-flash-free"]).map((id) => ({ id, providerID: "opencode", enabled: true, cost: [{ input: 0, output: 0 }] })).concat(options.extraModels || []) })
    } else if (route === "/api/plugin") {
      const fail = options.pluginFailure ? options.pluginFailure({ account, turn: turns }) : null
      if (fail) { res.writeHead(fail, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "fixture plugin failure" } })); return }
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
      const emitDelay = options.delay ? options.delay({ account, model, turn: turns }) : 5
      json({})
      setTimeout(() => {
        const send = (type, data) => subscribers.get(account)?.write("data: " + JSON.stringify({ type, data: { sessionID, ...data } }) + "\n\n")
        if (failure) {
          if (options.partial !== undefined) send("session.text.delta", { delta: options.partial === true ? "PARTIAL" : options.partial })
          send("session.execution.failed", { error: failure })
        }
        else {
          send("session.text.delta", { delta: "FIXTURE_OK" })
          send("session.execution.succeeded", {})
        }
      }, emitDelay)
    } else { req.resume(); json({}) }
  })
  // A live account may be restarting on the same port; prove this port reaches
  // this fixture's server before the gateway child starts using it.
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
      CCGW_STATE_FILE: path.join(dir,'cooldowns.json'),
      // Offline tests must never touch the network: Nord exit rotation is
      // stubbed per-test instead (CCGW_NORD_ROTATE=stub) when under test.
      CCGW_NORD_ROTATE: "off", CCGW_NORD_STATE: path.join(dir, "nord-rotate.state.json"),
      ...(options.env || {}),
      ...(options.cooldown !== undefined ? { CCGW_COOLDOWN_SECONDS: String(options.cooldown) } : {}) },
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

const body = { model: "deepseek-v4.1-flash-free", messages: [{ role: "user", content: "diagnostic" }] }

test('only native OpenCode models enter the gateway catalog and free pool', async () => {
  await fixture(null, async f => {
    const h = await f.health()
    assert.deepEqual(h.models,['deepseek-v4.1-flash-free'])
    assert.deepEqual(h.freeRanked.map(x=>x.id),['deepseek-v4.1-flash-free'])
  }, {extraModels:[{id:'other-free',providerID:'ccgw',enabled:true,cost:[{input:0,output:0}]}]})
})

test('invalid budgets fail as 400 while the server stays alive', async () => {
  await fixture(null, async f => {
    const r = await f.post('/v1/chat/completions',{...body,max_tokens:0})
    assert.equal(r.status,400)
    assert.equal(f.turns(),0)
    assert.ok(await f.health())
  })
})

test('empty messages are rejected before touching the pool', async () => {
  await fixture(null, async (f) => {
    const r = await f.post('/v1/messages', { model: body.model, messages: [] })
    assert.equal(r.status, 400)
    assert.match((await r.json()).error.message, /at least one message/)
    assert.equal(f.turns(), 0)
  })
})

test('output-limit truncation retries the same model with a larger budget instead of walking the chain', async () => {
  await fixture(({ turn }) => turn === 1
    ? { type: 'provider.internal', status: 502, message: 'Response still truncated after two output token limit continuations' }
    : null, async (f) => {
    const r = await f.post('/v1/messages', { ...body, max_tokens: 16 })
    assert.equal(r.status, 200)
    const hits = f.hits()
    assert.equal(hits.length, 2)
    assert.deepEqual(hits.map((h) => h.model), ['deepseek-v4.1-flash-free', 'deepseek-v4.1-flash-free'])
  }, { models: ['deepseek-v4.1-flash-free', 'glm-5.3-flash-free'] })
})

test('persistent output-limit truncation fails as 400 without walking the model chain', async () => {
  await fixture({ type: 'provider.internal', status: 502, message: 'Response still truncated after two output token limit continuations' }, async (f) => {
    const r = await f.post('/v1/messages', { ...body, max_tokens: 16 })
    assert.equal(r.status, 400)
    const hits = f.hits()
    assert.equal(hits.length, 3)
    assert.ok(hits.every((h) => h.model === 'deepseek-v4.1-flash-free'))
    assert.equal((await f.health()).pool.cooling, 0)
  }, { models: ['deepseek-v4.1-flash-free', 'glm-5.3-flash-free'] })
})

test('success log reports the model that actually served after a fallback', async () => {
  await fixture(({ turn }) => turn === 1
    ? { type: 'provider.internal', status: 502, message: 'Upstream request failed: Endpoint is unavailable.' }
    : null, async (f) => {
    const r = await f.post('/v1/messages', { model: 'claude-opus-5', max_tokens: 64, messages: [{ role: 'user', content: 'diagnostic' }] })
    assert.equal(r.status, 200)
    assert.deepEqual(f.hits().map((h) => h.model), ['glm-5.3-flash-free', 'deepseek-v4.1-flash-free'])
    // The gateway appends log lines asynchronously; poll instead of assuming the
    // success line is already on disk.
    const readDone = () => {
      try {
        return f.log().trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.reqId && l.textLen !== undefined).pop()
      } catch { return null }
    }
    const done = await waitFor(readDone)
    assert.ok(done, 'the success log line was written')
    assert.equal(done.model, 'deepseek-v4.1-flash-free')
    assert.equal(done.modelSource, 'slot:opus')
  }, { models: ['glm-5.3-flash-free', 'deepseek-v4.1-flash-free'] })
})

test("free-tier 403 stays forbidden without account rotation or quota signal", async () => {
  await fixture({ type: "provider.auth", status: 403, message: denied, response: { body: JSON.stringify({ error: { type: "FreeTierError", message: denied } }) } }, async (f) => {
    const r = await f.post("/v1/chat/completions", body)
    assert.equal(r.status, 403)
    assert.equal((await r.json()).error.code, "free_tier_access_denied")
    assert.equal(f.turns(), 1)
    const h = await f.health()
    assert.equal(h.pool.quotaExhausted, false)
    assert.equal(h.pool.cooling, 0)
  })
})

test("explicit 401 wins over misleading rate-limit text", async () => {
  await fixture({ type: "provider.auth", status: 401, message: "Invalid API key; rate limit policy requires authentication" }, async (f) => {
    const r = await f.post("/v1/messages", { ...body, max_tokens: 20 })
    assert.equal(r.status, 401)
    assert.equal((await r.json()).error.type, "authentication_error")
    assert.equal(f.turns(), 1)
    assert.equal((await f.health()).pool.quotaExhausted, false)
  })
})

test("real 429 preserves rate-limit status and cooldown signal", async () => {
  await fixture({ type: "provider.rate_limit", status: 429, message: "Rate limit exceeded" }, async (f) => {
    const r = await f.post("/v1/responses", { model: body.model, input: "diagnostic" })
    assert.equal(r.status, 429)
    assert.equal((await r.json()).error.code, "rate_limit_exceeded")
    const h = await f.health()
    assert.equal(h.pool.quotaExhausted, true)
    assert.equal(h.pool.cooling, 2)
  })
})

test("503 capacity error is not reported as exhausted quota", async () => {
  await fixture({ type: "provider.internal", status: 503, message: "Provider capacity temporarily unavailable" }, async (f) => {
    const r = await f.post("/v1/chat/completions", body)
    assert.equal(r.status, 503)
    assert.equal((await f.health()).pool.quotaExhausted, false)
  })
})

test("stream errors retain free-tier classification without account rotation", async () => {
  await fixture({ type: "provider.auth", status: 403, message: denied }, async (f) => {
    const r = await f.post("/v1/chat/completions", { ...body, stream: true })
    assert.equal(r.status, 403) // Preserve HTTP errors before any stream content.
    const err = (await r.json()).error
    assert.equal(err?.code, "free_tier_access_denied")
    assert.equal(f.turns(), 1)
    assert.equal((await f.health()).pool.quotaExhausted, false)
  })
})

const limited = { type: "provider.quota", status: 429, message: "Rate limit exceeded" }

test("repeated concurrent requests do not retry a fully cooling model", async () => {
  await fixture(limited, async (f) => {
    const first = await f.post("/v1/chat/completions", body)
    assert.equal(first.status, 429)
    assert.equal(f.turns(), 2)
    const repeated = await Promise.all(Array.from({ length: 5 }, () => f.post("/v1/chat/completions", body)))
    assert.ok(repeated.every((r) => r.status === 429))
    assert.equal(f.turns(), 2)
    assert.ok(Number(first.headers.get("retry-after")) > 0)
  })
})

test("one model's limit neither exhausts all models nor clears on another model's success", async () => {
  await fixture(({ model }) => model === body.model ? limited : null, async (f) => {
    assert.equal((await f.post("/v1/chat/completions", body)).status, 429)
    assert.equal((await f.health()).pool.quotaExhausted, false)
    assert.equal((await f.post("/v1/chat/completions", { ...body, model: "big-pickle" })).status, 200)
    assert.equal(f.turns(), 3)
    assert.equal((await f.post("/v1/chat/completions", body)).status, 429)
    assert.equal(f.turns(), 3)
  }, { models: [body.model, "big-pickle"] })
})

test("provider Retry-After is returned before SSE starts and is respected locally", async () => {
  await fixture({ ...limited, response: { headers: { "retry-after": "60" } } }, async (f) => {
    const r = await f.post("/v1/chat/completions", { ...body, stream: true })
    assert.equal(r.status, 429)
    assert.equal(r.headers.get("content-type"), "application/json")
    const seconds = Number(r.headers.get("retry-after"))
    assert.ok(seconds > 0 && seconds <= 60)
    assert.equal((await r.json()).error.code, "rate_limit_exceeded")
    const again = await f.post("/v1/chat/completions", body)
    assert.equal(again.status, 429)
    assert.equal(f.turns(), 2)
  })
})

test("an elapsed cooldown admits requests again", async () => {
  await fixture(({ turn }) => turn <= 2 ? limited : null, async (f) => {
    assert.equal((await f.post("/v1/chat/completions", body)).status, 429)
    await delay(260)
    const r = await f.post("/v1/chat/completions", body)
    assert.equal(r.status, 200)
    assert.equal(f.turns(), 3)
  }, { cooldown: 0.2 })
})

test("network cooldown applies across models without retrying unavailable instances", async () => {
  await fixture({ message: "fetch failed: ECONNREFUSED" }, async (f) => {
    assert.ok((await f.post("/v1/chat/completions", body)).status >= 500)
    assert.equal(f.turns(), 2)
    const r = await f.post("/v1/chat/completions", { ...body, model: "big-pickle" })
    assert.equal(r.status, 503)
    assert.ok(Number(r.headers.get("retry-after")) > 0)
    assert.equal(f.turns(), 2)
  }, { models: [body.model, "big-pickle"] })
})

test("a partially emitted stream is never replayed on another account", async () => {
  await fixture(limited, async (f) => {
    const r = await f.post("/v1/chat/completions", { ...body, stream: true })
    assert.equal(r.status, 200)
    const frames = await r.text()
    assert.ok(frames.includes("PARTIAL"))
    assert.ok(frames.includes("rate_limit_exceeded"))
    assert.equal(f.turns(), 1)
  }, { partial: true })
})

for (const [name, failure, status] of [
  ["model rate limit", limited, 429],
  ["network failure", { message: "fetch failed: ECONNREFUSED" }, 503],
]) {
  test(`a late in-flight success cannot erase a newer ${name} cooldown`, async () => {
    await fixture(({ turn }) => turn === 1 ? null : failure, async (f) => {
      const first = f.post("/v1/chat/completions", body)
      await delay(10)
      const second = f.post("/v1/chat/completions", body)
      await Promise.all([first, second])
      assert.equal(f.turns(), 2)
      assert.equal((await f.post("/v1/chat/completions", body)).status, status)
      assert.equal(f.turns(), 2)
    }, { accounts: ["a"], delay: ({ turn }) => turn === 1 ? 120 : 5 })
  })
}

test("a concurrent shorter Retry-After cannot shorten an active cooldown", async () => {
  await fixture(({ turn }) => ({ ...limited, response: { headers: { "retry-after": turn === 1 ? "120" : "10" } } }), async (f) => {
    const first = f.post("/v1/chat/completions", body)
    await delay(10)
    const second = f.post("/v1/chat/completions", body)
    await Promise.all([first, second])
    const again = await f.post("/v1/chat/completions", body)
    assert.ok(Number(again.headers.get("retry-after")) > 110)
    assert.equal(f.turns(), 2)
  }, { accounts: ["a"], delay: ({ turn }) => turn === 1 ? 60 : 120 })
})

test("empty stream deltas do not hide a 429 or disable account failover", async () => {
  await fixture(limited, async (f) => {
    const r = await f.post("/v1/chat/completions", { ...body, stream: true })
    assert.equal(r.status, 429)
    assert.ok(Number(r.headers.get("retry-after")) > 0)
    assert.equal(f.turns(), 2)
  }, { partial: "" })
})

for (const [dialect, route, request] of [
  ["anthropic", "/v1/messages", { ...body, max_tokens: 20 }],
  ["openai", "/v1/chat/completions", body],
  ["responses", "/v1/responses", { model: body.model, input: "diagnostic" }],
]) {
  test(`${dialect} successful text and stream still complete`, async () => {
    await fixture(null, async (f) => {
      const plain = await f.post(route, request)
      assert.equal(plain.status, 200)
      const result = await plain.json()
      const text = dialect === "anthropic" ? result.content[0].text : dialect === "openai" ? result.choices[0].message.content : result.output[0].content[0].text
      assert.equal(text, "FIXTURE_OK")
      const streamed = await f.post(route, { ...request, stream: true })
      const output = await streamed.text()
      assert.equal(streamed.status, 200)
      assert.ok(output.includes("FIXTURE_OK"))
      assert.ok(output.includes(dialect === "anthropic" ? "message_stop" : dialect === "responses" ? "response.completed" : "[DONE]"))
      assert.equal((await f.health()).pool.quotaExhausted, false)
    })
  })
}

// ---------------------------------------------------------------------------
// Exit rotation triggers. Nord is stubbed (CCGW_NORD_ROTATE=stub): the guard
// and the decision are exercised end to end, but no network is touched.

const geoBlocked = { type: "provider.auth", status: 403, message: "This model is not available in your country" }

test("a pool-wide 429 rotates the exit once and retries the same model on it", async () => {
  // Both accounts answer 429 inside one request: the model is pool-wide
  // limited, so the gateway rotates the exit and retries the same model on it.
  await fixture(({ turn }) => turn <= 2 ? limited : null, async (f) => {
    const r = await f.post("/v1/chat/completions", body)
    assert.equal(r.status, 200)
    assert.equal((await r.json()).choices[0].message.content, "FIXTURE_OK")
    assert.equal(f.turns(), 3) // account a, account b, then the retry on the new node
    const log = f.log()
    assert.ok(log.includes('"event":"rotating"'), "rotation was attempted")
    assert.ok(log.includes('"phase":"nord-rotate","event":"retry"'), "same-model retry on the new exit was logged")
  }, { cooldown: 30, env: { CCGW_NORD_ROTATE: "stub" } })
})

test("an account-level 429 fails over to the next account without rotating", async () => {
  await fixture(({ turn }) => turn === 1 ? limited : null, async (f) => {
    assert.equal((await f.post("/v1/chat/completions", body)).status, 200)
    assert.equal(f.turns(), 2)
    assert.ok(!f.log().includes('"phase":"nord-rotate"'), "no rotation for a single-account limit")
  }, { cooldown: 30, env: { CCGW_NORD_ROTATE: "stub" } })
})

test("a chain that is geo-blocked end to end rotates the exit once and replays it", async () => {
  // Slot request: the ranked chain is [glm, deepseek]. Both models refuse this
  // exit, so the gateway moves to another Nord node and replays the chain.
  await fixture(({ turn }) => turn <= 2 ? geoBlocked : null, async (f) => {
    const r = await f.post("/v1/messages", { model: "claude-opus-5", max_tokens: 64, messages: [{ role: "user", content: "diagnostic" }] })
    assert.equal(r.status, 200)
    assert.deepEqual(f.hits().map((h) => h.model), ["glm-5.3-flash-free", "deepseek-v4.1-flash-free", "glm-5.3-flash-free"])
    const log = f.log()
    assert.ok(log.includes('"reason":"geo-blocked"'), "the retry names the geo reason")
    assert.ok(log.includes('"phase":"nord-rotate","event":"retry"'))
    assert.equal((await f.health()).pool.quotaExhausted, false)
  }, { models: ["glm-5.3-flash-free", "deepseek-v4.1-flash-free"], env: { CCGW_NORD_ROTATE: "stub" } })
})

test("a geo restriction on one model falls back without rotating the exit", async () => {
  await fixture(({ model }) => model === "glm-5.3-flash-free" ? geoBlocked : null, async (f) => {
    const r = await f.post("/v1/messages", { model: "claude-opus-5", max_tokens: 64, messages: [{ role: "user", content: "diagnostic" }] })
    assert.equal(r.status, 200)
    assert.deepEqual(f.hits().map((h) => h.model), ["glm-5.3-flash-free", "deepseek-v4.1-flash-free"])
    assert.ok(!f.log().includes('"phase":"nord-rotate"'), "no exit change while another model serves")
  }, { models: ["glm-5.3-flash-free", "deepseek-v4.1-flash-free"], env: { CCGW_NORD_ROTATE: "stub" } })
})

test("an auth failure after a geo block does not rotate the exit", async () => {
  // The chain ended on a credential error: another exit cannot fix it, so the
  // rotation budget must not be spent and the real reason must surface.
  await fixture(({ model }) => model === "glm-5.3-flash-free"
    ? geoBlocked
    : { type: "provider.auth", status: 401, message: "invalid api key" }, async (f) => {
    const r = await f.post("/v1/messages", { model: "claude-opus-5", max_tokens: 64, messages: [{ role: "user", content: "diagnostic" }] })
    assert.equal(r.status, 401)
    assert.ok(!f.log().includes('"phase":"nord-rotate"'), "no rotation for a non-exit failure")
  }, { models: ["glm-5.3-flash-free", "deepseek-v4.1-flash-free"], env: { CCGW_NORD_ROTATE: "stub" } })
})

test("a rotation is deferred while another turn is still running", async () => {
  await fixture(({ turn }) => turn >= 2 && turn <= 3 ? limited : null, async (f) => {
    // A slow turn on another model holds the pool: the pool-wide-limited
    // request must not rotate the node out from under it.
    const slow = f.post("/v1/chat/completions", { ...body, model: "big-pickle" })
    await waitFor(() => f.turns() >= 1)
    const r = await f.post("/v1/chat/completions", body)
    assert.equal(r.status, 429)
    assert.equal((await slow).status, 200)
    const log = f.log()
    assert.ok(log.includes('"phase":"nord-rotate","event":"deferred"'), "rotation deferred for the running turn")
    assert.ok(!log.includes('"event":"rotated"'), "no node change while a turn was running")
  }, { cooldown: 30, models: ["deepseek-v4.1-flash-free", "big-pickle"], delay: ({ model }) => model === "big-pickle" ? 700 : 5, env: { CCGW_NORD_ROTATE: "stub", CCGW_NORD_DRAIN_MS: "0" } })
})

// ---------------------------------------------------------------------------
// Control-plane failures (the gateway's own OpenCode calls: plugin readiness,
// session create, prompt) are account-level, not model-level: they must never
// spend the ranked model chain.

test("control-plane failures classify as account-level network errors", () => {
  const timeout = classifyError(new Error("OpenCode GET /api/plugin?location%5Bdirectory%5D=D%3A%5CTemp%5Cccgw-scratch timed out after 30000ms"))
  assert.equal(timeout.kind, "network")
  assert.equal(timeout.code, "control_plane_error")
  const refused = classifyError(Object.assign(new Error("GET /api/plugin?location%5Bdirectory%5D=x -> 500 fixture plugin failure"), { status: 500, response: { body: "{}", headers: {} } }))
  assert.equal(refused.kind, "network")
  assert.equal(refused.code, "control_plane_error")
  const plugin = classifyError(Object.assign(new Error("Gateway session plugin is not active; output budgets and retry ownership cannot be enforced."), { status: 503, code: "gateway_plugin_unavailable" }))
  assert.equal(plugin.kind, "network")
  assert.equal(plugin.code, "control_plane_error")
  assert.equal(plugin.status, 503)
  // A model-level geo refusal keeps its own classification (precedence guard).
  const geo = classifyError(Object.assign(new Error("This model is not available in your country"), { status: 403 }))
  assert.equal(geo.kind, "upstream")
  assert.equal(geo.code, "model_geo_blocked")
})

test("a control-plane failure on one account fails over instead of walking models", async () => {
  await fixture(null, async (f) => {
    const r = await f.post("/v1/chat/completions", body)
    assert.equal(r.status, 200)
    assert.equal(f.turns(), 1)
    assert.deepEqual(f.hits().map((h) => h.account), ["b"], "the healthy account served on the same model")
    const log = f.log()
    assert.ok(log.includes('"phase":"rotate"'), "the broken account was rotated out")
    assert.ok(!log.includes('"phase":"model-fallback"'), "the model chain was not walked")
  }, { pluginFailure: ({ account }) => account === "a" ? 500 : null })
})

test("a control-plane failure on every account fails without walking models", async () => {
  await fixture(null, async (f) => {
    const r = await f.post("/v1/chat/completions", body)
    assert.equal(r.status, 500)
    assert.equal(f.turns(), 0, "no model was prompted")
    assert.ok(!f.log().includes('"phase":"model-fallback"'), "the model chain was not walked")
  }, { pluginFailure: () => 500 })
})

// A turn the gateway itself aborts (the idle window elapsed with zero session
// events) is a latency failure, not a model or account refusal: the request
// fails at once with 504 / turn_timeout instead of repeating the huge prompt
// on every model in the ranked chain or cooling an account.
test("a silent upstream trips the turn idle timeout: 504, one prompt, no chain walk", async () => {
  await fixture(null, async (f) => {
    const r = await f.post("/v1/chat/completions", body)
    assert.equal(r.status, 504)
    const j = await r.json()
    assert.equal(j.error.code, "turn_timeout")
    assert.equal(j.error.message, "timeout")
    assert.equal(f.turns(), 1, "the silent model was prompted once despite the ranked chain")
    await delay(300) // logLine appends asynchronously; give the error line time to land
    const log = f.log()
    assert.ok(!log.includes('"phase":"model-fallback"'), "no chain walk after a turn timeout")
    assert.ok(log.includes('"errorCode":"turn_timeout"'), "the turn log names the timeout")
    assert.ok(log.includes('"events":0'), "the silent attempt recorded zero upstream events")
  }, { models: ["deepseek-v4.1-flash-free", "glm-5.3-flash-free"], delay: () => 1500, env: { CCGW_TURN_TIMEOUT: "400" } })
})

// The upstream reports a dead model with more than one wording (measured live:
// "Model unavailable: opencode/<id>" and "Model <id> has been deprecated.").
// model-park.mjs counts strikes from these texts, so both shapes must match.
test("model-level refusal shapes are recognized; request/geo errors are not", () => {
  assert.equal(isModelLevelRefusal("Model unavailable: opencode/muse-spark-1.3-contributor-free"), true)
  assert.equal(isModelLevelRefusal("Model muse-spark-1.3-contributor-free has been deprecated."), true)
  assert.equal(isModelLevelRefusal("Upstream request failed: Endpoint is unavailable."), true)
  assert.equal(isModelLevelRefusal("所选模型不支持图片，请选择支持图片的模型：glm-5.3-flash-free"), false)
  assert.equal(isModelLevelRefusal("Invalid value for 'tools': maximum number of items is 128."), false)
  assert.equal(isModelLevelRefusal("This model is not available in your country"), false)
  assert.equal(isModelLevelRefusal("opencode/muse-spark-1.3-contributor-free"), false)
})
