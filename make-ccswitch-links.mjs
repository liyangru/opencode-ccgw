// make-ccswitch-links.mjs — generate ccswitch:// deep links to import the
// ccgw provider into CC Switch (Claude Code + Codex), then print + save them.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MODEL = "deepseek-v4.1-flash-free" // rank #1 — 默认会话 + opus 槽
const MODEL_SONNET = "glm-5.3-flash-free" // rank #2 — 多模态主力(sonnet 槽)
const MODEL_HAIKU = "nemotron-3.5-lightning-free" // rank #9 — 最快(haiku 槽 + 后台任务)
const GATEWAY = "http://127.0.0.1:8317"
const NAME = "ccgw (OpenCode)"
const NOTES = "本机 OpenCode 免费模型网关 ccgw (127.0.0.1:8317)。模型槽位按排名填好:opus=#1 DeepSeek V4.1 Flash(综合)、sonnet=#2 GLM 5.3 Flash(多模态/视频/PDF)、haiku=#9 Nemotron Lightning(最快)。"

const enc = (s) => encodeURIComponent(s)
const b64 = (s) => Buffer.from(s, "utf8").toString("base64")

const claudeConfig = JSON.stringify(
  {
    env: {
      ANTHROPIC_BASE_URL: GATEWAY,
      ANTHROPIC_AUTH_TOKEN: "ccgw-local",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL_HAIKU,
      ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL_SONNET,
      ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL,
      ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: MODEL_HAIKU,
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: MODEL_SONNET,
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: MODEL,
    },
  },
  null,
  2,
)

const codexConfig = `model_provider = "custom"
model = "${MODEL}"

[model_providers.custom]
name = "ccgw"
base_url = "${GATEWAY}/v1"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "ccgw-local"
`

const claudeUrl =
  "ccswitch://v1/import?" +
  [
    "resource=provider",
    "app=claude",
    "name=" + enc(NAME),
    "endpoint=" + enc(GATEWAY),
    "apiKey=ccgw-local",
    "model=" + enc(MODEL),
    "haikuModel=" + enc(MODEL_HAIKU),
    "sonnetModel=" + enc(MODEL_SONNET),
    "opusModel=" + enc(MODEL),
    "homepage=" + enc(GATEWAY + "/health"),
    "notes=" + enc(NOTES),
    "config=" + enc(b64(claudeConfig)),
    "configFormat=json",
    "enabled=true",
  ].join("&")

const codexUrl =
  "ccswitch://v1/import?" +
  [
    "resource=provider",
    "app=codex",
    "name=" + enc(NAME),
    "endpoint=" + enc(GATEWAY + "/v1"),
    "apiKey=ccgw-local",
    "model=" + enc(MODEL),
    "homepage=" + enc(GATEWAY + "/health"),
    "notes=" + enc(NOTES),
    "config=" + enc(b64(codexConfig)),
    "configFormat=toml",
  ].join("&")

fs.writeFileSync(path.join(__dirname, "ccswitch-links.txt"), "claude=" + claudeUrl + "\ncodex=" + codexUrl + "\n")
console.log("claude=" + claudeUrl)
console.log("")
console.log("codex=" + codexUrl)
console.log("")
console.log("claude config preview:\n" + claudeConfig)
console.log("codex config preview:\n" + codexConfig)
