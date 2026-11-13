const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const run = Date.now();
const samples = require('../assets/maps/eu5/lookup/paint-report.json').samples;
async function check(page, kind, app) {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const name = `home-test-${run}-${kind}`;
  const source = path.join(root, 'output', name + '.mapdesign');
  const folder = path.join(root, 'saves', 'snapshots');
  const imported = path.join(folder, name + '.mapdesign');
  const duplicate = path.join(folder, name + ' (2).mapdesign');
  try {
    assert.equal(await page.locator('#home .home-action').count(), 4);
    assert.equal(await page.locator('#home .hero,#home .intro,#home .steps').count(), 0);
    await page.screenshot({ path: path.join(root, `output/home-${kind}.png`) });
    await page.locator('#create-map').click();
    await page.locator('#choose-eu5').click();
    await page.waitForFunction(() => !document.querySelector('#choose-eu5').disabled && location.hash === '#map');
    assert.equal(await page.locator('.country-list-item').count(), 0);
    await page.evaluate(async sample => {
      window.CountryStore.restore([{ id: 'home-test-country', name: '载入国家', description: '保留介绍', color: '#123456' }]);
      await window.MapPainting.restore({ owners: { [sample.id]: 'home-test-country' }, wastelandEnabled: false, mode: 'paint', selectedCountry: 'home-test-country' });
    }, samples.stockholm);
    const snapshot = await page.evaluate(() => window.MapProject.capture());
    const text = JSON.stringify(snapshot, null, 2);
    await fs.writeFile(source, text);
    await page.locator('#nav-home').click();
    async function importFile() {
      if (app) {
        await app.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }); }, source);
        await page.locator('#import-snapshot').click();
      } else {
        const chooser = page.waitForEvent('filechooser'); await page.locator('#import-snapshot').click();
        await (await chooser).setFiles(source);
      }
      await page.waitForFunction(() => document.querySelector('#project-open-status').textContent.startsWith('已导入：'));
      await page.waitForFunction(() => !document.querySelector('#import-snapshot').disabled);
    }
    await importFile();
    assert.equal(await fs.readFile(imported, 'utf8'), text);
    assert.equal(await page.evaluate(() => location.hash), '#home');
    await page.evaluate(() => document.querySelector('#project-open-status').textContent = '');
    await importFile();
    assert.equal(await fs.readFile(imported, 'utf8'), text);
    assert.equal(await fs.readFile(duplicate, 'utf8'), text);
    await page.locator('#create-map').click(); await page.locator('#choose-eu5').click();
    await page.waitForFunction(() => !document.querySelector('#choose-eu5').disabled && location.hash === '#map');
    assert.equal(await page.locator('.country-list-item').count(), 0);
    const blank = await page.evaluate(() => window.MapProject.capture());
    assert.deepEqual(blank.painting.owners, {}); assert.equal(blank.painting.selectedCountry, null);
    assert.equal(blank.view.zoom, 100); assert.equal(blank.view.boundariesHidden, false);
    await page.locator('#nav-home').click(); await page.locator('#open-snapshot').click();
    const entry = page.locator('.snapshot-entry').filter({ has: page.locator('strong', { hasText: new RegExp('^' + name + '\\.mapdesign$') }) });
    await entry.waitFor();
    assert.equal(await page.locator('#snapshot-folder').textContent(), folder);
    await page.screenshot({ path: path.join(root, `output/load-library-${kind}.png`) });
    await entry.click();
    await page.locator('#load-selected-snapshot').click();
    await page.waitForFunction(() => !document.querySelector('#load-dialog').open && location.hash === '#map');
    const loaded = await page.evaluate(() => window.MapProject.capture());
    assert.deepEqual(loaded.countries, snapshot.countries); assert.deepEqual(loaded.painting.owners, snapshot.painting.owners);
    // Import validates without replacing the currently edited map.
    await page.locator('#nav-home').click();
    const invalid = path.join(root, 'output', name + '-invalid.mapdesign');
    await fs.writeFile(invalid, JSON.stringify({ ...snapshot, map: { id: 'invalid' } }));
    if (app) {
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, invalid);
      await page.locator('#import-snapshot').click();
    } else await page.locator('#snapshot-input').setInputFiles(invalid);
    await page.waitForFunction(() => document.querySelector('#project-open-status').textContent.startsWith('导入失败：'));
    assert.equal(await fs.stat(path.join(folder, name + '-invalid.mapdesign')).then(() => true, () => false), false);
    assert.deepEqual(await page.evaluate(() => window.CountryStore.list()), snapshot.countries);
    assert.deepEqual(errors, []);
    console.log(`${kind}: simple home, blank creation, exact import, collision handling, default-folder loading and invalid snapshot rejection passed.`);
  } finally {
    for (const file of [imported, duplicate]) await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
    await page.goto('http://127.0.0.1:4173/#home'); await check(page, 'browser');
  } finally { await browser.close(); }
  const profile = path.join(root, '.cache', 'home-test-' + run); await fs.mkdir(profile, { recursive: true });
  const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [root], env: { ...process.env, MAPDESIGNER_TEST_PROFILE: profile } });
  try { await check(await app.firstWindow(), 'desktop', app); } finally { await app.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
