"""Build shared, lightly simplified arcs; adjacent locations use identical geometry."""
import base64
import gzip
import json
import os
from collections import defaultdict
from pathlib import Path
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
SOURCE = Path(os.environ.get('MAPDESIGNER_MAP_SOURCE',str(Path(__file__).resolve().parents[1] / 'assets/maps/eu5')))


def simplify(points, tolerance=.65):
    if len(points) < 3:
        return points
    keep = {0, len(points)-1}
    stack = [(0, len(points)-1)]
    while stack:
        a, b = stack.pop()
        x, y = points[a]; dx, dy = points[b][0]-x, points[b][1]-y
        best, at = tolerance*tolerance, None
        for i in range(a+1, b):
            px, py = points[i][0]-x, points[i][1]-y
            t = max(0, min(1, (px*dx+py*dy)/(dx*dx+dy*dy))) if dx or dy else 0
            distance = (px-t*dx)**2+(py-t*dy)**2
            if distance > best:
                best, at = distance, i
        if at is not None:
            keep.add(at); stack.extend([(a, at), (at, b)])
    return [points[i] for i in sorted(keep)]


def main():
    meta = json.loads((SOURCE/'lookup/meta.js').read_text(encoding='utf-8').split('=',1)[1].rstrip(';'))
    paint = json.loads((SOURCE/'lookup/paint-meta.js').read_text(encoding='utf-8').split('=',1)[1].rstrip(';'))
    # The existing hit-test rows already map source pixels to stable Location IDs.
    w, h = meta['width'], meta['height']
    ids = np.zeros((h+2,w+2), dtype=np.uint16)
    kinds = np.array(paint['kinds'], dtype=np.uint8)
    river = np.asarray(Image.open(SOURCE/'rivers.png'))
    for band in range((h+meta['bandHeight']-1)//meta['bandHeight']):
        rows = json.loads((SOURCE/f'lookup/band-{band}.js').read_text(encoding='utf-8').split('=',1)[1].rstrip(';'))
        for offset,row in enumerate(rows):
            y=band*meta['bandHeight']+offset
            if y>=h: break
            start=0
            for end, location in zip(row[::2], row[1::2]):
                if kinds[location]!=1: ids[y+1,start+1:end+1]=location
                start=end
        print(f'Input band {band}',flush=True)
    ids[1:h+1,1:w+1][river==254]=0
    stride=w+1
    chunks=[]
    # Directed edges keep the location on their right in screen coordinates.
    for vertical in [False,True]:
        a,b=(ids[1:h+1,:w+1],ids[1:h+1,1:w+2]) if vertical else (ids[:h+1,1:w+1],ids[1:h+2,1:w+1])
        ys,xs=np.nonzero(a!=b)
        av,bv=a[ys,xs].astype(np.int32),b[ys,xs].astype(np.int32)
        start=(ys*stride+xs).astype(np.int32)
        end=start+(stride if vertical else 1)
        right,left=(av,bv) if vertical else (bv,av)
        chunks.append(np.column_stack((np.minimum(right,left),np.maximum(right,left),start,end,right)))
    edges=np.concatenate(chunks);del chunks,ids
    order=np.lexsort((edges[:,1],edges[:,0]));edges=edges[order];del order
    cuts=np.r_[0,np.flatnonzero(np.any(edges[1:,:2]!=edges[:-1,:2],axis=1))+1,len(edges)]
    arcs=[]; location_arcs=defaultdict(list); input_points=0
    for j,(lo,hi) in enumerate(zip(cuts[:-1],cuts[1:])):
        group=edges[lo:hi];adj=defaultdict(list)
        for i,e in enumerate(group):
            adj[int(e[2])].append(i);adj[int(e[3])].append(i)
        visited=set()
        starts=[v for v,links in adj.items() if len(links)!=2]
        starts.extend(adj) # Also visit closed loops.
        for start in starts:
            for first in adj[start]:
                if first in visited: continue
                vertices=[start];current=start;edge=first
                right=int(group[first,4]) if int(group[first,2])==start else int(group[first,0]+group[first,1]-group[first,4])
                left=int(group[first,0]+group[first,1]-right)
                while True:
                    visited.add(edge);e=group[edge]
                    current=int(e[3]) if int(e[2])==current else int(e[2]);vertices.append(current)
                    if current==start or len(adj[current])!=2: break
                    next_edges=[i for i in adj[current] if i not in visited]
                    if not next_edges: break
                    edge=next_edges[0]
                points=[(v%stride,v//stride) for v in vertices]
                input_points+=len(points)
                reduced=simplify(points)
                if len(reduced)<3 and vertices[0]==vertices[-1]: reduced=points
                index=len(arcs)+1
                arcs.append([right,left,[coordinate for p in reduced for coordinate in p]])
                if right: location_arcs[right].append((vertices[0],vertices[-1],index))
                if left: location_arcs[left].append((vertices[-1],vertices[0],-index))
        if j%10000==0: print(f'Pairs {j}/{len(cuts)-1}, arcs {len(arcs)}',flush=True)
    rings={}
    for location,links in location_arcs.items():
        outgoing=defaultdict(list)
        for a,b,index in links:outgoing[a].append((b,index))
        loops=[]
        while outgoing:
            start=next(iter(outgoing));current=start;loop=[]
            while True:
                if current not in outgoing: raise ValueError(f'Open ring: {location}')
                end,index=outgoing[current].pop()
                if not outgoing[current]:del outgoing[current]
                loop.append(index);current=end
                if current==start:break
            loops.append(loop)
        rings[location]=loops
    data={'version':1,'width':w,'height':h,'arcs':arcs,'rings':rings}
    payload=json.dumps(data,separators=(',',':')).encode()
    encoded=base64.b64encode(gzip.compress(payload,compresslevel=9)).decode()
    (SOURCE/'lookup/vector-map.js').write_text('window.MapVectorSource="'+encoded+'";',encoding='utf-8')
    # Only rivers, transparent elsewhere; coastlines and terrain are vector fills.
    pixels=np.where(river<254,1,0).astype(np.uint8)
    overlay=Image.fromarray(pixels,'P');overlay.putpalette([255,255,255,185,223,238]+[0]*762)
    overlay.save(SOURCE/'vector-rivers.png',transparency=bytes([0,255]),optimize=True)
    raw=(SOURCE/'vector-rivers.png').read_bytes()
    (SOURCE/'palette/vector-rivers.js').write_text('window.MapPaletteSources=window.MapPaletteSources||{};window.MapPaletteSources["vector-rivers.png"]="'+base64.b64encode(raw).decode()+'";',encoding='utf-8')
    report={'arcs':len(arcs),'locations':len(rings),'input_points':input_points,'vector_points':sum(len(a[2])//2 for a in arcs),'json_bytes':len(payload),'gzip_bytes':len(base64.b64decode(encoded)),'simplification_tolerance':.65}
    (SOURCE/'lookup/vector-report.json').write_text(json.dumps(report,indent=2),encoding='utf-8');print(report,flush=True)


if __name__=='__main__':main()
