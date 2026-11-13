(() => {
  const storageKey = 'mapdesigner.settings.v1';
  const defaults = window.MapSettingsDefaults;
  const bridge = window.mapFiles;
  const preview = ['http:', 'https:'].includes(location.protocol);
  const form = document.getElementById('settings-form');
  const status = document.getElementById('settings-status');
  const fonts = defaults.fonts;
  const actions = { undo: ['撤销', 'undo-map'], save: ['保存地图', 'save-map'], erase: ['擦除', 'erase-map'], names: ['显示名称', 'toggle-names'], boundaries: ['切换边界显示', 'toggle-boundaries'], country: ['创建国家', 'create-country'], zoomIn: ['放大 5%', 'zoom-in'], zoomOut: ['缩小 5%', 'zoom-out'], scrollUp: ['向上滚动'], scrollDown: ['向下滚动'], scrollLeft: ['向左滚动'], scrollRight: ['向右滚动'] };
  function localPaths() {
    if (location.protocol !== 'file:') return { snapshot: '', png: '' };
    const folder = relative => {
      const url = new URL(relative, document.baseURI), path = decodeURIComponent(url.pathname);
      return url.hostname ? '\\\\' + url.hostname + path.replace(/\//g, '\\') : /^\/[a-z]:\//i.test(path) ? path.slice(1).replace(/\//g, '\\') : path;
    };
    return { snapshot: folder('saves/snapshots'), png: folder('saves/png') };
  }
  let factory = { files: localPaths(), shortcuts: { ...defaults.shortcuts }, operations: { ...defaults.operations }, appearance: { ...defaults.appearance } };
  let state = JSON.parse(JSON.stringify(factory));
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey));
    if (stored) state = validate(stored);
  } catch {}
  function combination(event) {
    return (event.ctrlKey || event.metaKey ? 'Ctrl+' : '') + (event.altKey ? 'Alt+' : '') + (event.shiftKey ? 'Shift+' : '') + event.code;
  }
  function keyLabel(binding) {
    return binding.replace(/Key([A-Z])/g, '$1').replace(/Digit([0-9])/g, '$1').replace('Equal', '=').replace('Minus', '−').replace('Space', '空格').replace('ArrowUp', '↑').replace('ArrowDown', '↓').replace('ArrowLeft', '←').replace('ArrowRight', '→').replace(/\+/g, ' + ');
  }
  function validate(value) {
    const copy = defaults.upgrade(JSON.parse(JSON.stringify(value)));
    if (!copy.files || !['snapshot', 'png'].every(k => typeof copy.files[k] === 'string' && /^(?:[a-z]:[\\/]|\\\\|\/)/i.test(copy.files[k].trim()) && !/[<>"|?*\x00-\x1f]/.test(copy.files[k]))) throw new Error('请填写完整、有效的保存文件夹路径。');
    for (const k of ['snapshot', 'png']) copy.files[k] = copy.files[k].trim();
    const used = new Set();
    for (const key of Object.keys(defaults.shortcuts)) {
      const binding = copy.shortcuts?.[key];
      if (binding === '') continue;
      if (typeof binding !== 'string' || !/^(Ctrl\+)?(Alt\+)?(Shift\+)?(Key[A-Z]|Digit[0-9]|F[1-9]|F1[0-2]|Equal|Minus|Arrow(Up|Down|Left|Right)|Space|Delete|Backspace)$/.test(binding)) throw new Error('请使用字母、数字、方向键或它们与 Ctrl、Alt、Shift 的组合。');
      if (used.has(binding)) throw new Error('快捷键不能重复，请重新设置。');
      if (['Ctrl+KeyR','Ctrl+KeyW','Ctrl+KeyT','Ctrl+KeyN','Ctrl+Shift+KeyN','Ctrl+Shift+KeyT','Ctrl+KeyL','Alt+F4','F5','F11','F12'].includes(binding)) throw new Error('该组合是系统或浏览器保留快捷键，请换一个。');
      used.add(binding);
    }
    if (!['system','light','dark'].includes(copy.appearance?.theme) || !Object.hasOwn(fonts, copy.appearance?.font)) throw new Error('外观设置无效。');
    if (!['zoom','scroll'].includes(copy.operations?.wheelMode)) throw new Error('滚轮功能设置无效。');
    return copy;
  }
  const media = matchMedia('(prefers-color-scheme: dark)');
  let appearancePreview = null;
  function applyAppearance() {
    const appearance = appearancePreview || state.appearance;
    document.documentElement.dataset.theme = appearance.theme === 'system' ? media.matches ? 'dark' : 'light' : appearance.theme;
    document.documentElement.style.setProperty('--app-font', fonts[appearance.font]);
  }
  applyAppearance(); media.addEventListener('change', applyAppearance);
  const recordDialog = document.getElementById('shortcut-dialog');
  let recording = null;
  const editIcon = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const deleteIcon = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function setBinding(input, binding) { input.dataset.binding = binding; input.value = keyLabel(binding); }
  for (const [key, [label]] of Object.entries(actions)) {
    const row = document.createElement('div'); row.className = 'shortcut-row';
    const name = document.createElement('label'); name.textContent = label; name.htmlFor = `shortcut-${key}`;
    const controls = document.createElement('div'); controls.className = 'shortcut-controls';
    const input = document.createElement('input'); input.id = `shortcut-${key}`; input.readOnly = true; input.tabIndex = -1; input.dataset.action = key; input.autocomplete = 'off'; input.placeholder = '未设置';
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'map-tool-button shortcut-icon'; edit.dataset.editShortcut = key;
    edit.setAttribute('aria-label', `修改${label}快捷键`); edit.title = '修改'; edit.innerHTML = editIcon;
    edit.addEventListener('click', () => {
      recording = key; document.getElementById('shortcut-dialog-title').textContent = `修改${label}快捷键`;
      document.getElementById('shortcut-record-error').textContent = '';
      recordDialog.showModal(); document.getElementById('shortcut-prompt').focus();
    });
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'map-tool-button shortcut-icon'; remove.dataset.deleteShortcut = key;
    remove.setAttribute('aria-label', `删除${label}快捷键`); remove.title = '删除'; remove.innerHTML = deleteIcon;
    remove.addEventListener('click', () => { setBinding(input, ''); status.textContent = '快捷键已清空，保存后生效。'; });
    controls.append(input, edit, remove); row.append(name, controls); document.getElementById('shortcut-fields').append(row);
  }
  document.getElementById('cancel-shortcut').addEventListener('click', () => recordDialog.close());
  recordDialog.addEventListener('close', () => { recording = null; });
  recordDialog.addEventListener('keydown', event => {
    if (event.key === 'Tab') return;
    if (event.key === 'Escape') { recordDialog.close(); event.preventDefault(); return; }
    event.preventDefault(); event.stopPropagation();
    if (event.repeat || event.isComposing || ['Control','Shift','Alt','Meta'].includes(event.key)) return;
    const binding = combination(event), inputs = [...document.querySelectorAll('[data-action]')];
    try {
      const shortcuts = Object.fromEntries(inputs.map(input => [input.dataset.action, input.dataset.action === recording ? binding : input.dataset.binding]));
      validate({ ...state, shortcuts });
      setBinding(document.getElementById(`shortcut-${recording}`), binding);
      recordDialog.close(); status.textContent = '快捷键已修改，保存后生效。';
    } catch (error) { document.getElementById('shortcut-record-error').textContent = error.message; }
  });
  function activeCategory() { return document.querySelector('.settings-tabs [aria-selected="true"]').id.replace('tab-', ''); }
  function fillCategory(category, value = state) {
    if (category === 'files') for (const kind of ['snapshot','png']) document.getElementById(`settings-${kind}`).value = value.files[kind];
    if (category === 'operations') {
      for (const input of document.querySelectorAll('[data-action]')) setBinding(input, value.shortcuts[input.dataset.action]);
      document.getElementById('settings-wheel').value = value.operations.wheelMode;
    }
    if (category === 'appearance') {
      document.getElementById('settings-theme').value = value.appearance.theme;
      document.getElementById('settings-font').value = value.appearance.font;
      updateFontPreview();
    }
  }
  function fillForm() { for (const category of ['files','operations','appearance']) fillCategory(category); }
  function updateFontPreview() { document.querySelector('.settings-preview').style.fontFamily = fonts[document.getElementById('settings-font').value]; }
  function previewAppearance() {
    appearancePreview = { theme: document.getElementById('settings-theme').value, font: document.getElementById('settings-font').value };
    updateFontPreview(); applyAppearance();
  }
  for (const id of ['settings-theme','settings-font']) document.getElementById(id).addEventListener('change', previewAppearance);
  document.getElementById('settings-file-help').textContent = !bridge && !preview ? '直接打开本地页面时，选择文件夹会请求浏览器授权。使用桌面版可直接填写完整路径。' : '可以输入完整路径，也可以点击“选择…”；保存设置时会创建文件夹。';
  async function request(method, value) {
    const response = await fetch('/api/settings', value === undefined ? undefined : { method, headers: { 'Content-Type': 'application/json', 'X-MapDesigner-Request': '1' }, body: JSON.stringify(value) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '无法读取设置。');
    return result;
  }
  let folderHandles = {};
  for (const button of document.querySelectorAll('[data-choose-path]')) button.addEventListener('click', async () => {
    const kind = button.dataset.choosePath, input = document.getElementById(`settings-${kind}`);
    button.disabled = true;
    try {
      let chosen;
      if (bridge) chosen = await bridge.chooseDirectory(input.value);
      else if (preview) {
        const response = await fetch('/api/directory', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MapDesigner-Request': '1' }, body: JSON.stringify({ initial: input.value }) });
        const result = await response.json(); if (!response.ok) throw new Error(result.error); chosen = result.directory;
      } else {
        if (!window.showDirectoryPicker) throw new Error('请使用桌面版选择文件夹。');
        const handle = await window.showDirectoryPicker({ id: `mapdesigner-${kind}`, mode: 'readwrite' });
        folderHandles[kind] = handle;
        const old = input.value.replace(/[\\/]+$/, '');
        chosen = old.split(/[\\/]/).pop() === handle.name ? old : old.slice(0, Math.max(old.lastIndexOf('\\'), old.lastIndexOf('/')) + 1) + handle.name;
        status.textContent = '浏览器无法读取文件夹完整路径，请核对或修改路径后保存。';
      }
      if (chosen) input.value = chosen;
    } catch (error) { if (error.name !== 'AbortError') status.textContent = error.message; }
    finally { button.disabled = false; }
  });
  document.getElementById('reset-settings').addEventListener('click', () => saveCategory(true));
  const tabs = [...document.querySelectorAll('.settings-tabs [role="tab"]')];
  function activateTab(tab) {
    if (activeCategory() === 'appearance' && tab.id !== 'tab-appearance') {
      appearancePreview = null; applyAppearance(); fillCategory('appearance');
    }
    for (const item of tabs) { const active = item === tab; item.setAttribute('aria-selected', String(active)); item.tabIndex = active ? 0 : -1; document.getElementById(item.getAttribute('aria-controls')).hidden = !active; }
    form.hidden = tab.id === 'tab-ai';
    window.dispatchEvent(new Event(form.hidden ? 'ai-settings-open' : 'ai-settings-close'));
  }
  for (const tab of tabs) {
    tab.addEventListener('click', () => activateTab(tab));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault(); const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      activateTab(tabs[index]); tabs[index].focus();
    });
  }
  document.getElementById('open-settings').addEventListener('click', () => { location.hash = 'settings'; });
  form.noValidate = true;
  let saving = false;
  async function saveCategory(reset = false) {
    if (saving) return;
    saving = true;
    const save = document.getElementById('save-settings'), resetButton = document.getElementById('reset-settings');
    save.disabled = resetButton.disabled = true;
    const category = activeCategory();
    try {
      await ready;
      if (reset) {
        fillCategory(category, factory);
        if (category === 'appearance') previewAppearance();
        if (category === 'files') folderHandles = {};
      }
      let next = JSON.parse(JSON.stringify(state));
      if (category === 'files') next.files = { snapshot: document.getElementById('settings-snapshot').value, png: document.getElementById('settings-png').value };
      if (category === 'operations') {
        next.shortcuts = Object.fromEntries([...document.querySelectorAll('[data-action]')].map(input => [input.dataset.action, input.dataset.binding]));
        next.operations = { wheelMode: document.getElementById('settings-wheel').value };
      }
      if (category === 'appearance') next.appearance = { theme: document.getElementById('settings-theme').value, font: document.getElementById('settings-font').value };
      next = validate(next);
      if (bridge) next = await bridge.saveSettings(next);
      else if (preview) next = await request('POST', next);
      else localStorage.setItem(storageKey, JSON.stringify(next));
      const previous = state; state = next;
      try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch {}
      if (category === 'appearance') appearancePreview = null;
      applyAppearance(); fillCategory(category);
      window.dispatchEvent(new CustomEvent('settings-changed', { detail: { previous, current: JSON.parse(JSON.stringify(state)), folderHandles: category === 'files' ? folderHandles : {} } }));
      if (category === 'files') folderHandles = {};
      status.textContent = reset ? '当前分类已恢复默认设置并保存。' : '设置已保存。';
    } catch (error) { status.textContent = `保存失败：${error.message}`; }
    finally { saving = false; save.disabled = resetButton.disabled = false; }
  }
  form.addEventListener('submit', event => { event.preventDefault(); saveCategory(); });
  fillForm();
  const ready = (async () => {
    try {
      if (bridge) {
        const results = await Promise.all([bridge.getSettings(), bridge.getDefaultSettings()]);
        state = validate(results[0]); factory = validate(results[1]);
      } else if (preview) {
        const response = await fetch('/api/settings-defaults');
        if (!response.ok) throw new Error('默认设置读取失败。');
        factory = validate(await response.json()); state = validate(await request('GET'));
      }
      applyAppearance(); fillForm();
    } catch (error) { status.textContent = `设置服务未就绪：${error.message}。请重启程序或预览服务。`; }
  })();
  window.AppSettings = { ready, get: () => JSON.parse(JSON.stringify(state)), folderHandle: kind => folderHandles[kind] || null };
  let inSettings = location.hash === '#settings';
  window.addEventListener('hashchange', () => {
    const next = location.hash === '#settings';
    if (inSettings && !next) {
      appearancePreview = null; applyAppearance(); fillForm(); folderHandles = {}; status.textContent = '';
      if (recordDialog.open) recordDialog.close();
    }
    inSettings = next;
  });
  window.addEventListener('keydown', event => {
    if (event.isComposing || window.CountryCapitals?.selected() || document.getElementById('map').hidden || document.querySelector('dialog[open]') || event.target.closest?.('input,textarea,select,[contenteditable="true"]')) return;
    const action = Object.keys(actions).find(key => state.shortcuts[key] && state.shortcuts[key] === combination(event));
    if (!action) {
      if (/^Arrow(Up|Down|Left|Right)$/.test(event.code)) event.preventDefault();
      return;
    }
    if (event.repeat && !action.startsWith('scroll')) return;
    event.preventDefault();
    if (action.startsWith('scroll')) {
      const offsets = { scrollUp: [0, -120], scrollDown: [0, 120], scrollLeft: [-120, 0], scrollRight: [120, 0] };
      const [left, top] = offsets[action]; document.getElementById('map-viewport').scrollBy({ left, top, behavior: 'instant' });
    } else {
      const button = document.getElementById(actions[action][1]);
      if (!button.disabled) {
        if (action === 'boundaries') { const modes=['plots','countries','hidden']; button.value=modes[(modes.indexOf(button.value)+1)%modes.length]; button.dispatchEvent(new Event('change')); }
        else button.click();
      }
    }
  });
  document.getElementById('map-viewport').addEventListener('wheel', event => {
    if (document.getElementById('map').hidden || document.querySelector('dialog[open]') || state.operations.wheelMode === 'scroll' || !event.deltaY) return;
    event.preventDefault();
    const view = document.getElementById('map-viewport'), image = document.getElementById('basemap');
    if (!image.naturalWidth) return;
    const bounds = image.getBoundingClientRect(), x = (event.clientX - bounds.left) / bounds.width, y = (event.clientY - bounds.top) / bounds.height;
    setZoom(Number(document.getElementById('map-zoom').value) + (event.deltaY < 0 ? 50 : -50));
    const next = image.getBoundingClientRect();
    view.scrollLeft += next.left + x * next.width - event.clientX;
    view.scrollTop += next.top + y * next.height - event.clientY;
  }, { passive: false });
})();
