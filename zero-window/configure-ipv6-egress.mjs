// Machine-local configuration only; encrypted backups, never print credentials.
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createRequire} from 'node:module'
import {readEgressKey} from '../egress.mjs'
const require=createRequire(import.meta.url),zw=path.dirname(fileURLToPath(import.meta.url))
const keyDir=process.argv[2]
readEgressKey(keyDir) // fail before making changes if the private configuration is unavailable
const {protectPrivateText}=require(path.resolve(keyDir,'env.js'))
const cfg=JSON.parse(fs.readFileSync(path.join(zw,'accounts.json'),'utf8'))
const quote=s=>'"'+s.replaceAll('"','""')+'"'
const wrapper=path.join(zw,'launch-with-egress.mjs')
function update(file,gateway=false,profile){
  const bytes=fs.readFileSync(file),encoding=bytes[0]===255&&bytes[1]===254?'utf16le':'utf8'
  let text=bytes.toString(encoding).replace(/^\uFEFF/,'')
  const backup=file+'.egress-original.dpapi'
  if(!fs.existsSync(backup))fs.writeFileSync(backup,protectPrivateText(JSON.stringify({encoding,base64:bytes.toString('base64')})),{mode:0o600})
  text=text.split(/\r?\n/).filter(l=>!/^\s*(?:sh\.Environment\("PROCESS"\)|env)\("(?:CCGW_EGRESS_(?:URL|KEY_DIR|FAMILY)|CCGW_PROFILE_HOME)"\)\s*=/.test(l)).join('\r\n')
  const match=/rc\s*=\s*sh\.Run\("((?:""|[^"])*)",\s*0,\s*True\)/i.exec(text)
  if(!match)throw new Error('Unrecognized launcher format: '+path.basename(file))
  let command=match[1].replaceAll('""','"')
  if(!gateway&&!command.includes(wrapper))command='"'+process.execPath+'" "'+wrapper+'" '+command
  const lines=[`sh.Environment("PROCESS")("CCGW_EGRESS_KEY_DIR") = ${quote(path.resolve(keyDir))}`]
  lines.push(gateway?'sh.Environment("PROCESS")("CCGW_EGRESS_FAMILY") = "6"':'sh.Environment("PROCESS")("CCGW_EGRESS_URL") = "http://127.0.0.1:8317"')
  if(profile)lines.push(`sh.Environment("PROCESS")("CCGW_PROFILE_HOME") = ${quote(profile)}`)
  const replacement=lines.join('\r\n')+'\r\nrc = sh.Run('+quote(command)+', 0, True)'
  text=text.replace(match[0],()=>replacement)
  fs.writeFileSync(file,(encoding==='utf16le'?'\uFEFF':'')+text,encoding)
}
const files=new Map(cfg.accounts.map(a=>[path.join(path.dirname(path.resolve(zw,a.serviceFile)),'serve.vbs'),path.resolve(zw,'accounts',a.name,'home')]))
for(const [file,profile] of files)update(file,false,profile)
update(path.join(zw,'gateway.vbs'),true)
console.log(JSON.stringify({backendLaunchers:files.size,gatewayLauncher:true,backups:'Windows DPAPI encrypted',providerCredentialsChanged:false}))
