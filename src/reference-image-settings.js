(() => {
  const bridge = window.mapFiles;
  const panel = document.getElementById('settings-reference-images');
  const list = document.getElementById('reference-images-list');
  const folder = document.getElementById('reference-images-folder');
  const empty = document.getElementById('reference-images-empty');
  const status = document.getElementById('reference-images-status');
  const importButton = document.getElementById('import-reference-images');
  let busy = false;

  if (!bridge?.listReferenceImages) {
    importButton.hidden = true;
    status.textContent = '请在 MapDesigner 桌面版中管理参考图片。';
    return;
  }

  async function refresh() {
    const result = await bridge.listReferenceImages();
    folder.textContent = result.folder;
    folder.hidden = false;
    list.replaceChildren(...result.names.map(name => {
      const row = document.createElement('li');
      row.className = 'shortcut-row';
      const filename = document.createElement('span');
      filename.textContent = name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'map-tool-button';
      remove.textContent = '删除';
      remove.setAttribute('aria-label', `删除 ${name}`);
      remove.addEventListener('click', () => {
        if (busy || !window.confirm(`将「${name}」移到回收站？`)) return;
        update(async () => {
          await bridge.deleteReferenceImage(name);
          return '已移到回收站。';
        });
      });
      row.append(filename, remove);
      return row;
    }));
    empty.hidden = result.names.length > 0;
  }

  async function update(action) {
    if (busy) return;
    busy = true;
    importButton.disabled = true;
    for (const button of list.querySelectorAll('button')) button.disabled = true;
    status.textContent = '';
    try {
      const message = await action?.();
      await refresh();
      status.textContent = message || '';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = false;
      importButton.disabled = false;
      for (const button of list.querySelectorAll('button')) button.disabled = false;
    }
  }

  importButton.addEventListener('click', () => update(async () => {
    const { imported, failed } = await bridge.importReferenceImages();
    if (failed.length) return `已导入 ${imported} 张图片，以下文件未能导入：${failed.join('、')}`;
    return imported ? `已导入 ${imported} 张图片。` : '';
  }));
  window.addEventListener('reference-image-settings-open', () => update());
  window.addEventListener('hashchange', () => {
    if (location.hash === '#settings' && !panel.hidden) update();
  });
})();
