const assert=require('node:assert/strict');const path=require('node:path');const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{const page=await browser.newPage({viewport:{width:1440,height:920}});await page.goto('http://127.0.0.1:4173/#map');await page.waitForFunction(()=>document.querySelector('#basemap').naturalWidth===16384);
for(const spec of[{id:'romania',name:'罗马尼亚',zoom:1250},{id:'china',name:'中华',zoom:500},{id:'britain',name:'联合王国',zoom:650},{id:'channel',name:'英法联合王国',zoom:450},{id:'chile',name:'智利共和国',zoom:450},{id:'vietnam',name:'越南共和国',zoom:650},{id:'vietnam-short',name:'越南',zoom:650},{id:'vietnam-single',name:'越',zoom:650}]){
 await page.evaluate(async spec=>{if(!MapDesignerData.meta)await loadLookupScript('meta.js');if(!MapDesignerData.paintMeta)await loadLookupScript('paint-meta.js');CountryStore.restore([{id:'union',name:spec.name,description:'',color:'#d4aa77'},{id:'other',name:'',description:'',color:'#98b5a1'}]);const owners={};MapDesignerData.meta.locations.forEach((l,id)=>{if(!l||MapDesignerData.paintMeta.kinds[id]===1)return;const region=l[2]?.[2],area=l[2]?.[3];if(spec.id==='romania'){if([123,129].includes(area))owners[id]='union';else if(region===10)owners[id]='other';}if(spec.id==='china'&&[23,28,29,31].includes(region))owners[id]='union';if(spec.id==='britain'){if(region===5||area===66)owners[id]='union';else if(region===6)owners[id]='other';}if(spec.id==='channel'){if(region===5||region===7)owners[id]='union';else if(region===6)owners[id]='other';}if(spec.id==='chile'&&[671,680].includes(area))owners[id]='union';if(spec.id.startsWith('vietnam')&&[401,410].includes(area))owners[id]='union';});await MapPainting.restore({owners,wastelandEnabled:true,mode:'pan',selectedCountry:null});CountryLabels.restore({...CountryLabels.defaults(),enabled:true,font:'kaiti'});},spec);
 await page.evaluate(()=>CountryLabels.waitForRender());const label=(await page.evaluate(()=>CountryLabels.placements())).find(l=>l.id==='union');assert.ok(label);console.log(spec.id,JSON.stringify({angle:label.angle*180/Math.PI,components:label.components,coverage:label.coverage,lines:label.layout.lines,fontSize:label.fontSize,unspacedFontSize:label.unspacedFontSize,glyphs:label.glyphs}));
 assert.ok(label.angle>=-Math.PI/2&&label.angle<Math.PI/2);assert.ok(!label.glyphs||label.glyphs.every(g=>g.angle>=-Math.PI/2&&g.angle<Math.PI/2));if(spec.id==='china')assert.equal(label.angle,0,'China should have a horizontal title');
 if(spec.id==='romania')assert.ok(label.coverage.own>=.85,'Romanian label should remain predominantly within its own narrow territory');
 if(label.glyphs?.length>=3){const gaps=label.glyphs.slice(1).map((g,i)=>Math.hypot(g.x-label.glyphs[i].x,g.y-label.glyphs[i].y));assert.ok(Math.max(...gaps)/Math.min(...gaps)<=1.26,'adjacent Chinese glyph spacing must stay even');}
 if(spec.id==='britain')assert.equal(label.components.length,1);if(spec.id==='channel')assert.ok(label.components.length>=2);if(['chile','vietnam','vietnam-short'].includes(spec.id))assert.ok(Math.abs(label.angle)>Math.PI/3);
 if(['chile','vietnam','vietnam-short'].includes(spec.id)){
  assert.ok(label.glyphs?.length>=2,'elongated names should spread their characters');
  assert.ok(label.fontSize<=label.unspacedFontSize*.66,'tracking should reduce the type size');
 }
 if(spec.id==='vietnam-single')assert.ok(label.fontSize<=label.unspacedFontSize*.66,'even a single character should be smaller');
 if(spec.id==='vietnam-short'){
  assert.deepEqual(label.glyphs.map(g=>g.text),['越','南']);
  assert.ok(label.glyphs[1].y-label.glyphs[0].y>250,'two-character Vietnam name should span north and south');
 }
 await page.locator('#map-zoom').fill(String(spec.zoom));await page.evaluate(l=>{const v=document.querySelector('#map-viewport'),im=document.querySelector('#basemap');v.scrollLeft=im.width*l.x/16384-v.clientWidth/2;v.scrollTop=im.height*l.y/8192-v.clientHeight/2;},label);await page.evaluate(async()=>{await MapPainting.waitForRender();await CountryLabels.waitForRender();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});assert.equal(await page.evaluate(()=>CountryLabels.capture().opacity),75);const alpha=await page.evaluate(()=>{const c=document.querySelector('#country-name-layer'),data=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let max=0;for(let i=3;i<data.length;i+=4)max=Math.max(max,data[i]);return max;});assert.ok(alpha>180&&alpha<=192);await page.screenshot({path:path.resolve('output/country-label-geography-'+spec.id+'.png')});
 if(['vietnam-short','vietnam'].includes(spec.id)){
  const snapshot=await page.evaluate(()=>MapProject.capture());
  const before=label.glyphs.map(g=>[g.text,g.x,g.y]);
  const png=await page.evaluate(()=>MapProject.capturePNG());assert.equal(Buffer.from(png,'base64').subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  await page.evaluate(data=>MapProject.openText(JSON.stringify(data)),snapshot);
  const restored=(await page.evaluate(()=>CountryLabels.placements())).find(l=>l.id==='union');
  assert.deepEqual(restored.glyphs.map(g=>[g.text,g.x,g.y]),before,'snapshot should restore separated character positions');
 }

}
console.log('Actual EU5 geometry: Great Britain/Ulster mainland, Britain/France channel, Chile and Vietnam passed.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
