import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { saveCooldowns,loadCooldowns } from './cooldowns.mjs'

test('restart preserves model-scoped deadlines, expires old state, and excludes secrets',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cooldown-test-')),file=path.join(dir,'state.json')
  const account=()=>({name:'a',email:'a@example.invalid',client:{baseUrl:'http://localhost:1',auth:'secret-do-not-copy'},password:'secret-do-not-copy',rateLimits:new Map(),coolingUntil:0,fails:0})
  try {
    const a=account(); a.rateLimits.set('model-a',{until:2000,fails:2,message:'secret-do-not-copy'})
    saveCooldowns(file,[a],1000)
    assert.equal(fs.readFileSync(file,'utf8').includes('secret-do-not-copy'),false)
    const b=account();loadCooldowns(file,[b],1000)
    assert.equal(b.rateLimits.get('model-a').until,2000)
    assert.equal(b.rateLimits.has('model-b'),false)
    const c=account();loadCooldowns(file,[c],2001);assert.equal(c.rateLimits.size,0)
    const d=account();d.email='different@example.invalid';loadCooldowns(file,[d],1000);assert.equal(d.rateLimits.size,0)
  } finally { fs.rmSync(dir,{recursive:true,force:true}) }
})
