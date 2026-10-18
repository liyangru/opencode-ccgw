// Dedicated local GUI-subsystem Node copy for stdio MCP children. The installed
// Node and official OpenCode executables are never modified.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
let cached
export function bridgeNode(){
  if(process.platform!=='win32')return process.execPath
  if(cached)return cached
  const image=fs.readFileSync(process.execPath),pe=image.readUInt32LE(0x3c)
  if(image.toString('ascii',pe,pe+4)!=='PE\0\0')throw Error('Node executable is not a PE image')
  const id=crypto.createHash('sha256').update(image).digest('hex').slice(0,20)
  const dir=path.join(process.env.LOCALAPPDATA||os.tmpdir(),'ccgw','runtime')
  fs.mkdirSync(dir,{recursive:true})
  const target=path.join(dir,'nodew-'+id+'.exe')
  image.writeUInt16LE(2,pe+24+68) // IMAGE_SUBSYSTEM_WINDOWS_GUI
  if(!fs.existsSync(target)||!fs.readFileSync(target).equals(image))fs.writeFileSync(target,image,{mode:0o700})
  cached=target;return target
}
