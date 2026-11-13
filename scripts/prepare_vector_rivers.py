"""Trace the complete river footprint, retaining branches, holes and widths."""
import base64
import gzip
import json
from collections import defaultdict
import numpy as np
from PIL import Image
from prepare_vector_map import SOURCE, simplify


def trace(river, offset_x=0, offset_y=0):
    h,w=river.shape;stride=w+1
    mask=np.pad(river,1);parts=[]
    for vertical in [False,True]:
        a,b=(mask[1:h+1,:w+1],mask[1:h+1,1:w+2]) if vertical else (mask[:h+1,1:w+1],mask[1:h+2,1:w+1])
        ys,xs=np.nonzero(a!=b);start=(ys*stride+xs).astype(np.int32);end=start+(stride if vertical else 1)
        forward=a[ys,xs] if vertical else b[ys,xs]
        parts.append(np.column_stack((np.where(forward,start,end),np.where(forward,end,start))))
    edges=np.concatenate(parts);outgoing=defaultdict(list)
    for start,end in edges:outgoing[int(start)].append(int(end))
    edge_count=len(edges);del edges,parts,mask
    rings=[];input_points=0
    def direction(a,b):
        delta=b-a
        return 0 if delta==1 else 1 if delta==stride else 2 if delta==-1 else 3
    while outgoing:
        start=next(iter(outgoing));current=start;previous=None;vertices=[start]
        while True:
            options=outgoing[current]
            if previous is None or len(options)==1:end=options.pop()
            else:
                incoming=direction(previous,current)
                # At diagonal pixel contacts, stay on the same river bank.
                end=min(options,key=lambda end:{1:0,0:1,3:2,2:3}[(direction(current,end)-incoming)%4]);options.remove(end)
            if not options:del outgoing[current]
            previous,current=current,end;vertices.append(current)
            if current==start:break
        points=[(v%stride+offset_x,v//stride+offset_y) for v in vertices];input_points+=len(points)
        reduced=simplify(points,.3)
        if len(reduced)<4:reduced=points
        rings.append([coordinate for point in reduced for coordinate in point])
    return rings,edge_count,input_points


def main():
    river=np.asarray(Image.open(SOURCE/'rivers.png'))<254
    h,w=river.shape;rings=[];tiles=[];edge_count=0;input_points=0
    # A two-pixel overlap hides artificial cut edges. Nonzero fills add winding
    # in overlap areas while preserving holes, without seams between tiles.
    for y in range(0,h,512):
        for x in range(0,w,512):
            x0,y0=max(0,x-2),max(0,y-2)
            tile=river[y0:min(h,y+514),x0:min(w,x+514)]
            if not tile.any():continue
            contours,edges,points=trace(tile,x0,y0)
            tiles.append(list(range(len(rings),len(rings)+len(contours))))
            rings.extend(contours);edge_count+=edges;input_points+=points
        print(f'River tiles through row {y}',flush=True)
    data={'version':1,'width':w,'height':h,'rings':rings,'tiles':tiles,'tileSize':512,'tileOverlap':2}
    raw=json.dumps(data,separators=(',',':')).encode();packed=gzip.compress(raw,compresslevel=9,mtime=0)
    (SOURCE/'lookup/vector-rivers.js').write_text('window.MapRiverVectorSource="'+base64.b64encode(packed).decode()+'";',encoding='utf-8')
    report={'rings':len(rings),'river_pixels':int(river.sum()),'edges':edge_count,'input_points':input_points,'vector_points':sum(len(r)//2 for r in rings),'gzip_bytes':len(packed),'simplification_tolerance':.3}
    # Independent probes from the original raster, for coverage regression checks.
    rng=np.random.default_rng(42);ys,xs=np.nonzero(river)
    report['probes']=[[int(xs[i])+.5,int(ys[i])+.5,True] for i in rng.choice(len(xs),256,replace=False)]
    ys,xs=np.nonzero((~river[1:-1,1:-1]) & (river[:-2,1:-1] | river[2:,1:-1] | river[1:-1,:-2] | river[1:-1,2:]))
    report['probes'] += [[int(xs[i])+1.5,int(ys[i])+1.5,False] for i in rng.choice(len(xs),256,replace=False)]
    (SOURCE/'lookup/vector-rivers-report.json').write_text(json.dumps(report,indent=2),encoding='utf-8');print({k:v for k,v in report.items() if k!='probes'},flush=True)


if __name__=='__main__':main()
