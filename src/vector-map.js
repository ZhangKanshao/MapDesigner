(function installVectorMap(window, loadLookupScript) {
  let readyPromise,geometry;
  let viewportWorker, workerUnavailable=false, workerStats, workerRivers;
  const workerStyles=new Set();
  const viewportLayers=new Map();
  const paths=new Map(),strokes=new Map(),riverPaths=new Map(),riverTiles=new Map();
  function cached(cache,key,make){if(cache.has(key))return cache.get(key);const value=make();cache.set(key,value);if(cache.size>(cache===paths?30000:80000))cache.delete(cache.keys().next().value);return value;}
  function loadSources(){
    return Promise.all([loadLookupScript('vector-map.js'),loadLookupScript('vector-rivers.js'),loadLookupScript('meta.js'),loadLookupScript('paint-meta.js')]);
  }
  async function ready(){
    if(!readyPromise)readyPromise=(async()=>{
      await loadSources();
      const bytes=Uint8Array.from(atob(window.MapVectorSource),c=>c.charCodeAt(0));
      const text=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
      const data=JSON.parse(text);
      if(data.version!==1||data.width!==window.MapTemplate.width||data.height!==window.MapTemplate.height)throw new Error('矢量地图版本不匹配。');
      const bounds=points=>{let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;for(let i=0;i<points.length;i+=2){x0=Math.min(x0,points[i]);x1=Math.max(x1,points[i]);y0=Math.min(y0,points[i+1]);y1=Math.max(y1,points[i+1]);}return[x0,y0,x1,y1];};
      const riverBytes=Uint8Array.from(atob(window.MapRiverVectorSource),c=>c.charCodeAt(0));
      const riverData=JSON.parse(await new Response(new Blob([riverBytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
      if(riverData.version!==1||riverData.width!==data.width||riverData.height!==data.height)throw new Error('河流矢量数据与底图不匹配。');
      data.rivers=riverData.rings.map((points,id)=>({id,points,box:bounds(points)}));
      data.riverTiles=(riverData.tiles||[data.rivers.map(r=>r.id)]).map((rings,id)=>{
        const box=[Infinity,Infinity,-Infinity,-Infinity];
        for(const index of rings){const b=data.rivers[index].box;box[0]=Math.min(box[0],b[0]);box[1]=Math.min(box[1],b[1]);box[2]=Math.max(box[2],b[2]);box[3]=Math.max(box[3],b[3]);}
        return{id,rings,box};
      });
      data.arcs.forEach(arc=>arc.push(bounds(arc[2])));
      data.locations=Object.entries(data.rings).map(([key,rings])=>{const box=[Infinity,Infinity,-Infinity,-Infinity];let points=0;for(const ring of rings)for(const index of ring){const arc=data.arcs[Math.abs(index)-1],b=arc[3];points+=arc[2].length/2;box[0]=Math.min(box[0],b[0]);box[1]=Math.min(box[1],b[1]);box[2]=Math.max(box[2],b[2]);box[3]=Math.max(box[3],b[3]);}return{id:Number(key),rings,box,points};});
      // Nearby shapes give each canvas batch a much smaller pixel footprint.
      const columns=Math.ceil(data.width/512);
      const tile=box=>Math.floor((box[1]+box[3])/1024)*columns+Math.floor((box[0]+box[2])/1024);
      for(const location of data.locations)location.tile=tile(location.box);
      data.locations.sort((a,b)=>a.tile-b.tile);
      const arcTiles=data.arcs.map(arc=>tile(arc[3]));
      data.arcOrder=arcTiles.map((_,index)=>index).sort((a,b)=>arcTiles[a]-arcTiles[b]);
      data.arcTiles=arcTiles;
      geometry=data;return data;
    })().catch(error=>{readyPromise=null;throw error;});
    return readyPromise;
  }
  // Round only within 0.45 source pixels of a vertex, preserving shared endpoints
  // and small islands. Reversing an arc describes exactly the same curve.
  function append(path,coordinates,reverse=false,move=true){
    const n=coordinates.length/2,point=i=>{const j=(reverse?n-1-i:i)*2;return[coordinates[j],coordinates[j+1]];};
    const first=point(0);if(move)path.moveTo(...first);else path.lineTo(...first);
    for(let i=1;i<n-1;i++){
      const prev=point(i-1),p=point(i),next=point(i+1),a=Math.hypot(prev[0]-p[0],prev[1]-p[1]),b=Math.hypot(next[0]-p[0],next[1]-p[1]);
      if(!a||!b){path.lineTo(...p);continue;}
      const radius=Math.min(.45,a/2,b/2);
      path.lineTo(p[0]+(prev[0]-p[0])*radius/a,p[1]+(prev[1]-p[1])*radius/a);
      path.quadraticCurveTo(...p,p[0]+(next[0]-p[0])*radius/b,p[1]+(next[1]-p[1])*radius/b);
    }
    path.lineTo(...point(n-1));
  }
  function locationPath(location){return cached(paths,location.id,()=>{const path=new Path2D();for(const ring of location.rings){ring.forEach((index,i)=>append(path,geometry.arcs[Math.abs(index)-1][2],index<0,i===0));path.closePath();}return path;});}
  function riverPath(river){return cached(riverPaths,river.id,()=>{
    const path=new Path2D(),points=river.points,n=points.length/2-1;
    for(let i=0;i<n;i++){
      const previous=(i+n-1)%n,next=(i+1)%n,x=points[i*2],y=points[i*2+1];
      const dx=points[previous*2]-x,dy=points[previous*2+1]-y,ex=points[next*2]-x,ey=points[next*2+1]-y;
      const a=Math.hypot(dx,dy),b=Math.hypot(ex,ey),radius=Math.min(.4,a/2,b/2);
      if(!a||!b)continue;
      const px=x+dx*radius/a,py=y+dy*radius/a;
      if(i===0)path.moveTo(px,py);else path.lineTo(px,py);
      path.quadraticCurveTo(x,y,x+ex*radius/b,y+ey*radius/b);
    }
    path.closePath();return path;
  });}
  const visible=(b,v)=>b[2]>=v[0]&&b[0]<=v[2]&&b[3]>=v[1]&&b[1]<=v[3];
  // Bound each GPU draw's complexity. Merging the whole world into one Path2D
  // can silently fail in Chromium at overview zoom, leaving only the ocean.
  function batchAdd(batches,path,points,tile){
    let batch=batches.at(-1);if(!batch||batch.tile!==tile||batch.points+points>6000){batch={path:new Path2D(),points:0,tile};batches.push(batch);}
    batch.path.addPath(path);batch.points+=points;
  }
  function drawLand(context,data,view,{owners,countries,colors},kinds,pixelScale){
    const groups=new Map();
    for(const location of data.locations){
      if(!visible(location.box,view))continue;
      const color=countries.get(owners[location.id])||(kinds[location.id]===2?colors.wasteland:'#ffffff');
      if(!groups.has(color))groups.set(color,[]);batchAdd(groups.get(color),locationPath(location),location.points,location.tile);
    }
    context.lineJoin='round';context.lineCap='round';
    // Fill the antialias seam between adjacent same-color polygons, before borders.
    context.lineWidth=.45/pixelScale;
    for(const[color,batches]of groups){context.fillStyle=context.strokeStyle=color;for(const{path}of batches){context.fill(path);context.stroke(path);}}
  }
  function drawBorders(context, data, view, { owners, countries, countryRoots, level, colors }, kinds, pixelScale) {
    const meta = window.MapDesignerData.meta;
    const fine = [], coarse = [];
    const countryMode = level === 'countries';
    const parent = meta.parentOrder.indexOf(level);
    for (const i of data.arcOrder) {
      const [right, left, points, box] = data.arcs[i];
      if (!right || !left || kinds[right] === 1 || kinds[left] === 1 || !visible(box, view)) continue;
      let batches = fine;
      if (countryMode) {
        const rightCountry = countries.has(owners[right]) ? owners[right] : null;
        const leftCountry = countries.has(owners[left]) ? owners[left] : null;
        if (rightCountry === leftCountry || (!rightCountry && kinds[right] === 2) || (!leftCountry && kinds[left] === 2)) continue;
        const rightRoot = countryRoots?.get(rightCountry);
        if (!rightRoot || rightRoot !== countryRoots?.get(leftCountry)) batches = coarse;
      }
      const path = cached(strokes, i, () => {
        const path = new Path2D();
        append(path, points);
        return path;
      });
      const tile = data.arcTiles[i];
      batchAdd(batches, path, points.length / 2, tile);
      if (parent >= 0) {
        const a = meta.locations[right]?.[2]?.[parent], b = meta.locations[left]?.[2]?.[parent];
        if (a && b && a !== b) batchAdd(coarse, path, points.length / 2, tile);
      }
    }
    context.lineJoin = 'round';
    context.lineCap = 'round';
    const line = Math.max(.8, .55 / pixelScale);
    context.lineWidth = line;
    if (fine.length) {
      context.save();
      context.strokeStyle = countryMode ? '#000000' : colors.fineBorder;
      if (countryMode) {
        const unit = Math.max(line, 1 / pixelScale);
        // Round caps turn the very short mark into a dot.
        context.setLineDash([3.5 * unit, 3.1 * unit, .12 * unit, 3.1 * unit]);
      }
      for (const { path } of fine) context.stroke(path);
      context.restore();
    }
    context.lineWidth = line * (countryMode ? 1.5 : 2);
    context.strokeStyle = countryMode ? colors.countryBorder : colors.coarseBorder;
    for (const { path } of coarse) context.stroke(path);
  }
  function drawGroupOutlines(context, data, view, { owners, countries, groups }, kinds) {
    const memberships = new Map();
    const outlines = groups.map(group => ({ color: group.color, batches: [] }));
    for (const [index, group] of groups.entries()) {
      for (const id of group.memberIds) {
        if (!memberships.has(id)) memberships.set(id, new Set());
        memberships.get(id).add(index);
      }
    }
    if (!memberships.size) return;

    const lineWidth = 9.6;
    const margin = lineWidth / 2;
    const bounds = [view[0] - margin, view[1] - margin, view[2] + margin, view[3] + margin];
    for (const index of data.arcOrder) {
      const [right, left, points, box] = data.arcs[index];
      // Open water and coastlines have no land plot on at least one side.
      if (!right || !left || kinds[right] === 1 || kinds[left] === 1) continue;
      const rightGroups = memberships.get(owners[right]);
      const leftGroups = memberships.get(owners[left]);
      if (rightGroups === leftGroups || !visible(box, bounds)) continue;
      if ((kinds[right] === 2 && !countries.has(owners[right])) ||
          (kinds[left] === 2 && !countries.has(owners[left]))) continue;
      const addExterior = (inside, outside) => {
        if (!inside) return;
        for (const groupIndex of inside) {
          if (outside?.has(groupIndex)) continue;
          const path = cached(strokes, index, () => {
            const path = new Path2D();
            append(path, points);
            return path;
          });
          batchAdd(outlines[groupIndex].batches, path, points.length / 2, data.arcTiles[index]);
        }
      };
      addExterior(rightGroups, leftGroups);
      addExterior(leftGroups, rightGroups);
    }

    context.save();
    context.lineJoin = 'round';
    context.lineCap = 'round';
    context.lineWidth = lineWidth;
    context.globalAlpha = .5;
    for (const { color, batches } of outlines) {
      context.strokeStyle = color;
      for (const { path } of batches) context.stroke(path);
    }
    context.restore();
  }
  function drawRivers(context,data,view,color){
    // Preserve the complete footprint, including varying width, junctions and
    // islands inside braided rivers. Ownership never participates in this fill.
    let visibleRivers=0;context.fillStyle=color;
    for(const tile of data.riverTiles)if(visible(tile.box,view)){
      const path=cached(riverTiles,tile.id,()=>{const path=new Path2D();for(const id of tile.rings)path.addPath(riverPath(data.rivers[id]));return path;});
      context.fill(path);visibleRivers+=tile.rings.length;
    }
    return visibleRivers;
  }
  async function render(context,frame){
    const {scale,offsetX,offsetY,width,height,ratio,level,colors,paintRevision}=frame;
    const [data, texture] = await Promise.all([ready(), window.MapStyles.load(colors.style)]);
    const pixelScale=ratio*scale, pixelX=ratio*offsetX, pixelY=ratio*offsetY;
    const view=[-offsetX/scale-3,-offsetY/scale-3,(width-offsetX)/scale+3,(height-offsetY)/scale+3];
    const canvas=context.canvas;
    const kinds=window.MapDesignerData.paintMeta.kinds;
    const transform=target=>target.setTransform(pixelScale,0,0,pixelScale,pixelX,pixelY);
    const viewKey=JSON.stringify([pixelScale,pixelX,pixelY,canvas.width,canvas.height]);
    // The viewport worker can keep the last raster for each layer. Changing the
    // style or water color then reuses the expensive land and border passes.
    function layer(name,settings,draw){
      if (!frame.cacheLayers) return draw(context);
      const key=JSON.stringify([viewKey,...settings]);
      let entry=viewportLayers.get(name);
      if (entry?.key!==key) {
        const buffer=entry?.buffer || new OffscreenCanvas(canvas.width,canvas.height);
        if(buffer.width!==canvas.width)buffer.width=canvas.width;
        if(buffer.height!==canvas.height)buffer.height=canvas.height;
        const target=buffer.getContext('2d');
        target.setTransform(1,0,0,1,0,0);target.clearRect(0,0,buffer.width,buffer.height);transform(target);
        entry={key,buffer,result:draw(target)};viewportLayers.set(name,entry);
      }
      context.save();context.setTransform(1,0,0,1,0,0);
      context.drawImage(entry.buffer,0,0);context.restore();
      return entry.result;
    }
    context.setTransform(1,0,0,1,0,0);context.clearRect(0,0,canvas.width,canvas.height);
    transform(context);
    layer('land',[paintRevision,colors.wasteland,colors.vassalColorMode],target=>drawLand(target,data,view,frame,kinds,pixelScale));
    if(texture?.land){
      context.globalCompositeOperation='source-atop';
      context.drawImage(texture.land,0,0,data.width,data.height);
    }
    context.globalCompositeOperation='destination-over';
    if(texture?.ocean)context.drawImage(texture.ocean,0,0,data.width,data.height);
    context.fillStyle=colors.water;context.fillRect(0,0,data.width,data.height);
    context.setTransform(1,0,0,1,0,0);
    context.fillStyle='#e9edf1';context.fillRect(0,0,canvas.width,canvas.height);
    context.globalCompositeOperation='source-over';
    transform(context);
    const drawRiverLayer = () => layer('rivers', [colors.water], target => drawRivers(target, data, view, colors.water));
    let visibleRivers;
    if (level === 'countries') visibleRivers = drawRiverLayer();
    if(level!=='none'){
      if (level === 'countries' && frame.groups?.some(group => group.memberIds.length)) {
        layer('group-outlines', [paintRevision, frame.groupRevision], target => drawGroupOutlines(target, data, view, frame, kinds));
      }
      const borderColors=level==='countries'?[paintRevision,colors.countryBorder]:[colors.fineBorder,colors.coarseBorder];
      layer('borders',[level,...borderColors],target=>drawBorders(target,data,view,frame,kinds,pixelScale));
    }
    if (level !== 'countries') visibleRivers = drawRiverLayer();
    if(canvas.dataset){
      canvas.dataset.vectorRivers=String(visibleRivers);
      canvas.dataset.vector='true';
    }
    return visibleRivers;
  }
  function runWorker(install) {
    let canvas;
    const textures=new Map();
    self.MapStyles = { load: style => textures.get(style) };
    install(self, () => {});
    self.onmessage = async ({ data }) => {
      try {
        if (data.sources) Object.assign(self, data.sources);
        const { frame } = data;
        if (data.texture) textures.set(frame.colors.style,data.texture);
        const width = Math.ceil(frame.width * frame.ratio), height = Math.ceil(frame.height * frame.ratio);
        if (!canvas) canvas = new OffscreenCanvas(width, height);
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        const rivers = await self.VectorMap.render(canvas.getContext('2d'), { ...frame, cacheLayers: true });
        delete self.MapVectorSource;
        delete self.MapRiverVectorSource;
        const bitmap = canvas.transferToImageBitmap();
        const riverGeometry = data.sources ? (await self.VectorMap.ready()).rivers : undefined;
        self.postMessage({ bitmap, rivers, riverGeometry, stats: self.VectorMap.stats() }, [bitmap]);
      } catch (error) { self.postMessage({ error: error.message }); }
    };
  }
  async function renderViewport(context,frame,isCurrent){
    if (!workerUnavailable && typeof OffscreenCanvas !== 'undefined') {
      try {
        let sources;
        if (!viewportWorker) {
          await loadSources();
          const { meta, paintMeta } = window.MapDesignerData;
          const { width, height } = window.MapTemplate;
          sources = {
            MapTemplate: { width, height },
            MapDesignerData: { meta: { parentOrder: meta.parentOrder, locations: meta.locations }, paintMeta },
            MapVectorSource: window.MapVectorSource, MapRiverVectorSource: window.MapRiverVectorSource,
          };
          // A packaged desktop file:// page cannot reliably create a file URL worker.
          const url = URL.createObjectURL(new Blob([`(${runWorker})(${installVectorMap})`], { type: 'text/javascript' }));
          try { viewportWorker = new Worker(url); } finally { URL.revokeObjectURL(url); }
        }
        const style=frame.colors.style;
        let texture;
        if(style!=='classic'&&!workerStyles.has(style)){
          const {land,ocean}=await window.MapStyles.load(style);
          texture={land:await createImageBitmap(land),ocean:ocean?await createImageBitmap(ocean):null};
        }
        const result = await new Promise((resolve,reject)=>{
          viewportWorker.onmessage = ({data}) => data.error ? reject(new Error(data.error)) : resolve(data);
          viewportWorker.onerror = event => {event.preventDefault();reject(new Error('后台地图绘制失败。'));};
          viewportWorker.onmessageerror = reject;
          viewportWorker.postMessage({sources,frame,texture}, texture ? Object.values(texture).filter(Boolean) : []);
        });
        if(texture)workerStyles.add(style);
        workerStats = result.stats;
        workerRivers = result.riverGeometry ?? workerRivers;
        try {
          if (!isCurrent()) return;
          context.setTransform(1,0,0,1,0,0);
          context.clearRect(0,0,context.canvas.width,context.canvas.height);
          context.drawImage(result.bitmap,0,0);
          context.canvas.dataset.vectorRivers=String(result.rivers);
          context.canvas.dataset.vector='true';
          context.canvas.dataset.renderer='worker';
        } finally { result.bitmap.close(); }
        return;
      } catch {
        workerUnavailable = true;
        viewportWorker?.terminate();
        viewportWorker = null;
      }
    }
    if (isCurrent()) {
      await render(context,frame);
      context.canvas.dataset.renderer='main';
    }
  }
  window.VectorMap={ready,render,renderViewport,riverContains:(x,y)=>{
    const rivers=geometry?.rivers || workerRivers;
    if(!rivers)return false;const context=document.createElement('canvas').getContext('2d');let winding=0;
    for(const river of rivers)if(visible(river.box,[x,y,x,y])&&context.isPointInPath(riverPath(river),x,y)){
      // Clockwise outer rings and counterclockwise holes use nonzero winding.
      const p=river.points;let area=0;for(let i=0;i<p.length-2;i+=2)area+=p[i]*p[i+3]-p[i+2]*p[i+1];winding+=Math.sign(area);
    }
    return winding!==0;
  },stats:()=>geometry?{arcs:geometry.arcs.length,locations:geometry.locations.length,rivers:geometry.rivers.length,cachedPaths:paths.size,cachedStrokes:strokes.size,cachedRivers:riverPaths.size}:workerStats||null};
})(window, filename => loadLookupScript(filename));
