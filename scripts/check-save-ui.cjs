const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const crypto=require('node:crypto');
const samples = require('../assets/maps/eu5/lookup/paint-report.json').samples;
const root = path.resolve(__dirname, '..');
const run = String(Date.now());

async function check(page, environment, electron) {
  const directory = path.join(root, 'output', 'save-tests', run, environment);
  const snapshotDirectory = path.join(directory, 'snapshots');
  const pngDirectory = path.join(directory, 'png');
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => console.log(`${environment} resource: ${request.url()} ${request.failure()?.errorText}`));
  await page.waitForFunction(() => document.querySelector('#basemap').naturalWidth === 16384);
  assert.equal(await page.locator('.operations-group').locator('button').last().getAttribute('id'), 'save-map');
  const first = await page.locator('#admin-level').boundingBox(), second = await page.locator('#paint-level').boundingBox();
  assert.ok(Math.abs(first.y - second.y) < 2);
  const groups = await page.locator('.map-tools .toolbar-group').evaluateAll(items => items.map(item => item.getBoundingClientRect().y));
  assert.equal(groups.length, 3);
  assert.ok(Math.max(...groups) - Math.min(...groups) < 2);
  assert.equal((await page.locator('#toggle-names').textContent()).trim(), 'A');
  await page.locator('#toggle-names').click();
  assert.equal((await page.locator('#toggle-names').textContent()).trim(), 'A');
  await page.locator('#toggle-names').click();
  await page.locator('#create-country').click(); await page.locator('#country-name').fill('快照测试国');
  await page.locator('#confirm-country').click();
  await page.locator('.country-brush').click();
  await page.locator('#map-zoom').fill('1000');
  await page.evaluate(sample => {
    const v = document.querySelector('#map-viewport'), im = document.querySelector('#basemap');
    v.scrollLeft = im.width * (sample.x + .5) / 16384 - v.clientWidth / 2;
    v.scrollTop = im.height * (sample.y + .5) / 8192 - v.clientHeight / 2;
  }, samples.stockholm);
  const p = await page.locator('#basemap').evaluate((im, sample) => {
    const r = im.getBoundingClientRect(); return { x: r.left + r.width * (sample.x + .5) / 16384, y: r.top + r.height * (sample.y + .5) / 8192 };
  }, samples.stockholm);
  await page.mouse.click(p.x, p.y);
  await page.locator('#admin-level').selectOption('province');
  await page.locator('#paint-level').selectOption('area');
  let original;
  try { original = await page.evaluate(() => window.MapProject.capture()); }
  catch (error) {
    console.log(environment, await page.evaluate(() => ({ url: location.href, src: document.querySelector('#basemap').src, complete: document.querySelector('#basemap').complete, width: document.querySelector('#basemap').naturalWidth, message: document.querySelector('#map-message').textContent, hidden: document.querySelector('#map-message').hidden, paint: document.querySelector('#paint-status').textContent })));
    await page.screenshot({ path: path.join(root, 'output/save-test-error.png') });
    throw error;
  }
  assert.ok(Object.keys(original.painting.owners).length > 0);
  await page.locator('#save-map').click();
  await page.waitForFunction(() => !document.querySelector('#save-name').disabled);
  assert.match(await page.locator('#save-name').inputValue(), /^snapshot_\d{8}_\d{6}$/);
  assert.equal(await page.locator('#save-directory').inputValue(), path.join(root, 'saves', 'snapshots'));
  await page.locator('[name="save-type"][value="png"]').check();
  assert.equal(await page.locator('#save-directory').inputValue(), path.join(root, 'saves', 'png'));
  await page.locator('[name="save-type"][value="snapshot"]').check();
  await page.locator('#save-name').fill('snapshot-test');
  await page.locator('#save-directory').fill(snapshotDirectory);
  if (electron) {
    await electron.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, snapshotDirectory);
    await page.locator('#choose-save-directory').click();
    await page.waitForFunction(() => !document.querySelector('#choose-save-directory').disabled);
    assert.equal(await page.locator('#save-directory').inputValue(), snapshotDirectory);
  }
  await page.screenshot({ path: path.join(root, 'output/save-dialog.png') });
  await page.locator('#confirm-save').click();
  await page.waitForFunction(() => document.querySelector('#save-status').textContent.startsWith('已保存：'));
  const snapshotPath = path.join(snapshotDirectory, 'snapshot-test.mapdesign');
  const saved = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
  assert.deepEqual(saved.countries, original.countries);
  assert.deepEqual(saved.painting.owners, original.painting.owners);
  assert.equal(saved.view.adminLevel, 'province'); assert.equal(saved.view.paintLevel, 'area');
  const initialText = await fs.readFile(snapshotPath, 'utf8');
  await page.locator('#confirm-save').click();
  await page.waitForFunction(() => document.querySelector('#confirm-save').textContent === '覆盖保存');
  assert.equal(await fs.readFile(snapshotPath, 'utf8'), initialText);
  await page.locator('#confirm-save').click();
  await page.waitForFunction(() => document.querySelector('#save-status').textContent.startsWith('已保存：'));
  await page.locator('[name="save-type"][value="png"]').check();
  await page.locator('#save-name').fill('visible'); await page.locator('#save-directory').fill(pngDirectory);
  await page.locator('#confirm-save').click();
  await page.waitForFunction(() => document.querySelector('#save-status').textContent.startsWith('已保存：'));
  await page.locator('[name="save-type"][value="snapshot"]').check();
  assert.equal(await page.locator('#save-name').inputValue(), 'snapshot-test');
  assert.equal(await page.locator('#save-directory').inputValue(), snapshotDirectory);
  await page.locator('#close-save-dialog').click();
  const exported=await fs.readFile(path.join(pngDirectory,'visible.png'));
  assert.equal(exported.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(exported.readUInt32BE(16),16384);assert.equal(exported.readUInt32BE(20),8192);
  const visibleHash=crypto.createHash('sha256').update(exported).digest('hex');
  await page.locator('#toggle-boundaries').click();
  await page.waitForFunction(() => document.querySelector('#map-message').hidden);
  await page.locator('#save-map').click(); await page.waitForFunction(() => !document.querySelector('#save-name').disabled);
  await page.locator('[name="save-type"][value="png"]').check();
  assert.equal(await page.locator('#save-directory').inputValue(), path.join(root, 'saves', 'png'));
  await page.locator('#save-name').fill('hidden'); await page.locator('#save-directory').fill(pngDirectory);
  await page.locator('#confirm-save').click(); await page.waitForFunction(() => document.querySelector('#save-status').textContent.startsWith('已保存：'));
  await page.locator('#close-save-dialog').click();
  const hidden=await fs.readFile(path.join(pngDirectory,'hidden.png'));assert.equal(hidden.readUInt32BE(16),16384);assert.equal(hidden.readUInt32BE(20),8192);assert.notEqual(crypto.createHash('sha256').update(hidden).digest('hex'),visibleHash,'hidden borders must change the full-map PNG');
  console.log(`${environment}: full-map PNG dimensions and boundary visibility passed.`);
  // Loading must restore the saved state, not the later hidden-boundary state.
  await page.locator('#nav-home').click();
  await page.evaluate(text => window.MapProject.openText(text), initialText);
  await page.waitForFunction(() => document.querySelector('#paint-status').textContent.includes('快照已加载'));
  const restored = await page.evaluate(() => window.MapProject.capture());
  assert.deepEqual(restored.countries, saved.countries); assert.deepEqual(restored.painting, saved.painting);
  for (const key of ['zoom', 'adminLevel', 'paintLevel', 'boundariesHidden']) assert.equal(restored.view[key], saved.view[key]);
  assert.ok(Math.abs(restored.view.center.x - saved.view.center.x) < .002);
  assert.ok(Math.abs(restored.view.center.y - saved.view.center.y) < .002);
  assert.equal(await page.locator('#undo-map').isDisabled(), true);
  const invalid = { ...saved, map: { ...saved.map, sourceFingerprint: 'invalid' } };
  const rejected = await page.evaluate(async snapshot => { try { await window.MapProject.openText(JSON.stringify(snapshot)); return false; } catch { return true; } }, invalid);
  assert.equal(rejected, true);
  assert.deepEqual((await page.evaluate(() => window.MapProject.capture())).painting.owners, saved.painting.owners);
  // The reopened snapshot remains editable.
  await page.locator('#paint-level').selectOption('location');
  await page.locator('#erase-map').click();
  await page.mouse.click(p.x, p.y); await page.waitForTimeout(50);
  await page.evaluate(() => window.MapPainting.whenIdle());
  assert.equal((await page.evaluate(() => window.MapPainting.capture())).owners[samples.stockholm.id], undefined);
  assert.deepEqual(errors, []);
  console.log(`${environment}: independent snapshot/PNG paths, overwrite protection, restore, validation and continued editing passed.`);
}

