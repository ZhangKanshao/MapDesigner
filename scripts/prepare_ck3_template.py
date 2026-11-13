"""Build offline CK3 templates with dated de-jure hierarchy, leaving game files intact."""
import base64,csv,gzip,hashlib,json,os,re,shutil,subprocess,sys
from pathlib import Path
import numpy as np
from PIL import Image
Image.MAX_IMAGE_PIXELS=None
ROOT=Path(__file__).resolve().parents[1]
GAME=Path(r'D:\Steam\steamapps\common\Crusader Kings III\game')
OUT=ROOT/'assets/maps/ck3'
DATES={'867':'867.1.1','1066':'1066.9.15','1178':'1178.10.1'}
LEVELS={'e':'empire','k':'kingdom','d':'duchy','c':'county'}

def parse(path):
    try:content=path.read_text(encoding='utf-8-sig')
    except UnicodeDecodeError:content=path.read_bytes().decode('cp1252',errors='replace')
    tokens=[t for t in re.findall(r'"(?:\\.|[^"\\])*"|#[^\r\n]*|[{}=]|[^\s{}=#]+',content) if not t.startswith('#')]
    at=0
    def block():
        nonlocal at
        result=[]
        while at<len(tokens):
            key=tokens[at];at+=1
            if key=='}':return result
            if key=='{':block();continue
            if at>=len(tokens) or tokens[at]!='=':continue
            at+=1
            if at>=len(tokens):break
            value=tokens[at];at+=1
            if value=='{':value=block()
            elif at<len(tokens) and tokens[at]=='{':at+=1;value=block()
            elif value.startswith('"'):value=value[1:-1]
            result.append((key,value))
        return result
    return block()

