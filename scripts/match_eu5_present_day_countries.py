"""Register modern country polygons against a local patch of the EU5 map."""

import argparse
from collections import Counter
import csv
import hashlib
import json
from pathlib import Path
import re

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import distance_transform_edt
from scipy.spatial import Delaunay
import shapefile


ROOT = Path(__file__).resolve().parents[1]
MAP = ROOT / "assets/maps/eu5"
LOOKUP = MAP / "lookup"
CONTROLS = Path(__file__).with_name("eu5_present_day_control_points.json")
PUBLISHED = MAP / "present-day-map-matches"
LOCATORS = "game/in_game/gfx/map/map_objects/generated_map_object_locators_city.txt"
SOURCE_SHA256 = "16e7589083527d01208b9f645fc8643c767170258e9d13b59d37bc5a1f6a8758"
STEP = 0.0025


def read_assignment(path):
    return json.loads(path.read_text(encoding="utf-8").split("=", 1)[1].strip().removesuffix(";"))


def read_positions(game, map_height):
    source = (game / LOCATORS).read_text(encoding="utf-8-sig")
    entries = re.findall(r"id=(\w+)\s+position=\{\s*([\d.]+)\s+[-\d.]+\s+([\d.]+)\s*\}", source)
    return {key: (float(x), map_height - float(z)) for key, x, z in entries}


def register(controls, positions):
    def arrays(group):
        return np.array([positions[key] for key in group]), np.array(list(group.values()))

    pixels, coords = arrays(controls["anchors"])
    check_pixels, check_coords = arrays(controls["checks"])
    center, span = pixels.mean(axis=0), np.ptp(pixels, axis=0)
    px_per_degree = span / np.ptp(coords, axis=0)

    def design(points, degree):
        x, y = ((points - center) / span).T
        terms = [np.ones_like(x), x, y]
        if degree == 2:
            terms += [x * x, x * y, y * y]
        return np.column_stack(terms)

    # Choose the least complicated warp that improves held-out alignment.
    models = []
    for degree in (1, 2):
        inputs = design(pixels, degree)
        errors = []
        for i in range(len(pixels)):
            train = np.arange(len(pixels)) != i
            fit = np.linalg.lstsq(inputs[train], coords[train], rcond=None)[0]
            errors.append(np.linalg.norm((inputs[i] @ fit - coords[i]) * px_per_degree))
        fit = np.linalg.lstsq(inputs, coords, rcond=None)[0]
        models.append((np.mean(errors), degree, fit, errors))
    mean, degree, fit, errors = min(models, key=lambda model: model[0])

    def warp(points):
        return design(points, degree) @ fit

    checks = dict(zip(controls["checks"], np.linalg.norm(
        (warp(check_pixels) - check_coords) * px_per_degree, axis=1).round(1).tolist()))
    margin = int(np.ceil(max(np.quantile(errors, .9), max(checks.values()))) + 2)
    return pixels, warp, {
        "degree": degree, "anchorCount": len(pixels), "meanHoldoutPx": round(float(mean), 1),
        "checkPx": checks, "marginPx": margin,
    }


def rasterize_countries(source, extent):
    west, south, east, north = extent
    size = (int(np.ceil((east - west) / STEP)) + 2, int(np.ceil((north - south) / STEP)) + 2)
    raster = np.zeros((size[1], size[0]), dtype=np.uint16)
    names = [""]
    english_names = {}
    reader = shapefile.Reader(str(source), encoding="utf-8")
    for record in reader.iterShapeRecords(bbox=extent):
        geometry = record.shape.__geo_interface__
        polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
        mask = Image.new("1", size)
        pen = ImageDraw.Draw(mask)
        for polygon in polygons:
            if not polygon:
                continue
            x, y = np.array(polygon[0]).T
            if x.max() < west or x.min() > east or y.max() < south or y.min() > north:
                continue
            for i, ring in enumerate(polygon):
                pen.polygon([((x - west) / STEP, (north - y) / STEP) for x, y in ring], fill=int(i == 0))
        if mask.getbbox():
            name = record.record["NAME_ZH"]
            if not name:
                raise ValueError(f"Missing Chinese country name: {record.record['ADMIN']}")
            if name not in names:
                names.append(name)
                english_names[name] = record.record["ADMIN"]
            raster[np.asarray(mask)] = names.index(name)
    return raster, names, english_names


