import { atomicJson, immutableJson } from './journal.mjs';
// Human feedback on charts: ratings with reasons, and preferences between versions.
//
// Each event is stored with a SNAPSHOT of what was judged (request, SQL, data hash,
// spec, checks, release), so it stays meaningful after the run directory is gone
// and can be used without re-deriving context:
//   runs/feedback.jsonl               append-only log
//   runs/outbox/feedback-<id>.json    one file per event for Promote
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { RUNS_DIR } from './paths.mjs';

export const FEEDBACK_SCHEMA = 'xarts-chat/feedback@1';
export const REASONS = ['numbers_wrong', 'units_format', 'wrong_form', 'hard_to_read', 'title_misleading', 'missed_request'];
const RUN_RE = /^[0-9TZ]+-[a-f0-9]{8}$/;
const ART_RE = /^chart-\d+$/;
const UUID_RE = /^[a-f0-9-]{36}$/;

export class FeedbackError extends Error {}

function snapshot(runId, artifact) {
  const dir = join(RUNS_DIR, runId);
  const rec = existsSync(join(dir, 'record.json')) ? JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8')) : null;
  if (!rec) throw new FeedbackError(`No finished run ${runId}`);
  const render = rec.renders.find(r => r.artifact === artifact && r.ok);
  if (!render) throw new FeedbackError(`No successful render ${artifact} in ${runId}`);
  const specFile = join(dir, `${artifact}.spec.json`);
  return {
    runId, artifact,
    request: rec.request.message,
    chartId: render.chartId,
    spec: existsSync(specFile) ? JSON.parse(readFileSync(specFile, 'utf8')) : null,
    sql: render.sql, rows: render.rows, dataHash: render.dataHash, svgHash: render.svgHash,
    checks: render.checks.map(c => ({ id: c.id, status: c.status })),
    release: { kind: rec.release?.kind, releaseId: rec.release?.releaseId ?? null, sourceSha: rec.release?.sourceSha, packageHash: rec.release?.packageHash },
    model: rec.agent?.model ?? null,
  };
}

export function recordFeedback(input) {
  const { conversationId, runId, artifact, kind } = input ?? {};
  if (!UUID_RE.test(conversationId ?? '')) throw new FeedbackError('conversationId is required');
  if (!RUN_RE.test(runId ?? '') || !ART_RE.test(artifact ?? '')) throw new FeedbackError('runId and artifact are required');
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, 500) : '';
  const event = { schema: FEEDBACK_SCHEMA, id: randomUUID(), at: new Date().toISOString(), conversationId, kind };

  if (kind === 'rating') {
    if (!['up', 'down'].includes(input.value)) throw new FeedbackError('rating value must be up or down');
    const reasons = Array.isArray(input.reasons) ? [...new Set(input.reasons)].filter(r => REASONS.includes(r)) : [];
    Object.assign(event, { value: input.value, reasons: input.value === 'down' ? reasons : [], note, subject: snapshot(runId, artifact) });
  } else if (kind === 'preference') {
    if (!['this', 'previous', 'same'].includes(input.value)) throw new FeedbackError('preference value must be this, previous or same');
    const vs = input.vs ?? {};
    if (!RUN_RE.test(vs.runId ?? '') || !ART_RE.test(vs.artifact ?? '')) throw new FeedbackError('preference needs vs.runId and vs.artifact');
    const current = snapshot(runId, artifact);
    const previous = snapshot(vs.runId, vs.artifact);
    Object.assign(event, {
      value: input.value, note,
      // Normalised pair: chosen/rejected, or a tie. `current` is the newer version.
      chosen: input.value === 'this' ? current : input.value === 'previous' ? previous : null,
      rejected: input.value === 'this' ? previous : input.value === 'previous' ? current : null,
      tie: input.value === 'same' ? [previous, current] : null,
      revisionRequest: current.request,
    });
  } else {
    throw new FeedbackError('kind must be rating or preference');
  }

  mkdirSync(join(RUNS_DIR, 'outbox'), { recursive: true });
  appendFileSync(join(RUNS_DIR, 'feedback.jsonl'), `${JSON.stringify(event)}\n`);
  immutableJson(join(RUNS_DIR, 'outbox', `feedback-${event.id}.json`), event);
  return event;
}

export function feedbackFor(runId) {
  const f = join(RUNS_DIR, 'feedback.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    .filter(e => e.subject?.runId === runId || e.chosen?.runId === runId || e.rejected?.runId === runId || e.tie?.some(t => t.runId === runId))
    .map(e => ({ id: e.id, at: e.at, kind: e.kind, value: e.value, reasons: e.reasons, note: e.note }));
}
