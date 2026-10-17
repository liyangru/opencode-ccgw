#!/usr/bin/env node
// ccgw stdio MCP tool bridge.
//
// Usage: node bridge.mjs <manifestPath>
//
// The manifest is a JSON file: { "tools": [ { "name", "description", "inputSchema" } ] }.
// This server exposes exactly those tools to OpenCode. Any tools/call is *held*
// forever (no response) so the ccgw gateway can capture the call from OpenCode's
// event stream, hand it to the downstream client (Claude Code / Codex / ...),
// and abort the OpenCode turn while the client executes the tool itself.
import fs from "node:fs"

const manifestPath = process.argv[2]
let manifest = { tools: [] }
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  if (!Array.isArray(manifest.tools)) manifest.tools = []
} catch (e) {
  console.error("ccgw-bridge: failed to read manifest: " + e.message)
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n")
}

function handle(msg) {
  const { id, method, params } = msg
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "ccgw-bridge", version: "1.0.0" },
      },
    })
  } else if (method === "notifications/initialized" || method === "notifications/cancelled" || method === "notifications/roots/list_changed") {
    // notifications carry no response
  } else if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} })
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: manifest.tools } })
  } else if (method === "resources/list") {
    send({ jsonrpc: "2.0", id, result: { resources: [] } })
  } else if (method === "prompts/list") {
    send({ jsonrpc: "2.0", id, result: { prompts: [] } })
  } else if (method === "tools/call") {
    // Held forever by design. The gateway captures this call via events and
    // interrupts the session; the client executes the real tool.
    console.error("ccgw-bridge: holding tool call '" + (params?.name || "?") + "' (client will execute it)")
  } else if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } })
  }
}

let buf = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (d) => {
  buf += d
  let i
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    try {
      handle(JSON.parse(line))
    } catch (e) {
      console.error("ccgw-bridge: bad json line: " + e.message)
    }
  }
})
process.stdin.on("end", () => process.exit(0))
process.on("SIGTERM", () => process.exit(0))
process.on("SIGINT", () => process.exit(0))
