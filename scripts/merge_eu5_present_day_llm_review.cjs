const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const map = path.join(root, 'assets/maps/eu5');
const cache = path.join(root, '.cache/eu5-present-day');
const run = JSON.parse(fs.readFileSync(path.join(cache, 'llm-review/current.json'), 'utf8'));
const input = fs.readFileSync(path.join(cache, 'neighbor-review.jsonl'), 'utf8').replace(/^\uFEFF/, '').trim();
const evidence = new Map(input.split(/\r?\n/).map(line => {
  const row = JSON.parse(line);
  return [row.key, row];
}));
if (run.rows !== evidence.size) throw new Error('待核清单与本次模型批次不一致。');

function readAssignment(filename) {
  const source = fs.readFileSync(path.join(map, filename), 'utf8');
  return JSON.parse(source.slice(source.indexOf('=') + 1).trim().replace(/;$/, ''));
}
const metadata = readAssignment('lookup/meta.js');
const current = readAssignment('lookup/present-day-countries.js');
if (run.fingerprint !== current.sourceFingerprint) throw new Error('模型批次与当前底图版本不一致。');
const provinceIndex = metadata.parentOrder.indexOf('province');
const areaIndex = metadata.parentOrder.indexOf('area');
const provinceOwners = new Map();
const areaOwners = new Map();
for (const [id, countries] of Object.entries(current.locations)) {
  const location = metadata.locations[id];
  if (!location || evidence.has(location[0]) || !location[2]) continue;
  for (const [index, level, groups] of [[provinceIndex, 'province', provinceOwners], [areaIndex, 'area', areaOwners]]) {
    const group = metadata.groups[level][location[2][index]]?.[0];
    if (!group) continue;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(...countries.map(value => current.names[value]));
  }
}

// The tooltip reports the country. Keep constituent territories consistent with the base lookup.
const sovereignNames = new Map([
  ...['AS', 'GU', 'MP', 'PR', 'UM', 'VI'].map(code => [code, '美国']),
  ...['BL', 'GF', 'GP', 'MF', 'MQ', 'NC', 'PF', 'PM', 'RE', 'TF', 'WF', 'YT'].map(code => [code, '法国']),
  ...['AI', 'BM', 'IO', 'KY', 'MS', 'PN', 'SH', 'TC', 'VG'].map(code => [code, '英国']),
  ...['CC', 'CX', 'HM', 'NF'].map(code => [code, '澳大利亚']),
  ...['CN', 'HK', 'MO', 'TW'].map(code => [code, '中国']),
  ['KR', '韩国'], ['KP', '朝鲜'], ['CZ', '捷克'],
  ['TL', '东帝汶'], ['BN', '文莱'], ['DO', '多米尼加'], ['SZ', '斯威士兰'], ['LA', '老挝'], ['VN', '越南'],
]);
const displayNames = new Intl.DisplayNames(['zh-CN'], { type: 'region', fallback: 'none' });
const accepted = {};
const entries = [];
const counts = {};
const seen = new Set();
const files = fs.readdirSync(run.results).filter(file => /^\d+\.json$/.test(file)).sort();
for (const file of files) {
  for (const answer of JSON.parse(fs.readFileSync(path.join(run.results, file), 'utf8'))) {
    const input = evidence.get(answer.key);
    if (!input || seen.has(answer.key)) throw new Error(`模型结果包含未知或重复地块 ${answer.key}`);
    seen.add(answer.key);
    const countries = [...new Set(answer.codes.map(code => sovereignNames.get(code) ?? displayNames.of(code)))];
    const [country] = countries;
    const neighbors = input.borders.filter(border => border.evidence !== 'inferred' && border.countries.length);
    const reliable = neighbors.filter(border => border.evidence === 'map');
    const own = reliable.filter(border => border.countries.length === 1 && border.countries[0] === country);
    const foreign = reliable.filter(border => border.countries.some(name => name !== country));
    const namedOwn = neighbors.filter(border => border.countries.length === 1 && border.countries[0] === country);
    const namedForeign = neighbors.filter(border => border.countries.some(name => name !== country));
    const province = provinceOwners.get(input.parents.province?.[0]) ?? [];
    const area = areaOwners.get(input.parents.area?.[0]) ?? [];
    const provinceMatches = province.length >= 2 && province.every(name => name === country);
    const areaMatches = area.length >= 6 && area.every(name => name === country);
    const support = own.length > 0 || (provinceMatches && (areaMatches || namedOwn.length > 0)) ||
      (areaMatches && namedOwn.length > 0);
    let status;
    if (input.deferred) status = '地图标记待核';
    else if (!countries.length) status = '模型未判定';
    else if (answer.confidence !== 'H' || answer.evidence.trim().length < 4 ||
             /不确定|难以确定|可能|估计|疑似|大概|无法确认|approxi|uncertain|possibly|probably/i.test(answer.evidence)) status = '模型证据不足';
    else if (countries.length > 1) status = '多国归属待核';
    else if (foreign.length || (namedForeign.length && !own.length)) status = '邻接归属冲突';
    else if (!support) status = '缺少独立地图证据';
    else {
      status = '采用';
      accepted[answer.key] = countries;
    }
    counts[status] = (counts[status] ?? 0) + 1;
    entries.push({ ...answer, countries, status, parents: input.parents, neighbors: input.borders });
  }
}
if (seen.size !== evidence.size) {
  for (const [key, input] of evidence) {
    if (seen.has(key)) continue;
    entries.push({ key, countries: [], status: '模型批次未完成', parents: input.parents, neighbors: input.borders });
  }
  counts['模型批次未完成'] = evidence.size - seen.size;
}
const report = path.join(cache, 'llm-review/review.jsonl');
fs.writeFileSync(report, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
console.log(JSON.stringify({ total: evidence.size, analyzed: seen.size, completeBatches: files.length, counts }));
if (process.argv.includes('--publish')) {
  if (seen.size !== evidence.size) throw new Error('模型仍有批次未完成。');
  fs.writeFileSync(path.join(map, 'present-day-llm-matches.json'),
    JSON.stringify({ sourceFingerprint: run.fingerprint, locations: accepted }) + '\n');
}
