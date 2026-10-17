// test-formats.mjs — end-to-end acceptance test for ccgw.
//
// Spawns the gateway and exercises all three client dialects:
//   - non-stream text
//   - streaming text
//   - tool round-trip (model calls client tool -> client executes ->
//     result returns in the follow-up request -> model continues)
//
// Run: node ccgw/test-formats.mjs
import { spawn, execSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.CCGW_TEST_PORT || 8317)
const BASE = "http://127.0.0.1:" + PORT
const TOOL_CONTENT = "MAGIC-TOKEN-42"
const REAL_FILE = path.join(__dirname, "real-notes.txt")
const FILE_TOKEN = "FILE-TOKEN-8675309"
const CMD_TOKEN = "CMD-TOKEN-42"
fs.writeFileSync(REAL_FILE, "first line of the real file\nsecond line: " + FILE_TOKEN + "\n")

const results = []
const check = (name, ok, detail = "") => {
  results.push({ name, ok })
  console.log((ok ? "   PASS " : "   FAIL ") + name + (detail ? "  [" + detail + "]" : ""))
}

// --------------------------------------------------------------------------

const srv = spawn(process.execPath, [path.join(__dirname, "server.mjs")], {
  env: { ...process.env, CCGW_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
})
srv.stdout.on("data", (d) => process.stdout.write("[srv] " + d))
srv.stderr.on("data", (d) => process.stderr.write("[srv-err] " + d))

async function waitHealth(ms = 20000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + "/health")
      if (r.ok) {
        const h = await r.json()
        console.log("   health:", JSON.stringify(h).slice(0, 300))
        return h
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error("server did not become healthy")
}

async function post(p, body, headers = {}) {
  const r = await fetch(BASE + p, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: r.status, text, json }
}

async function streamPost(p, body, headers = {}) {
  const r = await fetch(BASE + p, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...headers },
    body: JSON.stringify(body),
  })
  if (!r.ok) return { status: r.status, frames: [], text: await r.text() }
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ""
  const frames = []
  let lastEvent = null
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "")
      buf = buf.slice(i + 1)
      if (line === "") {
        lastEvent = null
        continue
      }
      if (line.startsWith("event:")) lastEvent = line.slice(6).trim()
      else if (line.startsWith("data:")) {
        const raw = line.slice(5).trim()
        let data = null
        try {
          data = JSON.parse(raw)
        } catch {
          data = raw
        }
        frames.push({ event: lastEvent, data })
      }
    }
  }
  return { status: r.status, frames }
}

const READ_FILE_SCHEMA = {
  type: "object",
  properties: { path: { type: "string", description: "file path to read" } },
  required: ["path"],
}

// --------------------------------------------------------------------------
// Anthropic dialect

