"""Recheck directly affected EU5 locations under the specified display policy."""

import argparse
from collections import defaultdict
import csv
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
from shapely.strtree import STRtree

from match_eu5_present_day_atlas import read_gazetteer, read_map, read_polygons, registration, review_area_matches, run_tile
from match_eu5_present_day_countries import LOOKUP, MAP, SOURCE_SHA256, read_assignment, read_positions


POLICY = [
    ("印度/巴基斯坦", ("Jammu and Kashmir", "Gilgit-Baltistan", "Azad Kashmir", "Siachen Glacier")),
    ("中华人民共和国", ("Aksai Chin", "Arunachal Pradesh", "Shaksam Valley", "Demchok")),
    ("乌克兰", ("Crimea", "Donetsk People's Republic", "Luhansk People's Republic")),
    ("塞尔维亚", ("Kosovo",)),
    ("格鲁吉亚", ("Abkhazia", "South Ossetia")),
    ("索马里", ("Somaliland",)),
    ("以色列", ("Israel",)),
    ("巴勒斯坦", ("Gaza", "West Bank", "East Jerusalem")),
    ("叙利亚", ("Golan Heights", "UNDOF Zone")),
    ("摩尔多瓦", ("Transnistria",)),
    ("塞浦路斯", ("N. Cyprus", "Cyprus U.N. Buffer Zone")),
    ("马来西亚", ("North Borneo",)),
    ("阿塞拜疆", ("Artsakh",)),
    ("哈萨克斯坦", ("Baykonur",)),
    ("阿根廷", ("Falkland Is.",)),
    ("中华人民共和国", ("Taiwan", "Pinnacle Is.", "Paracel Is.")),
    ("西撒哈拉", ("W. Sahara",)),
    ("朝鲜民主主义人民共和国", ("Korean Demilitarized Zone (north)",)),
    ("大韩民国", ("Korean Demilitarized Zone (south)",)),
]


