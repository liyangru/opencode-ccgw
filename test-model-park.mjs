// Park arithmetic for models the upstream refuses at the model level.
// The gateway side of this is exercised by test-model-fallback.mjs (the chain
// skips parked models); this suite pins the strike/TTL state machine.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createModelPark } from './model-park.mjs'

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

test('one refusal is a strike, the second parks for the base TTL', () => {
  const c = clock()
  const park = createModelPark({ now: c.now })
  const first = park.noteRefusal('muse-spark-1.3-contributor-free', 'Model unavailable: opencode/muse-spark-1.3-contributor-free')
  assert.equal(first.parked, false, 'a single refusal does not park')
  assert.equal(first.strikes, 1)
  assert.equal(park.isParked('muse-spark-1.3-contributor-free'), false)
  const second = park.noteRefusal('muse-spark-1.3-contributor-free', 'Model unavailable: opencode/muse-spark-1.3-contributor-free')
  assert.equal(second.parked, true, 'the second consecutive refusal parks')
  assert.equal(second.seconds, 30 * 60, 'base TTL is 30 minutes')
  assert.equal(park.isParked('muse-spark-1.3-contributor-free'), true)
  assert.equal(park.strikesFor('muse-spark-1.3-contributor-free'), 2)
})

test('the TTL grows x4 per extra strike, capped at 6 h', () => {
  const c = clock()
  const park = createModelPark({ now: c.now })
  park.noteRefusal('m', 'x')
  park.noteRefusal('m', 'x')
  c.advance(31 * 60 * 1000) // let the first park expire; the model is tried again
  assert.equal(park.isParked('m'), false, 'an expired park releases the model')
  assert.equal(park.noteRefusal('m', 'x').seconds, 2 * 60 * 60, 'third strike -> 30 min x4 = 2 h')
  c.advance(3 * 60 * 60 * 1000)
  assert.equal(park.noteRefusal('m', 'x').seconds, 6 * 60 * 60, 'fourth strike -> 8 h capped to 6 h')
  c.advance(7 * 60 * 60 * 1000)
  assert.equal(park.noteRefusal('m', 'x').seconds, 6 * 60 * 60, 'further strikes stay at the cap')
})

test('one success clears the strikes and the park', () => {
  const c = clock()
  const park = createModelPark({ now: c.now })
  park.noteRefusal('glm-5.3-flash-free', 'Upstream request failed: Endpoint is unavailable.')
  park.noteRefusal('glm-5.3-flash-free', 'Upstream request failed: Endpoint is unavailable.')
  assert.equal(park.isParked('glm-5.3-flash-free'), true)
  park.noteSuccess('glm-5.3-flash-free')
  assert.equal(park.isParked('glm-5.3-flash-free'), false, 'a success un-parks the model')
  assert.equal(park.strikesFor('glm-5.3-flash-free'), 0, 'the strike history is gone, not merely expired')
  assert.equal(park.noteRefusal('glm-5.3-flash-free', 'x').strikes, 1, 'the count restarts from one')
})

test('baseMs 0 disables parking (refusals are still counted)', () => {
  const c = clock()
  const park = createModelPark({ baseMs: 0, now: c.now })
  park.noteRefusal('m', 'x')
  const r = park.noteRefusal('m', 'x')
  assert.equal(r.parked, false)
  assert.equal(r.seconds, 0)
  assert.equal(park.isParked('m'), false)
  assert.equal(r.strikes, 2)
})

test('snapshot lists only active parks, with remaining seconds and reason', () => {
  const c = clock()
  const park = createModelPark({ now: c.now })
  park.noteRefusal('dead-free', 'Model unavailable: opencode/dead-free')
  park.noteRefusal('dead-free', 'Model unavailable: opencode/dead-free')
  park.noteRefusal('flaky-free', 'Endpoint is unavailable')
  const snap = park.snapshot()
  assert.deepEqual(Object.keys(snap), ['dead-free'])
  assert.equal(snap['dead-free'].seconds, 30 * 60)
  assert.match(snap['dead-free'].reason, /Model unavailable/)
  c.advance(30 * 60 * 1000 + 1)
  assert.deepEqual(park.snapshot(), {}, 'expired parks disappear from /health')
})

test('an unknown model is never parked', () => {
  const park = createModelPark()
  assert.equal(park.isParked('never-seen-free'), false)
  assert.equal(park.strikesFor('never-seen-free'), 0)
})

// ---------------------------------------------------------------------------
// Persistence: with a file configured the record survives a restart, so the
// new process resumes the park (and the partial strike count) instead of
// re-learning it in CCGW_MODEL_PARK_STRIKES turns.

