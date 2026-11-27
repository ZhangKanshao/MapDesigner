// Run with Electron so the active local AI profile can be decrypted in the main process.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { app } = require('electron');
const { readActiveProfile, requestChat } = require('../electron/ai.cjs');

const root = path.resolve(__dirname, '..');
const map = path.join(root, 'assets/maps/eu5');
const cache = path.join(root, '.cache/eu5-present-day');
const workspace = process.env.MAPDESIGNER_COUNTRY_REVIEW_OUTPUT || path.join(cache, 'llm-review');
const profileDirectory = path.join(app.getPath('appData'), 'map-designer');
app.setPath('userData', profileDirectory);

const displayNames = new Intl.DisplayNames(['zh-CN'], { type: 'region', fallback: 'none' });
const countryAliases = { TW: '中国', CN: '中国', HK: '中国', MO: '中国', KR: '韩国', KP: '朝鲜', CZ: '捷克' };
function countryName(code) {
  if (typeof code !== 'string' || !/^[A-Z]{2}$/.test(code) || ['ZZ', 'EU', 'UN', 'XK'].includes(code)) return null;
  return countryAliases[code] ?? displayNames.of(code) ?? null;
}
function assignment(filename) {
  const source = fs.readFileSync(path.join(map, filename), 'utf8');
  return JSON.parse(source.slice(source.indexOf('=') + 1).trim().replace(/;$/, ''));
}
function csvFields(line) {
  const pattern = /(?:^|,)(?:"((?:[^"]|"")*)"|([^,]*))/g;
  return [...line.matchAll(pattern)].map(match => match[1]?.replaceAll('""', '"') ?? match[2]);
}

const system = [
  'You review modern country attribution for historical EU5 map cells. Follow PRC standard-map conventions.',
  'Use each exact place (including historical and Chinese names), game parents, adjoining locations and existing map evidence. Game parents can span borders. Geometric evidence is an uncertain registration, not authoritative.',
  'Do not substitute a modern city for a same-named unrelated place. A real cross-border footprint requires more evidence than mixed neighbors. For unresolved disputes, ambiguous names, large ambiguous cells, or insufficient evidence, leave codes empty.',
  'Return one strict JSON object with a rows array of [row number, array of ISO 3166-1 alpha-2 codes, confidence, short evidence]. Include every requested row exactly once. Confidence is H (well-supported), M (plausible), or U (unresolved). Use an empty code array only for U. Cite the specific modern place, landmark or location relation in <=25 characters per cell. Keep it brief. Do not invent sources. No Markdown or other text.',
].join('\n');

function getInputs() {
  const pending = fs.readFileSync(process.env.MAPDESIGNER_COUNTRY_REVIEW_INPUT || path.join(cache, 'neighbor-review.jsonl'), 'utf8');
  const locations = pending.replace(/^\uFEFF/, '').trim().split(/\r?\n/).map(line => JSON.parse(line));
  const metadata = assignment('lookup/meta.js');
  const existing = assignment('lookup/present-day-countries.js');
  const area = metadata.parentOrder.indexOf('area');
  const province = metadata.parentOrder.indexOf('province');
  const areaCountries = new Map();
  const provinceCountries = new Map();
  for (const [id, indexes] of Object.entries(existing.locations)) {
    const parents = metadata.locations[id]?.[2];
    if (!parents) continue;
    for (const [groups, group] of [[areaCountries, parents[area]], [provinceCountries, parents[province]]]) {
      if (!group) continue;
      if (!groups.has(group)) groups.set(group, new Map());
      const counts = groups.get(group);
      for (const index of indexes) {
        const country = existing.names[index];
        counts.set(country, (counts.get(country) ?? 0) + 1);
      }
    }
  }
  const parentCountries = (groups, level) => new Map(metadata.groups[level].flatMap((row, id) =>
    row && groups.has(id) ? [[row[0], [...groups.get(id)].sort((a, b) => b[1] - a[1]).slice(0, 5)]] : []));
  const areas = parentCountries(areaCountries, 'area');
  const provinces = parentCountries(provinceCountries, 'province');
  const atlas = new Map(fs.readFileSync(path.join(cache, 'atlas-final/atlas.csv'), 'utf8').trim().split(/\r?\n/).slice(1)
    .map(line => { const [key, , , status, votes] = csvFields(line); return [key, [status, votes]]; }));
  const rows = locations.map(location => ({
    ...location,
    atlas: atlas.get(location.key) ?? null,
    provinceCountries: provinces.get(location.parents.province?.[0]) ?? [],
    areaCountries: areas.get(location.parents.area?.[0]) ?? [],
  })).sort((a, b) => ['continent', 'subcontinent', 'region', 'area', 'province'].map(level =>
    (a.parents[level]?.[0] ?? '').localeCompare(b.parents[level]?.[0] ?? '')).find(order => order !== 0) ?? a.key.localeCompare(b.key));
  return { rows, fingerprint: existing.sourceFingerprint };
}

