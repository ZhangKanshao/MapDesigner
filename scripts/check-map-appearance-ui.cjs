const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const {pathToFileURL} = require('node:url');
const {chromium,_electron} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {createCanvas,loadImage} = require(path.join(process.env.PLAYWRIGHT_MODULE,'../@napi-rs/canvas'));
const root=path.resolve(__dirname,'..');
const samples={'1':{x:0,y:0},'2':{x:2401,y:0},'3':{x:11627,y:130},'4':{x:12834,y:169}};
const palette={water:'#2468ac',wasteland:'#e4c49a',fineBorder:'#565656',coarseBorder:'#663399'};
const run=Date.now();
async function check(page,kind){
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>document.querySelector('#basemap').naturalWidth===16384);
 await page.evaluate(()=>window.MapPainting.waitForRender());
 assert.equal(await page.locator('.settings-group .toolbar-group-label').textContent(),'外观');
 await page.evaluate(()=>window.CountryStore.restore([{id:'palette-test',name:'调色测试国',description:'',color:'#123456'}]));
 await page.locator('#open-map-settings').click();
 await page.locator('#map-color-hex-water').fill('#123456');await page.locator('#save-map-settings').click();
 await page.waitForFunction(()=>document.querySelector('#map-settings-status').textContent.includes('不能与现有国家颜色相同'));
 await page.waitForFunction(()=>!document.querySelector('#save-map-settings').disabled);
 assert.equal(await page.evaluate(()=>window.MapAppearance.capture().water),'#b9dfee');
 for(const [key,color]of Object.entries(palette))await page.locator('#map-color-hex-'+key).fill(color);
 await page.locator('#save-map-settings').click();
 await page.waitForFunction(()=>document.querySelector('#map-settings-status').textContent.startsWith('设置已保存'));
 await page.waitForFunction(()=>!document.querySelector('#save-map-settings').disabled);
 assert.deepEqual(await page.evaluate(()=>window.MapAppearance.capture()),palette);
 await page.screenshot({path:path.join(root,'output/map-colors-'+kind+'.png')});
 await page.locator('#close-map-settings').click();
 await page.locator('#admin-level').selectOption('province');
 await page.waitForFunction(()=>document.querySelector('#map-message').hidden);
 await page.evaluate(()=>window.MapProject.capture());
 const actual=await page.evaluate(samples=>{
  const img=document.querySelector('#basemap'),c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');
  return Object.fromEntries(Object.entries(samples).map(([key,{x,y}])=>{ctx.clearRect(0,0,1,1);ctx.drawImage(img,x,y,1,1,0,0,1,1);return[key,[...ctx.getImageData(0,0,1,1).data].slice(0,3)];}));
 },samples);
 for(const[index,key]of[['1','water'],['2','wasteland'],['3','fineBorder'],['4','coarseBorder']])assert.deepEqual(actual[index],[1,3,5].map(i=>parseInt(palette[key].slice(i,i+2),16)));
 if(kind!=='file') {
  const stockholm=require('../assets/maps/eu5/lookup/paint-report.json').samples.stockholm;
  await page.evaluate(async sample=>window.MapPainting.restore({owners:{[sample.id]:'palette-test'},wastelandEnabled:false,mode:'paint',selectedCountry:'palette-test'}),stockholm);
  await page.evaluate(()=>window.MapPainting.waitForRender());
 }
 const saved=await page.evaluate(()=>window.MapProject.capture());assert.deepEqual(saved.mapAppearance,palette);
 // Country validation follows the active map palette.
 await page.locator('#create-country').click();await page.locator('#country-name').fill('冲突国');await page.locator('#country-color-swatch').click();
 for(const[channel,value]of[['red',36],['green',104],['blue',172]])await page.locator('#country-'+channel).fill(String(value));
 await page.locator('#confirm-country').click();assert.equal(await page.locator('#country-color-error').isVisible(),true);await page.locator('#cancel-country').click();
 await page.locator('#toggle-boundaries').click();await page.waitForFunction(()=>document.querySelector('#map-message').hidden);await page.evaluate(()=>window.MapProject.capture());
 assert.equal(await page.evaluate(()=>window.MapAppearance.capture().water),palette.water);
 // PNG includes the configured palette, not the original image colors.
 const base64=await page.evaluate(()=>window.MapProject.capturePNG());
 const bytes=Buffer.from(base64,'base64');assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
 const png=await loadImage(bytes),canvas=createCanvas(png.width,png.height),ctx=canvas.getContext('2d');ctx.drawImage(png,0,0);const pixels=ctx.getImageData(0,0,png.width,png.height).data;
 let waterPixels=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]===36&&pixels[i+1]===104&&pixels[i+2]===172)waterPixels++;assert.ok(waterPixels>100);
 await fs.writeFile(path.join(root,'output/custom-map-export-'+kind+'.png'),bytes);
 await page.reload();await page.waitForFunction(()=>document.querySelector('#basemap').naturalWidth===16384);assert.deepEqual(await page.evaluate(()=>window.MapAppearance.capture()),palette);
 // Legacy snapshots keep the default colors; loading a custom snapshot restores its own palette.
 const legacy={...saved};delete legacy.mapAppearance;
 await page.evaluate(snapshot=>window.MapProject.openText(JSON.stringify(snapshot)),legacy);
 assert.equal(await page.evaluate(()=>window.MapAppearance.capture().water),'#b9dfee');
 await page.evaluate(snapshot=>window.MapProject.openText(JSON.stringify(snapshot)),saved);
 assert.deepEqual(await page.evaluate(()=>window.MapAppearance.capture()),palette);
 const invalid={...saved,mapAppearance:{...palette,water:'invalid'}};
 assert.equal(await page.evaluate(async snapshot=>{try{await window.MapProject.openText(JSON.stringify(snapshot));return false;}catch{return true;}},invalid),true);
 assert.deepEqual(await page.evaluate(()=>window.MapAppearance.capture()),palette);
 await page.locator('#open-map-settings').click();await page.locator('#reset-map-settings').click();
 await page.waitForFunction(()=>document.querySelector('#map-settings-status').textContent === '当前地图已恢复默认设置并保存。');
 assert.equal(await page.locator('#map-color-hex-water').inputValue(),'#b9dfee');
 assert.equal(await page.evaluate(()=>window.MapAppearance.capture().water),'#b9dfee');await page.waitForFunction(()=>!document.querySelector('#save-map-settings').disabled);
 await page.locator('#close-map-settings').click();assert.equal(await page.locator('.country-list-item').count(),1);
 await page.evaluate(snapshot=>window.MapProject.openText(JSON.stringify(snapshot)),saved);await page.evaluate(()=>window.MapProject.createBlank());
 assert.deepEqual(await page.evaluate(()=>window.MapAppearance.capture()),await page.evaluate(()=>window.MapAppearance.defaults()));assert.equal(await page.locator('.country-list-item').count(),0);
 assert.deepEqual(errors,[]);console.log(kind+': four rendered palette colors, reserved country colors, hidden borders, PNG, snapshot persistence/validation, legacy defaults and blank-map isolation passed.');
}
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{for(const [kind,url]of[['file',pathToFileURL(path.join(root,'index.html')).href+'#map'],['browser','http://127.0.0.1:4173/#map']]){const context=await browser.newContext({viewport:{width:1440,height:920}});const page=await context.newPage();await page.goto(url);await check(page,kind);await context.close();}}finally{await browser.close();}
 const profile=path.join(root,'.cache','palette-tests-'+run);await fs.mkdir(profile,{recursive:true});
 const app=await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[root],env:{...process.env,MAPDESIGNER_TEST_PROFILE:profile}});
 try{const page=await app.firstWindow();await page.evaluate(()=>location.hash='map');await check(page,'desktop');}finally{await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
