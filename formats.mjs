// formats.mjs — protocol adapters for ccgw.
//
// Converts Anthropic Messages / OpenAI Chat Completions / OpenAI Responses
// requests into a canonical form, renders a single prompt transcript for the
// OpenCode turn, and builds dialect-correct (streaming and non-streaming)
// responses from a runTurn result.
//
// Canonical request:
//   {
//     model: string,                     // client-requested, opaque
//     system: string,                    // flattened system text
//     messages: [
//       { role: "user", text },
//       { role: "assistant", text?, toolUses: [{ id, name, input, raw }] },
//       { role: "tool", results: [{ toolUseId, name?, text }] },
//     ],
//     tools: [{ name, description, inputSchema }],
//     stream: boolean,
//   }
import crypto from "node:crypto"
import { buildNameMap } from "./engine.mjs"
import { prepareImages } from "./images.mjs"

export const uid = (p) => p + crypto.randomBytes(12).toString("hex")

// ---------------------------------------------------------------------------
// Canonical parsing

function outputBudget(body, ...fields) {
  const field = fields.find((key) => body[key] !== undefined)
  if (!field) return undefined
  const n = body[field]
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(field + ' must be a positive integer')
  return n
}

const MEDIA_BLOCKS = new Set(['image','image_url','input_image','document','file','input_file','audio','input_audio','video','input_video'])
function rejectUnsupportedMedia(block) {
  if (MEDIA_BLOCKS.has(block?.type)) throw new Error('Unsupported ' + block.type + ' input: ccgw 尚未实现此附件类型的转发；请勿把此请求当作已读取附件。')
  if (Array.isArray(block?.content)) block.content.forEach(rejectUnsupportedMedia)
}

function anthropicContentToParts(content) {
  // returns { text, toolUses, toolResults }
  const out = { text: "", toolUses: [], toolResults: [] }
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content || []
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue
    rejectUnsupportedMedia(b)
    if (b.type === "text") out.text += b.text || ""
    else if (b.type === "tool_use") out.toolUses.push({ id: b.id || uid("toolu_"), name: b.name, input: b.input ?? {}, raw: undefined })
    else if (b.type === "tool_result") {
      let text = ""
      if (typeof b.content === "string") text = b.content
      else if (Array.isArray(b.content)) text = b.content.filter((c) => c?.type === "text").map((c) => c.text || "").join("\n")
      out.toolResults.push({ toolUseId: b.tool_use_id, text })
    }
    // thinking / redacted_thinking / server_tool_use etc. dropped
  }
  return out
}

export function parseAnthropic(body) {
  const prepared = prepareImages(body); body = prepared.body
  const system =
    typeof body.system === "string"
      ? body.system
      : Array.isArray(body.system)
        ? body.system.filter((b) => b?.type === "text").map((b) => b.text || "").join("\n")
        : ""
  const messages = []
  for (const m of body.messages || []) {
    if (m.role === "assistant") {
      const p = anthropicContentToParts(m.content)
      messages.push({ role: "assistant", text: p.text, toolUses: p.toolUses })
    } else {
      const p = anthropicContentToParts(m.content)
      if (p.toolResults.length) messages.push({ role: "tool", results: p.toolResults })
      if (p.text || !p.toolResults.length) messages.push({ role: "user", text: p.text })
    }
  }
  return {
    model: body.model || "",
    system,
    messages,
    tools: anthropicTools(body.tools),
    stream: !!body.stream,
    maxOutputTokens: outputBudget(body, 'max_tokens'),
    files: prepared.files,
  }
}

function anthropicTools(tools) {
  if (!Array.isArray(tools)) return []
  return tools
    .filter((t) => t && t.name)
    .map((t) => ({
      name: String(t.name),
      description: String(t.description || ""),
      inputSchema: t.input_schema || { type: "object", properties: {} },
    }))
}

function openaiContentText(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (!c || typeof c !== "object") return ""
        rejectUnsupportedMedia(c)
        if (c.type === "text") return c.text || ""
        if (c.type === "input_text" || c.type === "output_text") return c.text || ""
        return ""
      })
      .join("")
  }
  return ""
}

