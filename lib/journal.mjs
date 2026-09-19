// Local, append-only user-visible execution history. Never stores hidden model reasoning.
import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, linkSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { RUNS_DIR } from './paths.mjs';
const safe = value => /^[A-Za-z0-9_-]{1,128}$/.test(value);

export function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  const fd = openSync(tmp, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}

export function appendProgress(runId, event) {
  if (!safe(runId)) throw new Error('Invalid run ID');
  const dir = join(RUNS_DIR, runId); mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify({ schema: 'xarts-chat/progress@1', eventId: randomUUID(), at: new Date().toISOString(), runId, ...event })}\n`);
}

export function progressFor(runId) {
  if (!safe(runId)) throw new Error('Invalid run ID');
  const path = join(RUNS_DIR, runId, 'events.jsonl');
  if (!existsSync(path)) return [];
  // A process crash can leave only the final line truncated. Earlier evidence survives.
  const lines = readFileSync(path, 'utf8').split('\n');
  return lines.filter((line, i) => line && (i < lines.length - 1)).map(line => JSON.parse(line));
}


/** Atomic create-only outbox publication. Equal retries are harmless; changed evidence is rejected. */
export function immutableJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, bytes, { flag: 'wx' });
  const fd = openSync(tmp, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  try {
    try { linkSync(tmp, path); }
    catch (error) { if (error.code !== 'EEXIST' || readFileSync(path, 'utf8') !== bytes) throw error; }
  } finally { unlinkSync(tmp); }
}
