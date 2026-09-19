// Fast tests, no network, no claude: `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'xarts-chat-test-'));
process.env.XARTS_CHAT_RUNS = join(tmp, 'runs');
const { runSelect } = await import('../lib/sql.mjs');
const { resolveRelease } = await import('../lib/release.mjs');
const { buildRecord } = await import('../server/record.mjs');

// ---------------- SQL guard ----------------
const dbFile = join(tmp, 't.sqlite');
{ const w = new DatabaseSync(dbFile); w.exec("CREATE TABLE t (a INTEGER, b TEXT); INSERT INTO t VALUES (1,'x;y'),(2,'z'),(3,'w');"); w.close(); }
const db = new DatabaseSync(dbFile, { readOnly: true });

test('SELECT and WITH are allowed, rows are plain objects', () => {
  assert.deepEqual(runSelect(db, 'SELECT a FROM t ORDER BY a', 10).rows, [{ a: 1 }, { a: 2 }, { a: 3 }]);
  assert.equal(runSelect(db, 'WITH q AS (SELECT a FROM t) SELECT COUNT(*) n FROM q;', 10).rows[0].n, 3);
});
test('a semicolon inside a string literal is not a second statement', () => {
  assert.equal(runSelect(db, "SELECT b FROM t WHERE b = 'x;y'", 10).rows.length, 1);
});
test('writes and multiple statements are refused before execution', () => {
  assert.throws(() => runSelect(db, 'DELETE FROM t', 10), { code: 'SQL_NOT_SELECT' });
  assert.throws(() => runSelect(db, 'SELECT 1; DROP TABLE t', 10), { code: 'SQL_MULTI' });
});
test('a write disguised behind WITH is stopped by the read-only handle', () => {
  assert.throws(() => runSelect(db, 'WITH q AS (SELECT 1) DELETE FROM t', 10), { code: 'SQL_ERROR' });
  assert.equal(runSelect(db, 'SELECT COUNT(*) n FROM t', 10).rows[0].n, 3);
});
test('row limit truncates and says so', () => {
  const r = runSelect(db, 'SELECT a FROM t', 2);
  assert.equal(r.rows.length, 2);
  assert.equal(r.truncated, true);
});

// ---------------- release resolution ----------------
const tgz = Buffer.from('not really a tarball');
const hash = createHash('sha256').update(tgz).digest('hex');
function registry(name, { withActive = false, releaseHash = hash, bytes = tgz } = {}) {
  const dir = join(tmp, name);
  mkdirSync(join(dir, 'packages'), { recursive: true });
  mkdirSync(join(dir, 'releases'), { recursive: true });
  writeFileSync(join(dir, 'packages', `${releaseHash}.tgz`), bytes);
  writeFileSync(join(dir, 'baseline.json'), JSON.stringify({ kind: 'baseline', label: 'Baseline test', sourceSha: 'a'.repeat(40), packageHash: hash, version: 'v', createdAt: 'now' }));
  if (withActive) {
    writeFileSync(join(dir, 'active.json'), JSON.stringify({ schemaVersion: 1, releaseId: 'rel-1', activatedAt: '2026-09-19T00:00:00Z' }));
    writeFileSync(join(dir, 'releases', 'rel-1.json'), JSON.stringify({ schemaVersion: 1, id: 'rel-1', incidentId: 'inc-1', acceptedSha: 'b'.repeat(40), packageHash: releaseHash, priorReleaseId: null, outputArtifactHash: 'c'.repeat(64), manifestHash: 'd'.repeat(64), gateResultIds: ['gate-1'], destination: 'local_demo_registry', activatedAt: '2026-09-19T00:00:00Z' }));
  }
  return dir;
}

test('without a Promote release, the labelled baseline is used', () => {
  const local = registry('local-a');
  const r = resolveRelease({ promote: join(tmp, 'nowhere'), local });
  assert.equal(r.kind, 'baseline');
});
test('an active Promote release wins over the baseline', () => {
  const local = registry('local-b');
  const promote = registry('promote-b', { withActive: true });
  const r = resolveRelease({ promote, local });
  assert.equal(r.kind, 'promote');
  assert.equal(r.releaseId, 'rel-1');
  assert.equal(r.sourceSha, 'b'.repeat(40));
});
test('a Promote release whose tarball does not match its hash is refused, never silently replaced by the baseline', () => {
  const local = registry('local-c');
  const promote = registry('promote-c', { withActive: true, bytes: Buffer.from('tampered') });
  assert.throws(() => resolveRelease({ promote, local }), { code: 'hash_mismatch' });
});
test('an unsafe releaseId is refused', () => {
  const local = registry('local-d');
  const promote = registry('promote-d', { withActive: true });
  writeFileSync(join(promote, 'active.json'), JSON.stringify({ releaseId: '../../etc/passwd' }));
  assert.throws(() => resolveRelease({ promote, local }), { code: 'bad_release' });
});

