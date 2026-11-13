const assert=require('node:assert/strict');
require('../src/country-label-layout.js');
const layout={lines:['TEST NAME'],width:5.4,height:1.1,baseline:.3,lineAdvance:1.1};
function world(width,height,mask){const grid=new Uint32Array(width*height);for(let y=0;y<height;y++)for(let x=0;x<width;x++)grid[y*width+x]=mask(x,y);return{width,height,step:8,patterns:[[],[1],[2],[3]],weights:[[],[64],[64],[64]],grid};}
const request={owners:{1:'a',2:'b'},countries:[{id:'a',layouts:[layout]}]};
async function fit(geometry){return(await CountryLabelLayout.compute(geometry,request))[0];}
function majority(label){assert.ok(label);assert.ok(label.coverage.own>=.6-1e-5);assert.ok(label.coverage.land>=.65-1e-5);assert.ok(label.coverage.foreign<=.1+1e-5);assert.ok(Math.abs(label.angle)<=Math.PI/2+1e-5);}
(async()=>{
 const fringe=world(100,70,(x,y)=>x>=20&&x<60&&y>=20&&y<50?1:x>=60&&x<64&&y>=20&&y<50?2:0);
 const loose=await fit(fringe);majority(loose);assert.ok(loose.fontSize/8<40/layout.width*1.05,'compact-country names should leave breathing room');
 const wilderness=world(100,70,(x,y)=>x>=20&&x<60&&y>=20&&y<50?1:x>=60&&x<66&&y>=20&&y<50?3:0);
 wilderness.land=Uint8Array.from(wilderness.grid,n=>n?255:0);wilderness.waste=Uint8Array.from(wilderness.grid,n=>n===3?255:0);
 const overWaste=await fit(wilderness);majority(overWaste);
 const vertical=world(100,100,(x,y)=>x>=45&&x<53&&y>=5&&y<93?1:0);
 const chile=await fit(vertical);majority(chile);assert.ok(Math.abs(chile.angle)>Math.PI*5/12,'long N/S territory should get a near-vertical name');
 const diagonal=world(100,100,(x,y)=>y>=8&&y<92&&Math.abs(x-(40+y*.15))<5?1:0);
 const vietnam=await fit(diagonal);majority(vietnam);assert.ok(Math.abs(vietnam.angle)>Math.PI/3);
 const compact=await fit(world(100,100,(x,y)=>x>=20&&x<75&&y>=15&&y<85?1:0));majority(compact);assert.equal(compact.angle,0,'compact countries should read horizontally');
 for(const sign of [-1,1]){
  const angle=sign*Math.PI/5,c=Math.cos(angle),s=Math.sin(angle);
  const sloped=await fit(world(120,120,(x,y)=>{const dx=x-60,dy=y-60,u=dx*c+dy*s,v=-dx*s+dy*c;return (u/42)**2+(v/19)**2<1?1:0;}));
  majority(sloped);assert.ok(Math.abs(sloped.angle)>=Math.PI/12&&Math.abs(sloped.angle)<=Math.PI/4,'moderately elongated diagonal countries should use a helpful tilt within 45 degrees');assert.equal(Math.sign(sloped.angle),sign);
 }
 const mirrored=await fit(world(100,100,(x,y)=>y>=8&&y<92&&Math.abs(x-(65-y*.15))<5?1:0));majority(mirrored);assert.ok(mirrored.angle< -Math.PI/3,'opposite slope should use the equivalent upright negative rotation');assert.ok(mirrored.angle>=-Math.PI/2);
 const uk=world(100,80,(x,y)=>x>=25&&x<48&&y>=10&&y<58?1:x>=13&&x<18&&y>=33&&y<39?1:0);
 const britain=await fit(uk);majority(britain);assert.equal(britain.components.length,1);assert.ok(britain.x/8>=25);
 const strait=world(100,80,(x,y)=>x>=20&&x<42&&y>=8&&y<30?1:x>=29&&x<59&&y>=35&&y<60?1:0);
 const union=await fit(strait);majority(union);assert.equal(union.components.length,2,'comparable shores should share one name');assert.ok(union.coverage.members.every(n=>n/union.coverage.own>.1));
 const remote=world(180,80,(x,y)=>x>=20&&x<42&&y>=8&&y<30?1:x>=130&&x<160&&y>=35&&y<60?1:0);
 const far=await fit(remote);majority(far);assert.equal(far.components.length,1,'do not join remote territories across a huge empty sea');
 const large=await fit(world(100,70,(x,y)=>x>5&&x<90&&y>10&&y<55?1:0));const small=await fit(world(100,70,(x,y)=>x>5&&x<35&&y>10&&y<25?1:0));assert.ok(large.fontSize>small.fontSize*1.5);
 assert.deepEqual(await CountryLabelLayout.compute(world(40,30,()=>0),request),[]);
 const unit=text=>({text,width:1.1,height:1,baseline:.3,inkBox:{left:-.5,right:.5,top:-.45,bottom:.45}});
 const trackedLayout={lines:['越南'],width:2.2,height:1,baseline:.3,lineAdvance:1.1,units:[unit('越'),unit('南')],wideSpacing:true};
 const tracked=(await CountryLabelLayout.compute(diagonal,{...request,countries:[{id:'a',layouts:[trackedLayout]}]}))[0];
 majority(tracked);assert.equal(tracked.glyphs.length,2);assert.ok(tracked.fontSize<=tracked.unspacedFontSize*.66);assert.ok(tracked.coverage.own>=.85,'separated characters should remain predominantly inside their own territory');
 assert.ok(Math.hypot(tracked.glyphs[1].x-tracked.glyphs[0].x,tracked.glyphs[1].y-tracked.glyphs[0].y)>tracked.fontSize*4,'characters should be spread over the long country');
 const curved=world(120,140,(x,y)=>y>=6&&y<132&&Math.abs(x-(42+y*.18+9*Math.sin(y/126*Math.PI)))<5?1:0);
 const fiveLayout={...trackedLayout,lines:['曲折测试国'],width:5.5,units:Array.from('曲折测试国',unit)};
 const even=(await CountryLabelLayout.compute(curved,{...request,countries:[{id:'a',layouts:[fiveLayout]}]}))[0];
 majority(even);assert.equal(even.glyphs?.length,5);
 const gaps=even.glyphs.slice(1).map((g,i)=>Math.hypot(g.x-even.glyphs[i].x,g.y-even.glyphs[i].y));
 assert.ok(Math.max(...gaps)/Math.min(...gaps)<=1.26,'curved multi-character labels should retain roughly equal adjacent spacing');
 const colonies=world(220,180,(x,y)=>{
  if(x>=1&&x<7&&y>=1&&y<7)return 1;
  for(let i=0;i<32;i++){const cx=20+(i%8)*24,cy=20+Math.floor(i/8)*36;if(x>=cx&&x<cx+20&&y>=cy&&y<cy+24)return 2;}
  return 0;
 });
 const capitalRequest={owners:{1:'a',2:'a'},countries:[{id:'a',capital:{locationId:1,x:3.5*8,y:3.5*8},layouts:[layout]}]};
 const anchored=(await CountryLabelLayout.compute(colonies,capitalRequest))[0];assert.ok(anchored.x/8<10&&anchored.y/8<10,'capital piece must survive the largest-component limit');
 const unanchored=(await CountryLabelLayout.compute(colonies,{...capitalRequest,countries:[{id:'a',layouts:[layout]}]}))[0];assert.ok(unanchored.x/8>=20);
 console.log('Country labels: limited foreign/water/wasteland overlap, domestic majority, Chile/Vietnam tilt, dominant mainland, cross-strait peers and remote-territory fallback passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