async function testAnthropic() {
  console.log("\n== Anthropic /v1/messages")

  {
    const r = await post("/v1/messages", {
      model: "claude-sonnet-5",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Reply with exactly: A-NONSTREAM" }],
    })
    const txt = r.json?.content?.map((c) => c.text).join("") || ""
    check("anthropic non-stream text", r.status === 200 && txt.includes("A-NONSTREAM"), "status=" + r.status + " text=" + JSON.stringify(txt.slice(0, 80)))
  }

  {
    const r = await streamPost("/v1/messages", {
      model: "claude-sonnet-5",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: "Reply with exactly: A-STREAM" }],
    })
    const types = r.frames.map((f) => f.data?.type || f.event)
    let text = ""
    for (const f of r.frames) if (f.data?.type === "content_block_delta" && f.data?.delta?.type === "text_delta") text += f.data.delta.text
    const ok =
      r.status === 200 &&
      types[0] === "message_start" &&
      types.includes("content_block_start") &&
      types.includes("content_block_delta") &&
      types.includes("message_delta") &&
      types[types.length - 1] === "message_stop" &&
      text.includes("A-STREAM")
    check("anthropic stream text", ok, "types=" + types.slice(0, 4).join(",") + "..." + types.slice(-2).join(",") + " text=" + JSON.stringify(text.slice(0, 60)))
  }

  // tool round-trip, non-stream
  let toolUse = null
  {
    const r = await post("/v1/messages", {
      model: "claude-sonnet-5",
      max_tokens: 1024,
      tools: [{ name: "read_file", description: "Read a file from disk", input_schema: READ_FILE_SCHEMA }],
      messages: [{ role: "user", content: "Use the read_file tool to read notes.txt. Then report its contents." }],
    })
    toolUse = r.json?.content?.find((c) => c.type === "tool_use")
    check(
      "anthropic tool call (round 1)",
      r.status === 200 && toolUse?.name === "read_file" && pathOk(toolUse?.input),
      JSON.stringify(toolUse || r.json?.content || r.text.slice(0, 120))
    )
  }
  if (toolUse) {
    const r = await post("/v1/messages", {
      model: "claude-sonnet-5",
      max_tokens: 1024,
      tools: [{ name: "read_file", description: "Read a file from disk", input_schema: READ_FILE_SCHEMA }],
      messages: [
        { role: "user", content: "Use the read_file tool to read notes.txt. Then report its contents." },
        { role: "assistant", content: [toolUse] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: TOOL_CONTENT }] },
      ],
    })
    const txt = r.json?.content?.map((c) => c.text).join("") || ""
    check("anthropic tool round-trip (round 2)", r.status === 200 && txt.includes(TOOL_CONTENT), JSON.stringify(txt.slice(0, 140)))
  }

  // tool round-trip, streaming (Claude Code style)
  let sTool = null
  {
    const r = await streamPost("/v1/messages", {
      model: "claude-sonnet-5",
      max_tokens: 1024,
      stream: true,
      tools: [{ name: "read_file", description: "Read a file from disk", input_schema: READ_FILE_SCHEMA }],
      messages: [{ role: "user", content: "Read notes.txt with the read_file tool and then report what it says." }],
    })
    const types = r.frames.map((f) => f.data?.type)
    const tstart = r.frames.find((f) => f.data?.type === "content_block_start" && f.data?.content_block?.type === "tool_use")
    let partial = ""
    for (const f of r.frames) if (f.data?.type === "content_block_delta" && f.data?.delta?.type === "input_json_delta") partial += f.data.delta.partial_json
    sTool = tstart ? { id: tstart.data.content_block.id, name: tstart.data.content_block.name, input: safeJson(partial) } : null
    const stop = r.frames.find((f) => f.data?.type === "message_delta")?.data?.delta?.stop_reason
    check(
      "anthropic stream tool call (round 1)",
      r.status === 200 && sTool?.name === "read_file" && pathOk(sTool?.input) && stop === "tool_use" && types[types.length - 1] === "message_stop",
      "tool=" + JSON.stringify(sTool) + " stop=" + stop
    )
  }
  if (sTool) {
    const r = await streamPost("/v1/messages", {
      model: "claude-sonnet-5",
      max_tokens: 1024,
      stream: true,
      tools: [{ name: "read_file", description: "Read a file from disk", input_schema: READ_FILE_SCHEMA }],
      messages: [
        { role: "user", content: "Read notes.txt with the read_file tool and then report what it says." },
        { role: "assistant", content: [{ type: "tool_use", id: sTool.id, name: sTool.name, input: sTool.input }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: sTool.id, content: TOOL_CONTENT }] },
      ],
    })
    let text = ""
    for (const f of r.frames) if (f.data?.type === "content_block_delta" && f.data?.delta?.type === "text_delta") text += f.data.delta.text
    const stop = r.frames.find((f) => f.data?.type === "message_delta")?.data?.delta?.stop_reason
    check("anthropic stream tool round-trip (round 2)", r.status === 200 && text.includes(TOOL_CONTENT) && stop === "end_turn", "stop=" + stop + " text=" + JSON.stringify(text.slice(0, 120)))
  }
}

// --------------------------------------------------------------------------
// OpenAI chat completions dialect

