const assert=require('node:assert/strict');const path=require('node:path');const {chromium,_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');const root=path.resolve(__dirname,'..');
async function check(page,kind){
 await page.waitForFunction(()=>document.querySelector('#basemap').naturalWidth===16384);
 await page.evaluate(async()=>{
  await MapPainting.waitForRender();
  CountryStore.restore([{id:'france',name:'法兰西',description:'',color:'#2546e9'},{id:'swiss',name:'瑞士',description:'',color:'#ac7955'},{id:'germany',name:'德意志',description:'',color:'#b9bb70'}]);
  const owners={};MapDesignerData.meta.locations.forEach((l,id)=>{if(!l||MapDesignerData.paintMeta.kinds[id]===1)return;const region=l[2]?.[2],area=l[2]?.[3];if([43,44,45].includes(area))owners[id]='swiss';else if(region===7)owners[id]='france';else if([3,4].includes(region))owners[id]='germany';});
  await MapPainting.restore({owners,wastelandEnabled:true,mode:'pan',selectedCountry:null});CountryLabels.restore({...CountryLabels.defaults(),enabled:true});await CountryLabels.waitForRender();
 });
 const labels=await page.evaluate(()=>CountryLabels.placements());assert.equal(labels.length,3,'all neighboring names should remain visible');
 const france=labels.find(l=>l.id==='france');assert.ok(france.layout.width*france.layout.height*france.fontSize**2<france.components.reduce((sum,c)=>sum+c.area,0)*.25,'large-country name should occupy less than a quarter of its land area');
 assert.ok(france.coverage.inkLand>.95&&france.coverage.land>.95,'a mainland name should prefer inland placement over a larger coastal label');
 const overlaps=await page.evaluate(()=>{
  const labels=CountryLabels.placements(),c=document.createElement('canvas');c.width=2200;c.height=1500;const ctx=c.getContext('2d'),occupied=new Uint8Array(c.width*c.height),fonts=MapSettingsDefaults.fonts;let collisions=0;
  for(const label of labels){
   ctx.clearRect(0,0,c.width,c.height);const size=label.fontSize;ctx.font=`600 ${size}px ${fonts[CountryLabels.capture().font]}`;ctx.textAlign='center';ctx.textBaseline='alphabetic';ctx.lineJoin='round';ctx.lineWidth=Math.max(.75,size*.05);ctx.strokeStyle=ctx.fillStyle='#000';
   const draw=(x,y,angle,width,height,lines,baseline,advance)=>{ctx.save();ctx.translate(x-7000,y-1500);ctx.rotate(angle);ctx.beginPath();ctx.rect(-width*size/2,-height*size/2,width*size,height*size);ctx.clip();lines.forEach((line,i)=>{ctx.strokeText(line,0,(baseline+i*advance)*size);ctx.fillText(line,0,(baseline+i*advance)*size);});ctx.restore();};
   if(label.glyphs)for(const g of label.glyphs)draw(g.x,g.y,g.angle,g.width,g.height,[g.text],g.baseline,0);else draw(label.x,label.y,label.angle,label.layout.width,label.layout.height,label.layout.lines,label.layout.baseline,label.layout.lineAdvance);
   const data=ctx.getImageData(0,0,c.width,c.height).data;let inkPixels=0;for(let i=0;i<occupied.length;i++)if(data[i*4+3]){inkPixels++;if(occupied[i])collisions++;occupied[i]=1;}if(inkPixels<50)throw new Error('Label mask is outside the test viewport: '+label.id);
  }
  return collisions;
 });assert.equal(overlaps,0,'rendered names and outlines must not overlap');
 const positions=labels.map(l=>[l.id,l.x,l.y,l.fontSize,l.angle]).sort();await page.evaluate(async()=>{CountryStore.restore(CountryStore.list().reverse());await CountryLabels.waitForRender();});assert.deepEqual((await page.evaluate(()=>CountryLabels.placements())).map(l=>[l.id,l.x,l.y,l.fontSize,l.angle]).sort(),positions,'list order must not determine label collisions');
 await page.locator('#map-zoom').fill('1500');await page.evaluate(()=>{const v=document.querySelector('#map-viewport'),im=document.querySelector('#basemap');const labels=CountryLabels.placements(),a=labels.find(l=>l.id==='france'),b=labels.find(l=>l.id==='swiss');v.scrollLeft=im.width*(a.x+b.x)/2/16384-v.clientWidth/2;v.scrollTop=im.height*(a.y+b.y)/2/8192-v.clientHeight/2;});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await page.evaluate(async()=>{await MapPainting.waitForRender();await CountryLabels.waitForRender();});await page.screenshot({path:path.join(root,'output/country-name-collisions-'+kind+'.png')});
 const snapshot=await page.evaluate(()=>MapProject.capture());await page.evaluate(data=>MapProject.openText(JSON.stringify(data)),snapshot);assert.deepEqual((await page.evaluate(()=>CountryLabels.placements())).map(l=>[l.id,l.x,l.y,l.fontSize,l.angle]).sort(),positions);const png=await page.evaluate(()=>MapProject.capturePNG());assert.equal(Buffer.from(png,'base64').subarray(0,8).toString('hex'),'89504e470d0a1a0a');
 console.log(kind+': three neighbors, outline pixel collisions, restrained large-country text, deterministic order, snapshot and PNG passed.',labels.map(l=>({id:l.id,size:l.fontSize,angle:l.angle*180/Math.PI})));
}
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{const page=await browser.newPage({viewport:{width:1440,height:920}});await page.goto('http://127.0.0.1:4173/#map');await check(page,'browser');}finally{await browser.close();}const app=await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[root],env:{...process.env,MAPDESIGNER_TEST_PROFILE:path.join(root,'.cache','collision-test-'+Date.now())}});try{const page=await app.firstWindow();await page.evaluate(()=>location.hash='map');await check(page,'desktop');}finally{await app.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
