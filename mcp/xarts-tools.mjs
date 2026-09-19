#!/usr/bin/env node
// MCP stdio server: the ONLY tools `claude -p` gets in xarts-chat.
//
// Honesty rule enforced here, not in the prompt: numbers reach a chart only
// through SQL that THIS process executes against the read-only database.
// `chart_render` rejects any spec that carries its own `data`.
//
// Environment (set per request by server/claude.mjs):
//   XARTS_PKG_DIR   installed visx-render package of the resolved release
//   XARTS_RUN_DIR   runs/<runId>/ — artifacts and tool log for this request
//   XARTS_CHAT_DB   SQLite file (opened read-only)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSelect as runSelectOn } from '../lib/sql.mjs';
import { inspectSvg, readbackChecks, inspectorAvailable, closeInspector } from '../lib/inspect.mjs';

const PKG = process.env.XARTS_PKG_DIR;
const RUN = process.env.XARTS_RUN_DIR;
const DB = process.env.XARTS_CHAT_DB;
if (!PKG || !RUN || !DB) throw new Error('XARTS_PKG_DIR, XARTS_RUN_DIR and XARTS_CHAT_DB are required');
mkdirSync(RUN, { recursive: true });

const db = new DatabaseSync(DB, { readOnly: true });
const ficha = JSON.parse(readFileSync(join(PKG, 'docs', 'catalogo-ficha.json'), 'utf8'));
const charts = new Map(ficha.charts.map(c => [c.id, c]));
let renderSvgPromise;
const renderSvg = (...a) => (renderSvgPromise ??= import(pathToFileURL(join(PKG, 'core/runtime/node.js')).href)
  .then(m => m.renderSvg)).then(fn => fn(...a));

// Human feedback on earlier charts of the same form: the fast learning loop.
function houseNotes(chartId) {
  const file = join(RUN, '..', 'feedback.jsonl');
  let events = [];
  try { events = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return null; }
  const ofForm = s => s?.chartId === chartId;
  const liked = []; const reasons = {}; const notes = []; let up = 0; let down = 0;
  for (const e of events) {
    if (e.kind === 'rating' && ofForm(e.subject)) {
      if (e.value === 'up') { up++; liked.push(e.subject); } else { down++; for (const r of e.reasons ?? []) reasons[r] = (reasons[r] ?? 0) + 1; if (e.note) notes.push(e.note); }
    }
    if (e.kind === 'preference' && ofForm(e.chosen)) liked.push(e.chosen);
    if (e.kind === 'preference' && ofForm(e.rejected) && e.note) notes.push(e.note);
  }
  if (!up && !down && !liked.length) return null;
  const strip = spec => spec && ({ header: spec.header, columns: spec.columns, overrides: spec.overrides, locale: spec.locale });
  return {
    ratings: { up, down }, dislikedBecause: reasons, userNotes: notes.slice(-5),
    approvedExamples: liked.slice(-3).map(x => ({ request: x.request, spec: strip(x.spec), sql: x.sql })),
    how: 'Feedback from people who used earlier charts of this form. Follow approved patterns; avoid the reasons for dislikes.',
  };
}

let stylesPromise;
const loadStyles = id => (stylesPromise ??= import(pathToFileURL(join(PKG, 'core/registry/styles.js')).href))
  .then(m => m.loadStyleDefaults(id)).catch(() => undefined);
function formattingOf(defaults) {
  const found = {};
  const walk = (o, path) => {
    for (const [k, v] of Object.entries(o ?? {})) {
      if (/^(valueFormat|numberFormat|format|decimals|prefix|suffix)$/i.test(k)) found[[...path, k].join('.')] = v;
      else if (v && typeof v === 'object' && !Array.isArray(v) && path.length < 3) walk(v, [...path, k]);
    }
  };
  walk(defaults, []);
  return found;
}
let diagnosticsPromise;
const diagnosticStatus = code => (diagnosticsPromise ??= import(pathToFileURL(join(PKG, 'core/render/diagnostics.js')).href))
  .then(m => m.diagnosticStatus(code)).catch(() => null);
