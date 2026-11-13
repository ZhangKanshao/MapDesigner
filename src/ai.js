(() => {
  const bridge = window.mapAI;
  const byId = id => document.getElementById(id);
  const profileForm = byId('ai-profile-form');
  const select = byId('ai-profile-select');
  const name = byId('ai-profile-name'), endpoint = byId('ai-profile-endpoint'), model = byId('ai-profile-model');
  const key = byId('ai-profile-key'), clearKey = byId('ai-clear-key');
  const use = byId('ai-use-profile'), remove = byId('ai-delete-profile'), profileStatus = byId('ai-profile-status');
  const dialog = byId('ai-chat-dialog');
  const openChat = byId('open-ai-chat');
  const history = byId('ai-chat-history'), chatStatus = byId('ai-chat-status'), chatModel = byId('ai-chat-model');
  const input = byId('ai-chat-input'), send = byId('send-ai-chat');
  const storageKey = `mapdesigner.${window.MapTemplate.key}.ai-chat.v1`;
  let config = { activeId: null, profiles: [] };
  let messages = [], pending = null, editing = false, connecting = false, projectLoads = 0;
  const activeProfile = () => config.profiles.find(profile => profile.id === config.activeId);
  const selectedProfile = () => config.profiles.find(profile => profile.id === select.value);
  const errorText = error => error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');

  try { messages = AIMessages.validate(JSON.parse(localStorage.getItem(storageKey) || '[]')); } catch {}

  function updateProfileControls() {
    for (const control of profileForm.elements) control.disabled = editing || !bridge;
    const selected = selectedProfile();
    use.disabled = editing || !bridge || !selected || selected.id === config.activeId;
    remove.disabled = editing || !bridge || !selected;
  }
  function showProfile() {
    const profile = selectedProfile();
    name.value = profile?.name || '';
    endpoint.value = profile?.endpoint || '';
    model.value = profile?.model || '';
    key.value = '';
    key.placeholder = profile?.hasKey ? '已保存。留空保留原密钥' : '接口无需密钥时可留空';
    clearKey.checked = false;
    byId('ai-clear-key-row').hidden = !profile?.hasKey;
    updateProfileControls();
  }
  function showProfiles(preferred = config.activeId) {
    select.replaceChildren(new Option('新建配置', ''), ...config.profiles.map(profile =>
      new Option(profile.name + (profile.id === config.activeId ? '（当前使用）' : ''), profile.id)));
    select.value = config.profiles.some(profile => profile.id === preferred) ? preferred : '';
    showProfile();
  }
  async function updateProfiles(action, message, preferred) {
    if (editing || !bridge) return;
    editing = true;
    updateProfileControls();
    profileStatus.textContent = '';
    try {
      config = await action();
      showProfiles(typeof preferred === 'function' ? preferred(config) : preferred);
      profileStatus.textContent = message;
    } catch (error) { profileStatus.textContent = errorText(error); }
    finally { editing = false; updateProfileControls(); }
  }

  select.addEventListener('change', () => { showProfile(); profileStatus.textContent = ''; });
  window.addEventListener('ai-settings-open', () => updateProfiles(() => bridge.profiles(), '', select.value || undefined));
  window.addEventListener('ai-settings-close', () => { key.value = ''; });
  window.addEventListener('hashchange', () => { if (location.hash !== '#settings') key.value = ''; });
  profileForm.addEventListener('submit', event => {
    event.preventDefault();
    const draft = { id: select.value, name: name.value, endpoint: endpoint.value, model: model.value, key: key.value, clearKey: clearKey.checked };
    updateProfiles(() => bridge.saveProfile(draft), '配置已保存。', saved => draft.id || saved.profiles.at(-1).id);
  });
  use.addEventListener('click', () => {
    const id = select.value;
    updateProfiles(() => bridge.activateProfile(id), '已设为当前使用。', id);
  });
  remove.addEventListener('click', () => {
    const profile = selectedProfile();
    if (!profile || !window.confirm(`删除「${profile.name}」及其本机密钥？`)) return;
    updateProfiles(() => bridge.deleteProfile(profile.id), '配置及密钥已从本机删除。');
  });
  if (!bridge) byId('ai-settings-help').textContent = '请在 MapDesigner 桌面版中配置和连接 AI。';
  showProfiles();

  function updateChatControls() {
    const profile = activeProfile();
    input.disabled = send.disabled = !bridge || !profile || connecting || Boolean(pending) || projectLoads > 0;
    chatModel.textContent = !bridge ? '请在 MapDesigner 桌面版中发送消息。'
      : connecting ? '正在读取 AI 配置…'
      : profile ? `${profile.name} · ${profile.model}` : '请先在首页的 AI 设置中选择连接配置。';
  }
  function renderHistory() {
    const displayed = pending ? [...messages, pending] : messages;
    history.replaceChildren();
    if (!displayed.length) {
      const empty = document.createElement('p');
      empty.className = 'settings-help';
      empty.textContent = '这张地图还没有对话。';
      history.append(empty);
    }
    for (const message of displayed) {
      const bubble = document.createElement('article');
      bubble.className = `ai-message ai-message-${message.role}`;
      const author = document.createElement('strong'), content = document.createElement('p');
      author.textContent = message.role === 'user' ? '你' : 'AI';
      content.textContent = message.content;
      bubble.append(author, content);
      history.append(bubble);
    }
    history.scrollTop = history.scrollHeight;
  }
  function persist() {
    try { localStorage.setItem(storageKey, JSON.stringify(messages)); } catch {}
  }
  window.AIChat = {
    capture: () => messages.map(message => ({ ...message })),
    lockProject: () => {
      projectLoads++;
      openChat.disabled = true;
      if (dialog.open) dialog.close();
      return () => { openChat.disabled = --projectLoads > 0; updateChatControls(); };
    },
    restore: value => {
      messages = AIMessages.validate(value);
      pending = null;
      input.value = '';
      chatStatus.textContent = '';
      persist();
      renderHistory();
      updateChatControls();
    }
  };

  openChat.addEventListener('click', async () => {
    stopMapDrag();
    dialog.showModal();
    renderHistory();
    connecting = Boolean(bridge);
    updateChatControls();
    if (!bridge) return;
    try { config = await bridge.profiles(); }
    catch (error) {
      config = { activeId: null, profiles: [] };
      chatStatus.textContent = errorText(error);
    }
    finally {
      connecting = false;
      updateChatControls();
      if (dialog.open && !input.disabled) input.focus();
    }
  });
  byId('close-ai-chat').addEventListener('click', () => dialog.close());
  byId('reset-ai-chat').addEventListener('click', () => {
    window.AIChat.restore([]);
    chatStatus.textContent = '对话已重置。';
    if (!input.disabled) input.focus();
  });
  byId('ai-chat-form').addEventListener('submit', async event => {
    event.preventDefault();
    const profile = activeProfile(), content = input.value.trim();
    if (!bridge || !profile || connecting || pending || projectLoads || !content) return;
    const outgoing = { role: 'user', content };
    pending = outgoing;
    chatStatus.textContent = '正在整理地图资料…';
    renderHistory();
    updateChatControls();
    try {
      const request = AIMessages.validate([...messages, outgoing], true);
      const customPrompt = window.AIPrompts.content();
      const mapContext = await window.AIMapContext.build(request);
      if (pending !== outgoing || projectLoads) return;
      chatStatus.textContent = '等待回复…';
      const reply = await bridge.chat({ profileId: profile.id, messages: request, mapContext, customPrompt });
      if (pending !== outgoing) return;
      messages = AIMessages.validate([...request, { role: 'assistant', content: reply }]);
      persist();
      input.value = '';
      chatStatus.textContent = '';
    } catch (error) {
      if (pending === outgoing) chatStatus.textContent = errorText(error);
    } finally {
      if (pending === outgoing) {
        pending = null;
        renderHistory();
        updateChatControls();
        if (dialog.open) input.focus();
      }
    }
  });
})();
