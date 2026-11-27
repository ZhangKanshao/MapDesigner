"""Build and compare overlapping EU5 registrations using modern gazetteer control points."""

import argparse
from collections import Counter, defaultdict
import csv
import hashlib
import io
import json
from pathlib import Path
import unicodedata
import zipfile

import numpy as np
from scipy.ndimage import distance_transform_edt, maximum_filter
from scipy.spatial import ConvexHull, Delaunay
import shapefile
import shapely
from shapely.geometry import box, shape
from shapely.strtree import STRtree

from match_eu5_present_day_countries import (
    CONTROLS, LOOKUP, MAP, PUBLISHED, SOURCE_SHA256, analyze_patch, read_assignment, read_positions, register,
)


def normalize(name):
    return "".join(c for c in unicodedata.normalize("NFKD", name.casefold()) if c.isalnum())


def read_map(metadata):
    raster = np.empty((metadata["height"], metadata["width"]), dtype=np.uint16)
    counts = np.zeros(len(metadata["locations"]), dtype=np.int64)
    height = metadata["bandHeight"]
    for top in range(0, metadata["height"], height):
        rows = read_assignment(LOOKUP / f"band-{top // height}.js")
        for y, row in enumerate(rows, top):
            ends = np.asarray(row[::2])
            ids = np.asarray(row[1::2])
            lengths = np.diff(ends, prepend=0)
            np.add.at(counts, ids, lengths)
            raster[y] = np.repeat(ids, lengths)
    return raster, counts


def read_gazetteer(archive, positions, metadata, raster, country_matches=None):
    wanted = defaultdict(set)
    kinds = read_assignment(LOOKUP / "paint-meta.js")["kinds"]
    for id_, location in enumerate(metadata["locations"]):
        if location and kinds[id_] == 0 and location[0] in positions:
            key, label, _ = location
            px, py = map(int, positions[key])
            if 0 <= py < raster.shape[0] and 0 <= px < raster.shape[1] and raster[py, px] == id_:
                for name in (normalize(key), normalize(label)):
                    if len(name) >= 2:
                        wanted[name].add(key)
    candidates = defaultdict(set)
    with zipfile.ZipFile(archive) as file, io.TextIOWrapper(file.open("cities1000.txt"), encoding="utf-8") as rows:
        for row in rows:
            _, name, ascii_name, aliases, lat, lon, _, _, code, *_ = row.split("\t")
            coord = (float(lon), float(lat))
            for candidate in [name, ascii_name, *aliases.split(",")]:
                for key in wanted.get(normalize(candidate), ()):
                    candidates[key].add(coord)
                    if country_matches is not None and key in country_matches:
                        country_matches[key].add((coord, code))
    # Where available, keep independently chosen locations over gazetteer aliases.
    for region in json.loads(CONTROLS.read_text(encoding="utf-8")).values():
        if not region.get("useInAtlas"):
            continue
        for key, coord in (region["anchors"] | region["checks"]).items():
            candidates[key] = {tuple(coord)}
    return {key: np.array(sorted(coords)) for key, coords in candidates.items() if key in positions}


