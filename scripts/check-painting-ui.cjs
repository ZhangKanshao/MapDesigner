const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const samples = require('../assets/maps/eu5/lookup/paint-report.json').samples;

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const url of [pathToFileURL(path.resolve(__dirname, '../index.html')).href + '#map', 'http://127.0.0.1:4173/#map']) {
      const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(url);
      await page.waitForFunction(() => document.querySelector('#basemap').naturalWidth === 16384);
      async function createCountry(name, rgb) {
        await page.locator('#create-country').click();
        await page.locator('#country-name').fill(name);
        await page.locator('#country-color-swatch').click();
        for (const [i, channel] of ['red', 'green', 'blue'].entries()) await page.locator(`#country-${channel}`).fill(String(rgb[i]));
        await page.locator('#confirm-country').click();
      }
      async function settle() {
        await page.waitForFunction(() => document.querySelector('#paint-layer').dataset.busy !== 'true' && document.querySelector('#paint-layer').dataset.rendered === 'true');
      }
      async function center(sample) {
        await page.locator('#map-viewport').evaluate((view, sample) => {
          const image = document.querySelector('#basemap');
          view.scrollLeft = image.width * (sample.x + .5) / 16384 - view.clientWidth / 2;
          view.scrollTop = image.height * (sample.y + .5) / 8192 - view.clientHeight / 2;
        }, sample);
        await settle();
        return page.locator('#basemap').evaluate((image, sample) => {
          const r = image.getBoundingClientRect();
          return { x: r.left + r.width * (sample.x + .5) / 16384, y: r.top + r.height * (sample.y + .5) / 8192 };
        }, sample);
      }
      async function clickSample(sample) {
        const p = await center(sample);
        await page.mouse.click(p.x, p.y);
        await page.waitForTimeout(80);
        await settle();
      }
      async function owners() { return page.evaluate(() => JSON.parse(localStorage.getItem('mapdesigner.eu5.paint.v1') || '{}').owners || {}); }
      async function screenPixel(point) {
        const buffer = await page.screenshot({ clip: { x: Math.floor(point.x), y: Math.floor(point.y), width: 1, height: 1 }, scale: 'css' });
        return page.evaluate(async bytes => {
          const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
          const c = document.createElement('canvas'); c.width = c.height = 1;
          const context = c.getContext('2d'); context.drawImage(bitmap, 0, 0);
          return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
        }, [...buffer]);
      }
      await createCountry('第一国', [180, 70, 90]);
      await createCountry('第二国', [60, 140, 90]);
      const countries = await page.evaluate(() => window.CountryStore.list());
      assert.equal(await page.locator('.country-select').count(), 2);
      const plus = await page.locator('#create-country').boundingBox();
      const pencil = await page.locator('.country-capital').first().boundingBox();
      assert.ok(plus.x + plus.width >= pencil.x + pencil.width);
      await page.locator('.country-brush').first().click();
      await page.locator('#map-zoom').fill('2000');
      await page.locator('#toggle-boundaries').click();
      await page.waitForFunction(() => new URL(document.querySelector('#basemap').src).pathname.endsWith('basemap-no-borders.png'));
      await clickSample(samples.stockholm);
      assert.equal((await owners())[samples.stockholm.id], countries[0].id);
      let point = await center(samples.stockholm);
      const color = await screenPixel(point);
      assert.ok(color.every((channel, i) => Math.abs(channel - [180, 70, 90][i]) < 4), `painted pixel ${color}`);
      // Sea click changes nothing; dragging while selected must only pan.
      const countBeforeSea = Object.keys(await owners()).length;
      await clickSample(samples.sea);
      assert.equal(Object.keys(await owners()).length, countBeforeSea);
      point = await center(samples.uppsala);
      await page.mouse.move(point.x, point.y); await page.mouse.down();
      await page.mouse.move(point.x - 50, point.y - 30, { steps: 5 }); await page.mouse.up();
      await settle();
      assert.equal((await owners())[samples.uppsala.id], undefined);
      // Province fill includes other locations; erasing uses the independent fill grain.
      await page.locator('#paint-level').selectOption('province');
      await clickSample(samples.stockholm);
      assert.equal((await owners())[samples.uppsala.id], countries[0].id);
      assert.equal(await page.locator('#admin-level').inputValue(), 'location');
      await page.locator('#erase-map').click();
      await clickSample(samples.stockholm);
      assert.equal((await owners())[samples.stockholm.id], undefined);
      assert.equal((await owners())[samples.uppsala.id], undefined);
      // All five parent grains fill precisely the chosen membership, excluding water/wasteland.
      await page.locator('.country-brush').first().click();
      for (const level of ['area', 'region', 'subcontinent', 'continent']) {
        await page.locator('#paint-level').selectOption(level);
        await clickSample(samples.stockholm);
        const valid = await page.evaluate(({ id, level, country }) => {
          const data = window.MapDesignerData;
          const index = data.meta.parentOrder.indexOf(level);
          const parent = data.meta.locations[id][2][index];
          const entries = Object.entries(JSON.parse(localStorage.getItem('mapdesigner.eu5.paint.v1')).owners);
          return entries.length > 1 && entries.every(([location, owner]) => owner === country && data.meta.locations[location][2][index] === parent && data.paintMeta.kinds[location] === 0);
        }, { id: samples.stockholm.id, level, country: countries[0].id });
        assert.equal(valid, true, `${level} group membership`);
        await page.locator('#erase-map').click(); await clickSample(samples.stockholm);
        assert.equal(Object.keys(await owners()).length, 0);
        await page.locator('.country-brush').first().click();
      }
      // Wasteland is opt-in; switching off permanently removes only wasteland ownership.
      await page.locator('#paint-level').selectOption('location');
      await clickSample(samples.stockholm);
      await clickSample(samples.skanderna);
      assert.equal((await owners())[samples.skanderna.id], undefined);
      await page.locator('#toggle-wasteland').click(); await settle();
      await clickSample(samples.skanderna);
      assert.equal((await owners())[samples.skanderna.id], countries[0].id);
      let wastePoint = await center(samples.skanderna);
      const paintedWaste = await screenPixel(wastePoint);
      assert.ok(paintedWaste.every((channel, i) => Math.abs(channel - [180, 70, 90][i]) < 4));
      await page.locator('#toggle-wasteland').click(); await settle();
      assert.equal((await owners())[samples.skanderna.id], undefined);
      assert.equal((await owners())[samples.stockholm.id], countries[0].id);
      wastePoint = await center(samples.skanderna);
      assert.deepEqual(await screenPixel(wastePoint), [222, 222, 222]);
      // A river pixel stays unchanged even when its location is assigned to a country.
      point = await center(samples.river);
      const riverBefore = await screenPixel(point);
      await clickSample(samples.river);
      point = await center(samples.river);
      const riverAfter = await screenPixel(point);
      assert.ok(riverAfter.every((channel, i) => Math.abs(channel - riverBefore[i]) < 12), `river protected: ${riverBefore} / ${riverAfter}`);
      // Country edits keep ownership IDs and recolor existing land.
      await page.locator('.country-select').first().click();
      assert.equal(await page.locator('#country-name').inputValue(), '第一国');
      await page.locator('#country-name').fill('第一国新名称');
      await page.locator('#country-color-swatch').click();
      for (const [i, channel] of ['red', 'green', 'blue'].entries()) await page.locator(`#country-${channel}`).fill(String([120, 90, 190][i]));
      await page.locator('#confirm-country').click(); await settle();
      point = await center(samples.stockholm);
      const edited = await screenPixel(point);
      assert.ok(edited.every((channel, i) => Math.abs(channel - [120, 90, 190][i]) < 4));
      await page.locator('.country-brush').nth(1).click();
      await clickSample(samples.uppsala);
      await page.screenshot({ path: 'output/painted-countries-page.png' });
      await page.reload();
      await page.waitForFunction(() => document.querySelector('#paint-layer').dataset.rendered === 'true');
      assert.equal((await owners())[samples.stockholm.id], countries[0].id);
      assert.equal((await owners())[samples.uppsala.id], countries[1].id);
      await page.locator('.country-select').first().click();
      await page.locator('#delete-country').click(); await settle();
      assert.equal(await page.locator('.country-list-item').count(), 1);
      assert.equal((await owners())[samples.stockholm.id], undefined);
      assert.equal((await owners())[samples.uppsala.id], countries[1].id);
      assert.deepEqual(errors, []);
      console.log(`Edit/delete, paint, parent grains, erase, wasteland reset, protected river/sea and persistence passed: ${url}`);
      await ctx.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