function openaiTools(tools) {
  if (!Array.isArray(tools)) return []
  return tools
    .map((t) => {
      if (!t) return null
      const fn = t.type === "function" && t.function ? t.function : t
      if (!fn.name) return null
      return {
        name: String(fn.name),
        description: String(fn.description || ""),
        inputSchema: fn.parameters || { type: "object", properties: {} },
      }
    })
    .filter(Boolean)
}

export function parseOpenAI(body) {
  const prepared = prepareImages(body); body = prepared.body
  let system = ""
  const messages = []
  for (const m of body.messages || []) {
    if (!m) continue
    if (m.audio) throw new Error('Unsupported audio input: ccgw 尚未实现音频转发')
    if (m.role === "system" || m.role === "developer") {
      system += (system ? "\n" : "") + openaiContentText(m.content)
    } else if (m.role === "assistant") {
      const toolUses = (m.tool_calls || [])
        .filter((c) => c?.function?.name)
        .map((c) => ({
          id: c.id || uid("call_"),
          name: c.function.name,
          input: parseArgs(c.function.arguments),
          raw: typeof c.function.arguments === "string" ? c.function.arguments : JSON.stringify(c.function.arguments ?? {}),
        }))
      messages.push({ role: "assistant", text: openaiContentText(m.content), toolUses })
    } else if (m.role === "tool" || m.role === "function") {
      messages.push({ role: "tool", results: [{ toolUseId: m.tool_call_id || "", name: m.name, text: openaiContentText(m.content) }] })
    } else {
      messages.push({ role: "user", text: openaiContentText(m.content) })
    }
  }
  return {
    model: body.model || "",
    system,
    messages,
    tools: openaiTools(body.tools),
    stream: !!body.stream,
    maxOutputTokens: outputBudget(body, 'max_completion_tokens', 'max_tokens'),
    files: prepared.files,
  }
}

function parseArgs(a) {
  if (a === undefined || a === null) return undefined
  if (typeof a === "object") return a
  try {
    return JSON.parse(a)
  } catch {
    return undefined
  }
}

export function parseResponses(body) {
  const prepared = prepareImages(body); body = prepared.body
  let system = String(body.instructions || "")
  const messages = []
  const input = body.input
  const items = typeof input === "string" ? [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }] : input || []
  for (const it of items) {
    if (!it) continue
    rejectUnsupportedMedia(it)
    if (it.type === "function_call") {
      messages.push({
        role: "assistant",
        text: "",
        toolUses: [
          {
            id: it.call_id || it.id || uid("call_"),
            name: it.name,
            input: parseArgs(it.arguments),
            raw: typeof it.arguments === "string" ? it.arguments : JSON.stringify(it.arguments ?? {}),
          },
        ],
      })
    } else if (it.type === "function_call_output") {
      const text = typeof it.output === "string" ? it.output : openaiContentText(it.output)
      messages.push({ role: "tool", results: [{ toolUseId: it.call_id || "", text }] })
    } else if (it.type === "reasoning") {
      // dropped
    } else if (it.type === "message" || it.role) {
      const role = it.role || "user"
      const text = openaiContentText(it.content)
      if (role === "system" || role === "developer") system += (system ? "\n" : "") + text
      else if (role === "assistant") messages.push({ role: "assistant", text, toolUses: [] })
      else messages.push({ role: "user", text })
    }
  }
  // Responses tools are flattened: { type: "function", name, description, parameters }
  const tools = Array.isArray(body.tools)
    ? body.tools
        .filter((t) => t && t.name && (t.type === "function" || !t.type))
        .map((t) => ({
          name: String(t.name),
          description: String(t.description || ""),
          inputSchema: t.parameters || { type: "object", properties: {} },
        }))
    : []
  return {
    model: body.model || "",
    system,
    messages,
    tools,
    stream: !!body.stream,
    maxOutputTokens: outputBudget(body, 'max_output_tokens'),
    files: prepared.files,
  }
}

