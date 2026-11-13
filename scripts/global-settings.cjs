const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const defaults = require('../src/settings-defaults.js');
const root = path.resolve(__dirname, '..');
const config = process.env.MAPDESIGNER_SETTINGS_FILE || path.join(root, 'saves', 'settings.json');
function initial() { return { files: { snapshot: path.join(root, 'saves', 'snapshots'), png: path.join(root, 'saves', 'png') }, shortcuts: { ...defaults.shortcuts }, operations: { ...defaults.operations }, appearance: { ...defaults.appearance } }; }
function validate(value) {
  const result = initial();
  if (!value || typeof value !== 'object') throw new Error('设置数据无效。');
  for (const kind of ['snapshot', 'png']) {
    const folder = value.files?.[kind];
    if (typeof folder !== 'string' || !path.isAbsolute(folder.trim()) || /[<>"|?*\x00-\x1f]/.test(folder)) throw new Error('请填写完整、有效的保存文件夹路径。');
    result.files[kind] = path.resolve(folder.trim());
  }
  value = defaults.upgrade(value);
  const used = new Set();
  for (const key of Object.keys(defaults.shortcuts)) {
    const binding = value.shortcuts?.[key];
    if (binding === '') { result.shortcuts[key] = ''; continue; }
    if (typeof binding !== 'string' || !/^(Ctrl\+)?(Alt\+)?(Shift\+)?(Key[A-Z]|Digit[0-9]|F[1-9]|F1[0-2]|Equal|Minus|Arrow(Up|Down|Left|Right)|Space|Delete|Backspace)$/.test(binding)) throw new Error('快捷键无效。');
    if (used.has(binding)) throw new Error('快捷键不能重复。');
    if (['Ctrl+KeyR','Ctrl+KeyW','Ctrl+KeyT','Ctrl+KeyN','Ctrl+Shift+KeyN','Ctrl+Shift+KeyT','Ctrl+KeyL','Alt+F4','F5','F11','F12'].includes(binding)) throw new Error('该组合是系统或浏览器保留快捷键。');
    used.add(binding); result.shortcuts[key] = binding;
  }
  if (!['system', 'light', 'dark'].includes(value.appearance?.theme) || !Object.hasOwn(defaults.fonts, value.appearance?.font)) throw new Error('外观设置无效。');
  if (!['zoom', 'scroll'].includes(value.operations?.wheelMode)) throw new Error('滚轮功能设置无效。');
  result.operations = { wheelMode: value.operations.wheelMode };
  result.appearance = { theme: value.appearance.theme, font: value.appearance.font };
  return result;
}
function read() {
  try { return validate(JSON.parse(fs.readFileSync(config, 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') console.warn('无法读取设置，使用默认设置。'); return initial(); }
}
async function save(value) {
  const result = validate(value);
  // Create both destinations before committing, so an unusable path does not become the default.
  for (const folder of Object.values(result.files)) await fsp.mkdir(folder, { recursive: true });
  await fsp.mkdir(path.dirname(config), { recursive: true });
  const temporary = config + '.' + crypto.randomUUID() + '.tmp';
  try { await fsp.writeFile(temporary, JSON.stringify(result, null, 2)); await fsp.rename(temporary, config); }
  finally { await fsp.unlink(temporary).catch(() => {}); }
  return result;
}
module.exports = { read, save, validate, initial };
