const fs = require('node:fs');
const path = require('node:path');
const { auditInference, inferCountries, readLandNeighbors } = require('./infer_eu5_present_day_countries.cjs');

const root = path.resolve(__dirname, '../assets/maps/eu5');
const readAssignment = file => {
  const script = fs.readFileSync(path.join(root, file), 'utf8');
  return JSON.parse(script.slice(script.indexOf('=') + 1).trim().replace(/;$/, ''));
};
const metadata = readAssignment('lookup/meta.js');
const { kinds } = readAssignment('lookup/paint-meta.js');
const isPlayableLand = id => kinds[id] === 0;
const { sourceFingerprint } = readAssignment('project-meta.js');
const rules = JSON.parse(fs.readFileSync(path.join(root, 'present-day-country-rules.json'), 'utf8'));

const levels = ['location', ...metadata.parentOrder.toReversed()];
const items = { ...metadata.groups, location: metadata.locations };
const rulesById = Object.fromEntries(levels.map(level => [level, new Map()]));
const names = [];
const shortCountryNames = new Map([
  ['中华人民共和国', '中国'],
  ['大韩民国', '韩国'],
  ['朝鲜民主主义人民共和国', '朝鲜'],
]);

function countryIndices(countries) {
  return countries.map(country => {
    const label = shortCountryNames.get(country) ?? country;
    if (!names.includes(label)) names.push(label);
    return names.indexOf(label);
  });
}

function addRule(level, key, countries) {
  const id = items[level]?.findIndex(item => item?.[0] === key) ?? -1;
  if (id < 0 || (level === 'location' && kinds[id] === 1)) {
    throw new Error(`Unknown land place: ${level}/${key}`);
  }
  if (rulesById[level].has(id)) throw new Error(`Duplicate rule: ${level}/${key}`);
  rulesById[level].set(id, countryIndices(countries));
}

for (const [country, groups] of Object.entries(rules.countries)) {
  for (const [level, keys] of Object.entries(groups)) {
    for (const key of keys.split(/\s+/).filter(Boolean)) addRule(level, key, [country]);
  }
}
for (const [key, countries] of Object.entries(rules.crossBorder)) addRule('location', key, countries);
for (const [level, keys] of Object.entries(rules.unresolved)) {
  for (const key of keys.split(/\s+/).filter(Boolean)) addRule(level, key, []);
}

const mapMatches = new Map();
const blockedInference = new Set();
const matchDirectory = path.join(root, 'present-day-map-matches');
const locationIds = new Map(metadata.locations.flatMap((location, id) => location ? [[location[0], id]] : []));
if (fs.existsSync(matchDirectory)) {
  for (const file of fs.readdirSync(matchDirectory).filter(file => file.endsWith('.json')).sort()) {
    const patch = JSON.parse(fs.readFileSync(path.join(matchDirectory, file), 'utf8'));
    if (patch.sourceFingerprint !== sourceFingerprint) throw new Error(`Map version mismatch: ${file}`);
    for (const key of patch.reviewLocations ?? []) blockedInference.add(locationIds.get(key));
    for (const [key, countries] of Object.entries(patch.locations)) {
      const id = locationIds.get(key);
      if (id === undefined || kinds[id] === 1 || !countries.length) {
        throw new Error(`Invalid map match: ${file}/${key}`);
      }
      const indices = countryIndices(countries);
      const previous = mapMatches.get(id);
      if (previous && previous.toSorted().join() !== indices.toSorted().join()) {
        throw new Error(`Conflicting local map matches: ${file}/${key}`);
      }
      if (!previous) mapMatches.set(id, indices);
    }
  }
}

const locations = {};
const report = process.argv.includes('--unresolved');
const unresolvedByProvince = new Map();
let landCount = 0;
metadata.locations.forEach((location, id) => {
  if (!location || kinds[id] === 1) return;
  if (isPlayableLand(id)) landCount++;
  if (mapMatches.has(id)) {
    locations[id] = mapMatches.get(id);
    return;
  }
  for (const level of levels) {
    const groupId = level === 'location' ? id : location[2][metadata.parentOrder.indexOf(level)];
    const result = rulesById[level].get(groupId);
    if (result === undefined) continue;
    if (result.length) locations[id] = result;
    else blockedInference.add(id);
    break;
  }
});

const neighbors = readLandNeighbors(path.join(root, 'lookup'), metadata, kinds);
if (process.argv.includes('--inference-audit')) {
  for (const groupByProvince of [false, true]) {
    const audit = auditInference(metadata, kinds, neighbors, locations, mapMatches, blockedInference, groupByProvince);
    for (const key of Object.keys(audit.errors)) audit.errors[key] = audit.errors[key].map(country => names[country]);
    console.log(JSON.stringify({ heldOut: groupByProvince ? 'provinces' : 'locations', ...audit }));
  }
  process.exit(0);
}
const inferred = inferCountries(metadata, kinds, neighbors, locations, mapMatches, blockedInference);
for (const [id, countries] of inferred) locations[id] = countries;
// Keep the legacy calibration as neighbor evidence for existing land results.
// Only playable land is eligible for the published lookup and review reports.
for (const id of Object.keys(locations)) {
  if (!isPlayableLand(id)) delete locations[id];
}

const estimated = new Set();