// Apply tool_choice: "none" removes tools; a specific tool keeps only it.
export function applyToolChoice(canon, toolChoice) {
  if (!toolChoice) return canon
  const none =
    toolChoice === "none" ||
    (typeof toolChoice === "object" && (toolChoice.type === "none" || toolChoice.mode === "NONE"))
  const chosen =
    (typeof toolChoice === "object" && (toolChoice.name || toolChoice.function?.name)) || null
  if (none) canon.tools = []
  else if (chosen) {
    const name = toolChoice.name || toolChoice.function?.name
    canon.tools = canon.tools.filter((t) => t.name === name)
    canon.forcedTool = name
  } else if (typeof toolChoice === "object" && toolChoice.type === "tool" && toolChoice.name) {
    canon.tools = canon.tools.filter((t) => t.name === toolChoice.name)
    canon.forcedTool = toolChoice.name
  }
  return canon
}

// ---------------------------------------------------------------------------
// Transcript rendering

export function renderPrompt(canon, bridgeName, origToSan, routing = null) {
  const lines = []
  const wireName = (origName) => {
    const san = origToSan?.get(origName)
    return bridgeName && san ? bridgeName + "_" + san : null
  }
  const overflow = routing?.overflow instanceof Set ? routing.overflow : new Set()
  const dispatcherWire = routing?.dispatcher && bridgeName ? bridgeName + "_" + routing.dispatcher : null
  if (canon.system.trim()) {
    lines.push("System instructions:")
    lines.push(canon.system.trim())
    lines.push("")
  }
  lines.push("=== Conversation ===")
  const toolNameById = new Map()
  for (const m of canon.messages) {
    if (m.role === "user") {
      lines.push("User: " + (m.text || ""))
    } else if (m.role === "assistant") {
      if (m.text) lines.push("Assistant: " + m.text)
      for (const tu of m.toolUses || []) {
        toolNameById.set(tu.id, tu.name)
        const raw = tu.raw || JSON.stringify(tu.input ?? {})
        const direct = wireName(tu.name)
        if (direct) lines.push("Assistant called tool " + direct + " with arguments " + raw)
        else if (dispatcherWire && overflow.has(tu.name)) {
          lines.push("Assistant called tool " + dispatcherWire + " with arguments " + JSON.stringify({ name: tu.name, input: tu.input ?? {} }))
        } else lines.push("Assistant called tool " + tu.name + " with arguments " + raw)
      }
      if (!m.text && !(m.toolUses || []).length) lines.push("Assistant: (no content)")
    } else if (m.role === "tool") {
      for (const r of m.results || []) {
        const nm = r.name || toolNameById.get(r.toolUseId)
        lines.push("Tool result" + (nm ? " (" + nm + ")" : "") + ": " + (r.text || "(empty)"))
      }
    }
  }
  lines.push("=== End of conversation ===")
  lines.push("")
  if (canon.tools.length && bridgeName && origToSan) {
    lines.push("Client tool routing:")
    lines.push("Execute operations requested in this conversation with the client's bridged tools below. The built-in read tool belongs to the isolated gateway backend, not the user's workspace; do not use it for client file reads.")
    lines.push("Directly registered bridge tools (call them by exactly this name):")
    for (const t of canon.tools) {
      const direct = wireName(t.name)
      if (direct) lines.push(t.name + " -> " + direct)
    }
    if (dispatcherWire && overflow.size) {
      lines.push("Additional client tools reachable through the dispatcher " + dispatcherWire + " (call that tool with " + JSON.stringify({ name: "<tool name>", input: {} }) + "):")
      for (const t of canon.tools) if (overflow.has(t.name)) lines.push(t.name)
    }
    lines.push("")
  }
  const lastRole = canon.messages.length ? canon.messages[canon.messages.length - 1].role : ""
  let directive
  if (lastRole === "tool") {
    // The client already executed the requested tools; their output is above.
    directive =
      "The trailing messages in the conversation are tool results that have ALREADY been executed for you by the user's client. " +
      "Use them to continue and answer the original request directly. " +
      "Do NOT call these tools again — they have already run and their output is written above."
  } else {
    directive = "Respond now as the Assistant, continuing the conversation. Do not write transcript markers such as 'User:' or 'Assistant:'."
    if (canon.tools.length) {
      directive +=
        " You may call the provided tools when needed — make real tool calls, never write tool calls as text. Tool results will be appended to this conversation afterwards."
    }
  }
  if (canon.tools.length && canon.forcedTool) {
    const direct = wireName(canon.forcedTool)
    if (direct) directive += " For this request you must call the tool '" + direct + "'."
    else if (dispatcherWire && overflow.has(canon.forcedTool)) {
      directive += " For this request you must call the tool '" + dispatcherWire + "' with {\"name\": \"" + canon.forcedTool + "\", \"input\": {...}}."
    }
  }
  lines.push(directive)
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Model resolution: client model names are opaque; map to a known free model.

export function resolveModel(requested, knownIds, fallback) {
  if (!requested) return fallback
  const bare = String(requested).includes("/") ? String(requested).split("/").slice(1).join("/") : String(requested)
  if (knownIds.includes(bare)) return bare
  return fallback
}

// ---------------------------------------------------------------------------
// Non-streaming responses

const stopReasonAnthropic = (result) => (result.toolCalls.length ? "tool_use" : result.finish === "length" ? "max_tokens" : "end_turn")
const stopReasonOpenAI = result => result.toolCalls.length ? 'tool_calls' : result.finish === 'length' ? 'length' : 'stop'
const responseCompletion = result => result.finish === 'length'
  ? {status:'incomplete',incomplete_details:{reason:'max_output_tokens'}}
  : {status:'completed',incomplete_details:null}

export function anthropicNonStream(result, model, inputTokens) {
  const content = []
  if (result.text) content.push({ type: "text", text: result.text })
  for (const tc of result.toolCalls) content.push({ type: "tool_use", id: tc.id || uid("toolu_"), name: tc.name, input: tc.input ?? {} })
  return {
    id: uid("msg_"),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReasonAnthropic(result),
    stop_sequence: null,
    usage: { input_tokens: inputTokens ?? result.usage?.input ?? 0, output_tokens: result.usage?.output ?? 0 },
  }
}

export function openaiNonStream(result, model, inputTokens) {
  const message = { role: "assistant", content: result.text || null }
  if (result.toolCalls.length) {
    message.tool_calls = result.toolCalls.map((tc) => ({
      id: tc.id || uid("call_"),
      type: "function",
      function: { name: tc.name, arguments: tc.raw || JSON.stringify(tc.input ?? {}) },
    }))
  }
  return {
    id: uid("chatcmpl-"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: stopReasonOpenAI(result) }],
    usage: {
      prompt_tokens: inputTokens ?? result.usage?.input ?? 0,
      completion_tokens: result.usage?.output ?? 0,
      total_tokens: (inputTokens ?? result.usage?.input ?? 0) + (result.usage?.output ?? 0),
    },
  }
}

