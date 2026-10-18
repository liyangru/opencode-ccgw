import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAnthropic, parseOpenAI, parseResponses, anthropicNonStream, openaiNonStream, responsesNonStream, makeOpenAIStream, makeResponsesStream } from './formats.mjs'

for (const [name, parse, field, input] of [
  ['Anthropic', parseAnthropic, 'max_tokens', { messages: [{role:'user',content:'hi'}] }],
  ['Chat', parseOpenAI, 'max_tokens', { messages: [{role:'user',content:'hi'}] }],
  ['Responses', parseResponses, 'max_output_tokens', { input: 'hi' }],
]) {
  test(`${name} preserves and validates token budgets`, () => {
    for (const n of [64,8192]) assert.equal(parse({...input,[field]:n}).maxOutputTokens,n)
    assert.equal(parse(input).maxOutputTokens,undefined)
    for (const n of [0,-1,1.5,'64',null]) assert.throws(()=>parse({...input,[field]:n}),/positive integer/)
  })
}
test('Chat prefers max_completion_tokens when both fields are supplied', () => {
  assert.equal(parseOpenAI({messages:[],max_tokens:32,max_completion_tokens:64}).maxOutputTokens,64)
})
test('unsupported attachments return an explicit error instead of disappearing', () => {
  for (const type of ['image','document']) {
    assert.throws(()=>parseAnthropic({messages:[{role:'user',content:[{type,source:{type:'base64',data:'AAAA'}}]}]}),/unsupported.*input/i)
    assert.throws(()=>parseAnthropic({messages:[{role:'user',content:[{type:'tool_result',tool_use_id:'a',content:[{type}]}]}]}),/unsupported.*input/i)
  }
  for (const type of ['image_url','input_audio','input_file','input_image']) {
    assert.throws(()=>parseOpenAI({messages:[{role:'user',content:[{type}]}]}),/unsupported.*input/i)
    assert.throws(()=>parseResponses({input:[{type:'message',role:'user',content:[{type}]}]}),/unsupported.*input/i)
  }
})

test('exhausted output budgets stay incomplete across all client protocols',()=>{
  const result={text:'partial',toolCalls:[],finish:'length',usage:{input:1,output:64}}
  assert.equal(anthropicNonStream(result,'m').stop_reason,'max_tokens')
  assert.equal(openaiNonStream(result,'m').choices[0].finish_reason,'length')
  const response=responsesNonStream(result,'m')
  assert.equal(response.status,'incomplete')
  assert.equal(response.incomplete_details.reason,'max_output_tokens')
  const chat=[];makeOpenAIStream((event,data)=>chat.push(data),'m',1).finish(result)
  assert.ok(chat.some(d=>d?.choices?.[0]?.finish_reason==='length'))
  const events=[];makeResponsesStream((event,data)=>events.push({event,data}),'m',1).finish(result)
  assert.equal(events.at(-1).event,'response.incomplete')
  assert.equal(events.at(-1).data.response.incomplete_details.reason,'max_output_tokens')
  assert.equal(events.some(e=>e.event==='response.completed'),false)
})