// ---------------- run record ----------------
const release = { kind: 'baseline', label: 'B', shims: [] };
function run(id, entries) {
  const dir = join(process.env.XARTS_CHAT_RUNS, id);
  mkdirSync(dir, { recursive: true });
  for (const e of entries) appendFileSync(join(dir, 'tools.jsonl'), `${JSON.stringify(e)}\n`);
  return buildRecord({ runId: id, conversationId: 'c', message: 'm', release, result: { isError: false }, exitCode: 0, startedAt: 'now' });
}

test('outcome comes from tool results, not from what the assistant says', () => {
  assert.equal(run('r1', []).outcome, 'no_chart');
  assert.equal(run('r2', [{ tool: 'chart_render', artifact: 'chart-1', chartId: 'bar', checks: [{ id: 'x', status: 'pass' }] }]).outcome, 'rendered');
  assert.equal(run('r3', [{ tool: 'chart_render', artifact: 'chart-1', chartId: 'bar', error: 'boom', code: 'RENDER_FAILED', status: 500 }]).outcome, 'render_failed');
  assert.equal(run('r4', [{ tool: 'chart_render', artifact: 'chart-1', chartId: 'bar', checks: [{ id: 'finite-geometry', status: 'fail' }] }]).outcome, 'rendered_with_failures');
});
test('library 422 errors are input errors; uncoded 500s are flagged as possible library defects, even when recovered', () => {
  const rec = run('r5', [
    { tool: 'chart_render', artifact: 'chart-1', chartId: 'bar', error: 'bad binding', code: 'INVALID_BINDING', status: 422 },
    { tool: 'chart_render', artifact: 'chart-2', chartId: 'ui-waterfall-ui', error: 'uncoded', code: 'RENDER_FAILED', status: 500 },
    { tool: 'chart_render', artifact: 'chart-10', chartId: 'ui-waterfall-ui', checks: [] },
  ]);
  assert.equal(rec.outcome, 'rendered');
  assert.deepEqual(rec.signals.map(s => [s.kind, s.recovered]), [['input_error', false], ['possible_library_defect', true]]);
});

test('a result the server logged as success but Claude received as malformed is a delivery error, not a render', () => {
  const dir = join(process.env.XARTS_CHAT_RUNS, 'r6');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'tools.jsonl'), `${JSON.stringify({ tool: 'chart_render', artifact: 'chart-1', chartId: 'bar', checks: [] })}\n`);
  const rec = buildRecord({ runId: 'r6', conversationId: 'c', message: 'm', release, result: { isError: false }, exitCode: 0, startedAt: 'now',
    deliveredErrors: [{ tool: 'chart_render', text: 'MCP server "xarts" returned a malformed result that failed schema validation' }] });
  assert.equal(rec.outcome, 'tool_delivery_error');
  assert.equal(rec.signals[0].kind, 'tool_delivery_error');
});

// ---------------- label read-back ----------------
const { parseLabel, readbackChecks } = await import('../lib/inspect.mjs');
test('labels parse under their locale', () => {
  assert.deepEqual(parseLabel('105.908', 'en-GB'), { value: 105.908, decimals: 3, suffix: null });
  assert.deepEqual(parseLabel('105.908', 'es-ES'), { value: 105908, decimals: 0, suffix: null });
  assert.equal(parseLabel('+€364.4k', 'en-GB').value, 364.4);
  assert.equal(parseLabel('−28,997', 'en-GB').value, -28997);
  assert.equal(parseLabel('Revenue growth', 'en-GB'), null);
});
test('the thousands-of-euros case is flagged: 3-decimal labels read as whole numbers', () => {
  const texts = ['105.908', '+364.419', '0', '100'].map(text => ({ text }));
  const { checks } = readbackChecks({ texts, overlaps: [], clipped: [], truncated: [] }, { locale: 'en-GB', sql: 'SELECT step, amount_eur / 1000.0 AS k FROM ebitda_bridge' });
  assert.equal(checks.find(c => c.id === 'label-precision').status, 'warn');
  assert.equal(checks.find(c => c.id === 'sql-provenance').status, 'pass');
});
test('numbers typed into SQL instead of queried are caught', () => {
  const none = { texts: [], overlaps: [], clipped: [], truncated: [] };
  assert.equal(readbackChecks(none, { locale: 'en-GB', sql: "SELECT 'A' AS k, 105908 AS v" }).checks.find(c => c.id === 'sql-provenance').status, 'fail');
  assert.equal(readbackChecks(none, { locale: 'en-GB', sql: 'SELECT step, 364419 AS v FROM ebitda_bridge' }).checks.find(c => c.id === 'sql-provenance').status, 'warn');
});

