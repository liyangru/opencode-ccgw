// test-ranking.mjs 鈥?quick self-checks for ranking.mjs (run: node test-ranking.mjs)
import assert from "node:assert"
import { AUTO_ALIASES, DEFAULT_ORDER, DEFAULT_SLOTS, DEFAULT_VISION_TRUSTED, fallbackChain, isFreeModel, loadRankConfig, matchSlot, pickModel, rankFree } from "./ranking.mjs"

// --- free detection -------------------------------------------------------
assert.equal(isFreeModel("beam-free", undefined), true, "suffix alone counts")
assert.equal(isFreeModel("big-pickle", { cost: [{ input: 0, output: 0 }] }), true, "cost 0/0 counts (stealth freebies)")
assert.equal(isFreeModel("claude-sonnet-5-5", { cost: [{ input: 2, output: 10 }] }), false, "paid stays paid")
assert.equal(isFreeModel("big-pickle", { cost: [{ input: 0.3, output: 1.2 }] }), false, "nonzero cost not free")
assert.equal(isFreeModel("x-model", undefined), false, "unknown without suffix not free")

// --- config: rank file wins, slots defaulted ------------------------------
const cfg = loadRankConfig()
assert.deepEqual(cfg.order, DEFAULT_ORDER, "model-ranks.json order matches built-in order")
assert.deepEqual(cfg.slots, DEFAULT_SLOTS, "model-ranks.json slots match built-in slots")
assert.deepEqual(cfg.visionTrusted, DEFAULT_VISION_TRUSTED, "model-ranks.json visionTrusted matches built-in list")

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

// top-5 should not be text-only. The capabilities below are MEASURED, not the
// catalog's claims: the free catalog publishes no input metadata, so on
// 2026-10-18 a real 4x4 PNG was sent to every ranked model. Only glm, deepseek,
// mimo and nemotron-3.5-super-vl accepted it; the rest answered
// "所选模型不支持图片" (verified across 3 tries each for glm / deepseek /
// nemotron-3.5-super-vl).
//
// There is deliberately NO "video" assertion here. The gateway has never
// forwarded video: any video/audio/document attachment is rejected locally with
// HTTP 400 ("ccgw 尚未实现此附件类型的转发"), so the upstream never sees it and
// no model can be video-capable through this gateway. Asserting one would be
// asserting against a fixture that lies.
const inputOf = (id) => ({ "glm-5.3-flash-free": ["text", "image"], "nemotron-3.5-super-vl-free": ["text", "image"], "mimo-v2.6-flash-free": ["text", "image"], "deepseek-v4.1-flash-free": ["text", "image"], "beam-free": ["text"], "longcat-2.5-preview-free": ["text"], "space-bunny-free": ["text"], "brand-new-free": ["text"], "ghost-free": ["text"] }[id] || ["text"])
const top5 = ranked.slice(0, 5).flatMap((id) => inputOf(id))
assert.ok(top5.includes("image"), "an image-capable model ranks in the top 5")
assert.ok(top5.includes("text") === false || top5.length > 0, "sanity: fixture produces inputs")

// --- model-level fallback chain -------------------------------------------
const ranked04 = ["glm-5.3-flash-free", "nemotron-3.5-super-vl-free", "beam-free", "space-bunny-free"]
const image = (id) => id === "glm-5.3-flash-free" || id === "nemotron-3.5-super-vl-free"

assert.deepEqual(
  fallbackChain({ ranked: ranked04, model: "glm-5.3-flash-free", source: "slot:opus", imageOk: image, hasFiles: false }),
  ["glm-5.3-flash-free", "nemotron-3.5-super-vl-free", "beam-free", "space-bunny-free"],
  "text turn: chain starts at the model used and covers the rest of the ranking")
assert.deepEqual(
  fallbackChain({ ranked: ranked04, model: "glm-5.3-flash-free", source: "requested", imageOk: image, hasFiles: false }),
  ["glm-5.3-flash-free"],
  "the client named this model explicitly: never substitute it")
assert.deepEqual(
  fallbackChain({ ranked: ranked04, model: "glm-5.3-flash-free", source: "slot:opus", imageOk: image, hasFiles: true }),
  ["glm-5.3-flash-free", "nemotron-3.5-super-vl-free"],
  "image turn: the chain only contains models that accept images")
assert.deepEqual(
  fallbackChain({ ranked: ranked04, model: "beam-free", source: "top-free", imageOk: image, hasFiles: true }),
  [],
  "image turn that starts on a text-only model has no safe fallback")
assert.deepEqual(
  fallbackChain({ ranked: ["glm-5.3-flash-free", "nemotron-3.5-super-vl-free", "deepseek-v4.1-flash-free", "beam-free"], model: "glm-5.3-flash-free", source: "slot:opus", imageOk: (id) => id !== "beam-free", hasFiles: true }),
  ["glm-5.3-flash-free", "nemotron-3.5-super-vl-free"],
  "image turn: the tail drops image-capable models whose vision was measured wrong (deepseek)")

