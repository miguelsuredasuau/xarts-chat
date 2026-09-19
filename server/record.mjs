import { atomicJson, immutableJson } from '../lib/journal.mjs';
// Run record: what Promote reads. One file per chat turn in runs/<runId>/record.json,
// plus an append-only runs/index.jsonl and a copy in runs/outbox/ for Promote to consume.
// Facts only: outcome is derived from tool results and library errors, never from
// the assistant's own description of what it did.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { RUNS_DIR, DB_FILE } from '../lib/paths.mjs';

export const RECORD_SCHEMA = 'xarts-chat/run-record@1';
const num = a => Number(String(a).replace(/\D/g, '')) || 0;
const sha = b => createHash('sha256').update(b).digest('hex');

// Codes raised by xarts-chat itself before the library is reached: always input errors.
const CHAT_INPUT_CODES = new Set(['DATA_NOT_ALLOWED', 'SQL_ERROR', 'SQL_NOT_SELECT', 'SQL_MULTI', 'TOO_MANY_ROWS']);

function readToolLog(runDir) {
  const f = join(runDir, 'tools.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

export function buildRecord({ runId, conversationId, message, release, session, result, exitCode, stderr, startedAt, finalText, aborted, deliveredErrors = [] }) {
  const runDir = join(RUNS_DIR, runId);
  const tools = readToolLog(runDir);
  const renders = tools.filter(t => t.tool === 'chart_render');
  const ok = renders.filter(r => !r.error && !r.rejected);
  const failed = renders.filter(r => r.error || r.rejected);
  const lastRender = renders.at(-1);
  const failingChecks = ok.flatMap(r => (r.checks ?? []).filter(c => c.status === 'fail').map(c => ({ artifact: r.artifact, ...c })));
  const warnChecks = ok.flatMap(r => (r.checks ?? []).filter(c => c.status === 'warn').map(c => ({ artifact: r.artifact, ...c })));

  const transportFailures = deliveredErrors.filter(d => /malformed result|schema validation|MCP error/i.test(d.text));
  let outcome;
  if (aborted) outcome = 'cancelled';
  else if (exitCode !== 0 || result?.isError) outcome = result?.subtype === 'error_max_budget_usd' ? 'budget_exhausted' : 'error';
  else if (transportFailures.length) outcome = 'tool_delivery_error';
  else if (!renders.length) outcome = 'no_chart';
  else if (lastRender && (lastRender.error || lastRender.rejected)) outcome = 'render_failed';
  else if (failingChecks.length) outcome = 'rendered_with_failures';
  else if (warnChecks.length) outcome = 'rendered_with_warnings';
  else outcome = 'rendered';

  // Signals are hints for Promote's triage, not verdicts.
  const signals = [];
  for (const f of failed) {
    const code = f.code ?? (f.rejected ? 'DATA_NOT_ALLOWED' : 'RENDER_ERROR');
    signals.push({
      // Library classification (diagnosticStatus 422 = input, 500 = library) wins; unknown → flag for review.
      kind: CHAT_INPUT_CODES.has(code) || f.status === 422 ? 'input_error' : 'possible_library_defect',
      artifact: f.artifact, chartId: f.chartId ?? null, code, message: f.error ?? f.rejected,
      recovered: ok.some(o => o.chartId === f.chartId && num(o.artifact) > num(f.artifact)),
    });
  }
  for (const c of failingChecks) signals.push({ kind: 'possible_library_defect', artifact: c.artifact, code: `CHECK_${c.id}`, message: c.detail, recovered: false });
  // The agent's view can differ from the server's: a result the server logged as a success
  // but Claude received as an error (e.g. a malformed MCP result) means the agent answered blind.
  for (const d of transportFailures) signals.push({ kind: 'tool_delivery_error', code: 'MCP_RESULT_REJECTED', message: `${d.tool}: ${d.text}`, recovered: false });
  if (release.shims?.length) signals.push({ kind: 'packaging_workaround', code: 'RUNTIME_SHIM', message: release.shims.map(s => s.id).join(', '), recovered: true });

  return {
    schema: RECORD_SCHEMA,
    runId, conversationId,
    startedAt, finishedAt: new Date().toISOString(),
    request: { message, messageHash: sha(message) },
    dataset: { file: 'data/finance.sqlite', sha256: existsSync(DB_FILE) ? sha(readFileSync(DB_FILE)) : null, nature: 'synthetic' },
    release,
    agent: {
      completion: aborted ? 'cancelled' : result ? 'confirmed' : 'missing',
      runner: 'claude -p', sessionId: session?.sessionId ?? result?.sessionId ?? null, model: session?.model ?? null,
      tools: 'mcp__xarts only (data_schema, data_query, chart_search, chart_describe, chart_render)',
      usage: result ? { costUsd: result.costUsd, source: 'reported by claude -p result event', durationMs: result.durationMs, turns: result.turns, tokens: result.usage } : null,
    },
    outcome,
    renders: renders.map(r => ({
      artifact: r.artifact, chartId: r.chartId ?? null, ok: !r.error && !r.rejected,
      sql: r.sql ?? null, rows: r.rows ?? null, dataHash: r.dataHash ?? null, svgHash: r.svgHash ?? null,
      warnings: r.warnings ?? [], checks: r.checks ?? [], error: r.error ?? r.rejected ?? null, code: r.code ?? null, renderMs: r.renderMs ?? null,
    })),
    queries: tools.filter(t => t.tool === 'data_query').map(t => ({ sql: t.sql, rows: t.rows ?? null, error: t.error ?? null })),
    signals,
    checksNote: 'checks are local observations by xarts-chat, not Promote gates',
    finalText: finalText ?? result?.finalText ?? null,
    exitCode, stderr: exitCode ? stderr : undefined,
  };
}

export function writeRecord(record) {
  const runDir = join(RUNS_DIR, record.runId);
  mkdirSync(join(RUNS_DIR, 'outbox'), { recursive: true });
  const json = `${JSON.stringify(record, null, 2)}\n`;
  atomicJson(join(runDir, 'record.json'), record);
  immutableJson(join(RUNS_DIR, 'outbox', `${record.runId}.json`), record);
  appendFileSync(join(RUNS_DIR, 'index.jsonl'), `${JSON.stringify({
    runId: record.runId, conversationId: record.conversationId, at: record.finishedAt, outcome: record.outcome,
    message: record.request.message.slice(0, 160), charts: record.renders.filter(r => r.ok).map(r => r.chartId),
    release: record.release?.label, costUsd: record.agent.usage?.costUsd ?? null, signals: record.signals.length,
  })}\n`);
}

export function listRuns(limit = 50) {
  const f = join(RUNS_DIR, 'index.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).slice(-limit).reverse();
}
