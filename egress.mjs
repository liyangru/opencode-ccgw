// Loopback-only authenticated CONNECT for native OpenCode. TLS and application
// requests remain end-to-end; only the initial TCP address family is selected.
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)

export function readEgressKey(directory) {
  if(!directory)throw new Error('Private egress key directory is required')
  const {readPrivateText}=require(path.resolve(directory,'env.js'))
  const line=readPrivateText(path.resolve(directory,'.env')).split(/\r?\n/).find(l=>/^\s*GATEWAY_KEY\s*=/.test(l))
  let key=line?.slice(line.indexOf('=')+1).trim()
  if(key && ((key.startsWith('"')&&key.endsWith('"'))||(key.startsWith("'")&&key.endsWith("'"))))key=key.slice(1,-1)
  if(!key)throw new Error('Private gateway key is missing')
  return key
}

export function egressEnvironment(original,endpoint,key) {
  const url=new URL(endpoint)
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.pathname!=='/'||url.search||url.hash)throw new Error('Egress endpoint must be an explicit loopback HTTP port')
  url.username='ccgw';url.password=key
  return {...original,HTTPS_PROXY:url.href,https_proxy:url.href,NO_PROXY:'localhost,127.0.0.1,::1',no_proxy:'localhost,127.0.0.1,::1'}
}

export function attachEgress(server,{key,family=6,connect=net.connect,connectTimeoutMs=10000}={}) {
  if(!key||![4,6].includes(family))throw new Error('Egress needs a key and a valid address family')
  const expected=Buffer.from('Basic '+Buffer.from('ccgw:'+key).toString('base64'))
  const sockets=new Set(),stats={preferredFamily:family,active:0,connections:0,failures:0,fallbacks:0,lastFamily:null}
  const handler=(req,client,head)=>{
    const local=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(client.remoteAddress)
    const forwarded=['forwarded','x-forwarded-for','cf-connecting-ip','x-real-ip'].some(h=>h in req.headers)
    const auth=Buffer.from(String(req.headers['proxy-authorization']||''))
    if(!local||forwarded||auth.length!==expected.length||!crypto.timingSafeEqual(auth,expected)){client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="ccgw-egress"\r\nConnection: close\r\n\r\n');return}
    if(req.url.toLowerCase()!=='opencode.ai:443'){client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return}
    let upstream,established=false,closed=false,counted=false,fellBack=false
    sockets.add(client)
    client.on('error',()=>client.destroy())
    client.once('close',()=>{closed=true;sockets.delete(client);upstream?.destroy();if(counted){stats.active--;counted=false}})
    const dial=addressFamily=>{
      if(closed)return
      const socket=connect({host:'opencode.ai',port:443,family:addressFamily});upstream=socket;sockets.add(socket)
      const timer=setTimeout(()=>socket.destroy(new Error('Egress TCP connect timeout')),connectTimeoutMs)
      socket.once('connect',()=>{
        clearTimeout(timer)
        if(closed){socket.destroy();return}
        established=true;counted=true;stats.active++;stats.connections++;stats.lastFamily=socket.remoteFamily
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if(head.length)socket.write(head)
        client.pipe(socket);socket.pipe(client)
      })
      socket.once('error',()=>{
        clearTimeout(timer);stats.failures++
        if(upstream!==socket||closed)return
        if(!established&&addressFamily===6&&!fellBack){fellBack=true;stats.fallbacks++;dial(4);return}
        if(established)client.destroy()
        else client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
      })
      socket.once('close',()=>{clearTimeout(timer);sockets.delete(socket);if(upstream===socket&&established)client.destroy()})
    }
    dial(family)
  }
  server.on('connect',handler)
  return {state:()=>({...stats}),close(){server.removeListener('connect',handler);for(const s of sockets)s.destroy()}}
}