function addMissingCountries(filename, skipDeferred) {
  const file = path.join(root, filename);
  if (!fs.existsSync(file)) return 0;
  const review = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (review.sourceFingerprint !== sourceFingerprint) throw new Error(`核对数据与 EU5 底图版本不匹配：${filename}`);
  const estimatedKeys = new Set(review.estimatedLocations ?? []);
  let count = 0;
  for (const [key, countries] of Object.entries(review.locations)) {
    const id = locationIds.get(key);
    if (id === undefined || kinds[id] === 1 || !countries.length) throw new Error(`无效的核对地块：${filename}/${key}`);
    if (!isPlayableLand(id) || locations[id] || (skipDeferred && blockedInference.has(id))) continue;
    locations[id] = [...new Set(countryIndices(countries))];
    if (estimatedKeys.has(key)) estimated.add(id);
    count++;
  }
  return count;
}
const llmCount = addMissingCountries('present-day-llm-matches.json', true);
const overlapCount = addMissingCountries('present-day-overlap-matches.json', false);
const disputedFile = 'present-day-disputed-matches.json';
const disputeCount = addMissingCountries(disputedFile, false);
let regionalCount = 0;
const regionalIds = new Set();
for (const [countries, keys] of Object.entries(rules.regionalEstimates ?? {})) {
  for (const key of keys.split(/\s+/).filter(Boolean)) {
    const id = locationIds.get(key);
    if (!isPlayableLand(id) || regionalIds.has(id)) throw new Error(`无效或重复的区域核对地块：${key}`);
    regionalIds.add(id);
    if (locations[id]) continue;
    locations[id] = [...new Set(countryIndices(countries.split('/')))];
    estimated.add(id);
    regionalCount++;
  }
}
const remainingCount = addMissingCountries('present-day-remaining-matches.json', false);
const disputedPath = path.join(root, disputedFile);
const officialMatches = fs.existsSync(disputedPath)
  ? JSON.parse(fs.readFileSync(disputedPath, 'utf8')).officialLocations
  : {};
for (const [key, countries] of Object.entries({ ...officialMatches, ...rules.official })) {
  const id = locationIds.get(key);
  if (!isPlayableLand(id) || !Array.isArray(countries) || countries.some(country => typeof country !== 'string' || !country)) {
    throw new Error(`无效的正式口径地块：${key}`);
  }
  if (countries.length) locations[id] = [...new Set(countryIndices(countries))];
  else delete locations[id];
  estimated.delete(id);
}

if (process.argv.includes('--neighbor-review')) {
  for (const [id, location] of metadata.locations.entries()) {
    if (!location || !isPlayableLand(id) || locations[id]) continue;
    const parents = Object.fromEntries(metadata.parentOrder.map((level, index) =>
      [level, metadata.groups[level][location[2]?.[index]] ?? null]));
    const borders = [...neighbors[id]].filter(([neighbor]) => isPlayableLand(neighbor)).sort((a, b) => b[1] - a[1]).map(([neighbor, pixels]) => ({
      key: metadata.locations[neighbor][0],
      name: metadata.locations[neighbor][1],
      countries: estimated.has(neighbor) ? [] : locations[neighbor]?.map(country => names[country]) ?? [],
      evidence: estimated.has(neighbor) ? null : mapMatches.has(neighbor) ? 'map' : inferred.has(neighbor) ? 'inferred' : locations[neighbor] ? 'name' : null,
      pixels,
    }));
    console.log(JSON.stringify({ key: location[0], name: location[1], parents, borders, deferred: blockedInference.has(id) }));
  }
  process.exit(0);
}

if (report) {
  metadata.locations.forEach((location, id) => {
    if (!location || !isPlayableLand(id) || locations[id]) return;
    const parents = ['region', 'area', 'province'].map(level => {
      const groupId = location[2][metadata.parentOrder.indexOf(level)];
      const parent = items[level][groupId];
      return parent ? `${parent[1]} (${parent[0]})` : '—';
    });
    const key = parents.join(' / ');
    if (!unresolvedByProvince.has(key)) unresolvedByProvince.set(key, []);
    unresolvedByProvince.get(key).push(`${location[1]} (${location[0]})`);
  });
}

const output = { sourceFingerprint, names, locations, ...(estimated.size ? { estimated: [...estimated] } : {}) };
const assigned = Object.keys(locations).length;
const crossBorder = Object.values(locations).filter(countries => countries.length > 1).length;
if (report) {
  const provinces = [...unresolvedByProvince].sort((a, b) => b[1].length - a[1].length);
  for (const [parents, places] of provinces) {
    console.log(`${places.length}\t${parents}\t${places.join('、')}`);
  }
} else {
  fs.writeFileSync(path.join(root, 'lookup/present-day-countries.js'),
    `window.MapDesignerData.presentDayCountries=${JSON.stringify(output)};\n`);
}
const mapMatchCount = [...mapMatches.keys()].filter(isPlayableLand).length;
console.log(`Playable land locations: ${assigned}/${landCount} assigned (${estimated.size} estimated), ${crossBorder} cross-border, ${landCount - assigned} unresolved. Local map matches: ${mapMatchCount}. Inferred from neighbors: ${inferred.size}. LLM with map evidence: ${llmCount}. Additional area-overlap matches: ${overlapCount}. Disputed-area policy matches: ${disputeCount}. Remaining-place review: ${remainingCount + regionalCount}.`);
