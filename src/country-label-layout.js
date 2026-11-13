/* Weighted land coverage, component grouping and upright name placement. */
(function(scope) {
  const pause=()=>new Promise(resolve=>setTimeout(resolve,0));
  const policy={minOwn:.6,minLand:.65,maxForeign:.1,majorRatio:.3};
  const qualifiesEnclave = (count, total) => count >= 8 && count >= total * .40;
  function labelBox(x,y,size,angle,width,height){
    const c=Math.cos(angle),s=Math.sin(angle),padding=size*.08+.3,hw=width*size/2+padding,hh=height*size/2+padding;
    return{x,y,c,s,hw,hh,ex:Math.abs(c)*hw+Math.abs(s)*hh,ey:Math.abs(s)*hw+Math.abs(c)*hh};
  }
  function collides(a,obstacles=[]){
    return obstacles.some(b=>{
      const dx=b.x-a.x,dy=b.y-a.y;
      if(Math.abs(dx)>=a.ex+b.ex||Math.abs(dy)>=a.ey+b.ey)return false;
      for(const[x,y]of [[a.c,a.s],[-a.s,a.c],[b.c,b.s],[-b.s,b.c]]){
        const ra=a.hw*Math.abs(x*a.c+y*a.s)+a.hh*Math.abs(-x*a.s+y*a.c);
        const rb=b.hw*Math.abs(x*b.c+y*b.s)+b.hh*Math.abs(-x*b.s+y*b.c);
        if(Math.abs(dx*x+dy*y)>=ra+rb)return false;
      }
      return true;
    });
  }
  function placementQuality(metrics,frame){
    const land=.35*metrics.land+.65*(metrics.inkLand??metrics.land);
    // A short sea crossing can join peer islands; mainland labels should pay
    // a much stronger cost for putting actual letters beyond the coastline.
    const water=frame.pieces.length>1?.55+.45*land:.25+.75*land**3;
    const domestic=.3*metrics.own+.7*(metrics.inkOwn??metrics.own);
    const foreign=.3*metrics.foreign+.7*(metrics.inkForeign??metrics.foreign);
    return (.25+.75*domestic**2)*(1-foreign*3)*water*(1-metrics.waste*.08);
  }
  async function compute(geometry,request,cancelled=()=>false) {
    const {width:W,height:H,step,patterns,grid}=geometry;
    // Unnamed countries must still count as foreign territory.
    const ownerIds=new Map([...new Set(Object.values(request.owners))].map((id,index)=>[id,index+1]));
    const capitalOwners=new Map(request.countries.filter(country=>country.capital&&request.owners[country.capital.locationId]===country.id).map(country=>[ownerIds.get(country.id),country.capital]));
    const capitalPieces=new Map(),nearCapitalPieces=new Map();
    const locations=new Map(Object.entries(request.owners).map(([id,owner])=>[Number(id),ownerIds.get(owner)]));
    const enclaveOwners = new Set(request.countries.filter(country => Object.keys(country.enclaveLayouts || {}).length).map(country => ownerIds.get(country.id)));
    const shares=new Array(patterns.length),primary=new Uint32Array(patterns.length),primaryShare=new Float32Array(patterns.length),totalOwned=new Float32Array(patterns.length);
    const emptyShares=new Map();
    for(let p=0;p<patterns.length;p++) {
      const ids=patterns[p],weights=geometry.weights?.[p];let sum=null;
      const total=weights?weights.reduce((a,b)=>a+b,0):ids.length;
      for(let i=0;i<ids.length;i++) {const owner=locations.get(ids[i]);if(owner){if(!sum)sum=new Map();sum.set(owner,(sum.get(owner)||0)+(weights?weights[i]:1)/total);}}
      shares[p]=sum||emptyShares;
      for(const [owner,share] of shares[p]){totalOwned[p]+=share;if(share>primaryShare[p]){primary[p]=owner;primaryShare[p]=share;}}
      if(primaryShare[p]<.5)primary[p]=0;
    }
    const landAt=index=>geometry.land?geometry.land[index]/255:(patterns[grid[index]].length?1:0);
    const owners=new Uint32Array(grid.length),components=new Uint32Array(grid.length),queue=new Uint32Array(grid.length);
    for(let i=0;i<grid.length;i++)if(landAt(i)>.2)owners[i]=primary[grid[i]];
    const byOwner=new Map();let component=0;
    for(let start=0;start<owners.length;start++) {
      const owner=owners[start];if(!owner||components[start])continue;
      const id=++component;let head=0,tail=1;queue[0]=start;components[start]=id;
      const stats={id,owner,count:0,mass:0,minX:W,minY:H,maxX:0,maxY:0,sx:0,sy:0,sxx:0,syy:0,sxy:0,capitalDistance:Infinity,capitalNear:Infinity};
      const capital=capitalOwners.get(owner);
      const seenPatterns = request.enclaves && enclaveOwners.has(owner) ? new Set() : null;
      if (seenPatterns) stats.plots = new Set();
      while(head<tail) {
        const index=queue[head++],x=index%W,y=Math.floor(index/W),weight=primaryShare[grid[index]]*landAt(index);
        if (seenPatterns && !seenPatterns.has(grid[index])) {
          const pattern = grid[index];
          seenPatterns.add(pattern);
          for (const plot of patterns[pattern]) {
            if (locations.get(plot) === owner && request.enclaves.plots[plot]) stats.plots.add(plot);
          }
        }
        if(capital){const distance=(x+.5-capital.x/step)**2+(y+.5-capital.y/step)**2;stats.capitalNear=Math.min(stats.capitalNear,distance);if(patterns[grid[index]].includes(capital.locationId))stats.capitalDistance=Math.min(stats.capitalDistance,distance);}
        stats.count++;stats.mass+=weight;stats.minX=Math.min(stats.minX,x);stats.maxX=Math.max(stats.maxX,x);stats.minY=Math.min(stats.minY,y);stats.maxY=Math.max(stats.maxY,y);
        stats.sx+=(x+.5)*weight;stats.sy+=(y+.5)*weight;stats.sxx+=(x+.5)**2*weight;stats.syy+=(y+.5)**2*weight;stats.sxy+=(x+.5)*(y+.5)*weight;
        for(const next of [x?index-1:-1,x<W-1?index+1:-1,y?index-W:-1,y<H-1?index+W:-1])if(next>=0&&owners[next]===owner&&!components[next]){components[next]=id;queue[tail++]=next;}
        if((head&65535)===0){await pause();if(cancelled())return [];}
      }
      if(capital){if(!capitalPieces.has(owner)||stats.capitalDistance<capitalPieces.get(owner).capitalDistance)capitalPieces.set(owner,stats);if(!nearCapitalPieces.has(owner)||stats.capitalNear<nearCapitalPieces.get(owner).capitalNear)nearCapitalPieces.set(owner,stats);}
      if(!byOwner.has(owner))byOwner.set(owner,[]);
      const list=byOwner.get(owner);list.push(stats);
      const retained = request.enclaves && enclaveOwners.has(owner) ? 64 : 24;
      if(list.length>retained+8){list.sort((a,b)=>b.mass-a.mass);list.length=retained;}
    }
    const environment={geometry,components,shares,totalOwned,landAt,obstacles:[]};
    await pause();if(cancelled())return [];
    const result=[];
    const enclaveJobs = [];
    function appendLabel(country, fitted, area, enclave = false) {
      const boxes=fitted.glyphs?fitted.glyphs.map(g=>labelBox(g.x,g.y,fitted.size,g.angle,g.width,g.height)):[labelBox(fitted.x,fitted.y,fitted.size,fitted.angle,fitted.layout.width,fitted.layout.height)];
      if(boxes.some(box=>collides(box,environment.obstacles)))return false;
      environment.obstacles.push(...boxes);
      result.push({id:country.id,x:fitted.x*step,y:fitted.y*step,fontSize:fitted.size*step,angle:fitted.angle,layout:fitted.layout,area:area*step*step,coverage:fitted.coverage,unspacedFontSize:fitted.originalSize?fitted.originalSize*step:undefined,glyphs:fitted.glyphs?.map(glyph=>({...glyph,x:glyph.x*step,y:glyph.y*step})),components:fitted.pieces.map(p=>({area:p.mass*step*step,x:p.sx/p.mass*step,y:p.sy/p.mass*step})),...(enclave?{enclave:true}:{})});
      return true;
    }
    // Give small countries space before fitting their larger neighbors. Stable
    // ordering keeps label placement independent of country-list sorting.
    const mass=country=>(byOwner.get(ownerIds.get(country.id))||[]).reduce((sum,p)=>sum+p.mass,0);
    const ordered=[...request.countries].sort((a,b)=>mass(a)-mass(b)||a.id.localeCompare(b.id));
    for(const country of ordered) {
      if(cancelled())return [];
      const pieces=(byOwner.get(ownerIds.get(country.id))||[]).sort((a,b)=>b.mass-a.mass);
      if(!pieces.length||!country.layouts.length)continue;
      const owner=ownerIds.get(country.id),hasCapital=capitalOwners.has(owner);
      let capitalPiece=hasCapital?capitalPieces.get(owner):null;
      if(capitalPiece&&!Number.isFinite(capitalPiece.capitalDistance))capitalPiece=null;
      if(hasCapital&&!capitalPiece){const nearby=nearCapitalPieces.get(owner);if(nearby?.capitalNear<=16)capitalPiece=nearby;}
      // A designated capital outranks overseas landmass size. If its tiny location cannot be fitted, hide the name instead of moving it to a colony.
      if(hasCapital&&!capitalPiece)continue;
      const chosen=hasCapital?[capitalPiece]:groupPieces(pieces),main=fitGroup([hasCapital?capitalPiece:pieces[0]],country.layouts,environment);
      const combined=!hasCapital&&chosen.length>1?fitGroup(chosen,country.layouts,environment):null;
      // Important nearby pieces get a joint title; a remote or impractical group falls back to its mainland.
      const combinedSize=combined?.originalSize||combined?.size,mainSize=main?.originalSize||main?.size;
      const fitted=combined&&(!main||combinedSize>=mainSize*.6)?combined:main;
      if(fitted)appendLabel(country,fitted,pieces.reduce((a,p)=>a+p.mass,0));
      if (request.enclaves && enclaveOwners.has(owner)) enclaveJobs.push({country, pieces, mainland:fitted?.pieces || [capitalPiece || pieces[0]]});
      await pause();
    }
    // Mainland labels take priority over any extra labels from outlying territories.
    for (const {country, pieces, mainland} of enclaveJobs) {
      const labeled = new Set();
      for (const cluster of enclaveClusters(pieces, mainland, request.enclaves, W * .025)) {
        if (cancelled()) return [];
        const {groups, plots} = request.enclaves;
        const counts = countGroups(cluster.flatMap(piece => [...piece.plots]), plots);
        const candidates = [...counts].filter(([key, count]) => country.enclaveLayouts[key] && !labeled.has(key) && qualifiesEnclave(count, groups[key].total));
        candidates.sort(([a, countA], [b, countB]) => groups[a].depth - groups[b].depth || countB - countA || a - b);
        for (const [key] of candidates) {
          const anchors = cluster.map(piece => ({piece, count: [...piece.plots].filter(plot => plots[plot].includes(key)).length}));
          anchors.sort((a,b) => b.count - a.count || b.piece.mass - a.piece.mass);
          let best = null;
          for (const {piece, count} of anchors.slice(0, 3)) {
            if (!count) break;
            const fitted = fitGroup([piece], country.enclaveLayouts[key], environment);
            if (fitted && fitted.size * step >= 10 && (!best || fitted.size > best.size)) best = fitted;
          }
          if (best && appendLabel(country, best, cluster.reduce((sum, piece) => sum + piece.mass, 0), true)) {
            labeled.add(key);
            break;
          }
        }
        await pause();
      }
    }
    return result;
  }
  function countGroups(plotIds, plots) {
    const counts = new Map();
    for (const id of new Set(plotIds)) {
      for (const key of plots[id]) if (key !== null) counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }
  function enclaveClusters(pieces, mainland, geography, minGap) {
    const clusters = new Map();
    for (const piece of pieces) {
      if (!piece.plots?.size || mainland.some(main => pieceGap(main, piece) < minGap)) continue;
      const counts = countGroups(piece.plots, geography.plots);
      const regions = [...counts].filter(([key]) => geography.groups[key].depth === geography.regionalDepth);
      regions.sort(([a, countA], [b, countB]) => countB - countA || a - b);
      const key = regions.length ? regions[0][0] : `piece-${piece.id}`;
      if (!clusters.has(key)) clusters.set(key, []);
      clusters.get(key).push(piece);
    }
    return clusters.values();
  }
  function pieceGap(a, b) {
    return Math.hypot(Math.max(0, a.minX - b.maxX - 1, b.minX - a.maxX - 1), Math.max(0, a.minY - b.maxY - 1, b.minY - a.maxY - 1));
  }
  function groupPieces(pieces) {
    const selected=[pieces[0]];
    for(const piece of pieces.slice(1)) {
      if(piece.mass<pieces[0].mass*policy.majorRatio)break;
      const nearby=selected.some(other=>{
        const gap=pieceGap(piece,other);
        const scale=Math.sqrt(piece.mass)+Math.sqrt(other.mass);
        const distance=Math.hypot(piece.sx/piece.mass-other.sx/other.mass,piece.sy/piece.mass-other.sy/other.mass);
        return gap<=Math.min(160,scale*.65)&&distance<=scale*2.2;
      });
      if(nearby)selected.push(piece);
      if(selected.length===4)break;
    }
    return selected;
  }
  function fitGroup(pieces,layouts,env) {
    const {geometry,components,shares,totalOwned,landAt}=env,W=geometry.width,H=geometry.height,owner=pieces[0].owner;
    const group={mass:0,sx:0,sy:0,sxx:0,syy:0,sxy:0,minX:W,minY:H,maxX:0,maxY:0};
    for(const piece of pieces){for(const key of ['mass','sx','sy','sxx','syy','sxy'])group[key]+=piece[key];group.minX=Math.min(group.minX,piece.minX);group.minY=Math.min(group.minY,piece.minY);group.maxX=Math.max(group.maxX,piece.maxX);group.maxY=Math.max(group.maxY,piece.maxY);}
    const padding=Math.max(2,Math.min(20,Math.ceil(Math.sqrt(group.mass)*.15)));
    const originX=Math.max(0,group.minX-padding),originY=Math.max(0,group.minY-padding),w=Math.min(W-1,group.maxX+padding)-originX+1,h=Math.min(H-1,group.maxY+padding)-originY+1;
    const channels=4+pieces.length,stride=w+1,prefix=Array.from({length:channels},()=>new Float32Array(stride*h));
    const memberIds=new Map(pieces.map((piece,index)=>[piece.id,index]));
    const distance=new Float32Array((w+2)*(h+2)),ds=w+2;
    for(let y=0;y<h;y++) {
      const sums=new Float64Array(channels);
      for(let x=0;x<w;x++) {
        const index=(originY+y)*W+originX+x,p=geometry.grid[index],land=landAt(index),own=(shares[p].get(owner)||0)*land,foreign=Math.max(0,totalOwned[p]*land-own),waste=geometry.waste?geometry.waste[index]/255:0;
        const member=memberIds.get(components[index]);
        sums[0]+=own;sums[1]+=foreign;sums[2]+=land;sums[3]+=waste;
        if(member!==undefined)sums[4+member]+=own;
        for(let c=0;c<channels;c++)prefix[c][y*stride+x+1]=sums[c];
        if(own>.5)distance[(y+1)*ds+x+1]=1e6;
      }
    }
    for(let y=1;y<=h;y++)for(let x=1;x<=w;x++){const i=y*ds+x;if(distance[i])distance[i]=Math.min(distance[i],distance[i-1]+1,distance[i-ds]+1,distance[i-ds-1]+Math.SQRT2,distance[i-ds+1]+Math.SQRT2);}
    for(let y=h;y>=1;y--)for(let x=w;x>=1;x--){const i=y*ds+x;if(distance[i])distance[i]=Math.min(distance[i],distance[i+1]+1,distance[i+ds]+1,distance[i+ds-1]+Math.SQRT2,distance[i+ds+1]+Math.SQRT2);}
    const meanX=group.sx/group.mass-originX,meanY=group.sy/group.mass-originY,tiles=new Map();let nearest=null;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++) {
      const d=distance[(y+1)*ds+x+1];if(!d)continue;
      const point={x:x+.5,y:y+.5,d},key=Math.min(4,Math.floor(x*5/w))+5*Math.min(4,Math.floor(y*5/h));
      if(!tiles.has(key)||tiles.get(key).d<d)tiles.set(key,point);
      point.central=(point.x-meanX)**2+(point.y-meanY)**2;if(!nearest||point.central<nearest.central)nearest=point;
    }
    const centers=[{x:meanX,y:meanY},...tiles.values()].sort((a,b)=>(b.d||1e7)-(a.d||1e7)).slice(0,11);
    if(nearest)centers.push(nearest);
    if(pieces.length>1){for(const piece of pieces)centers.push({x:piece.sx/piece.mass-originX,y:piece.sy/piece.mass-originY});for(let i=1;i<pieces.length;i++)centers.unshift({x:(pieces[0].sx/pieces[0].mass+pieces[i].sx/pieces[i].mass)/2-originX,y:(pieces[0].sy/pieces[0].mass+pieces[i].sy/pieces[i].mass)/2-originY});}
    const covariance=group.sxy/group.mass-(group.sx/group.mass)*(group.sy/group.mass),vx=group.sxx/group.mass-(group.sx/group.mass)**2,vy=group.syy/group.mass-(group.sy/group.mass)**2;
    // Text axes repeat every 180 degrees. Wrap rather than clamp, so a direction
    // just past vertical reads in the equivalent upright direction.
    const normalize=a=>{while(a>=Math.PI/2)a-=Math.PI;while(a< -Math.PI/2)a+=Math.PI;return a;};
    const principal=normalize(.5*Math.atan2(2*covariance,vx-vy));
    const spread=Math.hypot(vx-vy,2*covariance),elongation=Math.sqrt((vx+vy+spread)/Math.max(.001,vx+vy-spread));
    const slender=elongation>=3.5;
    const elongated=elongation>=2;
    const moderate=Math.max(-Math.PI/4,Math.min(Math.PI/4,principal));
    const candidates=elongated||pieces.length>1 ? [0,principal,-Math.PI/2,principal-Math.PI/12,principal+Math.PI/12,-Math.PI/4,Math.PI/4,-Math.PI/3,Math.PI/3,-Math.PI*5/12,Math.PI*5/12] : [0,moderate,-Math.PI/12,Math.PI/12,-Math.PI/6,Math.PI/6,-Math.PI/4,Math.PI/4];
    const angles=[...new Set(candidates.map(normalize))];
    const preferModerateTilt = elongated && !slender && pieces.length === 1;
    const frame={prefix,w,h,pieces,group,originX,originY,obstacles:env.obstacles};let best=null,horizontal=null;
    for(const layout of layouts)for(const angle of angles)for(const center of centers) {
      const c=Math.abs(Math.cos(angle)),s=Math.abs(Math.sin(angle));
      const hi=Math.min(w/(layout.width*c+layout.height*s),h/(layout.width*s+layout.height*c));
      const difference=Math.abs(angle-principal),axisDifference=Math.min(difference,Math.PI-difference);
      const alignment=slender ? 1-.35*axisDifference/(Math.PI/2) : 1-(.04+.65*Math.max(0,2-elongation))*Math.abs(angle)/(Math.PI/4);
      // Keep names together when one line fits at a comparable size.
      const linePreference = Math.pow(slender ? .55 : .72, layout.lines.length - 1);
      // For moderately elongated mainland shapes, a steep title should offer a clear improvement.
      const tiltPreference = preferModerateTilt && Math.abs(angle) > Math.PI / 4 ? .85 : 1;
      const penalty=linePreference*alignment*tiltPreference*(1-Math.abs(angle)/100)*(1-Math.min(.18,Math.hypot(center.x-meanX,center.y-meanY)/Math.hypot(w,h)*.2));
      const incumbent=angle===0?horizontal:best;
      if(incumbent&&hi*penalty<incumbent.score)continue;
      let larger=hi,found=null;
      // Coverage need not be monotonic: a small box over a strait can fail while a larger one spans both shores.
      for(let size=hi,i=0;i<18;i++,size*=.82) {
        if(incumbent&&size*penalty<incumbent.score*.92)break;
        const metrics=evaluate(center.x,center.y,size,angle,layout,frame);
        if(metrics){found={size,metrics};break;}larger=size;
      }
      if(!found)continue;
      let low=found.size,high=larger;
      for(let i=0;i<4;i++){const size=(low+high)/2,metrics=evaluate(center.x,center.y,size,angle,layout,frame);if(metrics){low=size;found={size,metrics};}else high=size;}
      const coverage=found.metrics;
      const quality=placementQuality(coverage,frame);
      const score=found.size*penalty*quality;
      if(angle===0&&(!horizontal||score>horizontal.score))horizontal={x:originX+center.x,y:originY+center.y,size:found.size,score,angle,layout,coverage,pieces};
      if(!best||score>best.score)best={x:originX+center.x,y:originY+center.y,size:found.size,score,angle,layout,coverage,pieces};
    }
    // Prefer horizontal when the difference is marginal; let a clearly better
    // moderate tilt win, even for countries below the extreme-slender threshold.
    if(!slender&&pieces.length===1&&horizontal&&best.score<horizontal.score*1.02)best=horizontal;
    if(best&&slender) {
      const minorRadius=Math.sqrt(Math.max(.01,(vx+vy-spread)/2));
      const spaced=fitSpaced(layouts,principal,best,frame,env,{originX,originY,w,h,memberIds,distance,ds,minorRadius});
      if(spaced)return spaced;
      // A one-character name cannot be tracked, but should still avoid an oversized glyph.
      let compact=null;
      for(const layout of layouts)for(const angle of [principal,best.angle])for(const center of centers) {
        const size=Math.min(best.size*.65,minorRadius*1.5),metrics=evaluate(center.x,center.y,size,angle,layout,frame);
        if(!metrics)continue;
        const score=placementQuality(metrics,frame)*(1-Math.min(.2,Math.hypot(center.x-meanX,center.y-meanY)/Math.hypot(w,h)*.2));
        if(!compact||score>compact.score)compact={x:originX+center.x,y:originY+center.y,size,originalSize:best.size,score,angle,layout,coverage:metrics,pieces};
      }
      if(compact)return compact;
    }
    if(best&&!slender) {
      // Leave comfortable breathing room around compact countries' names.
      const area=group.mass*env.geometry.step**2;
      const largeFactor=1-.28*Math.max(0,Math.min(1,(Math.sqrt(area)-180)/320));
      const target=best.size*.78*largeFactor;
      // A smaller box over a strait can lose its domestic majority. Try nearby
      // valid centers rather than keeping an oversized or water-dominated name.
      let reduced=null;
      const options=[{x:best.x-originX,y:best.y-originY},...centers].sort((a,b)=>Math.hypot(a.x-(best.x-originX),a.y-(best.y-originY))-Math.hypot(b.x-(best.x-originX),b.y-(best.y-originY)));
      for(let size=target;size<best.size&&!reduced;size*=1.08)for(const center of options){
        const metrics=evaluate(center.x,center.y,size,best.angle,best.layout,frame);if(!metrics)continue;
        const score=placementQuality(metrics,frame)*(1-Math.min(.15,Math.hypot(center.x-meanX,center.y-meanY)/Math.hypot(w,h)*.15));
        if(!reduced||score>reduced.score)reduced={...best,x:originX+center.x,y:originY+center.y,size,score,coverage:metrics};
      }
      if(reduced)best=reduced;
      // The small trial size above only chooses a good inland center. Refit at
      // that center instead of treating multiple shrink factors as final size.
      const selected=best,baseQuality=placementQuality(selected.coverage,frame);
      const c=Math.abs(Math.cos(best.angle)),s=Math.abs(Math.sin(best.angle));
      const areaFraction=.22+.28*(1-Math.max(0,Math.min(1,(area-100000)/50000)));
      const areaCap=Math.sqrt(group.mass*areaFraction/(best.layout.width*best.layout.height));
      const ceiling=Math.min(w/(best.layout.width*c+best.layout.height*s),h/(best.layout.width*s+best.layout.height*c),areaCap/.96);
      let refitted=null;
      for(const center of options){
        const accepts=size=>{
          const metrics=evaluate(center.x,center.y,size,selected.angle,selected.layout,frame);
          if(!metrics||placementQuality(metrics,frame)<baseQuality*.85)return null;
          const ownFloor=pieces.length>1?policy.minOwn:.85,inkFloor=pieces.length>1?policy.minOwn:.88;
          if(metrics.own<Math.max(ownFloor,selected.coverage.own-.035)||(metrics.inkOwn??metrics.own)<Math.max(inkFloor,(selected.coverage.inkOwn??selected.coverage.own)-.035))return null;
          if(metrics.land<Math.min(.95,selected.coverage.land-.01)||(metrics.inkLand??metrics.land)<Math.min(.95,(selected.coverage.inkLand??selected.coverage.land)-.01))return null;
          return metrics;
        };
        let safe=selected.size,metrics=accepts(safe),limit=ceiling;if(!metrics)continue;
        while(safe<ceiling){
          const next=Math.min(ceiling,safe*1.12),candidate=accepts(next);
          if(!candidate){limit=next;break;}
          safe=next;metrics=candidate;
        }
        if(safe<limit)for(let i=0;i<5;i++){const size=(safe+limit)/2,candidate=accepts(size);if(candidate){safe=size;metrics=candidate;}else limit=size;}
        // One breathing margin after fitting, with the same territory checks.
        const comfortable=Math.max(selected.size,safe*.96),comfortableMetrics=accepts(comfortable);
        const size=comfortableMetrics?comfortable:safe,coverage=comfortableMetrics||metrics;
        const score=size*(.75+.25*placementQuality(coverage,frame))*(1-Math.min(.05,Math.hypot(center.x-meanX,center.y-meanY)/Math.hypot(w,h)*.05));
        if(!refitted||score>refitted.score)refitted={...selected,x:originX+center.x,y:originY+center.y,size,score,coverage};
      }
      if(refitted)best=refitted;
    }
    return best;
  }
  function fitSpaced(layouts,angle,base,frame,env,local) {
    const layout=layouts.find(item=>item.lines.length===1&&item.units?.length>=2);
    if(!layout)return null;
    const {originX,originY,w,h,memberIds,distance,ds,minorRadius}=local,{group,pieces}=frame;
    const centerX=group.sx/group.mass,centerY=group.sy/group.mass,c=Math.cos(angle),s=Math.sin(angle);
    const cells=[];let minT=Infinity,maxT=-Infinity;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++) {
      const index=(originY+y)*env.geometry.width+originX+x;
      if(!memberIds.has(env.components[index])||distance[(y+1)*ds+x+1]===0)continue;
      const dx=originX+x+.5-centerX,dy=originY+y+.5-centerY,t=dx*c+dy*s,u=-dx*s+dy*c;
      cells.push({x:x+.5,y:y+.5,t,u,d:distance[(y+1)*ds+x+1]});minT=Math.min(minT,t);maxT=Math.max(maxT,t);
    }
    if(cells.length<layout.units.length||maxT-minT<2)return null;
    // A weighted axis histogram keeps tiny tips from dictating the endpoints.
    const bins=new Uint32Array(100);
    for(const cell of cells)bins[Math.min(99,Math.floor((cell.t-minT)/(maxT-minT)*100))]++;
    function quantile(fraction){let count=0;for(let i=0;i<100;i++){count+=bins[i];if(count>=cells.length*fraction)return minT+(i+.5)/100*(maxT-minT);}return maxT;}
    const start=quantile(.08),end=quantile(.92),axisSpan=end-start;
    if(axisSpan<=0)return null;
    const initialSize=Math.min(base.size*.65,minorRadius*1.5,axisSpan/Math.max(1,layout.units.reduce((sum,unit)=>sum+unit.width,0)*1.15));
    for(let attempt=0,size=initialSize;attempt<7;attempt++,size*=.86) {
      const span=layout.wideSpacing?axisSpan:Math.min(axisSpan,size*(layout.units.reduce((sum,unit)=>sum+unit.width,0)+(layout.units.length-1)*1.25));
      const middle=(start+end)/2,interval=span/(layout.units.length-1),glyphs=[],sums={own:0,foreign:0,land:0,waste:0,members:new Array(pieces.length).fill(0)};
      if(interval<size*Math.max(...layout.units.map(unit=>unit.width))*1.15)continue;
      // Solve the word as a whole rather than placing each glyph greedily.
      // The shared gap range applies to visible spaces between glyphs/words.
      const columns=[];let failed=false;
      for(let i=0;i<layout.units.length;i++) {
        const unit=layout.units[i],target=middle-span/2+interval*i;
        const stripe=cells.filter(cell=>Math.abs(cell.t-target)<=Math.max(1,interval*.42));
        if(!stripe.length){failed=true;break;}
        const meanU=stripe.reduce((sum,cell)=>sum+cell.u,0)/stripe.length;
        const cost=p=>((p.t-target)/Math.max(1,interval))**2*8+((p.u-meanU)/Math.max(1,size*2))**2-.15*Math.min(2,p.d/Math.max(.5,size));
        const candidates=stripe.map(cell=>({cell,cost:cost(cell)})).sort((a,b)=>a.cost-b.cost).slice(0,36).map(item=>item.cell);
        const column=[];
        for(const cell of candidates) {
          if(collides(labelBox(originX+cell.x,originY+cell.y,size,angle,unit.width,unit.height),frame.obstacles))continue;
          const metrics=coverage(cell.x,cell.y,unit.width*size/2,unit.height*size/2,angle,frame);
          if(!valid(metrics,frame,false))continue;
          const box=unit.inkBox,bx=(box.left+box.right)*size/2,by=(box.top+box.bottom)*size/2;
          const ink=coverage(cell.x+bx*c-by*s,cell.y+bx*s+by*c,(box.right-box.left)*size/2,(box.bottom-box.top)*size/2,angle,frame);
          if(!valid(ink,frame,false)||metrics.own<.85||ink.own<.88)continue;
          const score=placementQuality({...metrics,inkOwn:ink.own,inkForeign:ink.foreign,inkLand:ink.land},frame)/(1+cost(cell)*.12);
          column.push({cell,metrics,unit,score});
        }
        if(!column.length){failed=true;break;}columns.push(column);
      }
      if(failed)continue;
      let beam=[{path:[],score:0,min:Infinity,max:0,rank:0}];
      for(const column of columns){
        const next=[];
        for(const state of beam)for(const candidate of column){
          const last=state.path.at(-1);let min=state.min,max=state.max;
          if(last){
            const separation=Math.max(interval*.4,(last.unit.width+candidate.unit.width)*size/2+size*.2);
            if(candidate.cell.t<=last.cell.t+separation)continue;
            const gap=Math.hypot(candidate.cell.x-last.cell.x,candidate.cell.y-last.cell.y)-(last.unit.width+candidate.unit.width)*size/2;
            if(gap<size*.2)continue;min=Math.min(min,gap);max=Math.max(max,gap);
            if(max/min>1.25)continue;
          }
          const path=[...state.path,candidate],score=state.score+candidate.score;
          const rank=score/path.length-(Number.isFinite(min)?.7*(max/min-1):0);
          next.push({path,score,min,max,rank});
        }
        next.sort((a,b)=>b.rank-a.rank);beam=next.slice(0,64);
        if(!beam.length)break;
      }
      if(!beam.length||beam[0].path.length!==layout.units.length)continue;
      let totalArea=0;
      for(const{cell,metrics,unit}of beam[0].path){
        const area=unit.width*unit.height*size*size;totalArea+=area;
        for(const key of ['own','foreign','land','waste'])sums[key]+=metrics[key]*area;
        for(let j=0;j<sums.members.length;j++)sums.members[j]+=metrics.members[j]*area;
        glyphs.push({text:unit.text,x:originX+cell.x,y:originY+cell.y,angle,width:unit.width,height:unit.height,baseline:unit.baseline});
      }
      for(const key of ['own','foreign','land','waste'])sums[key]/=totalArea;for(let j=0;j<sums.members.length;j++)sums.members[j]/=totalArea;
      if(!valid(sums,frame))continue;
      // Do not count empty space between characters as ink or as a border violation.
      const first=glyphs[0],last=glyphs.at(-1),cx=(first.x+last.x)/2,cy=(first.y+last.y)/2;
      let halfW=0,halfH=0;
      for(const glyph of glyphs){const dx=glyph.x-cx,dy=glyph.y-cy;halfW=Math.max(halfW,Math.abs(dx*c+dy*s)+glyph.width*size/2);halfH=Math.max(halfH,Math.abs(-dx*s+dy*c)+glyph.height*size/2);}
      return {x:cx,y:cy,size,originalSize:base.size,score:base.score,angle,layout:{...layout,width:halfW*2/size,height:halfH*2/size},coverage:sums,pieces,glyphs};
    }
    return null;
  }
  function valid(metrics,frame,checkMembers=true) {
    if(!metrics||metrics.own<policy.minOwn||metrics.land<policy.minLand||metrics.foreign>policy.maxForeign)return false;
    if(checkMembers&&frame.pieces.length>1)for(let i=0;i<frame.pieces.length;i++)if(metrics.members[i]/Math.max(metrics.own,1e-8)<Math.min(.12,frame.pieces[i].mass/frame.group.mass*.45))return false;
    return true;
  }
  function evaluate(x,y,size,angle,layout,frame) {
    if(collides(labelBox(x+frame.originX,y+frame.originY,size,angle,layout.width,layout.height),frame.obstacles))return null;
    const metrics=coverage(x,y,layout.width*size/2,layout.height*size/2,angle,frame);
    if(!valid(metrics,frame))return null;
    if(layout.inkBoxes?.length){
      const sums={own:0,foreign:0,land:0,waste:0,members:new Array(frame.pieces.length).fill(0)},c=Math.cos(angle),s=Math.sin(angle);let total=0;
      for(const box of layout.inkBoxes){
        const bx=(box.left+box.right)*size/2,by=(box.top+box.bottom)*size/2,hw=(box.right-box.left)*size/2,hh=(box.bottom-box.top)*size/2;
        const part=coverage(x+bx*c-by*s,y+bx*s+by*c,hw,hh,angle,frame);if(!part)return null;
        const area=hw*hh*4;total+=area;for(const key of ['own','foreign','land','waste'])sums[key]+=part[key]*area;for(let i=0;i<sums.members.length;i++)sums.members[i]+=part.members[i]*area;
      }
      for(const key of ['own','foreign','land','waste'])sums[key]/=total;for(let i=0;i<sums.members.length;i++)sums.members[i]/=total;
      if(!valid(sums,frame))return null;
      metrics.inkOwn=sums.own;metrics.inkForeign=sums.foreign;metrics.inkLand=sums.land;
    }
    return metrics;
  }
  function coverage(x,y,hw,hh,angle,{prefix,w,h,pieces}) {
    const c=Math.cos(angle),s=Math.sin(angle),polygon=[[-hw,-hh],[hw,-hh],[hw,hh],[-hw,hh]].map(([a,b])=>[x+a*c-b*s,y+a*s+b*c]);
    const minY=Math.min(...polygon.map(p=>p[1])),maxY=Math.max(...polygon.map(p=>p[1]));
    if(minY<0||maxY>h||polygon.some(p=>p[0]<0||p[0]>w))return null;
    const sums=new Float64Array(prefix.length);let area=0;
    for(let row=Math.floor(minY);row<Math.ceil(maxY);row++) {
      const top=Math.max(row,minY),bottom=Math.min(row+1,maxY),sample=(top+bottom)/2;let left=Infinity,right=-Infinity;
      for(let i=0;i<4;i++) {
        const a=polygon[i],b=polygon[(i+1)%4];if((a[1]<=sample&&b[1]>sample)||(b[1]<=sample&&a[1]>sample)){const at=a[0]+(sample-a[1])*(b[0]-a[0])/(b[1]-a[1]);left=Math.min(left,at);right=Math.max(right,at);}
      }
      if(!Number.isFinite(left)||right<=left)continue;
      left=Math.max(0,left);right=Math.min(w,right);const start=Math.floor(left),end=Math.min(w,Math.ceil(right)),thickness=bottom-top,offset=row*(w+1);
      area+=(right-left)*thickness;
      for(let channel=0;channel<prefix.length;channel++) {
        const p=prefix[channel];let value=p[offset+end]-p[offset+start];
        if(left>start)value-=(left-start)*(p[offset+start+1]-p[offset+start]);
        if(end>right)value-=(end-right)*(p[offset+end]-p[offset+end-1]);
        sums[channel]+=value*thickness;
      }
    }
    if(area<.01)return null;
    return {own:sums[0]/area,foreign:sums[1]/area,land:sums[2]/area,waste:sums[3]/area,members:Array.from(sums.slice(4),n=>n/area)};
  }
  scope.CountryLabelLayout={compute,policy,qualifiesEnclave};
})(globalThis);
