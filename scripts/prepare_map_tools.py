"""Build a borderless map and exact row-run location lookup for local/offline UI."""
import json
import re
from pathlib import Path

import numpy as np
from PIL import Image
from render_admin_maps import read_hierarchy, LEVELS, SOURCE

Image.MAX_IMAGE_PIXELS = None


def main():
    target = SOURCE / 'lookup'
    target.mkdir(exist_ok=True)
    hierarchy, groups = read_hierarchy((SOURCE / 'definitions.txt').read_text(encoding='utf-8-sig'))
    names = {}
    for path in (SOURCE / 'named_locations').glob('*.txt'):
        text = re.sub(r'#[^\n]*', '', path.read_text(encoding='utf-8-sig'))
        names.update({key: int(rgb, 16) for key, rgb in re.findall(r'^\s*(\w+)\s*=\s*([0-9a-fA-F]+)\s*$', text, re.M)})
    translations = {}
    for path in sorted((SOURCE / 'localization').glob('*.yml')):
        for key, value in re.findall(r'^\s*([^\s:#]+):\s*(?:\d+\s*)?("(?:\\.|[^"\\])*")', path.read_text(encoding='utf-8-sig'), re.M):
            translations[key] = json.loads(value)

    def label(key):
        text = translations.get(key, key)
        for _ in range(5):
            updated = re.sub(r'\$([\w.]+)\$', lambda match: translations.get(match[1], match[1]), text)
            if updated == text:
                break
            text = updated
        return text

    locations = [None]
    id_lookup = np.zeros(1 << 24, dtype=np.uint16)
    for key, rgb in names.items():
        id_lookup[rgb] = len(locations)
        locations.append([key, label(key), hierarchy.get(key)])
    group_names = {}
    for i, level in enumerate(LEVELS):
        group_names[level] = [None] * (len(groups[i]) + 1)
        for keys, group_id in groups[i].items():
            group_names[level][group_id] = [keys[-1], label(keys[-1])]
    config = re.sub(r'#[^\n]*', '', (SOURCE / 'default.map').read_text(encoding='utf-8-sig'))
    classes = np.zeros(1 << 24, dtype=np.uint8)
    for category, kind in [('sea_zones', 1), ('lakes', 1), ('impassable_mountains', 2), ('non_ownable', 2)]:
        keys = re.search(r'\b' + category + r'\s*=\s*\{([^{}]*)\}', config).group(1).split()
        classes[[names[key] for key in keys]] = kind
    raw = Image.open(SOURCE / 'locations.png').convert('RGB')
    rivers = Image.open(SOURCE / 'rivers.png')
    width, height = raw.size
    clean = np.empty((height, width), dtype=np.uint8)
    band_height = 256
    samples = {}
    # Include a known inland point per level for UI coordinate regression checks.
    sample_id = next(i for i, location in enumerate(locations) if location and location[0] == 'stockholm')
    run_count = 0
    for top in range(0, height, band_height):
        bottom = min(height, top + band_height)
        rgb = np.asarray(raw.crop((0, top, width, bottom)), dtype=np.uint32)
        colors = (rgb[:, :, 0] << 16) | (rgb[:, :, 1] << 8) | rgb[:, :, 2]
        ids = id_lookup[colors]
        if np.any(ids == 0):
            raise ValueError('Map contains an unregistered color')
        river = np.asarray(rivers.crop((0, top, width, bottom)))
        tile = classes[colors]
        tile[(river == 254) | (river < 254)] = 1
        clean[top:bottom] = tile
        rows = []
        for offset, row in enumerate(ids):
            ends = np.r_[np.flatnonzero(row[1:] != row[:-1]) + 1, width]
            starts = np.r_[0, ends[:-1]]
            values = row[starts]
            runs = np.column_stack((ends, values)).ravel().tolist()
            rows.append(runs)
            run_count += len(ends)
            hits = np.flatnonzero(values == sample_id)
            if len(hits):
                j = max(hits, key=lambda i: ends[i] - starts[i])
                length = int(ends[j] - starts[j])
                if length > samples.get('stockholm', {}).get('run_length', 0):
                    samples['stockholm'] = {'x': int((starts[j] + ends[j]) // 2), 'y': top + offset, 'run_length': length}
        (target / f'band-{top // band_height}.js').write_text(
            f'window.MapDesignerData.bands[{top // band_height}]=' + json.dumps(rows, separators=(',', ':')) + ';', encoding='utf-8')
    metadata = {'width': width, 'height': height, 'bandHeight': band_height, 'locations': locations,
                'groups': group_names, 'parentOrder': LEVELS, 'samples': samples}
    (target / 'meta.js').write_text('window.MapDesignerData.meta=' + json.dumps(metadata, ensure_ascii=False, separators=(',', ':')) + ';', encoding='utf-8')
    base = Image.open(SOURCE / 'basemap.png')
    output = Image.fromarray(clean, mode='P')
    output.putpalette(base.getpalette())
    output.save(SOURCE / 'basemap-no-borders.png', optimize=True)
    report = {'locations': len(names), 'runs': run_count, 'samples': samples,
              'location_labels_without_translation': sum(1 for key in names if key not in translations)}
    (target / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
