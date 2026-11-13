const assert=require('node:assert/strict');
const path=require('node:path');const {pathToFileURL}=require('node:url');
const {loadImage,createCanvas}=require(path.join(process.env.PLAYWRIGHT_MODULE,'../@napi-rs/canvas'));
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{for(const kind of ['file','browser']){
  const context=await browser.newContext({viewport:{width:1440,height:920}});const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(kind==='file'?pathToFileURL(path.resolve('index.html')).href+'#map':'http://127.0.0.1:4173/#map');
  await page.waitForFunction(()=>document.querySelector('#basemap').naturalWidth===16384);await page.evaluate(()=>MapPainting.waitForRender());
  assert.equal(await page.locator('#paint-layer').getAttribute('data-vector'),'true');
  await page.evaluate(async()=>{CountryLabels.restore({...CountryLabels.defaults(),enabled:false});CountryStore.restore([{id:'germany',name:'德国',description:'',color:'#c85b51'}]);const owners={};MapDesignerData.meta.locations.forEach((l,id)=>{if(l&&MapDesignerData.paintMeta.kinds[id]!==1&&[3,4].includes(l[2]?.[2]))owners[id]='germany';});await MapPainting.restore({owners,wastelandEnabled:true,mode:'pan',selectedCountry:null});});
  await page.locator('#map-zoom').fill('2000');
  await page.evaluate(()=>{const v=document.querySelector('#map-viewport'),im=document.querySelector('#basemap');v.scrollLeft=im.width*8314/16384-v.clientWidth/2;v.scrollTop=im.height*1900/8192-v.clientHeight/2;});
  await page.locator('#admin-level').selectOption('province');
  await page.waitForFunction(()=>loadedAdminLevel==='province');await page.evaluate(()=>MapPainting.waitForRender());
  const original=await page.evaluate(()=>MapPainting.capture().owners);
  const pixels=async()=>{const image=await loadImage(await page.locator('#paint-layer').screenshot()),canvas=createCanvas(image.width,image.height),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);const d=ctx.getImageData(0,0,canvas.width,canvas.height).data;let black=0,partial=0,gray=0;for(let i=0;i<d.length;i+=4){if(d[i]<8&&d[i+1]<8&&d[i+2]<8)black++;if(Math.abs(d[i]-d[i+1])<2&&Math.abs(d[i+1]-d[i+2])<2&&d[i]>4&&d[i]<145)partial++;if(d[i]===150&&d[i+1]===150&&d[i+2]===150)gray++;}return{black,partial,gray};};
  const drawn=await pixels();assert.ok(drawn.black>100);assert.ok(drawn.partial>100,'strokes must contain antialiased edge pixels');
  await page.screenshot({path:path.resolve('output/vector-borders-'+kind+'.png')});
  await page.evaluate(()=>document.querySelector('#paint-layer').style.visibility='hidden');await page.screenshot({path:path.resolve('output/raster-borders-'+kind+'.png')});await page.evaluate(()=>document.querySelector('#paint-layer').style.visibility='');
  await page.locator('#toggle-boundaries').click();await page.waitForFunction(()=>loadedBoundariesHidden);await page.evaluate(()=>MapPainting.waitForRender());
  const hidden=await pixels();assert.equal(hidden.black,0);assert.ok(hidden.partial<drawn.partial/10);
  assert.deepEqual(await page.evaluate(()=>MapPainting.capture().owners),original);
  for(const level of ['location','area','region','subcontinent','continent']){await page.locator('#admin-level').selectOption(level);await page.waitForFunction(level=>loadedAdminLevel===level,level);await page.evaluate(()=>MapPainting.waitForRender());}
  assert.deepEqual(errors,[]);console.log(kind+': shared vector arcs, antialiasing, border hiding, all administrative levels and ownership preservation passed.',drawn,await page.evaluate(()=>VectorMap.stats()));await context.close();
 }}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