def read_location_patch(metadata, bounds):
    left, top, right, bottom = bounds
    patch = np.zeros((bottom - top, right - left), dtype=np.uint16)
    complete_counts = Counter()
    band_height = metadata["bandHeight"]
    for band in range((metadata["height"] + band_height - 1) // band_height):
        rows = read_assignment(LOOKUP / f"band-{band}.js")
        for row_idx, row in enumerate(rows):
            y = band * band_height + row_idx
            start = 0
            for end, key in zip(row[::2], row[1::2]):
                complete_counts[key] += end - start
                if top <= y < bottom and start < right and end > left:
                    patch[y - top, max(0, start - left):min(right, end) - left] = key
                start = end
    return patch, complete_counts


def classify_overlap(raw, total):
    ranked = sorted(range(1, len(raw)), key=lambda i: -raw[i])
    if ranked and 5 * raw[ranked[0]] >= 4 * total:
        return ranked[:1]
    substantial = [i for i in ranked if 5 * raw[i] >= total]
    return substantial if len(substantial) >= 2 else []


def reliable_countries(countries, margin):
    reliable = np.zeros_like(countries)
    for identifier in np.unique(countries):
        if identifier == 0:
            continue
        rival = (countries != 0) & (countries != identifier)
        far = (distance_transform_edt(~rival) > margin) if rival.any() else np.ones(rival.shape, bool)
        reliable[(countries == identifier) & far] = identifier
    return reliable


def analyze_patch(metadata, patch, full_counts, footprint, countries, names, margin, targets=None):
    kinds = read_assignment(LOOKUP / "paint-meta.js")["kinds"]
    reliable = reliable_countries(countries, margin)
    keys = patch[footprint].astype(np.int64)
    inside_counts = np.bincount(keys, minlength=len(metadata["locations"]))
    n = len(names)
    raw_counts = np.bincount(keys * n + countries[footprint], minlength=len(inside_counts) * n).reshape(-1, n)
    stable_counts = np.bincount(keys * n + reliable[footprint], minlength=len(inside_counts) * n).reshape(-1, n)
    estimates = {}
    for key in np.flatnonzero(inside_counts):
        if key == 0 or kinds[key] != 0:
            continue
        if targets is not None and not targets[key]:
            continue
        count = int(full_counts[key])
        inside = int(inside_counts[key])
        raw = raw_counts[key]
        stable = stable_counts[key]
        ranked = sorted(range(1, len(names)), key=lambda i: -raw[i])
        material = [i for i in ranked if raw[i] >= .03 * count]
        covered = int(raw[1:].sum())
        decision = []
        if inside == count and covered >= .75 * count:
            if len(material) == 1 and stable[material[0]] >= .75 * count:
                decision = material
            elif len(material) > 1 and all(stable[i] >= .12 * count for i in material):
                decision = material
        location = metadata["locations"][key]
        estimates[location[0]] = {
            "name": location[1], "id": int(key), "inside": round(inside / count, 3),
            "coverage": round(covered / count, 3),
            "overlap": {names[i]: round(int(raw[i]) / count, 3) for i in ranked if raw[i]},
            "stable": {names[i]: round(int(stable[i]) / count, 3) for i in ranked if stable[i]},
            "countries": [names[i] for i in decision],
        }
        if targets is not None:
            measured = classify_overlap(raw, count) if inside == count else []
            stable_measured = classify_overlap(stable, count) if measured else []
            estimates[location[0]].update({
                "complete": inside == count,
                "areaDecision": [names[i] for i in measured],
                "stableDecision": set(measured) == set(stable_measured) if measured else False,
            })
    return estimates


def render_review(path, metadata, patch, footprint, countries, names, english_names, estimates, points, bounds):
    kinds = read_assignment(LOOKUP / "paint-meta.js")["kinds"]
    land = (patch != 0) & (np.asarray(kinds)[patch] != 1)
    ids = {name: i for i, name in enumerate(names)}
    palette = np.array([(226, 238, 244), (150, 192, 157), (197, 172, 214),
                        (242, 197, 130), (231, 150, 147), (138, 184, 209)], dtype=np.uint8)
    background = palette[0]
    base = np.empty((*patch.shape, 3), dtype=np.uint8)
    base[:] = background
    base[land] = (245, 244, 240)
    boundaries = np.zeros_like(land)
    boundaries[:, 1:] |= patch[:, 1:] != patch[:, :-1]
    boundaries[1:, :] |= patch[1:, :] != patch[:-1, :]
    matches = np.zeros(len(metadata["locations"]), dtype=np.uint16)
    for row in estimates.values():
        if row["countries"]:
            matches[row["id"]] = ids[row["countries"][0]]
    layers = []
    for labels in [countries, matches[patch]]:
        rgb = base.copy()
        mask = land & footprint & (labels != 0)
        rgb[mask] = palette[1 + (labels[mask] - 1) % (len(palette) - 1)]
        rgb[boundaries & land] = rgb[boundaries & land] * .80
        layers.append(Image.fromarray(rgb).resize((patch.shape[1] * 2, patch.shape[0] * 2)))

    width, height = layers[0].size
    image = Image.new("RGB", (2 * width + 30, height + 78), "white")
    image.paste(layers[0], (10, 30))
    image.paste(layers[1], (20 + width, 30))
    draw = ImageDraw.Draw(image)
    draw.text((10, 9), "Modern country polygons after local registration", fill="#263747")
    draw.text((20 + width, 9), "EU5 locations accepted by the overlap and uncertainty checks", fill="#263747")
    left, top = bounds[:2]
    for key, (x, y) in points.items():
        x, y = 10 + round(2 * (x - left)), 30 + round(2 * (y - top))
        draw.line((x - 3, y, x + 3, y), fill="#203952")
        draw.line((x, y - 3, x, y + 3), fill="#203952")
        if key == "asti":
            draw.text((x + 6, y - 7), "Asti", fill="#203952", stroke_width=1, stroke_fill="white")
    draw.text((10, height + 39), "Crosses: reference towns. Uncolored land: outside coverage or awaiting review.", fill="#263747")
    x = 10
    for i in np.unique(countries[land & footprint]):
        if i == 0:
            continue
        name = english_names[names[i]]
        color = tuple(palette[1 + (i - 1) % (len(palette) - 1)])
        draw.rectangle((x, height + 57, x + 12, height + 69), fill=color)
        draw.text((x + 17, height + 56), name, fill="#263747")
        x += int(draw.textlength(name)) + 35
    image.save(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("region")
    parser.add_argument("--game", type=Path, required=True)
    parser.add_argument("--boundaries", type=Path, required=True)
    parser.add_argument("--review-dir", type=Path, required=True)
    parser.add_argument("--publish", action="store_true", help="Save accepted matches for the runtime lookup")
    args = parser.parse_args()
    if hashlib.sha256(args.boundaries.read_bytes()).hexdigest() != SOURCE_SHA256:
        parser.error("Expected the recorded Natural Earth 10m China-view country archive")
    metadata = read_assignment(LOOKUP / "meta.js")
    controls = json.loads(CONTROLS.read_text(encoding="utf-8"))[args.region]
    positions = read_positions(args.game, metadata["height"])
    pixels, warp, calibration = register(controls, positions)
    left, top = np.floor(pixels.min(axis=0)).astype(int)
    right, bottom = np.ceil(pixels.max(axis=0)).astype(int)
    margin = calibration["marginPx"]
    bounds = (left - margin, top - margin, right + margin, bottom + margin)
    left, top, right, bottom = bounds
    y, x = np.mgrid[top:bottom, left:right]
    inputs = np.column_stack((x.ravel() + .5, y.ravel() + .5))
    footprint = (Delaunay(pixels).find_simplex(inputs) >= 0).reshape(x.shape)
    coords = warp(inputs).reshape(*x.shape, 2)
    # Detect a folded transform before using its raster for land attribution.
    dx = coords[:-1, 1:] - coords[:-1, :-1]
    dy = coords[1:, :-1] - coords[:-1, :-1]
    if np.any((dx[..., 0] * dy[..., 1] - dx[..., 1] * dy[..., 0])[footprint[:-1, :-1]] >= 0):
        raise ValueError("Warp folds inside its control-point footprint")
    lon, lat = coords.transpose(2, 0, 1)
    west, south = coords.reshape(-1, 2).min(axis=0) - STEP
    east, north = coords.reshape(-1, 2).max(axis=0) + STEP
    source, names, english_names = rasterize_countries(args.boundaries, (west, south, east, north))
    countries = source[np.rint((north - lat) / STEP).astype(int), np.rint((lon - west) / STEP).astype(int)]
    patch, counts = read_location_patch(metadata, bounds)
    point_positions = {key: positions[key] for key in controls["anchors"] | controls["checks"]}
    for key, (px, py) in point_positions.items():
        location = metadata["locations"][patch[int(py) - top, int(px) - left]]
        if location is None or location[0] != key:
            raise ValueError(f"EU5 city locator does not match the current location map: {key}")
    estimates = analyze_patch(metadata, patch, counts, footprint, countries, names, margin)

    args.review_dir.mkdir(parents=True, exist_ok=True)
    source_fingerprint = read_assignment(MAP / "project-meta.js")["sourceFingerprint"]
    review = {"region": args.region, "sourceFingerprint": source_fingerprint,
              "calibration": calibration, "bounds": [int(i) for i in bounds], "locations": estimates}
    (args.review_dir / f"{args.region}.json").write_text(
        json.dumps(review, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    render_review(args.review_dir / f"{args.region}.png", metadata, patch, footprint,
                  countries, names, english_names, estimates, point_positions, bounds)
    with (args.review_dir / f"{args.region}.csv").open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.writer(file)
        writer.writerow(["location", "name", "inside", "coverage", "overlap", "stable", "countries"])
        for key, row in estimates.items():
            writer.writerow([key, row["name"], row["inside"], row["coverage"],
                             json.dumps(row["overlap"], ensure_ascii=False),
                             json.dumps(row["stable"], ensure_ascii=False), "/".join(row["countries"])])
    report = Counter("matched" if row["countries"] else "review" for row in estimates.values())
    if args.publish:
        PUBLISHED.mkdir(exist_ok=True)
        published = {"sourceFingerprint": source_fingerprint, "boundarySha256": SOURCE_SHA256,
                     "calibration": calibration, "locations": {key: row["countries"]
                     for key, row in estimates.items() if row["countries"]}}
        (PUBLISHED / f"{args.region}.json").write_text(
            json.dumps(published, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"calibration": calibration, "locations": report}, ensure_ascii=False))


if __name__ == "__main__":
    main()
