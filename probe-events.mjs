// probe-events.mjs — one trivial text turn; log every session event type in order.
import { OpenCode, discoverService, deleteSession, sleep } from "./engine.mjs"

const { baseUrl, password } = discoverService()
console.log("service:", baseUrl, "password len:", password.length)
const oc = new OpenCode({ baseUrl, password })
const seen = []
oc.subscribe((ev) => {
  const t = ev?.type || "?"
  const sid = ev?.data?.sessionID
  const last = seen[seen.length - 1]
  if (!last || last.t !== t) seen.push({ t, n: 1 })
  else last.n++
  if (sid) console.log("EV", t, JSON.stringify(ev.data).slice(0, 160))
})
oc.startEventStream((e) => console.log("stream-error:", e.message))
await sleep(1500)

const sess = await oc.reqOrThrow("POST", "/api/session", {
  title: "[ccgw-probe] events",
  model: { id: "big-pickle", providerID: "opencode" },
  location: { directory: process.cwd() },
  permissions: [
    { action: "*", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "allow" },
  ],
})
const sid = sess.data.id
console.log("SESSION", sid)
await oc.reqOrThrow("POST", `/api/session/${sid}/prompt`, { text: "Reply with exactly: PONG3" })
await sleep(25000)
const msgs = await oc.req("GET", `/api/session/${sid}/message`)
const idle = msgs.json?.data?.find((m) => m.type === "idle")
console.log("IDLE:", JSON.stringify(idle))
console.log("EVENT ORDER:", seen.map((s) => s.t + (s.n > 1 ? "x" + s.n : "")).join(" -> "))
await deleteSession(oc, sid)
oc.stopEventStream()
process.exit(0)
