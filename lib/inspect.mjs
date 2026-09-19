// Render inspector: looks at a rendered SVG the way a reader would.
// Headless Chrome lays out the SVG with its embedded fonts, then we measure every
// text element, take a PNG, and read back the labels as printed.
//
// Everything here is an OBSERVATION of the output, independent of the chart's own
// helpers. It answers "what does the reader actually see", not "was the input valid".
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let browserPromise = null;

export const inspectorAvailable = () => existsSync(CHROME);

async function browser() {
  if (!browserPromise) {
    const puppeteer = require('puppeteer-core');
    browserPromise = puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--disable-extensions'] });
  }
  return browserPromise;
}

export async function closeInspector() {
  if (browserPromise) { const b = await browserPromise; browserPromise = null; await b.close(); }
}

/**
 * @returns {{ png: Buffer, texts: Array<{text:string,x:number,y:number,w:number,h:number}>, overlaps, clipped, truncated, width, height }}
 */
export async function inspectSvg(svg, { scale = 1.5 } = {}) {
  const b = await browser();
  const page = await b.newPage();
  try {
    await page.setJavaScriptEnabled(false);
    await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;background:#fff}svg{display:block}</style></head><body>${svg}</body></html>`, { waitUntil: 'load' });
    await page.setJavaScriptEnabled(true);
    const size = await page.evaluate(() => {
      const s = document.querySelector('svg');
      const r = s.getBoundingClientRect();
      return { w: Math.ceil(r.width), h: Math.ceil(r.height) };
    });
    await page.setViewport({ width: Math.max(1, size.w), height: Math.max(1, size.h), deviceScaleFactor: scale });
    await page.evaluate(() => document.fonts.ready);
    const measured = await page.evaluate(() => {
      const root = document.querySelector('svg');
      const R = root.getBoundingClientRect();
      const visible = el => {
        for (let n = el; n && n !== root; n = n.parentElement) {
          const cs = getComputedStyle(n);
          if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
        }
        return true;
      };
      // Leaf text runs: <tspan> without child tspans, or <text> without tspans.
      const nodes = [...root.querySelectorAll('text, tspan')].filter(n =>
        (n.tagName === 'tspan' ? !n.querySelector('tspan') : !n.querySelector('tspan')) && n.textContent.trim() && visible(n));
      const texts = nodes.map((n, i) => {
        const r = n.getBoundingClientRect();
        return { i, text: n.textContent.replace(/\s+/g, ' ').trim(), x: r.left - R.left, y: r.top - R.top, w: r.width, h: r.height };
      }).filter(t => t.w > 0 && t.h > 0);
      // Small marks (legend swatches, point dots) that can collide with text.
      const marks = [...root.querySelectorAll('circle, rect, ellipse')].filter(visible).map(n => {
        const r = n.getBoundingClientRect();
        return { tag: n.tagName, x: r.left - R.left, y: r.top - R.top, w: r.width, h: r.height };
      }).filter(m => m.w > 0 && m.h > 0 && m.w <= 16 && m.h <= 16);
      return { texts, marks, W: R.width, H: R.height };
    });
    const { texts, marks, W, H } = measured;

    // Overlap: intersection over the smaller box, ignoring tiny touches.
    const overlaps = [];
    for (let a = 0; a < texts.length; a++) {
      for (let c = a + 1; c < texts.length; c++) {
        const p = texts[a]; const q = texts[c];
        const ix = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x);
        const iy = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y);
        if (ix <= 1 || iy <= 1) continue;
        const ratio = (ix * iy) / Math.min(p.w * p.h, q.w * q.h);
        if (ratio >= 0.2) overlaps.push({ a: p.text, b: q.text, ratio: Math.round(ratio * 100) / 100 });
      }
    }
    // A mark sitting on a label: intersection must cover a real part of the mark,
    // so a dot that merely touches its own label's edge doesn't count.
    for (const m of marks) {
      for (const t of texts) {
        const ix = Math.min(m.x + m.w, t.x + t.w) - Math.max(m.x, t.x);
        const iy = Math.min(m.y + m.h, t.y + t.h) - Math.max(m.y, t.y);
        if (ix > 1.5 && iy > 1.5 && (ix * iy) / (m.w * m.h) >= 0.25) overlaps.push({ a: t.text, b: `a ${m.tag === 'circle' ? 'dot' : 'marker'}`, ratio: Math.round((ix * iy) / (m.w * m.h) * 100) / 100 });
      }
    }
    // Text boxes include the font's line spacing, so a small overshoot is usually ink-safe.
    // Count as clipped only past max(3 px, 20% of the line height).
    const clipped = texts.filter(t => {
      const tol = Math.max(3, t.h * 0.2);
      return t.x < -tol || t.y < -tol || t.x + t.w > W + tol || t.y + t.h > H + tol;
    }).map(t => t.text);
    const truncated = texts.filter(t => /…|\.\.\.$/.test(t.text)).map(t => t.text);
    // puppeteer ≥22 returns a Uint8Array; normalise so callers can .toString('base64').
    const png = Buffer.from(await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: size.w, height: size.h } }));
    return { png, texts: texts.map(({ i, ...t }) => t), overlaps, clipped, truncated, width: size.w, height: size.h };
  } finally {
    await page.close();
  }
}