async function testOpenAI() {
  console.log("\n== OpenAI /v1/chat/completions")

  {
    const r = await post("/v1/chat/completions", {
      model: "gpt-5.6-sol",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Reply with exactly: O-NONSTREAM" }],
    })
    const txt = r.json?.choices?.[0]?.message?.content || ""
    check("openai non-stream text", r.status === 200 && txt.includes("O-NONSTREAM"), "text=" + JSON.stringify(txt.slice(0, 80)))
  }

  {
    const r = await streamPost("/v1/chat/completions", {
      model: "gpt-5.6-sol",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: "Reply with exactly: O-STREAM" }],
    })
    let text = ""
    let sawDone = false
    let finish = null
    for (const f of r.frames) {
      if (f.data === "[DONE]") sawDone = true
      else if (f.data?.choices) {
        text += f.data.choices[0]?.delta?.content || ""
        if (f.data.choices[0]?.finish_reason) finish = f.data.choices[0].finish_reason
      }
    }
    check("openai stream text", r.status === 200 && text.includes("O-STREAM") && sawDone && finish === "stop", "finish=" + finish + " done=" + sawDone + " text=" + JSON.stringify(text.slice(0, 60)))
  }

  let toolCall = null
  {
    const r = await post("/v1/chat/completions", {
      model: "gpt-5.6-sol",
      max_tokens: 1024,
      tools: [{ type: "function", function: { name: "read_file", description: "Read a file from disk", parameters: READ_FILE_SCHEMA } }],
      messages: [{ role: "user", content: "Use the read_file tool to read notes.txt. Then report its contents." }],
    })
    toolCall = r.json?.choices?.[0]?.message?.tool_calls?.[0]
    const args = safeJson(toolCall?.function?.arguments)
    const finish = r.json?.choices?.[0]?.finish_reason
    check(
      "openai tool call (round 1)",
      r.status === 200 && toolCall?.function?.name === "read_file" && pathOk(args) && finish === "tool_calls",
      "finish=" + finish + " args=" + JSON.stringify(args)
    )
  }
  if (toolCall) {
    const r = await post("/v1/chat/completions", {
      model: "gpt-5.6-sol",
      max_tokens: 1024,
      tools: [{ type: "function", function: { name: "read_file", description: "Read a file from disk", parameters: READ_FILE_SCHEMA } }],
      messages: [
        { role: "user", content: "Use the read_file tool to read notes.txt. Then report its contents." },
        { role: "assistant", content: null, tool_calls: [toolCall] },
        { role: "tool", tool_call_id: toolCall.id, content: TOOL_CONTENT },
      ],
    })
    const txt = r.json?.choices?.[0]?.message?.content || ""
    check("openai tool round-trip (round 2)", r.status === 200 && txt.includes(TOOL_CONTENT), JSON.stringify(txt.slice(0, 140)))
  }

  let sToolCall = null
  {
    const r = await streamPost("/v1/chat/completions", {
      model: "gpt-5.6-sol",
      max_tokens: 1024,
      stream: true,
      tools: [{ type: "function", function: { name: "read_file", description: "Read a file from disk", parameters: READ_FILE_SCHEMA } }],
      messages: [{ role: "user", content: "Read notes.txt with the read_file tool and then report what it says." }],
    })
    let finish = null
    let args = ""
    let id = null
    let name = null
    for (const f of r.frames) {
      if (f.data?.choices) {
        const d = f.data.choices[0]?.delta
        if (d?.tool_calls) {
          for (const tc of d.tool_calls) {
            if (tc.id) id = tc.id
            if (tc.function?.name) name = tc.function.name
            if (tc.function?.arguments) args += tc.function.arguments
          }
        }
        if (f.data.choices[0]?.finish_reason) finish = f.data.choices[0].finish_reason
      }
    }
    sToolCall = { id, type: "function", function: { name, arguments: args } }
    check("openai stream tool call (round 1)", r.status === 200 && name === "read_file" && pathOk(safeJson(args)) && finish === "tool_calls", "finish=" + finish + " args=" + args)
  }
  if (sToolCall?.id) {
    const r = await streamPost("/v1/chat/completions", {
      model: "gpt-5.6-sol",
      max_tokens: 1024,
      stream: true,
      tools: [{ type: "function", function: { name: "read_file", description: "Read a file from disk", parameters: READ_FILE_SCHEMA } }],
      messages: [
        { role: "user", content: "Read notes.txt with the read_file tool and then report what it says." },
        { role: "assistant", content: null, tool_calls: [sToolCall] },
        { role: "tool", tool_call_id: sToolCall.id, content: TOOL_CONTENT },
      ],
    })
    let text = ""
    for (const f of r.frames) if (f.data?.choices) text += f.data.choices[0]?.delta?.content || ""
    check("openai stream tool round-trip (round 2)", r.status === 200 && text.includes(TOOL_CONTENT), JSON.stringify(text.slice(0, 120)))
  }
}

// --------------------------------------------------------------------------
// Responses dialect (Codex)

