const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const samples = require('../assets/maps/eu5/lookup/paint-report.json').samples;

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const url of [pathToFileURL(path.resolve(__dirname, '../index.html')).href + '#map', 'http://127.0.0.1:4173/#map']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(url);
      await page.waitForFunction(() => document.querySelector('#basemap').naturalWidth === 16384);
      async function settle() {
        await page.waitForFunction(() => document.querySelector('#paint-layer').dataset.busy !== 'true' && document.querySelector('#paint-layer').dataset.rendered === 'true');
      }
      async function create(name) {
        await page.locator('#create-country').click(); await page.locator('#country-name').fill(name);
        await page.locator('#confirm-country').click(); await settle();
      }
      async function undo() { await page.locator('#undo-map').click(); await settle(); }
      async function data() { return page.evaluate(() => JSON.parse(localStorage.getItem('mapdesigner.eu5.paint.v1') || '{}')); }
      async function clickSample(sample) {
        await page.locator('#map-viewport').evaluate((view, sample) => {
          const img = document.querySelector('#basemap');
          view.scrollLeft = img.width * (sample.x + .5) / 16384 - view.clientWidth / 2;
          view.scrollTop = img.height * (sample.y + .5) / 8192 - view.clientHeight / 2;
        }, sample);
        await settle();
        const point = await page.locator('#basemap').evaluate((img, sample) => {
          const r = img.getBoundingClientRect();
          return { x: r.left + r.width * (sample.x + .5) / 16384, y: r.top + r.height * (sample.y + .5) / 8192 };
        }, sample);
        await page.mouse.click(point.x, point.y); await page.waitForTimeout(30); await settle();
      }
      assert.equal(await page.locator('#undo-map').isDisabled(), true);
      assert.equal(await page.locator('#zoom-reset').count(), 0);
      assert.equal(await page.locator('.settings-group [role="switch"]').count(), 3);
      assert.equal(await page.locator('.operations-group #erase-map').count(), 1);
      assert.equal(await page.locator('.operations-group #toggle-names').count(), 1);
      assert.equal(await page.locator('.operations-group #undo-map').count(), 1);
      await page.locator('#toggle-wasteland').click(); await settle();
      assert.equal(await page.locator('#undo-map').isDisabled(), true);
      await page.locator('#toggle-wasteland').click(); await settle();
      assert.equal(await page.locator('#undo-map').isDisabled(), true);
      await page.locator('#toggle-boundaries').click();
      assert.equal(await page.locator('#toggle-boundaries').getAttribute('aria-checked'), 'true');
      await page.waitForFunction(() => document.querySelector('#map-message').hidden);
      await page.locator('#toggle-boundaries').click();
      await page.waitForFunction(() => document.querySelector('#map-message').hidden);
      assert.equal(await page.locator('#undo-map').isDisabled(), true);
      assert.equal((await page.locator('#erase-map').textContent()).trim(), '');
      assert.equal((await page.locator('#undo-map').textContent()).trim(), '');
      await create('甲国'); await create('乙国');
      await undo(); assert.equal(await page.locator('.country-list-item').count(), 1);
      await undo(); assert.equal(await page.locator('.country-list-item').count(), 0);
      assert.equal(await page.locator('#undo-map').isDisabled(), true);
      await create('甲国');
      const first = await page.evaluate(() => window.CountryStore.list()[0]);
      await page.locator('.country-select').click(); await page.locator('#country-name').fill('甲国改名');
      await page.locator('#confirm-country').click(); await settle();
      await undo(); assert.equal(await page.locator('.country-name').textContent(), '甲国');
      await page.locator('.country-brush').click();
      assert.ok((await page.locator('#map-surface').evaluate(el => getComputedStyle(el).cursor)).includes('brush-cursor.svg'));
      await page.locator('#map-zoom').fill('1000');
      await page.locator('#paint-level').selectOption('province');
      await clickSample(samples.stockholm);
      const province = (await data()).owners;
      assert.ok(Object.keys(province).length > 1);
      await clickSample(samples.stockholm); // No-op must not consume an undo step.
      await undo(); assert.equal(Object.keys((await data()).owners).length, 0);
      await page.locator('#paint-level').selectOption('location');
      await clickSample(samples.stockholm);
      await create('乙国');
      await page.locator('.country-brush').nth(1).click(); await clickSample(samples.stockholm);
      assert.notEqual((await data()).owners[samples.stockholm.id], first.id);
      await undo(); assert.equal((await data()).owners[samples.stockholm.id], first.id);
      await undo(); assert.equal(await page.locator('.country-list-item').count(), 1);
      await page.locator('#erase-map').click();
      assert.ok((await page.locator('#map-surface').evaluate(el => getComputedStyle(el).cursor)).includes('eraser-cursor.svg'));
      await clickSample(samples.stockholm); assert.equal((await data()).owners[samples.stockholm.id], undefined);
      await undo(); assert.equal((await data()).owners[samples.stockholm.id], first.id);
      await page.locator('.country-brush').click();
      await page.locator('#toggle-wasteland').click(); await settle();
      assert.equal(await page.locator('#toggle-wasteland').getAttribute('aria-checked'), 'true');
      await page.waitForTimeout(200);
      const on = await page.locator('#toggle-wasteland .switch-thumb').evaluate(el => getComputedStyle(el).transform);
      await clickSample(samples.skanderna);
      await page.locator('#toggle-wasteland').click(); await settle();
      assert.equal((await data()).owners[samples.skanderna.id], undefined);
      await undo(); assert.equal((await data()).wastelandEnabled, false);
      assert.equal((await data()).owners[samples.skanderna.id], undefined);
      assert.equal((await data()).owners[samples.stockholm.id], undefined);
      await clickSample(samples.stockholm);
      await page.waitForTimeout(200);
      const off = await page.locator('#toggle-wasteland .switch-thumb').evaluate(el => getComputedStyle(el).transform);
      assert.notEqual(on, off);
      await page.locator('.country-select').click(); await page.locator('#delete-country').click(); await settle();
      assert.equal(await page.locator('.country-list-item').count(), 0);
      assert.equal(Object.keys((await data()).owners).length, 0);
      await undo(); assert.equal(await page.locator('.country-list-item').count(), 1);
      assert.equal((await data()).owners[samples.stockholm.id], first.id);
      await page.screenshot({ path: 'output/history-toolbar-page.png' });
      await page.keyboard.press('Control+z'); await settle();
      assert.equal((await data()).owners[samples.stockholm.id], undefined);
      const baselineCount = await page.locator('.country-list-item').count();
      for (let i = 0; i < 31; i++) await create(`历史上限测试${i}`);
      for (let i = 0; i < 30; i++) await undo();
      assert.equal(await page.locator('#undo-map').isDisabled(), true);
      assert.equal(await page.locator('.country-list-item').count(), baselineCount + 1);
      assert.deepEqual(errors, []);
      console.log(`Icon cursors/buttons, sliding switch, multi-step undo, batch/no-op/transfer/erase/wasteland/country restore and Ctrl+Z passed: ${url}`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
