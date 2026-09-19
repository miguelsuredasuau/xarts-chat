// Browser end-to-end of a revision conversation, feedback, and verification in the
// dataset console. Costs two real claude -p turns. Not part of `npm test`.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const OUT = process.env.SHOTS ?? '.cache';
const wait = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
const ask = async (q, n) => {
  await page.type('#composer-input', q);
  await page.keyboard.press('Enter');
  await page.waitForFunction(k => document.querySelectorAll('.footer-line').length >= k, { timeout: 300000 }, n);
  await wait(800);
};
try {
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.goto('http://127.0.0.1:4320', { waitUntil: 'networkidle0' });
  await ask('What drove the change in EBITDA from H1 2025 to H1 2026?', 1);
  await ask('can you make it in thousands of euros? not euros?', 2);
  await page.screenshot({ path: `${OUT}/flow-1-revision.png` });
  const afterRevision = await page.evaluate(() => ({
    steps: [...document.querySelectorAll('.msg.assistant:last-of-type .step')].map(s => `${s.className.replace('step ', '')} | ${s.querySelector('.name').textContent} | ${s.querySelector('.detail').textContent.slice(0, 110)}`),
    checks: [...document.querySelectorAll('#checks .check')].map(c => `${c.className.replace('check ', '')}:${c.textContent}`),
    charts: document.querySelectorAll('.thumb').length,
    compareVisible: !document.querySelector('#fb-compare').hidden,
  }));
  // Feedback: thumbs down with a reason, then a preference against the previous version.
  await page.click('[data-rate=down]');
  await page.click('[data-reason=units_format]');
  await page.type('#fb-note', 'labels should read €105.9k');
  await page.click('#fb-detail button[type=submit]');
  await wait(400);
  let prefSaved = null;
  if (afterRevision.compareVisible) {
    await page.click('[data-pref=this]');
    await wait(400);
    prefSaved = await page.$eval('#fb-state', e => e.textContent);
  }
  await page.screenshot({ path: `${OUT}/flow-2-feedback.png` });
  // Verify in the dataset console.
  await page.click('.tabs [data-tab=data]');
  await page.waitForSelector('.verify button');
  await page.click('.verify button');
  await page.waitForFunction(() => /rows in/.test(document.querySelector('#ds-status').textContent), { timeout: 20000 });
  const verify = await page.$eval('#ds-status', e => e.textContent);
  await page.screenshot({ path: `${OUT}/flow-3-verify.png` });
  await page.click('#ds-tables button[data-table=revenue_monthly]');
  await wait(500);
  await page.screenshot({ path: `${OUT}/flow-4-browse.png` });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await wait(300);
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  await page.screenshot({ path: `${OUT}/flow-5-mobile-dataset.png`, fullPage: true });
  console.log(JSON.stringify({ afterRevision, prefSaved, verify, mobileOverflow, errors }, null, 1));
} finally { await browser.close(); }
