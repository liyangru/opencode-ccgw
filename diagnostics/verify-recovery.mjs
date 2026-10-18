import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {OpenCode,discoverService,installGatewayPlugin,runTurn,sleep} from '../engine.mjs'
const post=async body=>{
  const r=await fetch('http://127.0.0.1:8787/v1/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(90000)})
  const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data
}
const base={model:'glm-5.3-flash-free',max_tokens:512,tools:[{name:'probe_sum',description:'Return a plus b.',input_schema:{type:'object',properties:{a:{type:'number'},b:{type:'number'}},required:['a','b']}}]}
const messages=[{role:'user',content:'Call probe_sum with a=20 and b=22. After receiving the result, reply only with that number.'}]
const first=await post({...base,messages,tool_choice:{type:'tool',name:'probe_sum'}})
const call=first.content.find(x=>x.type==='tool_use'&&x.name==='probe_sum');assert.ok(call,'External tool call required');assert.deepEqual(call.input,{a:20,b:22})
const second=await post({...base,messages:[...messages,{role:'assistant',content:first.content},{role:'user',content:[{type:'tool_result',tool_use_id:call.id,content:'42'}]}]})
const answer=second.content.filter(x=>x.type==='text').map(x=>x.text).join('');assert.match(answer,/42/)
console.log(JSON.stringify({check:'external-tool-roundtrip',result:'passed',tool:call.name,answer}))
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ccgw-desktop-recovery-'));installGatewayPlugin(dir)
const oc=new OpenCode(discoverService());oc.startEventStream()
try{
  for(let i=0;!oc.connected&&i<100;i++)await sleep(100)
  assert.ok(oc.connected,'Desktop event stream required')
  const result=await runTurn(oc,{dir,model:{providerID:'ccgw',id:'deepseek-v4.1-flash-free'},promptText:'Do not call tools. Reply exactly OPENCODE_RECOVERED.',maxOutputTokens:2048,timeoutMs:90000})
  console.log(JSON.stringify({check:'official-desktop-service-to-ccgw',result}))
}finally{oc.stopEventStream()}
