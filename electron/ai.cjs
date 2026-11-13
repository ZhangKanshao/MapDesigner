const { app, ipcMain, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validate: validateMessages, defaultPrompt, mapContextLimit, customPromptLimit } = require('../src/ai-messages.js');

function endpointFor(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error('请填写有效的 API 地址。'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('API 地址须使用 HTTPS。本机服务可使用 HTTP。');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('请将密钥填入单独的输入框，API 地址无需查询参数或片段。');
  url.pathname = url.pathname.replace(/\/+$/, '') || '/v1';
  if (!url.pathname.endsWith('/chat/completions')) url.pathname += '/chat/completions';
  return url.href;
}

function textField(value, limit, label, optional = false) {
  const text = typeof value === 'string' ? value.trim() : '';
  if ((!text && !optional) || text.length > limit || /[\x00-\x1f\x7f]/.test(text)) throw new Error(`${label}格式无效。`);
  return text;
}

function publicConfig(config) {
  return {
    activeId: config.activeId,
    profiles: config.profiles.map(({ id, name, endpoint, model, key }) => ({ id, name, endpoint, model, hasKey: Boolean(key) }))
  };
}

function register() {
  const file = path.join(app.getPath('userData'), 'ai-connections.bin');
  let changes = Promise.resolve();

  async function read() {
    let encrypted;
    try { encrypted = await fs.readFile(file); }
    catch (error) {
      if (error.code === 'ENOENT') return { activeId: null, profiles: [] };
      throw new Error('无法读取本机 AI 配置。');
    }
    try { return JSON.parse(safeStorage.decryptString(encrypted)); }
    catch { throw new Error('无法解密本机 AI 配置。请使用原来的系统账户。'); }
  }

  async function write(config) {
    if (!config.profiles.length) {
      try { await fs.unlink(file); }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('无法删除本机 AI 配置。'); }
      return;
    }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用，无法保存 AI 配置。');
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const encrypted = safeStorage.encryptString(JSON.stringify(config));
      await fs.writeFile(temp, encrypted, { flag: 'wx', mode: 0o600 });
      await fs.rename(temp, file);
    } catch {
      throw new Error('无法加密保存本机 AI 配置。');
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  }

  function update(change) {
    const operation = changes.then(async () => {
      const config = await read();
      change(config);
      await write(config);
      return publicConfig(config);
    });
    changes = operation.catch(() => {});
    return operation;
  }

  ipcMain.handle('ai:profiles', async () => { await changes; return publicConfig(await read()); });
  ipcMain.handle('ai:save-profile', (_event, draft) => update(config => {
    const current = config.profiles.find(profile => profile.id === draft?.id);
    if (draft?.id && !current) throw new Error('此配置已删除。');
    if (!current && config.profiles.length >= 50) throw new Error('最多可保存 50 个 AI 配置。');
    const name = textField(draft?.name, 80, '配置名称');
    if (config.profiles.some(profile => profile !== current && profile.name.toLowerCase() === name.toLowerCase())) throw new Error('配置名称已存在。');
    const endpoint = endpointFor(textField(draft?.endpoint, 2048, 'API 地址'));
    const key = textField(draft?.key, 4096, 'API 密钥', true);
    if (current?.key && !key && !draft?.clearKey && new URL(current.endpoint).origin !== new URL(endpoint).origin) {
      throw new Error('API 服务地址已变更，请填写新密钥，或勾选删除原密钥。');
    }
    const profile = {
      id: current?.id ?? randomUUID(),
      name,
      endpoint,
      model: textField(draft?.model, 160, '模型名称'),
      key: key || (draft?.clearKey ? '' : current?.key || '')
    };
    if (current) config.profiles[config.profiles.indexOf(current)] = profile;
    else config.profiles.push(profile);
    if (!current && config.profiles.length === 1) config.activeId = profile.id;
  }));
  ipcMain.handle('ai:activate-profile', (_event, id) => update(config => {
    if (!config.profiles.some(profile => profile.id === id)) throw new Error('此配置已删除。');
    config.activeId = id;
  }));
  ipcMain.handle('ai:delete-profile', (_event, id) => update(config => {
    config.profiles = config.profiles.filter(profile => profile.id !== id);
    if (config.activeId === id) config.activeId = null;
  }));
  ipcMain.handle('ai:chat', async (_event, request) => {
    const messages = validateMessages(request?.messages, true);
    const { mapContext, customPrompt = '' } = request;
    if (typeof mapContext !== 'string' || !mapContext || mapContext.length > mapContextLimit) throw new Error('地图上下文无效或过长。');
    if (typeof customPrompt !== 'string' || customPrompt.length > customPromptLimit) throw new Error('自定义提示词无效或过长。');
    await changes;
    const { activeId, profiles } = await read();
    const profile = profiles.find(item => item.id === activeId);
    if (!profile) throw new Error('请先在 AI 设置中选择要使用的配置。');
    if (request.profileId !== profile.id) throw new Error('当前 AI 配置已切换，请重新打开对话。');
    const instructions = customPrompt.trim() ? `${defaultPrompt}\n\n用户选用的提示词：\n${customPrompt}` : defaultPrompt;
    const outgoing = [
      { role: 'system', content: instructions },
      ...messages.slice(0, -1),
      { role: 'user', content: `当前地图资料（JSON）：\n${mapContext}\n\n用户问题：\n${messages.at(-1).content}` }
    ];
    return sendChat(profile, outgoing, messages);
  });
}

async function sendChat(profile, outgoing, messages) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (profile.key) headers.Authorization = `Bearer ${profile.key}`;
  const signal = AbortSignal.timeout(90000);
  let response;
  try {
    response = await fetch(profile.endpoint, {
      method: 'POST', headers, signal, redirect: 'error',
      body: JSON.stringify({ model: profile.model, messages: outgoing, stream: false })
    });
  } catch {
    throw new Error(signal.aborted ? 'AI 请求超时。' : '无法连接 AI 接口，请检查地址和网络。');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`AI 接口返回 HTTP ${response.status}。请检查配置、权限或服务额度。`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('AI 接口返回了空响应。');
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 2 * 1024 * 1024) throw new Error('AI 接口的响应过大。');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (signal.aborted) throw new Error('AI 请求超时。');
    if (length > 2 * 1024 * 1024) throw error;
    throw new Error('读取 AI 响应失败，请重试。');
  } finally { reader.releaseLock(); }
  let content;
  try { content = JSON.parse(Buffer.concat(chunks).toString('utf8')).choices?.[0]?.message?.content; }
  catch { throw new Error('AI 接口未返回有效的 Chat Completions 响应。'); }
  if (typeof content !== 'string' || !content.trim()) throw new Error('AI 接口未返回文本回复。');
  return validateMessages([...messages, { role: 'assistant', content }]).at(-1).content;
}

module.exports = { register };
