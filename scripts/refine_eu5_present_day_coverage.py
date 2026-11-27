"""Fill gaps in EU5 country calibration with smaller, overlapping windows."""

import argparse
import csv
import hashlib
import json
from collections import Counter
from pathlib import Path

import numpy as np
from scipy.spatial import Delaunay

from match_eu5_present_day_atlas import movement_support, read_gazetteer, read_map, read_polygons, registration, sample_tile
from match_eu5_present_day_countries import LOOKUP, MAP, SOURCE_SHA256, classify_overlap, read_assignment, read_positions, reliable_countries


def smaller_windows(ys, xs, ids, size):
    # Place overlapping windows around the full extent of each target, including
    # locations cut by a previous window. Nearby targets share snapped windows.
    locations, minimum, maximum = np.unique(ids), {}, {}
    for axis, values in enumerate((xs, ys)):
        lower = np.full(ids.max() + 1, values.max(), dtype=int)
        upper = np.zeros_like(lower)
        np.minimum.at(lower, ids, values)
        np.maximum.at(upper, ids, values)
        minimum[axis], maximum[axis] = lower[locations], upper[locations]
    stride = size // 2
    windows = set()
    for xmin, ymin, xmax, ymax in zip(minimum[0], minimum[1], maximum[0], maximum[1]):
        for left in range(((xmin - size) // stride + 1) * stride, xmax + 1, stride):
            for top in range(((ymin - size) // stride + 1) * stride, ymax + 1, stride):
                windows.add((left, top, size))
    return sorted(windows)


def threshold_result(raw, trusted, total, unknown):
    result = classify_overlap(raw, total)
    # An unknown pixel can never reduce a country's measured share. A single
    # country can therefore be proved even if a sliver is still outside all fits.
    if not result or set(result) != set(classify_overlap(trusted, total)):
        return []
    if len(result) > 1 and (
        any(5 * (raw[i] + unknown) >= 4 * total for i in result)
        or 5 * unknown >= total
        or any(5 * (raw[i] + unknown) >= total for i in range(1, len(raw)) if i not in result)
    ):
        return []
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for field in ("game", "boundaries", "disputed", "gazetteer", "previous-review", "review-dir"):
        parser.add_argument("--" + field, type=Path, required=True)
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args()
    with args.previous_review.open(encoding="utf-8-sig", newline="") as file:
        previous_rows = {row["location"]: row for row in csv.DictReader(file)
                         if row["status"] in ("no-registration", "incomplete-registration")}
    if hashlib.sha256(args.boundaries.read_bytes()).hexdigest() != SOURCE_SHA256:
        parser.error("Expected the recorded Natural Earth China-view country archive")
    metadata = read_assignment(LOOKUP / "meta.js")
    fingerprint = read_assignment(MAP / "project-meta.js")["sourceFingerprint"]
    lookup = read_assignment(LOOKUP / "present-day-countries.js")
    if lookup["sourceFingerprint"] != fingerprint:
        raise ValueError("Country lookup refers to another EU5 map version")
    kinds = read_assignment(LOOKUP / "paint-meta.js")["kinds"]
    targets = np.array([bool(row) and kinds[i] == 0 and row[0] in previous_rows and str(i) not in lookup["locations"]
                        for i, row in enumerate(metadata["locations"])])
    if not targets.any():
        print("No still-unassigned locations in the previous coverage review.")
        return
    raster, totals = read_map(metadata)
    ys, xs = np.nonzero(targets[raster])
    location_ids = raster[ys, xs]
    linear = ys * raster.shape[1] + xs
    windows = [(str(size), smaller_windows(ys, xs, location_ids, size)) for size in (320, 480)]
    old_windows = {tuple(tile["tile"]) for row in previous_rows.values()
                   for tile in json.loads(row["country_shares_by_registration"])}
    windows.append(("revisited", sorted(old_windows)))
    positions = read_positions(args.game, metadata["height"])
    candidates = read_gazetteer(args.gazetteer, positions, metadata, raster)
    keys = np.array(sorted(candidates))
    xy = np.array([positions[key] for key in keys])
    boundaries = read_polygons(args.boundaries)
    disputed = read_polygons(args.disputed)
    labels = [""]
    votes = np.zeros(linear.size, np.uint16)
    country = np.zeros_like(votes)
    clear = np.zeros(linear.size, bool)
    conflicts = np.zeros(linear.size, bool)
    stretched = np.zeros(linear.size, bool)
    sensitive = set()
    print(f"Coverage targets: {targets.sum()}", flush=True)

    for stage, tiles in windows:
        reviews = 0
        extensions = 0
        for left, top, size in tiles:
            in_tile = ((xy[:, 0] >= left) & (xy[:, 0] < left + size) &
                       (xy[:, 1] >= top) & (xy[:, 1] < top + size))
            small = stage != "revisited"
            if in_tile.sum() < (13 if small else 18):
                continue
            stride = size // 2 if small else {640: 420, 1040: 690, 1440: 820}[size]
            seed = ((int(top) + stride) * metadata["width"] + int(left) + stride) % (1 << 32)
            result = registration(keys[in_tile].tolist(), positions, candidates, seed, small=small)
            if result is None:
                continue
            anchors, warp, quality = result
            support = movement_support(result, positions)
            extended = len(support) > len(anchors)
            if not extended and not small:
                continue
            tile = sample_tile((support, warp, quality), raster, boundaries, disputed, targets)
            if tile is None:
                continue
            west, north, patch, mask, mapped, names, close_to_dispute = tile
            selected = mask & targets[patch]
            if not selected.any():
                continue
            sensitive.update(np.unique(patch[selected & close_to_dispute]))
            y, x = np.nonzero(selected)
            indices = np.searchsorted(linear, (y + north) * raster.shape[1] + x + west)
            for name in names:
                if name not in labels:
                    labels.append(name)
            name_ids = np.array([labels.index(name) for name in names], dtype=np.uint16)
            recorded = name_ids[mapped[selected]]
            had_vote = votes[indices] != 0
            conflicts[indices] |= had_vote & (country[indices] != recorded)
            country[indices[~had_vote]] = recorded[~had_vote]
            votes[indices] += 1
            clear[indices] |= reliable_countries(mapped, quality["marginPx"])[selected] != 0
            if extended:
                outside = Delaunay(anchors).find_simplex(np.column_stack((x + west + .5, y + north + .5))) < 0
                stretched[indices[outside]] = True
                extensions += 1
            reviews += 1
        print(f"{stage}: {reviews} calibrated windows, {extensions} with tested extension", flush=True)

    rows = len(metadata["locations"])
    n = len(labels)
    stable = (votes > 0) & ~conflicts
    verified = stable & (clear | (votes >= 2))
    raw = np.bincount(location_ids[stable].astype(int) * n + country[stable], minlength=rows * n).reshape(-1, n)
    trusted = np.bincount(location_ids[verified].astype(int) * n + country[verified], minlength=rows * n).reshape(-1, n)
    extensions = np.bincount(location_ids[stable & stretched], minlength=rows)
    accepted = {}
    summary = Counter()
    args.review_dir.mkdir(parents=True, exist_ok=True)
    with (args.review_dir / "coverage-refinement.csv").open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.writer(file)
        writer.writerow(["location", "name", "previous_status", "status", "countries", "covered_share", "extended_share", "country_shares"])
        for id_ in np.flatnonzero(targets):
            key, name, _ = metadata["locations"][id_]
            total = int(totals[id_])
            covered = int(raw[id_].sum())
            selected = threshold_result(raw[id_], trusted[id_], total, total - covered)
            status = "disputed-area" if id_ in sensitive else "matched" if selected else "insufficient-coverage-or-confidence"
            countries = [labels[i] for i in selected] if status == "matched" else []
            if countries:
                accepted[key] = countries
            summary[status] += 1
            shares = {labels[i]: round(int(c) / total, 4) for i, c in enumerate(raw[id_]) if i and c}
            writer.writerow([key, name, previous_rows[key]["status"], status, "/".join(countries),
                             round(covered / total, 4), round(int(extensions[id_]) / total, 4), json.dumps(shares, ensure_ascii=False)])
    if args.publish:
        target = MAP / "present-day-overlap-matches.json"
        previous = json.loads(target.read_text(encoding="utf-8"))
        if previous["sourceFingerprint"] != fingerprint:
            raise ValueError("Previous overlap results refer to another EU5 map version")
        previous["locations"].update(accepted)
        target.write_text(json.dumps(previous, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps({"counts": summary, "crossBorder": sum(len(v) > 1 for v in accepted.values())}), flush=True)


if __name__ == "__main__":
    main()
