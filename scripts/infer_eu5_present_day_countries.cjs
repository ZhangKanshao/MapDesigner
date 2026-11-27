const fs = require('node:fs');
const path = require('node:path');

function readLandNeighbors(directory, metadata, kinds) {
  const neighbors = Array.from({ length: kinds.length }, () => new Map());
  function add(a, b, length) {
    if (!a || !b || a === b || kinds[a] === 1 || kinds[b] === 1) return;
    neighbors[a].set(b, (neighbors[a].get(b) ?? 0) + length);
    neighbors[b].set(a, (neighbors[b].get(a) ?? 0) + length);
  }

  let previous = [];
  for (let band = 0; band * metadata.bandHeight < metadata.height; band++) {
    const source = fs.readFileSync(path.join(directory, `band-${band}.js`), 'utf8');
    const rows = JSON.parse(source.slice(source.indexOf('=') + 1).trim().replace(/;$/, ''));
    for (const row of rows) {
      for (let i = 1; i + 2 < row.length; i += 2) add(row[i], row[i + 2], 1);
      let a = 0;
      let b = 0;
      let start = 0;
      while (a < row.length && b < previous.length) {
        const end = Math.min(row[a], previous[b]);
        add(row[a + 1], previous[b + 1], end - start);
        if (row[a] === end) a += 2;
        if (previous[b] === end) b += 2;
        start = end;
      }
      previous = row;
    }
  }
  return neighbors;
}

function inferCountries(metadata, kinds, neighbors, locations, mapMatches, blocked) {
  const levels = ['province', 'area'];
  const indexes = levels.map(level => metadata.parentOrder.indexOf(level));
  const groupEvidence = levels.map(() => new Map());
  for (const [id, countries] of mapMatches) {
    if (!locations[id] || blocked.has(id) || kinds[id] !== 0) continue;
    for (const [i, index] of indexes.entries()) {
      const parent = metadata.locations[id][2]?.[index];
      if (!parent) continue;
      const groups = groupEvidence[i];
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push(...countries);
    }
  }

  const inferred = new Map();
  for (const [id, location] of metadata.locations.entries()) {
    if (!location || kinds[id] !== 0 || locations[id] || blocked.has(id)) continue;
    const touching = neighbors[id];
    let landBorderLength = 0;
    let knownLength = 0;
    let knownCount = 0;
    const adjacentCountries = new Set();
    const geographicNeighbors = [];
    for (const [neighbor, length] of touching) {
      landBorderLength += length;
      if (blocked.has(neighbor)) continue;
      const countryIds = locations[neighbor];
      if (!countryIds) continue;
      for (const country of countryIds) adjacentCountries.add(country);
      knownLength += length;
      knownCount++;
      if (mapMatches.has(neighbor) && kinds[neighbor] === 0 && length >= 3) geographicNeighbors.push(neighbor);
    }
    if (adjacentCountries.size !== 1 || !geographicNeighbors.length || knownLength < 8) continue;
    const [country] = adjacentCountries;
    const province = groupEvidence[0].get(location[2]?.[indexes[0]]) ?? [];
    const area = groupEvidence[1].get(location[2]?.[indexes[1]]) ?? [];
    if (province.some(evidence => evidence !== country)) continue;
    const provinceAgrees = province.length >= 2;
    const areaAgrees = area.length >= 4 && area.every(evidence => evidence === country);
    if (!provinceAgrees && !areaAgrees) continue;
    // One shared edge alone is weak evidence, even when its neighbor is mapped.
    const enoughNeighbors = knownCount >= 2 && knownLength >= landBorderLength * .35;
    const stronglySurrounded = geographicNeighbors.length >= 3 && knownLength >= landBorderLength * .25;
    if (!enoughNeighbors && !stronglySurrounded && !(provinceAgrees && knownLength >= landBorderLength * .75)) continue;

    // Do not spread across a locally visible border or a location specifically
    // deferred by the map calibration, even if the game province agrees.
    const nearConflict = [...touching].some(([neighbor, length]) => {
      if (length < 3) return false;
      if (blocked.has(neighbor)) return true;
      if (!locations[neighbor]) return false;
      return [...neighbors[neighbor]].some(([next, shared]) => shared >= 3 && locations[next]?.some(owner => owner !== country));
    });
    if (nearConflict) continue;
    inferred.set(id, [country]);
  }
  return inferred;
}

function auditInference(metadata, kinds, neighbors, locations, mapMatches, blocked, groupByProvince) {
  let tested = 0;
  let predicted = 0;
  let correct = 0;
  const errors = {};
  const provinceIndex = metadata.parentOrder.indexOf('province');
  for (let fold = 0; fold < 5; fold++) {
    const visible = { ...locations };
    const hidden = [];
    for (const [id, countries] of mapMatches) {
      const group = groupByProvince ? metadata.locations[id][2]?.[provinceIndex] || id : id;
      if (group % 5 !== fold || kinds[id] !== 0 || countries.length !== 1 || blocked.has(id)) continue;
      delete visible[id];
      hidden.push(id);
    }
    const estimates = inferCountries(metadata, kinds, neighbors, visible, mapMatches, blocked);
    tested += hidden.length;
    for (const id of hidden) {
      if (!estimates.has(id)) continue;
      predicted++;
      if (estimates.get(id)[0] === locations[id][0]) correct++;
      else errors[metadata.locations[id][0]] = [locations[id][0], estimates.get(id)[0]];
    }
  }
  return { tested, predicted, correct, errors };
}

module.exports = { auditInference, inferCountries, readLandNeighbors };