(async () => {
  if (!process.env.SAVE_TEST_DESKTOP_ONLY) {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
      // Opening index.html directly has no Electron bridge or HTTP environment API.
      await page.goto(require('node:url').pathToFileURL(path.join(root, 'index.html')).href + '#map');
      await page.locator('#save-map').click();
      await page.waitForFunction(() => !document.querySelector('#save-name').disabled);
      assert.equal(await page.locator('#save-directory').inputValue(), path.join(root, 'saves', 'snapshots'));
      await page.locator('[name="save-type"][value="png"]').check();
      assert.equal(await page.locator('#save-directory').inputValue(), path.join(root, 'saves', 'png'));
      await page.locator('#save-directory').fill(path.join(root, 'output'));
      await page.locator('#close-save-dialog').click();
      await page.locator('#save-map').click();
      await page.waitForFunction(() => !document.querySelector('#save-name').disabled);
      assert.equal(await page.locator('#save-directory').inputValue(), path.join(root, 'saves', 'snapshots'));
      await page.locator('[name="save-type"][value="png"]').check();
      assert.equal(await page.locator('#save-directory').inputValue(), path.join(root, 'saves', 'png'));
      await page.screenshot({ path: path.join(root, 'output/save-defaults-local.png') });
      console.log('file: independent default folders and reopening passed.');
      await page.goto('http://127.0.0.1:4173/#map'); await check(page, 'browser');
    } finally { await browser.close(); }
  }
  const profile = path.join(root, '.cache', 'save-test-profile-' + run); await fs.mkdir(profile, { recursive: true });
  const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [root], env: { ...process.env, MAPDESIGNER_TEST_PROFILE: profile }, timeout: 30000 });
  try {
    const page = await app.firstWindow(); await page.evaluate(() => { location.hash = 'map'; });
    await check(page, 'desktop', app);
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
