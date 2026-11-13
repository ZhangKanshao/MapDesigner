const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const url of [pathToFileURL(path.resolve(__dirname, '../index.html')).href + '#map', 'http://127.0.0.1:4173/#map']) {
      await page.goto(url);
      await page.waitForFunction(() => document.querySelector('#basemap').naturalWidth === 16384);
      await page.locator('#zoom-in').click();
      assert.equal(await page.locator('#zoom-value').textContent(), '105%');
      await page.locator('#map-zoom').fill('200');
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => {
        const view = document.querySelector('#map-viewport');
        view.scrollLeft = 300;
        return view.scrollWidth > view.clientWidth && view.scrollLeft > 0;
      }), true);
      await page.screenshot({ path: 'output/zoom-map-page.png' });
      const mapBounds = await page.locator('#map-viewport').boundingBox();
      const start = { x: mapBounds.x + mapBounds.width / 2, y: mapBounds.y + mapBounds.height / 2 };
      const beforeDrag = await page.locator('#map-viewport').evaluate(el => [el.scrollLeft, el.scrollTop]);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x - 80, start.y - 50, { steps: 5 });
      await page.mouse.up();
      const afterDrag = await page.locator('#map-viewport').evaluate(el => [el.scrollLeft, el.scrollTop]);
      assert.ok(Math.abs(afterDrag[0] - beforeDrag[0] - 80) < 2, 'horizontal drag');
      assert.ok(Math.abs(afterDrag[1] - beforeDrag[1] - 50) < 2, 'vertical drag');
      await page.mouse.move(start.x + 40, start.y + 40);
      assert.deepEqual(await page.locator('#map-viewport').evaluate(el => [el.scrollLeft, el.scrollTop]), afterDrag);
      assert.equal(await page.locator('#map-viewport').evaluate(el => el.classList.contains('is-dragging')), false);
      await page.locator('#map-zoom').fill('1995');
      await page.locator('#zoom-in').click();
      assert.equal(await page.locator('#zoom-value').textContent(), '2000%');
      assert.equal(await page.locator('#zoom-in').isDisabled(), true);
      await page.locator('#map-zoom').fill('100');
      assert.equal(await page.locator('#zoom-out').isDisabled(), true);
      await page.locator('#map-zoom').fill('100');
      assert.equal(await page.locator('#zoom-value').textContent(), '100%');
      await page.locator('#back-templates').click();
      await page.locator('#choose-eu5').click();
      await page.setViewportSize({ width: 1000, height: 700 });
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => document.body.scrollWidth > innerWidth), false);
      await page.screenshot({ path: 'output/zoom-map-fit.png' });
      await page.setViewportSize({ width: 1440, height: 920 });
      await page.locator('#map-zoom').fill('300');
      for (const level of ['province', 'area', 'region', 'subcontinent', 'continent', 'location']) {
        const expected = level === 'location' ? 'basemap.png' : `basemap-${level}.png`;
        const before = await page.locator('#map-viewport').evaluate(el => [el.scrollLeft, el.scrollTop]);
        await page.locator('#admin-level').selectOption(level);
        await page.waitForFunction(filename => {
          const image = document.querySelector('#basemap');
          return new URL(image.src).pathname.endsWith(filename) && image.complete && image.naturalWidth === 16384 && document.querySelector('#map-message').hidden;
        }, expected);
        assert.equal(await page.locator('#zoom-value').textContent(), '300%');
        const after = await page.locator('#map-viewport').evaluate(el => [el.scrollLeft, el.scrollTop]);
        assert.ok(after.every((value, i) => Math.abs(value - before[i]) < 3), `view moved at ${level}`);
        assert.equal(await page.locator('#admin-legend').isVisible(), level !== 'location');
      }
      // A slow prior request must not replace the user's latest selection.
      await page.evaluate(() => {
        const select = document.querySelector('#admin-level');
        for (const value of ['province', 'continent', 'area']) {
          select.value = value;
          select.dispatchEvent(new Event('change'));
        }
      });
      await page.waitForFunction(() => new URL(document.querySelector('#basemap').src).pathname.endsWith('basemap-area.png') && document.querySelector('#map-message').hidden);
      await page.locator('#map-zoom').fill('500');
      await page.locator('#map-viewport').evaluate(el => {
        const image = document.querySelector('#basemap');
        el.scrollLeft = image.width * 8000 / 16384 - el.clientWidth / 2;
        el.scrollTop = image.height * 2300 / 8192 - el.clientHeight / 2;
      });
      await page.screenshot({ path: 'output/admin-map-page.png' });
      await page.locator('#admin-level').selectOption('location');
      await page.waitForFunction(() => document.querySelector('#basemap').src.endsWith('/basemap.png') && document.querySelector('#map-message').hidden);
      await page.locator('#map-zoom').fill('100');
      // Border visibility is independent of the selected naming granularity.
      await page.locator('#toggle-boundaries').click();
      await page.waitForFunction(() => new URL(document.querySelector('#basemap').src).pathname.endsWith('basemap-no-borders.png') && document.querySelector('#map-message').hidden);
      assert.equal(await page.locator('#location-legend').isVisible(), false);
      await page.locator('#map-zoom').fill('1000');
      const sample = require('../assets/maps/eu5/lookup/report.json').samples.stockholm;
      await page.locator('#map-viewport').evaluate((el, sample) => {
        const map = document.querySelector('#basemap');
        el.scrollLeft = map.width * (sample.x + .5) / 16384 - el.clientWidth / 2;
        el.scrollTop = map.height * (sample.y + .5) / 8192 - el.clientHeight / 2;
      }, sample);
      await page.locator('#toggle-names').click();
      const samplePoint = await page.locator('#basemap').evaluate((el, sample) => {
        const rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width * (sample.x + .5) / 16384, y: rect.top + rect.height * (sample.y + .5) / 8192 };
      }, sample);
      await page.mouse.move(samplePoint.x, samplePoint.y);
      const expectedNames = { location: '斯德哥尔摩', province: '乌普兰', area: '斯韦阿兰', region: '斯堪的纳维亚', subcontinent: '西欧', continent: '欧洲' };
      for (const [level, name] of Object.entries(expectedNames)) {
        await page.locator('#admin-level').selectOption(level);
        await page.waitForFunction(() => document.querySelector('#map-message').hidden);
        await page.mouse.move(samplePoint.x + 1, samplePoint.y);
        await page.mouse.move(samplePoint.x, samplePoint.y);
        await page.waitForFunction(expected => !document.querySelector('#name-tooltip').hidden && document.querySelector('#name-tooltip-label').textContent === expected, name);
        assert.equal(await page.locator('#map-viewport').evaluate(el => el.classList.contains('name-mode')), true);
      }
      await page.screenshot({ path: 'output/map-name-mode.png' });
      await page.locator('#toggle-boundaries').click();
      await page.waitForFunction(() => new URL(document.querySelector('#basemap').src).pathname.endsWith('basemap-continent.png') && document.querySelector('#map-message').hidden);
      await page.locator('#toggle-names').click();
      assert.equal(await page.locator('#name-tooltip').isVisible(), false);
      assert.equal(await page.locator('#map-viewport').evaluate(el => el.classList.contains('name-mode')), false);
      await page.locator('#admin-level').selectOption('location');
      await page.waitForFunction(() => new URL(document.querySelector('#basemap').src).pathname.endsWith('/basemap.png') && document.querySelector('#map-message').hidden);
      await page.locator('#map-zoom').fill('100');
      console.log(`Passed: ${url}`);
    }
    assert.deepEqual(errors, []);
    console.log('Map loading, zoom, all six administrative levels, view preservation and rapid switching passed.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
