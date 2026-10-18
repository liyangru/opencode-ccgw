import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {spawnSync} from 'node:child_process'
test('bridge GUI node preserves executable behavior and stdio without a console subsystem',async()=>{
  const {bridgeNode}=await import('./silent-node.mjs')
  const exe=bridgeNode()
  if(process.platform==='win32'){
    const b=fs.readFileSync(exe),pe=b.readUInt32LE(0x3c)
    assert.equal(b.readUInt16LE(pe+24+68),2)
  }
  const r=spawnSync(exe,['-e','process.stdout.write("BRIDGE_STDIO_OK")'],{encoding:'utf8',windowsHide:true})
  assert.equal(r.status,0);assert.equal(r.stdout,'BRIDGE_STDIO_OK')
})