// ---------------- feedback ----------------
const { recordFeedback, feedbackFor } = await import('../lib/feedback.mjs');
function finishedRun(id, chartId) {
  const dir = join(process.env.XARTS_CHAT_RUNS, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'chart-1.spec.json'), JSON.stringify({ chartId, header: { title: 't' } }));
  writeFileSync(join(dir, 'record.json'), JSON.stringify({ request: { message: `ask ${id}` }, release: { kind: 'baseline' }, agent: {},
    renders: [{ artifact: 'chart-1', chartId, ok: true, sql: 'SELECT 1', rows: 1, dataHash: 'h', svgHash: 's', checks: [] }] }));
}
const conv = '11111111-2222-3333-4444-555555555555';
test('a thumbs-down keeps its reasons and a snapshot of what was judged', () => {
  finishedRun('20260919T000001-aaaaaaaa', 'waterfall');
  const ev = recordFeedback({ conversationId: conv, runId: '20260919T000001-aaaaaaaa', artifact: 'chart-1', kind: 'rating', value: 'down', reasons: ['units_format', 'bogus'], note: 'labels read as euros' });
  assert.deepEqual(ev.reasons, ['units_format']);
  assert.equal(ev.subject.chartId, 'waterfall');
  assert.equal(ev.subject.sql, 'SELECT 1');
  assert.equal(feedbackFor('20260919T000001-aaaaaaaa').length, 1);
});
test('a preference between versions becomes a chosen/rejected pair', () => {
  finishedRun('20260919T000002-bbbbbbbb', 'waterfall');
  const ev = recordFeedback({ conversationId: conv, runId: '20260919T000002-bbbbbbbb', artifact: 'chart-1', kind: 'preference', value: 'previous', vs: { runId: '20260919T000001-aaaaaaaa', artifact: 'chart-1' } });
  assert.equal(ev.chosen.runId, '20260919T000001-aaaaaaaa');
  assert.equal(ev.rejected.runId, '20260919T000002-bbbbbbbb');
});
test('feedback on something that was never rendered is refused', () => {
  assert.throws(() => recordFeedback({ conversationId: conv, runId: '20260919T000009-cccccccc', artifact: 'chart-1', kind: 'rating', value: 'up' }), /No finished run/);
  assert.throws(() => recordFeedback({ conversationId: conv, runId: '../../x', artifact: 'chart-1', kind: 'rating', value: 'up' }), /required/);
});


test('incomplete Promote provenance cannot masquerade as an activated release', () => {
  const promote = registry('incomplete-provenance', { withActive: true });
  writeFileSync(join(promote, 'releases', 'rel-1.json'), JSON.stringify({ id: 'rel-1', packageHash: hash }));
  assert.throws(() => resolveRelease({ promote }), { code: 'bad_release' });
});

test('missing final result is recorded independently of successful artifact rendering', () => {
  const rec = buildRecord({ runId: 'r2', conversationId: 'c', message: 'm', release, result: null, exitCode: 0, startedAt: 'now' });
  assert.equal(rec.agent.completion, 'missing');
  assert.equal(rec.outcome, 'rendered'); // artifact observation, not a completed-agent claim
});

test('progress survives reopening and a truncated final write', async () => {
  const { appendProgress, progressFor } = await import('../lib/journal.mjs');
  appendProgress('journal-test', { t: 'request', message: 'Synthetic user request' });
  appendProgress('journal-test', { t: 'text', text: 'Visible assistant output' });
  appendFileSync(join(process.env.XARTS_CHAT_RUNS, 'journal-test', 'events.jsonl'), '{truncated');
  assert.deepEqual(progressFor('journal-test').map(e=>e.t), ['request','text']);
  assert.throws(()=>progressFor('../escape'));
});

test('an already cancelled turn never launches Claude', async () => {
  const { runClaude } = await import('../server/claude.mjs');
  const abort = new AbortController(); abort.abort();
  const result = await runClaude({ signal: abort.signal });
  assert.equal(result.exitCode, null);
  assert.match(result.stderr, /before launch/);
});


test('outbox publication is immutable and an identical retry is idempotent', async () => {
  const { immutableJson } = await import('../lib/journal.mjs');
  const path = join(tmp, 'immutable-record.json');
  immutableJson(path, { id: 'same' });
  immutableJson(path, { id: 'same' });
  assert.throws(()=>immutableJson(path, { id: 'changed' }));
});
