"""Recheck EU5 locations that touch only the calibration buffer of a dispute."""

import argparse
from collections import Counter, defaultdict
import csv
from functools import lru_cache
import hashlib
import json
from pathlib import Path
import subprocess

import numpy as np
import shapefile

from match_eu5_present_day_atlas import read_gazetteer, read_map, registration
from match_eu5_present_day_countries import LOOKUP, MAP, read_assignment, read_positions


DISPLAY_COUNTRIES = {"中华人民共和国": "中国", "大韩民国": "韩国", "朝鲜民主主义人民共和国": "朝鲜"}


def country_consensus(windows):
    complete = [row for row in windows if row["complete"]]
    if len({row["tile"][2] for row in complete}) < 2:
        return None
    decisions = {tuple(row["areaDecision"]) for row in complete if row["areaDecision"]}
    if len(decisions) != 1:
        return None
    (decision,) = decisions
    if len(decision) != 1:
        return None
    (country,) = decision
    if any(share >= .2 for row in complete for other, share in row["overlap"].items() if other != country):
        return None
    stable = [row for row in complete if row["stableDecision"] and row["areaDecision"] == [country]]
    reliable = len(stable) * 2 > len(complete) and len({row["tile"][2] for row in stable}) >= 2
    minimum_share = min(row["overlap"].get(country, 0) for row in complete)
    return country, complete, reliable, minimum_share


def local_country_codes(point, places, windows, calibrated_tile):
    # Compare the place name candidates close to the EU5 locator. Homonyms on
    # a different continent should not count as conflicting place matches.
    support = defaultdict(set)
    location = np.asarray(point, dtype=float)
    for window in windows:
        tile = tuple(window["tile"])
        result = calibrated_tile(tile)
        if result is None:
            continue
        _, warp, quality = result
        origin, east, south = warp(np.array([location, location + [1, 0], location + [0, 1]]))
        jacobian = np.array([east - origin, south - origin])
        if abs(np.linalg.det(jacobian)) < 1e-8:
            continue
        inverse = np.linalg.inv(jacobian)
        for coord, code in places:
            delta = (coord - origin) @ inverse
            if np.linalg.norm(delta) <= min(20, quality["marginPx"]):
                support[(coord, code)].add(tile[2])
    return {code for (_, code), scales in support.items() if code and len(scales) >= 2}


def read_country_codes(archive):
    codes = defaultdict(set)
    with shapefile.Reader(str(archive), encoding="utf-8") as source:
        for record in source.iterRecords():
            codes[record["NAME_ZH"]].update(code for code in (record["ISO_A2"], record["ISO_A2_EH"])
                                            if code and len(code) == 2 and code.isalpha())
    return codes


def read_land_borders():
    generator = Path(__file__).with_name("prepare_eu5_present_day_countries.cjs").resolve()
    result = subprocess.run(["node", str(generator), "--neighbor-review"], check=True,
                            capture_output=True, encoding="utf-8")
    return {row["key"]: row["borders"] for row in map(json.loads, result.stdout.splitlines())}


