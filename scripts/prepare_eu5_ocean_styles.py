"""Build EU5 ocean textures using Natural Earth's public-domain Ocean Bottom raster.

Source archive: https://naturalearth.s3.amazonaws.com/50m_raster/OB_50M.zip
"""

import argparse
from pathlib import Path
import re
import zipfile

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/maps/eu5'
TARGET = ROOT / 'assets/maps/styles'
Image.MAX_IMAGE_PIXELS = None

# Latitude and longitude of identifiable settlements and bays. In-game
# location centroids are approximate, so use them to guide broad ocean relief.
ANCHORS = {
    'london': (51.51, -.13), 'lisbon': (38.72, -9.14), 'stockholm': (59.33, 18.07),
    'constantinople': (41.01, 28.98), 'marrakesh': (31.63, -8), 'cairo': (30.04, 31.24),
    'accra': (5.55, -.2), 'luanda': (-8.84, 13.23), 'table_bay': (-33.88, 18.45),
    'mozambique': (-15.03, 40.73), 'mombasa': (-4.05, 39.67), 'zanzibar_island': (-6.14, 39.33),
    'surat': (21.17, 72.83), 'goa': (15.49, 73.83), 'madras': (13.08, 80.27),
    'chittagong': (22.36, 91.78), 'thang_long': (21.03, 105.85), 'malacca': (2.19, 102.25),
    'banten': (-6.04, 106.16), 'manila_bay': (14.55, 120.78), 'brunei_bay': (4.91, 115.10),
    'halifax_bay': (-19.1, 146.6), 'perth_bay': (-31.97, 115.55), 'tahiti': (-17.65, -149.45),
    'guangzhou': (23.13, 113.26), 'hangzhou': (30.25, 120.16), 'dadu': (39.92, 116.40),
    'dongnae': (35.20, 129.08), 'hakata': (33.59, 130.41), 'kamakura': (35.32, 139.55),
    'sapporo': (43.06, 141.35), 'manhattan': (40.78, -73.97),
    'sydney_bight': (46.15, -60.1), 'habana': (23.11, -82.37),
    'tenochtitlan': (19.43, -99.13), 'acapulco_bay': (16.83, -99.89),
    'panama': (8.97, -79.53), 'caracas': (10.48, -66.90),
    'quito': (-.22, -78.51), 'recife_cape': (-34.03, 25.70), 'salvador_cape': (-13.0, -38.53),
}


