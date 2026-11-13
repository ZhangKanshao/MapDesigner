const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium, _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const run = Date.now();
const testRoot = path.join(root, 'output', 'settings-tests', String(run));
async function check(page, kind, app) {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(() => window.AppSettings.ready);
  await page.locator('#open-settings').click(); await page.locator('#settings').waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-edit-shortcut]').count(), 12);
  assert.equal(await page.locator('[data-delete-shortcut]').count(), 12);
  async function edit(action, key) {
    await page.locator(`[data-edit-shortcut="${action}"]`).click();
    assert.equal(await page.locator('#shortcut-prompt').textContent(), '请输入新快捷键或组合键');
    await page.keyboard.press(key);
  }
  async function save() {
    await page.locator('#save-settings').click();
    await page.waitForFunction(() => document.querySelector('#settings-status').textContent === '设置已保存。' && !document.querySelector('#save-settings').disabled);
  }
  async function reset() {
    await page.locator('#reset-settings').click();
    await page.waitForFunction(() => document.querySelector('#settings-status').textContent === '当前分类已恢复默认设置并保存。' && !document.querySelector('#reset-settings').disabled);
  }
  await edit('erase', 'a');
  assert.ok((await page.locator('#shortcut-record-error').textContent()).includes('不能重复'));
  assert.equal(await page.locator('#shortcut-erase').inputValue(), 'E');
  await page.keyboard.press('r'); await page.locator('#shortcut-dialog').waitFor({ state: 'hidden' });
  await page.locator('[data-delete-shortcut="names"]').click();
  await page.locator('[data-delete-shortcut="boundaries"]').click();
  await save();
  const operations = await page.evaluate(() => window.AppSettings.get());
  assert.equal(operations.shortcuts.erase, 'KeyR'); assert.equal(operations.shortcuts.names, ''); assert.equal(operations.shortcuts.boundaries, '');
  assert.equal(operations.shortcuts.scrollUp, 'ArrowUp'); assert.equal(operations.operations.wheelMode, 'zoom');
  assert.equal(await page.locator('.settings-card #save-settings').count(), 0);
  const saveBox = await page.locator('#save-settings').boundingBox(), resetBox = await page.locator('#reset-settings').boundingBox();
  assert.equal(saveBox.width, resetBox.width); assert.equal(saveBox.height, resetBox.height); assert.ok(resetBox.x > saveBox.x);
  await page.screenshot({ path: path.join(root, `output/settings-${kind}-operations.png`), fullPage: true });
  const snapshots = path.join(testRoot, kind, 'custom-snapshots'), png = path.join(testRoot, kind, 'custom-png');
  await page.locator('#tab-files').click();
  await page.locator('#settings-snapshot').fill('relative-invalid'); await page.locator('#save-settings').click();
  await page.waitForFunction(() => document.querySelector('#settings-status').textContent.includes('完整'));
  await page.locator('#settings-snapshot').fill(snapshots); await page.locator('#settings-png').fill(png); await save();
  await fs.access(snapshots); await fs.access(png);
  assert.equal(await page.evaluate(() => window.AppSettings.get().shortcuts.erase), 'KeyR');
  await page.locator('#tab-appearance').click();
  await page.locator('#settings-theme').selectOption('dark'); await page.locator('#settings-font').selectOption('serif');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.ok((await page.locator('html').evaluate(e => getComputedStyle(e).fontFamily)).includes('SimSun'));
  assert.equal(await page.evaluate(() => window.AppSettings.get().appearance.theme), 'system');
  const fontBox = await page.locator('#settings-font').boundingBox(), previewBox = await page.locator('.settings-preview').boundingBox();
  assert.ok(previewBox.y > fontBox.y + fontBox.height);
  const card = await page.locator('.settings-card').boundingBox();
  assert.ok(Math.abs(fontBox.x + fontBox.width - (card.x + card.width - 33)) < 3);
  assert.equal(await page.locator('.settings-preview').evaluate(e => getComputedStyle(e).textAlign), 'center');
  await page.locator('#nav-home').click(); await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.locator('#open-settings').click(); await page.locator('#tab-appearance').click();
  assert.equal(await page.locator('#settings-theme').inputValue(), 'system');
  await page.locator('#settings-theme').selectOption('dark');
  await page.locator('#tab-files').click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await page.locator('#tab-appearance').click();
  assert.equal(await page.locator('#settings-theme').inputValue(), 'system');
  await page.locator('#settings-theme').selectOption('dark'); await page.locator('#settings-font').selectOption('serif'); await save();
  for (const [font, family] of [['kaiti','KaiTi'],['heiti','SimHei'],['fangsong','FangSong'],['arial','Arial'],['times','Times New Roman'],['mono','Consolas']]) {
    await page.locator('#settings-font').selectOption(font);
    assert.ok((await page.locator('html').evaluate(e => getComputedStyle(e).fontFamily)).includes(family));
    await save(); assert.equal(await page.evaluate(() => window.AppSettings.get().appearance.font), font);
  }
  await page.screenshot({ path: path.join(root, `output/settings-${kind}-dark.png`) });
  await page.reload(); await page.evaluate(() => window.AppSettings.ready);
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(await page.evaluate(() => window.AppSettings.get().shortcuts.names), '');
  assert.equal(await page.evaluate(() => window.AppSettings.get().files.snapshot), snapshots);
  await page.locator('#tab-appearance').click(); await reset();
  assert.equal(await page.locator('#settings-theme').inputValue(), 'system');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  assert.equal(await page.evaluate(() => window.AppSettings.get().files.snapshot), snapshots);
  assert.equal(await page.evaluate(() => window.AppSettings.get().shortcuts.erase), 'KeyR');
  assert.equal(await page.evaluate(() => window.AppSettings.get().appearance.font), 'system');
  await page.locator('#tab-files').click(); await reset();
  assert.equal(await page.locator('#settings-snapshot').inputValue(), path.join(root, 'saves', 'snapshots'));
  assert.equal(await page.evaluate(() => window.AppSettings.get().files.snapshot), path.join(root, 'saves', 'snapshots'));
  await page.reload(); await page.evaluate(() => window.AppSettings.ready);
  assert.equal(await page.evaluate(() => window.AppSettings.get().files.snapshot), path.join(root, 'saves', 'snapshots'));
  assert.equal(await page.evaluate(() => window.AppSettings.get().shortcuts.erase), 'KeyR');
  await page.locator('#tab-files').click();
  await page.locator('#settings-snapshot').fill(snapshots); await page.locator('#settings-png').fill(png); await save();

  await page.locator('#nav-home').click();
  await page.locator('#create-map').click(); await page.locator('#choose-eu5').click();
  await page.waitForFunction(() => location.hash === '#map' && !document.querySelector('#choose-eu5').disabled);
  await page.keyboard.press('e'); assert.equal(await page.locator('#erase-map').getAttribute('aria-pressed'), 'false');
  await page.keyboard.press('r'); assert.equal(await page.locator('#erase-map').getAttribute('aria-pressed'), 'true');
  await page.keyboard.press('a'); assert.equal(await page.locator('#toggle-names').getAttribute('aria-pressed'), 'false');
  await page.keyboard.press('r');
  await page.locator('#map-zoom').fill('1000'); await page.locator('#map-viewport').focus();
  await page.evaluate(async () => { await window.MapPainting.waitForRender(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); });
  await page.evaluate(() => { const v = document.querySelector('#map-viewport'); v.scrollLeft = 500; v.scrollTop = 500; });
  const scroll = () => page.locator('#map-viewport').evaluate(e => [e.scrollLeft, e.scrollTop]);
  const before = await scroll();
  await page.keyboard.press('ArrowRight'); assert.equal((await scroll())[0], before[0] + 120);
  await page.keyboard.press('ArrowLeft'); assert.equal((await scroll())[0], before[0]);
  await page.keyboard.press('ArrowDown'); assert.equal((await scroll())[1], before[1] + 120);
  await page.keyboard.press('ArrowUp'); assert.equal((await scroll())[1], before[1]);
  const view = await page.locator('#map-viewport').boundingBox();
  await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2); await page.mouse.wheel(0, -100);
  await page.waitForFunction(() => document.querySelector('#map-zoom').value === '1050');
  await page.keyboard.press('c'); await page.locator('#country-dialog').waitFor({ state: 'visible' });
  await page.locator('#country-name').fill('r'); assert.equal(await page.locator('#erase-map').getAttribute('aria-pressed'), 'false');
  await page.locator('#cancel-country').click();
  await page.keyboard.press('Control+s'); await page.locator('#save-dialog').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#save-name').disabled);
  assert.equal(await page.locator('#save-directory').inputValue(), snapshots);
  await page.locator('#save-name').fill('settings-test'); await page.locator('#confirm-save').click();
  await page.waitForFunction(() => document.querySelector('#save-status').textContent.startsWith('已保存：'));
  const source = path.join(snapshots, 'settings-test.mapdesign'); await fs.access(source);
  await page.locator('#close-save-dialog').click(); await page.locator('#nav-home').click(); await page.locator('#open-snapshot').click();
  await page.locator('.snapshot-entry').filter({ hasText: 'settings-test.mapdesign' }).waitFor();
  assert.equal(await page.locator('#snapshot-folder').textContent(), snapshots); await page.locator('#close-load-dialog').click();
  await page.locator('#open-settings').click(); await page.locator('#tab-operations').click();
  await page.locator('[data-delete-shortcut="scrollUp"]').click();
  await page.locator('#settings-wheel').selectOption('scroll'); await save();
  await page.evaluate(() => location.hash = 'map'); await page.locator('#map').waitFor({ state: 'visible' });
  const zoomBefore = await page.locator('#map-zoom').inputValue(), scrollBefore = await scroll();
  await page.locator('#map-viewport').focus(); await page.keyboard.press('ArrowUp'); assert.deepEqual(await scroll(), scrollBefore);
  await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2); await page.mouse.wheel(0, 140);
  await page.waitForFunction(top => document.querySelector('#map-viewport').scrollTop > top, scrollBefore[1]);
  assert.equal(await page.locator('#map-zoom').inputValue(), zoomBefore);
  await page.locator('#nav-home').click(); await page.locator('#open-settings').click(); await page.locator('#tab-operations').click();
  await reset();
  assert.equal(await page.locator('#shortcut-erase').inputValue(), 'E'); assert.equal(await page.locator('#settings-wheel').inputValue(), 'zoom');
  assert.equal(await page.evaluate(() => window.AppSettings.get().files.snapshot), snapshots);
  assert.equal(await page.evaluate(() => window.AppSettings.get().shortcuts.erase), 'KeyE');
  await page.reload(); await page.evaluate(() => window.AppSettings.ready);
  assert.equal(await page.evaluate(() => window.AppSettings.get().shortcuts.erase), 'KeyE');
  assert.deepEqual(errors, []);
  console.log(`${kind}: shortcut edit/conflicts/clear, arrows, wheel modes, category-only save/reset, appearance preview/revert, layout and persistence passed.`);
}

