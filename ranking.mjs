// ranking.mjs — free-model discovery + ranking + slot mapping for ccgw.
//
// The gateway fronts several OpenCode accounts and sees a union model catalog
// (the free models plus the paid catalog some accounts list). Free models are
// identified from the upstream metadata itself: cost.input === 0 &&
// cost.output === 0 — a "-free" name suffix is honored too (e.g. when cost
// metadata is missing), so stealth freebies like "big-pickle" classify
// correctly without hardcoding.
//
// Free models are ordered best -> worst: a curated order from model-ranks.json
// (hot-reloaded, next to this file) followed by anything new the accounts
// report, so freshly added free models become usable without a code change.
//
// Selection:
//   - a requested free model is used as-is;
//   - Claude-style aliases (haiku / sonnet / opus / fable / vision) resolve to
//     the models configured in model-ranks.json "slots" — e.g. Claude Code's
//     ANTHROPIC_DEFAULT_HAIKU_MODEL traffic (background tasks) lands on the
//     fastest free model even when a client sends a hard-coded claude-* name;
//   - anything else (unknown / paid / placeholder / "auto") is served by the
//     top-ranked free model instead of erroring out on the free tier.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_RANKS_FILE = path.join(__dirname, "model-ranks.json")

export const AUTO_ALIASES = new Set(["auto", "best", "best-free", "ccgw-auto", "free-auto"])

// Built-in safety net; keep in sync with model-ranks.json (the file wins).
export const DEFAULT_ORDER = [
  "glm-5.3-flash-free",
  "nemotron-3.5-super-vl-free",
  "mimo-v2.6-flash-free",
  "deepseek-v4.1-flash-free",
  "beam-free",
  "space-bunny-free",
  "jev-1.13-free",
  "nemotron-3-ultra-free",
  "longcat-2.5-preview-free",
  "big-pickle",
  "nemotron-3.5-lightning-free",
]

// Slot mapping. The first four slots are all filled from the four top-ranked
// models (see fallbackChain() for what happens when one of them is refused
// upstream), so the "top 5 must contain a vision model" constraint now holds by
// construction instead of by fixture.
//
// Ranked by MEASURED capability on 2026-10-18 over the WARP egress:
//   - a real 4x4 red PNG was sent to every free model. Only glm, deepseek,
//     mimo and nemotron-3.5-super-vl accepted it; the rest all answered
//     "所选模型不支持图片".
//   - glm answered "Red" 3/3 (avg ~1.65s) and nemotron-3.5-super-vl 3/3, so
//     glm is first: accurate AND fast.
//   - deepseek accepted the image but answered "Orange"/"White"/"White" for a
//     solid red square across three tries -> its vision is not trustworthy. It
//     still ranks 4th on capability (it IS image-capable) since the ranking is
//     about input capability, but it must never be a vision slot target.
//   - glm is intermittent upstream ("Endpoint is unavailable"); that is handled
//     by the model-level fallback chain, not by demoting it.
//
// haiku note: mimo is 3.2s versus space-bunny's 1.09s, so background work
// (titles, summaries) gets slower. This is intentional - haiku must stay inside
// the capability top 4. If background latency matters more, point haiku at
// space-bunny and accept a text-only slot.
export const DEFAULT_SLOTS = {
  opus: "glm-5.3-flash-free",
  sonnet: "deepseek-v4.1-flash-free",
  haiku: "mimo-v2.6-flash-free",
  vision: "nemotron-3.5-super-vl-free",
}

// Models whose vision was MEASURED correct on 2026-10-18 (solid red 4x4 PNG):
//   glm 3/3, nemotron-3.5-super-vl 3/3, mimo answered correctly.
// deepseek ACCEPTS images but answered "Orange"/"White" for red, so it is
// image-capable yet not vision-trustworthy. A request that carries files and
// would otherwise land on a slot target outside this list is served by the
// vision slot instead — otherwise Claude's sonnet slot (deepseek) would quietly
// return wrong answers for every screenshot the user pastes.
export const DEFAULT_VISION_TRUSTED = [
  "glm-5.3-flash-free",
  "nemotron-3.5-super-vl-free",
  "mimo-v2.6-flash-free",
]