const sha = s => createHash('sha256').update(s).digest('hex');
const log = entry => appendFileSync(join(RUN, 'tools.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
const text = obj => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) }] });
const fail = (code, message, extra = {}) => ({ ...text({ ok: false, code, message, ...extra }), isError: true });

// ---------- SQL: read-only, single SELECT/WITH statement, bounded ----------
const MAX_RENDER_ROWS = 5000;
const runSelect = (sql, limit) => runSelectOn(db, sql, limit);

// ---------- local observations (NOT Promote gates) ----------
function observe(svg, rows, card, warnings) {
  const checks = [];
  const add = (id, status, detail) => checks.push({ id, status, detail });
  add('svg-root', /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/.test(svg) && /<\/svg>\s*$/.test(svg) ? 'pass' : 'fail', 'Output is one standalone <svg> document');
  const bad = svg.match(/(?:[xy][12]?|width|height|cx|cy|r|d|transform|points)="[^"]*(?:NaN|Infinity)[^"]*"/g);
  add('finite-geometry', bad ? 'fail' : 'pass', bad ? `${bad.length} attribute(s) with NaN/Infinity, e.g. ${bad[0].slice(0, 80)}` : 'No NaN/Infinity in geometry attributes');
  if (card?.minItems != null || card?.maxItems != null) {
    const n = rows.length; const lo = card.minItems ?? 0; const hi = card.maxItems ?? Infinity;
    add('item-range', n >= lo && n <= hi ? 'pass' : 'warn', `${n} rows; catalogue range for ${card.id} is ${lo}–${hi === Infinity ? '∞' : hi}`);
  }
  add('library-warnings', warnings.length ? 'warn' : 'pass', warnings.length ? warnings.join(' | ') : 'The library reported no warnings');
  return checks;
}

const server = new McpServer({ name: 'xarts', version: '0.1.0' });

server.registerTool('data_schema', {
  title: 'Dataset schema',
  description: 'Tables, columns, types, row counts, units and the data dictionary of the read-only SQLite dataset. Call this first.',
  inputSchema: {},
}, async () => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name").all();
  const out = {
    about: Object.fromEntries(db.prepare('SELECT key, value FROM _about').all().map(r => [r.key, r.value])),
    tables: tables.map(({ name }) => ({
      name,
      rows: db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n,
      columns: db.prepare(`PRAGMA table_info("${name}")`).all().map(c => ({ name: c.name, type: c.type })),
    })),
    dictionary: db.prepare('SELECT * FROM _dictionary').all().map(r => ({ ...r })),
  };
  log({ tool: 'data_schema' });
  return text(out);
});

server.registerTool('data_query', {
  title: 'Explore data',
  description: 'Run one read-only SELECT to explore the data (max 200 rows returned). Exploration only: charts get their data from the `sql` argument of chart_render, never from numbers you copy.',
  inputSchema: { sql: z.string().describe('A single SELECT or WITH … SELECT statement'), max_rows: z.number().int().min(1).max(200).optional() },
}, async ({ sql, max_rows = 50 }) => {
  try {
    const r = runSelect(sql, max_rows);
    log({ tool: 'data_query', sql: r.sql, rows: r.rows.length, truncated: r.truncated });
    return text({ ok: true, rows: r.rows.slice(0, max_rows), rowCount: Math.min(r.rows.length, max_rows), truncated: r.truncated });
  } catch (e) {
    log({ tool: 'data_query', sql, error: e.message });
    return fail(e.code ?? 'SQL_ERROR', e.message);
  }
});