def registration(keys, positions, candidates, seed, small=False):
    # Split before either fitting or selecting a geographically plausible same-name town.
    check_keys = keys[::4]
    train_keys = [key for i, key in enumerate(keys) if i % 4]
    unique = [key for key in train_keys if len(candidates[key]) == 1]
    minimum_unique = 7 if small else 9
    minimum_checks = 3 if small else 4
    if len(unique) < minimum_unique or len(check_keys) < minimum_checks:
        return None
    xy = np.array([positions[key] for key in unique])
    coords = np.array([candidates[key][0] for key in unique])
    center = xy.mean(axis=0)
    inputs = np.column_stack((np.ones(len(xy)), xy - center))
    rng = np.random.default_rng(seed)
    # A few exact, globally unique names seed a warp even when neighboring
    # historical names have aliases elsewhere. Reject nearly collinear triples.
    samples = np.array([rng.choice(len(xy), 3, replace=False) for _ in range(240)])
    matrices = inputs[samples]
    samples = samples[np.abs(np.linalg.det(matrices)) > 3000]
    if not len(samples):
        return None
    fits = np.linalg.solve(inputs[samples], coords[samples])
    linear = fits[:, 1:]
    scales = np.linalg.norm(linear, axis=2)
    valid = (np.linalg.det(linear) < -0.00003) & (linear[:, 0, 0] > .004) & (linear[:, 1, 1] < -.004)
    valid &= (scales.min(axis=1) >= .006) & (scales.max(axis=1) <= .16)
    fits = fits[valid]
    if not len(fits):
        return None
    inverses = np.linalg.inv(fits[:, 1:])
    reconstructed = (coords[None] - fits[:, :1]) @ inverses
    errors = np.linalg.norm(reconstructed - (xy - center), axis=2)
    scores = np.sum(np.clip(1 - (errors / 25) ** 2, 0, 1), axis=1)
    nearest = int(scores.argmax())
    if np.count_nonzero(errors[nearest] <= 25) < minimum_unique:
        return None
    coarse = fits[nearest]
    near = errors[nearest] <= 25
    coarse = np.linalg.lstsq(inputs[near], coords[near], rcond=None)[0]
    inverse = np.linalg.inv(coarse[1:])

    def select(pool, max_distance):
        selected = {}
        for key in pool:
            options = candidates[key]
            displacement = (options - coarse[0]) @ inverse - (positions[key] - center)
            errors = np.linalg.norm(displacement, axis=1)
            best = int(errors.argmin())
            if errors[best] > max_distance:
                continue
            ambiguous = (errors < errors[best] + 8) & (np.linalg.norm(options - options[best], axis=1) > .12)
            if not ambiguous.any():
                selected[key] = options[best].tolist()
        return selected

    training = select(train_keys, 23)
    checks = select(check_keys, 33)
    if len(training) < (9 if small else 11) or len(checks) < minimum_checks:
        return None
    anchor_pixels = np.array([positions[key] for key in training])
    if np.ptp(anchor_pixels, axis=0).min() < (95 if small else 145) or np.ptp(list(training.values()), axis=0)[0] > 60:
        return None
    check_pixels = np.array([positions[key] for key in checks])
    if np.ptp(check_pixels, axis=0).min() < (60 if small else 90):
        return None
    result = register({"anchors": training, "checks": checks}, positions)
    quality = result[2]
    if quality["marginPx"] > 37 or quality["meanHoldoutPx"] > 16:
        return None
    return result


def read_polygons(archive):
    with shapefile.Reader(str(archive), encoding="utf-8") as source:
        records = list(source.iterShapeRecords())
    geometries = [shapely.make_valid(shape(row.shape.__geo_interface__)) for row in records]
    shapely.prepare(geometries)
    return geometries, STRtree(geometries), records


def sample_polygons(index, longitude, latitude, conflict=False):
    geometries, tree, records = index
    extent = box(longitude.min(), latitude.min(), longitude.max(), latitude.max())
    sampled = np.zeros(longitude.shape, dtype=np.uint16)
    names = [""]
    for idx in sorted(tree.query(extent)):
        polygon = geometries[idx]
        left, bottom, right, top = polygon.bounds
        extent_mask = (longitude >= left) & (longitude <= right) & (latitude >= bottom) & (latitude <= top)
        if not extent_mask.any():
            continue
        hits = shapely.intersects_xy(polygon, longitude[extent_mask], latitude[extent_mask])
        if not hits.any():
            continue
        name = "review" if conflict else records[idx].record["NAME_ZH"]
        if not name:
            continue
        if name not in names:
            names.append(name)
        sampled[np.flatnonzero(extent_mask)[hits]] = names.index(name)
    return sampled, names


