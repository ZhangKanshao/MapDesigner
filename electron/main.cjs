const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const projectFiles = require('../scripts/project-files.cjs');
const globalSettings = require('../scripts/global-settings.cjs');
const templateFiles=require('../scripts/template-files.cjs');
const pendingTemplates=new Map();
if (process.env.MAPDESIGNER_TEST_PROFILE) app.setPath('userData', process.env.MAPDESIGNER_TEST_PROFILE);

function createWindow() {
  Menu.setApplicationMenu(null);
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 640,
    title: 'MapDesigner',
    show: false,
    backgroundColor: '#f5f6f8',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  window.loadFile(path.join(__dirname, '../index.html')).catch(error => {
    if (window.isDestroyed()) return;
    console.error('Failed to load the MapDesigner home page:', error);
    dialog.showErrorBox('MapDesigner 启动失败', '无法加载首页，请重新打开 MapDesigner。');
    window.close();
  });
}

app.whenReady().then(() => {
  if (process.argv.includes('--choose-map-directory')) {
    const defaultPath = process.argv[process.argv.indexOf('--choose-map-directory') + 1];
    dialog.showOpenDialog({ title: '选择保存文件夹', defaultPath, properties: ['openDirectory', 'createDirectory'] }).then(result => {
      console.log('MAP_DIRECTORY:' + JSON.stringify(result.canceled ? null : result.filePaths[0]));
      app.quit();
    });
    return;
  }
  ipcMain.handle('settings:defaults', () => globalSettings.initial());
  ipcMain.handle('settings:get', () => globalSettings.read());
  ipcMain.handle('settings:save', (event, value) => globalSettings.save(value));
  require('./ai.cjs').register();
  ipcMain.handle('map-files:defaults', () => projectFiles.defaults());
  ipcMain.handle('map-files:template-lookup',(event,request)=>templateFiles.readLookup(request));
  ipcMain.handle('map-files:pending-template',event=>{const text=pendingTemplates.get(event.sender.id)||null;pendingTemplates.delete(event.sender.id);return text;});
  ipcMain.handle('map-files:template',(event,request)=>{
    templateFiles.directory(request?.key);
    if(request.text!==null&&request.text!==undefined&&(typeof request.text!=='string'||request.text.length>16*1024*1024))throw new Error('快照数据无效。');
    if(request.text)pendingTemplates.set(event.sender.id,{text:request.text,source:request.source||null});
    const query={map:request.key};if(request.fresh)query.new='1';
    setTimeout(()=>{if(!event.sender.isDestroyed())event.sender.loadFile(path.join(__dirname,'../index.html'),{query,hash:'map'}).catch(()=>{});},20);
    return true;
  });
  ipcMain.handle('map-files:list', () => projectFiles.listSnapshots());
  ipcMain.handle('map-files:read', (event, name) => projectFiles.readSnapshot(name));
  ipcMain.handle('map-files:delete', (event, name) => projectFiles.deleteSnapshot(name));
  ipcMain.handle('map-files:rename', (event, request) => projectFiles.renameSnapshot(request));
  ipcMain.handle('map-files:import', (event, request) => projectFiles.importSnapshot(request));
  ipcMain.handle('map-files:directory', async (event, initial) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { title: '选择保存文件夹', defaultPath: typeof initial === 'string' ? initial : undefined, properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('map-files:save', (event, request) => projectFiles.saveFile(request));
  ipcMain.handle('map-files:open', async event => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { title: '打开地图快照', properties: ['openFile'], filters: [{ name: 'MapDesigner 快照', extensions: ['mapdesign', 'json'] }] });
    if (result.canceled) return null;
    const selected = result.filePaths[0];
    if ((await fs.stat(selected)).size > 16 * 1024 * 1024) throw new Error('快照文件过大。');
    return { path: selected, text: await fs.readFile(selected, 'utf8') };
  });
  ipcMain.handle('map-files:capture', async (event, rect) => {
    if (!rect || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) || rect.width < 1 || rect.height < 1) throw new Error('地图视口无效。');
    const captured = await event.sender.capturePage({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) });
    return captured.toPNG().toString('base64');
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
