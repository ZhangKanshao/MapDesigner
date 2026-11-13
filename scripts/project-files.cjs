const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');

function defaults() {
  return require('./global-settings.cjs').read().files;
}
async function saveFile(request) {
  if (!request || !['snapshot', 'png'].includes(request.type)) throw new Error('未知的保存格式。');
  const name = typeof request.name === 'string' ? request.name.trim() : '';
  if (!name || name.length > 160 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('名称包含无效字符，请修改。');
  if (typeof request.directory !== 'string' || !path.isAbsolute(request.directory)) throw new Error('请填写完整的保存文件夹路径。');
  const extension = request.type === 'snapshot' && request.extension === '.json' ? '.json' : request.type === 'snapshot' ? '.mapdesign' : '.png';
  const fileName = name.toLowerCase().endsWith(extension) ? name : name + extension;
  const directory = path.resolve(request.directory);
  const target = path.join(directory, fileName);
  let bytes;
  if (request.type === 'snapshot') {
    if (typeof request.text !== 'string' || Buffer.byteLength(request.text) > 16 * 1024 * 1024) throw new Error('快照文件过大。');
    const snapshot = JSON.parse(request.text.replace(/^\uFEFF/, ''));
    if (snapshot.format !== 'MapDesignerSnapshot' || snapshot.formatVersion !== 1) throw new Error('快照格式无效。');
    bytes = Buffer.from(request.text, 'utf8');
  } else {
    if (typeof request.base64 !== 'string' || request.base64.length > 90 * 1024 * 1024) throw new Error('图片数据无效或过大。');
    bytes = Buffer.from(request.base64, 'base64');
    if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('PNG 图片数据无效。');
  }
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.access(target);
    if (!request.overwrite) return { exists: true, path: target };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(directory, `.${fileName}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx' });
    if (request.overwrite) await fs.rename(temporary, target);
    else {
      try { await fs.copyFile(temporary, target, require('node:fs').constants.COPYFILE_EXCL); }
      catch (error) { if (error.code === 'EEXIST') return { exists: true, path: target }; throw error; }
    }
    return { saved: true, path: target };
  } finally { await fs.unlink(temporary).catch(() => {}); }
}
async function listSnapshots() {
  const directory = defaults().snapshot;
  await fs.mkdir(directory, { recursive: true });
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.filter(entry => entry.isFile() && /\.(mapdesign|json)$/i.test(entry.name)).map(async entry => {
    const stat = await fs.stat(path.join(directory, entry.name));
    return { name: entry.name, modifiedAt: stat.mtime.toISOString(), size: stat.size };
  }));
  files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.name.localeCompare(b.name));
  return { directory, files };
}
async function readSnapshot(name) {
  if (typeof name !== 'string' || path.basename(name) !== name || !/\.(mapdesign|json)$/i.test(name)) throw new Error('快照文件名无效。');
  const directory = await fs.realpath(defaults().snapshot);
  const target = await fs.realpath(path.join(directory, name));
  if (path.dirname(target).toLowerCase() !== directory.toLowerCase()) throw new Error('只能加载默认文件夹中的快照。');
  const stat = await fs.stat(target);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('快照文件无效或过大。');
  return { text: await fs.readFile(target, 'utf8'), path: target };
}
async function importSnapshot(request) {
  if (!request || typeof request.name !== 'string') throw new Error('快照文件名无效。');
  const name = path.basename(request.name).replace(/\.(mapdesign|json)$/i, '');
  for (let i = 1; i <= 10000; i++) {
    const result = await saveFile({ type: 'snapshot', name: i === 1 ? name : `${name} (${i})`, directory: defaults().snapshot, text: request.text });
    if (result.saved) return result;
  }
  throw new Error('同名快照过多，请重命名后导入。');
}
async function deleteSnapshot(name) {
  if (typeof name !== 'string' || path.basename(name) !== name || !/\.(mapdesign|json)$/i.test(name)) throw new Error('快照文件名无效。');
  const directory=await fs.realpath(defaults().snapshot),target=path.join(directory,name);
  const stat=await fs.lstat(target);
  if(!stat.isFile()||stat.isSymbolicLink())throw new Error('只能删除默认文件夹中的快照文件。');
  const resolved=await fs.realpath(target);
  if(path.dirname(resolved).toLowerCase()!==directory.toLowerCase())throw new Error('只能删除默认文件夹中的快照。');
  await fs.unlink(target);return{deleted:true,name};
}
async function renameSnapshot({name,newName}={}) {
  if(typeof name!=='string'||path.basename(name)!==name||! /\.(mapdesign|json)$/i.test(name))throw new Error('快照文件名无效。');
  const stem=typeof newName==='string'?newName.trim():'';
  if(!stem||stem.length>160||/[<>:"/\\|?*\x00-\x1f]/.test(stem)||/[. ]$/.test(stem)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem))throw new Error('名称包含无效字符，请修改。');
  const filename=stem+path.extname(name),directory=await fs.realpath(defaults().snapshot),source=path.join(directory,name),target=path.join(directory,filename);
  const stat=await fs.lstat(source);
  if(!stat.isFile()||stat.isSymbolicLink()||path.dirname(await fs.realpath(source)).toLowerCase()!==directory.toLowerCase())throw new Error('只能重命名默认文件夹中的快照文件。');
  if(filename===name)return{renamed:true,name:filename};
  try{await fs.copyFile(source,target,require('node:fs').constants.COPYFILE_EXCL);}
  catch(error){if(error.code==='EEXIST')throw new Error('同名快照已存在，请换一个名称。');throw error;}
  try{await fs.unlink(source);}catch(error){await fs.unlink(target).catch(()=>{});throw error;}
  return{renamed:true,name:filename};
}
module.exports = { defaults, saveFile, listSnapshots, readSnapshot, importSnapshot, deleteSnapshot, renameSnapshot };
