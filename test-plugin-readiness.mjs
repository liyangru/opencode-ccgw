import {test} from 'node:test'
import assert from 'node:assert/strict'
import {ensureGatewayPlugin} from './engine.mjs'
test('cold native location may need over five seconds to activate without bypassing enforcement',async t=>{
  let now=0,calls=0
  t.mock.method(Date,'now',()=>now)
  const oc={async reqOrThrow(){calls++;now+=6000;return {data:[{id:'ccgw-output-budget-v1',state:{status:calls===1?'loading':'active'}}]}}}
  await ensureGatewayPlugin(oc,'fixture-location')
  assert.equal(calls,2)
})
test('failed budget plugin still fails closed immediately',async()=>{
  const oc={async reqOrThrow(){return {data:[{id:'ccgw-output-budget-v1',state:{status:'failed'}}]}}}
  await assert.rejects(ensureGatewayPlugin(oc,'fixture-location'),e=>e.status===503&&e.code==='gateway_plugin_unavailable')
})
