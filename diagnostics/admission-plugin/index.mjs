// Observational diagnostics for an isolated location. Never mutates requests.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
const fingerprint = s => crypto.createHash('sha256').update(s).digest('hex').slice(0,16)

export async function requestSummary(request) {
  const url = new URL(request.url)
  let body = {}
  try { body = await request.clone().json() } catch {}
  const auth = {}
  for (const name of ['authorization','x-api-key']) {
    const value = request.headers.get(name)
    if (value) auth[name] = { scheme: name === 'authorization' ? value.split(' ')[0] : 'key', fingerprint: fingerprint(value), publicPlaceholder: /^(?:Bearer )?public$/.test(value) }
  }
  const identity = {}
  for (const name of ['user-agent','x-opencode-client']) {
    const value = request.headers.get(name)
    if (value) identity[name] = value
  }
  const scopes = {}
  for (const name of ['x-opencode-org-id','x-org-id','x-opencode-project','x-opencode-session-id']) {
    const value = request.headers.get(name)
    if (value) scopes[name] = fingerprint(value)
  }
  return {
    method: request.method, endpoint: url.origin + url.pathname, queryNames: [...url.searchParams.keys()],
    headerNames: [...request.headers.keys()].sort(), auth, identity, scopes,
    model: body.model, stream: body.stream,
    maxOutput: body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens,
    toolNames: (body.tools || []).map(t=>t.function?.name || t.name),
    messageRoles: (body.messages || []).map(m=>m.role),
    bodyBytes: Buffer.byteLength(JSON.stringify(body)), bodyFingerprint: fingerprint(JSON.stringify(body)),
  }
}

export default {
  id: 'ccgw-admission-observer',
  async setup(ctx) {
    const file = path.join(ctx.location.directory, 'admission-trace.jsonl')
    const record = data => fs.appendFileSync(file, JSON.stringify({at:new Date().toISOString(),...data})+'\n',{mode:0o600})
    await ctx.session.hook('http.request', async event => {
      record({phase:'request',sessionID:event.sessionID,kind:event.kind,...await requestSummary(event.request)})
    },{providerID:'opencode'})
    await ctx.session.hook('http.response', async event => {
      const trace = {}
      for(const name of ['x-opencode-log-id','x-request-id','cf-ray','retry-after','server']) {
        const value=event.response.headers.get(name)
        if(value) trace[name]=value
      }
      let errorType
      if(event.response.status >= 400) {
        try { const b=await event.response.clone().json(); errorType=b?.error?.type } catch {}
      }
      record({phase:'response',sessionID:event.sessionID,kind:event.kind,status:event.response.status,errorType,trace})
    },{providerID:'opencode'})
  },
}