server.registerTool('chart_search', {
  title: 'Search the Xarts catalogue',
  description: 'Find chart forms in the installed Xarts release. Filter by intent (evolve, compare, decompose, rank, position, distribute, forecast, correlate, flow, locate, system-explain), by class (datos = data charts, marco = frameworks, conceptual) and/or free text.',
  inputSchema: {
    intent: z.string().optional(), clase: z.enum(['datos', 'marco', 'conceptual']).optional(),
    text: z.string().optional(), limit: z.number().int().min(1).max(40).optional(),
  },
}, async ({ intent, clase, text: q, limit = 15 }) => {
  const words = (q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const hits = ficha.charts.filter(c => (!intent || c.intent === intent || c.intentSecondary?.includes(intent))
    && (!clase || c.clase === clase)
    && words.every(w => `${c.id} ${c.title} ${c.description} ${c.family} ${(c.tags ?? []).join(' ')}`.toLowerCase().includes(w)))
    .slice(0, limit)
    .map(c => ({ id: c.id, title: c.title, clase: c.clase, intent: c.intent, family: c.family, items: [c.minItems, c.maxItems], summary: c.description }));
  log({ tool: 'chart_search', intent, clase, text: q, hits: hits.length });
  return text({ total: ficha.total, returned: hits.length, charts: hits });
});

server.registerTool('chart_describe', {
  title: 'Chart contract',
  description: 'The data contract of one chart form: roles (columns), their types, aliases, required flags and rules, plus item limits and how missing values are treated. Read before rendering.',
  inputSchema: { chartId: z.string() },
}, async ({ chartId }) => {
  const c = charts.get(chartId);
  log({ tool: 'chart_describe', chartId, found: !!c });
  if (!c) return fail('UNKNOWN_CHART', `No chart "${chartId}" in this release. Use chart_search.`);
  const { ficha: f = {} } = c;
  return text({
    id: c.id, title: c.title, clase: c.clase, intent: c.intent, family: c.family, items: [c.minItems, c.maxItems],
    argument: f.descripcion, roles: f.roles, missing: f.ausentes, columnsHint: 'Map roles with spec.columns, e.g. { "label": "step", "value": "amount_eur" }.',
    annotationAffinity: c.annotationAffinity,
    formatting: await (async () => {
      const st = await loadStyles(chartId);
      const f = st ? formattingOf(st.defaults) : {};
      return Object.keys(f).length
        ? { overridable: f, how: 'Set via spec.overrides.style using the same nested keys, e.g. { "overrides": { "style": { "valueFormat": { "prefix": "€", "suffix": "k" } } } }. Only these keys exist for this chart; anything else is rejected.' }
        : { overridable: {}, how: 'This chart exposes no number-format keys. Control precision by rounding in SQL and state the unit in header.subtitle.' };
    })(),
    houseNotes: houseNotes(chartId),
    numberFormatNote: 'The library has no general numberFormat option yet (reserved in its contract). Labels print the values as given, localized by spec.locale.',
  });
});

let seq = readdirSync(RUN).filter(f => /^chart-\d+\.svg$/.test(f)).length;
server.registerTool('chart_render', {
  title: 'Render a chart',
  description: 'Render with the installed Xarts release. Pass the ChartSpec WITHOUT `data`, and the SQL whose rows become the data. The server executes the SQL itself. Required spec fields: chartId, header.title. Use `columns` to map roles to SQL column names. On failure you get the library\'s coded error: fix the spec or SQL and retry, or explain why the request cannot be served.',
  inputSchema: {
    spec: z.record(z.any()).describe('ChartSpec without data: { chartId, header: { title, subtitle? }, columns?, footer?, dimensions?, annotations?, locale?, ... }'),
    sql: z.string().describe('Single SELECT whose result rows are the chart data'),
  },
}, async ({ spec, sql }) => {
  const n = ++seq;
  const base = `chart-${n}`;
  if ('data' in spec) {
    log({ tool: 'chart_render', artifact: base, rejected: 'spec.data' });
    return fail('DATA_NOT_ALLOWED', 'Do not put data in the spec. Pass the SQL; the server runs it.');
  }
  let q;
  try { q = runSelect(sql, MAX_RENDER_ROWS); } catch (e) {
    log({ tool: 'chart_render', artifact: base, sql, error: e.message, code: e.code ?? 'SQL_ERROR' });
    return fail(e.code ?? 'SQL_ERROR', e.message);
  }
  if (q.truncated) return fail('TOO_MANY_ROWS', `Query returns more than ${MAX_RENDER_ROWS} rows; aggregate it.`);
  const full = { fonts: 'embed', ...spec, data: q.rows, filename: base, embedSpec: false };
  const dataHash = sha(JSON.stringify(q.rows));
  writeFileSync(join(RUN, `${base}.spec.json`), JSON.stringify({ ...spec, filename: base }, null, 2));
  writeFileSync(join(RUN, `${base}.data.json`), JSON.stringify({ sql: q.sql, rowCount: q.rows.length, dataHash, rows: q.rows }, null, 2));
  const t0 = Date.now();
  try {
    const r = await renderSvg(full);
    const ms = Date.now() - t0;
    writeFileSync(join(RUN, `${base}.svg`), r.svg);
    const checks = observe(r.svg, q.rows, charts.get(r.chartId), r.warnings);
    let printed = null; let image = null; let inspectMs = null;
    if (inspectorAvailable()) {
      const ti = Date.now();
      try {
        const insp = await inspectSvg(r.svg);
        inspectMs = Date.now() - ti;
        writeFileSync(join(RUN, `${base}.png`), insp.png);
        const rb = readbackChecks(insp, { locale: full.locale ?? 'es-ES', sql: q.sql });
        checks.push(...rb.checks);
        printed = { texts: insp.texts.map(t => t.text).slice(0, 150), numericLabels: rb.numericLabels.slice(0, 80), overlaps: insp.overlaps.slice(0, 10) };
        image = insp.png.toString('base64');
      } catch (e) {
        checks.push({ id: 'inspector', status: 'warn', detail: `Render inspector failed: ${String(e.message).slice(0, 200)}` });
      }
    } else {
      checks.push({ id: 'inspector', status: 'warn', detail: 'Chrome not found: the output was not inspected (no image, no text read-back).' });
    }
    const needsReview = checks.filter(c => c.status !== 'pass');
    const result = {
      ok: true, artifact: base, chartId: r.chartId, width: r.width, height: r.height, rows: q.rows.length,
      warnings: r.warnings, checks, renderMs: ms, inspectMs, printed,
      review: needsReview.length
        ? `Look at the image and the printed labels. ${needsReview.length} check(s) need attention: ${needsReview.map(c => c.id).join(', ')}. Fix what you can (rounding in SQL, formatting overrides, shorter labels, another form) and re-render, or tell the user what remains and why.`
        : 'Look at the image and the printed labels before answering: do units, decimals and the title agree with what is printed?',
    };
    log({ tool: 'chart_render', artifact: base, chartId: r.chartId, sql: q.sql, rows: q.rows.length, dataHash, svgHash: sha(r.svg), warnings: r.warnings, checks, renderMs: ms, inspectMs, png: image ? `${base}.png` : null });
    const content = [{ type: 'text', text: JSON.stringify(result, null, 1) }];
    if (image) content.push({ type: 'image', data: image, mimeType: 'image/png' });
    return { content };
  } catch (e) {
    const code = typeof e?.code === 'string' ? e.code : 'RENDER_FAILED';
    const status = await diagnosticStatus(code); // library's own split: 422 input error, 500 library failure
    log({ tool: 'chart_render', artifact: base, chartId: spec.chartId, sql: q.sql, rows: q.rows.length, dataHash, error: String(e?.message ?? e).slice(0, 2000), code, status });
    return fail(code, String(e?.message ?? e).slice(0, 2000), { artifact: base, class: status === 422 ? 'input' : 'library' });
  }
});

const transport = new StdioServerTransport();
const shutdown = async () => { try { await closeInspector(); } finally { process.exit(0); } };
process.stdin.on('end', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
await server.connect(transport);
