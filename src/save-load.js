(() => {
  const dialog = document.getElementById('save-dialog');
  const form = document.getElementById('save-form');
  const nameInput = document.getElementById('save-name');
  const directoryInput = document.getElementById('save-directory');
  const confirm = document.getElementById('confirm-save');
  const status = document.getElementById('save-status');
  const input = document.getElementById('snapshot-input');
  const levels = Object.keys(window.MapTemplate.levels);
  let type = 'snapshot';
  let fields = {};
  let overwriteTarget = null;
  let working = false;
  const fileDirectoryHandles = {};
  const bridge = window.mapFiles;
  const isPreview = ['http:', 'https:'].includes(location.protocol);
  const sourceKey=`mapdesigner.${window.MapTemplate.key}.snapshot-source`;
  let snapshotSource=null;
  let snapshotTitle = '';
  try{const saved=JSON.parse(localStorage.getItem(sourceKey));if(saved&&typeof saved.filename==='string'&&/\.(mapdesign|json)$/i.test(saved.filename)&&typeof saved.directory==='string')snapshotSource=saved;}catch{}
  const sourceHint=document.createElement('p');sourceHint.id='save-overwrite-hint';sourceHint.className='settings-help';sourceHint.hidden=true;document.getElementById('save-type-description').after(sourceHint);
  const normalizePath=value=>value.replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase();
  function setSnapshotSource(source){
    snapshotSource=source?{filename:source.filename,directory:source.directory}:null;
    if(source?.directoryHandle)fileDirectoryHandles.snapshot=source.directoryHandle;
    try{if(snapshotSource)localStorage.setItem(sourceKey,JSON.stringify(snapshotSource));else localStorage.removeItem(sourceKey);}catch{}
  }
  function snapshotExtension(){return snapshotSource?.filename.match(/\.(mapdesign|json)$/i)?.[0].toLowerCase()||'.mapdesign';}
  function saveFilename(name){const extension=type==='snapshot'?snapshotExtension():'.png';return name.toLowerCase().endsWith(extension)?name:name+extension;}
  function targetsSource(){return type==='snapshot'&&snapshotSource&&saveFilename(nameInput.value.trim()).toLowerCase()===snapshotSource.filename.toLowerCase()&&normalizePath(directoryInput.value.trim())===normalizePath(snapshotSource.directory);}
  function updateSourceHint(){sourceHint.hidden=type!=='snapshot'||!snapshotSource;sourceHint.textContent=targetsSource()?'将覆盖原 Snapshot；修改文件名可另存为新的 Snapshot。':'将另存为新的 Snapshot。';}

  function localDefaultDirectories() {
    const configured = window.AppSettings?.get().files;
    if (configured?.snapshot && configured?.png) return configured;
    if (location.protocol !== 'file:') return { snapshot: '', png: '' };
    const root = new URL('./', document.baseURI);
    function folder(relative) {
      const url = new URL(relative, root);
      const pathname = decodeURIComponent(url.pathname);
      if (url.hostname) return `\\\\${url.hostname}${pathname.replace(/\//g, '\\')}`;
      return /^\/[a-z]:\//i.test(pathname) ? pathname.slice(1).replace(/\//g, '\\') : pathname;
    }
    return { snapshot: folder('saves/snapshots'), png: folder('saves/png') };
  }

  async function api(endpoint, body) {
    const response = await fetch(`/api/${endpoint}`, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MapDesigner-Request': '1' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '保存服务未就绪，请重新启动预览服务。');
    return data;
  }
  function showStatus(message, error = false) {
    status.textContent = message; status.hidden = false; status.dataset.error = String(error);
  }
  function timestamp() {
    const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date());
    return parts.replace(/[-:]/g, '').replace(' ', '_');
  }
  function rememberFields() { fields[type] = { name: nameInput.value, directory: directoryInput.value }; }
  function setType(next, remember = true) {
    if (remember && fields[type]) rememberFields();
    type = next;
    nameInput.value = fields[type].name; directoryInput.value = fields[type].directory;
    document.getElementById('save-extension').textContent = type === 'snapshot' ? snapshotExtension() : '.png';
    document.getElementById('save-type-description').textContent = type === 'snapshot' ? '保存国家、领土和视图设置，下次可加载并继续编辑。' : `保存整张地图（${window.MapTemplate.width} × ${window.MapTemplate.height}），保留着色、边界、国名和首都等显示设置。`;
    confirm.textContent = type === 'snapshot' ? '保存 snapshot' : '保存 PNG';
    overwriteTarget = null; status.hidden = true;
    updateSourceHint();
  }
  function setWorking(value) {
    working = value;
    for (const element of form.querySelectorAll('button,input')) element.disabled = value;
  }
  async function waitForMap() {
    await window.MapPainting.whenIdle();
    const start = performance.now();
    while (!image.complete || !image.naturalWidth || !message.hidden) {
      if (performance.now() - start > 30000) throw new Error('底图未加载完成，请稍后重试。');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await window.MapPainting.waitForRender();
    await window.CountryCapitals.waitForRender();
    await window.CountryLabels.waitForRender();
  }
  async function captureProject(name = '') {
    await waitForMap();
    return { format: 'MapDesignerSnapshot', formatVersion: 1, name, createdAt: new Date().toISOString(),
      map: { ...window.EU5ProjectMeta }, mapAppearance: window.MapAppearance.capture(), countryLabels: window.CountryLabels.capture(), countries: window.CountryStore.list(), groups: window.GroupStore.list(), painting: window.MapPainting.capture(), view: window.MapView.capture(), aiChat: window.AIChat.capture(), aiPromptId: window.AIPrompts.capture() };
  }
  function base64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
    return btoa(binary);
  }
  async function capturePNG() {
    await waitForMap();
    const data=await window.VectorMap.ready(),strip=document.createElement('canvas'),tile=document.createElement('canvas');
    const stripHeight=512;strip.width=data.width;strip.height=stripHeight;
    const ctx=strip.getContext('2d',{willReadFrequently:true}),tileCtx=tile.getContext('2d',{willReadFrequently:true});
    if(!ctx||!tileCtx)throw new Error('无法创建整图导出画布。');
    const painting=window.MapPainting.capture(),countries=window.CountryStore.displayColors();
    const colors=window.MapAppearance.capture(),view=window.MapView.capture(),capitals=window.CountryCapitals.markers();
    const level = view.boundaryDisplay === 'countries' ? 'countries' : view.boundariesHidden ? 'none' : view.adminLevel;
    const countryRoots = level === 'countries' ? window.CountryStore.borderRoots() : undefined;
    const groups = level === 'countries' ? window.GroupStore.list() : undefined;
    const labels=window.CountryLabels.createRenderer(),encoder=window.MapPNGEncoder.create(data.width,data.height),size=2048,pad=24;
    const total=Math.ceil(data.width/size)*Math.ceil(data.height/stripHeight);let completed=0;
    try{
      for(let y=0;y<data.height;y+=stripHeight){
        const h=Math.min(stripHeight,data.height-y);strip.height=h;
        for(let x=0;x<data.width;x+=size){
          const w=Math.min(size,data.width-x);tile.width=w+pad*2;tile.height=h+pad*2;
          const frame={width:tile.width,height:tile.height,ratio:1,scale:1,offsetX:pad-x,offsetY:pad-y};
          await window.VectorMap.render(tileCtx,{...frame,owners:painting.owners,countries,countryRoots,groups,colors,level});
          labels.draw(tileCtx,frame);window.CountryCapitals.renderTo(tileCtx,{...frame,capitals});
          ctx.drawImage(tile,pad,pad,w,h,x,0,w,h);
          completed++;if(dialog.open&&type==='png')showStatus(`正在导出整张地图… ${Math.round(completed/total*100)}%`);
          await new Promise(resolve=>setTimeout(resolve,0));
        }
        await encoder.writeRGBA(ctx.getImageData(0,0,data.width,h).data,h);
      }
      if(dialog.open&&type==='png')showStatus('正在生成 PNG 文件…');
      return base64(await encoder.finish());
    }catch(error){await encoder.abort();throw error;}
    finally{labels.dispose();strip.width=strip.height=tile.width=tile.height=1;}
  }
  document.getElementById('save-map').addEventListener('click', async () => {
    stopMapDrag();
    await window.AppSettings.ready;
    const time = timestamp();
    const localDefaults = localDefaultDirectories();
    fields = { snapshot: { name: `snapshot_${time}`, directory: localDefaults.snapshot }, png: { name: `map_${time}`, directory: localDefaults.png } };
    if(snapshotSource)fields.snapshot={name:snapshotSource.filename.replace(/\.(mapdesign|json)$/i,''),directory:snapshotSource.directory};
    type = 'snapshot';
    document.querySelector('[name="save-type"][value="snapshot"]').checked = true;
    setType('snapshot', false); dialog.showModal(); setWorking(true);
    try {
      const defaults = bridge ? await bridge.defaults() : isPreview ? await api('environment') : localDefaults;
      for (const kind of ['snapshot', 'png']) {
        if(kind!=='snapshot'||!snapshotSource)fields[kind].directory = defaults[kind];
      }
      directoryInput.value = fields.snapshot.directory;
      updateSourceHint();
    } catch (error) { showStatus(error.message, true); }
    finally { setWorking(false); nameInput.focus(); }
  });
  for (const radio of form.querySelectorAll('[name="save-type"]')) radio.addEventListener('change', () => setType(radio.value));
  for (const field of [nameInput, directoryInput]) field.addEventListener('input', () => {
    overwriteTarget = null; confirm.textContent = type === 'snapshot' ? '保存 snapshot' : '保存 PNG';
    updateSourceHint();
  });
  for (const id of ['close-save-dialog']) document.getElementById(id).addEventListener('click', () => { if (!working) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (working) event.preventDefault(); });
  document.getElementById('choose-save-directory').addEventListener('click', async () => {
    setWorking(true);
    try {
      let chosen;
      if (bridge) chosen = await bridge.chooseDirectory(directoryInput.value);
      else if (isPreview) chosen = (await api('directory', { initial: directoryInput.value })).directory;
      else if (window.showDirectoryPicker) {
        fileDirectoryHandles[type] = await window.showDirectoryPicker({ mode: 'readwrite' }); chosen = fileDirectoryHandles[type].name;
      } else throw new Error('请在桌面版或本地预览服务中选择保存路径。');
      if (chosen) { directoryInput.value = chosen; rememberFields(); overwriteTarget = null; updateSourceHint(); }
    } catch (error) { if (error.name !== 'AbortError') showStatus(error.message, true); }
    finally { setWorking(false); }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (working) return;
    const name = nameInput.value.trim(), directory = directoryInput.value.trim();
    if (!name || !directory) { showStatus('请填写名称和保存文件夹。', true); return; }
    const target = JSON.stringify([type, name, directory]);
    setWorking(true); showStatus(type === 'snapshot' ? '正在保存快照…' : '正在生成 PNG…');
    try {
      const request = { type, name, directory, overwrite: overwriteTarget === target || Boolean(targetsSource()), ...(type==='snapshot'?{extension:snapshotExtension()}:{}) };
      if (type === 'snapshot') request.text = JSON.stringify(await captureProject(name), null, 2);
      else request.base64 = await capturePNG();
      let result;
      if (bridge) result = await bridge.save(request);
      else if (isPreview) result = await api('save', request);
      else if (fileDirectoryHandles[type] && (directory === fileDirectoryHandles[type].name || directory === localDefaultDirectories()[type])) {
        const fileDirectoryHandle = fileDirectoryHandles[type];
        const fileName = saveFilename(name);
        let exists = false;
        try { await fileDirectoryHandle.getFileHandle(fileName); exists = true; } catch {}
        if (exists && !request.overwrite) result = { exists: true, path: `${directory}/${fileName}` };
        else {
          const handle = await fileDirectoryHandle.getFileHandle(fileName, { create: true });
          const writable = await handle.createWritable();
          await writable.write(type === 'snapshot' ? request.text : Uint8Array.from(atob(request.base64), char => char.charCodeAt(0)));
          await writable.close(); result = { saved: true, path: `${directory}/${fileName}` };
        }
      } else throw new Error('请使用“选择…”指定文件夹，或通过桌面版 / 本地预览填写保存路径。');
      if (result.exists) { overwriteTarget = target; confirm.textContent = '覆盖保存'; showStatus(`同名文件已存在：${result.path}。再次点击“覆盖保存”可替换。`, true); }
      else {
        overwriteTarget = null;
        if(type==='snapshot'){snapshotTitle=name;setSnapshotSource({filename:saveFilename(name),directory,directoryHandle:fileDirectoryHandles.snapshot});updateSourceHint();}
        showStatus(`已保存：${result.path}`); confirm.textContent = type === 'snapshot' ? '保存 snapshot' : '保存 PNG';
      }
    } catch (error) { showStatus(error.message, true); }
    finally { setWorking(false); }
  });

  async function validateSnapshot(data) {
    if (!data || data.format !== 'MapDesignerSnapshot' || data.formatVersion !== 1) throw new Error('不是支持的 MapDesigner snapshot。');
    const template=window.MapTemplates.forSnapshot(data.map),same=template.key===window.MapTemplate.key;
    const allowedLevels=Object.keys(template.levels);
    const lookup=async filename=>{if(!same)return window.MapTemplates.readLookup(template,filename);await loadLookupScript(filename);return filename==='meta.js'?window.MapDesignerData.meta:filename==='paint-meta.js'?window.MapDesignerData.paintMeta:window.MapDesignerData.bands[Number(filename.match(/band-(\d+)/)[1])];};
    if (!Array.isArray(data.countries) || data.countries.length > 10000) throw new Error('国家列表无效。');
    const groups = window.GroupStore.validate(data.groups === undefined ? [] : data.groups);
    const ids = new Set(), names = new Set(), colors = new Set();
    const mapAppearance = window.MapAppearance.validate(data.mapAppearance === undefined ? window.MapAppearance.defaults() : data.mapAppearance, data.countries, template);
    const countryLabels = window.CountryLabels.validate(data.countryLabels === undefined ? window.CountryLabels.defaults() : data.countryLabels);
    const aiChat = AIMessages.validate(data.aiChat === undefined ? [] : data.aiChat);
    const aiPromptId = window.AIPrompts.validateSelection(data.aiPromptId);
    const reserved = new Set(Object.values(mapAppearance));
    const countries = data.countries.map(country => {
      if (!country || typeof country.id !== 'string' || !/^[\w-]{1,100}$/.test(country.id) || typeof country.name !== 'string' || country.name.length > 100 || typeof country.description !== 'string' || country.description.length > 2000 || !/^#[\da-f]{6}$/i.test(country.color)) throw new Error('快照中的国家数据无效。');
      if (country.countryType !== undefined && typeof country.countryType !== 'string') throw new Error('快照中的国家类型无效。');
      const name = country.name.trim(), countryType = country.countryType?.trim(), color = country.color.toLowerCase();
      const fullName = window.CountryStore.fullName({ name, countryType });
      if ((countryType && !name) || fullName.length > 100) throw new Error('快照中的国家名称或类型无效。');
      const normalizedName = fullName.normalize('NFKC').toLowerCase();
      if (ids.has(country.id) || (fullName && names.has(normalizedName)) || colors.has(color) || reserved.has(color)) throw new Error('快照存在重复的国家名称、标识或冲突颜色。');
      ids.add(country.id); if (fullName) names.add(normalizedName); colors.add(color);
      const capital = country.capital;
      if (capital !== undefined && capital !== null && (!Number.isInteger(capital.locationId) || capital.locationId < 1 || !Number.isFinite(capital.x) || !Number.isFinite(capital.y) || capital.x < 0 || capital.x >= template.width || capital.y < 0 || capital.y >= template.height)) throw new Error('快照中的首都数据无效。');
      const suzerainId = country.suzerainId;
      if (suzerainId != null && (typeof suzerainId !== 'string' || suzerainId === country.id)) throw new Error('快照中的宗主关系无效。');
      return { id: country.id, name, ...(countryType ? { countryType } : {}), description: country.description, color, ...(suzerainId == null ? {} : { suzerainId }), ...(capital === undefined ? {} : { capital: capital ? { locationId: capital.locationId, x: capital.x, y: capital.y } : null }) };
    });
    if (groups.some(group => group.memberIds.some(id => !ids.has(id)))) throw new Error('快照包含不存在的集团成员。');
    const roots = new Set(countries.filter(country => country.suzerainId === undefined).map(country => country.id));
    if (countries.some(country => country.suzerainId !== undefined && !roots.has(country.suzerainId))) throw new Error('快照中的宗主国不存在或也是附庸。');
    const view = data.view;
    if (view?.boundaryDisplay !== undefined && !['plots','countries','hidden'].includes(view.boundaryDisplay)) throw new Error('快照的边界显示设置无效。');
    if (!view || !allowedLevels.includes(view.adminLevel) || !allowedLevels.includes(view.paintLevel) || !Number.isInteger(view.zoom) || view.zoom < 100 || view.zoom > 2000 || view.zoom % 5 || typeof view.boundariesHidden !== 'boolean' || typeof view.namesEnabled !== 'boolean' || !view.center || ![view.center.x, view.center.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw new Error('快照的视图设置无效。');
    const painting = data.painting;
    if (!painting || typeof painting.wastelandEnabled !== 'boolean' || !['paint', 'pan', 'erase'].includes(painting.mode) || !painting.owners || typeof painting.owners !== 'object' || Array.isArray(painting.owners) || (painting.selectedCountry !== null && !ids.has(painting.selectedCountry))) throw new Error('快照的领土设置无效。');
    const metadata=await lookup('meta.js'),kinds=(await lookup('paint-meta.js')).kinds;
    const owners = {};
    for (const [id, country] of Object.entries(painting.owners)) {
      if (!/^[1-9]\d*$/.test(id) || !metadata.locations[id] || !ids.has(country) || kinds[id] === 1 || (kinds[id] === 2 && !painting.wastelandEnabled)) throw new Error('快照包含无效的地块归属。');
      owners[id] = country;
    }
    for (const country of countries) if (country.capital) {
      const capital = country.capital, y = Math.floor(capital.y), x = Math.floor(capital.x), band = Math.floor(y / 256);
      if (!metadata.locations[capital.locationId] || kinds[capital.locationId] === 1) throw new Error('快照中的首都地块无效。');
      const row=(await lookup(`band-${band}.js`))[y%256];
      let low = 0, high = row.length / 2;
      while (low < high) { const mid = (low + high) >>> 1; if (x < row[mid * 2]) high = mid; else low = mid + 1; }
      if (row[low * 2 + 1] !== capital.locationId) throw new Error('首都标记不在指定地块内。');
    }
    const boundaryDisplay=view.boundaryDisplay || (view.boundariesHidden ? 'hidden' : 'plots');
    return { mapAppearance, countryLabels, countries, groups, aiChat, aiPromptId, painting: { ...painting, owners }, view: { ...view, boundaryDisplay, boundariesHidden:boundaryDisplay!=='plots', center: { ...view.center } } };
  }
  async function applySnapshot(snapshot) {
    window.CountryCapitals.cancel();
    window.MapAppearance.restore(snapshot.mapAppearance);
    window.CountryLabels.restore(snapshot.countryLabels);
    window.CountryStore.restore(snapshot.countries);
    await window.MapPainting.restore(snapshot.painting);
    await window.MapView.restore(snapshot.view);
    await window.MapPainting.waitForRender();
    await window.CountryCapitals.waitForRender();
    await window.CountryLabels.waitForRender();
    window.AIChat.restore(snapshot.aiChat);
    window.AIPrompts.restore(snapshot.aiPromptId);
    window.GroupStore.restore(snapshot.groups);
  }
  async function openText(text,{source=null}={}) {
    if (text.length > 16 * 1024 * 1024) throw new Error('快照文件过大。');
    const parsed=JSON.parse(text.replace(/^\uFEFF/, '')),data=await validateSnapshot(parsed);
    const target=window.MapTemplates.forSnapshot(parsed.map);
    if(target.key!==window.MapTemplate.key){await window.MapTemplates.navigate(target.key,{text,source});return;}
    await window.MapPainting.whenIdle();
    const backup = { mapAppearance: window.MapAppearance.capture(), countryLabels: window.CountryLabels.capture(), countries: window.CountryStore.list(), painting: window.MapPainting.capture(), view: image.naturalWidth && !document.getElementById('map').hidden ? window.MapView.capture() : null };
    const unlockChat = window.AIChat.lockProject();
    try { await applySnapshot(data); }
    catch (error) {
      window.MapAppearance.restore(backup.mapAppearance);
      window.CountryLabels.restore(backup.countryLabels);
      window.CountryStore.restore(backup.countries); await window.MapPainting.restore(backup.painting);
      if (backup.view) await window.MapView.restore(backup.view);
      throw error;
    } finally { unlockChat(); }
    document.getElementById('paint-status').textContent = '快照已加载，可继续编辑';
    snapshotTitle = typeof parsed.name === 'string' ? parsed.name.trim().slice(0, 160) : '';
    setSnapshotSource(source);
  }
  function openError(error) {
    document.getElementById('project-open-status').textContent = `加载失败：${error.message}`;
    document.getElementById('paint-status').textContent = `加载失败：${error.message}`;
  }
  const loadDialog = document.getElementById('load-dialog');
  const library = document.getElementById('snapshot-library');
  const libraryStatus = document.getElementById('snapshot-library-status');
  const folderLabel = document.getElementById('snapshot-folder');
  let libraryDirectory = null;
  let libraryBusy = false;
  let selectedSnapshot=null;
  const loadSelected=document.getElementById('load-selected-snapshot'),deleteSelected=document.getElementById('delete-selected-snapshot');
  function updateLibraryControls(){
    loadSelected.disabled=deleteSelected.disabled=libraryBusy||!selectedSnapshot;
    document.getElementById('close-load-dialog').disabled=libraryBusy;
    for(const button of library.querySelectorAll('button')){button.disabled=libraryBusy;button.setAttribute('aria-pressed',String(button.dataset.snapshot===selectedSnapshot));}
  }
  let homeBusy = false;
  function homeStatus(text) { document.getElementById('project-open-status').textContent = text; }
  function setHomeBusy(value) {
    homeBusy = value;
    for (const id of ['create-map', 'open-snapshot', 'import-snapshot']) document.getElementById(id).disabled = value;
  }
  async function authorizeLibraryDirectory() {
    if (libraryDirectory) return libraryDirectory;
    if (fileDirectoryHandles.snapshot) { libraryDirectory = fileDirectoryHandles.snapshot; return libraryDirectory; }
    if (!window.showDirectoryPicker) throw new Error('请通过桌面版或本地预览服务使用默认快照文件夹。');
    homeStatus(`请选择默认快照文件夹：${localDefaultDirectories().snapshot}`);
    libraryDirectory = await window.showDirectoryPicker({ id: 'mapdesigner-snapshots', mode: 'readwrite' });
    fileDirectoryHandles.snapshot = libraryDirectory;
    return libraryDirectory;
  }
  async function refreshLibrary() {
    if (libraryBusy) return;
    libraryBusy = true;selectedSnapshot=null; library.replaceChildren();updateLibraryControls(); libraryStatus.textContent = '正在读取快照…';
    try {
      let result;
      if (bridge) result = await bridge.listSnapshots();
      else if (isPreview) result = await api('snapshots', {});
      else {
        const directory = await authorizeLibraryDirectory(), files = [];
        for await (const [name, handle] of directory.entries()) {
          if (handle.kind !== 'file' || !/\.(mapdesign|json)$/i.test(name)) continue;
          const file = await handle.getFile(); files.push({ name, modifiedAt: new Date(file.lastModified).toISOString(), size: file.size });
        }
        files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.name.localeCompare(b.name));
        result = { directory: localDefaultDirectories().snapshot, files };
      }
      folderLabel.textContent = result.directory;
      libraryStatus.textContent = result.files.length ? '' : '默认文件夹中还没有 snapshot。可以先创建地图并保存，或使用“导入地图”。';
      for (const file of result.files) {
        const button = document.createElement('button'); button.className = 'snapshot-entry'; button.type = 'button';
        const name = document.createElement('strong'); name.textContent = file.name;
        const details = document.createElement('small'); details.textContent = `${new Date(file.modifiedAt).toLocaleString('zh-CN')} · ${Math.max(1, Math.round(file.size / 1024))} KB`;
        button.append(name, details);
        button.dataset.snapshot=file.name;button.setAttribute('aria-pressed','false');
        button.addEventListener('click',()=>{if(libraryBusy)return;selectedSnapshot=file.name;libraryStatus.textContent='';updateLibraryControls();});
        const row=document.createElement('div');row.className='snapshot-row';
        const rename=document.createElement('button');rename.type='button';rename.className='snapshot-rename map-tool-button icon-tool';rename.title='重命名';rename.setAttribute('aria-label',`重命名 ${file.name}`);
        rename.innerHTML='<svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        rename.addEventListener('click',()=>{
          if(libraryBusy||row.querySelector('form'))return;
          const form=document.createElement('form');form.className='snapshot-rename-form';
          const input=document.createElement('input');input.value=file.name.replace(/\.(mapdesign|json)$/i,'');input.maxLength=160;input.setAttribute('aria-label','新的快照名称');
          const suffix=document.createElement('span');suffix.textContent=file.name.match(/\.(mapdesign|json)$/i)[0];
          const save=document.createElement('button');save.type='submit';save.className='map-tool-button icon-tool';save.textContent='✓';save.setAttribute('aria-label','确认重命名');
          const cancel=document.createElement('button');cancel.type='button';cancel.className='map-tool-button icon-tool';cancel.textContent='×';cancel.setAttribute('aria-label','取消重命名');
          function close(){form.remove();button.hidden=false;rename.hidden=false;}
          cancel.addEventListener('click',close);input.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}});
          form.append(input,suffix,save,cancel);button.hidden=true;rename.hidden=true;row.append(form);input.focus();input.select();
          form.addEventListener('submit',async event=>{
            event.preventDefault();if(libraryBusy)return;
            const newName=input.value.trim();
            if(!newName||newName.length>160||/[<>:"/\\|?*\x00-\x1f]/.test(newName)||/[. ]$/.test(newName)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(newName)){libraryStatus.textContent='名称包含无效字符，请修改。';return;}
            libraryBusy=true;updateLibraryControls();input.disabled=true;libraryStatus.textContent='正在重命名…';
            try{
              let result;
              if(bridge)result=await bridge.renameSnapshot({name:file.name,newName});
              else if(isPreview)result=await api('snapshot-rename',{name:file.name,newName});
              else{
                const filename=newName+suffix.textContent;
                if(filename!==file.name){
                  for await(const existing of libraryDirectory.keys())if(existing.toLowerCase()===filename.toLowerCase())throw new Error('同名快照已存在，请换一个名称。');
                  const original=await(await libraryDirectory.getFileHandle(file.name)).getFile(),target=await libraryDirectory.getFileHandle(filename,{create:true});
                  try{const writable=await target.createWritable();await writable.write(original);await writable.close();await libraryDirectory.removeEntry(file.name);}catch(error){await libraryDirectory.removeEntry(filename).catch(()=>{});throw error;}
                }
                result={name:filename};
              }
              if(snapshotSource?.filename===file.name&&normalizePath(snapshotSource.directory)===normalizePath(folderLabel.textContent))setSnapshotSource({...snapshotSource,filename:result.name});
              libraryBusy=false;await refreshLibrary();selectedSnapshot=result.name;updateLibraryControls();libraryStatus.textContent=`已重命名：${result.name}`;
            }catch(error){libraryStatus.textContent=`重命名失败：${error.message}`;}
            finally{libraryBusy=false;input.disabled=false;updateLibraryControls();}
          });
        });
        row.append(button,rename);library.append(row);
      }
    } catch (error) { libraryStatus.textContent = `读取失败：${error.message}`; }
    finally { libraryBusy = false; updateLibraryControls(); }
  }
  document.getElementById('open-snapshot').addEventListener('click', async () => {
    if (homeBusy) return;
    setHomeBusy(true);
    try {
      await window.AppSettings.ready;
      if (!bridge && !isPreview) await authorizeLibraryDirectory();
      folderLabel.textContent = ''; loadDialog.showModal(); await refreshLibrary();
    } catch (error) { if (error.name !== 'AbortError') openError(error); }
    finally { setHomeBusy(false); }
  });
  loadSelected.addEventListener('click',async()=>{
    if(libraryBusy||!selectedSnapshot)return;
    const name=selectedSnapshot;libraryBusy=true;updateLibraryControls();libraryStatus.textContent='正在加载地图…';
    try{
      let selected;
      if(bridge)selected=await bridge.readSnapshot(name);
      else if(isPreview)selected=await api('snapshot-read',{name});
      else{const file=await(await libraryDirectory.getFileHandle(name)).getFile();if(file.size>16*1024*1024)throw new Error('快照文件过大。');selected={text:await file.text()};}
      const actualPath=selected.path,slash=actualPath?.search(/[^\\/]+$/);
      const sourceDirectory=actualPath?actualPath.slice(0,slash):folderLabel.textContent;
      const source={filename:actualPath?actualPath.slice(slash):name,directory:/^[a-z]:[\\/]$/i.test(sourceDirectory)||sourceDirectory==='/'?sourceDirectory:sourceDirectory.replace(/[\\/]$/,''),...(!bridge&&!isPreview?{directoryHandle:libraryDirectory}:{})};
      await openText(selected.text,{source});loadDialog.close();homeStatus('');
    }catch(error){libraryStatus.textContent=`加载失败：${error.message}`;}
    finally{libraryBusy=false;updateLibraryControls();}
  });
  deleteSelected.addEventListener('click',async()=>{
    if(libraryBusy||!selectedSnapshot)return;
    const name=selectedSnapshot;libraryBusy=true;updateLibraryControls();libraryStatus.textContent='正在删除快照…';
    try{
      if(bridge)await bridge.deleteSnapshot(name);
      else if(isPreview)await api('snapshot-delete',{name});
      else await libraryDirectory.removeEntry(name);
      libraryBusy=false;await refreshLibrary();
      libraryStatus.textContent=library.children.length?`已删除：${name}`:`已删除：${name}。默认文件夹中已没有 snapshot。`;
    }catch(error){libraryStatus.textContent=`删除失败：${error.message}`;}
    finally{libraryBusy=false;updateLibraryControls();}
  });
  document.getElementById('close-load-dialog').addEventListener('click',()=>{if(!libraryBusy)loadDialog.close();});
  loadDialog.addEventListener('cancel', event => { if (libraryBusy) event.preventDefault(); });
  async function importText(name, text) {
    await window.AppSettings.ready;
    if (text.length > 16 * 1024 * 1024) throw new Error('快照文件过大。');
    await validateSnapshot(JSON.parse(text.replace(/^\uFEFF/, '')));
    let result;
    if (bridge) result = await bridge.importSnapshot({ name, text });
    else if (isPreview) result = await api('snapshot-import', { name, text });
    else {
      const directory = await authorizeLibraryDirectory();
      const stem = name.replace(/\.(mapdesign|json)$/i, '');
      for (let i = 1; i <= 10000; i++) {
        const target = `${stem}${i === 1 ? '' : ` (${i})`}.mapdesign`;
        try { await directory.getFileHandle(target); continue; }
        catch (error) { if (error.name !== 'NotFoundError') throw error; }
        const handle = await directory.getFileHandle(target, { create: true });
        const writable = await handle.createWritable(); await writable.write(text); await writable.close();
        result = { path: `${localDefaultDirectories().snapshot}\\${target}` }; break;
      }
      if (!result) throw new Error('同名快照过多，请重命名后导入。');
    }
    homeStatus(`已导入：${result.path}。点击“加载地图”可继续编辑。`);
  }
  document.getElementById('import-snapshot').addEventListener('click', async () => {
    if (homeBusy) return;
    if (!bridge) {
      try {
        if (!isPreview) await authorizeLibraryDirectory();
        input.value = ''; input.click();
      } catch (error) { if (error.name !== 'AbortError') homeStatus(`导入失败：${error.message}`); }
      return;
    }
    setHomeBusy(true);
    try {
      const selected = await bridge.openSnapshot();
      if (selected) { homeStatus('正在导入快照…'); await importText(selected.path.split(/[\\/]/).pop(), selected.text); }
    } catch (error) { homeStatus(`导入失败：${error.message}`); }
    finally { setHomeBusy(false); }
  });
  input.addEventListener('change', async () => {
    const file = input.files[0]; if (!file || homeBusy) return;
    setHomeBusy(true); homeStatus('正在导入快照…');
    try { if (file.size > 16 * 1024 * 1024) throw new Error('快照文件过大。'); await importText(file.name, await file.text()); }
    catch (error) { homeStatus(`导入失败：${error.message}`); }
    finally { setHomeBusy(false); }
  });
  async function createBlank() {
    await openText(JSON.stringify({ format: 'MapDesignerSnapshot', formatVersion: 1, map: { ...window.EU5ProjectMeta }, mapAppearance: window.MapAppearance.defaults(), countryLabels: window.CountryLabels.defaults(), countries: [],
      painting: { owners: {}, wastelandEnabled: false, mode: 'pan', selectedCountry: null },
      view: { zoom: 100, adminLevel: window.MapTemplate.baseLevel, paintLevel: window.MapTemplate.baseLevel, boundariesHidden: false, namesEnabled: false, center: { x: .5, y: .5 } } }));
    document.getElementById('paint-status').textContent = '';
  }
  window.addEventListener('settings-changed', event => {
    for (const kind of ['snapshot', 'png']) {
      if (event.detail.previous.files[kind] !== event.detail.current.files[kind]) {
        delete fileDirectoryHandles[kind];
        if (kind === 'snapshot') libraryDirectory = null;
      }
      if (event.detail.folderHandles[kind]) {
        fileDirectoryHandles[kind] = event.detail.folderHandles[kind];
        if (kind === 'snapshot') libraryDirectory = event.detail.folderHandles[kind];
      }
    }
  });
  window.MapProject = { capture: captureProject, openText, validateSnapshot, capturePNG, createBlank,
    contextTitles: () => [snapshotSource?.filename.replace(/\.(mapdesign|json)$/i, ''), snapshotTitle] };

  const unlockStartupChat = window.AIChat.lockProject();
  (async()=>{const pending=await window.MapTemplates.consumePending();if(pending)await openText(typeof pending==='string'?pending:pending.text,{source:pending.source||null});else if(window.MapTemplate.fresh)await createBlank();})().catch(error=>{openError(error);location.hash='home';}).finally(unlockStartupChat);
})();
