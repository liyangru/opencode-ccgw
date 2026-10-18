import {test} from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import zlib from 'node:zlib'
import {EventEmitter} from 'node:events'
import {Readable} from 'node:stream'
test('direct transport preserves native request, selects IPv6 and streams decoded response',async()=>{
  const {directFetch}=await import('./native-ipv6/direct-fetch.mjs')
  let seen
  const server=http.createServer(async(q,r)=>{
    let body='';for await(const chunk of q)body+=chunk
    seen={method:q.method,url:q.url,auth:q.headers.authorization,body}
    r.writeHead(200,{'content-type':'text/event-stream','content-encoding':'gzip'})
    r.end(zlib.gzipSync('data: DIRECT_OK\n\n'))
  })
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
  try{
    let family
    const r=await directFetch('https://opencode.ai/inference/test?x=1',{method:'POST',headers:{authorization:'Bearer fixture-only'},body:'{"model":"fixture"}'},(opts,cb)=>{
      family=opts.family;assert.equal(opts.servername,'opencode.ai')
      return http.request({...opts,hostname:'127.0.0.1',port:server.address().port,protocol:'http:',family:4},cb)
    })
    assert.equal(family,6);assert.equal(await r.text(),'data: DIRECT_OK\n\n')
    assert.deepEqual(seen,{method:'POST',url:'/inference/test?x=1',auth:'Bearer fixture-only',body:'{"model":"fixture"}'})
    assert.equal(r.headers.get('content-encoding'),null)
  }finally{await new Promise(r=>server.close(r))}
})
test('native hook intercepts only the official provider',async()=>{
  const plugin=(await import('./native-ipv6/index.mjs')).default
  const hooks={}
  await plugin.setup({session:{async hook(name,fn,scope){assert.deepEqual(scope,{providerID:'opencode'});hooks[name]=fn}}})
  const other=new Request('https://example.com/inference/test')
  const event={request:other};await hooks['http.request'](event);assert.equal(event.request,other)
  const official=new Request('https://opencode.ai/inference/test',{method:'POST',body:'{}'})
  const selected={request:official};await hooks['http.request'](selected)
  assert.ok(selected.request.url.startsWith('data:'))
})
test('abort after headers/download still rejects unread response consumption',async()=>{
  const {directFetch}=await import('./native-ipv6/direct-fetch.mjs')
  const server=http.createServer((q,r)=>r.end('PRIVATE_RESPONSE'))
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
  const ac=new AbortController()
  try{
    const r=await directFetch('https://opencode.ai/inference/test',{signal:ac.signal},(opts,cb)=>http.request({...opts,hostname:'127.0.0.1',port:server.address().port,protocol:'http:',family:4},cb))
    await new Promise(r=>setTimeout(r,30));ac.abort()
    await assert.rejects(r.text(),e=>e.name==='AbortError')
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r))}
})
test('native hook returns the real 403/429 instead of the in-process placeholder',async()=>{
  const {createNativePlugin}=await import('./native-ipv6/index.mjs')
  for(const status of [403,429]){
    const hooks={},original=new Request('https://opencode.ai/inference/test',{method:'POST',body:'original-body'})
    const plugin=createNativePlugin(async req=>{assert.equal(await req.text(),'original-body');return new Response('real-error',{status,headers:{'retry-after':'123'}})})
    await plugin.setup({session:{async hook(n,f){hooks[n]=f}}})
    const event={request:original};await hooks['http.request'](event);event.response=new Response('placeholder')
    await hooks['http.response'](event);assert.equal(event.response.status,status);assert.equal(await event.response.text(),'real-error');assert.equal(event.response.headers.get('retry-after'),'123')
  }
})
test('connection timeout ends at TLS readiness, not at the first model token',async t=>{
  const {directFetch}=await import('./native-ipv6/direct-fetch.mjs')
  t.mock.timers.enable({apis:['setTimeout']})
  let deliver,destroyed=false
  const pending=directFetch('https://opencode.ai/inference/test',{},(opts,cb)=>{
    deliver=cb
    const out=new EventEmitter();out.destroy=e=>{destroyed=true;if(e)out.emit('error',e)}
    out.end=()=>queueMicrotask(()=>{const socket=new EventEmitter();socket.connecting=true;out.emit('socket',socket);socket.emit('secureConnect')})
    return out
  })
  await new Promise(setImmediate);t.mock.timers.tick(16000);assert.equal(destroyed,false)
  const response=Readable.from([Buffer.from('late headers accepted')]);Object.assign(response,{rawHeaders:[],headers:{},statusCode:200,statusMessage:'OK'});deliver(response)
  assert.equal(await (await pending).text(),'late headers accepted')
})
test('missing IPv6 route falls back once to IPv4 before any provider request is sent',async()=>{
  const {directFetch}=await import('./native-ipv6/direct-fetch.mjs')
  const attempts=[]
  const r=await directFetch('https://opencode.ai/inference/test',{method:'POST',body:'original-provider-body'},(opts,cb)=>{
    attempts.push(opts.family)
    const out=new EventEmitter();out.destroy=()=>{};out.end=body=>queueMicrotask(()=>{
      assert.equal(body.toString(),'original-provider-body')
      if(opts.family===6){out.emit('error',Object.assign(new Error('No IPv6 route'),{code:'ENETUNREACH'}));return}
      const res=Readable.from([Buffer.from('IPV4_OK')]);Object.assign(res,{rawHeaders:[],headers:{},statusCode:200,statusMessage:'OK'});cb(res)
    });return out
  })
  assert.equal(await r.text(),'IPV4_OK');assert.deepEqual(attempts,[6,4])
})
test('real provider 403 and 429 responses never cause a family retry',async()=>{
  const {directFetch}=await import('./native-ipv6/direct-fetch.mjs')
  for(const status of [403,429]){
    const attempts=[]
    const r=await directFetch('https://opencode.ai/inference/test',{},(opts,cb)=>{
      attempts.push(opts.family);const out=new EventEmitter();out.destroy=()=>{};out.end=()=>queueMicrotask(()=>{
        const res=Readable.from([Buffer.from('upstream-denied')]);Object.assign(res,{rawHeaders:[],headers:{},statusCode:status,statusMessage:'Denied'});cb(res)
      });return out
    })
    assert.equal(r.status,status);assert.equal(await r.text(),'upstream-denied');assert.deepEqual(attempts,[6])
  }
})
