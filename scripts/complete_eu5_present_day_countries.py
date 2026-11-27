"""Review remaining ordinary EU5 locations using map, names and local context."""

import argparse
from collections import Counter, defaultdict
import csv
from functools import lru_cache
import hashlib
import io
import json
from pathlib import Path
import statistics
import zipfile

import numpy as np
import shapefile
from scipy.spatial import Delaunay, cKDTree

from apply_eu5_disputed_boundary_policy import build_policy_layers
from match_eu5_present_day_atlas import normalize, read_gazetteer, read_map, read_polygons, registration, sample_polygons
from match_eu5_present_day_countries import LOOKUP, MAP, read_assignment, read_positions


COUNTRY_ALIASES = {
    "中华人民共和国": "中国", "大韩民国": "韩国", "朝鲜民主主义人民共和国": "朝鲜",
    "阿联酋": "阿拉伯联合酋长国", "美利坚合众国": "美国", "俄罗斯联邦": "俄罗斯",
    "捷克共和国": "捷克", "刚果（布）": "刚果共和国", "刚果（金）": "刚果民主共和国",
}
PROTECTED = {"与争议要素直接重叠", "公开口径尚无唯一归属"}


def display_country(name):
    return COUNTRY_ALIASES.get(name, name)


def read_rows(path, key):
    with path.open(encoding="utf-8-sig", newline="") as source:
        return {row[key]: row for row in csv.DictReader(source)}


def read_place_codes(path):
    names = {}
    with shapefile.Reader(str(path), encoding="utf-8") as source:
        for row in source.iterRecords():
            country = display_country(row["NAME_ZH"])
            for code in (row["ISO_A2"], row["ISO_A2_EH"]):
                if code and len(code) == 2 and code.isalpha():
                    names.setdefault(code, country)
    names.update(dict.fromkeys(("CN", "TW", "HK", "MO"), "中国"))
    names.update({"FK": "阿根廷", "IO": "毛里求斯", "YT": "科摩罗", "XK": "塞尔维亚"})
    names.update(dict.fromkeys(("AI", "BM", "KY", "MS", "PN", "SH", "TC", "VG"), "英国"))
    names.update(dict.fromkeys(("GP", "MQ", "NC", "PF", "RE", "WF", "PM"), "法国"))
    return names


def load_places(archive, work, metadata, targets, known, country_codes):
    """Extract exact gazetteer matches for missing plots and known nearby anchors."""
    output = work / "gazetteer-matches.json"
    with archive.open("rb") as source:
        signature = [hashlib.file_digest(source, "sha256").hexdigest(), sorted(targets), known, country_codes]
    if output.exists():
        cached = json.loads(output.read_text(encoding="utf-8"))
        cached_signature = cached["signature"]
        if cached_signature[0] == signature[0] and cached_signature[2:] == signature[2:] and targets.issubset(cached_signature[1]):
            return cached["places"]
    names = defaultdict(set)
    for row in metadata["locations"]:
        if not row or row[0] not in targets and row[0] not in known:
            continue
        key, label = row[:2]
        for name in (key, label):
            token = normalize(name)
            if len(token) >= 3:
                names[token].add(key)
    entries = defaultdict(set)
    with zipfile.ZipFile(archive) as file, io.TextIOWrapper(file.open("allCountries.txt"), encoding="utf-8") as rows:
        for line in rows:
            ident, name, ascii_name, aliases, lat, lon, category, feature, code, rest = line.split("\t", 9)
            if category not in ("P", "T", "H", "A", "S") or code not in country_codes:
                continue
            country = country_codes[code]
            direct = names.get(normalize(name), set()) | names.get(normalize(ascii_name), set())
            alternate = set()
            for variant in aliases.split(",") if aliases else ():
                alternate.update(names.get(normalize(variant), ()))
            for key in direct | alternate:
                if key not in targets and (category != "P" or country != known.get(key)):
                    continue
                entries[key].add((float(lon), float(lat), country, ident, name, feature, key in direct))
    matches = {key: sorted(points) for key, points in entries.items()}
    output.write_text(json.dumps({"signature": signature, "places": matches}, ensure_ascii=False), encoding="utf-8")
    return matches


