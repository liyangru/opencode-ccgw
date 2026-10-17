// smoke1.mjs — end-to-end smoke test for ccgw engine + bridge.
//
//   1. text turn (no tools) via runTurn
//   2. tool turn: bridge exposed, model calls it, engine captures + interrupts
//
// Run: node ccgw/smoke1.mjs
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  OpenCode,
  discoverService,
  runTurn,
  putBridge,
  deleteBridge,
  deleteSession,
  writeManifest,
  removeManifest,
  buildNameMap,
  sleep,
} from "./engine.mjs"

const MODEL = { id: "big-pickle", providerID: "opencode" }
const result = { text: null, tool: null, errors: [] }

const { baseUrl, password } = discoverService()
console.log("== service:", baseUrl, "password:", password ? "yes" : "no")
const oc = new OpenCode({ baseUrl, password })
const allEvents = []
oc.subscribe((ev) => allEvents.push({ at: Date.now(), type: ev?.type || "?", sid: ev?.data?.sessionID || "" }))
oc.startEventStream((e) => console.log("stream-error:", e.message))
await sleep(1500)

// Scratch dir doubles as session location + MCP location.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ccgw-smoke-scratch-"))
const bridgeName = "gwsmoke"
const BRIDGE_TOOLS = [
  {
    name: "echo",
    description: "Echo a message back to the caller.",
    inputSchema: {
      type: "object",
      properties: { msg: { type: "string", description: "message to echo" } },
      required: ["msg"],
    },
  },
]

let manifest = null
let sessionID = null
try {
  // ---------------------------------------------------------------- test 1
  console.log("\n== TEST 1: text turn (no tools)")
  {
    const t0 = Date.now()
    const r = await runTurn(oc, {
      dir: scratch,
      model: MODEL,
      promptText: "Reply with exactly: SMOKE-PONG",
      timeoutMs: 90000,
      log: (_, m) => console.log("   [log]", m),
      onTextDelta: (d) => process.stdout.write(d),
    })
    sessionID = r.sessionID
    console.log("\n   finish:", r.finish, "| text:", JSON.stringify(r.text), "| usage:", JSON.stringify(r.usage), "|", Date.now() - t0, "ms")
    if (!r.text.includes("SMOKE-PONG")) throw new Error("text turn: expected SMOKE-PONG in reply")
    if (r.toolCalls.length) throw new Error("text turn: unexpected tool calls")
    result.text = r.text
    await deleteSession(oc, sessionID)
    sessionID = null
    console.log("   PASS")
  }

  // ---------------------------------------------------------------- test 2
  console.log("\n== TEST 2: tool turn (bridge + capture + interrupt)")
  {
    const { origToSan, sanToOrig } = buildNameMap(BRIDGE_TOOLS)
    const sandbox = BRIDGE_TOOLS.map((t) => ({
      name: origToSan.get(t.name),
      description: t.description,
      inputSchema: t.inputSchema,
    }))
    manifest = writeManifest(sandbox)
    const t0 = Date.now()
    await putBridge(oc, scratch, bridgeName, manifest.file)
    console.log("   bridge registered + connected")
    const r = await runTurn(oc, {
      dir: scratch,
      model: MODEL,
      promptText: "Use the gwsmoke_echo tool with msg='holdtest' to echo the message. Then report the result.",
      bridgeName,
      sanToOrig,
      timeoutMs: 90000,
      log: (_, m) => console.log("   [log]", m),
      onTextDelta: (d) => process.stdout.write(d),
    })
    sessionID = r.sessionID
    console.log("\n   finish:", r.finish, "| toolCalls:", JSON.stringify(r.toolCalls), "| usage:", JSON.stringify(r.usage), "|", Date.now() - t0, "ms")
    if (r.toolCalls.length !== 1) throw new Error("tool turn: expected exactly 1 captured call, got " + r.toolCalls.length)
    const call = r.toolCalls[0]
    if (call.name !== "echo") throw new Error("tool turn: expected tool name 'echo', got " + call.name)
    if (!call.input || call.input.msg !== "holdtest") throw new Error("tool turn: expected input.msg=holdtest, got " + JSON.stringify(call.input))
    if (r.finish !== "tool-calls") throw new Error("tool turn: expected finish 'tool-calls', got " + r.finish)
    result.tool = { name: call.name, input: call.input }
    await deleteSession(oc, sessionID)
    sessionID = null
    console.log("   PASS")
  }
} catch (e) {
  result.errors.push(e.message)
  console.error("\n!! FAIL:", e.message)
  const t0 = allEvents.length ? allEvents[Math.max(0, allEvents.length - 120)].at : 0
  console.error("== last events:")
  for (const ev of allEvents.slice(-120)) console.error("   +" + (ev.at - t0) + "ms", ev.type, ev.sid.slice(0, 30))
} finally {
  if (sessionID) {
    try {
      await deleteSession(oc, sessionID)
    } catch {}
  }
  try {
    await deleteBridge(oc, scratch, bridgeName)
  } catch {}
  if (manifest) removeManifest(manifest.dir)
  try {
    fs.rmSync(scratch, { recursive: true, force: true })
  } catch {}
  oc.stopEventStream()
}

console.log("\n== SUMMARY:", JSON.stringify(result, null, 1))
process.exit(result.errors.length ? 1 : 0)
