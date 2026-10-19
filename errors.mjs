// Provider admission, authentication and rate limits are different failures.
// In particular, a FreeTierError must never trigger quota/account rotation.
const RATE_LIMIT = /\b429\b|too many requests|rate[ -]?limit|quota (?:exceeded|exhausted)|usage (?:limit exceeded|exceeded)|free (?:tier|usage) (?:limit )?(?:exceeded|exhausted)|limit (?:reached|exceeded)|hit your limit/i
const NETWORK = /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|EHOSTUNREACH|ECONNABORTED|networkerror/i
// The upstream reports "Response still truncated after two output token limit
// continuations" when the model burned the whole output budget on reasoning.
// That is a request-parameter problem (max_tokens too small), not a model or
// account failure: it must not rotate accounts or walk the fallback chain.
const OUTPUT_LIMIT = /still truncated|output token limit/i
// A per-model geo restriction ("This model is not available in your country")
// says nothing about the caller's credentials: the same key runs every other
// model, and this one from other networks. It is a model-level refusal, so it
// must walk the ranked fallback chain like "Endpoint is unavailable". It is
// NOT the terminal admission gate - the network-level gates (free tier app
// check, abusive-traffic IP block) stay access_denied and keep feeding the
// egress rotator.
const GEO_BLOCKED = /not available in your (?:country|region)|not (?:supported|allowed|offered) in your (?:country|region)|(?:geo|region)[- ]?(?:restricted|blocked)/i

// The gateway talks to its own OpenCode service for everything that is not the
// model call itself: plugin readiness, session create, prompt, model list.
// Those control-plane calls failing or timing out (engine.mjs: "OpenCode GET
// /api/... timed out after Nms"; reqOrThrow: "GET /api/... -> 500 ...") and the
// plugin readiness guard say nothing about the model: that account/exit is
// unhealthy for this attempt, so cool it briefly and fail over to the other
// account instead of walking the ranked model chain (which used to burn models
// and add 30+ seconds to the request).
const CONTROL_PLANE = /^OpenCode (?:GET|POST|PUT|PATCH|DELETE) \S+ timed out after \d+ms|^(?:GET|POST|PUT|PATCH|DELETE) \S+ -> 5\d\d\b|gateway session plugin is not active/i

function retryAfter(error) {
  if (Number.isFinite(error?.retryAfterMs) && error.retryAfterMs > 0) return error.retryAfterMs / 1000
  if (Number.isFinite(error?.retryAfterSeconds) && error.retryAfterSeconds > 0) return error.retryAfterSeconds
  const headers = error?.response?.headers
  const raw = typeof headers?.get === "function" ? headers.get("retry-after")
    : Object.entries(headers || {}).find(([k]) => k.toLowerCase() === "retry-after")?.[1]
  if (raw === undefined || raw === null || String(raw).trim() === "") return undefined
  const seconds = /^\d+(?:\.\d+)?$/.test(String(raw).trim()) ? Number(raw) : (Date.parse(String(raw)) - Date.now()) / 1000
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
}

export function classifyError(error) {
  const message = String(error?.message || error || "turn failed")
  let body = error?.response?.body
  if (typeof body === "string") {
    try { body = JSON.parse(body) } catch { body = null }
  }
  const providerType = String(body?.error?.type || error?.type || "")
  const rawStatus = Number(error?.status ?? error?.statusCode ?? error?.response?.status)
  const explicitStatus = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : null
  const freeTier = /FreeTierError/i.test(providerType) || /free tier can only be used from within OpenCode/i.test(message)
  const outputLimit = OUTPUT_LIMIT.test(message)
  const controlPlane = CONTROL_PLANE.test(message)
  const status = outputLimit ? 400 : explicitStatus ?? (freeTier ? 403 : RATE_LIMIT.test(message) ? 429 : 502)
  const geoBlocked = status === 403 && GEO_BLOCKED.test(message)
  const kind = outputLimit ? "request" : status === 401 ? "authentication" : geoBlocked ? "upstream" : status === 403 ? "access_denied" : status === 429 ? "rate_limit" : NETWORK.test(message) || controlPlane ? "network" : "upstream"
  const code = outputLimit ? "output_limit" : geoBlocked ? "model_geo_blocked" : freeTier && status === 403 ? "free_tier_access_denied" : kind === "authentication" ? "authentication_error" : kind === "access_denied" ? "access_denied" : kind === "rate_limit" ? "rate_limit_exceeded" : controlPlane ? "control_plane_error" : "upstream_error"
  const type = outputLimit ? "invalid_request_error" : kind === "authentication" ? "authentication_error" : kind === "access_denied" ? "permission_error" : kind === "rate_limit" ? "rate_limit_error" : "api_error"
  return { message, status, kind, code, type, retryAfterSeconds: retryAfter(error) }
}