// ---------- label readback ----------
// Parse a printed label into a number under a locale's separators.
export function parseLabel(text, locale = 'es-ES') {
  const decimalComma = /^(es|de|fr|it|pt|nl|ca|da|sv|nb|fi|pl|ru|tr)\b/i.test(locale);
  const m = String(text).replace(/−/g, '-').match(/^[+\-]?[€$£]?\s?[+\-]?\d[\d.,\s  ]*[kKMB%]?$/);
  if (!m) return null;
  let s = text.replace(/−/g, '-').replace(/[€$£%\s  ]/g, '');
  const suffix = s.match(/[kKMB]$/)?.[0];
  if (suffix) s = s.slice(0, -1);
  if (decimalComma) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const v = Number(s);
  if (!Number.isFinite(v)) return null;
  const decimals = (s.split('.')[1] ?? '').length;
  return { value: v, decimals, suffix: suffix ?? null };
}

/** Checks on what was printed, not on what was intended. */
export function readbackChecks({ texts, overlaps, clipped, truncated }, { locale, sql }) {
  const checks = [];
  const add = (id, status, detail, extra) => checks.push({ id, status, detail, ...(extra ? { extra } : {}) });

  add('text-overlap', overlaps.length ? 'warn' : 'pass',
    overlaps.length ? `${overlaps.length} overlapping text pair(s), e.g. «${overlaps[0].a}» over «${overlaps[0].b}»` : 'No overlapping text');
  add('text-clipped', clipped.length ? 'fail' : 'pass',
    clipped.length ? `${clipped.length} label(s) cut by the canvas edge, e.g. «${clipped[0]}»` : 'No text outside the canvas');
  add('labels-truncated', truncated.length ? 'warn' : 'pass',
    truncated.length ? `${truncated.length} label(s) shortened with an ellipsis: ${truncated.slice(0, 4).map(t => `«${t}»`).join(', ')}` : 'No shortened labels');

  const numeric = texts.map(t => ({ t: t.text, p: parseLabel(t.text, locale) })).filter(x => x.p);
  const precise = numeric.filter(x => x.p.decimals >= 3 && Math.abs(x.p.value) >= 1);
  const decimalComma = /^(es|de|fr|it|pt|nl|ca)\b/i.test(locale ?? 'es-ES');
  add('label-precision', precise.length ? 'warn' : 'pass',
    precise.length
      ? `${precise.length} label(s) print 3+ decimals, e.g. «${precise[0].t}». Readers used to ${decimalComma ? 'a decimal point' : 'a decimal comma'} will read it as a whole number with a thousands separator (a 1,000× misreading). Round in SQL, e.g. ROUND(x, 1), and state the unit in the subtitle.`
      : 'Numeric labels use a readable precision');

  // Where did the numbers come from? Literal numbers in the SELECT list bypass the dataset.
  if (sql) {
    const body = sql.replace(/'(?:[^']|'')*'/g, "''");
    const fromTable = /\bfrom\s+["`]?[a-z_][\w]*/i.test(body);
    const selectList = body.match(/^\s*(?:with[\s\S]+?\)\s*)?select([\s\S]*?)\bfrom\b/i)?.[1] ?? body;
    const literals = (selectList.match(/(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/g) ?? [])
      .filter(n => !['0', '1', '2', '100', '1000', '1000.0', '1e3', '1000000', '1000000.0'].includes(n));
    add('sql-provenance', !fromTable ? 'fail' : literals.length ? 'warn' : 'pass',
      !fromTable ? 'The SQL reads no dataset table: its numbers are typed, not queried'
        : literals.length ? `Numeric literal(s) in the SELECT list: ${[...new Set(literals)].slice(0, 5).join(', ')} — check they are unit conversions, not data`
          : 'Every value is read from a dataset table');
  }
  return { checks, numericLabels: numeric.map(x => x.t) };
}
