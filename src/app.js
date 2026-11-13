const pages = ['home', 'templates', 'map', 'settings'];
const image = document.getElementById('basemap');
const message = document.getElementById('map-message');
const viewport = document.getElementById('map-viewport');
const surface = document.getElementById('map-surface');
const zoom = document.getElementById('map-zoom');
const adminLevel = document.getElementById('admin-level');
const adminNames = window.MapTemplate.levels;
let loadedAdminLevel = window.MapTemplate.baseLevel;
let mapLoadSequence = 0;
let mapLoading = false;
let boundariesHidden = false;
let loadedBoundariesHidden = false;
let boundaryDisplay = 'plots';
let loadedBoundaryDisplay = 'plots';
let restoringMapView = window.MapTemplate.fresh;

function loadMapAsset(url) {
  return new Promise((resolve, reject) => {
    const asset = new Image();
    asset.onload = () => asset.naturalWidth ? resolve(asset) : reject(new Error('地图资源无效。'));
    asset.onerror = () => reject(new Error('地图资源加载失败。'));
    asset.src = url;
  });
}

function updateBoundaryControls() {
  const button = document.getElementById('toggle-boundaries');
  button.value = boundaryDisplay;
  document.getElementById('location-legend').hidden = loadedBoundaryDisplay !== 'plots';
  document.getElementById('admin-legend').hidden = loadedBoundaryDisplay === 'hidden' || (loadedBoundaryDisplay === 'plots' && loadedAdminLevel === window.MapTemplate.baseLevel);
  document.querySelector('.legend .admin-boundary').style.backgroundColor = window.MapAppearance.capture()[loadedBoundaryDisplay === 'countries' ? 'countryBorder' : 'coarseBorder'];
  document.getElementById('admin-legend-label').textContent = loadedBoundaryDisplay === 'countries' ? '国家分界' : `${adminNames[loadedAdminLevel]}分界`;
}

async function loadAdminMap(level) {
  const sequence = ++mapLoadSequence;
  mapLoading = true;
  const hideBorders = boundariesHidden;
  const nextDisplay = boundaryDisplay;
  const template = window.MapTemplate;
  let filename = 'basemap.png';
  if (template.game !== 'ck3' && hideBorders) filename = 'basemap-no-borders.png';
  else if (template.game === 'eu5' && level !== template.baseLevel) filename = `basemap-${level}.png`;
  message.hidden = false;
  message.textContent = `正在加载${adminNames[level]}底图…`;
  const mapURL = new URL(`${window.MapTemplate.assetRoot}/${filename}`, document.baseURI);
  if (level !== window.MapTemplate.baseLevel) mapURL.searchParams.set('v', '2');
  try {
    const nextImage = await window.MapAppearance.load(filename, mapURL.href);
    if (sequence !== mapLoadSequence) return;
    loadedAdminLevel = level;
    loadedBoundariesHidden = hideBorders;
    loadedBoundaryDisplay = nextDisplay;
    image.src = nextImage.src;
    updateBoundaryControls();
    message.hidden = true;
    return true;
  } catch {
    if (sequence !== mapLoadSequence) return;
    adminLevel.value = loadedAdminLevel;
    boundariesHidden = loadedBoundariesHidden;
    boundaryDisplay = loadedBoundaryDisplay;
    updateBoundaryControls();
    message.hidden = false;
    message.textContent = `${adminNames[level]}底图加载失败，请刷新后重试。`;
    return false;
  } finally {
    if (sequence === mapLoadSequence) mapLoading = false;
  }
}
adminLevel.addEventListener('change', () => loadAdminMap(adminLevel.value));
document.getElementById('toggle-boundaries').addEventListener('change', event => {
  boundaryDisplay = event.target.value;
  boundariesHidden = boundaryDisplay !== 'plots';
  updateBoundaryControls();
  loadAdminMap(adminLevel.value);
});
let imageWidth = 0;
let imageHeight = 0;
let zoomPercent = 100;
let mapDrag = null;

function stopMapDrag() {
  const pointerId = mapDrag?.pointerId;
  mapDrag = null;
  viewport.classList.remove('is-dragging');
  if (pointerId !== undefined && viewport.hasPointerCapture(pointerId)) {
    viewport.releasePointerCapture(pointerId);
  }
}

