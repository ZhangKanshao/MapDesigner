"""Generate protected-pixel masks and per-location painting classifications."""
import json
import re
import hashlib
import numpy as np
from PIL import Image
from render_admin_maps import SOURCE

Image.MAX_IMAGE_PIXELS = None


def main():
    metadata = json.loads((SOURCE / 'lookup/meta.js').read_text(encoding='utf-8').split('=', 1)[1].rstrip(';'))
    locations = metadata['locations']
    named = {}
    for path in (SOURCE / 'named_locations').glob('*.txt'):
        text = re.sub(r'#[^\n]*', '', path.read_text(encoding='utf-8-sig'))
        named.update({name: int(rgb, 16) for name, rgb in re.findall(r'^\s*(\w+)\s*=\s*([0-9a-fA-F]+)\s*$', text, re.M)})
    config = re.sub(r'#[^\n]*', '', (SOURCE / 'default.map').read_text(encoding='utf-8-sig'))
    kinds = [0] * len(locations)
    specials = {}
    for category, kind in [('sea_zones', 1), ('lakes', 1), ('impassable_mountains', 2), ('non_ownable', 2)]:
        keys = re.search(r'\b' + category + r'\s*=\s*\{([^{}]*)\}', config).group(1).split()
        specials.update({key: kind for key in keys})
    lookup = np.zeros(1 << 24, dtype=np.uint16)
    for i, location in enumerate(locations[1:], 1):
        kinds[i] = specials.get(location[0], 0)
        lookup[named[location[0]]] = i
    raw = Image.open(SOURCE / 'locations.png').convert('RGB')
    rivers = Image.open(SOURCE / 'rivers.png')
    width, height = raw.size
    non_ocean_counts = np.zeros(len(locations), dtype=np.int64)
    samples = {}
    wanted = {key: next(i for i, location in enumerate(locations) if location and location[0] == key)
              for key in ['stockholm', 'uppsala', 'skanderna']}
    for top in range(0, height, 256):
        bottom = min(height, top + 256)
        rgb = np.asarray(raw.crop((0, top, width, bottom)), dtype=np.uint32)
        ids = lookup[(rgb[:, :, 0] << 16) | (rgb[:, :, 1] << 8) | rgb[:, :, 2]]
        river = np.asarray(rivers.crop((0, top, width, bottom)))
        non_ocean_counts += np.bincount(ids[river != 254], minlength=len(locations))
        for name, location_id in wanted.items():
            positions = np.argwhere((ids == location_id) & (river == 255))
            if len(positions) and len(positions) > samples.get(name, {}).get('weight', 0):
                y, x = positions[len(positions) // 2]
                samples[name] = {'id': location_id, 'x': int(x), 'y': int(y + top), 'weight': len(positions)}
        if 'river' not in samples:
            kinds_array = np.asarray(kinds, dtype=np.uint8)
            positions = np.argwhere((river < 254) & (kinds_array[ids] == 0))
            if len(positions):
                y, x = positions[len(positions) // 2]
                samples['river'] = {'id': int(ids[y, x]), 'x': int(x), 'y': int(y + top)}
        if 'sea' not in samples:
            positions = np.argwhere(river == 254)
            if len(positions):
                y, x = positions[len(positions) // 2]
                samples['sea'] = {'id': int(ids[y, x]), 'x': int(x), 'y': int(y + top)}
    for i in range(1, len(kinds)):
        if non_ocean_counts[i] == 0:
            kinds[i] = 1
    for level in ['location', 'province', 'area', 'region', 'subcontinent', 'continent', 'none']:
        filename = 'basemap.png' if level == 'location' else 'basemap-no-borders.png' if level == 'none' else f'basemap-{level}.png'
        pixels = np.asarray(Image.open(SOURCE / filename))
        # Transparent at water, rivers and visible boundaries; opaque only on fillable ground.
        alpha = np.where((pixels == 0) | (pixels == 2), 255, 0).astype(np.uint8)
        mask = Image.fromarray(alpha, mode='L')
        Image.merge('LA', (Image.new('L', raw.size, 255), mask)).save(SOURCE / f'paint-mask-{level}.png', optimize=True)
        print(f'Mask: {level}', flush=True)
    data = {'kinds': kinds, 'samples': samples}
    (SOURCE / 'lookup/paint-meta.js').write_text('window.MapDesignerData.paintMeta=' + json.dumps(data, separators=(',', ':')) + ';', encoding='utf-8')
    (SOURCE / 'lookup/paint-report.json').write_text(json.dumps({'samples': samples}, indent=2), encoding='utf-8')
    manifest = json.loads((SOURCE / 'manifest.json').read_text(encoding='utf-8-sig'))
    fingerprint = hashlib.sha256(json.dumps(manifest, separators=(',', ':')).encode('utf-8')).hexdigest()
    (SOURCE / 'project-meta.js').write_text('window.EU5ProjectMeta=' + json.dumps({'id': 'eu5', 'sourceFingerprint': fingerprint}, separators=(',', ':')) + ';', encoding='utf-8')


if __name__ == '__main__':
    main()