async function testResponses() {
  console.log("\n== OpenAI /v1/responses (Codex)")

  {
    const r = await post("/v1/responses", {
      model: "gpt-5.6-sol",
      input: "Reply with exactly: R-NONSTREAM",
      store: false,
    })
    const txt = (r.json?.output || []).filter((o) => o.type === "message").flatMap((o) => o.content || []).map((c) => c.text).join("")
    check("responses non-stream text", r.status === 200 && txt.includes("R-NONSTREAM") && r.json?.status === "completed", "text=" + JSON.stringify(txt.slice(0, 80)))
  }

  {
    const r = await streamPost("/v1/responses", {
      model: "gpt-5.6-sol",
      input: "Reply with exactly: R-STREAM",
      store: false,
      stream: true,
    })
    const types = r.frames.map((f) => f.data?.type || f.event)
    let text = ""
    let completed = null
    for (const f of r.frames) {
      if (f.data?.type === "response.output_text.delta") text += f.data.delta
      if (f.data?.type === "response.completed") completed = f.data.response
    }
    check(
      "responses stream text",
      r.status === 200 && types[0] === "response.created" && types[types.length - 1] === "response.completed" && text.includes("R-STREAM") && completed?.status === "completed",
      "text=" + JSON.stringify(text.slice(0, 60))
    )
  }

  let fc = null
  {
    const r = await post("/v1/responses", {
      model: "gpt-5.6-sol",
      tools: [{ type: "function", name: "read_file", description: "Read a file from disk", parameters: READ_FILE_SCHEMA }],
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Use the read_file tool to read notes.txt. Then report its contents." }] },
      ],
      store: false,
    })
    fc = (r.json?.output || []).find((o) => o.type === "function_call")
    check(
      "responses tool call (round 1)",
      r.status === 200 && fc?.name === "read_file" && pathOk(safeJson(fc?.arguments)),
      JSON.stringify(fc || r.json?.output || r.text.slice(0, 120))
    )
  }
  if (fc) {
    const r = await post("/v1/responses", {
      model: "gpt-5.6-sol",
      tools: [{ type: "function", name: "read_file", description: "Read a file from disk", parameters: READ_FILE_SCHEMA }],
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Use the read_file tool to read notes.txt. Then report its contents." }] },
        { type: "function_call", call_id: fc.call_id, name: fc.name, arguments: fc.arguments },
        { type: "function_call_output", call_id: fc.call_id, output: TOOL_CONTENT },
      ],
      store: false,
    })
    const txt = (r.json?.output || []).filter((o) => o.type === "message").flatMap((o) => o.content || []).map((c) => c.text).join("")
    check("responses tool round-trip (round 2)", r.status === 200 && txt.includes(TOOL_CONTENT), JSON.stringify(txt.slice(0, 140)))
  }

  let sFc = null
  {
    const r = await streamPost("/v1/responses", {
      model: "gpt-5.6-sol",
      tools: [{ type: "function", name: "read_file", description: "Read a file from disk", parameters: READ_FILE_SCHEMA }],
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Read notes.txt with the read_file tool and then report what it says." }] }],
      store: false,
      stream: true,
    })
    for (const f of r.frames) {
      if (f.data?.type === "response.output_item.done" && f.data?.item?.type === "function_call") sFc = f.data.item
    }
    check(
      "responses stream tool call (round 1)",
      r.status === 200 && sFc?.name === "read_file" && pathOk(safeJson(sFc?.arguments)),
      JSON.stringify(sFc)
    )
  }
  if (sFc) {
    const r = await streamPost("/v1/responses", {
      model: "gpt-5.6-sol",
      tools: [{ type: "function", name: "read_file", description: "Read a file from disk", parameters: READ_FILE_SCHEMA }],
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Read notes.txt with the read_file tool and then report what it says." }] },
        { type: "function_call", call_id: sFc.call_id, name: sFc.name, arguments: sFc.arguments },
        { type: "function_call_output", call_id: sFc.call_id, output: TOOL_CONTENT },
      ],
      store: false,
      stream: true,
    })
    let text = ""
    for (const f of r.frames) if (f.data?.type === "response.output_text.delta") text += f.data.delta
    check("responses stream tool round-trip (round 2)", r.status === 200 && text.includes(TOOL_CONTENT), JSON.stringify(text.slice(0, 120)))
  }
}

function safeJson(s) {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

const pathOk = (args) => typeof args?.path === "string" && args.path.endsWith("notes.txt")

// --- real client-side tool execution --------------------------------------

function executeToolCall(name, args) {
  try {
    if (name === "read_file") return fs.readFileSync(String(args?.path || ""), "utf8")
    if (name === "run_command") {
      return execSync(String(args?.command || ""), { encoding: "utf8", timeout: 15000, windowsHide: true })
    }
    return "ERROR: unknown tool " + name
  } catch (e) {
    return "ERROR: " + (e.stdout || "") + (e.stderr || e.message)
  }
}

const REAL_TOOLS_ANTHROPIC = [
  { name: "read_file", description: "Read a file from disk (client-side tool)", input_schema: READ_FILE_SCHEMA },
  {
    name: "run_command",
    description: "Run a shell command and return its stdout (client-side tool)",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
]
const REAL_TOOLS_OPENAI = REAL_TOOLS_ANTHROPIC.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }))
const REAL_TOOLS_RESPONSES = REAL_TOOLS_ANTHROPIC.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.input_schema }))
const REAL_PROMPT =
  "First read the file " +
  REAL_FILE +
  ' with read_file. Then run the command node -e "console.log(\'CMD-TOKEN-\' + (6*7))" with run_command. ' +
  "Then summarize: the second line of the file, and the exact command output. Include both exact tokens in your final answer."

