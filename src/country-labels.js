(() => {
  const defaults={enabled:true,font:'kaiti',color:'#263747',opacity:75,enclaveNaming:true};
  const storageKey=`mapdesigner.${window.MapTemplate.key}.country-labels.v1`;
  const fonts=window.MapSettingsDefaults.fonts;
  const toggle=document.getElementById('toggle-country-labels');
  const layer=document.getElementById('country-name-layer'),ctx=layer.getContext('2d');
  const buffer=document.createElement('canvas');
  const fontInput=document.getElementById('country-label-font'),colorInput=document.getElementById('country-label-color'),hexInput=document.getElementById('country-label-color-hex');
  const opacityInput=document.getElementById('country-label-opacity'),opacityValue=document.getElementById('country-label-opacity-value');
  const enclaveToggle=document.getElementById('enclave-naming');
  const status=document.getElementById('country-label-status');
  let state={...defaults},revision=0,placements=[],busy=false,failure=null,timer=0,frame=0,geometryPromise=null,worker=null,lastJob=null;
  function validate(value) {
    if(!value || typeof value!=='object' || typeof value.enabled!=='boolean' || !Object.hasOwn(fonts,value.font) || typeof value.color!=='string' || !/^#[0-9a-f]{6}$/i.test(value.color) || !Number.isInteger(value.opacity) || value.opacity<0 || value.opacity>100) throw new Error('国家名称设置无效。');
    if(value.enclaveNaming!==undefined && typeof value.enclaveNaming!=='boolean') throw new Error('飞地命名设置无效。');
    return {enabled:value.enabled,font:value.font,color:value.color.toLowerCase(),opacity:value.opacity,enclaveNaming:value.enclaveNaming??defaults.enclaveNaming};
  }
  try{const saved=localStorage.getItem(storageKey);if(saved)state=validate(JSON.parse(saved));}catch{}
  for(const option of document.getElementById('settings-font').options)fontInput.append(option.cloneNode(true));
  function fillSettings(value=state) {fontInput.value=value.font;colorInput.value=hexInput.value=value.color;opacityInput.value=value.opacity;opacityValue.value=`${value.opacity}%`;enclaveToggle.setAttribute('aria-checked',String(value.enclaveNaming));}
  function readSettings(){return validate({...state,font:fontInput.value,color:hexInput.value.trim(),opacity:Number(opacityInput.value),enclaveNaming:enclaveToggle.getAttribute('aria-checked')==='true'});}
  enclaveToggle.addEventListener('click',()=>enclaveToggle.setAttribute('aria-checked',String(enclaveToggle.getAttribute('aria-checked')!=='true')));
  colorInput.addEventListener('input',()=>{hexInput.value=colorInput.value;});
  hexInput.addEventListener('input',()=>{if(/^#[0-9a-f]{6}$/i.test(hexInput.value))colorInput.value=hexInput.value;});
  opacityInput.addEventListener('input',()=>{opacityValue.value=`${opacityInput.value}%`;});
  function restore(value=defaults) {
    const previous=state,next=validate(value);
    if(Object.keys(next).every(key=>next[key]===previous[key]))return;
    state=next;toggle.setAttribute('aria-checked',String(!state.enabled));
    try{localStorage.setItem(storageKey,JSON.stringify(state));}catch{}
    if(next.enabled!==previous.enabled || next.font!==previous.font || next.enclaveNaming!==previous.enclaveNaming || !previous.opacity || !next.opacity)invalidate();
    else scheduleDraw();
  }
  toggle.setAttribute('aria-checked',String(!state.enabled));
  toggle.addEventListener('click',()=>restore({...state,enabled:!state.enabled}));
  function clear(){ctx.clearRect(0,0,layer.width,layer.height);layer.dataset.labelCount='0';}
  function scheduleDraw(){if(!frame)frame=requestAnimationFrame(()=>{frame=0;draw();});}
  function markBusy(value){busy=value;layer.dataset.rendered=String(!value);toggle.setAttribute('aria-busy',String(value));toggle.title=value?'正在排布国家名称…':'隐藏或显示国名';}
  function invalidate(){
    ++revision;failure=null;placements=[];clear();clearTimeout(timer);if(worker)worker.postMessage({type:'cancel',revision});
    if(!state.enabled || state.opacity===0){markBusy(false);scheduleDraw();return;}
    markBusy(true);timer=setTimeout(()=>rebuild(revision),80);
  }
  async function geometry(){
    if(!geometryPromise)geometryPromise=(async()=>{
      if(!window.MapCountryLabelGeometry)await new Promise((resolve,reject)=>{
        const script=document.createElement('script');script.src=new URL(`${window.MapTemplate.assetRoot}/lookup/country-label-geometry.js?v=2`,document.baseURI).href;
        script.onload=()=>{script.remove();resolve();};script.onerror=()=>{script.remove();reject(new Error('国家名称地形数据加载失败。'));};document.head.append(script);
      });
      const source=window.MapCountryLabelGeometry;
      if(source.sourceFingerprint!==window.EU5ProjectMeta.sourceFingerprint)throw new Error('国家名称地形数据与底图版本不匹配。');
      async function unpack(encoded) {
        const binary=atob(encoded),compressed=Uint8Array.from(binary,ch=>ch.charCodeAt(0));
        return new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      }
      const [bytes,land,waste]=await Promise.all([unpack(source.grid),unpack(source.land),unpack(source.waste)]);
      const result={width:source.width,height:source.height,step:source.step,patterns:source.patterns,weights:source.weights,grid:new Uint32Array(bytes),land:new Uint8Array(land),waste:new Uint8Array(waste)};
      delete window.MapCountryLabelGeometry;
      return result;
    })().catch(error=>{geometryPromise=null;throw error;});
    return geometryPromise;
  }
  function layoutsForName(name,font=state.font){
    name=name.trim();if(!name)return [];
    const measure=document.createElement('canvas').getContext('2d');measure.font=`600 100px ${fonts[font]}`;measure.textAlign='center';measure.textBaseline='alphabetic';
    const variants=[[name]],characters=Array.from(name);
    if(/^\p{Script=Han}+$/u.test(name)) {
      for(let rows=2;rows<=Math.min(6,characters.length);rows++){
        if(Math.ceil(characters.length/rows)/rows<1.5)continue;
        const base=Math.floor(characters.length/rows),extra=characters.length%rows,lines=[];let at=0;
        for(let row=0;row<rows;row++){const length=base+(row<extra?1:0);lines.push(characters.slice(at,at+length).join(''));at+=length;}
        variants.push(lines);
      }
    }else{
      const words=name.split(/\s+/u);
      if(words.length>1){
        const widths=words.map(word=>measure.measureText(word).width),space=measure.measureText(' ').width;
        const total=widths.reduce((a,b)=>a+b,0)+space*(words.length-1);
        for(let rows=2;rows<=Math.min(4,words.length);rows++){
          const target=Math.max(Math.max(...widths),total/rows),lines=[];let line='',width=0;
          for(let i=0;i<words.length;i++){
            if(line && width+space+widths[i]>target*1.08 && lines.length<rows-1){lines.push(line);line=words[i];width=widths[i];}
            else{width+=(line?space:0)+widths[i];line+=(line?' ':'')+words[i];}
          }
          if(line)lines.push(line);if(lines.length>1)variants.push(lines);
        }
      }
    }
    const unique=new Set(),result=[];
    for(const lines of variants){
      const key=JSON.stringify(lines);if(unique.has(key))continue;unique.add(key);
      let width=0,ascent=0,descent=0;
      for(const line of lines){const m=measure.measureText(line);width=Math.max(width,2*Math.max(m.actualBoundingBoxLeft,m.actualBoundingBoxRight),m.width);ascent=Math.max(ascent,m.actualBoundingBoxAscent||80);descent=Math.max(descent,m.actualBoundingBoxDescent||15);}
      const height=ascent+descent+(lines.length-1)*110;
      // Chinese uses glyph columns/rows; alphabetic names use the measured box.
      if(lines.length>1 && !/^\p{Script=Han}+$/u.test(name) && (width+16)/(height+16)<1.5)continue;
      const baseline=(ascent-height/2)/100;
      const inkBoxes=lines.map((line,index)=>{const m=measure.measureText(line),y=baseline+index*1.1;return {left:-m.actualBoundingBoxLeft/100-.03,right:m.actualBoundingBoxRight/100+.03,top:y-(m.actualBoundingBoxAscent||80)/100-.03,bottom:y+(m.actualBoundingBoxDescent||15)/100+.03};});
      let units=null,wideSpacing=false;
      if(lines.length===1) {
        const chinese=/^\p{Script=Han}+$/u.test(name),words=name.split(/\s+/u);
        const pieces=chinese?Array.from(name):words.length>1?words:[name];
        wideSpacing=chinese||words.length>1;
        if(pieces.length>=2&&pieces.length<=24)units=pieces.map(text=>{
          const m=measure.measureText(text),asc=m.actualBoundingBoxAscent||80,desc=m.actualBoundingBoxDescent||15,b=(asc-desc)/200;
          return {text,width:(Math.max(m.width,2*Math.max(m.actualBoundingBoxLeft,m.actualBoundingBoxRight))+16)/100,height:(asc+desc+16)/100,baseline:b,inkBox:{left:-m.actualBoundingBoxLeft/100-.03,right:m.actualBoundingBoxRight/100+.03,top:b-asc/100-.03,bottom:b+desc/100+.03}};
        });
      }
      result.push({lines,width:(width+16)/100,height:(height+16)/100,baseline,lineAdvance:1.1,inkBoxes,units,wideSpacing});
    }
    return result;
  }

  let enclaveGeography;
  async function prepareEnclaves(owners, countries) {
    if (!enclaveGeography) {
      await Promise.all([loadLookupScript('meta.js'), loadLookupScript('paint-meta.js')]);
      const { meta, paintMeta } = window.MapDesignerData;
      const groups = [];
      const groupKeys = meta.parentOrder.map((level, depth) => meta.groups[level].map(group => {
        if (!group) return null;
        return groups.push({ name: group[1], depth, total: 0 }) - 1;
      }));
      const plots = meta.locations.map((location, id) => {
        if (!location || paintMeta.kinds[id] !== 0) return null;
        return groupKeys.map((keys, depth) => {
          const key = keys[location[2]?.[depth]] ?? null;
          if (key !== null) groups[key].total++;
          return key;
        });
      });
      const regionalLevel = meta.parentOrder.includes('region') ? 'region' : 'kingdom';
      enclaveGeography = { groups, plots, regionalDepth: meta.parentOrder.indexOf(regionalLevel) };
    }

    const { groups, plots } = enclaveGeography;
    const counts = new Map(countries.map(country => [country.id, new Map()]));
    for (const [id, owner] of Object.entries(owners)) {
      const owned = counts.get(owner);
      if (!owned || !plots[id]) continue;
      for (const key of plots[id]) if (key !== null) owned.set(key, (owned.get(key) || 0) + 1);
    }
    for (const country of countries) {
      const prefix = country.name.trim();
      country.enclaveLayouts = {};
      for (const [key, count] of counts.get(country.id)) {
        if (!CountryLabelLayout.qualifiesEnclave(count, groups[key].total)) continue;
        country.enclaveLayouts[key] = layoutsForName(`${prefix}-${groups[key].name}`);
      }
    }
    return enclaveGeography;
  }
  function accept(rev,labels){if(rev!==revision)return;placements=labels;failure=null;markBusy(false);status.textContent='';scheduleDraw();}
  function fail(rev,error){if(rev!==revision)return;failure=error;markBusy(false);status.textContent=`国家名称排版失败：${error.message}`;clear();}
  async function fallback(job){try{accept(job.revision,await CountryLabelLayout.compute(job.geometry,job.request,()=>job.revision!==revision));}catch(error){fail(job.revision,error);}}
  function getWorker(data){
    if(location.protocol==='file:'&&!window.mapFiles)return null;
    if(worker)return worker;
    try{
      worker=new Worker(new URL('src/country-label-worker.js',document.baseURI));
      worker.onmessage=event=>{const answer=event.data;if(answer.error)fail(answer.revision,new Error(answer.error));else accept(answer.revision,answer.labels);};
      worker.onerror=event=>{event.preventDefault();worker?.terminate();worker=null;if(lastJob&&lastJob.revision===revision)fallback(lastJob);};
      worker.postMessage({type:'geometry',geometry:data});return worker;
    }catch{return null;}
  }
  async function rebuild(rev){
    try{
      await window.MapPainting.whenIdle();if(rev!==revision)return;
      const countries=window.CountryStore.list().filter(country=>country.name.trim());
      const owners=window.MapPainting.capture().owners;
      const owned=new Set(Object.values(owners));
      const named=countries.filter(country=>owned.has(country.id));
      if(!named.length){accept(rev,[]);return;}
      await document.fonts.load(`600 100px ${fonts[state.font]}`,named.map(window.CountryStore.fullName).join(''));
      const data=await geometry();if(rev!==revision)return;
      const enclaves = state.enclaveNaming ? await prepareEnclaves(owners, named) : null;
      if(rev!==revision)return;
      const request={owners,enclaves,countries:named.map(country=>({id:country.id,capital:country.capital,layouts:layoutsForName(window.CountryStore.fullName(country)),enclaveLayouts:country.enclaveLayouts}))};
      lastJob={revision:rev,geometry:data,request};
      const agent=getWorker(data);
      if(agent)agent.postMessage({revision:rev,request});else await fallback(lastJob);
    }catch(error){fail(rev,error);}
  }
  function renderLabels(target,scratch,{width,height,ratio=1,scale=1,offsetX=0,offsetY=0},settings,labels){
    const pw=Math.max(1,Math.ceil(width*ratio)),ph=Math.max(1,Math.ceil(height*ratio));
    if(scratch.width!==pw)scratch.width=pw;if(scratch.height!==ph)scratch.height=ph;
    const ink=scratch.getContext('2d',{willReadFrequently:true});ink.setTransform(1,0,0,1,0,0);ink.clearRect(0,0,pw,ph);
    if(!settings.enabled||settings.opacity===0)return 0;
    const rgb=[1,3,5].map(i=>parseInt(settings.color.slice(i,i+2),16));
    const halo=rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722>140?'#172536':'#ffffff';
    let count=0;
    for(const label of labels){
      const size=label.fontSize*scale;if(size<6)continue;
      const x=offsetX+label.x*scale,y=offsetY+label.y*scale;
      const w=label.layout.width*size,h=label.layout.height*size,c=Math.cos(label.angle),s=Math.sin(label.angle);
      const extentX=Math.abs(w*c/2)+Math.abs(h*s/2),extentY=Math.abs(w*s/2)+Math.abs(h*c/2);
      if(x+extentX<0||x-extentX>width||y+extentY<0||y-extentY>height)continue;
      const drawText=(cx,cy,angle,width,height,lines,baseline,advance)=>{
        ink.save();ink.setTransform(ratio,0,0,ratio,0,0);ink.translate(cx,cy);ink.rotate(angle);
        ink.beginPath();ink.rect(-width/2,-height/2,width,height);ink.clip();
        ink.font=`600 ${size}px ${fonts[settings.font]}`;ink.textAlign='center';ink.textBaseline='alphabetic';ink.lineJoin='round';ink.miterLimit=2;
        ink.strokeStyle=halo;ink.fillStyle=settings.color;ink.lineWidth=Math.max(.75,size*.05);
        lines.forEach((line,index)=>{const at=(baseline+index*advance)*size;ink.strokeText(line,0,at);ink.fillText(line,0,at);});ink.restore();
      };
      if(label.glyphs)for(const glyph of label.glyphs)drawText(offsetX+glyph.x*scale,offsetY+glyph.y*scale,glyph.angle,glyph.width*size,glyph.height*size,[glyph.text],glyph.baseline,0);
      else drawText(x,y,label.angle,w,h,label.layout.lines,label.layout.baseline,label.layout.lineAdvance);
      count++;
    }
    target.save();target.setTransform(1,0,0,1,0,0);target.globalAlpha=settings.opacity/100;target.drawImage(scratch,0,0);target.restore();
    return count;
  }
  function draw(){
    const view=document.getElementById('map-viewport'),image=document.getElementById('basemap');
    const ratio=window.devicePixelRatio||1,width=view.clientWidth,height=view.clientHeight;
    const pw=Math.max(1,Math.ceil(width*ratio)),ph=Math.max(1,Math.ceil(height*ratio));
    if(layer.width!==pw)layer.width=pw;if(layer.height!==ph)layer.height=ph;
    layer.style.width=`${width}px`;layer.style.height=`${height}px`;ctx.setTransform(1,0,0,1,0,0);clear();
    if(busy||!width||!height||!image.naturalWidth)return;
    const bounds=image.getBoundingClientRect(),viewport=view.getBoundingClientRect();
    layer.dataset.labelCount=String(renderLabels(ctx,buffer,{width,height,ratio,scale:bounds.width/window.MapTemplate.width,offsetX:bounds.left-viewport.left,offsetY:bounds.top-viewport.top},state,placements));
  }
  function createRenderer(){
    const scratch=document.createElement('canvas'),settings={...state},labels=placements;
    return{draw:(target,view)=>renderLabels(target,scratch,view,settings,labels),dispose:()=>{scratch.width=scratch.height=1;}};
  }
  for(const name of ['territories-changed','countries-changed'])window.addEventListener(name,invalidate);
  for(const name of ['map-view-change','hashchange'])window.addEventListener(name,scheduleDraw);
  document.getElementById('map-viewport').addEventListener('scroll',scheduleDraw);
  document.getElementById('basemap').addEventListener('load',scheduleDraw);
  window.CountryLabels={capture:()=>({...state}),defaults:()=>({...defaults}),validate,restore,fillSettings,readSettings,layoutsForName,createRenderer,
    placements:()=>placements.map(label=>({...label,glyphs:label.glyphs?.map(glyph=>({...glyph})),layout:{...label.layout,lines:[...label.layout.lines]}})),
    waitForRender:async()=>{
      const start=performance.now();
      while(busy||frame){if(failure)throw failure;if(performance.now()-start>60000)throw new Error('等待国家名称排版超时，请重试。');await new Promise(resolve=>setTimeout(resolve,20));}
      if(failure)throw failure;
    }};
  fillSettings();invalidate();
})();