export function isVisionTrusted(id, list = DEFAULT_VISION_TRUSTED) {
  return Array.isArray(list) && list.includes(id)
}

// ---------------------------------------------------------------------------
// Rank file (hot-reloaded when its mtime changes)

let rankCache = { file: null, mtime: -1, order: DEFAULT_ORDER, slots: DEFAULT_SLOTS, visionTrusted: DEFAULT_VISION_TRUSTED }

export function loadRankConfig(file = DEFAULT_RANKS_FILE) {
  try {
    const st = fs.statSync(file)
    if (rankCache.file === file && rankCache.mtime === st.mtimeMs) return rankCache
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"))
    const order = Array.isArray(cfg?.order) && cfg.order.length ? cfg.order.map(String) : DEFAULT_ORDER
    const slots = { ...DEFAULT_SLOTS, ...(cfg?.slots && typeof cfg.slots === "object" ? cfg.slots : {}) }
    const visionTrusted = Array.isArray(cfg?.visionTrusted) && cfg.visionTrusted.length
      ? cfg.visionTrusted.map(String)
      : DEFAULT_VISION_TRUSTED
    rankCache = { file, mtime: st.mtimeMs, order, slots, visionTrusted }
  } catch {
    if (rankCache.file !== file || rankCache.order !== DEFAULT_ORDER || rankCache.slots !== DEFAULT_SLOTS || rankCache.visionTrusted !== DEFAULT_VISION_TRUSTED) {
      rankCache = { file, mtime: -1, order: DEFAULT_ORDER, slots: DEFAULT_SLOTS, visionTrusted: DEFAULT_VISION_TRUSTED }
    }
  }
  return rankCache
}

// ---------------------------------------------------------------------------
// Free detection: upstream per-model metadata -> boolean

export function isFreeModel(id, meta) {
  if (/-free$/i.test(String(id))) return true
  const c = meta?.cost
  const first = Array.isArray(c) ? c[0] : c
  if (first && Number(first.input) === 0 && Number(first.output) === 0) return true
  return false
}

// ---------------------------------------------------------------------------
// Ranking: live free models -> ordered ids (curated first, new ones appended)

export function rankFree(models, order = DEFAULT_ORDER) {
  const freeIds = []
  const freeSet = new Set()
  for (const m of models) {
    if (!m?.free || freeSet.has(m.id)) continue
    freeSet.add(m.id)
    freeIds.push(m.id)
  }
  const ranked = []
  const seen = new Set()
  for (const id of order) {
    if (freeSet.has(id) && !seen.has(id)) {
      ranked.push(id)
      seen.add(id)
    }
  }
  for (const id of freeIds) {
    if (!seen.has(id)) {
      ranked.push(id)
      seen.add(id)
    }
  }
  return ranked
}

// ---------------------------------------------------------------------------
// Model-level fallback chain (used when the upstream refuses a model)
//
// When the upstream reports a model as unavailable ("Endpoint is
// unavailable"), that is a per-model fault and is cured by trying the next
// ranked model — it is NOT the quota cooldown (429) or the admission gate
// (403), which must stay terminal. A model the client named explicitly is
// never substituted, and an image request never falls back onto a model that
// cannot read one.

export function fallbackChain({ ranked, model, source, imageOk, hasFiles, visionTrusted = DEFAULT_VISION_TRUSTED, exclude }) {
  const rankedFromModel = ranked.includes(model)
    ? ranked.slice(ranked.indexOf(model))
    : [model]
  const base = source === "requested" ? [model] : rankedFromModel
  // The head is always attempted: an explicitly requested model, a slot target
  // or the top-ranked pick is the caller's decision (glm's intermittent
  // "Endpoint is unavailable" is cured by this walk, not by demoting it).
  // exclude() only trims the tail — parked models (model-park.mjs) stop costing
  // a failed turn on every walk without ever hiding the first attempt.
  const dedupe = (id, i, arr) => arr.indexOf(id) === i
  const chain = typeof exclude === "function"
    ? base.filter((id, i) => i === 0 || !exclude(id)).filter(dedupe)
    : base.filter(dedupe)
  if (!hasFiles) return chain
  // A model that cannot read an image at all has no safe chain (the caller
  // already rejects it with 400). An image-capable but not vision-trusted head
  // stays as the explicit first attempt, and the tail is limited to models whose
  // vision was measured correct.
  if (!imageOk(chain[0])) return []
  return chain.filter((id, i) => i === 0 || (imageOk(id) && isVisionTrusted(id, visionTrusted)))
}

