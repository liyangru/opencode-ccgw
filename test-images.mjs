import {test} from 'node:test'
import assert from 'node:assert/strict'
import {parseOpenAI,parseAnthropic,parseResponses} from './formats.mjs'
const uri='data:image/png;base64,aGVsbG8='
for(const [name,parse,body] of [
  ['Chat',parseOpenAI,{messages:[{role:'user',content:[{type:'text',text:'read'},{type:'image_url',image_url:{url:uri}}]}]}],
  ['Claude',parseAnthropic,{messages:[{role:'user',content:[{type:'image',source:{type:'base64',media_type:'image/png',data:'aGVsbG8='}}]}]}],
  ['Responses',parseResponses,{input:[{type:'message',role:'user',content:[{type:'input_image',image_url:uri}]}]}],
])test(name+' preserves actual image bytes as native files, not prompt text',()=>{
  const out=parse(body);assert.equal(out.files.length,1);assert.equal(out.files[0].uri,uri)
  assert.match(out.messages[0].text,/ccgw-image-1.png/);assert.ok(!JSON.stringify(out.messages).includes('aGVsbG8='))
})
test('remote/local image URLs are not fetched and malformed base64 is rejected',()=>{
  for(const url of ['file:///C:/secret','http://127.0.0.1/','https://example.com/x.png','data:image/png;base64,???'])assert.throws(()=>parseOpenAI({messages:[{role:'user',content:[{type:'image_url',image_url:{url}}]}]}),/Unsupported image input/)
})
test('Responses tool output images remain attached with their result marker',()=>{
  const out=parseResponses({input:[{type:'function_call_output',call_id:'call_1',output:[{type:'input_image',image_url:uri}]}]})
  assert.equal(out.files[0].uri,uri);assert.match(out.messages[0].results[0].text,/ccgw-image-1.png/)
})
