// Stream PNG rows so a full-resolution export does not need a 536 MB canvas.
(() => {
  const table=Uint32Array.from({length:256},(_,value)=>{for(let i=0;i<8;i++)value=value&1?0xedb88320^(value>>>1):value>>>1;return value>>>0;});
  function chunk(type,payload){
    const bytes=new Uint8Array(payload.length+12),view=new DataView(bytes.buffer);view.setUint32(0,payload.length);
    for(let i=0;i<4;i++)bytes[i+4]=type.charCodeAt(i);bytes.set(payload,8);let crc=0xffffffff;
    for(let i=4;i<bytes.length-4;i++)crc=table[(crc^bytes[i])&255]^(crc>>>8);
    view.setUint32(bytes.length-4,(crc^0xffffffff)>>>0);return bytes;
  }
  function create(width,height){
    const stream=new CompressionStream('deflate'),writer=stream.writable.getWriter(),reader=stream.readable.getReader(),parts=[];
    let rows=0,failure;
    const collecting=(async()=>{for(;;){const{value,done}=await reader.read();if(done)break;parts.push(chunk('IDAT',value));}})().catch(error=>{failure=error;});
    return{
      async writeRGBA(bytes,count){
        if(failure)throw failure;
        if(bytes.length!==width*count*4||rows+count>height)throw new Error('PNG 行数据无效。');
        const stride=width*4,filtered=new Uint8Array((stride+1)*count);
        for(let y=0;y<count;y++)filtered.set(bytes.subarray(y*stride,(y+1)*stride),y*(stride+1)+1);
        await writer.write(filtered);rows+=count;
      },
      async finish(){
        if(rows!==height)throw new Error('PNG 地图数据不完整。');await writer.close();await collecting;if(failure)throw failure;
        const header=new Uint8Array(13),view=new DataView(header.buffer);view.setUint32(0,width);view.setUint32(4,height);header[8]=8;header[9]=6;
        return new Uint8Array(await new Blob([new Uint8Array([137,80,78,71,13,10,26,10]),chunk('IHDR',header),...parts,chunk('IEND',new Uint8Array())],{type:'image/png'}).arrayBuffer());
      },
      async abort(){await Promise.allSettled([writer.abort(),reader.cancel()]);await collecting;}
    };
  }
  window.MapPNGEncoder={create};
})();
