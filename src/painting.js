(() => {
  const STORAGE_KEY = `mapdesigner.${window.MapTemplate.key}.paint.v1`;
  const layer = document.getElementById('paint-layer');
  const context = layer.getContext('2d');
  const grain = document.getElementById('paint-level');
  const pickButton = document.getElementById('pick-country');
  const eraseButton = document.getElementById('erase-map');
  const wasteButton = document.getElementById('toggle-wasteland');
  const undoButton = document.getElementById('undo-map');
  const status = document.getElementById('paint-status');
  let owners = {};
  let allowWasteland = false;
  let mode = 'pan';
  let countryPickRequest = 0;
  let metadataPromise;
  let groupMembers;
  let renderFrame = 0;
  let renderSequence = 0;
  let paintRevision = 0;
  let rendering = false;
  let renderedKey;
  let renderedView;
  let operationQueue = Promise.resolve();
  let pendingOperations = 0;
  const history = [];
  let historyChanges = 0;
  function updateUndo() {
    undoButton.disabled = history.length === 0 || pendingOperations > 0;
    undoButton.title = history.length ? `撤销：${history[history.length - 1].label}` : '暂无可撤销的操作';
  }
  function remember(entry) {
    entry.changes ||= [];
    history.push(entry);
    historyChanges += entry.changes.length;
    // Bound memory by both operation count and changed location count, never map bitmaps.
    while (history.length > 30 || (historyChanges > 150000 && history.length > 1)) {
      historyChanges -= history.shift().changes.length;
    }
    updateUndo();
  }
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    allowWasteland = stored.wastelandEnabled === true;
    if (stored.owners && typeof stored.owners === 'object' && !Array.isArray(stored.owners)) {
      for (const [id, country] of Object.entries(stored.owners)) {
        if (/^[1-9]\d*$/.test(id) && typeof country === 'string') owners[id] = country;
      }
    }
  } catch { /* A new map can still be painted if storage is unavailable. */ }

  async function ready() {
    if (!metadataPromise) metadataPromise = (async () => {
      if (!window.MapDesignerData.meta) await loadLookupScript('meta.js');
      if (!window.MapDesignerData.paintMeta) await loadLookupScript('paint-meta.js');
      const metadata = window.MapDesignerData.meta;
      const kinds = window.MapDesignerData.paintMeta.kinds;
      groupMembers = Object.fromEntries(metadata.parentOrder.map(level => [level, new Map()]));
      metadata.locations.forEach((location, id) => {
        if (!location?.[2]) return;
        metadata.parentOrder.forEach((level, index) => {
          const parent = location[2][index];
          if (!groupMembers[level].has(parent)) groupMembers[level].set(parent, []);
          groupMembers[level].get(parent).push(id);
        });
      });
      for (const id of Object.keys(owners)) {
        if (!metadata.locations[id] || kinds[id] === 1 || (!allowWasteland && kinds[id] === 2)) delete owners[id];
      }
      purgeDeletedCountries();
      return metadata;
    })().catch(error => { metadataPromise = null; throw error; });
    return metadataPromise;
  }

  function persist() {
    paintRevision++;
    window.dispatchEvent(new Event('territories-changed'));
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, wastelandEnabled: allowWasteland, owners })); }
    catch { status.textContent = '当前着色已生效，但本地保存失败。'; }
  }
  function purgeDeletedCountries(countries = window.CountryStore.list()) {
    const ids = new Set(countries.map(country => country.id));
    const changes = [];
    for (const id of Object.keys(owners)) if (!ids.has(owners[id])) {
      changes.push([Number(id), owners[id]]);
      delete owners[id];
    }
    return changes;
  }
  function updateTools() {
    pickButton.setAttribute('aria-pressed', String(mode === 'pick-country'));
    eraseButton.setAttribute('aria-pressed', String(mode === 'erase'));
    wasteButton.setAttribute('aria-checked', String(allowWasteland));
    wasteButton.title = allowWasteland ? '关闭荒地着色并还原已着色荒地' : '允许荒地着色';
    viewport.classList.toggle('paint-mode', mode === 'paint');
    viewport.classList.toggle('erase-mode', mode === 'erase');
    viewport.classList.toggle('pick-country-mode', mode === 'pick-country');
  }
  function getPixel(point) {
    const bounds = image.getBoundingClientRect();
    const view = viewport.getBoundingClientRect();
    if (!image.naturalWidth || point.x < view.left || point.x >= view.left + viewport.clientWidth || point.y < view.top || point.y >= view.top + viewport.clientHeight ||
        point.x < bounds.left || point.x >= bounds.right || point.y < bounds.top || point.y >= bounds.bottom) return null;
    return { x: Math.floor((point.x - bounds.left) * image.naturalWidth / bounds.width), y: Math.floor((point.y - bounds.top) * image.naturalHeight / bounds.height) };
  }
  async function locationAt(pixel, metadata) {
    const band = Math.floor(pixel.y / metadata.bandHeight);
    if (!window.MapDesignerData.bands[band]) await loadLookupScript(`band-${band}.js`);
    const row = window.MapDesignerData.bands[band][pixel.y % metadata.bandHeight];
    let low = 0, high = row.length / 2;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (pixel.x < row[mid * 2]) high = mid; else low = mid + 1;
    }
    return row[low * 2 + 1];
  }
  function enqueue(operation) {
    pendingOperations++;
    updateUndo();
    layer.dataset.busy = 'true';
    operationQueue = operationQueue.then(operation).catch(() => { status.textContent = '地图着色数据加载失败，请重试。'; }).finally(() => {
      pendingOperations--;
      layer.dataset.busy = String(pendingOperations > 0);
      updateUndo();
      scheduleRender();
    });
  }
  function stopCountryPick() {
    if (mode !== 'pick-country') return;
    mode = 'pan';
    status.textContent = '';
    updateTools();
  }
  async function pickCountry(pixel) {
    const request = ++countryPickRequest;
    const isCurrent = () => mode === 'pick-country' && countryPickRequest === request;
    try {
      const id = await locationAt(pixel, await ready());
      await operationQueue;
      if (!isCurrent() || document.querySelector('dialog[open]')) return;
      if (window.MapDesignerData.paintMeta.kinds[id] !== 1 && window.CountryStore.openInfo(owners[id])) {
        stopCountryPick();
      } else {
        status.textContent = '请点击已着色的地块。';
      }
    } catch {
      if (isCurrent()) status.textContent = '无法读取地块，请重试。';
    }
  }
  window.addEventListener('map-click', event => {
    if (window.CountryCapitals?.selected()) return;
    if (window.GroupStore.pickingMember()) {
      window.GroupStore.pickMember(event.detail);
      return;
    }
    if (mode === 'pan') return;
    const pixel = getPixel(event.detail);
    if (!pixel) return;
    if (mode === 'pick-country') {
      pickCountry(pixel);
      return;
    }
    const operation = { pixel, mode, level: grain.value, country: window.CountryStore.selected() };
    enqueue(async () => {
      const metadata = await ready();
      const id = await locationAt(operation.pixel, metadata);
      const kinds = window.MapDesignerData.paintMeta.kinds;
      if (kinds[id] === 1) { status.textContent = '海洋和湖泊不能着色。'; return; }
      if (kinds[id] === 2 && !allowWasteland) { status.textContent = '请先打开荒地着色。'; return; }
      if (operation.mode === 'paint' && !window.CountryStore.list().some(country => country.id === operation.country)) return;
      let targets = [id];
      if (operation.level !== window.MapTemplate.baseLevel) {
        const parent = metadata.locations[id]?.[2]?.[metadata.parentOrder.indexOf(operation.level)];
        if (!parent) { status.textContent = '此地块未定义该等级的归属。'; return; }
        targets = groupMembers[operation.level].get(parent) || [];
      }
      let changed = 0;
      const changes = [];
      for (const target of targets) {
        if (kinds[target] === 1 || (kinds[target] === 2 && !allowWasteland)) continue;
        if (operation.mode === 'erase') {
          if (owners[target]) { changes.push([target, owners[target]]); delete owners[target]; changed++; }
        } else if (owners[target] !== operation.country) { changes.push([target, owners[target] || null]); owners[target] = operation.country; changed++; }
      }
      if (changes.length) remember({ label: operation.mode === 'erase' ? '擦除' : '着色', changes });
      status.textContent = `已${operation.mode === 'erase' ? '还原' : '着色'} ${changed} 个地块`;
      persist();
    });
  });
  window.addEventListener('country-selection', event => {
    mode = event.detail.id ? 'paint' : 'pan';
    if (event.detail.id && namesEnabled) nameButton.click();
    const selected = window.CountryStore.list().find(country => country.id === event.detail.id);
    status.textContent = selected ? `着色：${window.CountryStore.fullName(selected) || '未命名国家'}` : '';
    updateTools();
  });
  window.addEventListener('name-mode-enabled', () => { window.CountryStore.select(null); mode = 'pan'; updateTools(); });
  pickButton.addEventListener('click', () => {
    if (mode === 'pick-country') {
      stopCountryPick();
      return;
    }
    window.CountryStore.select(null);
    if (namesEnabled) nameButton.click();
    countryPickRequest++;
    mode = 'pick-country';
    status.textContent = '点击已着色的地块查看国家信息。';
    updateTools();
  });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && mode === 'pick-country' && !document.querySelector('dialog[open]')) {
      event.preventDefault();
      stopCountryPick();
    }
  });
  window.addEventListener('hashchange', stopCountryPick);
  eraseButton.addEventListener('click', () => {
    const enable = mode !== 'erase';
    window.CountryStore.select(null);
    if (namesEnabled) nameButton.click();
    mode = enable ? 'erase' : 'pan';
    status.textContent = enable ? '擦除：单击还原所选粒度的地块' : '';
    updateTools();
  });
  wasteButton.addEventListener('click', () => {
    const desired = wasteButton.getAttribute('aria-checked') !== 'true';
    wasteButton.setAttribute('aria-checked', String(desired));
    enqueue(async () => {
      await ready();
      allowWasteland = desired;
      if (!allowWasteland) {
        const kinds = window.MapDesignerData.paintMeta.kinds;
        for (const id of Object.keys(owners)) if (kinds[id] === 2) {
          delete owners[id];
        }
        // A setting change is not undoable. Do not let older edits resurrect
        // wasteland ownership that this setting has explicitly cleared.
        for (let i = history.length - 1; i >= 0; i--) {
          const entry = history[i];
          const retained = entry.changes.filter(([id]) => kinds[id] !== 2);
          historyChanges -= entry.changes.length - retained.length;
          entry.changes = retained;
          if (!retained.length && !entry.countries && !entry.groups) history.splice(i, 1);
        }
        updateUndo();
        status.textContent = '荒地着色已关闭，已还原所有荒地。';
      } else status.textContent = '荒地着色已开启。';
      updateTools();
      persist();
    });
  });
  window.addEventListener('countries-changed', event => {
    const apply = () => {
      const changes = purgeDeletedCountries(event.detail?.after);
      const before = event.detail?.before;
      if (before) {
        const after = event.detail.after;
        const label = event.detail.label || (before.length < after.length ? '创建国家' : before.length > after.length ? '删除国家' : '修改国家');
        remember({ label, changes, countries: before, groups: event.detail.groupsBefore });
      }
      persist();
      if (mode === 'paint') {
        const selected = window.CountryStore.list().find(country => country.id === window.CountryStore.selected());
        status.textContent = selected ? `着色：${window.CountryStore.fullName(selected) || '未命名国家'}` : '';
      }
      scheduleRender();
    };
    if (event.detail?.before) enqueue(apply); else apply();
  });
  window.addEventListener('groups-changed', ({ detail: { before, label } }) => {
    enqueue(() => remember({ label, groups: before }));
  });
  undoButton.addEventListener('click', () => {
    if (!history.length || pendingOperations) return;
    enqueue(async () => {
      const entry = history.pop();
      historyChanges -= entry.changes.length;
      if (entry.countries) window.CountryStore.restore(entry.countries);
      if (entry.groups) {
        window.GroupStore.restore(entry.groups);
        if (!entry.countries) {
          status.textContent = `已撤销${entry.label}`;
          return;
        }
      }
      const validCountries = new Set(window.CountryStore.list().map(country => country.id));
      for (const [id, previousOwner] of entry.changes) {
        if (previousOwner && validCountries.has(previousOwner) && (allowWasteland || window.MapDesignerData.paintMeta?.kinds[id] !== 2)) owners[id] = previousOwner;
        else delete owners[id];
      }
      updateTools();
      persist();
      status.textContent = `已撤销${entry.label}`;
    });
  });


  function scheduleRender() {
    ++renderSequence;
    layer.dataset.rendered = 'false';
    if (renderedView && !restoringMapView) {
      const { scale, offsetX, offsetY } = readFrame();
      if (scale > 0) {
        const zoom = scale / renderedView.scale;
        layer.style.transform = `translate(${offsetX - renderedView.offsetX * zoom}px, ${offsetY - renderedView.offsetY * zoom}px) scale(${zoom})`;
      }
    }
    requestRender();
  }
  function requestRender() {
    if (!renderFrame && !rendering) renderFrame = requestAnimationFrame(() => {
      renderFrame = 0;
      renderTerritories();
    });
  }
  function readFrame() {
    const bounds = image.getBoundingClientRect(), view = viewport.getBoundingClientRect();
    return {
      scale: bounds.width / window.MapTemplate.width,
      offsetX: bounds.left - view.left, offsetY: bounds.top - view.top,
      width: viewport.clientWidth, height: viewport.clientHeight, ratio: window.devicePixelRatio || 1,
      level: loadedBoundaryDisplay === 'countries' ? 'countries' : loadedBoundariesHidden ? 'none' : loadedAdminLevel,
      colors: window.MapAppearance.capture(),
      groupRevision: window.GroupStore.outlineRevision(),
    };
  }
  function frameKey(frame) {
    return JSON.stringify([paintRevision, frame]);
  }
  async function renderTerritories() {
    if (restoringMapView || !viewport.clientWidth || !viewport.clientHeight) return;
    if (!image.naturalWidth) {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, layer.width, layer.height); renderedKey = null;
      layer.dataset.rendered = 'true'; return;
    }
    rendering = true;
    let sequence = renderSequence;
    try {
      await ready();
      const frame = readFrame();
      if (restoringMapView || !frame.width || !frame.height || !frame.scale) return;
      sequence = renderSequence;
      const key = frameKey(frame);
      const isCurrent = () => !restoringMapView && (sequence === renderSequence || key === frameKey(readFrame()));
      if (key !== renderedKey) {
        renderedKey = null;
        const { width, height, ratio } = frame;
        if (layer.width !== Math.ceil(width * ratio)) layer.width = Math.ceil(width * ratio);
        if (layer.height !== Math.ceil(height * ratio)) layer.height = Math.ceil(height * ratio);
        layer.style.width = `${width}px`; layer.style.height = `${height}px`;
        await window.VectorMap.renderViewport(context, {
          ...frame, paintRevision, owners, countries: window.CountryStore.displayColors(),
          countryRoots: frame.level === 'countries' ? window.CountryStore.borderRoots() : undefined,
          groups: frame.level === 'countries' ? window.GroupStore.list() : undefined,
        }, isCurrent);
      }
      if (!isCurrent()) return;
      renderedKey = key;
      renderedView = frame;
      layer.style.transform = '';
      layer.dataset.rendered = 'true';
    } catch {
      if (sequence === renderSequence) { status.textContent = '领土显示加载失败，请刷新重试。'; layer.dataset.rendered = 'error'; }
    } finally {
      rendering = false;
      if (sequence !== renderSequence && layer.dataset.rendered !== 'true') requestRender();
    }
  }
  for (const event of ['scroll']) viewport.addEventListener(event, scheduleRender);
  window.addEventListener('map-view-change', scheduleRender);
  image.addEventListener('load', scheduleRender);
  updateTools();
  updateUndo();
  window.MapPainting = {
    ownerOf: id => owners[id] || null,
    locationAtPoint: async point => {
      const pixel = getPixel(point); if (!pixel) return null;
      const metadata = await ready(), id = await locationAt(pixel, metadata);
      return { ...pixel, id, kind: window.MapDesignerData.paintMeta.kinds[id], name: metadata.locations[id]?.[1] || '' };
    },
    whenIdle: async () => { await operationQueue; },
    redraw: scheduleRender,
    waitForRender: async () => {
      const start = performance.now();
      while (layer.dataset.rendered !== 'true' || pendingOperations > 0) {
        if (layer.dataset.rendered === 'error') throw new Error('领土画面尚未正确加载。');
        if (performance.now() - start > 30000) throw new Error('等待地图绘制超时，请重试。');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    },
    capture: () => ({ owners: { ...owners }, wastelandEnabled: allowWasteland, mode: mode === 'pick-country' ? 'pan' : mode, selectedCountry: window.CountryStore.selected() }),
    restore: async state => {
      await operationQueue;
      await ready();
      if (namesEnabled) nameButton.click();
      owners = { ...state.owners };
      allowWasteland = state.wastelandEnabled;
      history.length = 0; historyChanges = 0;
      window.CountryStore.select(state.mode === 'paint' ? state.selectedCountry : null);
      mode = state.mode === 'erase' ? 'erase' : state.mode === 'paint' && window.CountryStore.selected() ? 'paint' : 'pan';
      updateTools(); updateUndo(); persist(); scheduleRender();
    }
  };
  ready().then(scheduleRender).catch(() => { status.textContent = '地图显示加载失败，请刷新重试。'; });
})();
