"""Build MapDesigner templates from local Hearts of Iron IV and Victoria 3 installs."""

import argparse
import base64
import csv
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
LEVELS = ('state', 'region', 'continent')
BAND_HEIGHT = 256
PALETTE = [255, 255, 255, 185, 223, 238, 222, 222, 222, 150, 150, 150, 0, 0, 0] + [0] * 753


def json_text(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def write_js(path, assignment, value):
    path.write_text(f'{assignment}={json_text(value)};', encoding='utf-8')


def clean(path):
    text = path.read_text(encoding='utf-8-sig', errors='replace')
    return re.sub(r'(?m)#.*$', '', text)


def sections(text):
    """Return named blocks at this level, skipping over each nested body."""
    tokens = re.finditer(r'"[^"]*"|([\w.-]+)\s*=\s*\{|[{}]', text)
    depth = 0
    name = None
    for token in tokens:
        value = token[0]
        if value.endswith('{'):
            if not depth:
                name, start = token[1], token.end()
            depth += 1
        elif value == '}':
            depth -= 1
            if not depth and name:
                yield name, text[start:token.start()]


def scalar(text, key):
    match = re.search(r'\b' + key + r'\s*=\s*"?([^\s"}]+)', text)
    return match[1] if match else None


def translations(*paths):
    names = {}
    for path in paths:
        for key, value in re.findall(r'^\s*([^\s:#]+):\s*(?:\d+\s*)?"((?:\\.|[^"\\])*)"',
                                     path.read_text(encoding='utf-8-sig'), re.M):
            try:
                names[key] = json.loads('"' + value + '"')
            except json.JSONDecodeError:
                names[key] = value
    return names


def unique_memberships(groups):
    members = {}
    for key, items in groups.items():
        for item in items:
            previous = members.setdefault(item, key)
            if previous != key:
                raise ValueError(f'{item} appears in both {previous} and {key}')
    return members


def read_hoi4(game):
    maps = game / 'map'
    locale = game / 'localisation/simp_chinese'
    names = translations(*(locale / f'{file}_l_simp_chinese.yml' for file in
                           ('state_names', 'strategic_region_names', 'victory_points')))
    continents = dict(sections(clean(maps / 'continent.txt')))['continents'].split()
    continent_names = dict(zip(
        ('europe', 'north_america', 'south_america', 'australia', 'africa', 'asia', 'middle_east'),
        ('欧洲', '北美洲', '南美洲', '大洋洲', '非洲', '亚洲', '中东'), strict=True))
    states, regions, state_names, region_names, impassable = {}, {}, {}, {}, set()
    for path in sorted((game / 'history/states').glob('*.txt')):
        state = dict(sections(clean(path)))['state']
        key = scalar(state, 'id')
        state_names[key] = names.get(scalar(state, 'name'), f'州 {key}')
        states[key] = set(map(int, dict(sections(state))['provinces'].split()))
        if scalar(state, 'impassable') == 'yes':
            impassable.update(states[key])
    for path in sorted((maps / 'strategicregions').glob('*.txt')):
        region = dict(sections(clean(path)))['strategic_region']
        key = scalar(region, 'id')
        region_names[key] = names.get(scalar(region, 'name'), f'战略区 {key}')
        regions[key] = set(map(int, dict(sections(region))['provinces'].split()))
    province_state = unique_memberships(states)
    province_region = unique_memberships(regions)
    records = []
    for row in csv.reader(clean(maps / 'definition.csv').splitlines(), delimiter=';'):
        if len(row) < 8 or not row[0].isdigit():
            continue
        pid, r, g, b = map(int, row[:4])
        rgb = (r << 16) | (g << 8) | b
        if pid == 0 or row[4] != 'land':
            records.append((pid, rgb, 1, None))
            continue
        state, region = province_state[pid], province_region[pid]
        continent = continents[int(row[7]) - 1]
        name = names.get(f'VICTORY_POINTS_{pid}', f'{state_names[state]} · 地块 {pid}')
        records.append((pid, rgb, 2 if pid in impassable else 0,
                        [str(pid), name, [state, region, continent]]))
    return maps / 'provinces.bmp', maps / 'rivers.bmp', records, (state_names, region_names, continent_names)


def colors(text):
    return {int(color, 16) for color in re.findall(r'\bx([0-9a-fA-F]{6})\b', text)}


def read_vic3(game):
    maps = game / 'game/map_data'
    common = game / 'game/common'
    locale = game / 'game/localization/simp_chinese'
    names = translations(locale / 'map/states_l_simp_chinese.yml',
                         locale / 'map/strategic_regions_l_simp_chinese.yml',
                         locale / 'hub_names_l_simp_chinese.yml')
    state_names, regions, region_names, states, hubs, impassable = {}, {}, {}, {}, {}, set()
    config = dict(sections(clean(maps / 'default.map')))
    water = colors(config['sea_starts']) | colors(config['lakes'])
    for path in sorted((maps / 'state_regions').glob('*.txt')):
        for key, state in sections(clean(path)):
            fields = dict(sections(state))
            provinces = colors(fields['provinces'])
            if path.name == '99_seas.txt':
                water.update(provinces)
                continue
            states[key] = provinces
            state_names[key] = names.get(key, key)
            impassable.update(colors(fields.get('impassable', '')))
            for hub in ('city', 'port', 'farm', 'mine', 'wood'):
                name = names.get(f'HUB_NAME_{key}_{hub}')
                color = scalar(state, hub)
                if name and color:
                    hubs[int(color[1:], 16)] = name
    for path in sorted((common / 'strategic_regions').glob('*.txt')):
        for key, region in sections(clean(path)):
            members = set(dict(sections(region))['states'].split()) & states.keys()
            if members:
                regions[key] = members
                region_names[key] = names.get(key, key)
    continents = {}
    for path in sorted((common / 'geographic_regions').glob('*.txt')):
        for key, region in sections(clean(path)):
            members = dict(sections(region)).get('strategic_regions', '').split()
            continents[key.removeprefix('geographic_region_')] = {m.removeprefix('sr:') for m in members}
    continent_names = dict(zip(('europe', 'north_america', 'south_america', 'africa', 'asia', 'oceania'),
                               ('欧洲', '北美洲', '南美洲', '非洲', '亚洲', '大洋洲'), strict=True))
    continents = {key: continents[key] for key in continent_names if key != 'oceania'}
    continents['north_america'].add('region_central_america')
    continents['asia'].remove('region_oceania')
    continents['oceania'] = {'region_oceania'}
    region_continent = unique_memberships(continents)
    if region_continent.keys() != regions.keys():
        raise ValueError('Victoria 3 continent groups must cover every land strategic region')
    state_region = unique_memberships(regions)
    province_state = unique_memberships(states)
    records = []
    for pid, rgb in enumerate(sorted(province_state.keys() | water), start=1):
        if rgb in water:
            records.append((pid, rgb, 1, None))
            continue
        state = province_state[rgb]
        region = state_region[state]
        code = f'x{rgb:06X}'
        name = hubs.get(rgb, f'{state_names[state]} · 地块 {code}')
        records.append((pid, rgb, 2 if rgb in impassable else 0,
                        [code, name, [state, region, region_continent[region]]]))
    return maps / 'provinces.png', maps / 'rivers.png', records, (state_names, region_names, continent_names)


def save_palette_image(target, filename, pixels, embed=True):
    image = Image.fromarray(pixels)
    image.putpalette(PALETTE)
    image.save(target / filename, optimize=True)
    if embed:
        data = base64.b64encode((target / filename).read_bytes()).decode('ascii')
        write_js(target / 'palette' / (Path(filename).stem + '.js'),
                 f'window.MapPaletteSources=window.MapPaletteSources||{{}};window.MapPaletteSources[{json_text(filename)}]',
                 data)


def build(key, source):
    province_path, river_path, records, group_names = source
    target = ROOT / 'assets/maps' / key
    for folder in ('lookup', 'palette'):
        (target / folder).mkdir(parents=True, exist_ok=True)
    groups = {level: [None] + [[key, names[key]] for key in sorted(names)]
              for level, names in zip(LEVELS, group_names)}
    group_indexes = [{record[0]: i for i, record in enumerate(groups[level]) if record} for level in LEVELS]
    max_id = max(record[0] for record in records)
    if max_id >= np.iinfo(np.uint16).max:
        raise ValueError('Too many province IDs for the vector format')
    kinds = np.ones(max_id + 1, dtype=np.uint8)
    locations = [None] * len(kinds)
    undefined = np.iinfo(np.uint16).max
    lookup = np.full(1 << 24, undefined, dtype=np.uint16)
    for pid, rgb, kind, location in records:
        if lookup[rgb] != undefined:
            raise ValueError(f'Duplicate province RGB {rgb:06X}')
        lookup[rgb] = pid
        kinds[pid] = kind
        if location:
            code, name, parents = location
            locations[pid] = [code, name, [indexes[parent] for indexes, parent in zip(group_indexes, parents)]]
    with Image.open(province_path) as raw, Image.open(river_path) as rivers:
        width, height = raw.size
        if rivers.size != raw.size or rivers.mode != 'P':
            raise ValueError('River image must be indexed and match the province map')
        river_pixels = np.array(rivers)
        river_palette = rivers.getpalette()
        rgb = np.asarray(raw.convert('RGB'), dtype=np.uint32)
    ids = lookup[(rgb[:, :, 0] << 16) | (rgb[:, :, 1] << 8) | rgb[:, :, 2]]
    del rgb, lookup
    if (ids == undefined).any():
        raise ValueError('Unmapped province color in raster')
    surface = kinds[ids]
    water = surface == 1
    # Game river backgrounds are 254/255. Keep province data authoritative for
    # open water and use the river pixels only as an overlay on those polygons.
    river_pixels[(river_pixels >= 254) & ~water] = 255
    river_pixels[water] = 254
    river_image = Image.fromarray(river_pixels)
    river_image.putpalette(river_palette)
    river_image.save(target / 'rivers.png', optimize=True)
    clean_pixels = np.where(river_pixels < 254, 1, surface).astype(np.uint8)
    fine_pixels = clean_pixels.copy()
    for left, right, destination, left_water, right_water in (
        (ids[:, :-1], ids[:, 1:], fine_pixels[:, :-1], water[:, :-1], water[:, 1:]),
        (ids[:-1], ids[1:], fine_pixels[:-1], water[:-1], water[1:]),
    ):
        destination[(left != right) & ~left_water & ~right_water] = 3
    fine_pixels[clean_pixels == 1] = 1
    save_palette_image(target, 'basemap.png', fine_pixels)
    save_palette_image(target, 'basemap-no-borders.png', clean_pixels)
    with Image.open(target / 'basemap.png') as image:
        preview = image.convert('RGB')
        preview.thumbnail((1200, 600), Image.Resampling.LANCZOS)
        preview.save(target / 'basemap-preview.png')
    for top in range(0, height, BAND_HEIGHT):
        band = top // BAND_HEIGHT
        rows = []
        for row in ids[top:top + BAND_HEIGHT]:
            ends = np.r_[np.flatnonzero(row[1:] != row[:-1]) + 1, width]
            rows.append(np.column_stack((ends, row[np.r_[0, ends[:-1]]])).ravel().tolist())
        write_js(target / f'lookup/band-{band}.js', f'window.MapDesignerData.bands[{band}]', rows)
    metadata = {'width': width, 'height': height, 'bandHeight': BAND_HEIGHT, 'locations': locations,
                'groups': groups, 'parentOrder': LEVELS}
    write_js(target / 'lookup/meta.js', 'window.MapDesignerData.meta', metadata)
    write_js(target / 'lookup/paint-meta.js', 'window.MapDesignerData.paintMeta', {'kinds': kinds.tolist()})
    digest = hashlib.sha256(json_text(metadata).encode('utf-8'))
    for data in (ids.astype('<u2', copy=False), kinds, river_pixels):
        digest.update(data)
    project = {'id': key, 'sourceFingerprint': digest.hexdigest()}
    write_js(target / 'project-meta.js', 'window.EU5ProjectMeta', project)
    env = {**os.environ, 'MAPDESIGNER_MAP_SOURCE': str(target), 'PYTHONUTF8': '1'}
    for script in ('prepare_vector_map.py', 'prepare_vector_rivers.py', 'prepare_country_labels.py'):
        subprocess.run([sys.executable, str(ROOT / 'scripts' / script)], env=env, check=True)
    return {'width': width, 'height': height, 'project': project}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--steam-common', type=Path, default=Path('D:/Steam/steamapps/common'))
    args = parser.parse_args()
    catalog = {}
    for key, game, read in (('hoi4', 'Hearts of Iron IV', read_hoi4), ('vic3', 'Victoria 3', read_vic3)):
        print(f'Building {game}', flush=True)
        catalog[key] = build(key, read(args.steam_common / game))
    write_js(ROOT / 'assets/maps/hoi4/templates.js', 'window.GrandStrategyTemplates', catalog)


if __name__ == '__main__':
    main()