// Ranked id list -> annotation objects (for /health).
export function describeRanked(models, ranked) {
  const byId = new Map(models.map((m) => [m.id, m]))
  return ranked.map((id, i) => {
    const m = byId.get(id) || {}
    return { rank: i + 1, id, name: m.name || id, input: m.input || null, bridgeInput: m.input?.includes('image') ? ['text','image'] : ['text'], context: m.context || null }
  })
}

// ---------------------------------------------------------------------------
// Slot mapping: Claude-style alias names -> configured slot models

export function matchSlot(bare, slots) {
  if (!slots) return null
  const lower = String(bare || "").toLowerCase()
  if (!lower) return null
  if (slots.vision && (lower === "vision" || lower === "image" || lower === "vl")) return { slot: "vision", model: slots.vision }
  if (slots.haiku && lower.includes("haiku")) return { slot: "haiku", model: slots.haiku }
  if (slots.opus && (lower.includes("opus") || lower.includes("fable"))) return { slot: "opus", model: slots.opus }
  if (slots.sonnet && lower.includes("sonnet")) return { slot: "sonnet", model: slots.sonnet }
  return null
}

// ---------------------------------------------------------------------------
// Selection: client-requested name -> model that will actually run
//
//   requested is a free model          -> that model                    ("requested")
//   requested matches a slot alias     -> slot model (if free)          ("slot:<name>")
//   pin (CCGW_MODEL) set and available -> pin                           ("default"/"alias")
//   anything else                      -> top-ranked free model        ("top-free"/"not-free"/"alias")
//   no free models known at all        -> passthrough known / static fallback

export function pickModel({ requested, ids, freeSet, ranked, slots, pin, fallback, hasFiles = false, visionTrusted = DEFAULT_VISION_TRUSTED }) {
  const raw = String(requested || "").trim()
  const bare = raw.includes("/") ? raw.split("/").slice(1).join("/") : raw
  const lower = bare.toLowerCase()
  const trusted = (id) => isVisionTrusted(id, visionTrusted)
  const visionSlot = slots?.vision && freeSet.has(slots.vision) && trusted(slots.vision) ? slots.vision : null
  const firstTrusted = ranked.find(trusted)
  // A request that carries images must not land on an image-capable model whose
  // vision is known to be wrong. Slot/pin/top-free selections are redirected to
  // the vision slot; an explicitly named model is still honored.
  const safeForImages = (id) => {
    if (!hasFiles || trusted(id)) return null
    if (visionSlot) return { model: visionSlot, source: "slot:vision" }
    if (firstTrusted) return { model: firstTrusted, source: "vision" }
    return null
  }

  if (bare && !AUTO_ALIASES.has(lower) && freeSet.has(bare)) return { model: bare, source: "requested" }
  const isAlias = !!lower && AUTO_ALIASES.has(lower)
  const slot = matchSlot(bare, slots)
  if (slot && freeSet.has(slot.model)) {
    const swap = safeForImages(slot.model)
    if (swap) return swap
    return { model: slot.model, source: "slot:" + slot.slot }
  }
  if (pin && ids.has(pin)) {
    const swap = safeForImages(pin)
    if (swap) return swap
    return { model: pin, source: isAlias ? "alias" : "default" }
  }
  if (ranked.length) {
    const swap = safeForImages(ranked[0])
    if (swap) return { ...swap, source: isAlias ? "alias" : "vision" }
    return { model: ranked[0], source: isAlias ? "alias" : bare && ids.has(bare) ? "not-free" : "top-free" }
  }
  if (bare && ids.has(bare)) return { model: bare, source: "passthrough" }
  return { model: fallback, source: "static" }
}
