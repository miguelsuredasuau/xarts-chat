#!/usr/bin/env node
// xarts-chat: local only (127.0.0.1). Serves the chat page, streams chat turns as
// server-sent events, and exposes run artifacts and records.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, RUNS_DIR, DB_FILE } from '../lib/paths.mjs';
import { resolveRelease, ensureInstalled, describeRelease, ReleaseError, PROMOTE_REGISTRY } from '../lib/release.mjs';
import { runClaude, BUDGET_USD, MODEL } from './claude.mjs';
import { promoteReceipt } from '../lib/promote-receipts.mjs';
import { appendProgress, progressFor } from '../lib/journal.mjs';
import { buildRecord, writeRecord, listRuns } from './record.mjs';
import { runSelect } from '../lib/sql.mjs';
import { recordFeedback, feedbackFor, FeedbackError } from '../lib/feedback.mjs';

const PORT = Number(process.env.PORT ?? 4320);
const HOST = '127.0.0.1';
const WEB = join(ROOT, 'web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };
const conversations = new Map(); // conversationId -> { sessionId, busy, controller }

mkdirSync(RUNS_DIR, { recursive: true });

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function currentRelease() {
  try {
    const r = resolveRelease();
    return { ok: true, release: describeRelease(r) };
  } catch (e) {
    return { ok: false, error: { code: e.code ?? 'RELEASE_ERROR', message: e.message } };
  }
}

function datasetInfo() {
  if (!existsSync(DB_FILE)) return null;
  const db = new DatabaseSync(DB_FILE, { readOnly: true });
  try {
    const about = Object.fromEntries(db.prepare('SELECT key, value FROM _about').all().map(r => [r.key, r.value]));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name").all()
      .map(({ name }) => ({ name, rows: db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n }));
    return { about, tables };
  } finally { db.close(); }
}

// ---------- dataset browser (read-only, same guard as the agent's tools) ----------
let roDb = null;
const dataDb = () => (roDb ??= new DatabaseSync(DB_FILE, { readOnly: true }));
const TABLE_RE = /^[a-z_][a-z0-9_]{0,63}$/;
function datasetSchema() {
  const db = dataDb();
  const dict = db.prepare('SELECT table_name, column_name, unit, description FROM _dictionary').all();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name").all();
  return tables.map(({ name }) => ({
    name,
    rows: db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n,
    columns: db.prepare(`PRAGMA table_info("${name}")`).all().map(c => {
      const d = dict.find(x => x.table_name === name && x.column_name === c.name);
      return { name: c.name, type: c.type, pk: !!c.pk, unit: d?.unit ?? null, description: d?.description ?? null };
    }),
  }));
}
function tablePage(name, offset, limit) {
  const schema = datasetSchema().find(t => t.name === name);
  if (!schema) return null;
  const order = schema.columns.filter(c => c.pk).map(c => `"${c.name}"`).join(', ') || 'rowid';
  const rows = dataDb().prepare(`SELECT * FROM "${name}" ORDER BY ${order} LIMIT ? OFFSET ?`).all(limit, offset).map(r => ({ ...r }));
  return { name, total: schema.rows, offset, limit, columns: schema.columns, rows };
}

async function readBody(req, limit = 64 * 1024) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('Body too large'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function chat(req, res) {
  let body;
  try { body = await readBody(req); } catch { return send(res, 400, { error: 'Invalid JSON body' }); }
  const message = String(body.message ?? '').trim();
  if (!message || message.length > 4000) return send(res, 400, { error: 'message must be 1–4000 characters' });
  const conversationId = /^[a-f0-9-]{36}$/.test(body.conversationId ?? '') ? body.conversationId : randomUUID();
  const conv = conversations.get(conversationId) ?? { sessionId: null, busy: false };
  conversations.set(conversationId, conv);
  if (conv.busy) return send(res, 409, { error: 'This conversation is already answering' });
  if ([...conversations.values()].some(c => c.busy)) return send(res, 429, { error: 'Another chart request is running. Please try again when it finishes.' });
  conv.busy = true;

  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const emit = ev => { appendProgress(runId, ev); if (!res.destroyed) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
  const runId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')}-${randomUUID().slice(0, 8)}`;
  const runDir = join(RUNS_DIR, runId);
  mkdirSync(runDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const controller = new AbortController();
  conv.controller = controller;
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });

  appendProgress(runId, { t: 'request', conversationId, message });
  emit({ t: 'run', runId, conversationId });
  let release;
  try {
    const resolved = resolveRelease();
    emit({ t: 'status', text: 'Checking the Xarts release…' });
    const pkgDir = ensureInstalled(resolved);
    release = describeRelease(resolved);
    emit({ t: 'release', release });

    let session = null; let result = null; let text = '';
    const deliveredErrors = []; // tool results Claude received as errors (what IT saw)
    const { exitCode, stderr } = await runClaude({
      message, sessionId: conv.sessionId, conversationId, runDir, pkgDir, shims: release.shims.map(s => s.id), signal: controller.signal,
      onEvent: ev => {
        if (ev.t === 'session') { session = ev; conv.sessionId = ev.sessionId; emit({ t: 'session', model: ev.model }); return; }
        if (ev.t === 'text') text += ev.text;
        if (ev.t === 'result') { result = ev; conv.sessionId = ev.sessionId ?? conv.sessionId; }
        if (ev.t === 'tool-result' && ev.isError) deliveredErrors.push({ tool: ev.name, text: String(ev.payload?.message ?? ev.payload?.text ?? '').slice(0, 500) });
        if (ev.t === 'tool-result' && ev.name === 'chart_render' && ev.payload?.artifact) {
          emit({ ...ev, svgUrl: ev.payload.ok ? `/runs/${runId}/${ev.payload.artifact}.svg` : null });
          return;
        }
        emit(ev);
      },
    });
    const record = buildRecord({ runId, conversationId, message, release, session, result, exitCode, stderr, startedAt, finalText: text, aborted: controller.signal.aborted, deliveredErrors });
    writeRecord(record);
    emit({ t: 'record', runId, outcome: record.outcome, signals: record.signals, usage: record.agent.usage, renders: record.renders.length });
  } catch (e) {
    const code = e instanceof ReleaseError ? e.code : 'SERVER_ERROR';
    emit({ t: 'error', code, message: e.message });
    const record = buildRecord({ runId, conversationId, message, release: release ?? { kind: 'unresolved', error: { code, message: e.message }, shims: [] }, session: null, result: null, exitCode: -1, stderr: String(e.stack ?? e), startedAt, aborted: controller.signal.aborted });
    record.outcome = e instanceof ReleaseError ? 'release_unavailable' : 'error';
    writeRecord(record);
  } finally {
    conv.busy = false;
    emit({ t: 'end' });
    res.end();
  }
}

function serveRunFile(res, runId, file) {
  if (!/^[0-9TZ]+-[a-f0-9]{8}$/.test(runId) || !/^(chart-\d+\.(svg|spec\.json|data\.json)|record\.json)$/.test(file)) return send(res, 404, { error: 'Not found' });
  const path = join(RUNS_DIR, runId, file);
  if (!existsSync(path)) return send(res, 404, { error: 'Not found' });
  const extra = extname(file) === '.svg' ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; sandbox" } : {};
  return send(res, 200, readFileSync(path), TYPES[extname(file)], extra);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  try {
    const host = req.headers.host ?? '';
    if (!/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(host) || (req.headers.origin && req.headers.origin !== `http://${host}`)) return send(res, 403, { error: 'Forbidden origin' });
    if (req.method === 'POST' && url.pathname === '/api/chat') return await chat(req, res);
    if (req.method === 'POST' && url.pathname === '/api/stop') {
      const body = await readBody(req);
      conversations.get(body.conversationId)?.controller?.abort();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/feedback') {
      try {
        const ev = recordFeedback(await readBody(req));
        return send(res, 200, { ok: true, id: ev.id });
      } catch (e) {
        return send(res, e instanceof FeedbackError ? 400 : 500, { ok: false, error: e.message });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/sql') {
      const body = await readBody(req);
      const t = Date.now();
      try {
        const r = runSelect(dataDb(), String(body.sql ?? ''), 1000);
        return send(res, 200, { ok: true, sql: r.sql, rows: r.rows, rowCount: r.rows.length, truncated: r.truncated, ms: Date.now() - t });
      } catch (e) {
        return send(res, 200, { ok: false, code: e.code ?? 'SQL_ERROR', message: e.message });
      }
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
    const receipt = url.pathname.match(/^\/api\/promote-receipts\/([A-Za-z0-9_-]+\.json)$/);
    if (receipt) return send(res, 200, promoteReceipt(receipt[1]));
    const progress = url.pathname.match(/^\/api\/progress\/([0-9TZ]+-[a-f0-9]{8})$/);
    if (progress) return send(res, 200, { events: progressFor(progress[1]) });
    const fm = url.pathname.match(/^\/api\/feedback\/([0-9TZ]+-[a-f0-9]{8})$/);
    if (fm) return send(res, 200, { feedback: feedbackFor(fm[1]) });
    if (url.pathname === '/api/dataset') return send(res, 200, { about: datasetInfo()?.about ?? null, tables: datasetSchema() });
    const tm = url.pathname.match(/^\/api\/dataset\/([^/]+)$/);
    if (tm) {
      if (!TABLE_RE.test(tm[1])) return send(res, 404, { error: 'Not found' });
      const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) | 0);
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100) | 0));
      const page = tablePage(tm[1], offset, limit);
      return page ? send(res, 200, page) : send(res, 404, { error: 'Not found' });
    }
    if (url.pathname === '/api/state') {
      return send(res, 200, {
        release: currentRelease(), dataset: datasetInfo(), runs: listRuns(30),
        promoteRegistry: PROMOTE_REGISTRY ? { configured: true, path: PROMOTE_REGISTRY } : { configured: false },
        agent: { runner: 'claude -p', model: MODEL ?? 'claude default', budgetUsdPerTurn: BUDGET_USD },
      });
    }
    const font = url.pathname.match(/^\/fonts\/(Inter_18pt-(?:Regular|Medium|SemiBold|Bold)\.ttf)$/);
    if (font) {
      const dir = ensureInstalled(resolveRelease());
      return send(res, 200, readFileSync(join(dir, 'fonts', 'inter', font[1])), 'font/ttf', { 'Cache-Control': 'max-age=86400' });
    }
    const m = url.pathname.match(/^\/runs\/([^/]+)\/([^/]+)$/);
    if (m) return serveRunFile(res, m[1], m[2]);
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!/^[a-z0-9-]+\.(html|js|css|svg)$/.test(file) || !existsSync(join(WEB, file))) return send(res, 404, { error: 'Not found' });
    return send(res, 200, readFileSync(join(WEB, file)), TYPES[extname(file)]);
  } catch (e) {
    if (!res.headersSent) send(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  const r = currentRelease();
  console.log(`xarts-chat on http://${HOST}:${PORT}`);
  console.log(r.ok ? `release: ${r.release.label} · ${r.release.packageHash.slice(0, 12)}${r.release.shims.length ? ` · shims: ${r.release.shims.map(s => s.id).join(', ')}` : ''}` : `release: UNAVAILABLE — ${r.error.message}`);
});
