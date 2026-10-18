import {directFetch} from './direct-fetch.mjs'
import crypto from 'node:crypto'
export function createNativePlugin(transport=directFetch){return {
  id:'native-opencode-ipv6-v1',
  async setup(ctx){
    const pending=new Map()
    await ctx.session.hook('http.request',async event=>{
      const url=new URL(event.request.url)
      if(url.protocol!=='https:'||url.hostname!=='opencode.ai'||!url.pathname.startsWith('/inference/'))return
      // In-process data response avoids the runtime's IPv4-preferring fetch.
      // The response hook sends the untouched native Request over HTTPS/IPv6.
      const original=event.request,marker='data:application/octet-stream,'+crypto.randomUUID()
      const cleanup=()=>pending.delete(marker)
      pending.set(marker,{original,cleanup})
      original.signal.addEventListener('abort',cleanup,{once:true})
      event.request=new Request(marker,{signal:original.signal})
    },{providerID:'opencode'})
    await ctx.session.hook('http.response',async event=>{
      const entry=pending.get(event.request.url)
      if(!entry)return
      pending.delete(event.request.url)
      entry.original.signal.removeEventListener('abort',entry.cleanup)
      event.response=await transport(entry.original)
    },{providerID:'opencode'})
  },
}}
export default createNativePlugin()