def neighbor_evidence(country, minimum_share, windows, borders):
    if minimum_share < .98 or sum(window["complete"] for window in windows) < 3:
        return False, 0, 0
    if any(share >= .05 for window in windows if not window["complete"]
           for other, share in window["overlap"].items() if other != country):
        return False, 0, 0
    name = DISPLAY_COUNTRIES.get(country, country)
    if any(border["pixels"] >= 3 and border["countries"] and name not in border["countries"] for border in borders):
        return False, 0, 0
    matching = [border for border in borders if border["pixels"] >= 3 and border["countries"] == [name]]
    length = sum(border["pixels"] for border in matching)
    total = sum(border["pixels"] for border in borders)
    # Require more support from neighbors when a complete window shows slivers
    # outside the expected country. Count support from confirmed single-country neighbors.
    meets_threshold = length * (3 if minimum_share == 1 else 2) >= total
    return len(matching) >= 2 and meets_threshold, len(matching), length / total if total else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for field in ("game", "boundaries", "gazetteer", "area-review", "dispute-audit", "review-dir"):
        parser.add_argument("--" + field, type=Path, required=True)
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args()

    patch_path = MAP / "present-day-overlap-matches.json"
    patch = json.loads(patch_path.read_text(encoding="utf-8"))
    for attribute, source in (("boundarySha256", args.boundaries), ("gazetteerSha256", args.gazetteer)):
        if hashlib.sha256(source.read_bytes()).hexdigest() != patch[attribute]:
            parser.error(f"Calibration data differs from the overlap report: {source}")
    metadata = read_assignment(LOOKUP / "meta.js")
    lookup = read_assignment(LOOKUP / "present-day-countries.js")
    fingerprint = read_assignment(MAP / "project-meta.js")["sourceFingerprint"]
    if lookup["sourceFingerprint"] != fingerprint or patch["sourceFingerprint"] != fingerprint:
        raise ValueError("Country lookup refers to another EU5 map version")
    kinds = read_assignment(LOOKUP / "paint-meta.js")["kinds"]
    pending = {row[0] for id_, row in enumerate(metadata["locations"])
               if row and kinds[id_] == 0 and str(id_) not in lookup["locations"]}
    with args.dispute_audit.open(encoding="utf-8-sig", newline="") as source:
        buffer_only = {row["地块ID"] for row in csv.DictReader(source)
                       if row["触发方式"] == "仅命中误差带" and not row["直接命中的要素和最大重叠比例"]}
    targets = pending & buffer_only
    with args.area_review.open(encoding="utf-8-sig", newline="") as source:
        candidates = [row for row in csv.DictReader(source)
                      if row["status"] == "disputed-area" and row["location"] in targets]
    if not candidates:
        print("No unresolved EU5 locations limited to the dispute buffer.")
        return

    named_places = {row["location"]: set() for row in candidates}
    raster, _ = read_map(metadata)
    positions = read_positions(args.game, metadata["height"])
    place_candidates = read_gazetteer(args.gazetteer, positions, metadata, raster, country_matches=named_places)
    del raster
    keys = np.array(sorted(place_candidates))
    xy = np.array([positions[key] for key in keys])
    country_codes = read_country_codes(args.boundaries)
    borders = read_land_borders()

    @lru_cache(maxsize=None)
    def calibrated_tile(tile):
        left, top, size = tile
        inside = ((xy[:, 0] >= left) & (xy[:, 0] < left + size) &
                  (xy[:, 1] >= top) & (xy[:, 1] < top + size))
        stride = {640: 420, 1040: 690, 1440: 820}[size]
        seed = (top + stride) * metadata["width"] + left + stride
        return registration(keys[inside].tolist(), positions, place_candidates, seed)

    args.review_dir.mkdir(parents=True, exist_ok=True)
    accepted = {}
    counts = Counter()
    with (args.review_dir / "dispute-buffer.csv").open("w", encoding="utf-8-sig", newline="") as report:
        writer = csv.writer(report)
        writer.writerow(["location", "name", "status", "country", "minimum_share", "full_windows", "local_place_codes",
                         "matching_neighbors", "matching_border_share"])
        for row in candidates:
            key, name = row["location"], row["name"]
            readings = json.loads(row["country_shares_by_registration"])
            consensus = country_consensus(readings)
            if consensus is None:
                counts["no-consensus"] += 1
                writer.writerow([key, name, "no-consensus", "", "", "", "", "", ""])
                continue
            country, windows, reliable, minimum_share = consensus
            codes = local_country_codes(positions[key], named_places[key], windows, calibrated_tile) if named_places[key] else set()
            neighbor_count, border_share = "", ""
            if codes and country_codes[country] and codes - country_codes[country]:
                status = "conflicting-place"
            elif reliable:
                status = "matched-by-windows"
            elif minimum_share >= .8 and codes and codes <= country_codes[country]:
                status = "matched-by-place"
            else:
                supported, neighbor_count, border_share = neighbor_evidence(country, minimum_share, readings, borders.get(key, ()))
                status = "matched-by-neighbors" if supported else "insufficient-evidence"
            if status.startswith("matched-"):
                accepted[key] = [country]
            counts[status] += 1
            writer.writerow([key, name, status, country, minimum_share, len(windows), "/".join(sorted(codes)),
                             neighbor_count, border_share])
    if args.publish:
        patch["locations"].update(accepted)
        patch_path.write_text(json.dumps(patch, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps({"reviewed": len(candidates), "matched": len(accepted), "counts": counts}), flush=True)


if __name__ == "__main__":
    main()
