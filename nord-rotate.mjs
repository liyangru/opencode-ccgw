// ccgw Nord exit rotation.
//
// User instruction (2026-10-19): when the free pool is rate-limited or the exit
// IP gets banned, switch to a different Nord node automatically. The free tier
// buckets requests per source IP, so a fresh node = a fresh bucket.
//
// Manual use:
//   node nord-rotate.mjs            # decide + rotate once (guard applies)
//   node nord-rotate.mjs --force    # ignore the guard
//   node nord-rotate.mjs --dry-run  # decision only, never touch the network
//
// Env:
//   CCGW_NORD_ROTATE=off     disable the automatic path entirely
//   CCGW_NORD_ROTATE=stub    test mode: decide + record, never touch the network
//   CCGW_NORD_MIN_INTERVAL_SEC / CCGW_NORD_MAX_PER_HOUR  guard overrides
//
// Config file (optional): nord-rotate.config.json with any of
//   { "enabled": true, "minIntervalSec": 120, "maxPerHour": 6, "timeoutMs": 120000 }
//
// State/audit: nord-rotate.state.json next to this file.
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const NORD_SCRIPT = path.join(__dirname, "zero-window", "nord-cli.ps1")
export const STATE_FILE = process.env.CCGW_NORD_STATE || path.join(__dirname, "nord-rotate.state.json")
const CONFIG_FILE = path.join(__dirname, "nord-rotate.config.json")

export const DEFAULT_CONFIG = { enabled: true, minIntervalSec: 120, maxPerHour: 6, timeoutMs: 120000 }

export function loadConfig() {
  const cfg = { ...DEFAULT_CONFIG }
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"))
    for (const k of Object.keys(DEFAULT_CONFIG)) {
      if (raw[k] !== undefined) cfg[k] = typeof DEFAULT_CONFIG[k] === "number" ? Number(raw[k]) : raw[k]
    }
  } catch {}
  if (process.env.CCGW_NORD_MIN_INTERVAL_SEC) cfg.minIntervalSec = Number(process.env.CCGW_NORD_MIN_INTERVAL_SEC) || cfg.minIntervalSec
  if (process.env.CCGW_NORD_MAX_PER_HOUR) cfg.maxPerHour = Number(process.env.CCGW_NORD_MAX_PER_HOUR) || cfg.maxPerHour
  const mode = String(process.env.CCGW_NORD_ROTATE || "on").toLowerCase()
  if (mode === "off") cfg.enabled = false
  cfg.mode = mode
  return cfg
}

export function loadState(file = STATE_FILE) {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"))
    if (!Array.isArray(s.events)) s.events = []
    return s
  } catch {
    return { events: [], lastAt: 0, lastGroup: null }
  }
}

export function saveState(state, file = STATE_FILE) {
  const trimmed = { ...state, events: (state.events || []).slice(-50) }
  try {
    fs.writeFileSync(file, JSON.stringify(trimmed, null, 2))
  } catch {}
  return trimmed
}

// Pure guard: may we rotate right now? Exported for tests.
export function planRotate(state, now, cfg = DEFAULT_CONFIG, force = false) {
  if (force) return { ok: true, forced: true }
  if (!cfg.enabled) return { ok: false, reason: "disabled" }
  const okEvents = (state?.events || []).filter((e) => e?.ok)
  const inHour = okEvents.filter((e) => now - Number(e.ts || 0) < 3600_000).length
  if (inHour >= cfg.maxPerHour) return { ok: false, reason: "hourly-cap", inHour }
  const last = Math.max(0, ...okEvents.map((e) => Number(e.ts || 0)))
  if (last && now - last < cfg.minIntervalSec * 1000) {
    return { ok: false, reason: "cooldown", waitSec: Math.ceil((cfg.minIntervalSec * 1000 - (now - last)) / 1000) }
  }
  return { ok: true }
}

