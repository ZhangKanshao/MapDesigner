const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const projectFiles = require('./project-files.cjs');
const globalSettings = require('./global-settings.cjs');
const root = path.resolve(__dirname, '..');
const port = Number(process.env.MAPDESIGNER_PREVIEW_PORT || 4173);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };
http.createServer(async (request, response) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
  catch { response.writeHead(400).end(); return; }
  if (pathname.startsWith('/api/')) {
    const json = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
    if (pathname === '/api/environment' && request.method === 'GET') { json(200, projectFiles.defaults()); return; }
    if (pathname === '/api/settings' && request.method === 'GET') { json(200, globalSettings.read()); return; }
    if (pathname === '/api/settings-defaults' && request.method === 'GET') { json(200, globalSettings.initial()); return; }
    const origin = request.headers.origin;
    if (request.method !== 'POST' || request.headers['x-mapdesigner-request'] !== '1' || ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) { json(403, { error: '只接受地图页面发起的保存请求。' }); return; }
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 96 * 1024 * 1024) throw new Error('保存数据过大。');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (pathname === '/api/settings') { json(200, await globalSettings.save(body)); return; }
      if (pathname === '/api/snapshots') { json(200, await projectFiles.listSnapshots()); return; }
      if (pathname === '/api/snapshot-read') { json(200, await projectFiles.readSnapshot(body.name)); return; }
      if (pathname === '/api/snapshot-delete') { json(200, await projectFiles.deleteSnapshot(body.name)); return; }
      if (pathname === '/api/snapshot-rename') { json(200, await projectFiles.renameSnapshot(body)); return; }
      if (pathname === '/api/snapshot-import') { json(200, await projectFiles.importSnapshot(body)); return; }
      if (pathname === '/api/save') { json(200, await projectFiles.saveFile(body)); return; }
      if (pathname === '/api/directory') {
        const initial = typeof body.initial === 'string' && path.isAbsolute(body.initial) ? body.initial : root;
        const chosen = await new Promise((resolve, reject) => {
          const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
          const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [root, '--choose-map-directory', initial], { windowsHide: true, env });
          let output = '';
          child.stdout.on('data', chunk => { output += chunk; });
          child.on('error', () => reject(new Error('文件夹选择器无法启动，请直接填写保存路径。')));
          child.on('close', () => {
            const match = output.match(/MAP_DIRECTORY:(.*)/);
            if (!match) reject(new Error('文件夹选择器未返回结果，请直接填写保存路径。'));
            else { try { resolve(JSON.parse(match[1])); } catch { reject(new Error('保存路径无效。')); } }
          });
        });
        json(200, { directory: chosen }); return;
      }
      json(404, { error: '未找到此保存操作。' });
    } catch (error) { json(400, { error: error.message }); }
    return;
  }
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  const relative = path.relative(root, file);
  const allowed = relative === 'index.html' || relative.startsWith('src' + path.sep) || relative.startsWith('output' + path.sep + 'maps' + path.sep) || ['eu5', 'ck3', 'hoi4', 'vic3', 'styles'].some(folder => relative.startsWith(path.join('assets', 'maps', folder) + path.sep));
  if (!allowed || relative.startsWith('..')) { response.writeHead(403).end(); return; }
  fs.stat(file, (error, stat) => {
    if (error || !stat.isFile()) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Content-Length': stat.size });
    fs.createReadStream(file).pipe(response);
  });
}).listen(port, '127.0.0.1', () => console.log(`MapDesigner: http://127.0.0.1:${port}`));
