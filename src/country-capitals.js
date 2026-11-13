(() => {
  const layer=document.getElementById('capital-layer'),ctx=layer.getContext('2d');
  const viewport=document.getElementById('map-viewport'),image=document.getElementById('basemap'),status=document.getElementById('paint-status');
  let picking=null,sequence=0,pending=0,frame=0;
  function announce(){viewport.classList.toggle('capital-mode',Boolean(picking));window.dispatchEvent(new Event('capital-mode-change'));}
  function cancel(message=false){if(!picking)return;picking=null;sequence++;announce();if(message)status.textContent='已取消首都选择。';}
  function begin(id){
    if(picking===id){cancel(true);return;}
    const country=window.CountryStore.list().find(country=>country.id===id);if(!country)return;
    stopMapDrag();window.CountryStore.select(null);if(namesEnabled)nameButton.click();
    picking=id;sequence++;announce();
    status.textContent=`点击${window.CountryStore.fullName(country)||'该国家'}的本国${window.MapTemplate.levels[window.MapTemplate.baseLevel]}指定首都；可拖动平移，Esc 取消。`;
  }
  function clear(id){if(picking===id)cancel();window.CountryStore.setCapital(id,null);status.textContent='首都选择已清除。';schedule();}
  function markers(){
    return window.CountryStore.list().filter(country=>country.capital&&window.MapPainting.ownerOf(country.capital.locationId)===country.id).map(country=>({id:country.id,name:window.CountryStore.fullName(country),...country.capital}));
  }
  function schedule(){if(!frame)frame=requestAnimationFrame(()=>{frame=0;draw();});}
  function renderTo(ctx,{width:w,height:h,ratio=1,scale=1,offsetX=0,offsetY=0,capitals=markers()}){
    let count=0;ctx.save();ctx.setTransform(ratio,0,0,ratio,0,0);ctx.lineJoin='round';
    for(const capital of capitals){
      const x=offsetX+capital.x*scale,y=offsetY+capital.y*scale;
      if(x<-10||x>w+10||y<-10||y>h+10)continue;
      ctx.beginPath();for(let i=0;i<10;i++){const angle=-Math.PI/2+i*Math.PI/5,r=i%2?3.3:7.5,px=x+Math.cos(angle)*r,py=y+Math.sin(angle)*r;if(i)ctx.lineTo(px,py);else ctx.moveTo(px,py);}ctx.closePath();
      ctx.strokeStyle='#ffffff';ctx.lineWidth=4;ctx.stroke();ctx.fillStyle='#f3bf50';ctx.fill();ctx.strokeStyle='#4a3a20';ctx.lineWidth=1.3;ctx.stroke();count++;
    }
    ctx.restore();return count;
  }
  function draw(){
    const ratio=window.devicePixelRatio||1,w=viewport.clientWidth,h=viewport.clientHeight;
    const pw=Math.max(1,Math.ceil(w*ratio)),ph=Math.max(1,Math.ceil(h*ratio));
    if(layer.width!==pw)layer.width=pw;if(layer.height!==ph)layer.height=ph;
    layer.style.width=`${w}px`;layer.style.height=`${h}px`;ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,pw,ph);
    let count=0;if(w&&h&&image.naturalWidth){const bounds=image.getBoundingClientRect(),view=viewport.getBoundingClientRect();count=renderTo(ctx,{width:w,height:h,ratio,scale:bounds.width/image.naturalWidth,offsetX:bounds.left-view.left,offsetY:bounds.top-view.top});}
    layer.dataset.markerCount=String(count);
  }
  window.addEventListener('map-click',async event=>{
    if(!picking)return;
    const id=picking,revision=sequence;pending++;
    try{
      const point=await window.MapPainting.locationAtPoint(event.detail);
      await window.MapPainting.whenIdle();if(revision!==sequence||picking!==id)return;
      if(!point)return;
      if(point.kind===1||window.MapPainting.ownerOf(point.id)!==id){status.textContent=`首都必须选择该国家已经着色的${window.MapTemplate.levels[window.MapTemplate.baseLevel]}，请重新点击。`;return;}
      if(!window.CountryStore.list().some(country=>country.id===id)){cancel();return;}
      window.CountryStore.setCapital(id,{locationId:point.id,x:point.x+.5,y:point.y+.5});
      cancel();status.textContent=`已指定首都：${point.name||point.id}`;schedule();
      await window.MapPainting.whenIdle();
    }catch(error){status.textContent=`指定首都失败：${error.message}`;}
    finally{pending--;}
  });
  window.addEventListener('keydown',event=>{if(event.key==='Escape'&&picking){event.preventDefault();cancel(true);}});
  window.addEventListener('country-selection',()=>cancel());window.addEventListener('name-mode-enabled',()=>cancel());
  for(const id of ['erase-map','create-country','save-map','open-map-settings'])document.getElementById(id).addEventListener('click',()=>cancel());
  document.getElementById('country-list').addEventListener('click',event=>{if(event.target.closest('.country-select'))cancel();});
  window.addEventListener('hashchange',()=>{cancel();schedule();});
  for(const event of ['countries-changed','territories-changed'])window.addEventListener(event,event=>{
    if(picking&&!window.CountryStore.list().some(country=>country.id===picking))cancel();
    if(event.type==='territories-changed'&&window.CountryStore.list().some(country=>country.capital))window.CountryStore.refresh();schedule();
  });
  for(const event of ['map-view-change'])window.addEventListener(event,schedule);
  viewport.addEventListener('scroll',schedule);image.addEventListener('load',schedule);
  window.CountryCapitals={renderTo,selected:()=>picking,begin,clear,cancel,markers,waitForRender:async()=>{
    const start=performance.now();while(pending||frame){if(performance.now()-start>30000)throw new Error('等待首都标记超时。');await new Promise(resolve=>setTimeout(resolve,20));}
  }};
  window.CountryStore.refresh();schedule();
})();