export function responsesNonStream(result, model, inputTokens) {
  const output = []
  if (result.text) {
    output.push({
      id: uid("msg_"),
      type: "message",
      role: "assistant",
      status: result.finish === 'length' ? 'incomplete' : 'completed',
      content: [{ type: "output_text", text: result.text, annotations: [] }],
    })
  }
  for (const tc of result.toolCalls) {
    output.push({
      type: "function_call",
      id: uid("fc_"),
      call_id: tc.id || uid("call_"),
      name: tc.name,
      arguments: tc.raw || JSON.stringify(tc.input ?? {}),
      status: "completed",
    })
  }
  const it = inputTokens ?? result.usage?.input ?? 0
  const ot = result.usage?.output ?? 0
  return {
    id: uid("resp_"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    ...responseCompletion(result),
    error: null,
    instructions: null,
    max_output_tokens: null,
    model,
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    store: false,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage: { input_tokens: it, output_tokens: ot, total_tokens: it + ot },
    metadata: {},
  }
}

// ---------------------------------------------------------------------------
// Streaming response builders. `send(eventName|null, obj)` writes one SSE
// frame; null eventName = data-only frame (OpenAI style).

export function makeAnthropicStream(send, model, inputTokens) {
  const id = uid("msg_")
  let textOpen = false
  let blockIndex = 0
  let textLen = 0

  send("message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens || 0, output_tokens: 0 },
    },
  })
  send("ping", { type: "ping" })

  const openText = () => {
    if (textOpen) return
    textOpen = true
    send("content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } })
  }
  const closeText = () => {
    if (!textOpen) return
    send("content_block_stop", { type: "content_block_stop", index: blockIndex })
    blockIndex++
    textOpen = false
  }

  return {
    onDelta(d) {
      openText()
      textLen += d.length
      send("content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: d } })
    },
    finish(result) {
      closeText()
      // If nothing was emitted, still provide an (empty) text block.
      if (blockIndex === 0 && !result.toolCalls.length) {
        send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
        send("content_block_stop", { type: "content_block_stop", index: 0 })
        blockIndex = 1
      }
      for (const tc of result.toolCalls) {
        send("content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "tool_use", id: tc.id || uid("toolu_"), name: tc.name, input: {} },
        })
        const args = tc.raw || JSON.stringify(tc.input ?? {})
        if (args && args !== "{}") {
          send("content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "input_json_delta", partial_json: args },
          })
        }
        send("content_block_stop", { type: "content_block_stop", index: blockIndex })
        blockIndex++
      }
      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReasonAnthropic(result), stop_sequence: null },
        usage: { output_tokens: result.usage?.output ?? 0 },
      })
      send("message_stop", { type: "message_stop" })
    },
    fail(err) {
      send("error", { type: "error", error: { type: err?.type || "api_error", message: String(err?.message || err) } })
    },
  }
}

