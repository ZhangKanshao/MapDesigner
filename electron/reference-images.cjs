const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { constants } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

const extensions = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'];
const filters = [{ name: '图片', extensions }];

function isImageName(name) {
  return typeof name === 'string' && !/[<>:"/\\|?*\x00-\x1f]/.test(name) &&
    extensions.includes(path.extname(name).slice(1).toLowerCase());
}

async function directory() {
  const root = app.isPackaged ? app.getPath('userData') : path.resolve(__dirname, '..');
  const folder = path.join(root, 'reference-images');
  await fs.mkdir(folder, { recursive: true });
  return folder;
}

async function chooseImages(event, title, folder, multiple = false) {
  const properties = multiple ? ['openFile', 'multiSelections'] : ['openFile'];
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title, defaultPath: folder, properties, filters,
  });
  return result.canceled ? [] : result.filePaths;
}

async function importImage(source, folder) {
  const name = path.basename(source);
  if (!isImageName(name)) throw new Error('图片格式不受支持。');
  const stat = await fs.stat(source);
  if (!stat.isFile() || !stat.size) throw new Error('图片文件无效。');
  const { name: stem, ext } = path.parse(name);
  for (let i = 1; i <= 10000; i++) {
    const target = i === 1 ? name : `${stem} (${i})${ext}`;
    try {
      await fs.copyFile(source, path.join(folder, target), constants.COPYFILE_EXCL);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('同名图片过多。');
}

function register() {
  ipcMain.handle('map-files:open-reference-image', async event => {
    const [selected] = await chooseImages(event, '打开参考图片', await directory());
    return selected ? fs.readFile(selected) : null;
  });
  ipcMain.handle('reference-images:list', async () => {
    const folder = await directory();
    const entries = await fs.readdir(folder, { withFileTypes: true });
    const names = entries.filter(entry => entry.isFile() && isImageName(entry.name)).map(entry => entry.name);
    return { folder, names: names.sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true })) };
  });
  ipcMain.handle('reference-images:import', async event => {
    const folder = await directory();
    const sources = await chooseImages(event, '导入参考图片', folder, true);
    let imported = 0;
    const failed = [];
    for (const source of sources) {
      try {
        await importImage(source, folder);
        imported++;
      } catch {
        failed.push(path.basename(source));
      }
    }
    return { imported, failed };
  });
  ipcMain.handle('reference-images:delete', async (_event, name) => {
    if (!isImageName(name)) throw new Error('图片文件名无效。');
    const folder = await fs.realpath(await directory());
    const target = path.join(folder, name);
    if (!(await fs.lstat(target)).isFile()) throw new Error('只能删除参考图片文件夹里的图片。');
    await shell.trashItem(target);
  });
}

module.exports = { register };
