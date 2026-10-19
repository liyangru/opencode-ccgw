// Control-plane requests (model list, sessions, interrupts) must never hang the
// gateway when the local OpenCode service stops answering: /health and every
// new turn await them. These tests pin the bounded request and the caller abort.
import assert from "node:assert/strict"
import { test, after } from "node:test"
import http from "node:http"
import { OpenCode } from "./engine.mjs"

const server = http.createServer((req, res) => {
  if (req.url === "/ok") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ ok: true }))
    return
  }
  // /hang: accept the request and never answer.
})

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const baseUrl = "http://127.0.0.1:" + server.address().port
const oc = new OpenCode({ baseUrl, password: "test" })

after(() => {
  server.closeAllConnections?.()
  server.close()
})

test("a hung request times out instead of hanging the caller", async () => {
  const t0 = Date.now()
  await assert.rejects(
    oc.req("GET", "/hang", undefined, { timeoutMs: 200 }),
    /timed out after 200ms/,
  )
  const took = Date.now() - t0
  assert.ok(took < 5000, "timeout should fire quickly, took " + took + "ms")
})

test("a caller abort wins and keeps its reason", async () => {
  const ac = new AbortController()
  const pending = oc.req("GET", "/hang", undefined, { timeoutMs: 60000, signal: ac.signal })
  setTimeout(() => ac.abort(new Error("client disconnected")), 50)
  await assert.rejects(pending, /client disconnected/)
})

test("normal control-plane calls are unchanged", async () => {
  const r = await oc.req("GET", "/ok", undefined, { timeoutMs: 2000 })
  assert.equal(r.status, 200)
  assert.equal(r.ok, true)
  assert.deepEqual(r.json, { ok: true })
  assert.equal(r.text, '{"ok":true}')
})

test("a pre-aborted signal rejects without sending a request", async () => {
  const ac = new AbortController()
  ac.abort(new Error("already gone"))
  await assert.rejects(
    oc.req("GET", "/ok", undefined, { timeoutMs: 2000, signal: ac.signal }),
    /already gone/,
  )
})