export function makeOpenAIStream(send, model, inputTokens) {
  const id = uid("chatcmpl-")
  const created = Math.floor(Date.now() / 1000)
  const chunk = (delta, finish_reason = null) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason }],
  })

  send(null, chunk({ role: "assistant", content: "" }))

  return {
    onDelta(d) {
      send(null, chunk({ content: d }))
    },
    finish(result) {
      result.toolCalls.forEach((tc, i) => {
        const args = tc.raw || JSON.stringify(tc.input ?? {})
        send(null, chunk({ tool_calls: [{ index: i, id: tc.id || uid("call_"), type: "function", function: { name: tc.name, arguments: args } }] }))
      })
      send(null, chunk({}, stopReasonOpenAI(result)))
      send(null, "[DONE]")
    },
    fail(err) {
      send(null, { error: { message: String(err?.message || err), type: err?.type || "server_error", ...(err?.code ? { code: err.code } : {}) } })
      send(null, "[DONE]")
    },
  }
}

export function makeResponsesStream(send, model, inputTokens) {
  const respId = uid("resp_")
  let seq = 0
  let textOpen = false
  const msgId = uid("msg_")
  let outputIndex = 0

  const baseResponse = () => ({
    id: respId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "in_progress",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model,
    output: [],
    parallel_tool_calls: true,
    previous_response_id: null,
    store: false,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage: null,
    metadata: {},
  })

  send("response.created", { type: "response.created", sequence_number: seq++, response: baseResponse() })
  send("response.in_progress", { type: "response.in_progress", sequence_number: seq++, response: baseResponse() })

  const openText = () => {
    if (textOpen) return
    textOpen = true
    send("response.output_item.added", {
      type: "response.output_item.added",
      sequence_number: seq++,
      output_index: outputIndex,
      item: { id: msgId, type: "message", status: "in_progress", content: [], role: "assistant" },
    })
    send("response.content_part.added", {
      type: "response.content_part.added",
      sequence_number: seq++,
      item_id: msgId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", annotations: [], text: "" },
    })
  }

  return {
    onDelta(d) {
      openText()
      send("response.output_text.delta", {
        type: "response.output_text.delta",
        sequence_number: seq++,
        item_id: msgId,
        output_index: outputIndex,
        content_index: 0,
        delta: d,
        logprobs: [],
      })
    },
    finish(result) {
      const output = []
      let idx = 0
      if (textOpen || (!result.toolCalls.length && result.text !== "")) {
        if (!textOpen) openText()
        const full = result.text || ""
        send("response.output_text.done", {
          type: "response.output_text.done",
          sequence_number: seq++,
          item_id: msgId,
          output_index: outputIndex,
          content_index: 0,
          text: full,
          logprobs: [],
        })
        send("response.content_part.done", {
          type: "response.content_part.done",
          sequence_number: seq++,
          item_id: msgId,
          output_index: outputIndex,
          content_index: 0,
          part: { type: "output_text", annotations: [], text: full },
        })
        const item = { id: msgId, type: "message", status: result.finish === 'length' ? 'incomplete' : 'completed', content: [{ type: "output_text", annotations: [], text: full }], role: "assistant" }
        send("response.output_item.done", { type: "response.output_item.done", sequence_number: seq++, output_index: outputIndex, item })
        output.push(item)
        idx = outputIndex + 1
        textOpen = false
      }
      for (const tc of result.toolCalls) {
        const fcId = uid("fc_")
        const callId = tc.id || uid("call_")
        const args = tc.raw || JSON.stringify(tc.input ?? {})
        const item = { id: fcId, type: "function_call", status: "in_progress", arguments: "", call_id: callId, name: tc.name }
        send("response.output_item.added", { type: "response.output_item.added", sequence_number: seq++, output_index: idx, item })
        send("response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          sequence_number: seq++,
          item_id: fcId,
          output_index: idx,
          delta: args,
        })
        send("response.function_call_arguments.done", {
          type: "response.function_call_arguments.done",
          sequence_number: seq++,
          item_id: fcId,
          output_index: idx,
          arguments: args,
        })
        const doneItem = { ...item, status: "completed", arguments: args }
        send("response.output_item.done", { type: "response.output_item.done", sequence_number: seq++, output_index: idx, item: doneItem })
        output.push(doneItem)
        idx++
      }
      const it = inputTokens || result.usage?.input || 0
      const ot = result.usage?.output || 0
      const full = { ...baseResponse(), ...responseCompletion(result), output, usage: { input_tokens: it, output_tokens: ot, total_tokens: it + ot } }
      const type = full.status === 'incomplete' ? 'response.incomplete' : 'response.completed'
      send(type, { type, sequence_number: seq++, response: full })
    },
    fail(err) {
      send("response.failed", {
        type: "response.failed",
        sequence_number: seq++,
        response: { ...baseResponse(), status: "failed", error: { code: err?.code || "server_error", message: String(err?.message || err) } },
      })
    },
  }
}

