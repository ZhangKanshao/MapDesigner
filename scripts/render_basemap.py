"""Render EU5's categorical map inputs without changing source assets."""
from pathlib import Path
import json
import re
import shutil

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/maps/eu5'
OUT = ROOT / 'output/maps'
COLORS = {'land': '#ffffff', 'water': '#b9dfee', 'wasteland': '#dedede', 'border': '#969696'}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    config = re.sub(r'#[^\n]*', '', (SOURCE / 'default.map').read_text(encoding='utf-8-sig'))
    named = {}
    for path in (SOURCE / 'named_locations').glob('*.txt'):
        content = re.sub(r'#[^\n]*', '', path.read_text(encoding='utf-8-sig'))
        named.update({name: int(value, 16) for name, value in re.findall(r'^\s*(\w+)\s*=\s*([0-9a-fA-F]+)\s*$', content, re.M)})
    classes = np.zeros(1 << 24, dtype=np.uint8)
    category_counts = {}
    for category, kind in [('sea_zones', 1), ('lakes', 1), ('impassable_mountains', 2), ('non_ownable', 2)]:
        match = re.search(r'\b' + category + r'\s*=\s*\{([^{}]*)\}', config)
        if not match:
            raise ValueError(f'Missing category: {category}')
        keys = match.group(1).split()
        missing = [key for key in keys if key not in named]
        if missing:
            raise ValueError(f'Unknown locations in {category}: {missing[:10]}')
        classes[[named[key] for key in keys]] = kind
        category_counts[category] = len(keys)

    locations = Image.open(SOURCE / 'locations.png').convert('RGB')
    rivers = Image.open(SOURCE / 'rivers.png')
    if rivers.mode != 'P' or rivers.size != locations.size:
        raise ValueError('Expected matching indexed river map')
    width, height = locations.size
    result = np.empty((height, width), dtype=np.uint8)
    seen = set()
    river_pixels = 0
    for top in range(0, height, 256):
        bottom = min(height, top + 256)
        rgb = np.asarray(locations.crop((0, top, width, min(height, bottom + 1))), dtype=np.uint32)
        ids = (rgb[:, :, 0] << 16) | (rgb[:, :, 1] << 8) | rgb[:, :, 2]
        seen.update(np.unique(ids).tolist())
        kinds = classes[ids]
        rows = bottom - top
        river_indices = np.asarray(rivers.crop((0, top, width, min(height, bottom + 1))))
        # Pink background in the original river map identifies water, including
        # impassable open ocean locations also listed alongside land wastelands.
        kinds[river_indices == 254] = 1
        tile = kinds[:rows].copy()
        # One source pixel on the left/top side of each land boundary.
        vertical = (ids[:rows, :-1] != ids[:rows, 1:]) & (kinds[:rows, :-1] != 1) & (kinds[:rows, 1:] != 1)
        tile[:, :-1][vertical] = 3
        pairs = min(rows, len(ids) - 1)
        horizontal = (ids[:pairs] != ids[1:pairs + 1]) & (kinds[:pairs] != 1) & (kinds[1:pairs + 1] != 1)
        tile[:pairs][horizontal] = 3
        # 254/255 are background; all other used indices encode rivers or junction markers.
        river_mask = (river_indices[:rows] < 254) & (kinds[:rows] != 1)
        tile[river_mask] = 1
        river_pixels += int(river_mask.sum())
        result[top:bottom] = tile
    unknown = seen - set(named.values())
    if unknown:
        raise ValueError(f'Unregistered map colors: {len(unknown)}; sample: {sorted(unknown)[:10]}')
    image = Image.fromarray(result, mode='P')
    palette = [int(color[i:i + 2], 16) for color in COLORS.values() for i in (1, 3, 5)]
    image.putpalette(palette + [0] * (768 - len(palette)))
    image.save(OUT / 'eu5-basemap.png', optimize=True)
    preview = image.convert('RGB')
    preview.thumbnail((2400, 1200), Image.Resampling.LANCZOS)
    preview.save(OUT / 'eu5-basemap-preview.png')
    # Keep application resources in assets; output/ remains for exported artifacts.
    shutil.copyfile(OUT / 'eu5-basemap.png', SOURCE / 'basemap.png')
    shutil.copyfile(OUT / 'eu5-basemap-preview.png', SOURCE / 'basemap-preview.png')
    image.crop((7200, 1700, 9200, 3100)).convert('RGB').save(OUT / 'eu5-basemap-detail.png')
    report = {'size': [width, height], 'colors': COLORS, 'categories': category_counts,
              'unique_location_colors': len(seen), 'unknown_colors': len(unknown), 'river_pixels': river_pixels,
              'notes': ['Lakes use water color; non_ownable uses wasteland color.',
                        'River-map water background (index 254) overrides impassable open ocean classification.',
                        'Internal sea boundaries omitted. One-pixel land boundaries at source resolution.',
                        'River junction/source markers use the same blue as river segments.']}
    (OUT / 'eu5-basemap.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
