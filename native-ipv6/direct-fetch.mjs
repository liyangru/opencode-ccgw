import https from 'node:https'
import {Readable} from 'node:stream'
import zlib from 'node:zlib'

// No local proxy: retain the original URL, TLS hostname and request identity.
// Scoped caller selects only official inference requests, never other providers.
export async function directFetch(input,init,request=https.request){
  const original=new Request(input,init)
  try{return await fetchFamily(original.clone(),request,6)}
  catch(error){
    original.signal.throwIfAborted()
    // Only DNS/TCP/TLS-connect failures can switch families. Provider responses
    // (including 403/429) and failures after sending a request are never replayed.
    if(!['ENOENT','ENOTFOUND','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH','ECONNREFUSED','CCGW_CONNECT_TIMEOUT'].includes(error?.code))throw error
    return await fetchFamily(original,request,4)
  }
}
async function fetchFamily(input,request,family){
  const req=new Request(input),url=new URL(req.url)
  if(url.protocol!=='https:'||url.hostname!=='opencode.ai'||url.port)throw Error('Native IPv6 transport is restricted to official OpenCode HTTPS')
  req.signal.throwIfAborted()
  const body=req.body?Buffer.from(await req.arrayBuffer()):undefined
  const headers=Object.fromEntries(req.headers)
  return await new Promise((resolve,reject)=>{
    let response,stream,bodyController,reader,settled=false,out
    let connectTimer
    const fail=e=>{if(!settled){settled=true;reject(e)}}
    const cleanup=()=>req.signal.removeEventListener('abort',abort)
    const abort=()=>{const e=req.signal.reason||new DOMException('Aborted','AbortError');out?.destroy(e);stream?.destroy(e);try{bodyController?.error(e)}catch{}reader?.cancel(e).catch(()=>{});cleanup();fail(e)}
    out=request({protocol:'https:',hostname:url.hostname,servername:url.hostname,port:443,family,method:req.method,path:url.pathname+url.search,headers},res=>{
      response=res
      clearTimeout(connectTimer)
      const resultHeaders=new Headers()
      for(let i=0;i<res.rawHeaders.length;i+=2)resultHeaders.append(res.rawHeaders[i],res.rawHeaders[i+1])
      stream=res
      const encoding=res.headers['content-encoding']?.toLowerCase()
      const decoder=encoding==='gzip'?zlib.createGunzip():encoding==='br'?zlib.createBrotliDecompress():encoding==='deflate'?zlib.createInflate():null
      if(decoder){res.on('error',e=>decoder.destroy(e));decoder.once('close',()=>res.destroy());stream=res.pipe(decoder);resultHeaders.delete('content-encoding');resultHeaders.delete('content-length')}
      reader=Readable.toWeb(stream).getReader()
      const webBody=new ReadableStream({
        start(controller){bodyController=controller},
        async pull(controller){
          try{req.signal.throwIfAborted();const {done,value}=await reader.read();if(done){cleanup();controller.close()}else controller.enqueue(value)}
          catch(e){cleanup();controller.error(e);reader.cancel(e).catch(()=>{})}
        },
        cancel(reason){cleanup();out.destroy();stream.destroy();return reader.cancel(reason)},
      },{highWaterMark:0})
      try{
        const empty=[204,205,304].includes(res.statusCode)||req.method==='HEAD'
        if(empty){cleanup();reader.cancel().catch(()=>{})}
        const result=new Response(empty?null:webBody,{status:res.statusCode,statusText:res.statusMessage,headers:resultHeaders})
        Object.defineProperty(result,'url',{value:req.url})
        settled=true;resolve(result)
      }catch(e){out.destroy();fail(e)}
    })
    connectTimer=setTimeout(()=>out.destroy(Object.assign(new Error('OpenCode connection timed out'),{code:'CCGW_CONNECT_TIMEOUT'})),15000)
    out.once('error',e=>{clearTimeout(connectTimer);fail(e)})
    out.once('socket',socket=>{
      if(!socket.connecting&&socket.encrypted)clearTimeout(connectTimer)
      else socket.once('secureConnect',()=>clearTimeout(connectTimer))
    })
    req.signal.addEventListener('abort',abort,{once:true})
    out.once('close',()=>{clearTimeout(connectTimer);if(!response)req.signal.removeEventListener('abort',abort)})
    if(req.signal.aborted){abort();return}
    out.end(body)
  })
}
