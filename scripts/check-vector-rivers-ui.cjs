const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const {pathToFileURL}=require('node:url');
const {chromium,_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..');
async function check(page,kind){
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>document.querySelector('#basemap').naturalWidth===16384);await page.evaluate(()=>MapPainting.waitForRender());
 const probes=JSON.parse(await fs.readFile(path.join(root,'assets/maps/eu5/lookup/vector-rivers-report.json'),'utf8')).probes;
 const failures=await page.evaluate(probes=>probes.filter(([x,y,inside])=>VectorMap.riverContains(x,y)!==inside),probes);
 assert.deepEqual(failures,[],'river centers must remain covered; neighboring bank centers must remain outside');
 await page.evaluate(async()=>{CountryLabels.restore({...CountryLabels.defaults(),enabled:false});const {id}=MapDesignerData.paintMeta.samples.river;CountryStore.restore([{id:'river-test',name:'河流测试',description:'',color:'#c85b51'}]);await MapPainting.restore({owners:{[id]:'river-test'},wastelandEnabled:false,mode:'pan',selectedCountry:null});});
 await page.locator('#map-zoom').fill('2000');
 await page.evaluate(()=>{const p=MapDesignerData.paintMeta.samples.river,v=document.querySelector('#map-viewport'),im=document.querySelector('#basemap');v.scrollLeft=im.width*(p.x+.5)/16384-v.clientWidth/2;v.scrollTop=im.height*(p.y+.5)/8192-v.clientHeight/2;});
 await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await page.evaluate(()=>MapPainting.waitForRender());
 assert.ok(Number(await page.locator('#paint-layer').getAttribute('data-vector-rivers'))>0);
 await page.screenshot({path:path.join(root,'output/vector-rivers-'+kind+'.png')});
 const png=await page.evaluate(()=>MapProject.capturePNG());assert.equal(Buffer.from(png,'base64').subarray(0,8).toString('hex'),'89504e470d0a1a0a');
 const snapshot=await page.evaluate(()=>MapProject.capture());await page.evaluate(data=>MapProject.openText(JSON.stringify(data)),snapshot);
 assert.deepEqual(await page.evaluate(()=>MapPainting.capture().owners),snapshot.painting.owners);
 const {x,y}=await page.evaluate(()=>MapDesignerData.paintMeta.samples.river);assert.equal(await page.evaluate(([x,y])=>VectorMap.riverContains(x+.5,y+.5),[x,y]),true);
 assert.deepEqual(errors,[]);console.log(kind+': 512 river/bank geometry probes, painted land protection, vector rendering, PNG and snapshot passed.');
}
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});try{for(const kind of ['file','browser']){const context=await browser.newContext({viewport:{width:1440,height:920}}),page=await context.newPage();await page.goto(kind==='file'?pathToFileURL(path.join(root,'index.html')).href+'#map':'http://127.0.0.1:4173/#map');await check(page,kind);await context.close();}}finally{await browser.close();}
 const profile=path.join(root,'.cache','river-test-'+Date.now());const app=await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[root],env:{...process.env,MAPDESIGNER_TEST_PROFILE:profile}});try{const page=await app.firstWindow();await page.evaluate(()=>location.hash='map');await check(page,'desktop');}finally{await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
