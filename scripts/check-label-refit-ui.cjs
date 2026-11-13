const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),vm=require('node:vm'),zlib=require('node:zlib');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');const root=path.resolve(__dirname,'..');
(async()=>{
 const scope={window:{}};vm.runInNewContext(await fs.readFile(path.join(root,'assets/maps/eu5/lookup/country-label-geometry.js'),'utf8'),scope);
 const raw=scope.window.MapCountryLabelGeometry,unpack=data=>zlib.gunzipSync(Buffer.from(data,'base64'));
 const grid=unpack(raw.grid),geometry={width:raw.width,height:raw.height,step:raw.step,patterns:raw.patterns,weights:raw.weights,grid:new Uint32Array(grid.buffer.slice(grid.byteOffset,grid.byteOffset+grid.byteLength)),land:new Uint8Array(unpack(raw.land)),waste:new Uint8Array(unpack(raw.waste))};
 const source=(await fs.readFile(path.join(root,'src/country-label-layout.js'),'utf8')).replace(/\r\n/g,'\n'),start=source.indexOf('      // The small trial size above'),end=source.indexOf('\n    }\n    return best;',start);
 assert.ok(start>0&&end>start);const previous={setTimeout};vm.runInNewContext(source.slice(0,start)+source.slice(end),previous);const current={setTimeout};vm.runInNewContext(source,current);
 const browser=await chromium.launch({channel:'msedge',headless:true});try{
  const page=await browser.newPage({viewport:{width:1440,height:920}});await page.goto('http://127.0.0.1:4173/#map');await page.waitForFunction(()=>document.querySelector('#basemap').naturalWidth===16384);
  const request=await page.evaluate(async()=>{
   await MapPainting.waitForRender();await document.fonts.load(`600 100px ${MapSettingsDefaults.fonts.kaiti}`,'保加利亚');
   const owners={};MapDesignerData.meta.locations.forEach((l,id)=>{if(!l||MapDesignerData.paintMeta.kinds[id]===1)return;const a=l[2]?.[3];if([197,198,199,200,201,202,203].includes(a))owners[id]='bulgaria';else if([195,196].includes(a))owners[id]='neighbor';});
   CountryStore.restore([{id:'bulgaria',name:'保加利亚',description:'',color:'#596779'},{id:'neighbor',name:'',description:'',color:'#c7a331'}]);await MapPainting.restore({owners,wastelandEnabled:true,mode:'pan',selectedCountry:null});CountryLabels.restore({...CountryLabels.defaults(),enabled:true});await CountryLabels.waitForRender();
   return{owners,countries:[{id:'bulgaria',layouts:CountryLabels.layoutsForName('保加利亚')}]};
  });
  const before=(await previous.CountryLabelLayout.compute(geometry,request))[0],after=(await current.CountryLabelLayout.compute(geometry,request))[0];
  console.log({before:before.fontSize,after:after.fontSize,growth:after.fontSize/before.fontSize,own:after.coverage.own,land:after.coverage.land});
  assert.ok(after.fontSize>before.fontSize*1.1,'irregular mainland should regain a useful size after inland repositioning');
  assert.ok(after.coverage.own>=before.coverage.own-.04&&after.coverage.land>=.95,'growth must retain domestic and inland placement');
  assert.ok(after.layout.width*after.layout.height*after.fontSize**2<=after.components.reduce((sum,c)=>sum+c.area,0)*.505,'refitting must retain a bounded name footprint');
  await page.locator('#map-zoom').fill('1500');await page.evaluate(()=>{const l=CountryLabels.placements().find(l=>l.id==='bulgaria'),v=document.querySelector('#map-viewport'),im=document.querySelector('#basemap');v.scrollLeft=im.width*l.x/16384-v.clientWidth/2;v.scrollTop=im.height*l.y/8192-v.clientHeight/2;});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await page.evaluate(async()=>{await MapPainting.waitForRender();await CountryLabels.waitForRender();});await page.screenshot({path:path.join(root,'output/refitted-bulgaria.png')});
  console.log('Bulgaria: refit increases the former undersized label while preserving territory coverage and area limits.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