def movement_support(result, positions):
    pixels, _, quality = result
    hull = ConvexHull(pixels)
    points = np.array([positions[key] for key, error in quality["checkPx"].items() if error <= 22], dtype=float)
    if not len(points):
        return pixels
    beyond = (points @ hull.equations[:, :2].T + hull.equations[:, 2]).max(axis=1)
    stretch_limit = min(52, .15 * np.ptp(pixels, axis=0).min())
    return np.vstack([pixels, points[(beyond > 0) & (beyond <= stretch_limit)]])


def sample_tile(result, raster, boundaries, disputed, targets=None, dispute_margin=None):
    pixels, warp, quality = result
    margin = quality["marginPx"]
    left, top = np.maximum(0, np.floor(pixels.min(axis=0) - margin)).astype(int)
    right, bottom = np.minimum(raster.shape[::-1], np.ceil(pixels.max(axis=0) + margin)).astype(int)
    patch = raster[top:bottom, left:right]
    if targets is None:
        sampled = np.ones(patch.shape, dtype=bool)
    else:
        core = targets[patch]
        if not core.any():
            return None
        # Keep a halo around target pixels so rival countries and disputed
        # polygons still participate in the calibration uncertainty test.
        sampled = maximum_filter(core, size=2 * margin + 1, mode="constant")
    y, x = np.nonzero(sampled)
    inputs = np.column_stack((x + left + .5, y + top + .5))
    calibrated = Delaunay(pixels).find_simplex(inputs) >= 0
    if not calibrated.any():
        return None
    footprint = np.zeros(patch.shape, dtype=bool)
    footprint[sampled] = calibrated
    coords = warp(inputs)
    lon, lat = coords.T
    if np.ptp(lon) > 75 or np.abs(lon).max() > 180 or np.abs(lat).max() > 90:
        return None
    gx = warp(inputs + [1, 0]) - coords
    gy = warp(inputs + [0, 1]) - coords
    if np.any((gx[:, 0] * gy[:, 1] - gx[:, 1] * gy[:, 0])[calibrated] >= 0):
        return None
    values, names = sample_polygons(boundaries, lon, lat)
    countries = np.zeros(patch.shape, dtype=np.uint16)
    countries[sampled] = values
    disputes, _ = sample_polygons(disputed, lon, lat, conflict=True)
    dispute_nearby = np.zeros_like(footprint)
    if disputes.any():
        dispute_pixels = np.zeros(patch.shape, dtype=bool)
        dispute_pixels[sampled] = disputes != 0
        distance = distance_transform_edt(~dispute_pixels)
        dispute_nearby = (distance <= (margin if dispute_margin is None else dispute_margin)) & footprint
    return int(left), int(top), patch, footprint, countries, names, dispute_nearby


def run_tile(result, metadata, raster, counts, boundaries, disputed, targets=None, dispute_margin=None):
    tile = sample_tile(result, raster, boundaries, disputed, targets, dispute_margin)
    if tile is None:
        return {}, set()
    _, _, patch, footprint, countries, names, dispute_nearby = tile
    sensitive = set(np.unique(patch[dispute_nearby]))
    estimates = analyze_patch(metadata, patch, counts, footprint, countries, names, result[2]["marginPx"], targets)
    return estimates, sensitive


def largest_country_by_area(windows):
    totals = Counter()
    for window in windows:
        for country, share in window["overlap"].items():
            # The window measurements are stored to three decimal places.
            totals[country] += round(share * 1000)
    ranked = totals.most_common(2)
    if not ranked or not ranked[0][1] or (len(ranked) > 1 and ranked[0][1] == ranked[1][1]):
        return []
    return [ranked[0][0]]