def main():
    OUT.mkdir(parents=True,exist_ok=True)
    titles={};province_titles={};parents={};source_paths=[]
    def walk(nodes,parent=None):
        for key,values in nodes:
            if not isinstance(values,list) or not re.fullmatch(r'[bcdkeh]_[^\s{}="]+',key):continue
            titles[key]=values;parents[key]=parent
            for field,value in values:
                if key.startswith('b_') and field=='province' and str(value).isdigit():
                    pid=int(value)
                    if pid in province_titles and province_titles[pid]!=key:raise ValueError(f'Province conflict {pid}')
                    province_titles[pid]=key
            walk(values,key)
    for path in sorted((GAME/'common/landed_titles').glob('*.txt')):source_paths.append(path);walk(parse(path))
    base_overrides=[];changes=[]
    for path in sorted((GAME/'history/titles').rglob('*.txt')):
        source_paths.append(path)
        for key,values in parse(path):
            if key not in titles or not isinstance(values,list):continue
            for field,value in values:
                if field=='de_jure_liege':base_overrides.append((key,value))
                elif re.fullmatch(r'\d+\.\d+\.\d+',field) and isinstance(value,list):
                    for prop,target in value:
                        if prop=='de_jure_liege':changes.append((tuple(map(int,field.split('.'))),key,target))
    changes.sort(key=lambda change:change[0])
    translations={}
    for path in sorted((GAME/'localization/simp_chinese').rglob('*.yml')):
        found=False
        for key,value in re.findall(r'^\s*([bcdkeh]_[^\s:#]+):\s*(?:\d+\s*)?"((?:\\.|[^"\\])*)"',path.read_text(encoding='utf-8-sig'),re.M):
            if key in titles:
                try:translations[key]=json.loads('"'+value+'"')
                except json.JSONDecodeError:translations[key]=value
                found=True
        if found:source_paths.append(path)
    def label(key):
        text=translations.get(key,key)
        for _ in range(6):
            updated=re.sub(r'\$([^$]+)\$',lambda m:translations.get(m[1],m[1]),text)
            if updated==text:break
            text=updated
        return text
    definitions={}
    with (GAME/'map_data/definition.csv').open(encoding='utf-8-sig',newline='') as stream:
        for row in csv.reader(stream,delimiter=';'):
            if len(row)>4 and row[0].isdigit():definitions[int(row[0])]=([int(v) for v in row[1:4]],row[4])
    config=re.sub(r'#[^\r\n]*','',(GAME/'map_data/default.map').read_text(encoding='utf-8-sig'));categories={}
    for key,kind,body in re.findall(r'(\w+)\s*=\s*(LIST|RANGE)\s*\{([^{}]*)\}',config):
        values=list(map(int,body.split()));categories.setdefault(key,set()).update(range(values[0],values[1]+1) if kind=='RANGE' else values)
    kinds=np.zeros(max(max(definitions),max(v for values in categories.values() for v in values))+1,dtype=np.uint8);kinds[0]=1
    for key in ['sea_zones','river_provinces','lakes','impassable_seas']:kinds[list(categories.get(key,set()))]=1
    kinds[list(categories['impassable_mountains'])]=2
    # Three natural areas have no title and are omitted by default.map.
    for pid in definitions:
        if pid not in province_titles and kinds[pid]==0:kinds[pid]=2
    lookup=np.zeros(1<<24,dtype=np.uint16)
    for pid,(rgb,_) in definitions.items():lookup[(rgb[0]<<16)|(rgb[1]<<8)|rgb[2]]=pid
    raw=Image.open(GAME/'map_data/provinces.png').convert('RGB');rivers=Image.open(GAME/'map_data/rivers.png');width,height=raw.size
    first=OUT/'867';(first/'lookup').mkdir(parents=True,exist_ok=True);(first/'palette').mkdir(exist_ok=True)
    clean=np.empty((height,width),dtype=np.uint8);fine=np.empty_like(clean);samples={}
    wanted={key:next(pid for pid,title in province_titles.items() if title==key) for key in ['b_london','b_roma']}
    for top in range(0,height,256):
        bottom=min(height,top+256);rgb=np.asarray(raw.crop((0,top,width,min(height,bottom+1))),dtype=np.uint32)
        ids=lookup[(rgb[:,:,0]<<16)|(rgb[:,:,1]<<8)|rgb[:,:,2]];rows=bottom-top;tile=kinds[ids[:rows]].copy();river=np.asarray(rivers.crop((0,top,width,bottom)))
        tile[(river==254)|(river<254)]=1;clean[top:bottom]=tile
        edge=tile.copy();v=(ids[:rows,:-1]!=ids[:rows,1:])&(kinds[ids[:rows,:-1]]!=1)&(kinds[ids[:rows,1:]]!=1);edge[:,:-1][v]=3
        n=min(rows,len(ids)-1);h=(ids[:n]!=ids[1:n+1])&(kinds[ids[:n]]!=1)&(kinds[ids[1:n+1]]!=1);edge[:n][h]=3;edge[tile==1]=1;fine[top:bottom]=edge
        encoded=[]
        for y,row in enumerate(ids[:rows]):
            ends=np.r_[np.flatnonzero(row[1:]!=row[:-1])+1,width];starts=np.r_[0,ends[:-1]];values=row[starts];encoded.append(np.column_stack((ends,values)).ravel().tolist())
            for key,pid in wanted.items():
                hits=np.flatnonzero(values==pid)
                for j in hits:
                    length=int(ends[j]-starts[j]);x=int((ends[j]+starts[j])//2)
                    if length>samples.get(key,{}).get('length',0) and river[y,x]==255:samples[key]={'id':pid,'x':x,'y':top+y,'length':length}
        (first/f'lookup/band-{top//256}.js').write_text(f'window.MapDesignerData.bands[{top//256}]='+json.dumps(encoded,separators=(',',':'))+';',encoding='utf-8');print('CK3 map band',top//256,flush=True)
    palette=[255,255,255,185,223,238,222,222,222,150,150,150,0,0,0]+[0]*753
    for name,pixels in [('basemap.png',fine),('basemap-no-borders.png',clean)]:
        image=Image.fromarray(pixels,'P');image.putpalette(palette);image.save(first/name,optimize=True)
        data=(first/name).read_bytes();(first/'palette'/name.replace('.png','.js')).write_text('window.MapPaletteSources=window.MapPaletteSources||{};window.MapPaletteSources['+json.dumps(name)+']='+json.dumps(base64.b64encode(data).decode())+';',encoding='utf-8')
    preview=Image.open(first/'basemap.png').convert('RGB');preview.thumbnail((1200,600),Image.Resampling.LANCZOS);preview.save(OUT/'basemap-preview.png')
    paint={'kinds':kinds.tolist(),'samples':samples};(first/'lookup/paint-meta.js').write_text('window.MapDesignerData.paintMeta='+json.dumps(paint,separators=(',',':'))+';',encoding='utf-8')
    shutil.copy2(GAME/'map_data/rivers.png',first/'rivers.png')
    source_paths += [GAME/'map_data'/n for n in ['provinces.png','rivers.png','definition.csv','default.map']]
    manifest=[{'path':str(p),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in source_paths]
    (OUT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    groups={level:[None]+[[key,label(key)] for key in sorted(titles) if key.startswith(rank+'_')] for rank,level in LEVELS.items()}
    group_ids={level:{item[0]:i for i,item in enumerate(items) if item} for level,items in groups.items()}
    catalog={};audits={}
    for year,date in DATES.items():
        target=OUT/year
        if target!=first:shutil.copytree(first,target,dirs_exist_ok=True)
        current=dict(parents)
        def apply(key,value):current[key]=None if str(value)=='0' else value
        for key,value in base_overrides:apply(key,value)
        count=0
        for when,key,value in changes:
            if when<=tuple(map(int,date.split('.'))):apply(key,value);count+=1
        locations=[None]*(max(definitions)+1)
        for pid,(_,internal) in definitions.items():
            if not pid:continue
            title=province_titles.get(pid);ancestors={};key=title;seen=set()
            while key and key in titles:
                if key in seen:raise ValueError(f'De-jure cycle on {date}: {key}')
                seen.add(key)
                if key[0] in LEVELS:ancestors[LEVELS[key[0]]]=group_ids[LEVELS[key[0]]][key]
                key=current.get(key)
            locations[pid]=[title or internal,label(title) if title else internal,[ancestors.get(level) for level in LEVELS.values()]]
        metadata={'width':width,'height':height,'bandHeight':256,'locations':locations,'groups':groups,'parentOrder':list(LEVELS.values()),'samples':samples,'scenario':date}
        (target/'lookup/meta.js').write_text('window.MapDesignerData.meta='+json.dumps(metadata,ensure_ascii=False,separators=(',',':'))+';',encoding='utf-8')
        fingerprint=hashlib.sha256((json.dumps(manifest,sort_keys=True,separators=(',',':'))+date).encode()).hexdigest()
        project={'id':'ck3','scenario':date,'sourceFingerprint':fingerprint}
        (target/'project-meta.js').write_text('window.EU5ProjectMeta='+json.dumps(project,separators=(',',':'))+';',encoding='utf-8');catalog[year]=project
        audits[year]={'date':date,'applied_history_changes':count,'d_poitou_parent':current.get('d_poitou'),'d_cilicia_parent':current.get('d_cilicia'),'baronies':len(province_titles)}
        if year=='867':
            env={**os.environ,'MAPDESIGNER_MAP_SOURCE':str(first),'PYTHONUTF8':'1'}
            for script in ['prepare_vector_map.py','prepare_vector_rivers.py','prepare_country_labels.py']:subprocess.run([sys.executable,str(ROOT/'scripts'/script)],env=env,check=True)
        else:
            for name in ['vector-map.js','vector-rivers.js'] :shutil.copy2(first/'lookup'/name,target/'lookup'/name)
            geometry=(first/'lookup/country-label-geometry.js').read_text(encoding='utf-8').replace(catalog['867']['sourceFingerprint'],fingerprint);(target/'lookup/country-label-geometry.js').write_text(geometry,encoding='utf-8')
    (OUT/'templates.js').write_text('window.CK3Templates='+json.dumps(catalog,separators=(',',':'))+';',encoding='utf-8')
    (OUT/'history-audit.json').write_text(json.dumps(audits,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(audits),flush=True)

if __name__=='__main__':main()
