// Browser end-to-end: loads the page, sends one question through the real claude -p loop,
// waits for the record, and screenshots desktop + mobile. Uses puppeteer-core from the
// Xarts checkout (XARTS_REPO) and the local Chrome. Not part of `npm test` (costs a real turn).
import { createRequire } from 'node:module';
const require = createRequire(`${process.env.XARTS_REPO ?? '/Users/miguelsureda/Desktop/xarts by anlak'}/package.json`);
const puppeteer = require('puppeteer-core');
const OUT = process.env.SHOTS ?? '.cache';
const Q = process.argv[2] ?? 'What drove the change in EBITDA from H1 2025 to H1 2026?';
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
try {
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.goto('http://127.0.0.1:4320', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !document.querySelector('.release-label').textContent.includes('Resolving'));
  await page.screenshot({ path: `${OUT}/ui-empty.png` });
  await page.type('#composer-input', Q);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.step', { timeout: 60000 });
  await new Promise(r => setTimeout(r, 4000));
  await page.screenshot({ path: `${OUT}/ui-working.png` });
  await page.waitForSelector('.footer-line', { timeout: 240000 });
  await new Promise(r => setTimeout(r, 1200));
  await page.screenshot({ path: `${OUT}/ui-done.png` });
  for (const tab of ['data', 'record']) {
    await page.click(`.tabs [data-tab=${tab}]`);
    await new Promise(r => setTimeout(r, 500));
    await page.screenshot({ path: `${OUT}/ui-${tab}.png` });
  }
  await page.click('.tabs [data-tab=chart]');
  const summary = await page.evaluate(() => ({
    steps: [...document.querySelectorAll('.step')].map(s => `${s.className.replace('step ', '')} | ${s.querySelector('.name').textContent} | ${s.querySelector('.detail').textContent.slice(0, 90)}`),
    tags: [...document.querySelectorAll('.footer-line .tag')].map(t => t.textContent),
    title: document.querySelector('#stage-title').textContent,
    imgOk: (() => { const i = document.querySelector('#chart-img'); return i && i.complete && i.naturalWidth > 0; })(),
    hOverflow: document.documentElement.scrollWidth > innerWidth,
  }));
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await new Promise(r => setTimeout(r, 400));
  await page.screenshot({ path: `${OUT}/ui-mobile.png`, fullPage: true });
  summary.mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  console.log(JSON.stringify({ ...summary, errors }, null, 1));
} finally { await browser.close(); }