test('a configured file makes the park and strikes survive a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-park-file-'))
  const file = path.join(dir, 'model-park.json')
  try {
    const c = clock()
    const a = createModelPark({ now: c.now, file })
    a.noteRefusal('dead-free', 'Model unavailable: opencode/dead-free')
    a.noteRefusal('dead-free', 'Model unavailable: opencode/dead-free')
    assert.equal(a.isParked('dead-free'), true)

    const b = createModelPark({ now: c.now, file })
    assert.equal(b.isParked('dead-free'), true, 'the restarted process still parks the model')
    assert.equal(b.strikesFor('dead-free'), 2, 'the strike count carries over, not just the TTL')
    assert.equal(b.snapshot()['dead-free'].reason, 'Model unavailable: opencode/dead-free')

    b.noteSuccess('dead-free')
    const d = createModelPark({ now: c.now, file })
    assert.equal(d.isParked('dead-free'), false, 'a success clears the persisted record')
    assert.equal(d.strikesFor('dead-free'), 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a pre-park strike survives a restart so one more refusal parks it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-park-file2-'))
  const file = path.join(dir, 'model-park.json')
  try {
    const c = clock()
    createModelPark({ now: c.now, file }).noteRefusal('flaky-free', 'Endpoint is unavailable')
    const restarted = createModelPark({ now: c.now, file })
    const r = restarted.noteRefusal('flaky-free', 'Endpoint is unavailable')
    assert.equal(r.parked, true, 'the second strike overall parks it, even across a restart')
    assert.equal(r.strikes, 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt file starts clean, and parking still works afterwards', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-park-file3-'))
  const file = path.join(dir, 'model-park.json')
  try {
    fs.writeFileSync(file, '{not json')
    const park = createModelPark({ file })
    assert.equal(park.isParked('m'), false, 'a corrupt file is ignored, not fatal')
    park.noteRefusal('m', 'x')
    park.noteRefusal('m', 'x')
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).entries.m.strikes, 2, 'the next write repairs the file')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// End-to-end: the fixture upstream refuses one model exactly the way the live
// pool does ("Model unavailable: opencode/<id>"). Two refused requests must
// park it, and the third request's chain must not walk into it any more.

const root = path.dirname(fileURLToPath(import.meta.url))
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function fixture(error, run, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-park-test-'))
  const subscribers = new Map()
  let turns = 0
  let serial = 0
  const sessions = new Map()
  const hits = []
  const upstream = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost')
    if (u.pathname === '/__probe') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('fixture'); return }
    const account = u.pathname.split('/')[1]
    const route = u.pathname.slice(account.length + 1)
    const json = (body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (route === '/api/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': connected\n\n')
      subscribers.set(account, res)
      req.on('close', () => subscribers.delete(account))
    } else if (route === '/api/model') {
      json({ data: (options.models || ['glm-5.3-flash-free']).map((id) => ({ id, providerID: 'opencode', enabled: true, cost: [{ input: 0, output: 0 }] })) })
    } else if (route === '/api/plugin') {
      json({ data: [{ id: 'ccgw-output-budget-v1', state: { status: 'active' } }] })
    } else if (req.method === 'POST' && route === '/api/session') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const input = JSON.parse(Buffer.concat(chunks).toString())
      const id = 'ses_fixture_' + (++serial)
      sessions.set(id, input.model?.id)
      json({ data: { id } })
    } else if (req.method === 'POST' && /\/prompt$/.test(route)) {
      req.resume()
      const sessionID = route.split('/')[3]
      turns++
      const model = sessions.get(sessionID)
      hits.push({ account, model })
      const failure = typeof error === 'function' ? error({ account, model, turn: turns }) : error
      json({})
      setTimeout(() => {
        const send = (type, data) => subscribers.get(account)?.write('data: ' + JSON.stringify({ type, data: { sessionID, ...data } }) + '\n\n')
        if (failure) send('session.execution.failed', { error: failure })
        else {
          send('session.text.delta', { delta: 'FIXTURE_OK' })
          send('session.execution.succeeded', {})
        }
      }, 5)
    } else { req.resume(); json({}) }
  })
  const upstreamPort = await listen(upstream)
  const reservation = http.createServer()
  const gatewayPort = await listen(reservation)
  await new Promise((resolve) => reservation.close(resolve))
  const accountsFile = path.join(dir, 'accounts.json')
  fs.writeFileSync(accountsFile, JSON.stringify({ accounts: ['a', 'b'].map((name) => ({ name, url: `http://127.0.0.1:${upstreamPort}/${name}` })) }))
  const child = spawn(process.execPath, [path.join(root, 'server.mjs')], {
    cwd: root,
    env: { ...process.env, CCGW_PORT: String(gatewayPort), CCGW_ACCOUNTS_FILE: accountsFile,
      CCGW_SCRATCH: path.join(dir, 'scratch'), CCGW_LOG: path.join(dir, 'gateway.log'),
      CCGW_KEEP_SESSIONS: '1', CCGW_TOKEN: 'fixture-only', CCGW_TURN_TIMEOUT: '3000',
      CCGW_STATE_FILE: path.join(dir, 'cooldowns.json'),
      CCGW_MODEL_PARK_FILE: path.join(dir, 'model-park.json'),
      CCGW_NORD_ROTATE: 'off', CCGW_NORD_STATE: path.join(dir, 'nord-rotate.state.json') },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (x) => { output += x })
  child.stderr.on('data', (x) => { output += x })
  const base = `http://127.0.0.1:${gatewayPort}`
  try {
    const deadline = Date.now() + 8000
    while (true) {
      if (child.exitCode !== null) throw new Error(output)
      try {
        const h = await (await fetch(base + '/health')).json()
        if (h.accounts.every((a) => a.eventStream)) break
      } catch {}
      if (Date.now() >= deadline) throw new Error('Fixture startup timed out: ' + output)
      await delay(30)
    }
    await run({
      hits: () => hits,
      log: () => fs.readFileSync(path.join(dir, 'gateway.log'), 'utf8'),
      health: async () => (await fetch(base + '/health')).json(),
      post: (route, body) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      get: (route, headers) => fetch(base + route, { headers }),
    })
  } finally {
    child.kill()
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve))
    upstream.closeAllConnections?.()
    await new Promise((resolve) => upstream.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('two model-level refusals park the model; the next chain skips it (end-to-end)', async () => {
  const failure = ({ model }) => model === 'dead-free'
    ? { type: 'api_error', status: 502, message: 'Model unavailable: opencode/dead-free' }
    : { type: 'api_error', status: 502, message: 'fixture upstream wobble' }
  await fixture(failure, async (f) => {
    const send = () => f.post('/v1/messages', { model: 'auto', max_tokens: 64, messages: [{ role: 'user', content: 'diagnostic' }] })
    const deadHits = () => f.hits().filter((h) => h.model === 'dead-free').length
    assert.equal((await send()).status, 502)
    assert.equal(deadHits(), 1, 'the first walk reaches the dead model once')
    assert.equal((await send()).status, 502)
    assert.equal(deadHits(), 2, 'the second refusal parks it')
    const h = await f.health()
    assert.ok(h.modelPark['dead-free'], '/health lists the parked model')
    assert.ok(Number(h.modelPark['dead-free'].seconds) > 0)
    assert.equal(h.modelPark['dead-free'].strikes, 2)
    // The model list marks the park (both shapes) so a client can see why the
    // automatic chain skips it; the model itself stays listed and requestable.
    const listOA = await (await f.get('/v1/models')).json()
    const dead = listOA.data.find((m) => m.id === 'dead-free')
    assert.equal(dead.ccgw_parked, true, 'the OpenAI model list marks the parked model')
    assert.ok(dead.ccgw_parked_seconds > 0, 'the mark carries the remaining seconds')
    assert.ok(!listOA.data.find((m) => m.id === 'glm-5.3-flash-free')?.ccgw_parked, 'healthy models are not marked')
    const listAN = await (await f.get('/v1/models', { 'anthropic-version': '2023-06-01' })).json()
    assert.equal(listAN.data.find((m) => m.id === 'dead-free').ccgw_parked, true, 'the Anthropic model list marks it too')
    // Turn tracking: every completed request lands in /health.turns.
    assert.ok(h.turns && h.turns.count >= 2, 'completed turns are counted')
    assert.ok(h.turns.recent.length >= 1 && typeof h.turns.recent[0].ms === 'number', 'recent turn latencies are exposed')
    assert.equal((await send()).status, 502)
    assert.equal(deadHits(), 2, 'the third request no longer walks into the parked model')
    assert.match(f.log(), /"phase":"model-park"/, 'the park is logged')
    assert.match(f.log(), /"phase":"model-fallback"/, 'the refusals themselves still walked the chain')
  }, { models: ['glm-5.3-flash-free', 'dead-free'] })
})
