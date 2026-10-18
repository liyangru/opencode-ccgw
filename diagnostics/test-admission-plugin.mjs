import assert from 'node:assert/strict'
import { requestSummary } from './admission-plugin/index.mjs'
const request=new Request('https://example.invalid/inference/openai/v1/chat/completions?api_key=secret-query',{method:'POST',headers:{authorization:'Bearer secret-fixture','content-type':'application/json','x-opencode-org-id':'org_private','user-agent':'opencode/test/2.0.32/cli'},body:JSON.stringify({model:'fixture-free',messages:[{role:'user',content:'PRIVATE_PROMPT'}],tools:[{type:'function',function:{name:'read'}}],max_completion_tokens:64})})
const summary=await requestSummary(request),text=JSON.stringify(summary)
for(const secret of ['secret-fixture','secret-query','org_private','PRIVATE_PROMPT']) assert.equal(text.includes(secret),false)
assert.equal(summary.maxOutput,64)
assert.deepEqual(summary.toolNames,['read'])
assert.equal(summary.auth.authorization.publicPlaceholder,false)
assert.equal(summary.endpoint,'https://example.invalid/inference/openai/v1/chat/completions')
console.log('PASS admission observer retains metadata without credentials, query values, or prompts')
