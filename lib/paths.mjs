import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DB_FILE = process.env.XARTS_CHAT_DB ?? join(ROOT, 'data', 'finance.sqlite');
export const RUNS_DIR = process.env.XARTS_CHAT_RUNS ?? join(ROOT, 'runs');