// --- slot matching --------------------------------------------------------
const slots = cfg.slots
assert.equal(matchSlot("claude-haiku-4-5-20251001", slots)?.slot, "haiku")
assert.equal(matchSlot("claude-3-5-haiku", slots)?.slot, "haiku")
assert.equal(matchSlot("claude-sonnet-5-5", slots)?.slot, "sonnet")
assert.equal(matchSlot("claude-opus-5-5", slots)?.slot, "opus")
assert.equal(matchSlot("claude-fable-5-1", slots)?.slot, "opus")
assert.equal(matchSlot("vision", slots)?.slot, "vision")
assert.equal(matchSlot("beam-free", slots), null, "real model names do not hit slots")

// --- selection ------------------------------------------------------------
const ids = new Set(catalog.map((m) => m.id))
const freeSet = new Set(ranked)
const base = { ids, freeSet, ranked, slots, pin: "", fallback: "glm-5.3-flash-free" }

assert.deepEqual(pickModel({ ...base, requested: "glm-5.3-flash-free" }), { model: "glm-5.3-flash-free", source: "requested" })
assert.deepEqual(pickModel({ ...base, requested: "opencode/glm-5.3-flash-free" }), { model: "glm-5.3-flash-free", source: "requested" })
assert.deepEqual(pickModel({ ...base, requested: "claude-haiku-4-5-20251001" }), { model: "mimo-v2.6-flash-free", source: "slot:haiku" })
assert.deepEqual(pickModel({ ...base, requested: "claude-sonnet-4-5-20250929" }), { model: "deepseek-v4.1-flash-free", source: "slot:sonnet" })
assert.deepEqual(pickModel({ ...base, requested: "claude-opus-5-5" }), { model: "glm-5.3-flash-free", source: "slot:opus" })
assert.deepEqual(pickModel({ ...base, requested: "vision" }), { model: "nemotron-3.5-super-vl-free", source: "slot:vision" })
// image turns: an image-capable slot whose vision is untrusted is redirected
assert.deepEqual(pickModel({ ...base, requested: "claude-sonnet-5-5", hasFiles: true }), { model: "nemotron-3.5-super-vl-free", source: "slot:vision" })
assert.deepEqual(pickModel({ ...base, requested: "claude-opus-5-5", hasFiles: true }), { model: "glm-5.3-flash-free", source: "slot:opus" })
assert.deepEqual(pickModel({ ...base, requested: "claude-haiku-5-5", hasFiles: true }), { model: "mimo-v2.6-flash-free", source: "slot:haiku" })
assert.deepEqual(pickModel({ ...base, requested: "deepseek-v4.1-flash-free", hasFiles: true }), { model: "deepseek-v4.1-flash-free", source: "requested" })
assert.deepEqual(pickModel({ ...base, requested: "totally-made-up", hasFiles: true }), { model: "glm-5.3-flash-free", source: "top-free" })
assert.deepEqual(pickModel({ ...base, ranked: ["deepseek-v4.1-flash-free", "glm-5.3-flash-free"], requested: "", hasFiles: true }), { model: "nemotron-3.5-super-vl-free", source: "vision" })
assert.deepEqual(pickModel({ ...base, requested: "gpt-6-astra" }), { model: "glm-5.3-flash-free", source: "not-free" })
assert.deepEqual(pickModel({ ...base, requested: "totally-made-up" }), { model: "glm-5.3-flash-free", source: "top-free" })
assert.deepEqual(pickModel({ ...base, requested: "" }), { model: "glm-5.3-flash-free", source: "top-free" })
assert.deepEqual(pickModel({ ...base, requested: "auto" }), { model: "glm-5.3-flash-free", source: "alias" })
assert.deepEqual(pickModel({ ...base, requested: "AUTO" }), { model: "glm-5.3-flash-free", source: "alias" })
assert.deepEqual(pickModel({ ...base, pin: "big-pickle", requested: "totally-made-up" }), { model: "big-pickle", source: "default" })
assert.deepEqual(pickModel({ ...base, pin: "big-pickle", requested: "auto" }), { model: "big-pickle", source: "alias" })
assert.deepEqual(pickModel({ ...base, pin: "nonexistent", requested: "totally-made-up" }), { model: "glm-5.3-flash-free", source: "top-free" })
// slot pointing at a model that is not free -> skipped, top-ranked used
assert.deepEqual(pickModel({ ...base, slots: { ...slots, haiku: "gone-model-free" }, requested: "claude-haiku-4-5" }), { model: "glm-5.3-flash-free", source: "top-free" })
// no free models known at all
assert.deepEqual(pickModel({ ...base, ranked: [], requested: "claude-sonnet-5-5" }), { model: "deepseek-v4.1-flash-free", source: "slot:sonnet" })
assert.deepEqual(pickModel({ ...base, ranked: [], slots: {}, requested: "claude-sonnet-5-5" }), { model: "claude-sonnet-5-5", source: "passthrough" })
assert.deepEqual(pickModel({ ...base, ranked: [], slots: {}, requested: "nope" }), { model: "glm-5.3-flash-free", source: "static" })

console.log("test-ranking: all checks passed (" + AUTO_ALIASES.size + " aliases, " + ranked.length + " ranked, " + Object.keys(slots).length + " slots)")

