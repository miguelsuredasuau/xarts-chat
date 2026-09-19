// One chat turn = one `claude -p` process, restricted to the xarts MCP tools.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, DB_FILE } from '../lib/paths.mjs';
import { SYSTEM_PROMPT } from './prompt.mjs';

const MCP_SERVER = join(ROOT, 'mcp', 'xarts-tools.mjs');
const TSX = fileURLToPath(import.meta.resolve('tsx'));
export const BUDGET_USD = Number(process.env.XARTS_CHAT_BUDGET_USD ?? 1.5);
if (!Number.isFinite(BUDGET_USD) || BUDGET_USD <= 0) throw new Error('XARTS_CHAT_BUDGET_USD must be positive');
export const MODEL = process.env.XARTS_CHAT_MODEL ?? null;

/**
 * Runs one turn and calls onEvent with normalized events:
 *   { t: 'session', sessionId, model }
 *   { t: 'text', text }                     streamed assistant text
 *   { t: 'tool-start', id, name, input }
 *   { t: 'tool-result', id, isError, payload }
 *   { t: 'result', ... }                    final usage as reported by claude -p
 * Resolves with { exitCode, stderr }.
 */
export function runClaude({ message, sessionId, conversationId, runDir, pkgDir, shims, onEvent, signal }) {
  if (signal?.aborted) return Promise.resolve({ exitCode: null, stderr: 'Cancelled before launch' });
  const sandbox = join(ROOT, '.sandbox', conversationId);
  mkdirSync(sandbox, { recursive: true });
  const nodeArgs = ['--no-warnings', ...(shims.includes('ts-loader') ? ['--import', TSX] : []), MCP_SERVER];
  const mcpConfig = {
    mcpServers: {
      xarts: {
        command: process.execPath,
        args: nodeArgs,
        env: { XARTS_PKG_DIR: pkgDir, XARTS_RUN_DIR: runDir, XARTS_CHAT_DB: DB_FILE, PATH: process.env.PATH },
      },
    },
  };
  const args = [
    '-p', message,
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--mcp-config', JSON.stringify(mcpConfig), '--strict-mcp-config',
    '--tools', '',
    '--allowedTools', 'mcp__xarts',
    '--setting-sources', 'project',
    '--system-prompt', SYSTEM_PROMPT,
    '--max-budget-usd', String(BUDGET_USD),
  ];
  if (MODEL) args.push('--model', MODEL);
  if (sessionId) args.push('--resume', sessionId);

  return new Promise(resolvePromise => {
    const child = spawn('claude', args, { cwd: sandbox, stdio: ['ignore', 'pipe', 'pipe'], env: process.env, detached: process.platform !== 'win32' });
    let forceTimer;
    const kill = sig => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig); else child.kill(sig); } catch {} };
    const abort = () => { kill('SIGTERM'); forceTimer ??= setTimeout(() => kill('SIGKILL'), 5000); };
    signal?.addEventListener('abort', abort, { once: true });
    const deadline = setTimeout(abort, 180000);
    if (signal?.aborted) abort();
    let buf = '';
    let stderr = '';
    const toolNames = new Map();
    child.stdout.on('data', chunk => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        handle(ev);
      }
    });
    child.stderr.on('data', c => { stderr = (stderr + c).slice(-4000); });
    child.on('error', e => { stderr = `Claude launch failed: ${e.code ?? 'unknown'}`; });
    child.on('close', code => { clearTimeout(deadline); clearTimeout(forceTimer); signal?.removeEventListener('abort', abort); resolvePromise({ exitCode: code, stderr: stderr.slice(-4000) }); });

    function handle(ev) {
      if (ev.type === 'system' && ev.subtype === 'init') {
        onEvent({ t: 'session', sessionId: ev.session_id, model: ev.model, tools: ev.tools, mcp: ev.mcp_servers });
      } else if (ev.type === 'stream_event') {
        const e = ev.event;
        if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') onEvent({ t: 'text', text: e.delta.text });
      } else if (ev.type === 'assistant') {
        for (const block of ev.message?.content ?? []) {
          if (block.type === 'tool_use') {
            const name = String(block.name).replace(/^mcp__xarts__/, '');
            toolNames.set(block.id, name);
            onEvent({ t: 'tool-start', id: block.id, name, input: block.input });
          }
        }
      } else if (ev.type === 'user') {
        for (const block of ev.message?.content ?? []) {
          if (block.type !== 'tool_result') continue;
          const raw = Array.isArray(block.content) ? block.content.map(c => c.text ?? '').join('') : String(block.content ?? '');
          let payload;
          try { payload = JSON.parse(raw); } catch { payload = { text: raw.slice(0, 2000) }; }
          onEvent({ t: 'tool-result', id: block.tool_use_id, name: toolNames.get(block.tool_use_id), isError: !!block.is_error, payload });
        }
      } else if (ev.type === 'result') {
        onEvent({
          t: 'result', subtype: ev.subtype, isError: !!ev.is_error, sessionId: ev.session_id,
          costUsd: ev.total_cost_usd ?? null, durationMs: ev.duration_ms ?? null, turns: ev.num_turns ?? null,
          usage: ev.usage ?? null, finalText: typeof ev.result === 'string' ? ev.result : null,
        });
      }
    }
  });
}