def geometry_summary(readings):
    usable = [shares for shares in readings if sum(shares.values()) >= .40]
    if not usable:
        return {}, 0, 0
    labels = {name for shares in usable for name in shares}
    averages = {name: statistics.mean(shares.get(name, 0) for shares in usable) for name in labels}
    ranked = dict(sorted(averages.items(), key=lambda item: (-item[1], item[0])))
    leader = next(iter(ranked))
    agreement = sum(max(shares, key=shares.get) == leader for shares in usable) / len(usable)
    return ranked, len(usable), agreement


def strongest(votes):
    if not votes:
        return "", 0
    country, score = votes.most_common(1)[0]
    return country, score / votes.total()


def decide(geometry, map_count, agreement, local, local_share, distant, named, neighbor, neighbor_share,
           parent, model, confidence, full_count):
    name = next(iter(named)) if len(named) == 1 else ""
    leader = next(iter(geometry), "")
    top_share = geometry.get(leader, 0)
    crossed = [c for c, share in geometry.items() if share >= .20]
    if map_count >= 3 and len(crossed) >= 2 and top_share < .80 and agreement >= .55:
        if (name in crossed or local in crossed or model in crossed) and geometry[crossed[1]] >= .22:
            return crossed, "多窗口面积复算"
    if name and (name == leader or name == local and local_share >= .55 or name == model and confidence == "H"):
        if top_share < .72 or leader == name:
            return [name], "地名坐标核对"
    if map_count >= 2 and agreement >= .66 and top_share >= .68 and len(crossed) <= 1:
        return [leader], "多窗口面积复算"
    if map_count >= 2 and agreement >= .65 and top_share >= .38 and (leader == name or leader == model or leader == local and local_share >= .75):
        if len(crossed) <= 1 or map_count >= 3 and (name in crossed or model in crossed):
            return crossed if len(crossed) >= 2 and top_share < .80 else [leader], "面积与地点交叉核对"
    if local_share >= .94 and distant <= 130 and (parent.get(local, 0) >= .8 or neighbor == local and neighbor_share >= .48):
        if (not leader or leader == local or top_share < .25) and (not named or local in named):
            if not model or confidence != "H" or model == local:
                return [local], "周边一致且远离交界"
    if model and confidence in ("H", "M") and (leader == model and top_share >= .18 or local == model and local_share >= .7 or neighbor == model and neighbor_share >= .65):
        if (not named or model in named) and (not leader or leader == model or top_share < .3):
            if confidence == "H" or local == model and local_share >= .85 or neighbor == model and neighbor_share >= .8:
                return [model], "地名研判与地理证据"
    if full_count and map_count and agreement >= .85 and top_share >= .55 and (parent.get(leader, 0) >= .7 or local == leader):
        if not named or leader in named:
            return crossed if 1 < len(crossed) and top_share < .80 else [leader], "面积与周边一致"
    return [], "证据不足或互有冲突"


