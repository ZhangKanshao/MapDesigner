"""Calibrate and build ocean relief for the non-EU5 templates."""

import argparse
import csv
import json
from pathlib import Path
import re
import struct
import zipfile

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from prepare_eu5_ocean_styles import ROOT, TARGET, distance_to_coast, read_relief, render_bathymetry


# Kernel radius as a fraction of the map width, then regularization and
# latitude/base polynomial degree. CK3 is a crop and does not wrap.
MODELS = {'hoi4': (.09, .03, 2), 'vic3': (.18, .03, 2), 'ck3': (.24, .03, 1)}
COAST_SAMPLE = (3, 14)


def read_js(path):
    return json.loads(path.read_text(encoding='utf-8').split('=', 1)[1].strip().rstrip(';'))


def map_pixels(directory, controls):
    meta = read_js(directory / 'lookup/meta.js')
    width, height = meta['width'], meta['height']
    band_height = meta['bandHeight']
    xs = np.arange(2, width, 4)
    ids = np.empty((height // 4, width // 4), dtype=np.uint16)
    for index in range((height + band_height - 1) // band_height):
        band = read_js(directory / f'lookup/band-{index}.js')
        for offset in range(2, len(band), 4):
            row = np.array(band[offset], dtype=np.int32)
            ids[(index * band_height + offset) // 4] = row[1::2][np.searchsorted(row[::2], xs, side='right')]
    points = []
    for pid, location in enumerate(meta['locations']):
        if location and location[0] in controls:
            y, x = np.where(ids == pid)
            if len(x):
                points.append(((x.min() + x.max()) / 2, (y.min() + y.max()) / 2, *controls[location[0]]))
    if len(points) < 50:
        raise ValueError(f'Only {len(points)} geographic controls found in {directory}')
    return ids, np.array(points)


def marine_mask(game, games, directory, ids):
    with Image.open(directory / 'rivers.png') as image:
        ocean = np.asarray(image.resize(ids.shape[::-1], Image.Resampling.NEAREST)) == 254
    if game == 'hoi4':
        definition = games / 'Hearts of Iron IV/map/definition.csv'
        with definition.open(encoding='utf-8-sig', errors='replace') as source:
            lakes = [int(row[0]) for row in csv.reader(source, delimiter=';')
                     if len(row) > 4 and row[0].isdigit() and row[4] == 'lake']
    elif game == 'vic3':
        config = (games / 'Victoria 3/game/map_data/default.map').read_text(encoding='utf-8-sig')
        lakes = {int(code, 16) for code in re.findall(r'\bx([0-9a-fA-F]{6})\b', re.search(r'\blakes\s*=\s*\{([^{}]*)\}', config)[1])}
        # The Victoria lookup allocates IDs in ascending source RGB order.
        from prepare_grand_strategy_templates import read_vic3
        _, _, records, _ = read_vic3(games / 'Victoria 3')
        lakes = [pid for pid, rgb, _, _ in records if rgb in lakes]
    else:
        config = (games / 'Crusader Kings III/game/map_data/default.map').read_text(encoding='utf-8-sig')
        categories = {}
        for key, kind, body in re.findall(r'(?m)^(\w+)\s*=\s*(LIST|RANGE)\s*\{([^{}]*)\}', config):
            values = list(map(int, re.findall(r'\d+', re.sub(r'#[^\n]*', '', body))))
            categories.setdefault(key, set()).update(range(values[0], values[1] + 1) if kind == 'RANGE' else values)
        ocean |= np.isin(ids, list(categories['sea_zones'] | categories['impassable_seas']))
        lakes = list(categories['lakes'] | categories['river_provinces'])
    return ocean & ~np.isin(ids, lakes)


def project_fit(points, width, parameters, wrap):
    radius, regularization, degree = parameters
    x, y, latitude, longitude = points.T
    x, y = x / width, y / width
    if wrap:
        offset = np.angle(np.exp(1j * np.radians(longitude - x * 360)).mean(), deg=True)
        lat_model = np.polynomial.Polynomial.fit(y, latitude, degree)

        def base(px, py):
            return lat_model(py), px * 360 + offset

        residual = np.column_stack((latitude - lat_model(y), (longitude - x * 360 - offset + 180) % 360 - 180))
    else:
        center = np.array([x.mean(), y.mean()])
        design = np.column_stack((np.ones_like(x), x - center[0], y - center[1]))
        coefficients = np.linalg.lstsq(design, points[:, 2:], rcond=None)[0]

        def base(px, py):
            return tuple(coefficients[0, i] + (px - center[0]) * coefficients[1, i] +
                         (py - center[1]) * coefficients[2, i] for i in range(2))

        residual = points[:, 2:] - design @ coefficients

    def weights(px, py):
        dx = np.abs(px[..., None] - x)
        if wrap:
            dx = np.minimum(dx, 1 - dx)
        return np.exp(-(dx / radius)**2), np.exp(-((py[..., None] - y) / radius)**2)

    wx, wy = weights(x, y)
    correction = np.linalg.solve(wx * wy + regularization * np.eye(len(x)), residual)

    def project(px, py):
        px, py = px / width, py / width
        lat, lon = base(px, py)
        wx, wy = weights(px, py)
        if px.ndim == 2 and px.shape[0] == 1 and py.shape[1] == 1:
            return lat + (wy[:, 0, :] * correction[:, 0]) @ wx[0].T, lon + (wy[:, 0, :] * correction[:, 1]) @ wx[0].T
        adjustment = (wx * wy) @ correction
        return lat + adjustment[..., 0], lon + adjustment[..., 1]

    return project


def validate_points(points, width, params, wrap):
    errors = []
    for i, (x, y, lat, lon) in enumerate(points):
        fit = project_fit(np.delete(points, i, axis=0), width, params, wrap)
        mapped_lat, mapped_lon = fit(np.array(x), np.array(y))
        dl = (mapped_lon - lon + 180) % 360 - 180
        errors.append(111.2 * np.hypot(mapped_lat - lat, dl * np.cos(np.radians(lat))))
    return np.percentile(errors, [50, 90])


def world_land_mask(path):
    with zipfile.ZipFile(path) as archive:
        data = archive.read('ne_50m_land.shp')
    mask = Image.new('L', (10800, 5400))
    draw = ImageDraw.Draw(mask)
    pos = 100
    while pos < len(data):
        length = struct.unpack_from('>i', data, pos + 4)[0] * 2
        record = pos + 8
        pos = record + length
        if struct.unpack_from('<i', data, record)[0] != 5:
            continue
        parts, count = struct.unpack_from('<2i', data, record + 36)
        starts = (*struct.unpack_from(f'<{parts}i', data, record + 44), count)
        coords = np.frombuffer(data, dtype='<f8', count=count * 2, offset=record + 44 + 4 * parts).reshape(-1, 2)
        for start, end in zip(starts, starts[1:]):
            draw.polygon([((lon + 180) * 30 - .5, (90 - lat) * 30 - .5) for lon, lat in coords[start:end]], fill=255)
    return mask


def coast_agreement(project, ocean, distance, land_distance, public_land):
    low, high = COAST_SAMPLE
    def matches(dist, expected):
        y, x = np.where((dist >= low) & (dist <= high))
        y, x = y[::4], x[::4]
        lat, lon = project(x, y)
        sx = np.rint(((lon + 180) % 360) * 30 - .5).astype(int) % public_land.shape[1]
        sy = np.rint((90 - lat) * 30 - .5).astype(int).clip(0, public_land.shape[0] - 1)
        return float(((public_land[sy, sx] != 0) == expected).mean())
    return matches(distance, False), matches(land_distance, True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('ocean_bottom_zip', type=Path)
    parser.add_argument('land_zip', type=Path)
    parser.add_argument('--steam-common', type=Path, default=Path('D:/Steam/steamapps/common'))
    parser.add_argument('--audit-only', action='store_true')
    args = parser.parse_args()
    controls = json.loads((Path(__file__).parent / 'ocean_control_points.json').read_text(encoding='utf-8'))
    land_mask = world_land_mask(args.land_zip)
    public_land = np.asarray(land_mask)
    relief = None if args.audit_only else read_relief(args.ocean_bottom_zip)
    softened_land = None if args.audit_only else np.asarray(land_mask.filter(ImageFilter.GaussianBlur(11)))
    for game, params in MODELS.items():
        directory = ROOT / 'assets/maps' / ('ck3/1066' if game == 'ck3' else game)
        ids, points = map_pixels(directory, controls[game])
        ocean = marine_mask(game, args.steam_common, directory, ids)
        wrap = game != 'ck3'
        width = ocean.shape[1]
        distance = distance_to_coast(ocean, wrap=wrap)
        land_distance = distance_to_coast(~ocean, limit=COAST_SAMPLE[1], wrap=wrap)
        median, p90 = validate_points(points, width, params, wrap)
        project = project_fit(points, width, params, wrap)
        water_match, land_match = coast_agreement(project, ocean, distance, land_distance, public_land)
        passed = median <= 100 and p90 <= 200 and min(water_match, land_match) >= .78
        print(f'{game}: {len(points)} points, median/p90 {median:.0f}/{p90:.0f} km, '
              f'near-coast water/land agreement {water_match:.1%}/{land_match:.1%}, '
              f'{"pass" if passed else "fail"}', flush=True)
        if passed and not args.audit_only:
            render_bathymetry(relief, ocean, distance, project, TARGET / f'{game}-bathymetry.png', wrap, softened_land)


if __name__ == '__main__':
    main()
