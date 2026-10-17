// probe-tools.mjs — register bridge in a fresh scratch location, ask the model
// which tools it can directly call. Diagnoses tool visibility issues.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { OpenCode, discoverService, putBridge, deleteBridge, deleteSession, writeManifest, removeManifest, buildNameMap, sleep } from "./engine.mjs"

const { baseUrl, password } = discoverService()
const oc = new OpenCode({ baseUrl, password })
const evs = []
oc.subscribe((ev) => {
  evs.push(ev)
  const t = ev?.type || "?"
  if (t.includes("tool") || t.includes("step") || t.includes("execution")) {
    console.log("EV", t, JSON.stringify(ev.data).slice(0, 220))
  }
})
oc.startEventStream((e) => console.log("stream-error:", e.message))
await sleep(1200)

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ccgw-tools-scratch-"))
const bridgeName = "gwtools"
const tools = [{ name: "echo", description: "Echo a message back to the caller.", inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] } }]
const { origToSan } = buildNameMap(tools)
const manifest = writeManifest(tools.map((t) => ({ name: origToSan.get(t.name), description: t.description, inputSchema: t.inputSchema })))

let sid = null
try {
  await putBridge(oc, scratch, bridgeName, manifest.file)
  console.log("bridge connected")

  const perms = [
    { action: "*", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "allow" },
    { action: bridgeName + "_*", resource: "*", effect: "allow" },
  ]
  console.log("permissions:", JSON.stringify(perms))
  const sess = await oc.reqOrThrow("POST", "/api/session", {
    title: "[ccgw-probe] tools",
    model: { id: "big-pickle", providerID: "opencode" },
    location: { directory: scratch },
    permissions: perms,
  })
  sid = sess.data.id
  console.log("session:", sid)
  const plist = await oc.req("GET", `/api/session/${sid}/permission`)
  console.log("session permissions:", JSON.stringify(plist.json).slice(0, 500))

  await oc.reqOrThrow("POST", `/api/session/${sid}/prompt`, {
    text: 'Output ONLY JSON: {"top": [names of every tool you can directly call right now]}. No other text, no markdown fences.',
  })
  const deadline = Date.now() + 60000
  let idle = null
  while (Date.now() < deadline) {
    await sleep(1000)
    const msgs = await oc.req("GET", `/api/session/${sid}/message`)
    idle = msgs.json?.data?.find((m) => m.type === "idle")
    if (idle) break
  }
  console.log("idle:", JSON.stringify(idle))
  const msgs = await oc.req("GET", `/api/session/${sid}/message`)
  for (const m of msgs.json?.data || []) {
    if (m.type === "assistant") {
      console.log("ASSISTANT finish=" + m.finish)
      for (const c of m.content || []) console.log("  ", JSON.stringify(c).slice(0, 800))
    }
  }
} catch (e) {
  console.error("FAIL:", e.message)
} finally {
  if (sid) try { await deleteSession(oc, sid) } catch {}
  try { await deleteBridge(oc, scratch, bridgeName) } catch {}
  removeManifest(manifest.dir)
  try { fs.rmSync(scratch, { recursive: true, force: true }) } catch {}
  oc.stopEventStream()
}
process.exit(0)
