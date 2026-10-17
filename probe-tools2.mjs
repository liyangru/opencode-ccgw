// probe-tools2.mjs — does an MCP bridge registered AFTER the location booted
// become visible to later sessions in that location?
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { OpenCode, discoverService, putBridge, deleteBridge, deleteSession, writeManifest, removeManifest, buildNameMap, listMcp, sleep } from "./engine.mjs"

const { baseUrl, password } = discoverService()
const oc = new OpenCode({ baseUrl, password })
oc.subscribe((ev) => {
  const t = ev?.type || "?"
  if (t.includes("tool") || t.includes("command") || t.includes("mcp")) console.log("EV", t, JSON.stringify(ev.data || ev).slice(0, 180))
})
oc.startEventStream()
await sleep(1200)

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ccgw-t2-"))
const bridgeName = "gwprobe2"
const permsBase = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
]
const permsBridge = [...permsBase, { action: bridgeName + "_*", resource: "*", effect: "allow" }]

const manifest = writeManifest([{ name: "echo", description: "Echo a message back.", inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] } }])

async function newSession(title, perms) {
  const sess = await oc.reqOrThrow("POST", "/api/session", { title, model: { id: "big-pickle", providerID: "opencode" }, location: { directory: scratch }, permissions: perms })
  return sess.data.id
}
async function promptAndWait(sid, text, ms = 60000) {
  await oc.reqOrThrow("POST", `/api/session/${sid}/prompt`, { text })
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    await sleep(1000)
    const msgs = await oc.req("GET", `/api/session/${sid}/message`)
    const idle = msgs.json?.data?.find((m) => m.type === "idle")
    if (idle) {
      const assistant = msgs.json.data.filter((m) => m.type === "assistant").pop()
      const txt = (assistant?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("")
      return { idle, txt, assistant }
    }
  }
  return { idle: null, txt: "", assistant: null }
}

const ids = []
try {
  // S0: boot + warm the location BEFORE the bridge exists.
  const s0 = await newSession("[gw-t2] S0 warmup", permsBase)
  ids.push(s0)
  const r0 = await promptAndWait(s0, 'Output ONLY JSON: {"top": [names of every tool you can directly call]}. No other text.')
  console.log("S0 tools:", JSON.stringify(r0.txt))

  // Register bridge AFTER location is warm.
  await putBridge(oc, scratch, bridgeName, manifest.file)
  console.log("bridge connected (post-boot); mcp status:", JSON.stringify((await listMcp(oc, scratch)).map((s) => ({ name: s.name, st: s.status?.status }))))
  await sleep(3000)

  // S1: introspection after bridge.
  const s1 = await newSession("[gw-t2] S1 introspect", permsBridge)
  ids.push(s1)
  const r1 = await promptAndWait(s1, 'Output ONLY JSON: {"top": [names of every tool you can directly call]}. No other text.')
  console.log("S1 tools:", JSON.stringify(r1.txt))
  console.log("S1 usage:", JSON.stringify(r1.assistant?.tokens || r1.assistant?.usage || null))

  // S2: actual call attempt.
  const s2 = await newSession("[gw-t2] S2 call", permsBridge)
  ids.push(s2)
  const r2 = await promptAndWait(s2, "Use the " + bridgeName + "_echo tool with msg='holdtest'. Report the result.", 90000)
  console.log("S2 reply:", JSON.stringify(r2.txt).slice(0, 400))
  console.log("S2 finish:", r2.assistant?.finish, "| mcp status now:", JSON.stringify((await listMcp(oc, scratch)).map((s) => ({ name: s.name, st: s.status?.status }))))
} catch (e) {
  console.error("FAIL:", e.message)
} finally {
  for (const id of ids) try { await deleteSession(oc, id) } catch {}
  try { await deleteBridge(oc, scratch, bridgeName) } catch {}
  removeManifest(manifest.dir)
  try { fs.rmSync(scratch, { recursive: true, force: true }) } catch {}
  oc.stopEventStream()
}
process.exit(0)
