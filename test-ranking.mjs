// test-ranking.mjs — quick self-checks for ranking.mjs (run: node test-ranking.mjs)
import assert from "node:assert"
import { AUTO_ALIASES, DEFAULT_ORDER, DEFAULT_SLOTS, isFreeModel, loadRankConfig, matchSlot, pickModel, rankFree } from "./ranking.mjs"

// --- free detection -------------------------------------------------------
assert.equal(isFreeModel("deepseek-v4.1-flash-free", undefined), true, "suffix alone counts")
assert.equal(isFreeModel("big-pickle", { cost: [{ input: 0, output: 0 }] }), true, "cost 0/0 counts (stealth freebies)")
assert.equal(isFreeModel("claude-sonnet-5-5", { cost: [{ input: 2, output: 10 }] }), false, "paid stays paid")
assert.equal(isFreeModel("big-pickle", { cost: [{ input: 0.3, output: 1.2 }] }), false, "nonzero cost not free")
assert.equal(isFreeModel("x-model", undefined), false, "unknown without suffix not free")

// --- config: rank file wins, slots defaulted ------------------------------
const cfg = loadRankConfig()
assert.deepEqual(cfg.order, DEFAULT_ORDER, "model-ranks.json order matches built-in order")
assert.deepEqual(cfg.slots, DEFAULT_SLOTS, "model-ranks.json slots match built-in slots")

// --- ranking: curated first (file order), new free models appended --------
const catalog = [
  ...DEFAULT_ORDER.map((id) => ({ id, free: true })),
  { id: "brand-new-free", free: true }, // not in DEFAULT_ORDER -> appended
  { id: "claude-sonnet-5-5", free: false },
  { id: "claude-haiku-5-5", free: false },
  { id: "gpt-6-astra", free: false },
  { id: "ghost-free", free: true }, // also new
]
const ranked = rankFree(catalog, cfg.order)
assert.deepEqual(ranked, [...DEFAULT_ORDER, "brand-new-free", "ghost-free"], "curated order first, unknown free models appended, paid excluded")

// top-5 should not be text-only: at least image and video providers up high
const inputOf = (id) => ({ "deepseek-v4.1-flash-free": ["text", "image"], "glm-5.3-flash-free": ["text", "image", "video", "pdf"], "nemotron-3.5-super-vl-free": ["text", "image"], "beam-free": ["text"], "longcat-2.5-preview-free": ["text", "image"] }[id] || ["text"])
const top5 = ranked.slice(0, 5).flatMap((id) => inputOf(id))
assert.ok(top5.includes("image"), "an image-capable model ranks in the top 5")
assert.ok(top5.includes("video"), "a video-capable model ranks in the top 5")

// --- slot matching --------------------------------------------------------
const slots = cfg.slots
assert.equal(matchSlot("claude-haiku-4-5-20251001", slots)?.slot, "haiku")
assert.equal(matchSlot("claude-3-5-haiku", slots)?.slot, "haiku")
assert.equal(matchSlot("claude-sonnet-5-5", slots)?.slot, "sonnet")
assert.equal(matchSlot("claude-opus-5-5", slots)?.slot, "opus")
assert.equal(matchSlot("claude-fable-5-1", slots)?.slot, "opus")
assert.equal(matchSlot("vision", slots)?.slot, "vision")
assert.equal(matchSlot("deepseek-v4.1-flash-free", slots), null, "real model names do not hit slots")

// --- selection ------------------------------------------------------------
const ids = new Set(catalog.map((m) => m.id))
const freeSet = new Set(ranked)
const base = { ids, freeSet, ranked, slots, pin: "", fallback: "deepseek-v4.1-flash-free" }

assert.deepEqual(pickModel({ ...base, requested: "glm-5.3-flash-free" }), { model: "glm-5.3-flash-free", source: "requested" })
assert.deepEqual(pickModel({ ...base, requested: "opencode/glm-5.3-flash-free" }), { model: "glm-5.3-flash-free", source: "requested" })
assert.deepEqual(pickModel({ ...base, requested: "claude-haiku-4-5-20251001" }), { model: "nemotron-3.5-lightning-free", source: "slot:haiku" })
assert.deepEqual(pickModel({ ...base, requested: "claude-sonnet-4-5-20250929" }), { model: "glm-5.3-flash-free", source: "slot:sonnet" })
assert.deepEqual(pickModel({ ...base, requested: "claude-opus-5-5" }), { model: "deepseek-v4.1-flash-free", source: "slot:opus" })
assert.deepEqual(pickModel({ ...base, requested: "vision" }), { model: "glm-5.3-flash-free", source: "slot:vision" })
assert.deepEqual(pickModel({ ...base, requested: "gpt-6-astra" }), { model: "deepseek-v4.1-flash-free", source: "not-free" })
assert.deepEqual(pickModel({ ...base, requested: "totally-made-up" }), { model: "deepseek-v4.1-flash-free", source: "top-free" })
assert.deepEqual(pickModel({ ...base, requested: "" }), { model: "deepseek-v4.1-flash-free", source: "top-free" })
assert.deepEqual(pickModel({ ...base, requested: "auto" }), { model: "deepseek-v4.1-flash-free", source: "alias" })
assert.deepEqual(pickModel({ ...base, requested: "AUTO" }), { model: "deepseek-v4.1-flash-free", source: "alias" })
assert.deepEqual(pickModel({ ...base, pin: "big-pickle", requested: "totally-made-up" }), { model: "big-pickle", source: "default" })
assert.deepEqual(pickModel({ ...base, pin: "big-pickle", requested: "auto" }), { model: "big-pickle", source: "alias" })
assert.deepEqual(pickModel({ ...base, pin: "nonexistent", requested: "totally-made-up" }), { model: "deepseek-v4.1-flash-free", source: "top-free" })
// slot pointing at a model that is not free -> skipped, top-ranked used
assert.deepEqual(pickModel({ ...base, slots: { ...slots, haiku: "gone-model-free" }, requested: "claude-haiku-4-5" }), { model: "deepseek-v4.1-flash-free", source: "top-free" })
// no free models known at all
assert.deepEqual(pickModel({ ...base, ranked: [], requested: "claude-sonnet-5-5" }), { model: "glm-5.3-flash-free", source: "slot:sonnet" })
assert.deepEqual(pickModel({ ...base, ranked: [], slots: {}, requested: "claude-sonnet-5-5" }), { model: "claude-sonnet-5-5", source: "passthrough" })
assert.deepEqual(pickModel({ ...base, ranked: [], slots: {}, requested: "nope" }), { model: "deepseek-v4.1-flash-free", source: "static" })

console.log("test-ranking: all checks passed (" + AUTO_ALIASES.size + " aliases, " + ranked.length + " ranked, " + Object.keys(slots).length + " slots)")
