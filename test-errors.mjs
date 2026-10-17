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
const denied = "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building."
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function fixture(error, run, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccgw-error-test-"))
  const subscribers = new Map()
  let turns = 0
  let serial = 0
  const sessions = new Map()
  const hits = []
  const upstream = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://localhost")
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
  const upstreamPort = await listen(upstream)
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