function prompt(batch) {
  const parentIndex = new Map();
  function index(parent) {
    const key = parent?.[0];
    if (!key) return 0;
    if (!parentIndex.has(key)) parentIndex.set(key, [parentIndex.size + 1, ...parent]);
    return parentIndex.get(key)[0];
  }
  const rows = batch.map((row, id) => [id, row.key, row.name, Object.values(row.parents).map(index),
    row.borders.filter(border => border.countries.length).slice(0, 6)
      .map(border => [border.key, border.name, border.countries, border.evidence, border.pixels]),
    row.provinceCountries, row.areaCountries, row.atlas, row.deferred, row.calibration ?? null]);
  return 'Parent dictionary [id,key,Chinese name]: ' + JSON.stringify([...parentIndex.values()]) +
    '\nRows [id,key,name,parents from broad to fine,neighbors ordered by shared land border,province country counts,area country counts,atlas status and votes,deferred for review,calibrated country readings]:\n' +
    JSON.stringify(rows);
}

function validateReply(text, batch) {
  const json = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const data = JSON.parse(json).rows;
  if (!Array.isArray(data) || data.length !== batch.length) throw new Error('批次未覆盖所有地块。');
  const seen = new Set();
  return data.map(item => {
    const [id, codes, confidence, evidence] = item;
    if (!Number.isInteger(id) || !batch[id] || seen.has(id) || !Array.isArray(codes) || codes.length > 3 ||
        !['H', 'M', 'U'].includes(confidence) || typeof evidence !== 'string' || evidence.length > 300) {
      throw new Error('模型返回的地块或证据格式无效。');
    }
    seen.add(id);
    const countries = [...new Set(codes.map(countryName))];
    if (!countries.length || countries.some(name => !name) || confidence === 'U') {
      return { key: batch[id].key, codes: [], countries: [], confidence: 'U', evidence };
    }
    return { key: batch[id].key, codes, countries, confidence, evidence };
  });
}

async function run() {
  const { rows, fingerprint } = getInputs();
  const profile = await readActiveProfile(path.join(profileDirectory, 'ai-connections.bin'));
  const options = {
    response_format: { type: 'json_object' },
    max_tokens: 4800,
    ...(/^deepseek-(flash|v4-pro)$/.test(profile.model) ? { thinking: { type: 'disabled' } } : {}),
  };
  const batchSize = 60;
  const total = Math.ceil(rows.length / batchSize);
  const runId = createHash('sha256').update(JSON.stringify([fingerprint, system, rows, profile.model])).digest('hex');
  const results = path.join(workspace, runId.slice(0, 16));
  fs.mkdirSync(results, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'current.json'), JSON.stringify({ runId, results, fingerprint, total, rows: rows.length }));
  console.log(`待核 ${rows.length} 个地块，${total} 批。`);
  let cursor = 0;
  let completed = 0;
  let stopReason;
  const failures = [];
  async function review(batch) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return validateReply(await requestChat(profile, [{ role: 'system', content: system },
          { role: 'user', content: prompt(batch) }], options), batch);
      } catch (error) {
        lastError = error;
        if (/HTTP (400|401|402|403|404)/.test(error.message)) throw error;
        if (/HTTP 429|超时/.test(error.message)) await new Promise(resolve => setTimeout(resolve, 2500 * (attempt + 1)));
      }
    }
    if (batch.length <= 1 || /HTTP|超时|无法连接/.test(lastError.message)) throw lastError;
    const half = Math.floor(batch.length / 2);
    return [...await review(batch.slice(0, half)), ...await review(batch.slice(half))];
  }
  async function worker() {
    while (cursor < total && !stopReason) {
      const index = cursor++;
      const file = path.join(results, `${String(index).padStart(3, '0')}.json`);
      if (!fs.existsSync(file)) {
        try {
          const output = await review(rows.slice(index * batchSize, (index + 1) * batchSize));
          fs.writeFileSync(file + '.tmp', JSON.stringify(output));
          fs.renameSync(file + '.tmp', file);
        } catch (error) {
          const reason = /HTTP \d+|超时|无法连接/.test(error.message) ? error.message : '模型回复未通过校验。';
          if (/HTTP (400|401|402|403|404)/.test(reason)) stopReason = reason;
          failures.push({ index, reason });
          console.log(`批次 ${index + 1} 待重试，${reason}`);
          continue;
        }
      }
      console.log(`已完成批次 ${index + 1}，进度 ${++completed}/${total}`);
    }
  }
  await Promise.all(Array.from({ length: 10 }, worker));
  fs.writeFileSync(path.join(results, 'status.json'), JSON.stringify({ completed, total, failures, stopReason }));
  if (completed !== total) throw new Error(stopReason ?? `仍有 ${total - completed} 批未完成。`);
}

app.whenReady().then(run).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => app.exit(process.exitCode || 0));
