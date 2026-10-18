import {test} from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
test('backend profile cannot inherit desktop config, data, cache or service discovery',async()=>{
  const {backendEnvironment}=await import('./zero-window/backend-profile.mjs')
  const original={USERPROFILE:'C:/desktop',HOME:'C:/desktop',APPDATA:'C:/desktop/roaming',LOCALAPPDATA:'C:/desktop/local',OPENCODE_CONFIG:'C:/desktop/private.json',OPENCODE_CONFIG_CONTENT:'private',CCGW_SERVICE_FILE:'C:/desktop/service.json',PATH:'system-path'}
  const home=path.resolve('fixture-backend-profile'),out=backendEnvironment(original,home)
  for(const k of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME','OPENCODE_CONFIG_DIR'])assert.ok(out[k].startsWith(home),k)
  for(const k of ['OPENCODE_CONFIG','OPENCODE_CONFIG_CONTENT','CCGW_SERVICE_FILE'])assert.equal(out[k],undefined)
  assert.equal(out.PATH,'system-path');assert.equal(original.HOME,'C:/desktop')
})
