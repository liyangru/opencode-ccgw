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
  "deepseek-v4.1-flash-free",
  "glm-5.3-flash-free",
  "nemotron-3.5-super-vl-free",
  "beam-free",
  "longcat-2.5-preview-free",
  "space-bunny-free",
  "mimo-v2.6-flash-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
  "big-pickle",
]

// Slot mapping: haiku = small/fast + background, sonnet = workhorse,
// opus = max power, vision = image/video/PDF tasks.
export const DEFAULT_SLOTS = {
  opus: "deepseek-v4.1-flash-free",
  sonnet: "glm-5.3-flash-free",
  haiku: "nemotron-3.5-lightning-free",
  vision: "glm-5.3-flash-free",
}

// ---------------------------------------------------------------------------
// Rank file (hot-reloaded when its mtime changes)

let rankCache = { file: null, mtime: -1, order: DEFAULT_ORDER, slots: DEFAULT_SLOTS }

export function loadRankConfig(file = DEFAULT_RANKS_FILE) {
  try {
    const st = fs.statSync(file)
    if (rankCache.file === file && rankCache.mtime === st.mtimeMs) return rankCache
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"))
    const order = Array.isArray(cfg?.order) && cfg.order.length ? cfg.order.map(String) : DEFAULT_ORDER
    const slots = { ...DEFAULT_SLOTS, ...(cfg?.slots && typeof cfg.slots === "object" ? cfg.slots : {}) }
    rankCache = { file, mtime: st.mtimeMs, order, slots }
  } catch {
    if (rankCache.file !== file || rankCache.order !== DEFAULT_ORDER || rankCache.slots !== DEFAULT_SLOTS) {
      rankCache = { file, mtime: -1, order: DEFAULT_ORDER, slots: DEFAULT_SLOTS }
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

// Ranked id list -> annotation objects (for /health).
export function describeRanked(models, ranked) {
  const byId = new Map(models.map((m) => [m.id, m]))
  return ranked.map((id, i) => {
    const m = byId.get(id) || {}
    return { rank: i + 1, id, name: m.name || id, input: m.input || null, context: m.context || null }
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

export function pickModel({ requested, ids, freeSet, ranked, slots, pin, fallback }) {
  const raw = String(requested || "").trim()
  const bare = raw.includes("/") ? raw.split("/").slice(1).join("/") : raw
  const lower = bare.toLowerCase()
  if (bare && !AUTO_ALIASES.has(lower) && freeSet.has(bare)) return { model: bare, source: "requested" }
  const isAlias = !!lower && AUTO_ALIASES.has(lower)
  const slot = matchSlot(bare, slots)
  if (slot && freeSet.has(slot.model)) return { model: slot.model, source: "slot:" + slot.slot }
  if (pin && ids.has(pin)) return { model: pin, source: isAlias ? "alias" : "default" }
  if (ranked.length) {
    return { model: ranked[0], source: isAlias ? "alias" : bare && ids.has(bare) ? "not-free" : "top-free" }
  }
  if (bare && ids.has(bare)) return { model: bare, source: "passthrough" }
  return { model: fallback, source: "static" }
}
