// Nord exit rotation guard: the gateway may rotate the exit node when the
// pool is rate-limited (user instruction 2026-10-19). These tests pin the
// anti-thrash policy and the state bookkeeping; nothing here touches the
// network (the rotate runner is injected).
import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { planRotate, rotateEgress, loadState, saveState, waitForIdle, DEFAULT_CONFIG } from "./nord-rotate.mjs"

const cfg = { ...DEFAULT_CONFIG }
const tmpState = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ccgw-nord-")), "state.json")
const okEvent = (ts, group = "Japan") => ({ ts, ok: true, group, reason: "test", detail: "" })

test("guard allows the first rotation", () => {
  assert.equal(planRotate({ events: [] }, 1_000_000, cfg).ok, true)
})

test("guard blocks a second rotation inside the min interval", () => {
  const now = 1_000_000
  const d = planRotate({ events: [okEvent(now - 30_000)] }, now, cfg)
  assert.equal(d.ok, false)
  assert.equal(d.reason, "cooldown")
  assert.ok(d.waitSec > 0 && d.waitSec <= cfg.minIntervalSec)
})

test("guard re-allows after the min interval", () => {
  const now = 1_000_000
  assert.equal(planRotate({ events: [okEvent(now - (cfg.minIntervalSec + 1) * 1000)] }, now, cfg).ok, true)
})

test("guard blocks after the hourly cap", () => {
  const now = 10_000_000
  const events = Array.from({ length: cfg.maxPerHour }, (_, i) => okEvent(now - (i + 1) * cfg.minIntervalSec * 1000))
  const d = planRotate({ events }, now, cfg)
  assert.equal(d.ok, false)
  assert.equal(d.reason, "hourly-cap")
})

test("failed rotations do not count toward the guard", () => {
  const now = 10_000_000
  const events = Array.from({ length: cfg.maxPerHour + 2 }, (_, i) => ({ ts: now - (i + 1) * 1000, ok: false, reason: "test", detail: "boom" }))
  assert.equal(planRotate({ events }, now, cfg).ok, true)
})

test("disabled config blocks rotation unless forced", () => {
  const now = 1_000_000
  assert.equal(planRotate({ events: [] }, now, { ...cfg, enabled: false }).ok, false)
  assert.equal(planRotate({ events: [] }, now, { ...cfg, enabled: false }, true).ok, true)
})

test("a successful rotation records state, returns the group, and starts the cooldown", async () => {
  const stateFile = tmpState()
  const r = await rotateEgress({ reason: "test", stateFile, run: async () => ({ ok: true, group: "Netherlands", ip: "203.0.113.7", detail: "rotate: OK group=Netherlands ip=203.0.113.7" }) })
  assert.equal(r.rotated, true)
  assert.equal(r.group, "Netherlands")
  assert.equal(r.ip, "203.0.113.7")
  const state = loadState(stateFile)
  assert.equal(state.events.length, 1)
  assert.equal(state.lastGroup, "Netherlands")
  assert.ok(state.lastAt > 0)
  const second = await rotateEgress({ reason: "test", stateFile, run: async () => ({ ok: true, group: "Japan" }) })
  assert.equal(second.rotated, false)
  assert.equal(second.reason, "cooldown")
})

test("a failed rotation records the failure without extending the guard window", async () => {
  const stateFile = tmpState()
  const first = await rotateEgress({ reason: "test", stateFile, run: async () => ({ ok: true, group: "Japan" }) })
  assert.equal(first.rotated, true)
  const before = loadState(stateFile)
  const r = await rotateEgress({ reason: "test", force: true, stateFile, run: async () => ({ ok: false, group: null, detail: "rotate: FAILED" }) })
  assert.equal(r.rotated, false)
  const after = loadState(stateFile)
  assert.equal(after.lastAt, before.lastAt)
  assert.equal(after.lastGroup, "Japan")
  assert.equal(after.events.length, 2)
  assert.equal(after.events[1].ok, false)
})

test("a throwing runner is recorded as a failure, not an exception", async () => {
  const stateFile = tmpState()
  const r = await rotateEgress({ reason: "test", force: true, stateFile, run: async () => { throw new Error("powershell gone") } })
  assert.equal(r.rotated, false)
  const state = loadState(stateFile)
  assert.equal(state.events[0].ok, false)
  assert.ok(String(state.events[0].detail).includes("powershell gone"))
})

test("CCGW_NORD_ROTATE=off disables the automatic path", async () => {
  const previous = process.env.CCGW_NORD_ROTATE
  process.env.CCGW_NORD_ROTATE = "off"
  try {
    const stateFile = tmpState()
    let ran = false
    const r = await rotateEgress({ reason: "test", stateFile, run: async () => { ran = true; return { ok: true, group: "x" } } })
    assert.equal(r.rotated, false)
    assert.equal(r.reason, "disabled")
    assert.equal(ran, false)
  } finally {
    if (previous === undefined) delete process.env.CCGW_NORD_ROTATE
    else process.env.CCGW_NORD_ROTATE = previous
  }
})

test("waitForIdle returns once the other turns finish", async () => {
  const seq = [3, 2, 1]
  let i = 0
  const r = await waitForIdle(() => seq[Math.min(i++, seq.length - 1)], { idleAt: 1, timeoutMs: 10_000, intervalMs: 0, sleep: async () => {} })
  assert.equal(r.drained, true)
  assert.ok(i >= 2)
})

test("waitForIdle reports a timeout instead of forcing the rotation", async () => {
  let calls = 0
  const r = await waitForIdle(() => { calls++; return 4 }, { idleAt: 1, timeoutMs: 0, intervalMs: 0, sleep: async () => {} })
  assert.equal(r.drained, false)
  assert.ok(calls >= 1)
})

test("waitForIdle skips waiting when the caller is alone", async () => {
  const r = await waitForIdle(() => 1, { idleAt: 1, timeoutMs: 0 })
  assert.equal(r.drained, true)
})

test("state file trimming keeps the newest events", () => {
  const stateFile = tmpState()
  const events = Array.from({ length: 80 }, (_, i) => okEvent(i + 1))
  const saved = saveState({ events, lastAt: 80, lastGroup: "Japan" }, stateFile)
  assert.equal(saved.events.length, 50)
  assert.equal(loadState(stateFile).events.length, 50)
})