def eu5_inputs():
    names = {}
    for path in (SOURCE / 'named_locations').glob('*.txt'):
        text = re.sub(r'#[^\n]*', '', path.read_text(encoding='utf-8-sig'))
        names.update({name: int(value, 16) for name, value in
                      re.findall(r'^\s*(\w+)\s*=\s*([0-9a-fA-F]+)\s*$', text, re.M)})
    config = re.sub(r'#[^\n]*', '', (SOURCE / 'default.map').read_text(encoding='utf-8-sig'))
    lakes = re.search(r'\blakes\s*=\s*\{([^{}]*)\}', config)[1].split()
    sea_zones = re.search(r'\bsea_zones\s*=\s*\{([^{}]*)\}', config)[1].split()
    with Image.open(SOURCE / 'locations.png') as locations, Image.open(SOURCE / 'rivers.png') as rivers:
        size = (locations.width // 4, locations.height // 4)
        rgb = np.asarray(locations.resize(size, Image.Resampling.NEAREST).convert('RGB'), dtype=np.uint32)
        ids = (rgb[:, :, 0] << 16) | (rgb[:, :, 1] << 8) | rgb[:, :, 2]
        ocean = np.asarray(rivers.resize(size, Image.Resampling.NEAREST)) == 254
    # Some coastal zones (e.g. Kele Bay) use the land-background river index.
    ocean |= np.isin(ids, [names[name] for name in sea_zones])
    ocean &= ~np.isin(ids, [names[name] for name in lakes])
    points = []
    for name, (lat, lon) in ANCHORS.items():
        if name not in names:
            continue
        y, x = np.where(ids == names[name])
        if len(x):
            points.append((x.mean(), y.mean(), lat, lon))
    if len(points) < 30:
        raise ValueError('Missing EU5 geographic control points')
    return ocean, np.array(points)


def distance_to_coast(ocean, limit=29, wrap=True):
    distance = np.full(ocean.shape, limit + 1, dtype=np.uint8)
    reached = ~ocean
    for step in range(1, limit + 1):
        expanded = reached.copy()
        expanded[:, 1:] |= reached[:, :-1]
        expanded[:, :-1] |= reached[:, 1:]
        if wrap:
            expanded[:, 0] |= reached[:, -1]
            expanded[:, -1] |= reached[:, 0]
        expanded[1:] |= reached[:-1]
        expanded[:-1] |= reached[1:]
        distance[expanded & ~reached] = step
        reached = expanded
    distance[~ocean] = 0
    return distance


def read_relief(archive_path):
    with zipfile.ZipFile(archive_path) as archive, archive.open('OB_50M/OB_50M.tif') as source:
        with Image.open(source) as image:
            if image.size != (10800, 5400):
                raise ValueError('Expected the geographic 1:50m Ocean Bottom grid')
            return np.asarray(image.convert('RGB'))


def bathymetry(archive_path, ocean, distance, points):
    height, width = ocean.shape
    x, y, lat, lon = points.T
    # Longitude wraps continuously. Fit latitude globally, then blend bounded
    # local corrections so distant ocean regions never inherit a regional warp.
    lon_base = 360 / width
    lon_offset = np.angle(np.exp(1j * np.radians(lon - x * lon_base)).mean(), deg=True)
    lon_error = (lon - (x * lon_base + lon_offset) + 180) % 360 - 180
    if np.max(np.abs(lon_error)) > 8:
        raise ValueError('Check for geographic control points with ambiguous names')
    lat_model = np.polynomial.Polynomial.fit(y, lat, 2)
    lat_error = lat - lat_model(y)
    def project(columns, rows):
        lon_fix = np.zeros((len(rows), width), dtype=np.float32)
        lat_fix = np.zeros_like(lon_fix)
        weight = np.full_like(lon_fix, .3)
        for px, py, d_lat, d_lon in zip(x, y, lat_error, lon_error):
            dx = (columns - px + width / 2) % width - width / 2
            influence = np.exp(-(dx**2 + (rows - py)**2) / (width * .0625)**2)
            lon_fix += influence * d_lon
            lat_fix += influence * d_lat
            weight += influence
        return lat_model(rows) + lat_fix / weight, columns * lon_base + lon_offset + lon_fix / weight
    render_bathymetry(read_relief(archive_path), ocean, distance, project, TARGET / 'eu5-bathymetry.png')
    print(f'{len(points)} control points, texture {width} × {height}')


def render_bathymetry(relief, ocean, distance, project, target, wrap=True, public_land=None):
    height, width = ocean.shape
    result = np.empty((height, width, 4), dtype=np.uint8)
    columns = np.arange(width)[None, :]
    # Extend one texel below the vector coastline, so the image's mask and the
    # exact land outline do not leave a bright strip between them.
    coverage = ocean.copy()
    coverage[:, 1:] |= ocean[:, :-1]
    coverage[:, :-1] |= ocean[:, 1:]
    if wrap:
        coverage[:, 0] |= ocean[:, -1]
        coverage[:, -1] |= ocean[:, 0]
    coverage[1:] |= ocean[:-1]
    coverage[:-1] |= ocean[1:]
    # Compositing at alpha 240 over default water gives the sampled Yellow Sea blue (#84b8db).
    coastal_blue = np.array([129, 182, 218])
    for top in range(0, height, 64):
        rows = np.arange(top, min(top + 64, height))[:, None]
        latitude, longitude = project(columns, rows)
        longitude = (longitude + 180) % 360
        latitude = np.clip(latitude, -89.99, 89.99)
        sx = longitude * 30 - .5
        sy = (90 - latitude) * 30 - .5
        x0 = np.floor(sx).astype(int)
        y0 = np.clip(np.floor(sy).astype(int), 0, relief.shape[0] - 2)
        fx = (sx - x0)[..., None]
        fy = np.clip(sy - y0, 0, 1)[..., None]
        left, right = x0 % relief.shape[1], (x0 + 1) % relief.shape[1]
        upper = (1 - fx) * relief[y0, left] + fx * relief[y0, right]
        lower = (1 - fx) * relief[y0 + 1, left] + fx * relief[y0 + 1, right]
        section = result[top:top + len(rows)]
        coast = np.clip((distance[top:top + len(rows)].astype(float) - 1) / 23, 0, 1)[..., None]
        coast = coast**2 * (3 - 2 * coast)
        if public_land is not None:
            # A modern island or shoreline can differ from the game's geometry.
            # Blend to the coastal tint where the public raster has no sea data.
            coast *= 1 - public_land[np.rint(sy).astype(int).clip(0, relief.shape[0]-1),
                                     np.rint(sx).astype(int) % relief.shape[1]][..., None] / 255
        sampled = (1 - fy) * upper + fy * lower
        # Fade to blue near land rather than fading to the pale base water.
        section[:, :, :3] = np.rint(coast * sampled + (1 - coast) * coastal_blue).astype(np.uint8)
        section[:, :, 3] = np.where(coverage[top:top + len(rows)], 240, 0)
    Image.fromarray(result).save(target, optimize=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('ocean_bottom_zip', type=Path)
    args = parser.parse_args()
    water, controls = eu5_inputs()
    coast_distance = distance_to_coast(water)
    bathymetry(args.ocean_bottom_zip, water, coast_distance, controls)
