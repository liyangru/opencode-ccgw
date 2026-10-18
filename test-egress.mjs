import {test} from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const api=await import('./egress.mjs').catch(()=>({}))
const listen=(s,host='127.0.0.1')=>new Promise(r=>s.listen(0,host,()=>r(s.address().port)))
const pause=ms=>new Promise(r=>setTimeout(r,ms))
async function fixture(run,connectOverride){
  assert.equal(typeof api.attachEgress,'function','IPv6 egress support must exist')
  const peer=net.createServer(s=>s.pipe(s)),peerPort=await listen(peer,'::1'),attempts=[]
  const server=http.createServer((q,r)=>r.writeHead(404).end())
  const relay=api.attachEgress(server,{key:'fixture-only',family:6,connect:opts=>{attempts.push(opts.family);return connectOverride?connectOverride(opts,attempts,peerPort):net.connect({host:'::1',port:peerPort})}})
  const port=await listen(server)
  const connect=(authority='opencode.ai:443',authorized=true)=>new Promise((resolve,reject)=>{
    const socket=net.connect({host:'127.0.0.1',port},()=>socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authorized?'Proxy-Authorization: Basic '+Buffer.from('ccgw:fixture-only').toString('base64')+'\r\n':''}\r\n`))
    let data='';socket.on('error',reject);socket.on('data',x=>{data+=x.toString();if(data.includes('\r\n\r\n'))resolve({socket,data})})
  })
  try{await run({connect,attempts,relay})}finally{relay.close();server.closeAllConnections();await new Promise(r=>server.close(r));await new Promise(r=>peer.close(r))}
}
test('egress uses IPv6 and forwards opaque TLS bytes without changing them',async()=>{
  await fixture(async({connect,attempts,relay})=>{
    const {socket,data}=await connect();assert.match(data,/200 Connection Established/)
    const echoed=new Promise((resolve,reject)=>{socket.once('data',x=>resolve(x.toString()));socket.once('error',reject)})
    socket.write('OPAQUE_TLS_BYTES');assert.equal(await echoed,'OPAQUE_TLS_BYTES');socket.destroy();await pause(20)
    assert.deepEqual(attempts,[6]);assert.equal(relay.state().active,0)
  })
})
test('egress rejects missing credentials and targets outside OpenCode before connecting',async()=>{
  await fixture(async({connect,attempts})=>{
    const a=await connect('opencode.ai:443',false);assert.match(a.data,/407/);a.socket.destroy()
    for(const target of ['evil.invalid:443','opencode.ai:80','127.0.0.1:443','opencode.ai.evil.invalid:443']){const r=await connect(target);assert.match(r.data,/403/);r.socket.destroy()}
    assert.deepEqual(attempts,[])
  })
})
test('initial IPv6 connection failure falls back once before any encrypted request is sent',async()=>{
  await fixture(async({connect,attempts})=>{
    const r=await connect();assert.match(r.data,/200/);assert.deepEqual(attempts,[6,4]);r.socket.destroy()
  },(opts,attempts,port)=>{if(attempts.length===1){const s=new net.Socket();queueMicrotask(()=>s.destroy(new Error('no ipv6 route')));return s}return net.connect({host:'::1',port})})
})
test('private egress key is loaded via private helper and stays out of source configuration',()=>{
  assert.equal(typeof api.readEgressKey,'function')
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'egress-private-test-'))
  try{
    fs.writeFileSync(path.join(dir,'env.js'),"exports.readPrivateText=f=>require('fs').readFileSync(f,'utf8')")
    fs.writeFileSync(path.join(dir,'.env'),'GATEWAY_KEY="fixture-private-key"\n')
    assert.equal(api.readEgressKey(dir),'fixture-private-key')
    const env=api.egressEnvironment({OPENCODE_API_KEY:'original-provider-key',HOME:'original-profile'},'http://127.0.0.1:8317','fixture-private-key')
    assert.equal(env.OPENCODE_API_KEY,'original-provider-key');assert.equal(env.HOME,'original-profile')
    assert.equal(new URL(env.HTTPS_PROXY).password,'fixture-private-key');assert.match(env.NO_PROXY,/127\.0\.0\.1/)
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
})
