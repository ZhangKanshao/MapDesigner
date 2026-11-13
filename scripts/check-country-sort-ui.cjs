const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const url of [pathToFileURL(path.resolve('index.html')).href + '#map', 'http://127.0.0.1:4173/#map']) {
      const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
      const page = await context.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(url);
      await page.waitForFunction(() => document.querySelector('#basemap').naturalWidth === 16384);
      await page.evaluate(() => {
        window.CountryStore.restore(Array.from({ length: 5 }, (_, i) => ({ id: `sort-${i}`, name: `国家 ${i}`, description: '', color: '#' + (0x123400 + i).toString(16) })));
        window.CountryStore.select('sort-2');
      });
      const order = () => page.evaluate(() => window.CountryStore.list().map(c => c.id));
      const chip = id => page.locator(`[data-country-id="${id}"] .country-select`);
      const original = await order();
      const last = await chip('sort-4').boundingBox();
      await chip('sort-0').dragTo(chip('sort-4'), { targetPosition: { x: 30, y: last.height - 2 } });
      assert.deepEqual(await order(), ['sort-1', 'sort-2', 'sort-3', 'sort-4', 'sort-0']);
      assert.equal(await page.evaluate(() => window.CountryStore.selected()), 'sort-2');
      await chip('sort-0').dragTo(chip('sort-1'), { targetPosition: { x: 30, y: 2 } });
      assert.deepEqual(await order(), original);
      await page.evaluate(() => window.MapPainting.whenIdle());
      await page.locator('#undo-map').click();
      await page.evaluate(() => window.MapPainting.whenIdle());
      const sorted = ['sort-1', 'sort-2', 'sort-3', 'sort-4', 'sort-0'];
      assert.deepEqual(await order(), sorted);
      const snapshot = await page.evaluate(() => window.MapProject.capture());
      assert.deepEqual(snapshot.countries.map(c => c.id), sorted);
      await page.reload();
      assert.deepEqual(await order(), sorted);
      await page.evaluate(() => window.CountryStore.restore([]));
      await page.evaluate(snapshot => window.MapProject.openText(JSON.stringify(snapshot)), snapshot);
      assert.deepEqual(await order(), sorted);
      // A long list scrolls while the pointer is held at its lower edge.
      await page.evaluate(() => {
        window.CountryStore.restore(Array.from({ length: 35 }, (_, i) => ({ id: `long-${i}`, name: `长列表 ${i}`, description: '', color: '#' + (0x345600 + i).toString(16) })));
        document.querySelector('.country-panel-scroll').scrollTop = 0;
      });
      const start = await chip('long-0').boundingBox();
      const panel = await page.locator('.country-panel-scroll').boundingBox();
      await page.mouse.move(start.x + 30, start.y + start.height / 2);
      await page.mouse.down();
      await page.mouse.move(start.x + 35, start.y + start.height / 2 + 8, { steps: 3 });
      await page.mouse.move(panel.x + panel.width / 2, panel.y + panel.height - 4, { steps: 12 });
      await page.waitForTimeout(650);
      assert.ok(await page.locator('.country-panel-scroll').evaluate(e => e.scrollTop > 60));
      await page.mouse.move(panel.x + panel.width / 2 + 1, panel.y + panel.height - 5);
      await page.mouse.up();
      assert.notEqual((await order())[0], 'long-0');
      assert.equal((await order()).length, 35);
      assert.deepEqual(errors, []);
      console.log(`Country dragging up/down, selection, undo, persistence, snapshot and auto-scroll passed: ${url}`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
