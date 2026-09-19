#!/usr/bin/env node
// Turns runs/feedback.jsonl into datasets Promote can use:
//
//   runs/feedback-dataset/preferences.jsonl  chosen vs rejected versions of the same request
//                                             (the shape preference-tuning methods expect)
//   runs/feedback-dataset/ratings.jsonl      single-chart judgements with reasons
//   runs/feedback-dataset/eval-cases.jsonl   disliked charts as regression cases: request + what went wrong,
//                                             to re-run against a new prompt, model or Xarts release
//
// Honest scope: nothing here trains a model. These are evaluation and preference
// data. Today they feed the agent through chart_describe's `houseNotes`; they can
// feed prompt changes, Promote incidents, or later fine-tuning.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS_DIR } from '../lib/paths.mjs';

const file = join(RUNS_DIR, 'feedback.jsonl');
const events = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const out = join(RUNS_DIR, 'feedback-dataset');
mkdirSync(out, { recursive: true });

const brief = s => s && ({ runId: s.runId, artifact: s.artifact, chartId: s.chartId, spec: s.spec, sql: s.sql, dataHash: s.dataHash, checks: s.checks, release: s.release, model: s.model });
const preferences = events.filter(e => e.kind === 'preference' && e.chosen && e.rejected).map(e => ({
  id: e.id, at: e.at, prompt: e.revisionRequest, chosen: brief(e.chosen), rejected: brief(e.rejected), note: e.note || null,
}));
const ratings = events.filter(e => e.kind === 'rating').map(e => ({
  id: e.id, at: e.at, request: e.subject.request, label: e.value, reasons: e.reasons, note: e.note || null, chart: brief(e.subject),
}));
const evalCases = ratings.filter(r => r.label === 'down').map(r => ({
  id: `eval-${r.id}`, request: r.request, datasetHash: null, mustNot: r.reasons, humanNote: r.note, failingChart: r.chart,
}));

const write = (name, rows) => writeFileSync(join(out, name), rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
write('preferences.jsonl', preferences);
write('ratings.jsonl', ratings);
write('eval-cases.jsonl', evalCases);
console.log(JSON.stringify({ events: events.length, preferences: preferences.length, ratings: ratings.length, up: ratings.filter(r => r.label === 'up').length, evalCases: evalCases.length, out }, null, 1));
