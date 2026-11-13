const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const url of [pathToFileURL(path.resolve(__dirname, '../index.html')).href + '#map', 'http://127.0.0.1:4173/#map']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(url);
      assert.equal(await page.locator('.country-panel #create-country').count(), 1);
      assert.equal(await page.locator('.map-tools #create-country').count(), 0);
      assert.equal(await page.locator('#country-count').count(), 0);
      assert.equal(await page.locator('.country-panel').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(255, 255, 255, 0.7)');
      await page.locator('#create-country').click();
      await page.locator('#country-name').fill(' 测试王国 ');
      await page.locator('#country-description').fill('这是一段国家介绍。');
      await page.locator('#country-color-swatch').click();
      for (const [id, value] of [['red', 12], ['green', 34], ['blue', 56]]) await page.locator(`#country-${id}`).fill(String(value));
      await page.screenshot({ path: 'output/create-country-dialog.png' });
      await page.locator('#confirm-country').click();
      assert.equal(await page.locator('#country-dialog').isVisible(), false);
      assert.equal(await page.locator('.country-list-item').count(), 1);
      assert.equal(await page.locator('.country-list-item').textContent(), '测试王国');
      assert.equal(await page.locator('.country-list-swatch').evaluate(el => el.style.backgroundColor), 'rgb(12, 34, 56)');
      assert.equal(await page.locator('.country-list-item').getAttribute('title'), '这是一段国家介绍。');
      // Neither duplicate names nor duplicate RGB colors can create an entry.
      await page.locator('#create-country').click();
      await page.locator('#country-name').fill('测试王国');
      await page.locator('#confirm-country').click();
      assert.equal(await page.locator('#country-name-error').isVisible(), true);
      assert.equal(await page.locator('.country-list-item').count(), 1);
      await page.locator('#country-name').fill('第二王国');
      await page.locator('#country-color-swatch').click();
      for (const [id, value] of [['red', 12], ['green', 34], ['blue', 56]]) await page.locator(`#country-${id}`).fill(String(value));
      await page.locator('#confirm-country').click();
      assert.equal(await page.locator('#country-color-error').isVisible(), true);
      assert.equal(await page.locator('.country-list-item').count(), 1);
      await page.locator('#country-red').fill('256');
      await page.locator('#confirm-country').click();
      assert.ok((await page.locator('#country-color-error').textContent()).includes('0–255'));
      for (const [rgb, label] of [
        [[185, 223, 238], '海洋'], [[222, 222, 222], '荒地'],
        [[150, 150, 150], '地块边界'], [[0, 0, 0], '行政区划边界']
      ]) {
        for (const [i, channel] of ['red', 'green', 'blue'].entries()) await page.locator(`#country-${channel}`).fill(String(rgb[i]));
        await page.locator('#confirm-country').click();
        assert.ok((await page.locator('#country-color-error').textContent()).includes(label));
        assert.equal(await page.locator('.country-list-item').count(), 1);
      }
      // Click the palette, adjust hue and saturation/value, then submit.
      await page.locator('.color-preset').nth(5).click();
      await page.locator('#country-hue').fill('180');
      const canvas = await page.locator('#country-sv').boundingBox();
      await page.mouse.click(canvas.x + canvas.width * .6, canvas.y + canvas.height * .3);
      assert.equal(await page.locator('#country-color-error').isVisible(), false);
      await page.locator('#confirm-country').click();
      assert.equal(await page.locator('.country-list-item').count(), 2);
      // Blank names and descriptions are allowed, including multiple unnamed entries.
      for (let i = 0; i < 2; i++) {
        await page.locator('#create-country').click();
        await page.locator('#confirm-country').click();
      }
      assert.equal(await page.locator('.country-list-item').count(), 4);
      await page.locator('#create-country').click();
      await page.locator('#country-name').fill('不应保存');
      await page.locator('#cancel-country').click();
      assert.equal(await page.locator('.country-list-item').count(), 4);
      await page.reload();
      assert.equal(await page.locator('.country-list-item').count(), 4);
      assert.equal(await page.locator('.country-list-item').first().textContent(), '测试王国');
      await page.screenshot({ path: 'output/country-list-page.png' });
      await page.setViewportSize({ width: 1000, height: 700 });
      await page.locator('#create-country').click();
      await page.locator('#country-color-swatch').click();
      await page.locator('#confirm-country').click();
      assert.equal(await page.locator('.country-list-item').count(), 5);
      assert.equal(await page.evaluate(() => document.body.scrollWidth > innerWidth), false);
      await page.evaluate(() => {
        const entries = window.CountryStore.list();
        for (let i = 0; i < 35; i++) entries.push({ id: `scroll-${i}`, name: `滚动测试国家 ${i + 1}`, description: '', color: '#' + (0x123400 + i).toString(16) });
        window.CountryStore.restore(entries);
      });
      const headerBefore = await page.locator('.country-panel-heading').boundingBox();
      const firstBefore = await page.locator('.country-list-item').first().boundingBox();
      const scroll = await page.locator('.country-panel-scroll').evaluate(el => {
        const result = { direction: getComputedStyle(el).direction, contentDirection: getComputedStyle(el.firstElementChild).direction, overflow: el.scrollHeight > el.clientHeight, leftGutter: el.clientLeft };
        el.scrollTop = el.scrollHeight;
        return result;
      });
      assert.equal(scroll.direction, 'rtl'); assert.equal(scroll.contentDirection, 'ltr');
      assert.ok(scroll.overflow); assert.ok(scroll.leftGutter > 0, 'scrollbar must occupy the left gutter');
      const headerAfter = await page.locator('.country-panel-heading').boundingBox();
      const firstAfter = await page.locator('.country-list-item').first().boundingBox();
      assert.equal(headerAfter.y, headerBefore.y);
      assert.ok(firstAfter.y < firstBefore.y - 100);
      await page.locator('.country-list-item').last().locator('.country-select').click();
      assert.equal(await page.locator('#country-name').inputValue(), '滚动测试国家 35');
      await page.locator('#cancel-country').click();
      await page.screenshot({ path: 'output/country-list-scrolled.png' });
      assert.deepEqual(errors, []);
      console.log(`Countries, conflicts, RGB, palette, optional fields, cancel, persistence and small window passed: ${url}`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
