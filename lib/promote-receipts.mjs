import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './paths.mjs';

function receiptRoot() {
  if (process.env.PROMOTE_RECEIPTS) return process.env.PROMOTE_RECEIPTS;
  const config = join(ROOT, '.local', 'integration.json');
  if (!existsSync(config)) return null;
  return JSON.parse(readFileSync(config, 'utf8')).promoteReceipts ?? null;
}
export function promoteReceipt(source) {
  if (!/^[A-Za-z0-9_-]+\.json$/.test(source)) throw new Error('Invalid source');
  const root = receiptRoot();
  if (!root) return { status: 'not_connected' };
  const path = join(root, source);
  if (!existsSync(path)) return { status: 'pending' };
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return { status: 'unavailable' }; }
}
