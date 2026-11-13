(() => {
  const defaults = { water: '#b9dfee', wasteland: '#dedede', fineBorder: '#969696', coarseBorder: '#555555', countryBorder: '#000000', vassalColorMode: 'lighter', style: 'classic' };
  const labels = { water: '水域颜色', wasteland: '荒地颜色', fineBorder: '细粒度边界颜色', coarseBorder: '粗粒度边界颜色', countryBorder: '国家边界颜色' };
  const storageKey = `mapdesigner.${window.MapTemplate.key}.appearance.v1`;
  const reserved = new Map();
  let colors = { ...defaults };
  const sources = new Map(), urls = new Map();
  function validate(value = defaults, countries = [], template = window.MapTemplate) {
    if (!value || typeof value !== 'object') throw new Error('地图颜色设置无效。');
    value = { countryBorder: defaults.countryBorder, ...value };
    const result = {};
    for (const key of Object.keys(labels)) {
      if (typeof value[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(value[key])) throw new Error(`${labels[key]}无效，请使用 #RRGGBB。`);
      result[key] = value[key].toLowerCase();
      if (countries.some(country => country?.color?.toLowerCase() === result[key])) throw new Error(`${labels[key]}不能与现有国家颜色相同。`);
    }
    result.vassalColorMode = value.vassalColorMode ?? defaults.vassalColorMode;
    if (!['free', 'same', 'lighter'].includes(result.vassalColorMode)) throw new Error('附庸着色设置无效。');
    const style = value.style ?? defaults.style;
    result.style = style === 'paper' || style === 'copper' ? 'classic'
      : style === 'bathymetry' && template.game === 'eu5' ? 'terrain' : style;
    if (!window.MapStyles.valid(result.style)) throw new Error('地图风格设置无效。');
    return result;
  }
  try { const saved = localStorage.getItem(storageKey); if (saved) colors = validate(JSON.parse(saved)); } catch {}
  function updateReservedAndLegend() {
    reserved.clear();
    const reservedLabels = { water: '海洋 / 河流', wasteland: '荒地', fineBorder: '地块边界', coarseBorder: '行政区划边界', countryBorder: '国家边界' };
    for (const key of Object.keys(labels)) reserved.set(colors[key], reservedLabels[key]);
    for (const [selector, key] of [['.legend .water','water'],['.legend .wasteland','wasteland'],['.legend .boundary','fineBorder'],['.legend .admin-boundary','coarseBorder']]) document.querySelector(selector).style.backgroundColor = colors[key];
  }
  function restore(value = defaults) {
    colors = validate(value); updateReservedAndLegend();
    try { localStorage.setItem(storageKey, JSON.stringify(colors)); } catch {}
    window.CountryStore?.refresh();
  }
  async function applyAppearance(value, previous) {
    if (Object.keys(value).every(key => value[key] === previous[key])) return;
    if (value.style !== previous.style) await window.MapStyles.load(value.style);
    restore(value);
    const rasterColors = ['water', 'wasteland', 'fineBorder', 'coarseBorder'];
    if (rasterColors.some(key => value[key] !== previous[key]) && !await loadAdminMap(adminLevel.value)) {
      throw new Error('地图颜色加载失败。');
    }
    updateBoundaryControls();
    window.MapPainting.redraw();
    await window.MapPainting.waitForRender();
  }
  updateReservedAndLegend();
  const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  function crc32(bytes, start, end) {
    let crc = 0xffffffff;
    for (let i = start; i < end; i++) crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  function sourceBytes(filename) {
    if (!sources.has(filename)) {
      const promise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = new URL(`${window.MapTemplate.assetRoot}/palette/${filename.replace(/\.png$/, '.js')}`, document.baseURI).href;
        script.onload = () => {
          try {
            const binary = atob(window.MapPaletteSources[filename]);
            const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
            delete window.MapPaletteSources[filename]; script.remove(); resolve(bytes);
          } catch (error) { sources.delete(filename); script.remove(); reject(error); }
        };
        script.onerror = () => { sources.delete(filename); script.remove(); reject(new Error('地图调色资源加载失败。')); };
        document.head.append(script);
      });
      sources.set(filename, promise);
    }
    return sources.get(filename);
  }
  async function load(filename, originalURL) {
    const palette = Object.fromEntries(Object.keys(labels).map(key => [key, colors[key]]));
    const hasCoarseBorder = filename !== 'basemap.png' && filename !== 'basemap-no-borders.png';
    if (['water','wasteland','fineBorder'].every(key => palette[key] === defaults[key]) && (!hasCoarseBorder || palette.coarseBorder === '#000000')) return loadMapAsset(originalURL);
    const key = JSON.stringify([filename, palette]);
    if (urls.has(key)) return loadMapAsset(urls.get(key));
    const bytes = (await sourceBytes(filename)).slice();
    const view = new DataView(bytes.buffer);
    let found = false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = view.getUint32(offset);
      if (String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)) === 'PLTE') {
        if (length < 15) throw new Error('地图调色板无效。');
        for (const [index, name] of [[1,'water'],[2,'wasteland'],[3,'fineBorder'],[4,'coarseBorder']]) {
          const color = palette[name];
          for (let channel = 0; channel < 3; channel++) bytes[offset + 8 + index * 3 + channel] = parseInt(color.slice(1 + channel * 2, 3 + channel * 2), 16);
        }
        view.setUint32(offset + 8 + length, crc32(bytes, offset + 4, offset + 8 + length)); found = true; break;
      }
      offset += length + 12;
    }
    if (!found) throw new Error('底图不支持调色。');
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    try {
      const result = await loadMapAsset(url); urls.set(key, url);
      while (urls.size > 2) { const oldest = urls.keys().next().value; URL.revokeObjectURL(urls.get(oldest)); urls.delete(oldest); }
      return result;
    } catch (error) { URL.revokeObjectURL(url); throw error; }
  }
  const dialog = document.getElementById('map-settings-dialog');
  const form = document.getElementById('map-settings-form');
  const status = document.getElementById('map-settings-status');
  const styleInput = document.getElementById('map-style');
  styleInput.replaceChildren(...Object.entries(window.MapStyles.options()).map(([value, label]) => new Option(label, value)));
  let working = false;
  for (const [key, label] of Object.entries(labels)) {
    const row = document.createElement('div'); row.className = 'map-color-row';
    const name = document.createElement('label'); name.htmlFor = `map-color-${key}`; name.textContent = label;
    const controls = document.createElement('div'); controls.className = 'map-color-controls';
    const swatch = document.createElement('input'); swatch.type = 'color'; swatch.id = `map-color-${key}`; swatch.setAttribute('aria-label', `选择${label}`);
    const text = document.createElement('input'); text.type = 'text'; text.id = `map-color-hex-${key}`; text.maxLength = 7; text.setAttribute('aria-label', `${label}十六进制值`);
    swatch.addEventListener('input', () => { text.value = swatch.value; });
    text.addEventListener('input', () => { if (/^#[0-9a-f]{6}$/i.test(text.value)) swatch.value = text.value; });
    controls.append(swatch, text); row.append(name, controls); document.getElementById('map-color-fields').append(row);
  }
  function fill(value) {
    styleInput.value = value.style;
    document.getElementById('vassal-color-mode').value = value.vassalColorMode;
    for (const key of Object.keys(labels)) {
      document.getElementById(`map-color-${key}`).value = value[key];
      document.getElementById(`map-color-hex-${key}`).value = value[key];
    }
  }
  document.getElementById('open-map-settings').addEventListener('click', () => { stopMapDrag(); fill(colors); window.CountryLabels.fillSettings(); status.textContent = ''; dialog.showModal(); });
  document.getElementById('close-map-settings').addEventListener('click', () => { if (!working) dialog.close(); });
  document.getElementById('reset-map-settings').addEventListener('click', () => saveColors(true));
  dialog.addEventListener('cancel', event => { if (working) event.preventDefault(); });
  async function saveColors(reset = false) {
    if (working) return;
    const before = { ...colors }, beforeLabels = window.CountryLabels.capture();
    if (reset) { fill(defaults); window.CountryLabels.fillSettings(window.CountryLabels.defaults()); }
    working = true; for (const control of form.querySelectorAll('button,input,select')) control.disabled = true;
    try {
      const next = Object.fromEntries(Object.keys(labels).map(key => [key, document.getElementById(`map-color-hex-${key}`).value.trim()]));
      next.vassalColorMode = document.getElementById('vassal-color-mode').value;
      next.style = styleInput.value;
      const validated = validate(next, window.CountryStore.list());
      const nextLabels = reset ? window.CountryLabels.defaults() : window.CountryLabels.readSettings();
      status.textContent = '正在应用地图风格…';
      window.CountryLabels.restore(nextLabels);
      await applyAppearance(validated, before);
      await window.CountryLabels.waitForRender();
      status.textContent = reset ? '当前地图已恢复默认设置并保存。' : '设置已保存至当前地图，保存 snapshot 后可随文件恢复。';
    } catch (error) {
      window.CountryLabels.restore(beforeLabels);
      try { await applyAppearance(before, colors); } catch {}
      status.textContent = `保存失败：${error.message}`;
    } finally { working = false; for (const control of form.querySelectorAll('button,input,select')) control.disabled = false; }
  }
  form.addEventListener('submit', event => { event.preventDefault(); saveColors(); });
  window.MapAppearance = { defaults: () => ({ ...defaults }), capture: () => ({ ...colors }), validate, restore, reservedColors: () => reserved, load };
})();
