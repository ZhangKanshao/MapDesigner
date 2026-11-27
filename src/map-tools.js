// Row-run lookup keeps original-resolution hit testing independent of visible borders.
// Load local scripts instead of canvas/fetch so the same feature works on file://.
window.MapDesignerData = { meta: null, bands: {} };
const tooltip = document.getElementById('name-tooltip');
const stage = document.getElementById('map-stage');
const lookupRequests = new Map();
let hoverPoint = null;
let hoverSequence = 0;
let hoverFrame = 0;
let presentDayCountriesRequest;

function loadPresentDayCountries() {
  presentDayCountriesRequest ??= loadLookupScript('present-day-countries.js')
    .then(() => {
      const data = window.MapDesignerData.presentDayCountries;
      return data?.sourceFingerprint === window.EU5ProjectMeta.sourceFingerprint ? data : null;
    })
    .catch(() => null);
  return presentDayCountriesRequest;
}

function loadLookupScript(filename) {
  if (lookupRequests.has(filename)) return lookupRequests.get(filename);
  const promise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL(`${window.MapTemplate.assetRoot}/lookup/${filename}`, document.baseURI).href;
    script.onload = () => { script.remove(); resolve(); };
    script.onerror = () => { script.remove(); lookupRequests.delete(filename); reject(new Error('名称数据加载失败')); };
    document.head.append(script);
  });
  lookupRequests.set(filename, promise);
  return promise;
}

function clearNameTooltip() {
  ++hoverSequence;
  tooltip.hidden = true;
}

function positionTooltip(point) {
  const bounds = stage.getBoundingClientRect();
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  let left = point.x - bounds.left + 24;
  let top = point.y - bounds.top + 25;
  if (left + width > bounds.width - 10) left = point.x - bounds.left - width - 14;
  if (top + height > bounds.height - 10) top = point.y - bounds.top - height - 14;
  tooltip.style.left = `${Math.max(8, left)}px`;
  tooltip.style.top = `${Math.max(8, top)}px`;
}

function showName(point, level, label, key = '') {
  document.getElementById('name-tooltip-level').textContent = adminNames[level];
  document.getElementById('name-tooltip-label').textContent = label;
  tooltip.dataset.key = key;
  tooltip.hidden = false;
  positionTooltip(point);
}

async function inspectMapPoint() {
  const point = hoverPoint;
  const sequence = ++hoverSequence;
  if (!point || mapDrag || mapLoading || restoringMapView || !image.naturalWidth) return;
  const level = window.CountryCapitals?.selected() ? window.MapTemplate.baseLevel : loadedAdminLevel;
  const view = viewport.getBoundingClientRect();
  const bounds = image.getBoundingClientRect();
  if (point.x < view.left || point.x >= view.left + viewport.clientWidth || point.y < view.top || point.y >= view.top + viewport.clientHeight ||
      point.x < bounds.left || point.y < bounds.top || point.x >= bounds.right || point.y >= bounds.bottom ||
      !surface.contains(document.elementFromPoint(point.x, point.y))) return;
  const x = Math.floor((point.x - bounds.left) * window.MapTemplate.width / bounds.width);
  const y = Math.floor((point.y - bounds.top) * window.MapTemplate.height / bounds.height);
  try {
    if (!window.MapDesignerData.meta) await loadLookupScript('meta.js');
    const metadata = window.MapDesignerData.meta;
    const band = Math.floor(y / metadata.bandHeight);
    if (!window.MapDesignerData.bands[band]) await loadLookupScript(`band-${band}.js`);
    if (sequence !== hoverSequence) return;
    const row = window.MapDesignerData.bands[band][y % metadata.bandHeight];
    let low = 0;
    let high = row.length / 2;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (x < row[mid * 2]) high = mid;
      else low = mid + 1;
    }
    const id = row[low * 2 + 1];
    const location = metadata.locations[id];
    let item = location;
    if (level !== window.MapTemplate.baseLevel) {
      const parent = location?.[2]?.[metadata.parentOrder.indexOf(level)];
      item = parent ? metadata.groups[level][parent] : null;
    }
    let label = item ? item[1] : '未定义归属';
    if (location && level === window.MapTemplate.baseLevel && window.MapTemplate.game === 'eu5') {
      const data = await loadPresentDayCountries();
      if (sequence !== hoverSequence) return;
      const countries = data?.locations[id]?.map(index => data.names[index]);
      if (countries?.length) {
        const caption = data.estimated?.includes(id) ? '今属推定' : '今属';
        label += `（${caption}：${countries.join('/')}）`;
      }
    }
    showName(point, level, label, item ? item[0] : '');
  } catch {
    if (sequence !== hoverSequence) return;
    showName(point, level, '名称加载失败，请重新悬停');
  }
}

function scheduleNameLookup() {
  clearNameTooltip();
  if (!hoverFrame) hoverFrame = requestAnimationFrame(() => { hoverFrame = 0; inspectMapPoint(); });
}

function trackMapHover(event) {
  if (event.pointerType === 'touch') return;
  hoverPoint = { x: event.clientX, y: event.clientY };
  scheduleNameLookup();
}
function endMapHover() {
  hoverPoint = null;
  clearNameTooltip();
}
for (const event of ['pointerenter', 'pointermove', 'pointerup']) viewport.addEventListener(event, trackMapHover);
for (const event of ['pointerleave', 'pointercancel']) viewport.addEventListener(event, endMapHover);
viewport.addEventListener('pointerdown', clearNameTooltip);
viewport.addEventListener('scroll', scheduleNameLookup);
adminLevel.addEventListener('change', clearNameTooltip);
for (const event of ['map-view-change', 'capital-mode-change']) window.addEventListener(event, scheduleNameLookup);
for (const event of ['blur', 'hashchange']) window.addEventListener(event, endMapHover);
