#!/usr/bin/env node
// Coverage sweep: render every demo spec of the source commit through the INSTALLED
// release package (the same path the chat uses) and record what happens per form.
//
//   node --import tsx scripts/coverage.mjs <xarts-checkout-at-release-sha> [--out runs/coverage.json]
//
// Output: per chartId → { clase, intent, status: ok|error|no_demo, code, class (input|library), ms, warnings }.
// This measures ENGINE coverage of the release. Chat coverage also depends on
// whether the form's data can come from SQL (see `chatPath`).
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveRelease, ensureInstalled, describeRelease } from '../lib/release.mjs';
import { ROOT } from '../lib/paths.mjs';

const { positionals, values } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' } } });
const checkout = resolve(positionals[0] ?? join(ROOT, '.cache/xarts-e9059b4b'));
const out = resolve(values.out ?? join(ROOT, 'runs', 'coverage.json'));
const release = resolveRelease();
const pkg = ensureInstalled(release);
const { renderSvg } = await import(pathToFileURL(join(pkg, 'core/runtime/node.js')).href);
const { diagnosticStatus, errorCode } = await import(pathToFileURL(join(pkg, 'core/render/diagnostics.js')).href);
const ficha = JSON.parse(readFileSync(join(pkg, 'docs/catalogo-ficha.json'), 'utf8'));

const demoDir = join(checkout, 'specs', 'demo');
const demos = new Map();
for (const f of readdirSync(demoDir).filter(f => f.endsWith('.json'))) {
  const spec = JSON.parse(readFileSync(join(demoDir, f), 'utf8'));
  if (spec.chartId && !demos.has(spec.chartId)) demos.set(spec.chartId, { file: f, spec });
}

// Can the chat serve this form today? Its only data path is rows from SQL.
function chatPath(card, spec) {
  if (card.clase === 'conceptual') return 'content_not_rows';
  if (spec && !Array.isArray(spec.data)) return 'engine_demo_only';
  if (spec?.basemap) return 'needs_basemap';
  return 'sql_rows';
}

const results = [];
const t0 = Date.now();
for (const card of ficha.charts) {
  const demo = demos.get(card.id);
  const base = { id: card.id, title: card.title, clase: card.clase, intent: card.intent, family: card.family };
  if (!demo) { results.push({ ...base, status: 'no_demo', chatPath: chatPath(card, null) }); continue; }
  const spec = { ...demo.spec, fonts: 'reference', embedSpec: false };
  const t = Date.now();
  try {
    const r = await renderSvg(spec);
    results.push({ ...base, status: 'ok', ms: Date.now() - t, warnings: r.warnings.length, bytes: r.svg.length, chatPath: chatPath(card, demo.spec), demo: demo.file });
  } catch (e) {
    const code = errorCode(e);
    results.push({ ...base, status: 'error', code, class: diagnosticStatus(code) === 422 ? 'input' : 'library', message: String(e?.message ?? e).slice(0, 300), ms: Date.now() - t, chatPath: chatPath(card, demo.spec), demo: demo.file });
  }
}

const count = (pred) => results.filter(pred).length;
const summary = {
  release: describeRelease(release),
  checkout, measuredAt: new Date().toISOString(), durationMs: Date.now() - t0,
  total: results.length,
  ok: count(r => r.status === 'ok'),
  error: count(r => r.status === 'error'),
  noDemo: count(r => r.status === 'no_demo'),
  byClase: Object.fromEntries(['datos', 'marco', 'conceptual'].map(c => [c, {
    total: count(r => r.clase === c), ok: count(r => r.clase === c && r.status === 'ok'),
    error: count(r => r.clase === c && r.status === 'error'), noDemo: count(r => r.clase === c && r.status === 'no_demo'),
  }])),
  chatPath: Object.fromEntries(['sql_rows', 'engine_demo_only', 'content_not_rows', 'needs_basemap'].map(p => [p, count(r => r.chatPath === p && r.status === 'ok')])),
  errorCodes: results.filter(r => r.status === 'error').reduce((a, r) => ({ ...a, [r.code]: (a[r.code] ?? 0) + 1 }), {}),
};
writeFileSync(out, JSON.stringify({ summary, results }, null, 1));
console.log(JSON.stringify(summary, null, 1));
