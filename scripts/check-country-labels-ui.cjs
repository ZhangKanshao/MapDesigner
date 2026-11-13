const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const path=require('node:path');const {pathToFileURL}=require('node:url');
const {chromium,_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {loadImage,createCanvas}=require(path.join(process.env.PLAYWRIGHT_MODULE,'../@napi-rs/canvas'));
const root=path.resolve(__dirname,'..'),run=Date.now();
async function check(page,kind){
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>document.querySelector('#basemap').naturalWidth===16384);
 assert.equal(await page.locator('#toggle-country-labels').getAttribute('aria-checked'),'false');
 assert.equal(await page.locator('#toggle-country-labels').getAttribute('aria-label'),'隐藏国名');assert.equal(await page.evaluate(()=>CountryLabels.capture().font),'kaiti');assert.equal(await page.evaluate(()=>CountryLabels.capture().enabled),true);
 await page.locator('#toggle-country-labels').click();assert.equal(await page.locator('#toggle-country-labels').getAttribute('aria-checked'),'true');assert.equal(await page.evaluate(()=>CountryLabels.capture().enabled),false);
 assert.equal(await page.evaluate(()=>CountryLabels.capture().opacity),75);
 const wordUnits=await page.evaluate(()=>({single:CountryLabels.layoutsForName('Deutschland')[0].units,multi:CountryLabels.layoutsForName('United Kingdom')[0].units.map(u=>u.text),chinese:CountryLabels.layoutsForName('越南')[0].units.map(u=>u.text)}));assert.equal(wordUnits.single,null);assert.deepEqual(wordUnits.multi,['United','Kingdom']);assert.deepEqual(wordUnits.chinese,['越','南']);
 const breaks=await page.evaluate(()=>({four:CountryLabels.layoutsForName('中华帝国').map(l=>l.lines),five:CountryLabels.layoutsForName('大中华帝国').map(l=>l.lines),latin:CountryLabels.layoutsForName('United Northern Republic').map(l=>({lines:l.lines,ratio:l.width/l.height}))}));
 assert.deepEqual(breaks.four,[['中华帝国']]);assert.ok(breaks.five.some(lines=>lines.length===2&&Array.from(lines[0]).length===3&&Array.from(lines[1]).length===2));
 assert.ok(breaks.latin.every(l=>l.lines.length===1||l.ratio>=1.5));
 await page.evaluate(async()=>{
  if(!MapDesignerData.meta)await loadLookupScript('meta.js');if(!MapDesignerData.paintMeta)await loadLookupScript('paint-meta.js');
  CountryStore.restore([{id:'china',name:'大中华帝国',description:'',color:'#d8aa72'},{id:'russia',name:'北方联合共和国',description:'',color:'#8cb097'},{id:'france',name:'Western Commonwealth',description:'',color:'#b49acb'},{id:'unnamed',name:'',description:'',color:'#be8b93'},{id:'empty',name:'Lost Nation',description:'',color:'#8491b8'}]);
  const m=MapDesignerData.meta,kinds=MapDesignerData.paintMeta.kinds,owners={};
  m.locations.forEach((location,id)=>{if(!location||kinds[id]===1)return;const region=location[2]?.[2];if([23,28,29,31].includes(region))owners[id]='china';else if(region===15)owners[id]='russia';else if(region===7)owners[id]='france';else if(region===24)owners[id]='unnamed';});
  const enclave=m.locations.findIndex(l=>l&&/nanjing|yingtian|beijing/.test(l[0]));
  if(enclave>0&&owners[enclave]==='china')owners[enclave]='russia';
  await MapPainting.restore({owners,wastelandEnabled:true,mode:'pan',selectedCountry:null});
 });
 await page.locator('#open-map-settings').click();await page.locator('#country-label-font').selectOption('kaiti');
 await page.locator('#country-label-color-hex').fill('#334155');await page.locator('#country-label-opacity').fill('50');
 assert.equal(await page.locator('#country-label-opacity-value').textContent(),'50%');
 await page.locator('#save-map-settings').click();await page.waitForFunction(()=>document.querySelector('#map-settings-status').textContent.startsWith('设置已保存')&&!document.querySelector('#save-map-settings').disabled);await page.locator('#close-map-settings').click();
 const start=Date.now();await page.locator('#toggle-country-labels').click();await page.evaluate(()=>CountryLabels.waitForRender());
 const placements=await page.evaluate(()=>CountryLabels.placements());
 console.log(kind+' layout time '+(Date.now()-start)+'ms, names '+placements.map(l=>l.id+':'+l.layout.lines.join('/')).join(', '));
 assert.ok(placements.some(l=>l.id==='china'));assert.ok(placements.some(l=>l.id==='france'));
 assert.ok(placements.every(l=>!['unnamed','empty'].includes(l.id)&&Math.abs(l.angle)<=Math.PI/2+.001));
 assert.equal(new Set(placements.map(l=>l.id)).size,placements.length);
 await page.locator('#map-zoom').fill('400');
 await page.evaluate(()=>{const l=CountryLabels.placements().find(l=>l.id==='china'),v=document.querySelector('#map-viewport'),im=document.querySelector('#basemap');v.scrollLeft=im.width*l.x/16384-v.clientWidth/2;v.scrollTop=im.height*l.y/8192-v.clientHeight/2;});
 await page.evaluate(async()=>{await MapPainting.waitForRender();await CountryLabels.waitForRender();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
 const pixels=await page.evaluate(async()=>{
  const canvas=document.querySelector('#country-name-layer'),ctx=canvas.getContext('2d'),data=ctx.getImageData(0,0,canvas.width,canvas.height).data;
  const im=document.querySelector('#basemap').getBoundingClientRect(),v=document.querySelector('#map-viewport').getBoundingClientRect(),ratio=devicePixelRatio,scale=im.width/16384;
  const owners=MapPainting.capture().owners,labels=CountryLabels.placements();let count=0,maxAlpha=0,halo=0,foreign=0,outside=0,own=0,land=0;
  const points=[],bands=new Set();
  for(let p=0;p<data.length;p+=4)if(data[p+3]){
   count++;maxAlpha=Math.max(maxAlpha,data[p+3]);if(data[p]>225&&data[p+1]>225&&data[p+2]>225)halo++;
   const px=(p/4)%canvas.width,py=Math.floor(p/4/canvas.width),x=(v.left+(px+.5)/ratio-im.left)/scale,y=(v.top+(py+.5)/ratio-im.top)/scale;
   const label=labels.find(l=>{const parts=l.glyphs||[{x:l.x,y:l.y,angle:l.angle,width:l.layout.width,height:l.layout.height}];return parts.some(part=>{const dx=x-part.x,dy=y-part.y,c=Math.cos(part.angle),s=Math.sin(part.angle);return Math.abs(dx*c+dy*s)<=part.width*l.fontSize/2+1/scale&&Math.abs(-dx*s+dy*c)<=part.height*l.fontSize/2+1/scale;});});
   if(!label){foreign++;continue;}points.push([Math.floor(x),Math.floor(y),label.id]);bands.add(Math.floor(y/256));
  }
  for(const band of bands)if(!MapDesignerData.bands[band])await loadLookupScript(`band-${band}.js`);
  for(const[x,y,owner]of points){const row=MapDesignerData.bands[Math.floor(y/256)][y%256];let lo=0,hi=row.length/2;while(lo<hi){const mid=(lo+hi)>>>1;if(x<row[mid*2])hi=mid;else lo=mid+1;}const id=row[lo*2+1];if(owners[id]===owner)own++;else outside++;if(owners[id]&&owners[id]!==owner)foreign++;if(MapDesignerData.paintMeta.kinds[id]!==1)land++;}
  return {count,maxAlpha,halo,foreign,outside,own,land};
 });
 console.log(kind+' visible name pixels',pixels);assert.ok(pixels.count>50);assert.ok(pixels.maxAlpha<=128);assert.ok(pixels.halo>0);assert.ok(pixels.own/pixels.count>=.55);assert.ok(pixels.foreign/pixels.count<=.15);assert.ok(pixels.land/pixels.count>=.6);
 await page.screenshot({path:path.join(root,'output/country-names-'+kind+'.png')});
 await page.locator('[data-country-id="china"] .country-select').click();await page.locator('#country-name').fill('中华帝国');await page.locator('#confirm-country').click();
 await page.evaluate(async()=>{await MapPainting.whenIdle();await CountryLabels.waitForRender();});
 assert.deepEqual((await page.evaluate(()=>CountryLabels.placements())).find(l=>l.id==='china').layout.lines,['中华帝国']);
 await page.locator('#undo-map').click();await page.evaluate(async()=>{await MapPainting.whenIdle();await CountryLabels.waitForRender();});
 assert.equal((await page.evaluate(()=>CountryLabels.placements())).find(l=>l.id==='china').layout.lines.join(''),'大中华帝国');
 const saved=await page.evaluate(()=>MapProject.capture());assert.equal(saved.countryLabels.enabled,true);assert.equal(saved.countryLabels.font,'kaiti');assert.equal(saved.countryLabels.opacity,50);
 if(kind!=='file'){
 const withNames=Buffer.from(await page.evaluate(()=>MapProject.capturePNG()),'base64');
 await page.locator('#toggle-country-labels').click();await page.evaluate(()=>CountryLabels.waitForRender());
 const without=Buffer.from(await page.evaluate(()=>MapProject.capturePNG()),'base64');
 const decode=async bytes=>{const im=await loadImage(bytes),c=createCanvas(im.width,im.height);const ctx=c.getContext('2d');ctx.drawImage(im,0,0);return ctx.getImageData(0,0,im.width,im.height).data;};
 const a=await decode(withNames),b=await decode(without);let changed=0;for(let i=0;i<a.length;i+=4)if(Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2])>10)changed++;
 assert.ok(changed>30,'PNG must include country names when enabled');
 }
 await page.evaluate(snapshot=>MapProject.openText(JSON.stringify(snapshot)),saved);assert.equal(await page.locator('#toggle-country-labels').getAttribute('aria-checked'),'false');
 assert.deepEqual(await page.evaluate(()=>CountryLabels.capture()),saved.countryLabels);
 const beforeSize=(await page.evaluate(()=>CountryLabels.placements())).find(l=>l.id==='china').fontSize;
 // Removing almost all territory clears stale labels immediately and fits a much smaller one, or hides it.
 const cleared=await page.evaluate(async()=>{const owners=MapPainting.capture().owners;for(const id of Object.keys(owners))if(owners[id]==='china'&&Number(id)%50!==0)delete owners[id];await MapPainting.restore({...MapPainting.capture(),owners});return document.querySelector('#country-name-layer').dataset.labelCount;});
 assert.equal(cleared,'0');
 await page.evaluate(()=>CountryLabels.waitForRender());const after=(await page.evaluate(()=>CountryLabels.placements())).find(l=>l.id==='china');assert.ok(!after||after.fontSize<beforeSize);
 await page.evaluate(snapshot=>MapProject.openText(JSON.stringify(snapshot)),saved);
 // Style settings and switches survive reload, but do not leak into a newly created map.
 await page.reload();await page.waitForFunction(()=>document.querySelector('#basemap').naturalWidth===16384);await page.evaluate(()=>CountryLabels.waitForRender());assert.deepEqual(await page.evaluate(()=>CountryLabels.capture()),saved.countryLabels);
 const legacy={...saved};delete legacy.countryLabels;await page.evaluate(snapshot=>MapProject.openText(JSON.stringify(snapshot)),legacy);assert.equal(await page.evaluate(()=>CountryLabels.capture().enabled),true);assert.equal(await page.evaluate(()=>CountryLabels.capture().opacity),75);
 await page.evaluate(snapshot=>MapProject.openText(JSON.stringify(snapshot)),saved);
 const invalid={...saved,countryLabels:{...saved.countryLabels,opacity:101}};
 assert.equal(await page.evaluate(async snapshot=>{try{await MapProject.openText(JSON.stringify(snapshot));return false;}catch{return true;}},invalid),true);
 assert.deepEqual(await page.evaluate(()=>CountryLabels.capture()),saved.countryLabels);
 await page.locator('#open-map-settings').click();await page.locator('#country-label-opacity').fill('0');await page.locator('#save-map-settings').click();await page.waitForFunction(()=>document.querySelector('#map-settings-status').textContent.startsWith('设置已保存')&&!document.querySelector('#save-map-settings').disabled);
 assert.equal(await page.locator('#country-name-layer').getAttribute('data-label-count'),'0');
 await page.locator('#reset-map-settings').click();await page.waitForFunction(()=>document.querySelector('#map-settings-status').textContent==='当前地图已恢复默认设置并保存。'&&!document.querySelector('#save-map-settings').disabled);
 assert.deepEqual(await page.evaluate(()=>CountryLabels.capture()),await page.evaluate(()=>CountryLabels.defaults()));await page.locator('#close-map-settings').click();
 await page.evaluate(snapshot=>MapProject.openText(JSON.stringify(snapshot)),saved);await page.evaluate(()=>MapProject.createBlank());assert.equal(await page.evaluate(()=>CountryLabels.capture().enabled),true);
 assert.deepEqual(errors,[]);console.log(kind+': Chinese/Latin wrapping, domestic majority, outline/opacity, territory updates, '+(kind==='file'?'label canvas':'PNG')+', snapshot, legacy and new-map isolation passed.');
}
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{for(const[kind,url]of[['file',pathToFileURL(path.join(root,'index.html')).href+'#map'],['browser','http://127.0.0.1:4173/#map']]){const context=await browser.newContext({viewport:{width:1440,height:920}});const page=await context.newPage();await page.goto(url);await check(page,kind);await context.close();}}finally{await browser.close();}
 const profile=path.join(root,'.cache','country-label-tests-'+run);await fs.mkdir(profile,{recursive:true});
 const app=await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[root],env:{...process.env,MAPDESIGNER_TEST_PROFILE:profile}});
 try{const page=await app.firstWindow();await page.evaluate(()=>location.hash='map');await check(page,'desktop');}finally{await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