surface.addEventListener('pointerdown', event => {
  if (event.button !== 0 || !event.isPrimary || !image.naturalWidth) return;
  stopMapDrag();
  mapDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
    left: viewport.scrollLeft, top: viewport.scrollTop, moved: false };
  viewport.setPointerCapture(event.pointerId);
  viewport.classList.add('is-dragging');
  viewport.focus({ preventScroll: true });
  event.preventDefault();
});
viewport.addEventListener('pointermove', event => {
  if (!mapDrag || event.pointerId !== mapDrag.pointerId) return;
  if (event.pointerType === 'mouse' && !(event.buttons & 1)) { stopMapDrag(); return; }
  if (Math.hypot(event.clientX - mapDrag.x, event.clientY - mapDrag.y) > 4) mapDrag.moved = true;
  if (!mapDrag.moved) return;
  viewport.scrollLeft = mapDrag.left - (event.clientX - mapDrag.x);
  viewport.scrollTop = mapDrag.top - (event.clientY - mapDrag.y);
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  viewport.addEventListener(type, event => {
    if (mapDrag?.pointerId !== event.pointerId) return;
    const click = type === 'pointerup' && !mapDrag.moved;
    stopMapDrag();
    if (click) window.dispatchEvent(new CustomEvent('map-click', { detail: { x: event.clientX, y: event.clientY } }));
  });
}
window.addEventListener('blur', stopMapDrag);

function layoutMap() {
  if (!image.naturalWidth || !viewport.clientWidth || !viewport.clientHeight) return;
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  const centerX = imageWidth ? (viewport.scrollLeft + width / 2 - Math.max(0, (width - imageWidth) / 2)) / imageWidth : .5;
  const centerY = imageHeight ? (viewport.scrollTop + height / 2 - Math.max(0, (height - imageHeight) / 2)) / imageHeight : .5;
  const fit = Math.min(width / image.naturalWidth, height / image.naturalHeight);
  imageWidth = image.naturalWidth * fit * zoomPercent / 100;
  imageHeight = image.naturalHeight * fit * zoomPercent / 100;
  surface.style.width = `${Math.max(width, imageWidth)}px`;
  surface.style.height = `${Math.max(height, imageHeight)}px`;
  image.style.width = `${imageWidth}px`;
  image.style.height = `${imageHeight}px`;
  viewport.scrollLeft = Math.max(0, (width - imageWidth) / 2) + centerX * imageWidth - width / 2;
  viewport.scrollTop = Math.max(0, (height - imageHeight) / 2) + centerY * imageHeight - height / 2;
  window.dispatchEvent(new Event('map-view-change'));
}

function setZoom(value) {
  stopMapDrag();
  zoomPercent = Math.min(2000, Math.max(100, Math.round(Number(value) / 5) * 5));
  zoom.value = zoomPercent;
  zoom.setAttribute('aria-valuetext', `${zoomPercent}%`);
  document.getElementById('zoom-value').value = `${zoomPercent}%`;
  document.getElementById('zoom-out').disabled = zoomPercent === 100;
  document.getElementById('zoom-in').disabled = zoomPercent === 2000;
  layoutMap();
}
zoom.addEventListener('input', () => setZoom(zoom.value));
document.getElementById('zoom-out').addEventListener('click', () => setZoom(zoomPercent - 5));
document.getElementById('zoom-in').addEventListener('click', () => setZoom(zoomPercent + 5));
new ResizeObserver(() => layoutMap()).observe(viewport);
const labels = { home: '首页', templates: '创建地图', map: window.MapTemplate.label, settings: '设置' };

function renderBreadcrumb(page) {
  const breadcrumb = document.getElementById('breadcrumb');
  const entries = [{ label: '首页', route: 'home', id: 'nav-home' }];
  if (page === 'settings') entries.push({ label: '设置', route: 'settings' });
  else if (page !== 'home') {
    entries.push({ label: '创建地图', route: 'templates', id: 'nav-create' });
    if (page === 'map') entries.push({ label: window.MapTemplate.label, route: 'map' });
  }
  breadcrumb.replaceChildren();
  entries.forEach((entry, index) => {
    if (index) {
      const separator = document.createElement('span');
      separator.className = 'breadcrumb-separator'; separator.textContent = '/'; separator.setAttribute('aria-hidden', 'true');
      breadcrumb.append(separator);
    }
    const link = document.createElement('a');
    link.href = `#${entry.route}`; link.textContent = entry.label;
    if (entry.id) link.id = entry.id;
    if (index === entries.length - 1) link.setAttribute('aria-current', 'page');
    breadcrumb.append(link);
  });
}

function renderRoute() {
  stopMapDrag();
  const route = location.hash.slice(1);
  const page = pages.includes(route) ? route : 'home';
  pages.forEach(name => { document.getElementById(name).hidden = name !== page; });
  renderBreadcrumb(page);
  document.title = `${page === 'map' ? window.MapTemplate.label : labels[page]} · MapDesigner`;
  if (page === 'map' && !image.getAttribute('src') && !mapLoading) {
    loadAdminMap(adminLevel.value);
  }
  if (page === 'map') requestAnimationFrame(layoutMap);
}

image.addEventListener('load', () => { message.hidden = true; layoutMap(); });
image.addEventListener('error', () => {
  message.hidden = false;
  message.textContent = `底图加载失败，请检查 ${window.MapTemplate.assetRoot}/basemap.png 是否存在，然后刷新页面。`;
});
document.getElementById('create-map').addEventListener('click', () => { location.hash = 'templates'; });
for (const key of ['eu5', 'hoi4', 'vic3']) {
  const button = document.getElementById(`choose-${key}`);
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      if (key === window.MapTemplate.key) await window.MapProject.createBlank();
      else await window.MapTemplates.navigate(key, { fresh: true });
    } catch (error) {
      document.getElementById('project-open-status').textContent = `创建失败：${error.message}`;
      location.hash = 'home';
    } finally { button.disabled = false; }
  });
}
document.getElementById('back-templates').addEventListener('click', () => { location.hash = 'templates'; });
window.addEventListener('hashchange', renderRoute);
for (const toggle of document.querySelectorAll('.map-lists button[aria-controls]')) {
  const scroll = document.getElementById(toggle.getAttribute('aria-controls'));
  const name = toggle.closest('aside').getAttribute('aria-label');
  let scrollTop = 0;
  toggle.addEventListener('click', () => {
    const expand = scroll.hidden;
    if (!expand) scrollTop = scroll.scrollTop;
    scroll.hidden = !expand;
    if (expand) scroll.scrollTop = scrollTop;
    const label = (expand ? '收起' : '展开') + name;
    toggle.setAttribute('aria-expanded', String(expand));
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
  });
}
setZoom(100);
renderRoute();

