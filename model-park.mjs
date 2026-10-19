// model-park.mjs — pool-wide parking for models the upstream itself refuses.
//
// "Model unavailable: opencode/<id>" and "Endpoint is unavailable" are
// model-level refusals: not an account quota (429) and not the admission gate
// (403). The ranked chain is supposed to walk past such a model, and it does —
// but a model that stays listed in the catalog while the provider never serves
// it (live examples: muse-spark-1.3-contributor-free, gpt-5.6-sol, cat-jam-free)
// costs a full failed turn on every chain walk that reaches it.
//
// After CCGW_MODEL_PARK_STRIKES consecutive refusals the model is parked out of
// the *tail* of the automatic fallback chains for a TTL that grows x4 per extra
// strike (30 min -> 2 h -> ... capped at 6 h), and a single success clears the
// record. The chain head is never hidden — an explicitly requested model, a slot
// target or the top-ranked pick is always attempted (glm's intermittent
// "Endpoint is unavailable" is cured by the chain walk, not by demotion; see
// ranking.mjs fallbackChain()).
//
// With `file` set (server.mjs: CCGW_MODEL_PARK_FILE) every change is mirrored
// to disk, so a gateway restart resumes the recorded strikes/TTL instead of
// re-learning a dead model in CCGW_MODEL_PARK_STRIKES turns. Persistence is
// best-effort: an unreadable or corrupt file just starts clean, and each write
// goes through a tmp file + rename so a crash cannot leave a partial record.
// CCGW_MODEL_PARK_MS=0 disables parking (refusals are still counted and kept).

import fs from "node:fs"

const BASE_MS = 30 * 60 * 1000
const MAX_MS = 6 * 60 * 60 * 1000
const STRIKES = 2

export function createModelPark({
  baseMs = BASE_MS,
  maxMs = MAX_MS,
  strikes = STRIKES,
  now = () => Date.now(),
  file = null, // persist the record here (a restart resumes it); null = memory only
  maxEntries = 500, // upper bound on retained models; oldest `last` are pruned first
} = {}) {
  const entries = new Map() // id -> { strikes, until, reason, last }

  if (file) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"))
      for (const [id, e] of Object.entries(raw?.entries || {})) {
        const rec = {
          strikes: Math.max(0, Number(e?.strikes) || 0),
          until: Number(e?.until) || 0,
          reason: e?.reason ? String(e.reason).slice(0, 160) : null,
          last: Number(e?.last) || 0,
        }
        if (rec.strikes > 0 || rec.until > now()) entries.set(String(id), rec)
      }
    } catch {} // missing/corrupt file = start clean
  }

  function save() {
    if (!file) return
    try {
      if (entries.size > maxEntries) {
        const byLast = [...entries.entries()].sort((a, b) => (b[1].last || 0) - (a[1].last || 0))
        for (const [id] of byLast.slice(maxEntries)) entries.delete(id)
      }
      const body = { savedAt: now(), entries: {} }
      for (const [id, e] of entries) body.entries[id] = { strikes: e.strikes, until: e.until, reason: e.reason, last: e.last }
      const tmp = file + ".tmp"
      fs.writeFileSync(tmp, JSON.stringify(body))
      fs.renameSync(tmp, file)
    } catch {} // best-effort; the authoritative record is in memory
  }

  function isParked(id) {
    const e = entries.get(String(id))
    return !!e && e.until > now()
  }

  function noteRefusal(id, reason) {
    const key = String(id)
    const e = entries.get(key) || { strikes: 0, until: 0, reason: null, last: 0 }
    e.strikes += 1
    e.last = now()
    e.reason = String(reason || "").slice(0, 160) || e.reason
    // Strike <strikes> parks for baseMs; every further strike multiplies the TTL
    // by 4, capped at maxMs. baseMs 0 keeps the model eligible (park disabled).
    const ms = Math.min(baseMs * 4 ** Math.max(0, e.strikes - strikes), maxMs)
    if (e.strikes >= strikes && ms > 0) e.until = now() + ms
    entries.set(key, e)
    save()
    const t = now()
    return {
      parked: e.until > t,
      strikes: e.strikes,
      until: e.until > t ? e.until : null,
      seconds: e.until > t ? Math.max(1, Math.ceil((e.until - t) / 1000)) : 0,
    }
  }

  function noteSuccess(id) {
    if (entries.delete(String(id))) save()
  }

  // Active parks only, for /health: a monitor can see which models are being
  // skipped without parsing ccgw.log.
  function snapshot() {
    const t = now()
    const out = {}
    for (const [id, e] of entries) {
      if (e.until > t) out[id] = { strikes: e.strikes, seconds: Math.max(1, Math.ceil((e.until - t) / 1000)), reason: e.reason || null }
    }
    return out
  }

  function strikesFor(id) {
    return entries.get(String(id))?.strikes || 0
  }

  return { isParked, noteRefusal, noteSuccess, strikesFor, snapshot }
}
