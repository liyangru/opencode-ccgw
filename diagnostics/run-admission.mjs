// Run: node diagnostics/run-admission.mjs [desktop|acct1] [readonly|approval]
// One official native inference, no VPN/account/provider changes, no tool execution.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {OpenCode,discoverService,installGatewayPlugin,ensureGatewayPlugin,sleep,READ_ONLY_PERMISSIONS} from '../engine.mjs'
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const target=process.argv[2]||'desktop',permissionMode=process.argv[3]||'readonly'
let service
if(target==='desktop')service=discoverService()
else {
  const zw=path.join(root,'zero-window'),a=JSON.parse(fs.readFileSync(path.join(zw,'accounts.json'),'utf8')).accounts.find(a=>a.name===target)
  if(!a)throw new Error('Unknown diagnostic target')
  service={baseUrl:a.url,password:JSON.parse(fs.readFileSync(path.resolve(zw,a.serviceFile),'utf8')).password}
}
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ccgw-admission-'))
installGatewayPlugin(dir)
const plugin=path.join(dir,'.opencode','plugins','admission-observer','index.mjs')
fs.mkdirSync(path.dirname(plugin),{recursive:true});fs.copyFileSync(path.join(root,'diagnostics','admission-plugin','index.mjs'),plugin)
const oc=new OpenCode(service)
let sid,unsub,timer
try {
  await ensureGatewayPlugin(oc,dir)
  const plugins=await oc.reqOrThrow('GET','/api/plugin?'+new URLSearchParams({'location[directory]':dir}))
  if(!plugins.data.some(p=>p.id==='ccgw-admission-observer'&&p.state.status==='active'))throw new Error('Observer not active')
  const integration=await oc.req('GET','/api/integration/opencode')
  // Only status shape and connection type, never raw integration credentials.
  const integrationData=integration.json?.data||integration.json
  console.log(JSON.stringify({target,permissionMode,diagnosticDirectory:dir,integrationStatus:integration.status,integrationFields:Object.keys(integrationData||{})}))
  oc.startEventStream()
  for(let i=0;!oc.connected&&i<100;i++)await sleep(50)
  if(!oc.connected)throw new Error('Native event stream disconnected')
  const session=await oc.reqOrThrow('POST','/api/session',{
    title:'只读准入诊断 '+target+' '+permissionMode,agent:'build',location:{directory:dir},
    model:{providerID:'opencode',id:'glm-5.3-flash-free'},
    permissions:permissionMode==='approval'?[{action:'*',resource:'*',effect:'ask'}]:READ_ONLY_PERMISSIONS,
    metadata:{ccgw:{managed:true,maxOutputTokens:128}},
  })
  sid=session.data.id
  let settle;const done=new Promise(r=>{settle=r});let text=''
  unsub=oc.subscribe(ev=>{
    if(ev.data?.sessionID!==sid)return
    if(ev.type==='session.text.delta')text+=ev.data.delta||''
    if(ev.type==='session.execution.succeeded')settle({outcome:'success',reply:text})
    if(ev.type==='session.execution.failed'||(/retry/.test(ev.type)&&ev.data.error)){const e=ev.data.error;settle({outcome:'error',status:e?.status,type:e?.type,message:e?.message})}
    if(/permission/.test(ev.type)||ev.type==='session.tool.input.started')settle({outcome:'tool-proposed-stopped'})
  })
  timer=setTimeout(()=>settle({outcome:'timeout'}),30000)
  await oc.reqOrThrow('POST',`/api/session/${sid}/prompt`,{text:'Read-only connectivity diagnosis. Do not call tools, read files or run commands. Reply exactly ADMISSION_OK.'})
  console.log(JSON.stringify({sessionID:sid,...await done}))
}finally{
  clearTimeout(timer);unsub?.();if(sid)await oc.req('POST',`/api/session/${sid}/interrupt`,{}).catch(()=>{})
  oc.stopEventStream()
  const file=path.join(dir,'admission-trace.jsonl')
  if(fs.existsSync(file))console.log(fs.readFileSync(file,'utf8'))
}
