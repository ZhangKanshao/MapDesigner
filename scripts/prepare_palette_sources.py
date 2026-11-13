"""Package indexed basemap bytes for offline PNG palette changes, including file://."""
from pathlib import Path
import base64
import json
import struct
root = Path(__file__).resolve().parents[1] / 'assets/maps/eu5'
output = root / 'palette'
output.mkdir(exist_ok=True)
for source in sorted(root.glob('basemap*.png')):
    if source.name == 'basemap-preview.png':
        continue
    data = source.read_bytes()
    if data[25] != 3:
        raise ValueError(f'Expected indexed PNG: {source}')
    encoded = base64.b64encode(data).decode('ascii')
    (output / (source.stem + '.js')).write_text('window.MapPaletteSources=window.MapPaletteSources||{};window.MapPaletteSources[' + json.dumps(source.name) + ']=' + json.dumps(encoded) + ';', encoding='utf-8')
    print(source.name, len(data))
