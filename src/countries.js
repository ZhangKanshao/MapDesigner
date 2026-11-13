(() => {
  const STORAGE_KEY = `mapdesigner.${window.MapTemplate.key}.countries.v1`;
  const presets = ['#c85b51', '#d68c45', '#d2b453', '#7b9a58', '#499483', '#528eae', '#677cb2', '#9974a8', '#b06e85', '#a8795d', '#718d94', '#596779', '#ecb9b2', '#eed39c', '#a8caba', '#b5c5e0'];
  const reservedColors = window.MapAppearance.reservedColors();
  const dialog = document.getElementById('country-dialog');
  const form = document.getElementById('country-form');
  const nameInput = document.getElementById('country-name');
  const typeInput = document.getElementById('country-type');
  const descriptionInput = document.getElementById('country-description');
  const suzerainSelect = document.getElementById('country-suzerain');
  const groupChoices = document.getElementById('country-groups');
  const swatch = document.getElementById('country-color-swatch');
  const infoBrush = document.getElementById('country-info-brush');
  const brushIcon = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M14 5l5 5M9 15l10-12 2 2L11 17M10 15c-4-2-5 2-5 4-1 1-2 1-3 1 6 3 10 0 8-5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const picker = document.getElementById('country-color-picker');
  const canvas = document.getElementById('country-sv');
  const hueInput = document.getElementById('country-hue');
  const rgbInputs = ['red', 'green', 'blue'].map(channel => document.getElementById(`country-${channel}`));
  const context = canvas.getContext('2d');
  const countryList = document.getElementById('country-list');
  const countryPanel = countryList.closest('.country-panel');
  const countryScroll = document.getElementById('country-panel-scroll');
  let countryDrag = null;
  let dragFrame = 0;
  let countries = [];
  let color = presets[0];
  let hsv = [0, 0, 0];
  let colorDrag = null;
  let editingId = null;
  let draftCapital;
  let selectedId = null;
  const normalizedName = name => name.trim().normalize('NFKC').toLowerCase();
  const fullName = country => country.name + (country.countryType || '');
  const fromRGB = rgb => '#' + rgb.map(value => value.toString(16).padStart(2, '0')).join('');
  const toRGB = hex => [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16));

  function nearbyColor(vassal, base, siblings, used) {
    // IDs seed the offsets so repainting and list sorting keep the same colors.
    let seed = 2166136261;
    for (const ch of `${vassal.suzerainId}/${vassal.id}`) seed = Math.imul(seed ^ ch.codePointAt(0), 16777619);
    function nextOffset(channel) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const low = Math.max(0, channel - 24), high = Math.min(255, channel + 24);
      return low + Math.floor((seed / 2 ** 32) * (high - low + 1));
    }

    let best = null, bestDistance = -1;
    for (let attempt = 0; attempt < 64; attempt++) {
      const rgb = base.map(nextOffset);
      const candidate = fromRGB(rgb);
      if (used.has(candidate)) continue;
      let distance = Infinity;
      for (const other of siblings) {
        const squared = (rgb[0] - other[0]) ** 2 + (rgb[1] - other[1]) ** 2 + (rgb[2] - other[2]) ** 2;
        distance = Math.min(distance, squared);
      }
      if (distance >= 20 ** 2) return candidate;
      if (distance > bestDistance) { best = candidate; bestDistance = distance; }
    }
    if (best) return best;

    // A crowded palette can exhaust the sampled values. Find an unused neighbor.
    const [red, green, blue] = base;
    for (let radius = 1; radius <= 255; radius++) {
      for (let g = Math.min(255, green + radius); g >= Math.max(0, green - radius); g--) {
        for (let r = Math.min(255, red + radius); r >= Math.max(0, red - radius); r--) {
          for (let b = Math.min(255, blue + radius); b >= Math.max(0, blue - radius); b--) {
            if (Math.max(Math.abs(r - red), Math.abs(g - green), Math.abs(b - blue)) !== radius) continue;
            const candidate = fromRGB([r, g, b]);
            if (!used.has(candidate)) return candidate;
          }
        }
      }
    }
  }

  function displayColors() {
    const base = new Map(countries.map(country => [country.id, country.color]));
    const { vassalColorMode } = window.MapAppearance.capture();
    if (vassalColorMode === 'free') return base;

    const display = new Map(base);
    const used = new Set(['#ffffff', ...reservedColors.keys(), ...base.values()]);
    const familyColors = new Map();
    const vassals = countries.filter(country => country.suzerainId).sort((a, b) => a.id.localeCompare(b.id));
    for (const vassal of vassals) {
      const suzerainColor = base.get(vassal.suzerainId);
      if (!suzerainColor) continue;
      if (vassalColorMode === 'same') {
        display.set(vassal.id, suzerainColor);
        continue;
      }
      if (!familyColors.has(vassal.suzerainId)) familyColors.set(vassal.suzerainId, [toRGB(suzerainColor)]);
      const family = familyColors.get(vassal.suzerainId);
      const color = nearbyColor(vassal, family[0], family, used);
      display.set(vassal.id, color);
      family.push(toRGB(color));
      used.add(color);
    }
    return display;
  }

  function displayError(id, message) {
    const element = document.getElementById(id);
    element.textContent = message;
    element.hidden = !message;
  }
  function nameError() {
    const name = nameInput.value.trim(), countryType = typeInput.value.trim();
    if (countryType && !name) return '请先填写国家名称。';
    const label = fullName({ name, countryType });
    if (label.length > 100) return '国家名称和国家类型合计不能超过 100 个字符。';
    const key = normalizedName(label);
    return key && countries.some(country => country.id !== editingId && normalizedName(fullName(country)) === key) ? '国家名称已存在，请使用其他名称。' : '';
  }
  function rgbValue() {
    const rgb = rgbInputs.map(input => input.value.trim() === '' ? NaN : Number(input.value));
    return rgb.every(value => Number.isInteger(value) && value >= 0 && value <= 255) ? rgb : null;
  }
  function colorError() {
    if (!rgbValue()) return 'RGB 值必须是 0–255 之间的整数。';
    if (reservedColors.has(color)) return `该颜色用于${reservedColors.get(color)}，请选择其他颜色。`;
    return countries.some(country => country.id !== editingId && country.color === color) ? '该地图颜色已被其他国家使用，请选择其他颜色。' : '';
  }
  function validate() {
    const nameMessage = nameError();
    const colorMessage = colorError();
    displayError('country-name-error', nameMessage);
    displayError('country-color-error', colorMessage);
    nameInput.setAttribute('aria-invalid', String(Boolean(nameMessage)));
    typeInput.setAttribute('aria-invalid', String(Boolean(nameMessage)));
    swatch.setAttribute('aria-invalid', String(Boolean(colorMessage)));
    return !nameMessage && !colorMessage;
  }

  function rgbToHSV([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    let hue = 0;
    if (delta) {
      if (max === r) hue = ((g - b) / delta) % 6;
      else if (max === g) hue = (b - r) / delta + 2;
      else hue = (r - g) / delta + 4;
      hue = (hue * 60 + 360) % 360;
    }
    return [hue, max ? delta / max : 0, max];
  }
  function hsvToRGB([h, s, v]) {
    const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
    const values = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return values.map(value => Math.round((value + m) * 255));
  }
  function drawPicker() {
    const width = canvas.width, height = canvas.height;
    context.fillStyle = `hsl(${hsv[0]} 100% 50%)`;
    context.fillRect(0, 0, width, height);
    const white = context.createLinearGradient(0, 0, width, 0);
    white.addColorStop(0, '#fff'); white.addColorStop(1, '#fff0');
    context.fillStyle = white; context.fillRect(0, 0, width, height);
    const black = context.createLinearGradient(0, 0, 0, height);
    black.addColorStop(0, '#0000'); black.addColorStop(1, '#000');
    context.fillStyle = black; context.fillRect(0, 0, width, height);
    context.beginPath(); context.arc(hsv[1] * width, (1 - hsv[2]) * height, 5, 0, 2 * Math.PI);
    context.strokeStyle = '#fff'; context.lineWidth = 2; context.stroke();
    context.strokeStyle = '#24384f'; context.lineWidth = 1; context.stroke();
  }
  function setColor(value, preserveHSV = false) {
    color = value.toLowerCase();
    const rgb = toRGB(color);
    if (!preserveHSV) hsv = rgbToHSV(rgb);
    rgbInputs.forEach((input, i) => { input.value = rgb[i]; });
    swatch.style.backgroundColor = color;
    hueInput.value = Math.round(hsv[0]);
    drawPicker();
    validate();
  }
  function setPickerOpen(open) {
    picker.hidden = !open;
    swatch.setAttribute('aria-expanded', String(open));
  }
  function renderCountries() {
    const scrollTop = countryScroll.scrollTop;
    const list = document.getElementById('country-list');
    const rows = document.createDocumentFragment();
    const shownColors = displayColors();
    const names = new Map();
    let unnamed = 0;
    for (const country of countries) names.set(country.id, fullName(country) || `未命名国家 ${++unnamed}`);
    for (const country of countries) {
      const item = document.createElement('li');
      item.className = 'country-list-item';
      item.dataset.countryId = country.id;
      item.classList.toggle('country-vassal', Boolean(country.suzerainId));
      const chip = document.createElement('span');
      chip.className = 'country-list-swatch';
      const shownColor = shownColors.get(country.id);
      chip.style.backgroundColor = shownColor;
      chip.setAttribute('aria-label', `RGB ${toRGB(shownColor).join(', ')}`);
      const label = document.createElement('span');
      label.textContent = names.get(country.id);
      if (country.description) item.title = country.description;
      label.className = 'country-name';
      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'country-select';
      select.draggable = true;
      select.setAttribute('aria-pressed', String(country.id === selectedId));
      select.title = `查看${label.textContent}的国家信息。拖到其他国名可设为附庸，拖到行间可排序。`;
      if (country.suzerainId) select.title += ` 宗主国：${names.get(country.suzerainId)}。拖出国家列表可解除附庸。`;
      select.append(chip, label);
      select.addEventListener('click', () => openCountry(country));
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'country-brush';
      edit.title = `使用${label.textContent}着色，再次点击取消`;
      edit.setAttribute('aria-pressed', String(country.id === selectedId));
      edit.setAttribute('aria-label', `使用${label.textContent}着色`);
      edit.innerHTML = brushIcon;
      edit.addEventListener('click', () => toggleCountryBrush(country.id));
      const capital = document.createElement('button');
      capital.type = 'button'; capital.className = 'country-capital';
      const active = country.capital && window.MapPainting?.ownerOf(country.capital.locationId) === country.id;
      capital.dataset.set = String(Boolean(country.capital)); capital.dataset.active = String(Boolean(active));
      capital.setAttribute('aria-label', `指定${label.textContent}首都`);
      capital.setAttribute('aria-pressed', String(window.CountryCapitals?.selected() === country.id));
      const capitalName = country.capital ? window.MapDesignerData?.meta?.locations[country.capital.locationId]?.[1] || country.capital.locationId : '';
      capital.title = country.capital ? (active ? `首都：${capitalName}；点击更改，右键清除` : `原首都：${capitalName}，已不在本国领土；点击重新指定，右键清除`) : `指定首都：点击后选择本国${window.MapTemplate.levels[window.MapTemplate.baseLevel]}；右键清除`;
      capital.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="m12 3 2.78 5.63 6.22.9-4.5 4.39 1.06 6.2L12 17.2l-5.56 2.92 1.06-6.2L3 9.53l6.22-.9z" fill="currentColor" fill-opacity="0" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
      capital.addEventListener('click', () => window.CountryCapitals.begin(country.id));
      capital.addEventListener('contextmenu', event => { event.preventDefault(); window.CountryCapitals.clear(country.id); });
      item.append(select, edit, capital);
      rows.append(item);
    }
    list.replaceChildren(rows);
    document.getElementById('countries-empty').hidden = countries.length !== 0;
    countryScroll.scrollTop = scrollTop;
  }
  function saveCountries() {
    const status = document.getElementById('country-storage-status');
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(countries));
      status.hidden = true;
    } catch {
      status.textContent = '国家已加入当前列表，但本地保存失败。';
      status.hidden = false;
    }
  }
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (Array.isArray(stored)) {
      for (const entry of stored) {
        if (!entry || typeof entry.id !== 'string' || typeof entry.name !== 'string' || typeof entry.description !== 'string' || !/^#[0-9a-f]{6}$/i.test(entry.color)) continue;
        const normalized = { id: entry.id, name: entry.name.trim(), description: entry.description, color: entry.color.toLowerCase() };
        if (typeof entry.countryType === 'string' && entry.countryType.trim() && normalized.name) normalized.countryType = entry.countryType.trim();
        if (entry.capital && Number.isInteger(entry.capital.locationId) && entry.capital.locationId > 0 && Number.isFinite(entry.capital.x) && Number.isFinite(entry.capital.y) && entry.capital.x >= 0 && entry.capital.x < window.MapTemplate.width && entry.capital.y >= 0 && entry.capital.y < window.MapTemplate.height) normalized.capital = { ...entry.capital };
        else if (entry.capital === null) normalized.capital = null;
        if (typeof entry.suzerainId === 'string') normalized.suzerainId = entry.suzerainId;
        const key = normalizedName(fullName(normalized));
        if (countries.some(other => other.id === normalized.id || other.color === normalized.color || (key && normalizedName(fullName(other)) === key))) continue;
        countries.push(normalized);
      }
    }
  } catch { /* Local storage may be unavailable; creation still works in this session. */ }
  const storedRoots = new Set(countries.filter(country => !country.suzerainId).map(country => country.id));
  for (const country of countries) {
    if (!storedRoots.has(country.suzerainId)) delete country.suzerainId;
  }
  countries = groupCountries(countries);
  renderCountries();

  function selectCountry(id) {
    selectedId = countries.some(country => country.id === id) ? id : null;
    renderCountries();
    window.dispatchEvent(new CustomEvent('country-selection', { detail: { id: selectedId } }));
  }
  function toggleCountryBrush(id) {
    selectCountry(selectedId === id ? null : id);
  }
  function notifyCountryChange(before, label, groupsBefore) {
    window.dispatchEvent(new CustomEvent('countries-changed', { detail: { before, after: countries.map(country => ({ ...country })), label, groupsBefore } }));
  }

  function clearDropMarker() {
    for (const item of countryList.children) item.classList.remove('country-drop-before', 'country-drop-after', 'country-drop-suzerain');
  }
  function updateDropMarker() {
    clearDropMarker();
    const name = document.elementFromPoint(countryDrag.x, countryDrag.y)?.closest('.country-select');
    const targetRow = name?.closest('.country-list-item');
    const label = name?.querySelector('.country-name')?.getBoundingClientRect();
    if (label && (countryDrag.y < label.top || countryDrag.y > label.bottom)) {
      countryDrag.suzerainTarget = null;
    } else {
      countryDrag.suzerainTarget = targetRow?.dataset.countryId ?? null;
    }
    if (countryDrag.suzerainTarget) {
      const root = suzerainRoot(countryDrag.suzerainTarget);
      if (root && root !== countryDrag.id) targetRow.classList.add('country-drop-suzerain');
      return;
    }
    const rows = [...countryList.children].filter(item => item.dataset.countryId !== countryDrag.id);
    const next = rows.find(item => {
      const bounds = item.getBoundingClientRect();
      return countryDrag.y < bounds.top + bounds.height / 2;
    });
    countryDrag.beforeId = next?.dataset.countryId || null;
    if (next) next.classList.add('country-drop-before');
    else rows.at(-1)?.classList.add('country-drop-after');
  }
  function scrollWhileDragging() {
    if (!countryDrag) return;
    const bounds = countryScroll.getBoundingClientRect();
    if (countryDrag.x >= bounds.left && countryDrag.x <= bounds.right && countryDrag.y >= bounds.top && countryDrag.y <= bounds.bottom) {
      const edge = Math.min(36, bounds.height / 3);
      const speed = countryDrag.y < bounds.top + edge ? -10 * (1 - (countryDrag.y - bounds.top) / edge) :
        countryDrag.y > bounds.bottom - edge ? 10 * (1 - (bounds.bottom - countryDrag.y) / edge) : 0;
      if (speed) { countryScroll.scrollTop += speed; updateDropMarker(); }
    }
    dragFrame = requestAnimationFrame(scrollWhileDragging);
  }
  function finishCountryDrag() {
    cancelAnimationFrame(dragFrame);
    countryDrag = null;
    clearDropMarker();
    countryList.querySelector('.country-dragging')?.classList.remove('country-dragging');
  }
  countryList.addEventListener('dragstart', event => {
    const select = event.target.closest('.country-select');
    if (!select) { event.preventDefault(); return; }
    const row = select.closest('.country-list-item');
    countryDrag = { id: row.dataset.countryId, x: event.clientX, y: event.clientY, beforeId: null };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', countryDrag.id);
    row.classList.add('country-dragging');
    dragFrame = requestAnimationFrame(scrollWhileDragging);
  });
  countryScroll.addEventListener('dragover', event => {
    if (!countryDrag) return;
    event.preventDefault();
    countryDrag.x = event.clientX; countryDrag.y = event.clientY;
    updateDropMarker();
    const root = suzerainRoot(countryDrag.suzerainTarget);
    event.dataTransfer.dropEffect = root === countryDrag.id ? 'none' : 'move';
  });
  countryScroll.addEventListener('dragleave', event => {
    if (countryDrag && !countryScroll.contains(event.relatedTarget)) {
      countryDrag.x = -Infinity; clearDropMarker();
    }
  });
  countryScroll.addEventListener('drop', event => {
    if (!countryDrag) return;
    event.preventDefault();
    countryDrag.x = event.clientX; countryDrag.y = event.clientY;
    updateDropMarker();
    const before = countries.map(country => ({ ...country }));
    const moved = countries.find(country => country.id === countryDrag.id);
    if (countryDrag.suzerainTarget) {
      const root = suzerainRoot(countryDrag.suzerainTarget);
      finishCountryDrag();
      if (!moved || !root || root === moved.id || root === moved.suzerainId) return;
      changeSuzerain(moved, root, before);
      return;
    }
    const next = countries.filter(country => country.id !== countryDrag.id);
    const index = countryDrag.beforeId ? next.findIndex(country => country.id === countryDrag.beforeId) : next.length;
    finishCountryDrag();
    if (!moved || index < 0) return;
    next.splice(index, 0, moved);
    const grouped = groupCountries(next);
    if (grouped.every((country, i) => country.id === countries[i].id)) return;
    countries = grouped;
    renderCountries(); saveCountries(); notifyCountryChange(before, '国家排序');
  });
  window.addEventListener('dragover', event => {
    if (!countryDrag || countryPanel.contains(event.target) || !countries.some(country => country.id === countryDrag.id && country.suzerainId)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  });
  window.addEventListener('drop', event => {
    if (!countryDrag || countryPanel.contains(event.target)) return;
    const moved = countries.find(country => country.id === countryDrag.id);
    if (!moved?.suzerainId) return;
    event.preventDefault();
    finishCountryDrag();
    changeSuzerain(moved, undefined, window.CountryStore.list());
  });
  countryList.addEventListener('dragend', finishCountryDrag);
  window.addEventListener('hashchange', finishCountryDrag);
  window.CountryStore = {
    displayColors, fullName,
    borderRoots: () => new Map(countries.map(country => [country.id, country.suzerainId || country.id])),
    openInfo: id => {
      const country = countries.find(entry => entry.id === id);
      if (!country || document.querySelector('dialog[open]')) return false;
      openCountry(country);
      return true;
    },
    list: () => countries.map(country => ({ ...country, ...(country.capital ? { capital: { ...country.capital } } : {}) })), refresh: renderCountries, selected: () => selectedId, select: selectCountry,
    restore: entries => {
      countries = groupCountries(entries.map(country => ({ ...country, ...(country.capital ? { capital: { ...country.capital } } : {}) })));
      if (!countries.some(country => country.id === selectedId)) selectCountry(null);
      renderCountries(); saveCountries(); notifyCountryChange();
    }
  };

  window.CountryStore.setCapital = (id, capital) => {
    const country = countries.find(country => country.id === id);
    if (!country || JSON.stringify(country.capital || null) === JSON.stringify(capital)) return;
    const before = window.CountryStore.list();
    countries = countries.map(country => country.id === id ? { ...country, capital: capital ? { ...capital } : null } : country);
    renderCountries(); saveCountries(); notifyCountryChange(before, capital ? '指定首都' : '清除首都');
  };
  window.addEventListener('capital-mode-change', renderCountries);

  function suzerainRoot(id) {
    const country = countries.find(entry => entry.id === id);
    return country?.suzerainId || country?.id;
  }

  function groupCountries(entries) {
    const groups = new Map(entries.filter(country => !country.suzerainId).map(country => [country.id, [country]]));
    const unattached = [];
    for (const country of entries) {
      if (!country.suzerainId) continue;
      const group = groups.get(country.suzerainId);
      if (group) group.push(country);
      else unattached.push(country);
    }
    return [...groups.values()].flat().concat(unattached);
  }

  function applySuzerain(country, root) {
    if (country.suzerainId === root) return [];
    if (!root) {
      delete country.suzerainId;
      countries = countries.filter(entry => entry.id !== country.id);
      countries.push(country);
      return [];
    }
    const followers = countries.filter(entry => entry.suzerainId === country.id);
    country.suzerainId = root;
    for (const vassal of followers) vassal.suzerainId = root;
    const moved = new Set([country, ...followers]);
    countries = countries.filter(entry => !moved.has(entry));
    countries.splice(countries.findIndex(entry => entry.id === root) + 1, 0, country, ...followers);
    return followers;
  }

  function updateCountryGroups(countryId, selectedGroups, root, followers) {
    const selections = new Map([[countryId, selectedGroups]]);
    if (followers.length) {
      const inheritedGroups = window.GroupStore.membershipsOf(root);
      for (const follower of followers) selections.set(follower.id, inheritedGroups);
    }
    return window.GroupStore.updateMemberships(selections);
  }

  function changeSuzerain(country, root, before) {
    const followers = applySuzerain(country, root);
    const groupsBefore = root
      ? updateCountryGroups(country.id, window.GroupStore.membershipsOf(root), root, followers)
      : undefined;
    renderCountries();
    saveCountries();
    notifyCountryChange(before, root ? '设定宗主国' : '解除附庸', groupsBefore);
  }

  function fillSuzerains(existing) {
    const names = new Map(countries.map((country, index) => [country.id, fullName(country) || `未命名国家 ${index + 1}`]));
    suzerainSelect.replaceChildren(new Option('无（独立国家）', ''));
    for (const country of countries) {
      const root = country.suzerainId || country.id;
      if (root === existing?.id) continue;
      const label = country.suzerainId ? `${names.get(country.id)}（归属 ${names.get(root)}）` : names.get(country.id);
      suzerainSelect.add(new Option(label, country.id));
    }
    suzerainSelect.value = existing?.suzerainId || '';
    displayError('country-suzerain-error', '');
  }

  function fillGroupChoices(countryId) {
    const selectedGroups = window.GroupStore.membershipsOf(countryId);
    const groups = window.GroupStore.list();
    groupChoices.replaceChildren();
    if (!groups.length) {
      const empty = document.createElement('p');
      empty.textContent = '当前地图还没有集团。';
      groupChoices.append(empty);
      return;
    }
    for (const group of groups) {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = group.id;
      checkbox.checked = selectedGroups.has(group.id);
      const swatch = document.createElement('span');
      swatch.className = 'country-list-swatch';
      swatch.style.backgroundColor = group.color;
      swatch.setAttribute('aria-hidden', 'true');
      label.append(checkbox, swatch, group.name);
      groupChoices.append(label);
    }
    groupChoices.scrollTop = 0;
  }

  suzerainSelect.addEventListener('change', () => {
    const root = suzerainRoot(suzerainSelect.value);
    if (!root) return;
    const selectedGroups = window.GroupStore.membershipsOf(root);
    for (const checkbox of groupChoices.querySelectorAll('input')) checkbox.checked = selectedGroups.has(checkbox.value);
  });

  function openCountry(existing = null) {
    stopMapDrag();
    window.CountryCapitals?.cancel();
    draftCapital = existing?.capital;
    editingId = existing?.id || null;
    form.reset();
    fillSuzerains(existing);
    fillGroupChoices(existing?.id);
    document.getElementById('country-capital-settings').hidden = !existing;
    refreshCapitalSettings();
    setPickerOpen(false);
    document.getElementById('country-dialog-title').textContent = existing ? '国家信息' : '创建国家';
    document.getElementById('close-country-dialog').setAttribute('aria-label', existing ? '关闭国家信息' : '关闭创建国家');
    infoBrush.hidden = !existing;
    infoBrush.setAttribute('aria-pressed', String(Boolean(existing && existing.id === selectedId)));
    document.getElementById('delete-country').hidden = !existing;
    dialog.querySelector('.country-dialog-heading .eyebrow').textContent = existing ? 'COUNTRY INFO' : 'NEW COUNTRY';
    nameInput.value = existing?.name || '';
    typeInput.value = existing?.countryType || '';
    descriptionInput.value = existing?.description || '';
    let next = presets.find(preset => !reservedColors.has(preset) && !countries.some(country => country.color === preset));
    if (!next) {
      let value = 1;
      while (reservedColors.has('#' + value.toString(16).padStart(6, '0')) || countries.some(country => country.color === '#' + value.toString(16).padStart(6, '0'))) value++;
      next = '#' + value.toString(16).padStart(6, '0');
    }
    setColor(existing?.color || next);
    dialog.showModal();
    nameInput.focus();
  }
  function refreshCapitalSettings() {
    document.getElementById('country-capital-name').textContent = draftCapital ? (window.MapDesignerData?.meta?.locations[draftCapital.locationId]?.[1] || `${window.MapTemplate.levels[window.MapTemplate.baseLevel]} ${draftCapital.locationId}`) : '未指定';
    document.getElementById('delete-country-capital').disabled = !draftCapital;
  }
  document.getElementById('select-country-capital').addEventListener('click', () => {
    const id=editingId;form.requestSubmit();
    if(!dialog.open && id)window.CountryCapitals.begin(id);
  });
  document.getElementById('delete-country-capital').addEventListener('click', () => {draftCapital=null;refreshCapitalSettings();});
  infoBrush.innerHTML = brushIcon;
  infoBrush.addEventListener('click', () => {
    const id = editingId;
    if (!id) return;
    form.requestSubmit();
    if (!dialog.open) toggleCountryBrush(id);
  });
  document.getElementById('create-country').addEventListener('click', () => openCountry());
  document.getElementById('delete-country').addEventListener('click', () => {
    const before = countries.map(country => ({ ...country }));
    countries = countries.filter(country => country.id !== editingId);
    for (const country of countries) {
      if (country.suzerainId === editingId) delete country.suzerainId;
    }
    if (selectedId === editingId) selectCountry(null);
    renderCountries();
    saveCountries();
    notifyCountryChange(before);
    dialog.close();
  });
  for (const id of ['close-country-dialog', 'cancel-country']) document.getElementById(id).addEventListener('click', () => dialog.close());
  swatch.addEventListener('click', () => setPickerOpen(picker.hidden));
  document.getElementById('close-color-picker').addEventListener('click', () => { setPickerOpen(false); swatch.focus(); });
  dialog.addEventListener('cancel', event => {
    if (!picker.hidden) { event.preventDefault(); setPickerOpen(false); swatch.focus(); }
  });
  window.addEventListener('hashchange', () => { if (dialog.open) dialog.close(); });
  nameInput.addEventListener('input', validate);
  typeInput.addEventListener('input', validate);
  for (const input of rgbInputs) input.addEventListener('input', () => {
    const rgb = rgbValue();
    if (rgb) setColor(fromRGB(rgb)); else validate();
  });
  for (const preset of presets) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'color-preset';
    button.style.backgroundColor = preset;
    button.setAttribute('aria-label', `选择 RGB ${toRGB(preset).join(', ')}`);
    button.addEventListener('click', () => setColor(preset));
    document.getElementById('country-color-presets').append(button);
  }
  function pickSV(event) {
    const bounds = canvas.getBoundingClientRect();
    hsv[1] = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    hsv[2] = 1 - Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
    setColor(fromRGB(hsvToRGB(hsv)), true);
  }
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    colorDrag = event.pointerId; canvas.setPointerCapture(event.pointerId); pickSV(event);
  });
  canvas.addEventListener('pointermove', event => { if (colorDrag === event.pointerId) pickSV(event); });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(type, () => { colorDrag = null; });
  canvas.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    hsv[1] = Math.max(0, Math.min(1, hsv[1] + (event.key === 'ArrowRight' ? .02 : event.key === 'ArrowLeft' ? -.02 : 0)));
    hsv[2] = Math.max(0, Math.min(1, hsv[2] + (event.key === 'ArrowUp' ? .02 : event.key === 'ArrowDown' ? -.02 : 0)));
    setColor(fromRGB(hsvToRGB(hsv)), true);
  });
  hueInput.addEventListener('input', () => { hsv[0] = Number(hueInput.value); setColor(fromRGB(hsvToRGB(hsv)), true); });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!validate()) {
      if (nameError()) nameInput.focus(); else { setPickerOpen(true); rgbInputs[0].focus(); }
      return;
    }
    const before = countries.map(country => ({ ...country }));
    const next = { ...countries.find(country => country.id === editingId), id: editingId || crypto.randomUUID(), name: nameInput.value.trim(), description: descriptionInput.value.trim(), color };
    const countryType = typeInput.value.trim();
    if (countryType) next.countryType = countryType;
    else delete next.countryType;
    const root = suzerainRoot(suzerainSelect.value);
    if (suzerainSelect.value && (!root || root === next.id)) {
      displayError('country-suzerain-error', '不能选择自己或自己的附庸作为宗主国。');
      suzerainSelect.focus();
      return;
    }
    if (draftCapital !== undefined) next.capital = draftCapital ? {...draftCapital} : null;
    if (editingId) countries = countries.map(country => country.id === editingId ? next : country);
    else countries.push(next);
    const followers = applySuzerain(next, root);
    const selectedGroups = new Set(Array.from(groupChoices.querySelectorAll('input:checked'), input => input.value));
    const groupsBefore = updateCountryGroups(next.id, selectedGroups, root, followers);
    if (editingId) renderCountries();
    else selectCountry(next.id);
    saveCountries();
    if (groupsBefore || JSON.stringify(before) !== JSON.stringify(countries)) notifyCountryChange(before, undefined, groupsBefore);
    dialog.close();
  });
})();