(async () => {
  const backend = require('./global-settings.cjs');
  const legacy = backend.initial(); delete legacy.operations;
  for (const key of ['scrollUp', 'scrollDown', 'scrollLeft', 'scrollRight']) delete legacy.shortcuts[key];
  legacy.shortcuts.names = 'ArrowUp'; legacy.shortcuts.erase = '';
  const upgraded = backend.validate(legacy);
  assert.equal(upgraded.shortcuts.names, 'ArrowUp'); assert.equal(upgraded.shortcuts.scrollUp, '');
  assert.equal(upgraded.shortcuts.erase, ''); assert.equal(upgraded.operations.wheelMode, 'zoom');
  await fs.mkdir(testRoot, { recursive: true });
  const server = spawn(process.execPath, ['scripts/preview.cjs'], { cwd: root, windowsHide: true, env: { ...process.env, MAPDESIGNER_PREVIEW_PORT: '4181', MAPDESIGNER_SETTINGS_FILE: path.join(testRoot, 'browser-settings.json') }, stdio: 'pipe' });
  try {
    await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); server.once('exit', code => reject(new Error('test server exited '+code))); });
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
      await page.goto('http://127.0.0.1:4181/#home'); await check(page, 'browser');
      const local = await browser.newPage({ viewport: { width: 1000, height: 760 } });
      await local.goto(require('node:url').pathToFileURL(path.join(root, 'index.html')).href + '#settings');
      await local.evaluate(() => window.AppSettings.ready);
      await local.locator('#tab-files').click();
      const localFolder = path.join(testRoot, 'local-snapshots');
      await local.locator('#settings-snapshot').fill(localFolder);
      await local.locator('#save-settings').click();
      await local.waitForFunction(() => document.querySelector('#settings-status').textContent === '设置已保存。');
      await local.locator('#tab-appearance').click();
      await local.locator('#settings-theme').selectOption('system');
      await local.locator('#save-settings').click();
      await local.waitForFunction(() => document.querySelector('#settings-status').textContent === '设置已保存。');
      await local.emulateMedia({ colorScheme: 'dark' });
      await local.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
      await local.emulateMedia({ colorScheme: 'light' });
      await local.waitForFunction(() => document.documentElement.dataset.theme === 'light');
      await local.reload(); await local.evaluate(() => window.AppSettings.ready);
      assert.equal(await local.evaluate(() => window.AppSettings.get().files.snapshot), localFolder);
      assert.equal(await local.evaluate(() => document.body.scrollWidth > innerWidth), false);
      console.log('file: local settings persistence, custom path, system theme changes and compact layout passed.');
    }
    finally { await browser.close(); }
  } finally { server.kill(); }
  const profile = path.join(testRoot, 'desktop-profile'); await fs.mkdir(profile, { recursive: true });
  const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [root], env: { ...process.env, MAPDESIGNER_TEST_PROFILE: profile, MAPDESIGNER_SETTINGS_FILE: path.join(testRoot, 'desktop-settings.json') } });
  try { await check(await app.firstWindow(), 'desktop'); } finally { await app.close(); }
})().catch(e => { console.error(e); process.exitCode=1; });
