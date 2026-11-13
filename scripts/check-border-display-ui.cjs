const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs/promises');
const{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const{pathToFileURL}=require('node:url');
const{loadImage,createCanvas}=require(path.join(process.env.PLAYWRIGHT_MODULE,'../@napi-rs/canvas'));
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{for(const key of ['eu5','ck3-1066']){
  const context=await browser.newContext({viewport:{width:1600,height:960}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(pathToFileURL(path.resolve('index.html')).href+'?map='+key+'#map');
  await page.waitForFunction(()=>document.querySelector('#basemap').naturalWidth===MapTemplate.width);await page.evaluate(()=>MapPainting.waitForRender());
  assert.deepEqual(await page.locator('#toggle-boundaries option').allTextContents(),['显示地块边界','显示政治边界','隐藏边界']);
  const result=await page.evaluate(async()=>{
   const data=await VectorMap.ready(),kinds=MapDesignerData.paintMeta.kinds,colors=MapAppearance.defaults();
   CountryLabels.restore({...CountryLabels.defaults(),enabled:false});
   const countries=new Map([['a','#c85b51'],['b','#779944']]);
   const arc=data.arcs.find(a=>a[0]&&a[1]&&kinds[a[0]]===0&&kinds[a[1]]===0&&a[2].length>8),[a,b]=arc;
   const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=512;const ctx=canvas.getContext('2d');
   const box=arc[3],scale=10,frame={scale,offsetX:512-(box[0]+box[2])/2*scale,offsetY:256-(box[1]+box[3])/2*scale,width:1024,height:512,ratio:1,countries,colors};
   async function pixels(owners,level,countryRoots){await VectorMap.render(ctx,{...frame,owners,level,countryRoots});return ctx.getImageData(0,0,1024,512).data;}
   function changed(x,y){let n=0;for(let i=0;i<x.length;i++)if(x[i]!==y[i])n++;return n;}
   const empty=changed(await pixels({},'countries'),await pixels({},'none'));
   const united={};data.locations.forEach(l=>{united[l.id]='a';});
   const same=changed(await pixels(united,'countries'),await pixels(united,'none'));
   const neutral=changed(await pixels({[a]:'a'},'countries'),await pixels({[a]:'a'},'none'));
   const wasteland=data.locations.find(l=>kinds[l.id]===2);const withoutWaste={...united};delete withoutWaste[wasteland.id];
   const noWaste=changed(await pixels(withoutWaste,'countries'),await pixels(withoutWaste,'none'));
   const neighbors={...united,[b]:'b'};
   const noBorder=await pixels(neighbors,'none');
   const outside=await pixels(neighbors,'countries',new Map([['a','a'],['b','b']]));
   const patterns=[];
   const stroke=ctx.stroke.bind(ctx);
   ctx.stroke=path=>{const dash=ctx.getLineDash();if(dash.length)patterns.push(dash);stroke(path);};
   const suzerain=await pixels(neighbors,'countries',new Map([['a','a'],['b','a']]));
   const siblings=await pixels(neighbors,'countries',new Map([['a','root'],['b','root']]));
   const dotDash=patterns.length>0&&patterns.every(([dash,gap,dot,nextGap])=>dash>gap&&gap===nextGap&&dot>0&&dot<dash/10);
   const hasGray=(rgba,tone)=>rgba.some((value,i)=>i%4===0&&value===tone&&rgba[i+1]===tone&&rgba[i+2]===tone);
   const different=changed(outside,noBorder);
   const innerBlack=hasGray(suzerain,0);
   const outerBlack=hasGray(outside,0);
   const innerThin=changed(suzerain,noBorder)<different;
   const sameStyle=changed(suzerain,siblings)===0;
   const owners={[a]:'a',[b]:'b'};CountryStore.restore([...countries].map(([id,color])=>({id,color,name:id,description:''})));await MapPainting.restore({owners,wastelandEnabled:false,mode:'pan',selectedCountry:null});
   return{empty,same,neutral,noWaste,different,innerBlack,outerBlack,innerThin,sameStyle,dotDash,colors};
  });
  assert.equal(result.empty,0);assert.equal(result.same,0);assert.equal(result.noWaste,0);assert.ok(result.neutral>100);assert.ok(result.different>100);assert.equal(result.colors.coarseBorder,'#555555');assert.equal(result.colors.countryBorder,'#000000');
  assert.ok(result.innerBlack && result.outerBlack && result.innerThin && result.sameStyle && result.dotDash);
  await page.locator('#toggle-boundaries').selectOption('countries');await page.waitForFunction(()=>loadedBoundaryDisplay==='countries');await page.evaluate(()=>MapPainting.waitForRender());
  assert.equal(await page.locator('#location-legend').isVisible(),false);assert.equal(await page.locator('#admin-legend-label').textContent(),'国家分界');
  const snap=await page.evaluate(()=>MapProject.capture());assert.equal(snap.view.boundaryDisplay,'countries');
  await page.locator('#toggle-boundaries').selectOption('hidden');await page.waitForFunction(()=>loadedBoundaryDisplay==='hidden');await page.evaluate(s=>MapProject.openText(JSON.stringify(s)),snap);assert.equal(await page.locator('#toggle-boundaries').inputValue(),'countries');
  await page.mouse.click(1100,120);await page.keyboard.press('b');await page.waitForFunction(()=>loadedBoundaryDisplay==='hidden');await page.keyboard.press('b');await page.waitForFunction(()=>loadedBoundaryDisplay==='plots');
  const old=structuredClone(snap);delete old.view.boundaryDisplay;old.view.boundariesHidden=false;delete old.mapAppearance.countryBorder;
  await page.evaluate(s=>MapProject.openText(JSON.stringify(s)),old);assert.equal(await page.locator('#toggle-boundaries').inputValue(),'plots');assert.equal(await page.evaluate(()=>MapAppearance.capture().countryBorder),'#000000');
  await page.locator('#open-map-settings').click();assert.equal(await page.locator('#map-color-hex-countryBorder').inputValue(),'#000000');await page.locator('#map-color-hex-countryBorder').fill('#ee00aa');await page.locator('#map-settings-form button[type="submit"]').click();await page.waitForFunction(()=>document.querySelector('#map-settings-status').textContent.startsWith('设置已保存'));await page.locator('#close-map-settings').click();
  await page.locator('#toggle-boundaries').selectOption('countries');await page.waitForFunction(()=>loadedBoundaryDisplay==='countries');await page.evaluate(()=>MapPainting.waitForRender());
  if(key==='ck3-1066'){
   const png=Buffer.from(await page.evaluate(()=>MapProject.capturePNG()),'base64');await fs.writeFile('output/country-borders-full.png',png);
   const image=await loadImage(png),canvas=createCanvas(image.width,image.height),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);const pixels=ctx.getImageData(0,0,image.width,image.height).data;let n=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]>150&&pixels[i+1]<60&&pixels[i+2]>100)n++;assert.ok(n>10,'export must include the custom country border');
  }
  assert.deepEqual(errors,[]);console.log(key+': border modes, country adjacency, same-country/neutral suppression, colors, snapshot compatibility and shortcut passed.');await context.close();
 }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