def review_area_matches(metadata, targets, observations, sensitive, args, report, *, use_largest_share=False):
    accepted = {}
    counts = Counter()
    report_file = args.review_dir / "area-overlap.csv"
    with report_file.open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.writer(file)
        writer.writerow(["location", "name", "status", "countries", "country_shares_by_registration"])
        for id_ in np.flatnonzero(targets):
            key, name, _ = metadata["locations"][id_]
            readings = observations[key]
            complete = [row for row in readings if row["complete"]]
            votes = Counter(tuple(sorted(row["areaDecision"])) for row in complete if row["areaDecision"])
            countries = []
            if key in sensitive:
                status = "disputed-area"
            elif not complete:
                status = "incomplete-registration" if readings else "no-registration"
            elif len(votes) > 1:
                status = "conflicting-registrations"
            elif not votes:
                if use_largest_share:
                    countries = largest_country_by_area(complete)
                status = "matched-largest-share" if countries else "below-threshold"
            else:
                agreements = next(iter(votes.values()))
                strongest = max((row for row in complete if row["areaDecision"]),
                                key=lambda row: (row["stableDecision"], -row["marginPx"]))
                if agreements * 2 <= len(complete) or (agreements == 1 and not strongest["stableDecision"]):
                    status = "uncertain-registration"
                else:
                    status = "matched"
                    countries = strongest["areaDecision"]
            if countries:
                accepted[key] = countries
            counts[status] += 1
            writer.writerow([key, name, status, "/".join(countries), json.dumps(readings, ensure_ascii=False)])
    if args.publish:
        output = MAP / "present-day-overlap-matches.json"
        previous = json.loads(output.read_text(encoding="utf-8")) if output.exists() else None
        if previous is not None and previous["sourceFingerprint"] != report["sourceFingerprint"]:
            raise ValueError("Previous overlap results refer to another EU5 map version")
        merged = {**(previous["locations"] if previous else {}), **accepted}
        output.write_text(json.dumps({**report, "locations": merged}, ensure_ascii=False, separators=(",", ":")) + "\n",
                          encoding="utf-8")
    print(json.dumps({"counts": counts, "crossBorder": sum(len(names) > 1 for names in accepted.values())}), flush=True)
    return accepted


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game", type=Path, required=True)
    parser.add_argument("--boundaries", type=Path, required=True)
    parser.add_argument("--disputed", type=Path, required=True)
    parser.add_argument("--gazetteer", type=Path, required=True)
    parser.add_argument("--review-dir", type=Path, required=True)
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--unassigned-only", action="store_true", help="Apply 80/20 area thresholds to the current unassigned locations")
    args = parser.parse_args()
    if hashlib.sha256(args.boundaries.read_bytes()).hexdigest() != SOURCE_SHA256:
        parser.error("Expected the recorded Natural Earth 10m China-view country archive")
    metadata = read_assignment(LOOKUP / "meta.js")
    fingerprint = read_assignment(MAP / "project-meta.js")["sourceFingerprint"]
    report = {"sourceFingerprint": fingerprint, "boundarySha256": SOURCE_SHA256,
              "gazetteerSha256": hashlib.sha256(args.gazetteer.read_bytes()).hexdigest(),
              "disputedSha256": hashlib.sha256(args.disputed.read_bytes()).hexdigest()}
    targets = None
    if args.unassigned_only:
        lookup = read_assignment(LOOKUP / "present-day-countries.js")
        if lookup["sourceFingerprint"] != fingerprint:
            raise ValueError("Current country lookup refers to another EU5 map version")
        kinds = read_assignment(LOOKUP / "paint-meta.js")["kinds"]
        targets = np.array([bool(row) and kinds[id_] == 0 and str(id_) not in lookup["locations"]
                            for id_, row in enumerate(metadata["locations"])])
        print(f"Unassigned land locations: {targets.sum()}", flush=True)
    raster, counts = read_map(metadata)
    positions = read_positions(args.game, metadata["height"])
    candidates = read_gazetteer(args.gazetteer, positions, metadata, raster)
    boundaries = read_polygons(args.boundaries)
    disputed = read_polygons(args.disputed)
    keys = sorted(candidates)
    xy = np.array([positions[key] for key in keys])
    keys = np.array(keys)
    print(f"Named control-point candidates: {len(keys)}", flush=True)
    manual = {}
    for path in sorted(PUBLISHED.glob("*.json")):
        if path.stem != "atlas":
            manual.update(json.loads(path.read_text(encoding="utf-8"))["locations"])
    matches = defaultdict(Counter)
    sensitive = set()
    inspected = set()
    tiles = []
    observations = defaultdict(list)
    # Smaller windows adapt to local distortion; larger ones bridge gaps in land
    # coverage and provide an independent fit in overlapping areas.
    tile_sizes = [(640, 420), (1040, 690)]
    if targets is not None:
        tile_sizes.append((1440, 820))
    for size, stride in tile_sizes:
        for top in range(-stride // 2, metadata["height"], stride):
            for left in range(-stride // 2, metadata["width"], stride):
                in_tile = ((xy[:, 0] >= left) & (xy[:, 0] < left + size) &
                           (xy[:, 1] >= top) & (xy[:, 1] < top + size))
                if in_tile.sum() < 18:
                    continue
                seed = (top + stride) * metadata["width"] + left + stride
                result = registration(keys[in_tile].tolist(), positions, candidates, seed)
                if result is None:
                    continue
                estimates, disputed_ids = run_tile(result, metadata, raster, counts, boundaries, disputed, targets)
                if not estimates:
                    continue
                inspected.update(estimates)
                sensitive.update(metadata["locations"][i][0] for i in disputed_ids if i)
                accepted = 0
                for key, row in estimates.items():
                    if targets is not None:
                        observations[key].append({"tile": [left, top, size], "inside": row["inside"],
                                                  "complete": row["complete"], "overlap": row["overlap"],
                                                  "areaDecision": row["areaDecision"], "stableDecision": row["stableDecision"],
                                                  "marginPx": result[2]["marginPx"]})
                    if row["countries"]:
                        matches[key][tuple(sorted(row["countries"]))] += 1
                        accepted += 1
                quality = result[2]
                tiles.append({"tile": [left, top, size], "anchors": quality["anchorCount"],
                              "checkPx": quality["checkPx"], "marginPx": quality["marginPx"], "accepted": accepted})
        observed_count = len(observations) if targets is not None else len(matches)
        print(f"Tile size {size}: {len(tiles)} registrations, {observed_count} candidate locations", flush=True)

    args.review_dir.mkdir(parents=True, exist_ok=True)
    if targets is not None:
        review_area_matches(metadata, targets, observations, sensitive, args, report, use_largest_share=True)
        return

    accepted = {}
    review_locations = []
    status_counts = Counter()
    with (args.review_dir / "atlas.csv").open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.writer(file)
        writer.writerow(["location", "name", "game_region", "status", "countries_by_tile"])
        for row in metadata["locations"]:
            if not row or row[0] not in inspected:
                continue
            key, name, parents = row
            guesses = matches.get(key, {})
            if key in sensitive:
                status = "disputed-area"
            elif len(guesses) > 1 or (key in manual and guesses and tuple(sorted(manual[key])) not in guesses):
                status = "conflicting-registrations"
            elif not guesses:
                status = "needs-review"
            elif len(next(iter(guesses))) > 1 and max(guesses.values()) < 2:
                status = "single-registration-border"
            elif key in manual:
                status = "already-calibrated"
            else:
                status = "matched"
                accepted[key] = list(next(iter(guesses)))
            if status in ("disputed-area", "conflicting-registrations", "single-registration-border"):
                review_locations.append(key)
            status_counts[status] += 1
            region = metadata["groups"]["region"][parents[metadata["parentOrder"].index("region")]] if parents else None
            writer.writerow([key, name, region[1] if region else "", status,
                             " | ".join(f'{"/".join(names)} ({votes})' for names, votes in guesses.items())])
    (args.review_dir / "atlas-calibration.json").write_text(
        json.dumps({**report, "tiles": tiles, "counts": status_counts}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.publish:
        PUBLISHED.mkdir(exist_ok=True)
        (PUBLISHED / "atlas.json").write_text(
            json.dumps({**report, "locations": accepted, "reviewLocations": review_locations},
                       ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps(status_counts), flush=True)


if __name__ == "__main__":
    main()
