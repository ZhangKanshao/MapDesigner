"""Generate offline relief textures from local game terrain."""
import argparse
import io
from pathlib import Path
import re

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
Image.MAX_IMAGE_PIXELS = None


def eu5_height(cache, level=4):
    info = (cache / 'heightmap.info').read_text()
    width, height = map(int, re.search(r'source_resolution=\{\s*(\d+)\s+(\d+)\s*\}', info).groups())
    edge = int(re.search(r'tile_size=(\d+)', info)[1])
    border = int(re.search(r'border_size=(\d+)', info)[1])
    index = [tuple(map(int, pair)) for pair in re.findall(r'offset=(\d+)\s+size=(\d+)', info)]
    cols, rows = width // edge, height // edge
    offset = 0
    for _ in range(level):
        offset += cols * rows
        cols, rows = cols // 2, rows // 2
    if len(index) < offset + cols * rows:
        raise ValueError('EU5 height cache is missing tiles at the requested level.')
    blocks = np.empty((rows, cols, edge, edge), dtype=np.uint16)
    with (cache / 'heightmap.bin').open('rb') as source:
        for tile, (position, size) in enumerate(index[offset:offset + cols * rows]):
            source.seek(position)
            with Image.open(io.BytesIO(source.read(size))) as image:
                # Rows in the cache run south to north, individual PNG rows run north to south.
                blocks[rows - 1 - tile // cols, tile % cols] = np.asarray(image)[border:border+edge, border:border+edge]
    return blocks.transpose(0, 2, 1, 3).reshape(rows * edge, cols * edge)


def save_overlay(values, target):
    # Palette entries are translucent black or white. The renderer clips them to land.
    values = np.clip(np.rint(values), -127, 127).astype(np.int16)
    texture = Image.fromarray((values + 128).astype(np.uint8)).convert('P')
    texture.putpalette([channel for index in range(256) for channel in (0 if index <= 128 else 255,) * 3])
    transparency = bytes(abs(index - 128) for index in range(256))
    target.parent.mkdir(parents=True, exist_ok=True)
    texture.save(target, transparency=transparency, optimize=True)
    print(f'{target.relative_to(ROOT)}: {texture.width} × {texture.height}')


def hillshade(elevation, base, strength):
    elevation = np.maximum(0, (np.asarray(elevation, dtype=np.float32) - base) / 1250)
    dy, dx = np.gradient(elevation)
    light = (.56*dx + .40*dy + .72) / np.sqrt(dx*dx + dy*dy + 1)
    return np.clip(((light - .72)*115 - np.sqrt(elevation)*8) * strength, -76, 16)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--steam-common', type=Path, default=Path('D:/Steam/steamapps/common'))
    parser.add_argument('--game', choices=('eu5', 'ck3', 'hoi4', 'vic3'), action='append',
                        help='Generate relief for the selected game. May be repeated. Defaults to all games.')
    args = parser.parse_args()
    games = args.steam_common
    target = ROOT / 'assets/maps/styles'
    selected = set(args.game or ('eu5', 'ck3', 'hoi4', 'vic3'))
    if 'eu5' in selected:
        eu5 = games / 'Europa Universalis V/game/in_game/gfx/terrain2/terrain_cache'
        save_overlay(hillshade(eu5_height(eu5), 4500, .64), target / 'eu5-relief.png')
    if 'ck3' in selected:
        ck3 = games / 'Crusader Kings III/game/map_data/heightmap.png'
        with Image.open(ck3) as image:
            elevation = image.resize((image.width // 4, image.height // 4), Image.Resampling.BILINEAR)
        save_overlay(hillshade(elevation, 2800, .78), target / 'ck3-relief.png')
    if 'hoi4' in selected:
        hoi4 = games / 'Hearts of Iron IV/map/heightmap.bmp'
        with Image.open(hoi4) as image:
            # Elevations are 8-bit, with sea level at 89 in the source.
            elevation = (np.asarray(image.convert('L'), dtype=np.float32) - 89) * 256
        save_overlay(hillshade(elevation, 0, .75), target / 'hoi4-relief.png')
    if 'vic3' in selected:
        vic3 = games / 'Victoria 3/game/map_data/heightmap.png'
        with Image.open(vic3) as image:
            # One map pixel spans a 2×2 block in the 16-bit heightmap.
            elevation = image.resize((image.width // 2, image.height // 2), Image.Resampling.BOX)
        save_overlay(hillshade(elevation, 4800, .78), target / 'vic3-relief.png')


if __name__ == '__main__':
    main()
