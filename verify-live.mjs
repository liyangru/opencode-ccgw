// verify-live.mjs — quick check against an ALREADY RUNNING ccgw instance.
// Verifies: health, text turn, tool round-trip (client-side execution).
// Run: node ccgw/verify-live.mjs
const BASE = process.env.CCGW_BASE || "http://127.0.0.1:8317"
const TOKEN = "LIVE-TOKEN-9"
const out = []
const check = (n, ok, d = "") => {
  out.push({ n, ok })
  console.log((ok ? "PASS " : "FAIL ") + n + (d ? "  [" + d + "]" : ""))
}

async function post(p, body) {
  const r = await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  return { status: r.status, json: await r.json().catch(() => null) }
}

const h = await fetch(BASE + "/health").then((r) => r.json()).catch(() => null)
console.log("health:", JSON.stringify(h))
check("health", !!h?.ok && h?.eventStream)
check("default model = deepseek-v4.1-flash-free", h?.defaultModel === "deepseek-v4.1-flash-free", "defaultModel=" + h?.defaultModel)

const t = await post("/v1/messages", { model: "claude-sonnet-5", max_tokens: 512, messages: [{ role: "user", content: "Reply with exactly: GW-OK" }] })
const txt = t.json?.content?.map((c) => c.text).join("") || ""
check("text turn", t.status === 200 && txt.includes("GW-OK"), JSON.stringify(txt.slice(0, 80)))

const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
const r1 = await post("/v1/messages", {
  model: "claude-sonnet-5",
  max_tokens: 512,
  tools: [{ name: "read_file", description: "Read a file from disk", input_schema: schema }],
  messages: [{ role: "user", content: "Use the read_file tool to read notes.txt. Then report its contents." }],
})
const tu = r1.json?.content?.find((c) => c.type === "tool_use")
check("tool call captured", r1.status === 200 && tu?.name === "read_file", JSON.stringify(tu || r1.json?.content || ""))

if (tu) {
  const r2 = await post("/v1/messages", {
    model: "claude-sonnet-5",
    max_tokens: 512,
    tools: [{ name: "read_file", description: "Read a file from disk", input_schema: schema }],
    messages: [
      { role: "user", content: "Use the read_file tool to read notes.txt. Then report its contents." },
      { role: "assistant", content: [{ type: "tool_use", id: tu.id, name: tu.name, input: tu.input }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: tu.id, content: TOKEN }] },
    ],
  })
  const txt2 = r2.json?.content?.map((c) => c.text).join("") || ""
  check("tool round-trip", r2.status === 200 && txt2.includes(TOKEN), JSON.stringify(txt2.slice(0, 100)))
}

const failed = out.filter((o) => !o.ok)
console.log("\n== " + (out.length - failed.length) + "/" + out.length + " live checks passed")
process.exit(failed.length ? 1 : 0)
