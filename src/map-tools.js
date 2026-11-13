// Row-run lookup keeps original-resolution hit testing independent of visible borders.
// Load local scripts instead of canvas/fetch so the same feature works on file://.
window.MapDesignerData = { meta: null, bands: {} };
const nameButton = document.getElementById('toggle-names');
const nameHint = document.getElementById('name-mode-hint');
const tooltip = document.getElementById('name-tooltip');
const stage = document.getElementById('map-stage');
const lookupRequests = new Map();
let namesEnabled = false;
let hoverPoint = null;
let hoverSequence = 0;
let hoverFrame = 0;

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
  const level = window.CountryCapitals?.selected() ? window.MapTemplate.baseLevel : adminLevel.value;
  if (!(namesEnabled || window.CountryCapitals?.selected()) || !point || mapDrag) { tooltip.hidden = true; return; }
  const view = viewport.getBoundingClientRect();
  const bounds = image.getBoundingClientRect();
  if (point.x < view.left || point.x >= view.left + viewport.clientWidth || point.y < view.top || point.y >= view.top + viewport.clientHeight ||
      point.x < bounds.left || point.y < bounds.top || point.x >= bounds.right || point.y >= bounds.bottom) {
    tooltip.hidden = true;
    return;
  }
  const x = Math.floor((point.x - bounds.left) * window.MapTemplate.width / bounds.width);
  const y = Math.floor((point.y - bounds.top) * window.MapTemplate.height / bounds.height);
  try {
    if (!window.MapDesignerData.meta) await loadLookupScript('meta.js');
    const metadata = window.MapDesignerData.meta;
    const band = Math.floor(y / metadata.bandHeight);
    if (!window.MapDesignerData.bands[band]) await loadLookupScript(`band-${band}.js`);
    if (sequence !== hoverSequence || !(namesEnabled || window.CountryCapitals?.selected())) return;
    const row = window.MapDesignerData.bands[band][y % metadata.bandHeight];
    let low = 0;
    let high = row.length / 2;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (x < row[mid * 2]) high = mid;
      else low = mid + 1;
    }
    const location = metadata.locations[row[low * 2 + 1]];
    let item = location;
    if (level !== window.MapTemplate.baseLevel) {
      const parent = location?.[2]?.[metadata.parentOrder.indexOf(level)];
      item = parent ? metadata.groups[level][parent] : null;
    }
    showName(point, level, item ? item[1] : '未定义归属', item ? item[0] : '');
  } catch {
    if (sequence !== hoverSequence || !(namesEnabled || window.CountryCapitals?.selected())) return;
    showName(point, level, '名称加载失败，请关闭后重试');
  }
}

function scheduleNameLookup() {
  clearNameTooltip();
  if (!hoverFrame) hoverFrame = requestAnimationFrame(() => { hoverFrame = 0; inspectMapPoint(); });
}

nameButton.addEventListener('click', () => {
  namesEnabled = !namesEnabled;
  nameButton.setAttribute('aria-pressed', String(namesEnabled));
  nameButton.setAttribute('aria-label', namesEnabled ? '隐藏名称' : '显示名称');
  nameButton.title = namesEnabled ? '隐藏名称' : '显示名称';
  viewport.classList.toggle('name-mode', namesEnabled);
  nameHint.hidden = !(namesEnabled || window.CountryCapitals?.selected());
  if (namesEnabled) window.dispatchEvent(new Event('name-mode-enabled'));
  clearNameTooltip();
});
viewport.addEventListener('pointermove', event => {
  hoverPoint = { x: event.clientX, y: event.clientY };
  if (namesEnabled || window.CountryCapitals?.selected()) scheduleNameLookup();
});
viewport.addEventListener('pointerleave', () => { hoverPoint = null; clearNameTooltip(); });
viewport.addEventListener('pointerdown', clearNameTooltip);
viewport.addEventListener('pointerup', () => { if (namesEnabled || window.CountryCapitals?.selected()) scheduleNameLookup(); });
viewport.addEventListener('scroll', () => { if (namesEnabled || window.CountryCapitals?.selected()) scheduleNameLookup(); });
adminLevel.addEventListener('change', scheduleNameLookup);
image.addEventListener('load', scheduleNameLookup);
zoom.addEventListener('input', scheduleNameLookup);
window.addEventListener('blur', () => { hoverPoint = null; clearNameTooltip(); });
window.addEventListener('hashchange', () => { hoverPoint = null; clearNameTooltip(); });

window.addEventListener('capital-mode-change', scheduleNameLookup);