function anthropicToolBlocks(frames) {
  const blocks = []
  let cur = null
  let partial = ""
  for (const f of frames) {
    const d = f.data
    if (d?.type === "content_block_start" && d.content_block?.type === "tool_use") {
      cur = { id: d.content_block.id, name: d.content_block.name }
      partial = ""
    } else if (d?.type === "content_block_delta" && d.delta?.type === "input_json_delta" && cur) {
      partial += d.delta.partial_json
    } else if (d?.type === "content_block_stop" && cur) {
      blocks.push({ ...cur, input: safeJson(partial) || {} })
      cur = null
    }
  }
  return blocks
}

async function testRealToolsAnthropic() {
  console.log("\n== Anthropic real tool execution (stream; client really reads/executes)")
  const messages = [{ role: "user", content: REAL_PROMPT }]
  let finalText = ""
  const callLog = []
  for (let round = 0; round < 5; round++) {
    const r = await streamPost("/v1/messages", { model: "claude-sonnet-5", max_tokens: 1024, stream: true, tools: REAL_TOOLS_ANTHROPIC, messages })
    let text = ""
    for (const f of r.frames) if (f.data?.type === "content_block_delta" && f.data?.delta?.type === "text_delta") text += f.data.delta.text
    const blocks = anthropicToolBlocks(r.frames)
    if (!blocks.length) {
      finalText = text
      break
    }
    messages.push({ role: "assistant", content: blocks.map((b) => ({ type: "tool_use", id: b.id, name: b.name, input: b.input })) })
    messages.push({
      role: "user",
      content: blocks.map((b) => {
        const out = executeToolCall(b.name, b.input)
        callLog.push(b.name + "(" + JSON.stringify(b.input || {}).slice(0, 90) + ")")
        return { type: "tool_result", tool_use_id: b.id, content: out }
      }),
    })
  }
  check(
    "anthropic real tools loop (file + command)",
    finalText.includes(FILE_TOKEN) && finalText.includes(CMD_TOKEN),
    "calls=" + JSON.stringify(callLog) + " text=" + JSON.stringify(finalText.slice(0, 200))
  )
}

async function testRealToolsResponses() {
  console.log("\n== Responses real tool execution (Codex style)")
  const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: REAL_PROMPT }] }]
  let finalText = ""
  const callLog = []
  for (let round = 0; round < 5; round++) {
    const r = await streamPost("/v1/responses", { model: "gpt-5.6-sol", tools: REAL_TOOLS_RESPONSES, input, stream: true, store: false })
    let text = ""
    const calls = []
    for (const f of r.frames) {
      if (f.data?.type === "response.output_text.delta") text += f.data.delta
      if (f.data?.type === "response.output_item.done" && f.data?.item?.type === "function_call") calls.push(f.data.item)
    }
    if (!calls.length) {
      finalText = text
      break
    }
    for (const c of calls) {
      input.push({ type: "function_call", call_id: c.call_id, name: c.name, arguments: c.arguments })
      const out = executeToolCall(c.name, safeJson(c.arguments) || {})
      callLog.push(c.name + "(" + String(c.arguments).slice(0, 90) + ")")
      input.push({ type: "function_call_output", call_id: c.call_id, output: out })
    }
  }
  check(
    "responses real tools loop (file + command)",
    finalText.includes(FILE_TOKEN) && finalText.includes(CMD_TOKEN),
    "calls=" + JSON.stringify(callLog) + " text=" + JSON.stringify(finalText.slice(0, 200))
  )
}

// --------------------------------------------------------------------------

const only = process.argv[2] || "all"
try {
  const h = await waitHealth()
  if (!h.eventStream) console.log("   WARN: event stream not connected yet")
  if (only === "all" || only === "anthropic") await testAnthropic()
  if (only === "all" || only === "openai") await testOpenAI()
  if (only === "all" || only === "responses") await testResponses()
  if (only === "all" || only === "real") {
    await testRealToolsAnthropic()
    await testRealToolsResponses()
  }
} catch (e) {
  console.error("TEST HARNESS ERROR:", e.message)
  results.push({ name: "harness", ok: false })
} finally {
  srv.kill()
}

const failed = results.filter((r) => !r.ok)
console.log("\n== " + (results.length - failed.length) + "/" + results.length + " checks passed")
if (failed.length) {
  console.log("FAILED:", failed.map((f) => f.name).join(", "))
  process.exit(1)
}
process.exit(0)
