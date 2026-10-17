// Provider admission, authentication and rate limits are different failures.
// In particular, a FreeTierError must never trigger quota/account rotation.
const RATE_LIMIT = /\b429\b|too many requests|rate[ -]?limit|quota (?:exceeded|exhausted)|usage (?:limit exceeded|exceeded)|free (?:tier|usage) (?:limit )?(?:exceeded|exhausted)|limit (?:reached|exceeded)|hit your limit/i
const NETWORK = /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|EHOSTUNREACH|ECONNABORTED|networkerror/i

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
  const status = explicitStatus ?? (freeTier ? 403 : RATE_LIMIT.test(message) ? 429 : 502)
  const kind = status === 401 ? "authentication" : status === 403 ? "access_denied" : status === 429 ? "rate_limit" : NETWORK.test(message) ? "network" : "upstream"
  const code = freeTier && status === 403 ? "free_tier_access_denied" : kind === "authentication" ? "authentication_error" : kind === "access_denied" ? "access_denied" : kind === "rate_limit" ? "rate_limit_exceeded" : "upstream_error"
  const type = kind === "authentication" ? "authentication_error" : kind === "access_denied" ? "permission_error" : kind === "rate_limit" ? "rate_limit_error" : "api_error"
  return { message, status, kind, code, type, retryAfterSeconds: retryAfter(error) }
}
