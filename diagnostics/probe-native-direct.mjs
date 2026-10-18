// One-process, no-VPN transport test. CONNECT preserves end-to-end TLS and
// genuine OpenCode requests; it only selects the local ISP address family.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {OpenCode,installGatewayPlugin,ensureGatewayPlugin,sleep,READ_ONLY_PERMISSIONS} from '../engine.mjs'
const family=Number(process.argv[2]||4)
const anonymous=process.argv.includes('--anonymous')
const readonly=process.argv.includes('--readonly')
if(![4,6].includes(family))throw new Error('Address family must be 4 or 6')
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'opencode-family-'+family+'-'))
installGatewayPlugin(dir)
const plugin=path.join(dir,'.opencode/plugins/admission-observer/index.mjs')
fs.mkdirSync(path.dirname(plugin),{recursive:true});fs.copyFileSync(path.join(root,'diagnostics/admission-plugin/index.mjs'),plugin)
const sockets=new Set(),connections=[]
const proxy=http.createServer((req,res)=>res.writeHead(405).end())
proxy.on('connect',(req,client,head)=>{
  if(req.url!=='opencode.ai:443'){client.end('HTTP/1.1 403 Forbidden\r\n\r\n');return}
  const upstream=net.connect({host:'opencode.ai',port:443,family},()=>{
    connections.push({family:upstream.remoteFamily,addressFingerprint:crypto.createHash('sha256').update(upstream.remoteAddress).digest('hex').slice(0,12)})
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head)
    client.pipe(upstream);upstream.pipe(client)
  })
  for(const socket of [client,upstream]){sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{client.destroy();upstream.destroy()})}
  client.on('close',()=>upstream.destroy());upstream.on('close',()=>client.destroy())
})
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(s.address().port)))
const proxyPort=await listen(proxy),reservation=http.createServer(),port=await listen(reservation)
await new Promise(r=>reservation.close(r))
const env={...process.env,OPENCODE_SERVER_PASSWORD:crypto.randomBytes(20).toString('hex')}
if(anonymous){
  const home=path.join(dir,'anonymous-profile');fs.mkdirSync(home)
  Object.assign(env,{HOME:home,USERPROFILE:home,APPDATA:path.join(home,'AppData/Roaming'),LOCALAPPDATA:path.join(home,'AppData/Local'),XDG_CONFIG_HOME:path.join(home,'.config'),XDG_DATA_HOME:path.join(home,'.local/share'),XDG_CACHE_HOME:path.join(home,'.cache'),XDG_STATE_HOME:path.join(home,'.local/state')})
  for(const key of Object.keys(env))if(/API_KEY|TOKEN|SECRET|OPENCODE_CONFIG/i.test(key))delete env[key]
}
for(const key of Object.keys(env))if(/^(https?|all|no)_proxy$/i.test(key))delete env[key]
// No proxy: native DNS ordering probe
const pluginDir=path.join(dir,'.opencode/plugins/native-ipv6');fs.mkdirSync(pluginDir,{recursive:true});for(const f of ['index.mjs','direct-fetch.mjs'])fs.copyFileSync(path.join(root,'native-ipv6',f),path.join(pluginDir,f));
const cli=path.join(process.env.APPDATA,'ai.opencode.desktop/cli/2.0.32-x64/opencode-cli.exe')
const child=spawn(cli,['serve','--hostname','127.0.0.1','--port',String(port)],{cwd:dir,env,windowsHide:true,stdio:['ignore','pipe','pipe']})
let startup='';child.stdout.on('data',x=>{startup=(startup+x).slice(-3000)});child.stderr.on('data',x=>{startup=(startup+x).slice(-3000)})
const oc=new OpenCode({baseUrl:`http://127.0.0.1:${port}`,password:env.OPENCODE_SERVER_PASSWORD})
let sessionID,unsub,timer
try{
  let ready=false
  for(let i=0;i<150;i++){if(child.exitCode!==null)throw new Error('Diagnostic native process exited');try{if((await oc.req('GET','/api/info')).ok){ready=true;break}}catch{}await sleep(100)}
  if(!ready)throw new Error('Diagnostic native process did not become ready')
  await ensureGatewayPlugin(oc,dir);oc.startEventStream();for(let i=0;!oc.connected&&i<100;i++)await sleep(50)
  const session=await oc.reqOrThrow('POST','/api/session',{title:'地址族诊断 IPv'+family,agent:'build',location:{directory:dir},model:{providerID:'opencode',id:'glm-5.3-flash-free'},permissions:readonly?READ_ONLY_PERMISSIONS:[{action:'*',resource:'*',effect:'ask'}],metadata:{ccgw:{managed:true,maxOutputTokens:128}}})
  sessionID=session.data.id
  let settle;const done=new Promise(r=>{settle=r});let text=''
  unsub=oc.subscribe(ev=>{if(ev.data?.sessionID!==sessionID)return;if(ev.type==='session.text.delta')text+=ev.data.delta||'';if(ev.type==='session.execution.succeeded')settle({reply:text});if(ev.type==='session.execution.failed')settle({error:{status:ev.data.error?.status,type:ev.data.error?.type,message:ev.data.error?.message}});if(/permission/.test(ev.type)||ev.type==='session.tool.input.started')settle({error:{type:'tool-proposed-stopped'}})})
  timer=setTimeout(()=>settle({error:{type:'timeout'}}),25000)
  await oc.reqOrThrow('POST',`/api/session/${sessionID}/prompt`,{text:'Read-only connectivity diagnosis. Do not call tools, read files or run commands. Reply exactly ADMISSION_OK.'})
  console.log(JSON.stringify({family,anonymous,readonly,directory:dir,sessionID,...await done,connections}))
  const file=path.join(dir,'admission-trace.jsonl');if(fs.existsSync(file))console.log(fs.readFileSync(file,'utf8'))
}finally{
  clearTimeout(timer);unsub?.();if(sessionID)await oc.req('POST',`/api/session/${sessionID}/interrupt`,{}).catch(()=>{})
  oc.stopEventStream();child.kill();if(child.exitCode===null)await new Promise(r=>child.once('exit',r))
  for(const socket of sockets)socket.destroy();await new Promise(r=>proxy.close(r))
}
