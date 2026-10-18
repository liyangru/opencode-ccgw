// Persist only local cooldown deadlines; no credentials, prompts or provider bodies.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const scope = a => crypto.createHash('sha256').update(JSON.stringify([a.name,a.email || '',a.client.baseUrl])).digest('hex')
export function saveCooldowns(file, accounts, now = Date.now()) {
  const data = accounts.map(a => ({
    scope: scope(a), networkUntil: a.coolingUntil > now ? a.coolingUntil : 0,
    fails: a.fails,
    models: [...a.rateLimits].filter(([,r])=>r.until>now).map(([id,r])=>({id,until:r.until,fails:r.fails})),
  }))
  fs.mkdirSync(path.dirname(file),{recursive:true})
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp,JSON.stringify({version:1,accounts:data})+'\n',{mode:0o600})
  fs.renameSync(tmp,file)
}
export function loadCooldowns(file, accounts, now = Date.now()) {
  if (!fs.existsSync(file)) return
  const data = JSON.parse(fs.readFileSync(file,'utf8'))
  if (data.version !== 1 || !Array.isArray(data.accounts)) throw new Error('Invalid cooldown state format')
  const valid = n => Number.isSafeInteger(n) && n > now
  const fails = n => Number.isSafeInteger(n) && n > 0 ? Math.min(n,100) : 0
  for (const a of accounts) {
    const saved = data.accounts.find(s=>s.scope===scope(a))
    if (!saved) continue
    a.coolingUntil = valid(saved.networkUntil) ? saved.networkUntil : 0
    a.fails = fails(saved.fails)
    for (const r of saved.models || []) {
      if (typeof r.id==='string' && valid(r.until)) a.rateLimits.set(r.id,{until:r.until,fails:fails(r.fails),message:'限流冷却已从上次运行恢复'})
    }
    if (a.coolingUntil || a.rateLimits.size) a.lastError = '上次运行留有冷却记录；有效期限见冷却状态'
  }
}
