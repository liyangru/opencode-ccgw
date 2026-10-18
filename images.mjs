// Inline image attachments only. Never fetch arbitrary URLs or dereference
// client-supplied local paths. OpenCode validates/decodes the actual image.
export function prepareImages(body){
  const files=[];let bytes=0
  function walk(block){
    if(Array.isArray(block))return block.map(walk)
    if(!block||typeof block!=='object')return block
    if(['image','image_url','input_image'].includes(block.type)){
      const source=block.source
      const uri=block.type==='image'&&source?.type==='base64'
        ?`data:${source.media_type};base64,${source.data}`
        :typeof block.image_url==='string'?block.image_url:block.image_url?.url
      const match=typeof uri==='string'&&/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(uri)
      if(!match||match[2].length%4!==0)throw Error('Unsupported image input: 请上传内嵌 PNG/JPEG/WebP/GIF 图片；暂不抓取远程图片网址或本地文件路径。')
      bytes+=Buffer.byteLength(match[2],'base64')
      if(files.length>=20||bytes>15*1024*1024)throw Error('Unsupported image input: 图片总量超过 20 张或 15MB。')
      const name=`ccgw-image-${files.length+1}.${match[1]==='jpeg'?'jpg':match[1]}`
      files.push({uri,name})
      return {type:'text',text:`[Attached image: ${name}]`}
    }
    if(block.type==='function_call_output'&&Array.isArray(block.output))return {...block,output:walk(block.output)}
    return Array.isArray(block.content)?{...block,content:walk(block.content)}:block
  }
  return {body:{...body,...(Array.isArray(body.messages)?{messages:walk(body.messages)}:{}),...(Array.isArray(body.input)?{input:walk(body.input)}:{})},files}
}