// ---------------------------------------------------------------------------
// /v1/models shapes

export function modelsAnthropic(list, now) {
  return {
    data: list.map((m) => ({
      type: "model",
      id: m.id,
      display_name: m.name || m.id,
      created_at: now,
      ...(m.rank ? { ccgw_rank: m.rank } : {}),
      ccgw_input: m.input?.includes('image') ? ['text','image'] : ['text'],
      ...(m.input ? { ccgw_upstream_input: m.input } : {}),
    })),
    has_more: false,
    first_id: list[0]?.id ?? null,
    last_id: list[list.length - 1]?.id ?? null,
  }
}

export function modelsOpenAI(list, now) {
  return {
    object: "list",
    data: list.map((m) => ({
      id: m.id,
      object: "model",
      created: now,
      owned_by: m.providerID || "opencode",
      ...(m.rank ? { ccgw_rank: m.rank } : {}),
      ccgw_input: m.input?.includes('image') ? ['text','image'] : ['text'],
      ...(m.input ? { ccgw_upstream_input: m.input } : {}),
    })),
  }
}

// Rough char-based estimate for /v1/messages/count_tokens.
export function countTokensApprox(canon) {
  let chars = canon.system.length
  for (const m of canon.messages) {
    chars += (m.text || "").length
    for (const tu of m.toolUses || []) chars += JSON.stringify(tu.input ?? {}).length + (tu.name || "").length
    for (const r of m.results || []) chars += (r.text || "").length
  }
  for (const t of canon.tools) chars += t.name.length + JSON.stringify(t.inputSchema || {}).length
  return Math.max(1, Math.ceil(chars / 4))
}
