import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { runTurn } from './engine.mjs'

for (const phase of ['before','plugin','create']) test('cancel at '+phase+' never submits a native prompt',async()=>{
  const ac=new AbortController(),calls=[],dir=fs.mkdtempSync(path.join(os.tmpdir(),'cancel-test-'))
  const oc={
    async reqOrThrow(method,p){
      calls.push(p)
      if(p.startsWith('/api/plugin')) { if(phase==='plugin')ac.abort();return {data:[{id:'ccgw-output-budget-v1',state:{status:'active'}}]} }
      if(p==='/api/session'){if(phase==='create')ac.abort();return {data:{id:'ses_cancel'}}}
      if(p.endsWith('/prompt')) throw new Error('UNWANTED_PROMPT')
    },
    async req(method,p){calls.push(p);return {ok:true}},subscribe(){return ()=>{}},
  }
  if(phase==='before')ac.abort()
  try {
    await assert.rejects(runTurn(oc,{dir,model:{providerID:'opencode',id:'model'},promptText:'test',signal:ac.signal}),e=>e.name==='AbortError')
    assert.equal(calls.some(p=>p.endsWith('/prompt')),false)
    if(phase==='create')assert.ok(calls.some(p=>p.endsWith('/interrupt')))
  } finally { fs.rmSync(dir,{recursive:true,force:true}) }
})

test('cancellation during the first model catalog lookup never creates a turn',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cancel-gateway-'))
  const delay=ms=>new Promise(r=>setTimeout(r,ms))
  let modelSeen,subscribers=[],prompts=0,sessions=0
  const seen=new Promise(r=>{modelSeen=r})
  const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(s.address().port)))
  const mock=http.createServer(async(req,res)=>{
    const p=new URL(req.url,'http://localhost').pathname
    const json=b=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(b))}
    if(p==='/api/event'){res.writeHead(200,{'content-type':'text/event-stream'});res.write(': ready\n\n');subscribers.push(res);return}
    req.resume()
    if(p==='/api/model'){modelSeen();await delay(300);return json({data:[{id:'diagnostic-free',providerID:'opencode',enabled:true,cost:[{input:0,output:0}]}]})}
    if(p==='/api/plugin')return json({data:[{id:'ccgw-output-budget-v1',state:{status:'active'}}]})
    if(p==='/api/session'&&req.method==='POST'){sessions++;return json({data:{id:'ses_fixture'}})}
    if(p.endsWith('/prompt')){
      prompts++;json({});for(const sub of subscribers)sub.write('data: '+JSON.stringify({type:'session.execution.succeeded',data:{sessionID:'ses_fixture'}})+'\n\n');return
    }
    json({})
  })
  const mockPort=await listen(mock),reserve=http.createServer(),port=await listen(reserve)
  await new Promise(r=>reserve.close(r))
  const accounts=path.join(dir,'accounts.json')
  fs.writeFileSync(accounts,JSON.stringify({accounts:[{name:'fixture',url:`http://127.0.0.1:${mockPort}`}]}))
  const child=spawn(process.execPath,['server.mjs'],{cwd:import.meta.dirname,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,CCGW_PORT:String(port),CCGW_ACCOUNTS_FILE:accounts,CCGW_SCRATCH:path.join(dir,'scratch'),CCGW_LOG:path.join(dir,'test.log'),CCGW_STATE_FILE:path.join(dir,'state.json'),CCGW_KEEP_SESSIONS:'1'}})
  let output='';child.stdout.on('data',x=>{output+=x});child.stderr.on('data',x=>{output+=x})
  try {
    for(let i=0;!output.includes('[ccgw] listening');i++){if(i>100)throw new Error('startup timeout');await delay(20)}
    const ac=new AbortController()
    const request=fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'diagnostic-free',messages:[{role:'user',content:'cancel'}]}),signal:ac.signal}).catch(()=>{})
    await Promise.race([seen,delay(2000).then(()=>{throw new Error('catalog not queried')})]);ac.abort()
    await request;await delay(600)
    assert.equal(prompts,0);assert.equal(sessions,0)
  } finally {
    child.kill();if(child.exitCode===null)await new Promise(r=>child.once('exit',r))
    mock.closeAllConnections();await new Promise(r=>mock.close(r));fs.rmSync(dir,{recursive:true,force:true})
  }
})