def build_policy_layers(country_layer, disputed_layer, selected=None):
    country_shapes, _, country_records = country_layer
    disputed_shapes, _, disputed_records = disputed_layer
    overlay_shapes, overlay_records = list(country_shapes), list(country_records)
    protected_shapes, protected_records = [], []
    policy_names = {feature for _, features in POLICY for feature in features}
    disputed_features = {row.record["BRK_NAME"]: (geometry, row.record["NAME_ZH"])
                         for geometry, row in zip(disputed_shapes, disputed_records)}
    if missing := policy_names - disputed_features.keys():
        raise ValueError(f"Missing configured boundary features: {sorted(missing)}")
    # Apply Chinese-side polygons after Kashmir, and the Palestinian areas after Israel.
    raw_names = set()
    for label, features in POLICY:
        for geometry, row in zip(disputed_shapes, disputed_records):
            if row.record["BRK_NAME"] not in features:
                continue
            if selected is None or row.record["BRK_NAME"] in selected:
                raw_names.add(row.record["NAME_ZH"])
            overlay_shapes.append(geometry)
            overlay_records.append(SimpleNamespace(record={"NAME_ZH": label}))
    for geometry, row in zip(disputed_shapes, disputed_records):
        if row.record["BRK_NAME"] not in policy_names:
            protected_shapes.append(geometry)
            protected_records.append(row)
    north, south = [g for g, row in zip(disputed_shapes, disputed_records)
                    if row.record["BRK_NAME"].startswith("Korean Demilitarized Zone")]
    if north.intersection(south).area > 1e-10 or north.boundary.intersection(south.boundary).length <= 0:
        raise ValueError("The Korean DMZ polygons do not define a shared military demarcation line")
    return ((overlay_shapes, STRtree(overlay_shapes), overlay_records),
            (protected_shapes, STRtree(protected_shapes), protected_records), raw_names)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for field in ("game", "boundaries", "disputed", "gazetteer", "area-review", "dispute-audit", "review-dir"):
        parser.add_argument("--" + field, type=Path, required=True)
    parser.add_argument("--feature", action="append", choices=sorted(feature for _, features in POLICY for feature in features),
                        help="Recheck a specified disputed feature, including previously labelled locations")
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args()
    if hashlib.sha256(args.boundaries.read_bytes()).hexdigest() != SOURCE_SHA256:
        parser.error("Expected the recorded Natural Earth China-view country archive")
    metadata = read_assignment(LOOKUP / "meta.js")
    fingerprint = read_assignment(MAP / "project-meta.js")["sourceFingerprint"]
    lookup = read_assignment(LOOKUP / "present-day-countries.js")
    if lookup["sourceFingerprint"] != fingerprint:
        raise ValueError("Country lookup refers to another EU5 map version")
    selected = set(args.feature) if args.feature else None
    boundaries, protected, feature_names = build_policy_layers(read_polygons(args.boundaries), read_polygons(args.disputed), selected)
    with args.dispute_audit.open(encoding="utf-8-sig", newline="") as file:
        targeted = {row["地块ID"] for row in csv.DictReader(file)
                    if any(item.split(" [", 1)[0] in feature_names
                           for item in row["直接命中的要素和最大重叠比例"].split("；"))}
    kinds = read_assignment(LOOKUP / "paint-meta.js")["kinds"]
    target_ids = {location[0]: i for i, location in enumerate(metadata["locations"])
                  if location and kinds[i] == 0 and location[0] in targeted}
    target_mask = np.isin(np.arange(len(metadata["locations"])), list(target_ids.values()))
    tiles = defaultdict(set)
    with args.area_review.open(encoding="utf-8-sig", newline="") as file:
        for row in csv.DictReader(file):
            if row["location"] in target_ids:
                for observation in json.loads(row["country_shares_by_registration"]):
                    tiles[tuple(observation["tile"])].add(target_ids[row["location"]])
    print(f"{len(target_ids)} directly affected land locations, {len(tiles)} windows", flush=True)
    raster, counts = read_map(metadata)
    positions = read_positions(args.game, metadata["height"])
    candidates = read_gazetteer(args.gazetteer, positions, metadata, raster)
    keys = np.array(sorted(candidates))
    xy = np.array([positions[key] for key in keys])
    observations = defaultdict(list)
    sensitive = set()
    for number, ((left, top, size), ids) in enumerate(sorted(tiles.items()), 1):
        in_tile = ((xy[:, 0] >= left) & (xy[:, 0] < left + size) & (xy[:, 1] >= top) & (xy[:, 1] < top + size))
        stride = {640: 420, 1040: 690, 1440: 820}[size]
        seed = (top + stride) * metadata["width"] + left + stride
        result = registration(keys[in_tile].tolist(), positions, candidates, seed)
        if result is None:
            continue
        tile_targets = np.isin(np.arange(len(target_mask)), list(ids))
        estimates, disputed_ids = run_tile(result, metadata, raster, counts, boundaries, protected, tile_targets, dispute_margin=0)
        sensitive.update(metadata["locations"][i][0] for i in disputed_ids if i)
        for key, row in estimates.items():
            observations[key].append({"tile": [left, top, size], "inside": row["inside"],
                                      "complete": row["complete"], "overlap": row["overlap"],
                                      "areaDecision": row["areaDecision"], "stableDecision": row["stableDecision"],
                                      "marginPx": result[2]["marginPx"]})
        if number % 25 == 0:
            print(f"{number}/{len(tiles)} windows", flush=True)
    args.review_dir.mkdir(parents=True, exist_ok=True)
    report_options = SimpleNamespace(review_dir=args.review_dir, publish=False)
    accepted = review_area_matches(metadata, target_mask, observations, sensitive, report_options, {}, use_largest_share=True)
    locations = {key: list(dict.fromkeys(country for label in labels for country in label.split("/")))
                 for key, labels in accepted.items()}
    if args.publish:
        output = MAP / "present-day-disputed-matches.json"
        previous = json.loads(output.read_text(encoding="utf-8")) if output.exists() else {"sourceFingerprint": fingerprint, "locations": {}}
        if previous["sourceFingerprint"] != fingerprint:
            raise ValueError("Disputed-area results refer to another EU5 map version")
        # Replace the selected run's previous decisions so a rejected match cannot persist.
        official = previous.get("officialLocations", {})
        previous["officialLocations"] = {**{key: value for key, value in official.items() if key not in target_ids}, **locations}
        output.write_text(json.dumps(previous, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Accepted {len(locations)} display labels ({sum(len(v) > 1 for v in locations.values())} multi-country).", flush=True)


if __name__ == "__main__":
    main()
