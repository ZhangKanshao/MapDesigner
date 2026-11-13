"""Render selectable EU5 administrative boundaries over the existing basemap."""
from pathlib import Path
import json
import re

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/maps/eu5'
LEVELS = ['continent', 'subcontinent', 'region', 'area', 'province']


def read_hierarchy(text):
    tokens = re.findall(r'[{}=]|[^\s{}=]+', re.sub(r'#[^\n]*', '', text))
    stack, locations = [], {}
    groups = [dict() for _ in LEVELS]
    i = 0
    while i < len(tokens):
        token = tokens[i]
        if i + 2 < len(tokens) and tokens[i + 1:i + 3] == ['=', '{']:
            stack.append(token)
            if len(stack) > 5:
                raise ValueError(f'Unexpected hierarchy depth: {stack}')
            groups[len(stack) - 1].setdefault(tuple(stack), len(groups[len(stack) - 1]) + 1)
            i += 3
        elif token == '}':
            if not stack:
                raise ValueError('Unbalanced hierarchy')
            stack.pop()
            i += 1
        else:
            if len(stack) != 5 or token in ['{', '=']:
                raise ValueError(f'Unexpected token {token} at {stack}')
            if token in locations:
                raise ValueError(f'Duplicate location: {token}')
            locations[token] = tuple(groups[j][tuple(stack[:j + 1])] for j in range(5))
            i += 1
    if stack:
        raise ValueError('Unclosed hierarchy')
    return locations, groups


def main():
    hierarchy, groups = read_hierarchy((SOURCE / 'definitions.txt').read_text(encoding='utf-8-sig'))
    named = {}
    for path in (SOURCE / 'named_locations').glob('*.txt'):
        text = re.sub(r'#[^\n]*', '', path.read_text(encoding='utf-8-sig'))
        named.update({name: int(rgb, 16) for name, rgb in re.findall(r'^\s*(\w+)\s*=\s*([0-9a-fA-F]+)\s*$', text, re.M)})
    missing = set(named) - set(hierarchy)
    unknown = set(hierarchy) - set(named)
    if unknown:
        raise ValueError(f'Hierarchy/color mismatch: missing={list(missing)[:8]}, unknown={list(unknown)[:8]}')
    raw = Image.open(SOURCE / 'locations.png').convert('RGB')
    rivers = Image.open(SOURCE / 'rivers.png')
    water = np.asarray(rivers) == 254
    config = re.sub(r'#[^\n]*', '', (SOURCE / 'default.map').read_text(encoding='utf-8-sig'))
    water_colors = []
    for category in ['sea_zones', 'lakes']:
        keys = re.search(r'\b' + category + r'\s*=\s*\{([^{}]*)\}', config).group(1).split()
        water_colors.extend(named[key] for key in keys)
    base = Image.open(SOURCE / 'basemap.png')
    palette = base.getpalette()
    palette[12:15] = [0, 0, 0]  # Additional index 4 is the black administrative outline.
    original = np.asarray(base)
    width, height = raw.size
    report = {'size': [width, height], 'stroke_width_source_pixels': 2,
              'coastlines_outlined': False,
              'locations_without_hierarchy': sorted(missing), 'levels': {}}
    last_count = None
    # Fine to coarse: verify that parent boundaries are a subset of child boundaries.
    previous_edges = None
    for index in reversed(range(5)):
        level = LEVELS[index]
        lookup = np.zeros(1 << 24, dtype=np.uint16)
        for name, parents in hierarchy.items():
            lookup[named[name]] = parents[index]
        lookup[water_colors] = 0
        edges = np.zeros((height, width), dtype=bool)
        stroke = np.zeros((height, width), dtype=bool)
        for top in range(0, height, 256):
            bottom = min(height, top + 256)
            end = min(height, bottom + 1)
            rgb = np.asarray(raw.crop((0, top, width, end)), dtype=np.uint32)
            colors = (rgb[:, :, 0] << 16) | (rgb[:, :, 1] << 8) | rgb[:, :, 2]
            ids = lookup[colors]
            ids[water[top:end]] = 0
            rows = bottom - top
            # Draw only between two land locations assigned to different groups.
            # Mark one pixel on either side: 2 px versus the Location line's 1 px.
            left, right = ids[:rows, :-1], ids[:rows, 1:]
            vertical = (left != right) & (left != 0) & (right != 0)
            edges[top:bottom, :-1] |= vertical
            stroke[top:bottom, :-1] |= vertical
            stroke[top:bottom, 1:] |= vertical
            pairs = min(rows, len(ids) - 1)
            above, below = ids[:pairs], ids[1:pairs + 1]
            horizontal = (above != below) & (above != 0) & (below != 0)
            edges[top:top + pairs] |= horizontal
            stroke[top:top + pairs] |= horizontal
            stroke[top + 1:top + pairs + 1] |= horizontal
            # Longitude wraps in EU5's source map.
            last, first = ids[:rows, -1], ids[:rows, 0]
            seam = (last != first) & (last != 0) & (first != 0)
            edges[top:bottom, -1] |= seam
            stroke[top:bottom, -1] |= seam
            stroke[top:bottom, 0] |= seam
        count = int(edges.sum())
        if previous_edges is not None and np.any(edges & ~previous_edges):
            raise ValueError(f'{level} boundary is not a subset of the finer level')
        if last_count is not None and count > last_count:
            raise ValueError('Unexpected boundary growth at coarser level')
        previous_edges = edges
        last_count = count
        pixels = original.copy()
        # Preserve water and rivers from the basemap, including boundary crossings.
        pixels[stroke & (original != 1)] = 4
        output = Image.fromarray(pixels, mode='P')
        output.putpalette(palette)
        output.save(SOURCE / f'basemap-{level}.png', optimize=True)
        report['levels'][level] = {'groups': len(groups[index]), 'boundary_pixels_before_thickening': count}
        print(f'{level}: {len(groups[index])} groups, {count} boundary pixels', flush=True)
    (SOURCE / 'admin-boundaries.json').write_text(json.dumps(report, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