def estimate(geometry, map_count, agreement, local, local_share, distant, named, neighbor, neighbor_share, parent, model, confidence):
    leader = next(iter(geometry), "")
    top_share = geometry.get(leader, 0)
    significant = [country for country, share in geometry.items() if share >= .20]
    if len(named) == 1:
        (name,) = named
        if not leader or leader == name or top_share < .55:
            if model == name or local == name or name in geometry:
                return [name], "地名与周边推定"
    if map_count >= 2 and len(significant) >= 2 and top_share < .80 and sum(geometry[country] for country in significant) >= .80:
        if not named or named.intersection(significant):
            return significant, "跨境面积推定"
    if top_share >= .95 and agreement == 1 and (not named or leader in named):
        if not model or model == leader or confidence != "H":
            return [leader], "单一归属面积推定"
    if map_count >= 2 and top_share >= .43 and agreement >= .6:
        if not named or leader in named:
            if leader == local or leader == model or top_share >= .68:
                return significant if top_share < .80 else [leader], "多窗口面积推定"
    if local_share >= .82 and distant < 200 and (not leader or leader == local or top_share < .22) and (not named or local in named):
        if (model == local or parent.get(local, 0) >= .75 or neighbor == local and neighbor_share >= .45):
            if not model or model == local or confidence != "H":
                return [local], "周边归属推定"
    if model and confidence == "H" and (not leader or leader == model or top_share < .35) and (not named or model in named):
        if (model == local or model == neighbor or parent.get(model, 0) >= .4 or model in geometry or model in named):
            return [model], "地名研判推定"
    return [], "证据不足或互有冲突"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("game", "cache-dir", "review-dir"):
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--gazetteer", type=Path)
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args()
    cache, work = args.cache_dir, args.review_dir
    work.mkdir(parents=True, exist_ok=True)
    meta = read_assignment(LOOKUP / "meta.js")
    current = read_assignment(LOOKUP / "present-day-countries.js")
    baseline = read_assignment(work / "before.js")
    if baseline["sourceFingerprint"] != current["sourceFingerprint"]:
        raise ValueError("The baseline belongs to another EU5 map version")
    pending = read_rows(work / "pending-before.csv", "地块键")
    border_data = {row["key"]: row for row in map(json.loads, (work / "neighbors.jsonl").read_text(encoding="utf-8-sig").splitlines())}
    original_area = read_rows(cache / "area-overlap/area-overlap.csv", "location")
    refinements = read_rows(cache / "coverage-refinement/coverage-refinement.csv", "location")
    country_archive = cache / "ne_10m_admin_0_countries_chn.zip"
    codes = read_place_codes(country_archive)
    positions = read_positions(args.game, meta["height"])
    indexes = {r[0]: str(i) for i, r in enumerate(meta["locations"]) if r}
    rules = json.loads((MAP / "present-day-country-rules.json").read_text(encoding="utf-8"))
    explicit = set(rules.get("official", {}))
    explicit.update(key for keys in rules.get("regionalEstimates", {}).values() for key in keys.split())
    targets = {key for key, row in pending.items() if row["待核主因"] not in PROTECTED and key not in explicit}
    prior_estimates = {str(i) for i in baseline.get("estimated", ())}
    known = {key: baseline["names"][baseline["locations"][i][0]] for key, i in indexes.items()
             if key in positions and i not in prior_estimates and len(baseline["locations"].get(i, ())) == 1}
    anchor_names = list(known)
    anchor_index = cKDTree([positions[key] for key in anchor_names])
    parent_votes = defaultdict(Counter)
    levels = {level: meta["parentOrder"].index(level) for level in ("province", "area")}
    for key, country in known.items():
        row = meta["locations"][int(indexes[key])]
        for level, index in levels.items():
            parent = meta["groups"][level][row[2][index]]
            if parent:
                parent_votes[(level, parent[0])][country] += 1
    llm_dir = work / "llm-review"
    model = {}
    if (llm_dir / "current.json").exists():
        run = json.loads((llm_dir / "current.json").read_text(encoding="utf-8"))
        if run["fingerprint"] != current["sourceFingerprint"]:
            raise ValueError("Model review belongs to another EU5 map version")
        for file in sorted(Path(run["results"]).glob("[0-9][0-9][0-9].json")):
            model.update((row["key"], row) for row in json.loads(file.read_text(encoding="utf-8")))
    print(f"{len(targets)} eligible; {len(model)} model observations", flush=True)

    raster, _ = read_map(meta)
    anchor_candidates = read_gazetteer(cache / "cities1000.zip", positions, meta, raster)
    named = load_places(args.gazetteer, work, meta, targets, known, codes) if args.gazetteer else {}
    for key in anchor_names:
        points = [point[:2] for point in named.get(key, ()) if point[5].startswith("PPL") and (point[6] or key not in anchor_candidates)]
        if key not in anchor_candidates and points:
            anchor_candidates[key] = np.unique(points, axis=0)
    # Leave every missing location out of the calibration controls.
    keys = np.array(sorted(set(anchor_candidates) - pending.keys()))
    xy = np.array([positions[key] for key in keys])
    boundaries, disputed, _ = build_policy_layers(read_polygons(country_archive), read_polygons(cache / "ne_10m_admin_0_disputed_areas.zip"))
    target_array = np.zeros(len(meta["locations"]), dtype=bool)
    target_array[[int(indexes[key]) for key in targets]] = True
    ys, xs = np.nonzero(target_array[raster])
    values = raster[ys, xs]
    order = values.argsort(kind="stable")
    sorted_values = values[order]
    sample = {}
    for id_ in np.unique(values):
        start, end = np.searchsorted(sorted_values, [id_, id_ + 1])
        indices = order[start:end]
        if len(indices) > 96:
            indices = indices[np.linspace(0, len(indices) - 1, 96, dtype=int)]
        sample[int(id_)] = np.column_stack((xs[indices] + .5, ys[indices] + .5))
    del raster, xs, ys, values, order, sorted_values

    @lru_cache(maxsize=None)
    def fit(left, top, size):
        selected = ((xy[:, 0] >= left) & (xy[:, 0] < left + size) & (xy[:, 1] >= top) & (xy[:, 1] < top + size))
        if selected.sum() < 13:
            return None
        result = registration(keys[selected].tolist(), positions, anchor_candidates,
                              ((top + size) * meta["width"] + left + size) % (1 << 32), small=True)
        if result is None:
            return None
        anchors, warp, quality = result
        return Delaunay(anchors), warp, quality

    accepted = {}
    estimated = []
    counts = Counter()
    with (work / "remaining-review.csv").open("w", encoding="utf-8-sig", newline="") as destination:
        columns = ["地块键", "地块名", "今属", "结论依据", "面积证据", "可用面积窗口数", "新增校准窗口数", "地名证据",
                   "周边推定", "同国周边权重", "邻接证据", "模型建议", "模型依据"]
        writer = csv.writer(destination)
        writer.writerow(columns)
        for number, (key, row) in enumerate(pending.items(), 1):
            if key not in targets:
                continue
            id_ = int(indexes[key])
            points = sample.get(id_)
            position = np.array(positions[key]) if key in positions else np.mean(points, axis=0)
            distance, nearby = anchor_index.query(position, k=16)
            local_votes = Counter()
            for d, index in zip(distance, nearby):
                local_votes[known[anchor_names[index]]] += 1 / (15 + d) ** 2
            local, local_share = strongest(local_votes)
            peers = border_data[key]
            neighbors = Counter()
            for border in peers["borders"]:
                if len(border["countries"]) == 1:
                    neighbors[border["countries"][0]] += border["pixels"]
            neighbor, _ = strongest(neighbors)
            neighbor_share = neighbors[neighbor] / max(1, sum(border["pixels"] for border in peers["borders"]))
            parents = defaultdict(float)
            for level in levels:
                parent = peers["parents"][level]
                counts_for_parent = parent_votes[(level, parent[0])] if parent else Counter()
                if counts_for_parent.total() >= 2:
                    for country, n in counts_for_parent.items():
                        parents[country] = max(parents[country], n / counts_for_parent.total())
            details = original_area.get(key, {})
            windows = json.loads(details.get("country_shares_by_registration", "[]"))
            full = [window["overlap"] for window in windows if window["complete"]]
            readings = full or [window["overlap"] for window in windows]
            if key in refinements and not full:
                readings.append(json.loads(refinements[key]["country_shares"]))
            name_hits = Counter()
            new_readings = []
            contested = 0
            if points is not None:
                for size in (520, 780, 1160, 1720):
                    stride = size // 2
                    x, y = np.floor(position / stride).astype(int) * stride
                    for left, top in ((x - stride, y - stride), (x, y - stride), (x - stride, y), (x, y)):
                        if not (left < position[0] < left + size and top < position[1] < top + size):
                            continue
                        result = fit(int(left), int(top), size)
                        if result is None:
                            continue
                        hull, warp, _ = result
                        if hull.find_simplex([position])[0] < 0:
                            continue
                        geo_position = warp(np.array([position]))[0]
                        for lon, lat, country, ident, _, feature, direct in named.get(key, ()):
                            delta = np.array([(lon - geo_position[0]) * np.cos(np.deg2rad(lat)), lat - geo_position[1]])
                            if (direct or feature.startswith("PPL")) and np.linalg.norm(delta) <= .24:
                                name_hits[(country, ident, size)] += 1
                        inside = hull.find_simplex(points) >= 0
                        if inside.mean() < .85:
                            continue
                        coords = warp(points[inside])
                        if abs(coords[:, 0]).max() > 180 or abs(coords[:, 1]).max() > 90:
                            continue
                        dx = warp(points[inside] + [1, 0]) - coords
                        dy = warp(points[inside] + [0, 1]) - coords
                        if np.any(dx[:, 0] * dy[:, 1] - dx[:, 1] * dy[:, 0] >= 0):
                            continue
                        raw, names = sample_polygons(boundaries, *coords.T)
                        unknown, _ = sample_polygons(disputed, *coords.T, conflict=True)
                        if unknown.mean() >= .10:
                            contested += 1
                        new_readings.append({names[c]: count / len(points) for c, count in Counter(raw).items() if c})
            found_names = {country for country, ident, size in name_hits
                           if len({s for c, i, s in name_hits if c == country and i == ident}) >= 2}
            readings = [{display_country(c): score for c, score in shares.items()} for shares in (*readings, *new_readings)]
            geometry, map_count, agreement = geometry_summary(readings)
            answer = model.get(key, {})
            model_names = [codes.get(code, display_country(country)) for code, country in zip(answer.get("codes", ()), answer.get("countries", ()))]
            guessed = model_names[0] if len(model_names) == 1 else ""
            exact_names = {point[2] for point in named.get(key, ()) if point[6]
                           and (point[5].startswith("PPL") or point[5] in ("ISL", "ISLS", "ADM1", "PCLI"))}
            if not found_names and len(exact_names) == 1:
                candidate = next(iter(exact_names))
                if (guessed == candidate and answer.get("confidence") == "H") or (candidate == local and local_share >= .9):
                    found_names.add(candidate)
            chosen, reason = decide(geometry, map_count, agreement, local, local_share, distance[2], found_names,
                                    neighbor, neighbor_share, parents, guessed, answer.get("confidence"), len(full) + len(new_readings))
            if contested >= 2 and contested * 2 >= len(new_readings):
                chosen, reason = [], "新校准命中争议边界"
            elif not chosen:
                chosen, reason = estimate(geometry, map_count, agreement, local, local_share, distance[2], found_names,
                                          neighbor, neighbor_share, parents, guessed, answer.get("confidence"))
                if chosen:
                    estimated.append(key)
            if chosen:
                accepted[key] = list(dict.fromkeys(c for country in chosen for c in country.split("/")))
            counts[reason] += 1
            writer.writerow([key, row["地块名"], "/".join(accepted.get(key, ())), reason,
                             json.dumps({c: round(v, 3) for c, v in geometry.items()}, ensure_ascii=False), map_count, len(new_readings),
                             "/".join(sorted(found_names)), local, round(local_share, 3), neighbor, "/".join(model_names), answer.get("evidence", "")])
            if number % 120 == 0:
                print(f"{number}/{len(pending)}; {len(accepted)} matched", flush=True)
    if args.publish:
        output = MAP / "present-day-remaining-matches.json"
        payload = {"sourceFingerprint": current["sourceFingerprint"], "locations": accepted, "estimatedLocations": estimated}
        output.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps({"accepted": len(accepted), "estimated": len(estimated), "counts": counts}), flush=True)


if __name__ == "__main__":
    main()
