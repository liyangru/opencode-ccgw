// Turn deadline semantics. The old cap was wall-clock: a healthy long turn
// died at CCGW_TURN_TIMEOUT no matter what it was doing (measured live
// 2026-10-19: a 141-tool desktop turn aborted at 181.8s while its sibling with
// the same prompt size finished at 124.4s). Now timeoutMs is an *idle* window
// that any session event resets, maxMs is a hard ceiling, and a tripped
// deadline fails as "timeout" (504 / turn_timeout) instead of walking the
// model chain or cooling an account. These tests drive runTurn() itself with a
// stub OpenCode client; the gateway-level path is pinned in test-errors.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { runTurn } from './engine.mjs'
import { classifyError } from './errors.mjs'

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-deadline-'))

function stubOc(sessionID = 'ses_deadline') {
  const calls = []
  const listeners = new Set()
  return {
    calls,
    emit(type, data = {}) { for (const fn of listeners) fn({ type, data: { sessionID, ...data } }) },
    async reqOrThrow(method, p) {
      calls.push(p)
      if (p.startsWith('/api/plugin')) return { data: [{ id: 'ccgw-output-budget-v1', state: { status: 'active' } }] }
      if (p === '/api/session') return { data: { id: sessionID } }
      if (p.endsWith('/prompt')) return {}
      throw new Error('unexpected request ' + p)
    },
    async req(method, p) { calls.push(p); return { ok: true } },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
  }
}

const opts = (dir, extra) => ({ dir, model: { providerID: 'opencode', id: 'diagnostic-free' }, promptText: 'deadline', ...extra })

test('a silent upstream trips the idle window and the turn is interrupted', async () => {
  const dir = tmpdir()
  try {
    const oc = stubOc()
    const t0 = Date.now()
    const r = await runTurn(oc, opts(dir, { timeoutMs: 200, maxMs: 60000 }))
    const took = Date.now() - t0
    assert.equal(r.error?.message, 'timeout', 'the abort reason is the idle timeout')
    assert.equal(r.finish, 'error')
    assert.ok(took >= 150 && took < 5000, 'aborted near the idle window, took ' + took + 'ms')
    assert.ok(oc.calls.some((p) => p.endsWith('/interrupt')), 'the stalled turn was interrupted upstream')
    assert.equal(r.events.count, 0, 'no session events arrived')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('session events reset the idle clock; the turn dies only after they stop', async () => {
  const dir = tmpdir()
  try {
    const oc = stubOc()
    let done = false
    const pending = runTurn(oc, opts(dir, { timeoutMs: 400, maxMs: 60000 })).then((r) => { done = true; return r })
    const pulse = setInterval(() => oc.emit('session.step.ended', {}), 100)
    let r = null
    try {
      await delay(900)
      assert.equal(done, false, 'the turn survived past the idle window because events kept arriving')
    } finally {
      clearInterval(pulse)
    }
    r = await pending
    assert.equal(r.error?.message, 'timeout', 'once the events stop, the idle window finally trips')
    assert.ok(r.events.count >= 7, 'the pulse events were counted: ' + r.events.count)
    assert.ok(r.events.maxGapMs >= 50, 'the longest silent gap is measured: ' + r.events.maxGapMs)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the hard ceiling ends a turn that keeps trickling events forever', async () => {
  const dir = tmpdir()
  try {
    const oc = stubOc()
    const t0 = Date.now()
    const pulse = setInterval(() => oc.emit('session.step.ended', {}), 50)
    let r = null
    try {
      r = await runTurn(oc, opts(dir, { timeoutMs: 5000, maxMs: 400 }))
    } finally {
      clearInterval(pulse)
    }
    const took = Date.now() - t0
    assert.equal(r.error?.message, 'turn max time exceeded')
    assert.ok(took >= 350 && took < 4000, 'the ceiling fired near maxMs, took ' + took + 'ms')
    assert.ok(oc.calls.some((p) => p.endsWith('/interrupt')), 'the runaway turn was interrupted upstream')
    assert.ok(r.events.count >= 3, 'progress was flowing the whole time: ' + r.events.count)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('turn timeouts classify as their own kind, never as a model or account failure', () => {
  const idle = classifyError({ type: 'timeout', message: 'timeout' })
  assert.equal(idle.kind, 'timeout')
  assert.equal(idle.code, 'turn_timeout')
  assert.equal(idle.status, 504)
  const ceiling = classifyError(new Error('turn max time exceeded'))
  assert.equal(ceiling.kind, 'timeout')
  assert.equal(ceiling.code, 'turn_timeout')
  assert.equal(ceiling.status, 504)
  // An upstream response that merely says "timeout" keeps its upstream status.
  const upstream = classifyError(Object.assign(new Error('timeout'), { status: 502 }))
  assert.equal(upstream.kind, 'upstream')
  assert.equal(upstream.status, 502)
})

console.log('turn-timeout suite: idle reset, hard ceiling, interrupt and classification checks loaded')
