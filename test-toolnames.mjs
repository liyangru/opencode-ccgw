// Tool-name/count hygiene: the upstream free tier caps wire tool names at 64
// characters and the tools array at 128 items. Desktop Claude Code sends 137
// tools with long MCP names; both limits used to fail the whole turn
// ("Invalid value for 'tools[75].function.name'", "maximum number of items is
// 128"). These tests pin the fix: prefix-budgeted name mapping, a dispatcher
// tool for the overflow, and exact reverse mapping on the way back.
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  buildNameMap,
  planBridgeTools,
  unpackDispatcherCalls,
  UPSTREAM_MAX_TOOL_NAME,
  UPSTREAM_MAX_TOOLS,
} from "./engine.mjs"
import { renderPrompt } from "./formats.mjs"

// Same shape as the gateway's per-request bridge name (gw + 12 hex).
const PREFIX = "gw0123456789ab"
const wireName = (san) => PREFIX + "_" + san

function desktopLikeTools(n = 137) {
  const tools = []
  for (let i = 0; i < n; i++) {
    let name
    // Long MCP names truncate to the same prefix; short built-ins stay intact;
    // some carry characters that must be sanitized.
    if (i % 3 === 0) name = "mcp__claude_ai_Skills__Skill__tool-" + i + "-" + "x".repeat(50)
    else if (i % 3 === 1) name = "Tool_" + i
    else name = "mcp__tools__server.tool/" + i + " " + "y".repeat(40)
    tools.push({ name, description: "tool " + i, inputSchema: { type: "object", properties: {} } })
  }
  return tools
}

test("wire tool names stay within the upstream 64-character limit", () => {
  const tools = desktopLikeTools()
  const map = buildNameMap(tools, { prefix: PREFIX })
  assert.equal(map.sanToOrig.size, tools.length)
  for (const san of map.sanToOrig.keys()) {
    assert.ok(
      wireName(san).length <= UPSTREAM_MAX_TOOL_NAME,
      "wire name over the limit: " + wireName(san) + " (" + wireName(san).length + ")",
    )
  }
})

test("truncation collisions stay unique and round-trip", () => {
  const tools = desktopLikeTools(60)
  const map = buildNameMap(tools, { prefix: PREFIX })
  const seen = new Set()
  for (const t of tools) {
    const san = map.origToSan.get(t.name)
    assert.ok(san, "missing mapping for " + t.name)
    assert.equal(map.sanToOrig.get(san), t.name, "reverse mapping broken for " + t.name)
    assert.ok(!seen.has(san), "duplicate sanitized name " + san)
    seen.add(san)
  }
  // The whole point: many long names collapse to one 45-char base and must be
  // disambiguated, not silently merged.
  const collided = [...seen].filter((s) => /_\d+$/.test(s))
  assert.ok(collided.length > 10, "expected truncation collisions to be deduped, got " + collided.length)
})

test("sanitized names stay MCP-safe", () => {
  const map = buildNameMap([{ name: "mcp__tools__server.tool/7 with spaces" }, { name: "9leading-digit" }, { name: "!!!" }], { prefix: PREFIX })
  for (const san of map.sanToOrig.keys()) assert.match(san, /^[A-Za-z0-9_-]+$/)
})

test("small tool lists are bridged directly, without a dispatcher", () => {
  const plan = planBridgeTools(desktopLikeTools(20), {})
  assert.equal(plan.dispatcher, null)
  assert.equal(plan.direct.length, 20)
  assert.equal(plan.overflow.length, 0)
})

test("137 client tools fit the upstream limit via the dispatcher", () => {
  const tools = desktopLikeTools(137)
  const plan = planBridgeTools(tools)
  assert.ok(plan.dispatcher, "expected a dispatcher for an oversized list")
  assert.equal(plan.direct.length + plan.overflow.length, tools.length)
  // Bridge list + the upstream's own built-in tools must stay inside 128.
  assert.ok(plan.direct.length + 1 <= UPSTREAM_MAX_TOOLS - 16, "bridge list too large: " + (plan.direct.length + 1))
  const bridgeList = [...plan.direct, plan.dispatcher]
  const map = buildNameMap(bridgeList, { prefix: PREFIX })
  assert.equal(map.sanToOrig.size, bridgeList.length)
  for (const san of map.sanToOrig.keys()) assert.ok(wireName(san).length <= UPSTREAM_MAX_TOOL_NAME)
})

test("the dispatcher name never collides with a client tool", () => {
  const tools = [{ name: "gwcall" }, ...desktopLikeTools(140)]
  const plan = planBridgeTools(tools)
  assert.notEqual(plan.dispatcher.name, "gwcall")
  const names = new Set(tools.map((t) => t.name))
  assert.ok(!names.has(plan.dispatcher.name))
})

test("overflow tools are unpacked back into the original client call", () => {
  const tools = desktopLikeTools(137)
  const plan = planBridgeTools(tools)
  const dispatcher = plan.dispatcher.name
  const target = plan.overflow[0].name
  const calls = unpackDispatcherCalls(
    [
      { id: "tu_1", name: dispatcher, input: { name: target, input: { path: "a.txt" } }, raw: "{}" },
      { id: "tu_2", name: "Tool_1", input: { q: 1 }, raw: '{"q":1}' },
      { id: "tu_3", name: dispatcher, input: {} }, // no target: dropped
    ],
    dispatcher,
  )
  assert.equal(calls.length, 2)
  assert.equal(calls[0].name, target)
  assert.deepEqual(calls[0].input, { path: "a.txt" })
  assert.equal(calls[0].raw, JSON.stringify({ path: "a.txt" }))
  assert.equal(calls[1].name, "Tool_1")
})

test("renderPrompt routes overflow through the dispatcher and keeps direct names exact", () => {
  const tools = desktopLikeTools(137)
  const plan = planBridgeTools(tools)
  const bridgeList = [...plan.direct, plan.dispatcher]
  const map = buildNameMap(bridgeList, { prefix: PREFIX })
  const routing = { overflow: new Set(plan.overflow.map((t) => t.name)), dispatcher: map.origToSan.get(plan.dispatcher.name) }
  const canon = {
    system: "",
    messages: [
      { role: "user", text: "hi" },
      { role: "assistant", text: "", toolUses: [{ id: "tu_1", name: plan.overflow[0].name, input: { path: "b" }, raw: '{"path":"b"}' }] },
      { role: "tool", results: [{ toolUseId: "tu_1", name: plan.overflow[0].name, text: "ok" }] },
    ],
    tools,
    forcedTool: null,
    files: [],
  }
  const prompt = renderPrompt(canon, PREFIX, map.origToSan, routing)
  // The direct tool line uses the exact wire name.
  assert.ok(prompt.includes(plan.direct[0].name + " -> " + PREFIX + "_" + map.origToSan.get(plan.direct[0].name)))
  // The overflow tool is not offered as a direct wire name...
  assert.ok(!prompt.includes(plan.overflow[0].name + " -> " + PREFIX + "_"))
  // ...it is listed under the dispatcher, and the transcript shows the
  // dispatcher call form.
  assert.ok(prompt.includes(plan.overflow[0].name))
  assert.ok(prompt.includes(PREFIX + "_" + routing.dispatcher))
  assert.ok(prompt.includes('{"name":"' + plan.overflow[0].name + '","input":{"path":"b"}}'))
})
