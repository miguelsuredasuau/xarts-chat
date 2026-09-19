#!/usr/bin/env node
// Quality sweep: render every demo spec through the installed release AND inspect the
// output like a reader (text overlaps, clipping, truncated labels, label precision).
// "Renders" is not "reads well": this measures the second.
//
//   node --import tsx scripts/quality-sweep.mjs [xarts-checkout] [--out runs/quality.json]
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveRelease, ensureInstalled, describeRelease } from '../lib/release.mjs';
import { inspectSvg, readbackChecks, closeInspector } from '../lib/inspect.mjs';
import { ROOT } from '../lib/paths.mjs';

const { positionals, values } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' } } });
const checkout = resolve(positionals[0] ?? join(ROOT, '.cache/xarts-e9059b4b'));
const out = resolve(values.out ?? join(ROOT, 'runs', 'quality.json'));
const shots = join(ROOT, 'runs', 'quality-shots');
mkdirSync(shots, { recursive: true });
const release = resolveRelease();
const pkg = ensureInstalled(release);
const { renderSvg } = await import(pathToFileURL(join(pkg, 'core/runtime/node.js')).href);
const ficha = new Map(JSON.parse(readFileSync(join(pkg, 'docs/catalogo-ficha.json'), 'utf8')).charts.map(c => [c.id, c]));

const demoDir = join(checkout, 'specs', 'demo');
const results = [];
const t0 = Date.now();
for (const f of readdirSync(demoDir).filter(f => f.endsWith('.json')).sort()) {
  const spec = JSON.parse(readFileSync(join(demoDir, f), 'utf8'));
  const card = ficha.get(spec.chartId);
  const base = { id: spec.chartId, clase: card?.clase ?? null, demo: f };
  try {
    const r = await renderSvg({ ...spec, fonts: 'embed', embedSpec: false });
    const insp = await inspectSvg(r.svg, { scale: 1 });
    const { checks } = readbackChecks(insp, { locale: spec.locale ?? 'es-ES', sql: null });
    const bad = checks.filter(c => c.status !== 'pass');
    if (bad.length) writeFileSync(join(shots, `${spec.chartId}.png`), insp.png);
    results.push({ ...base, status: bad.some(c => c.status === 'fail') ? 'fail' : bad.length ? 'warn' : 'pass',
      overlaps: insp.overlaps.length, clipped: insp.clipped.length, truncated: insp.truncated.length,
      examples: { overlap: insp.overlaps[0] ?? null, clipped: insp.clipped[0] ?? null, truncated: insp.truncated[0] ?? null },
      checks: bad.map(c => c.id) });
  } catch (e) {
    results.push({ ...base, status: 'error', message: String(e?.message ?? e).slice(0, 200) });
  }
}
await closeInspector();
const n = s => results.filter(r => r.status === s).length;
const summary = {
  release: describeRelease(release).label, measuredAt: new Date().toISOString(), durationMs: Date.now() - t0,
  total: results.length, pass: n('pass'), warn: n('warn'), fail: n('fail'), error: n('error'),
  withOverlaps: results.filter(r => r.overlaps).length, withClipping: results.filter(r => r.clipped).length, withTruncation: results.filter(r => r.truncated).length,
  byClase: Object.fromEntries(['datos', 'marco', 'conceptual'].map(c => [c, Object.fromEntries(['pass', 'warn', 'fail', 'error'].map(s => [s, results.filter(r => r.clase === c && r.status === s).length]))])),
};
writeFileSync(out, JSON.stringify({ summary, results }, null, 1));
console.log(JSON.stringify(summary, null, 1));