// Wait until only `idleAt` turns are still running (the caller itself). A Nord
// disconnect tears down the tunnel that every in-flight upstream connection is
// using, so a rotation must not start while another turn is streaming. Exported
// for tests; `sleep` is injectable so the tests stay instant.
export async function waitForIdle(activeCount, opts = {}) {
  const { idleAt = 1, timeoutMs = 15000, intervalMs = 250, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = opts
  const t0 = Date.now()
  for (;;) {
    if (activeCount() <= idleAt) return { drained: true, waitedMs: Date.now() - t0 }
    const left = timeoutMs - (Date.now() - t0)
    if (left <= 0) return { drained: false, waitedMs: Date.now() - t0 }
    await sleep(Math.min(intervalMs, left))
  }
}

// Run zero-window\nord-cli.ps1 rotate and parse its one-line verdict.
export function runRotateScript(timeoutMs = DEFAULT_CONFIG.timeoutMs) {
  return new Promise((resolve) => {
    if (!fs.existsSync(NORD_SCRIPT)) return resolve({ ok: false, group: null, ip: null, detail: "nord-cli.ps1 not found at " + NORD_SCRIPT })
    let out = ""
    let settled = false
    let child = null
    const finish = (r) => {
      if (settled) return
      settled = true
      try { child?.kill() } catch {}
      resolve(r)
    }
    try {
      child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", NORD_SCRIPT, "rotate"], { windowsHide: true })
    } catch (e) {
      return finish({ ok: false, group: null, ip: null, detail: "spawn failed: " + String(e?.message || e) })
    }
    child.stdout?.on("data", (c) => { out += String(c) })
    child.stderr?.on("data", (c) => { out += String(c) })
    child.on("error", (e) => finish({ ok: false, group: null, ip: null, detail: "spawn failed: " + String(e?.message || e) }))
    child.on("close", (code) => {
      // Group names contain spaces ("Hong Kong"), so capture lazily up to the ip
      // field instead of \S+ (which used to record "Hong").
      const m = /rotate:\s*OK\s*group=(.+?)(?:\s+ip=(\S+))?\s*$/m.exec(out)
      finish({ ok: code === 0 && !!m, group: m ? m[1] : null, ip: m && m[2] && m[2] !== "unknown" ? m[2] : null, detail: out.trim().slice(-400) || "exit " + code })
    })
    setTimeout(() => finish({ ok: false, group: null, ip: null, detail: "timeout after " + timeoutMs + "ms; " + out.trim().slice(-200) }), timeoutMs)
  })
}

// Rotate the exit once, honoring the guard. `run` is injectable for tests.
export async function rotateEgress(opts = {}) {
  const { reason = "manual", log = () => {}, force = false, run = null, now = () => Date.now(), stateFile = STATE_FILE } = opts
  const cfg = loadConfig()
  const state = loadState(stateFile)
  const decision = planRotate(state, now(), cfg, force)
  if (!decision.ok) {
    log("skipped", decision.reason + (decision.waitSec ? " (" + decision.waitSec + "s left)" : ""))
    return { rotated: false, reason: decision.reason, waitSec: decision.waitSec }
  }
  const runner = run || (cfg.mode === "stub" ? async () => ({ ok: true, group: "stub", ip: null, detail: "stub mode: no network change" }) : runRotateScript)
  log("rotating", "reason=" + reason + (cfg.mode === "stub" ? " [stub]" : "") + " (minInterval=" + cfg.minIntervalSec + "s, cap=" + cfg.maxPerHour + "/h)")
  let result
  try {
    result = await runner(cfg.timeoutMs)
  } catch (e) {
    result = { ok: false, group: null, ip: null, detail: String(e?.message || e) }
  }
  const ts = now()
  const event = { ts, ok: !!result?.ok, group: result?.group || null, ip: result?.ip || null, reason, detail: String(result?.detail || "").slice(0, 300) }
  saveState({ lastAt: event.ok ? ts : Number(state.lastAt || 0), lastGroup: event.ok ? event.group : state.lastGroup || null, events: [...(state.events || []), event] }, stateFile)
  log(event.ok ? "rotated" : "failed", (event.group ? "group=" + event.group + (event.ip ? " ip=" + event.ip : "") + " " : "") + event.detail)
  return { rotated: event.ok, group: event.group, ip: event.ip, detail: event.detail, reason }
}

// CLI entry
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  const dryRun = process.argv.includes("--dry-run")
  const force = process.argv.includes("--force")
  const write = (evt, msg) => console.log("[" + evt + "] " + msg)
  if (dryRun) {
    const cfg = loadConfig()
    const d = planRotate(loadState(), Date.now(), cfg, force)
    console.log(JSON.stringify({ mode: cfg.mode, enabled: cfg.enabled, minIntervalSec: cfg.minIntervalSec, maxPerHour: cfg.maxPerHour, decision: d }, null, 2))
  } else {
    const r = await rotateEgress({ reason: "cli", force, log: write })
    if (!r.rotated) process.exitCode = 1
  }
}
