// test-ranking.mjs — quick self-checks for ranking.mjs (run: node test-ranking.mjs)
import assert from "node:assert"
import { AUTO_ALIASES, DEFAULT_ORDER, isFreeModel, loadRankOrder, pickModel, rankFree } from "./ranking.mjs"

// --- free detection -------------------------------------------------------
assert.equal(isFreeModel("deepseek-v4.1-flash-free", undefined), true, "suffix alone counts")
assert.equal(isFreeModel("big-pickle", { cost: [{ input: 0, output: 0 }] }), true, "cost 0/0 counts (stealth freebies)")
assert.equal(isFreeModel("claude-sonnet-5-5", { cost: [{ input: 2, output: 10 }] }), false, "paid stays paid")
assert.equal(isFreeModel("big-pickle", { cost: [{ input: 0.3, output: 1.2 }] }), false, "nonzero cost not free")
assert.equal(isFreeModel("x-model", undefined), false, "unknown without suffix not free")

// --- ranking: curated first (in file order), new free models appended -----
const catalog = [
  { id: "big-pickle", free: true },
  { id: "glm-5.3-flash-free", free: true },
  { id: "brand-new-free", free: true }, // not in DEFAULT_ORDER -> appended
  { id: "claude-sonnet-5-5", free: false },
  { id: "deepseek-v4.1-flash-free", free: true },
  { id: "ghost-free", free: true }, // also new
]
const order = loadRankOrder() // model-ranks.json should win when present
assert.deepEqual(order.slice(0, 3), DEFAULT_ORDER.slice(0, 3), "rank file matches built-in order")
const ranked = rankFree(catalog, order)
assert.deepEqual(
  ranked,
  ["deepseek-v4.1-flash-free", "glm-5.3-flash-free", "big-pickle", "brand-new-free", "ghost-free"],
  "curated order first, unknown free models appended, paid excluded",
)

// --- selection ------------------------------------------------------------
const ids = new Set(catalog.map((m) => m.id))
const freeSet = new Set(ranked)
const rankedAll = ranked
const base = { ids, freeSet, ranked: rankedAll, pin: "", fallback: "deepseek-v4.1-flash-free" }

assert.deepEqual(pickModel({ ...base, requested: "glm-5.3-flash-free" }), { model: "glm-5.3-flash-free", source: "requested" })
assert.deepEqual(pickModel({ ...base, requested: "opencode/glm-5.3-flash-free" }), { model: "glm-5.3-flash-free", source: "requested" })
assert.deepEqual(pickModel({ ...base, requested: "claude-sonnet-5-5" }), { model: "deepseek-v4.1-flash-free", source: "not-free" })
assert.deepEqual(pickModel({ ...base, requested: "totally-made-up" }), { model: "deepseek-v4.1-flash-free", source: "top-free" })
assert.deepEqual(pickModel({ ...base, requested: "" }), { model: "deepseek-v4.1-flash-free", source: "top-free" })
assert.deepEqual(pickModel({ ...base, requested: "auto" }), { model: "deepseek-v4.1-flash-free", source: "alias" })
assert.deepEqual(pickModel({ ...base, requested: "AUTO" }), { model: "deepseek-v4.1-flash-free", source: "alias" })
assert.deepEqual(pickModel({ ...base, requested: "sonnet" }), { model: "deepseek-v4.1-flash-free", source: "top-free" })
assert.deepEqual(pickModel({ ...base, pin: "big-pickle", requested: "sonnet" }), { model: "big-pickle", source: "default" })
assert.deepEqual(pickModel({ ...base, pin: "big-pickle", requested: "auto" }), { model: "big-pickle", source: "alias" })
assert.deepEqual(pickModel({ ...base, pin: "nonexistent", requested: "sonnet" }), { model: "deepseek-v4.1-flash-free", source: "top-free" })
assert.deepEqual(pickModel({ ...base, ranked: [], requested: "claude-sonnet-5-5" }), { model: "claude-sonnet-5-5", source: "passthrough" })
assert.deepEqual(pickModel({ ...base, ranked: [], requested: "nope" }), { model: "deepseek-v4.1-flash-free", source: "static" })

console.log("test-ranking: all checks passed (" + AUTO_ALIASES.size + " aliases, " + order.length + " ranked)")