window.MapView = {
  capture: () => {
    const bounds = image.getBoundingClientRect(), view = viewport.getBoundingClientRect();
    return {
      zoom: zoomPercent, adminLevel: loadedAdminLevel, paintLevel: document.getElementById('paint-level').value,
      boundariesHidden: loadedBoundariesHidden, boundaryDisplay: loadedBoundaryDisplay, namesEnabled,
      center: { x: Math.max(0, Math.min(1, (view.left + viewport.clientWidth / 2 - bounds.left) / bounds.width)),
        y: Math.max(0, Math.min(1, (view.top + viewport.clientHeight / 2 - bounds.top) / bounds.height)) }
    };
  },
  restore: async settings => {
    restoringMapView = true;
    try {
      adminLevel.value = settings.adminLevel;
      boundaryDisplay = settings.boundaryDisplay || (settings.boundariesHidden ? 'hidden' : 'plots');
      boundariesHidden = boundaryDisplay !== 'plots';
      // Start restoring the snapshot before the route can request a default basemap.
      const mapLoad = loadAdminMap(settings.adminLevel);
      location.hash = 'map'; renderRoute();
      if (!await mapLoad) throw new Error('快照所需底图加载失败。');
      if (!image.complete) await new Promise((resolve, reject) => { image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', reject, { once: true }); });
      document.getElementById('paint-level').value = settings.paintLevel;
      setZoom(settings.zoom);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      viewport.scrollLeft = Math.max(0, (viewport.clientWidth - imageWidth) / 2) + settings.center.x * imageWidth - viewport.clientWidth / 2;
      viewport.scrollTop = Math.max(0, (viewport.clientHeight - imageHeight) / 2) + settings.center.y * imageHeight - viewport.clientHeight / 2;
      if (namesEnabled !== settings.namesEnabled) nameButton.click();
    } finally {
      restoringMapView = false;
      window.dispatchEvent(new Event('map-view-change'));
    }
  }
};

const ck3Dialog=document.getElementById('ck3-date-dialog');
document.getElementById('choose-ck3').addEventListener('click',()=>ck3Dialog.showModal());
document.getElementById('close-ck3-date').addEventListener('click',()=>ck3Dialog.close());
document.getElementById('create-ck3-map').addEventListener('click',async event=>{
  const button=event.currentTarget;button.disabled=true;
  try{const key=document.getElementById('ck3-scenario').value;ck3Dialog.close();if(key===window.MapTemplate.key)await window.MapProject.createBlank();else await window.MapTemplates.navigate(key,{fresh:true});}
  catch(error){document.getElementById('project-open-status').textContent=`创建失败：${error.message}`;location.hash='home';}
  finally{button.disabled=false;}
});
