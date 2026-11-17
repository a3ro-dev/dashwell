// Loads the extension into Chrome for Testing, opens Tumblr, and reports what it did.
// usage: node scripts/try.mjs [url]   (CHROME=path/to/chrome-for-testing)
import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'node:url';

const ext = fileURLToPath(new URL('../extension', import.meta.url));
const url = process.argv[2] ?? 'https://www.tumblr.com/';
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME,
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--window-size=1400,1000'],
  defaultViewport: { width: 1400, height: 1000 },
});
const sw = await browser.waitForTarget((t) => t.type() === 'service_worker', { timeout: 10000 }).catch(() => null);
console.log('extension service worker:', sw ? 'running' : 'NOT FOUND (extension failed to load)');
const page = await browser.newPage();
page.on('console', (m) => m.type() === 'error' && console.log('page error:', m.text().slice(0, 200)));
page.on('pageerror', (e) => console.log('page exception:', e.message));
await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch((e) => console.log('goto:', e.message));
for (let i = 0; i < 3; i++) await page.mouse.wheel({ deltaY: 2500 }), await new Promise((r) => setTimeout(r, 1500));
await page.evaluate(() => scrollTo(0, 0));
await new Promise((r) => setTimeout(r, 1000));
console.log(await page.evaluate(() => ({
  path: location.pathname,
  hud: document.querySelector('.tn-hud')?.innerText ?? 'NO HUD',
  articles: document.querySelectorAll('[data-cell-id] article').length,
  labelled: [...document.querySelectorAll('.tn-why')].map((e) => e.textContent).slice(0, 8),
  premiumLeft: [...document.querySelectorAll('a,button')].filter((e) => /premium|ad-free/i.test(e.textContent) && e.offsetParent).map((e) => e.textContent.trim().slice(0, 40)),
})));
await page.screenshot({ path: '.cache/try.png' });
await browser.close();
