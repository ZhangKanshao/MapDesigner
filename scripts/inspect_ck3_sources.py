"""Read-only audit of the local CK3 inputs needed by a flat map template."""
import csv
import hashlib
import json
import re
from collections import Counter
from pathlib import Path
from PIL import Image
import numpy as np

GAME=Path(r'D:\Steam\steamapps\common\Crusader Kings III\game')
ROOT=Path(__file__).resolve().parents[1]
RANKS={'b':'男爵领','c':'伯爵领','d':'公国','k':'王国','e':'帝国','h':'霸权'}


def main():
    titles={};duplicates=[];province_links={};unparsed=[];conflicts=[]
    for path in sorted((GAME/'common/landed_titles').glob('*.txt')):
        text=re.sub(r'#[^\r\n]*','',path.read_text(encoding='utf-8-sig'))
        tokens=re.findall(r'"(?:\\.|[^"\\])*"|[{}=]|[^\s{}=]+',text)
        stack=[]
        for i,token in enumerate(tokens):
            if token=='{':
                key=tokens[i-2] if i>=2 and tokens[i-1]=='=' else ''
                is_title=bool(re.fullmatch(r'[bcdkeh]_[^\s{}="]+',key)) and (not stack or stack[-1][1])
                if is_title:
                    if key in titles:duplicates.append(key)
                    titles[key]={'parent':stack[-1][0] if stack else None,'rank':key[0],'file':str(path)}
                stack.append((key,is_title))
            elif token=='}':
                if not stack:raise ValueError(f'Unbalanced titles: {path}')
                stack.pop()
            elif token=='province' and i+2<len(tokens) and tokens[i+1]=='=' and stack and stack[-1][1] and stack[-1][0].startswith('b_'):
                if not tokens[i+2].isdigit():unparsed.append([str(path),tokens[i+2]]);continue
                province=int(tokens[i+2]);title=stack[-1][0]
                if province in province_links and province_links[province]!=title:conflicts.append([province,province_links[province],title])
                province_links[province]=title
        if stack:raise ValueError(f'Unclosed titles: {path}')
    translations={};localization_files=set()
    for path in sorted((GAME/'localization/simp_chinese').rglob('*.yml')):
        for key,value in re.findall(r'^\s*([bcdkeh]_[^\s:#]+):\s*(?:\d+\s*)?"((?:\\.|[^"\\])*)"',path.read_text(encoding='utf-8-sig'),re.M):
            if key in titles:
                try:translations[key]=json.loads('"'+value+'"')
                except json.JSONDecodeError:translations[key]=value
                localization_files.add(str(path))
    definitions={}
    with (GAME/'map_data/definition.csv').open(encoding='utf-8-sig',newline='') as stream:
        for row in csv.reader(stream,delimiter=';'):
            if len(row)<5 or not row[0].isdigit():continue
            definitions[int(row[0])]={'rgb':[int(v) for v in row[1:4]],'name':row[4]}
    config=re.sub(r'#[^\r\n]*','',(GAME/'map_data/default.map').read_text(encoding='utf-8-sig'))
    categories={}
    for category,kind,body in re.findall(r'(\w+)\s*=\s*(LIST|RANGE)\s*\{([^{}]*)\}',config):
        values=[int(n) for n in body.split()]
        if kind=='RANGE':
            if len(values)!=2:raise ValueError(f'Invalid range: {category}')
            values=list(range(values[0],values[1]+1))
        categories.setdefault(category,set()).update(values)
    images={}
    Image.MAX_IMAGE_PIXELS=None
    for name in ['provinces.png','rivers.png','heightmap.png']:
        with Image.open(GAME/'map_data'/name) as image:images[name]={'size':list(image.size),'mode':image.mode}
    water=set().union(*(categories.get(key,set()) for key in ['sea_zones','river_provinces','lakes','impassable_seas']))
    waste=categories.get('impassable_mountains',set())
    linked={pid for pid in province_links if pid in definitions}
    rgb_ids={tuple(value['rgb']):pid for pid,value in definitions.items()};seen=set()
    with Image.open(GAME/'map_data/provinces.png') as image:
        for y in range(0,image.height,256):
            pixels=np.asarray(image.crop((0,y,image.width,min(image.height,y+256))),dtype=np.uint32)
            seen.update(np.unique((pixels[:,:,0]<<16)|(pixels[:,:,1]<<8)|pixels[:,:,2]).tolist())
    present=set();unknown=[]
    for color in seen:
        rgb=(color>>16,(color>>8)&255,color&255)
        if rgb in rgb_ids:present.add(rgb_ids[rgb])
        else:unknown.append(color)
    eligible=present-water-waste-{0}
    def chain(key):
        result=[];seen=set()
        while key:
            if key in seen:raise ValueError(f'Title cycle: {key}')
            seen.add(key);title=titles[key];result.append({'key':key,'name':translations.get(key,key),'rank':RANKS[title['rank']]});key=title['parent']
        return result
    paths=[GAME/'map_data'/n for n in ['provinces.png','rivers.png','definition.csv','default.map']]
    paths+=sorted((GAME/'common/landed_titles').glob('*.txt'))
    paths += [Path(p) for p in sorted(localization_files)]
    manifest=[{'path':str(p),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in paths]
    report={'source':str(GAME),'images':images,'title_counts':dict(Counter(t['rank'] for t in titles.values())),
        'rank_labels':RANKS,'linked_barony_count':len(linked),'province_definition_count':len(definitions)-1,
        'present_province_count':len(present-{0}),'unknown_map_colors':unknown,
        'classification_counts':{key:len(value) for key,value in categories.items()},
        'eligible_provinces_without_barony':sorted(eligible-linked),
        'linked_provinces_marked_water_or_waste':sorted(linked&(water|waste)),
        'missing_barony_translations':[key for key in province_links.values() if key not in translations],
        'unparsed_province_values':unparsed,'duplicate_title_definitions':duplicates,'conflicting_province_links':conflicts,
        'examples':{key:{'province':next((pid for pid,title in province_links.items() if title==key),None),'chain':chain(key)} for key in ['b_london','b_roma'] if key in titles},
        'hegemony_examples':[{**titles[key],'key':key,'name':translations.get(key,key)} for key in titles if key.startswith('h_')],
        'localization_file_count':len(localization_files),'files':manifest}
    output=ROOT/'output/maps/ck3-source-audit.json';output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    summary={k:v for k,v in report.items() if k not in ['files','missing_barony_translations','hegemony_examples']}
    summary['missing_barony_translation_count']=len(report['missing_barony_translations'])
    summary['eligible_provinces_without_barony_count']=len(report['eligible_provinces_without_barony'])
    summary['eligible_provinces_without_barony']=report['eligible_provinces_without_barony'][:20]
    print(json.dumps(summary,ensure_ascii=False,indent=2))


if __name__=='__main__':main()
