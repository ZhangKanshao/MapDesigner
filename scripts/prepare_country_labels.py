"""Build weighted 8x8 location and terrain coverage for country-name fitting."""
from pathlib import Path
import base64, gzip, json, os
import numpy as np
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
root = Path(os.environ.get('MAPDESIGNER_MAP_SOURCE',str(Path(__file__).resolve().parents[1] / 'assets/maps/eu5'))) / 'lookup'
meta=json.loads((root/'meta.js').read_text(encoding='utf-8').split('=',1)[1].rstrip(';\r\n '))
width,height=meta['width'],meta['height']
gw,gh=width//8,height//8
band_count=(height+255)//256
step = 8
patterns = [[]]
weights = [[]]
terrain = Image.open(root.parent / 'basemap-no-borders.png')
land = np.zeros((gh,gw),dtype=np.uint8)
waste = np.zeros((gh,gw),dtype=np.uint8)
pattern_ids = {(): 0}
grid = np.zeros((gh,gw), dtype=np.uint32)
for band in range(band_count):
    text = (root / f'band-{band}.js').read_text(encoding='utf-8')
    rows = json.loads(text.split('=',1)[1].rstrip(';\r\n '))
    rows_in_band = len(rows)
    grid_rows = rows_in_band // step
    grid_start = band * 256 // step
    tile = np.empty((rows_in_band,width),dtype=np.uint32)
    for y,row in enumerate(rows):
        start = 0
        for end,location in zip(row[0::2],row[1::2]):
            tile[y,start:end] = location
            start = end
    cells = tile.reshape(grid_rows,8,gw,8).transpose(0,2,1,3).reshape(-1,64)
    cells.sort(axis=1)
    options,inverse = np.unique(cells,axis=0,return_inverse=True)
    mapping = np.empty(len(options),dtype=np.uint32)
    for i,option in enumerate(options):
        ids,counts = np.unique(option,return_counts=True)
        key = tuple((int(v),int(n)) for v,n in zip(ids,counts))
        if key not in pattern_ids:
            pattern_ids[key] = len(patterns)
            patterns.append([v for v,n in key])
            weights.append([n for v,n in key])
        mapping[i] = pattern_ids[key]
    surface = np.asarray(terrain.crop((0,band*256,width,band*256+rows_in_band)))
    def fraction(mask):
        return np.rint(mask.reshape(grid_rows,8,gw,8).mean(axis=(1,3))*255).astype(np.uint8)
    band_slice = slice(grid_start, grid_start + grid_rows)
    land[band_slice] = fraction(surface != 1)
    waste[band_slice] = fraction(surface == 2)
    grid[band_slice] = mapping[inverse].reshape(grid_rows,gw)
    print(f'band {band+1}/{band_count}, patterns {len(patterns)}',flush=True)
fingerprint = json.loads((root.parent / 'project-meta.js').read_text(encoding='utf-8').split('=',1)[1].rstrip(';\r\n '))['sourceFingerprint']
pack = lambda data: base64.b64encode(gzip.compress(data.tobytes(),compresslevel=9,mtime=0)).decode('ascii')
result = {'version':2,'sourceFingerprint':fingerprint,'width':gw,'height':gh,'step':step,'patterns':patterns,'weights':weights,'grid':pack(grid.astype('<u4')),'land':pack(land),'waste':pack(waste)}
(root / 'country-label-geometry.js').write_text('window.MapCountryLabelGeometry='+json.dumps(result,separators=(',',':'))+';',encoding='utf-8')
print('geometry bytes', (root / 'country-label-geometry.js').stat().st_size)
