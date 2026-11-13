(() => {
  const eu5=window.EU5ProjectMeta;
  const catalog={eu5:{key:'eu5',game:'eu5',name:'Europa Universalis V',label:'Europa Universalis V',width:16384,height:8192,baseLevel:'location',levels:{location:'地块',province:'省份',area:'区域',region:'地区',subcontinent:'次大陆',continent:'大洲'},assetRoot:'assets/maps/eu5',project:eu5}};
  for(const[year,project]of Object.entries(window.CK3Templates||{})){
    const key=`ck3-${year}`;catalog[key]={key,game:'ck3',name:'Crusader Kings III',label:`Crusader Kings III · ${year} 年法理`,width:9216,height:4608,baseLevel:'barony',levels:{barony:'男爵领',county:'伯爵领',duchy:'公国',kingdom:'王国',empire:'帝国'},assetRoot:`assets/maps/ck3/${year}`,project};
  }
  const politicalTemplates = {
    hoi4: { name: 'Hearts of Iron IV', state: '州', continent: '大洲分组' },
    vic3: { name: 'Victoria III', state: '州区', continent: '大洲' },
  };
  for (const [key, { name, state, continent }] of Object.entries(politicalTemplates)) {
    const metadata = window.GrandStrategyTemplates?.[key];
    if (!metadata) continue;
    catalog[key] = {
      ...metadata, key, game: key, name, label: name, baseLevel: 'province',
      levels: { province: '地块', state, region: '战略区', continent },
      assetRoot: `assets/maps/${key}`,
    };
  }
  const params=new URL(location.href).searchParams,active=catalog[params.get('map')]||catalog.eu5;
  window.MapTemplate={...active,fresh:params.get('new')==='1'};window.EU5ProjectMeta=active.project;
  if(params.has('new')){const url=new URL(location.href);url.searchParams.delete('new');history.replaceState(null,'',url);}
  function forSnapshot(map){
    const found=Object.values(catalog).find(t=>t.project.id===map?.id&&(t.project.scenario||null)===(map?.scenario||null));
    if(!found||found.project.sourceFingerprint!==map?.sourceFingerprint)throw new Error('快照的地图或法理日期版本不匹配。');
    return found;
  }
  function handoff(mode,operation){return new Promise((resolve,reject)=>{const opening=indexedDB.open('mapdesigner-map-handoff',1);opening.onupgradeneeded=()=>opening.result.createObjectStore('pending');opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result,tx=db.transaction('pending',mode),request=operation(tx.objectStore('pending'));let result;request.onsuccess=()=>{result=request.result;};tx.oncomplete=()=>{db.close();resolve(result);};tx.onerror=()=>{db.close();reject(tx.error);};};});}
  async function navigate(key,{text=null,source=null,fresh=false}={}){
    if(!catalog[key])throw new Error('未知的地图模板。');
    if(window.mapFiles?.switchTemplate){await window.mapFiles.switchTemplate({key,text,source,fresh});return;}
    const url=new URL(document.baseURI);url.search='';url.searchParams.set('map',key);if(fresh)url.searchParams.set('new','1');
    if(text){const id=crypto.randomUUID();await handoff('readwrite',store=>store.put({text,source},id));url.searchParams.set('pending',id);}
    url.hash='map';location.assign(url.href);
  }
  async function consumePending(){
    if(window.mapFiles?.consumeTemplateSnapshot)return window.mapFiles.consumeTemplateSnapshot();
    const url=new URL(location.href),id=url.searchParams.get('pending');if(!id)return null;
    const text=await handoff('readonly',store=>store.get(id));await handoff('readwrite',store=>store.delete(id));url.searchParams.delete('pending');history.replaceState(null,'',url);return text||null;
  }
  async function readLookup(template,filename){
    if(window.mapFiles?.readTemplateLookup)return window.mapFiles.readTemplateLookup({key:template.key,filename});
    const response=await fetch(new URL(`${template.assetRoot}/lookup/${filename}`,document.baseURI));if(!response.ok)throw new Error('地图验证数据读取失败。');
    const text=await response.text();return JSON.parse(text.slice(text.indexOf('=')+1).trim().replace(/;$/,''));
  }
  window.MapTemplates={catalog,forSnapshot,navigate,consumePending,readLookup};
  for(const id of ['admin-level','paint-level']){const select=document.getElementById(id);select.replaceChildren(...Object.entries(active.levels).map(([key,label])=>{const option=document.createElement('option');option.value=key;option.textContent=label;return option;}));}
  const legend=document.getElementById('location-legend');legend.lastChild.textContent=`${active.levels[active.baseLevel]}分界`;
  document.querySelector('#map .map-toolbar strong').textContent=active.name;
  document.querySelector('#map .map-toolbar .subtle').textContent=active.game==='ck3'?`${active.project.scenario.split('.')[0]} 年法理`:'地图编辑';
  document.getElementById('basemap').alt=`${active.name} 底图`;
})();
