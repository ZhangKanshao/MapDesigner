(() => {
  const libraryKey = 'mapdesigner.ai-prompts.v1';
  const selectionKey = `mapdesigner.${window.MapTemplate.key}.ai-prompt.v1`;
  const validId = id => typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id);
  const select = document.getElementById('ai-prompt-select');
  const dialog = document.getElementById('ai-prompts-dialog');
  const editor = document.getElementById('ai-prompt-edit-select');
  const name = document.getElementById('ai-prompt-name'), content = document.getElementById('ai-prompt-content');
  const status = document.getElementById('ai-prompt-status'), remove = document.getElementById('delete-ai-prompt');
  let library = [], selectedId = '';
  try {
    const saved = JSON.parse(localStorage.getItem(libraryKey) || '[]');
    if (Array.isArray(saved)) library = saved.filter(item => validId(item?.id) && typeof item.name === 'string' && typeof item.content === 'string' && item.content.length <= AIMessages.customPromptLimit);
    selectedId = localStorage.getItem(selectionKey) || '';
  } catch {}

  function validateSelection(id) {
    if (id === undefined || id === null || id === '') return '';
    if (!validId(id)) throw new Error('快照中的提示词选择无效。');
    return id;
  }
  function restore(id) {
    selectedId = library.some(item => item.id === id) ? id : '';
    select.value = selectedId;
    try { localStorage.setItem(selectionKey, selectedId); } catch {}
  }
  function showEditor() {
    const item = library.find(prompt => prompt.id === editor.value);
    name.value = item?.name || '';
    content.value = item?.content || '';
    remove.disabled = !item;
  }
  function refresh(preferred = '') {
    select.replaceChildren(new Option('默认地图约束', ''), ...library.map(item => new Option(item.name, item.id)));
    editor.replaceChildren(new Option('新建提示词', ''), ...library.map(item => new Option(item.name, item.id)));
    editor.value = preferred;
    restore(selectedId);
    showEditor();
  }
  function saveLibrary(next) {
    try { localStorage.setItem(libraryKey, JSON.stringify(next)); }
    catch { status.textContent = '无法保存到本机，请检查存储空间。'; return false; }
    library = next;
    return true;
  }

  document.getElementById('ai-default-prompt').textContent = AIMessages.defaultPrompt;
  document.getElementById('open-ai-prompts').addEventListener('click', () => {
    refresh(selectedId);
    status.textContent = '';
    dialog.showModal();
  });
  document.getElementById('close-ai-prompts').addEventListener('click', () => dialog.close());
  select.addEventListener('change', () => restore(select.value));
  editor.addEventListener('change', () => { status.textContent = ''; showEditor(); });
  document.getElementById('ai-prompt-form').addEventListener('submit', event => {
    event.preventDefault();
    const title = name.value.trim(), text = content.value.trim();
    if (!title || !text || title.length > 80 || text.length > AIMessages.customPromptLimit) { status.textContent = '请填写有效的名称和提示词。'; return; }
    if (library.some(item => item.id !== editor.value && item.name.normalize('NFKC').toLowerCase() === title.normalize('NFKC').toLowerCase())) {
      status.textContent = '提示词名称已存在。';
      return;
    }
    const entry = { id: editor.value || crypto.randomUUID(), name: title, content: text };
    const next = editor.value ? library.map(item => item.id === entry.id ? entry : item) : [...library, entry];
    if (saveLibrary(next)) { refresh(entry.id); status.textContent = '提示词已保存。'; }
  });
  remove.addEventListener('click', () => {
    const item = library.find(prompt => prompt.id === editor.value);
    if (item && saveLibrary(library.filter(prompt => prompt.id !== item.id))) {
      refresh();
      status.textContent = '提示词已删除。';
    }
  });
  window.AIPrompts = { validateSelection, restore, capture: () => selectedId, content: () => library.find(item => item.id === selectedId)?.content || '' };
  refresh();
})();
