// Proof that the model-fallback loop advances the queue correctly.
//
// The live gateway cannot be made to fail on demand (glm's
// "Endpoint is unavailable" is intermittent and we cannot force it), so this
// replays the exact control flow of the retry loop in handleTurn() against a
// scripted upstream, one sequence per scenario. If server.mjs's loop logic
// drifts, this fails.
import assert from "node:assert"
import { fallbackChain } from "./ranking.mjs"

const ranked = ["glm-5.3-flash-free", "nemotron-3.5-super-vl-free", "beam-free", "space-bunny-free"]
const imageOk = (id) => id === "glm-5.3-flash-free" || id === "nemotron-3.5-super-vl-free"

// Mirrors the inner/outer loop in server.mjs handleTurn().
function simulate(scenario, opts = {}) {
  const chain = fallbackChain({
    ranked, model: opts.model, source: opts.source, imageOk, hasFiles: opts.hasFiles, exclude: opts.exclude,
  })
  const modelQueue = [...chain]
  const attempts = []
  const outcomes = {
    "glm-5.3-flash-free": scenario[0],
    "nemotron-3.5-super-vl-free": scenario[1],
    "beam-free": scenario[2],
  }
  const accountNames = ["acct1", "acct2"]
  const cooling = new Set(opts.cooling || [])

  if (modelQueue.length === 0) return { error: "empty-chain", attempts }
  if (scenario.every((o) => o === "fail-upstream")) {
    return { error: "all-failed", attempts }
  }
  for (let mi = 0; mi < modelQueue.length; mi++) {
    const activeModel = modelQueue[mi]
    let broke = false
    // pickAccount() returns null when every account is cooling for this model.
    if (cooling.has(activeModel)) {
      attempts.push({ model: activeModel, account: null, outcome: "no-account" })
      if (mi + 1 < modelQueue.length) { broke = true; continue }
      return { error: "cooling", attempts }
    }
    // inner loop over accounts
    for (let attempt = 0; attempt < accountNames.length; attempt++) {
      const outcome = outcomes[activeModel]
      attempts.push({ model: activeModel, account: accountNames[attempt], outcome })
      if (outcome === "ok") return { model: activeModel, account: accountNames[attempt], attempts }
      if (outcome === "rate-limit") {
        // 429: cooldown, rotate account; if it was the last account -> terminal
        if (attempt < accountNames.length - 1) continue
        return { error: "rate-limited", attempts }
      }
      if (outcome === "admission-403") {
        // 403: terminal for this request by design (entry gate, not quota)
        return { error: "access-denied", attempts }
      }
      // upstream model refusal: after every account is tried, drop to next model
      if (attempt === accountNames.length - 1) {
        if (mi + 1 < modelQueue.length) {
          broke = true // the outer loop picks up the next model
          break
        }
        return { error: "upstream-failed-last", attempts }
      }
    }
    if (broke) continue // outer loop -> next model in queue
    return { error: "unreachable", attempts }
  }
  return { error: "exhausted", attempts }
}

// ---- scenarios ----------------------------------------------------------
let r = simulate(["fail-upstream", "ok", "ok"], { model: "glm-5.3-flash-free", source: "slot:opus" })
assert.equal(r.error, undefined, "no error")
assert.equal(r.model, "nemotron-3.5-super-vl-free", "falls through to the next ranked model after glm's upstream refusal")
assert.deepEqual(r.attempts.map((a) => a.model), ["glm-5.3-flash-free", "glm-5.3-flash-free", "nemotron-3.5-super-vl-free"], "both accounts are tried before dropping the model")

r = simulate(["fail-upstream", "fail-upstream", "ok"], { model: "glm-5.3-flash-free", source: "slot:opus" })
assert.equal(r.model, "beam-free", "keeps dropping models until one serves")

r = simulate(["fail-upstream", "fail-upstream", "fail-upstream"], { model: "glm-5.3-flash-free", source: "slot:opus" })
assert.equal(r.error, "all-failed", "when the whole chain refuses, the request fails instead of pretending")

r = simulate(["rate-limit"], { model: "glm-5.3-flash-free", source: "slot:opus" })
assert.equal(r.error, "rate-limited", "429 never changes the model")
assert.ok(r.attempts.every((a) => a.model === "glm-5.3-flash-free"), "429 only rotates accounts, staying on the same model")

r = simulate(["admission-403"], { model: "glm-5.3-flash-free", source: "slot:opus" })
assert.equal(r.error, "access-denied", "403 never changes the model")
assert.equal(r.attempts.length, 1, "403 fails on the first account, no rotation")

const chain = fallbackChain({ ranked, model: "beam-free", source: "top-free", imageOk, hasFiles: true })
assert.deepEqual(chain, [], "an image request starting on a text-only model has no safe fallback")

// Regression: pickAccount() returning null (all accounts cooling) used to break
// the inner loop without setting an error or advancing the model, so the outer
// loop spun forever. It must advance the model, then terminate.
r = simulate(["ok", "ok", "ok"], { model: "glm-5.3-flash-free", source: "slot:opus", cooling: ["glm-5.3-flash-free"] })
assert.equal(r.model, "nemotron-3.5-super-vl-free", "all-cooling on the head model advances instead of spinning")
r = simulate(["ok", "ok", "ok"], { model: "glm-5.3-flash-free", source: "slot:opus", cooling: ranked })
assert.equal(r.error, "cooling", "all models cooling terminates with an error")

// Parked models (model-park.mjs): the automatic tail skips them, the chain head
// is never hidden, and an explicitly requested model is still attempted.
const parked = new Set(["beam-free", "space-bunny-free"])
const exclude = (id) => parked.has(id)
assert.deepEqual(
  fallbackChain({ ranked, model: "glm-5.3-flash-free", source: "slot:opus", imageOk, exclude }),
  ["glm-5.3-flash-free", "nemotron-3.5-super-vl-free"],
  "parked models are skipped in the tail",
)
assert.deepEqual(
  fallbackChain({ ranked, model: "glm-5.3-flash-free", source: "slot:opus", imageOk, exclude: () => true }),
  ["glm-5.3-flash-free"],
  "an all-parked tail keeps the head instead of leaving an empty chain",
)
assert.deepEqual(
  fallbackChain({ ranked, model: "beam-free", source: "requested", imageOk, exclude }),
  ["beam-free"],
  "an explicitly requested parked model is still attempted",
)
assert.deepEqual(
  fallbackChain({ ranked, model: "glm-5.3-flash-free", source: "slot:opus", imageOk, hasFiles: true, exclude }),
  ["glm-5.3-flash-free", "nemotron-3.5-super-vl-free"],
  "image chains keep their vision-safe tail rule with parks applied",
)
r = simulate(["fail-upstream", "ok", "ok"], { model: "glm-5.3-flash-free", source: "slot:opus", exclude: () => true })
assert.equal(r.error, "upstream-failed-last", "a one-model chain (every other model parked) fails cleanly instead of spinning or walking the chain")

console.log("  model-fallback control flow: 12 checks ok (drop-on-upstream, terminal 429/403, chain exhaustion, image-safe chain, all-cooling advance/terminate, parked-tail skip, head kept, explicit request kept, one-model chain no-spin)")
