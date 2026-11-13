// Subscription models through their own command-line agents, run headless on
// this machine: no API key, the CLI is already signed in.
//
//   agy:<model>         Antigravity CLI  (agy -p … --output-format json)
//   claudecode:<model>  Claude Code      (claude -p --output-format json, prompt on stdin)
//
// Each call is one process in an empty temp folder, so the agent finds no
// project files, no AGENTS.md and no CLAUDE.md. The answer is JSON asked for in
// the prompt; neither CLI is trusted to enforce a schema.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, extname, isAbsolute, join } from 'node:path';

export type CliId = 'agy' | 'claudecode';
/** timeoutS: how long one headless turn may take. agy with gemini-3.8-flash-high took 84–202 s per step on a real board. */
type CliDef = { bin: string; env: string; label: string; models: string[]; timeoutS: number };

export const CLIS: Record<CliId, CliDef> = {
  agy: { bin: 'agy', env: 'AGY_BIN', label: 'Antigravity CLI', models: ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low'], timeoutS: 300 },
  claudecode: { bin: 'claude', env: 'CLAUDE_BIN', label: 'Claude Code', models: ['sonnet', 'opus', 'haiku'], timeoutS: 180 },
};

export class CliError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const WIN = process.platform === 'win32';
const TIMEOUT_S = 180;
/** Longest prompt passed as an argument; Windows caps a command line near 32k characters. */
const MAX_ARG = 20_000;

/** The command that starts a CLI: the env override, or the first match on PATH. A script path runs under this Node. */
export function findBin(id: CliId): string[] | null {
  const { bin, env } = CLIS[id];
  const override = process.env[env]?.trim();
  if (override) return /\.(m?js|ts)$/i.test(override) ? [process.execPath, override] : [override];
  const exts = WIN ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = join(dir, bin + ext);
      if (existsSync(p)) return [p];
    }
  }
  return null;
}

const isBatch = (cmd: string[]) => WIN && /\.(cmd|bat)$/i.test(extname(cmd[0]));

type Run = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

function run(cmd: string[], args: string[], o: { cwd: string; stdin?: string; timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<Run> {
  return new Promise((resolve, reject) => {
    // A .cmd shim only starts through the shell, which does not quote for us.
    const batch = isBatch(cmd);
    const q = (s: string) => (/[\s"&|<>^%]/.test(s) ? `"${s.replace(/"/g, '')}"` : s);
    const [file, ...head] = cmd;
    const proc = batch
      ? spawn([file, ...head, ...args].map(q).join(' '), { cwd: o.cwd, env: o.env, shell: true, windowsHide: true })
      : spawn(file, [...head, ...args], { cwd: o.cwd, env: o.env, windowsHide: true });
    let stdout = '', stderr = '', timedOut = false;
    proc.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    proc.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      // The CLI starts children of its own; on Windows only taskkill takes the whole tree.
      if (WIN && proc.pid) spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
      else proc.kill('SIGKILL');
    }, o.timeoutMs);
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
    proc.stdin.on('error', () => {});
    proc.stdin.end(o.stdin ?? '');
  });
}

/** The outermost JSON value in a CLI's stdout (banners and warnings may surround it). */
function outerJson(text: string): any {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    const a = t.search(/[{[]/);
    const b = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (a >= 0 && b > a) {
      try { return JSON.parse(t.slice(a, b + 1)); } catch { /* fall through */ }
    }
    return null;
  }
}

const LIMIT = /RESOURCE_EXHAUSTED|rate.?limit|\b429\b|quota|usage limit|limit reached/i;
function failure(label: string, r: Run, detail: string, timeoutS = TIMEOUT_S): CliError {
  const text = `${detail} ${r.stderr}`.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (r.timedOut || /print_timeout|DEADLINE_EXCEEDED/.test(text)) return new CliError('timeout', `${label}: no answer within ${timeoutS} s`);
  if (LIMIT.test(text)) return new CliError('rate_limited', `${label}: the subscription's usage limit is reached. ${text}`);
  if (/not logged in|login|authenticat|unauthori/i.test(text)) return new CliError('bad_key', `${label}: not signed in. Open the CLI once in a terminal and sign in. ${text}`);
  return new CliError('provider_error', `${label} (exit ${r.code}): ${text || 'no output'}`);
}

// At most two processes per CLI: a subscription's limits are per account, and each process is heavy.
const slots: Record<CliId, { active: number; waiting: (() => void)[] }> = { agy: { active: 0, waiting: [] }, claudecode: { active: 0, waiting: [] } };
async function withSlot<T>(id: CliId, fn: () => Promise<T>): Promise<T> {
  const s = slots[id];
  if (s.active >= 2) await new Promise<void>((r) => s.waiting.push(r));
  s.active++;
  try {
    return await fn();
  } finally {
    s.active--;
    s.waiting.shift()?.();
  }
}

/** One headless turn. Returns the model's text answer. */
export async function cliText(id: CliId, model: string, prompt: string, timeoutS = CLIS[id].timeoutS): Promise<string> {
  const { label } = CLIS[id];
  const cmd = findBin(id);
  if (!cmd) throw new CliError('unreachable', `${label}: "${CLIS[id].bin}" is not on PATH. Install it, or set ${CLIS[id].env} to its full path.`);
  if (!/^[\w.:\/-]+$/.test(model)) throw new CliError('bad_model', `${label}: "${model}" is not a model name`);
  return withSlot(id, async () => {
    const cwd = await mkdtemp(join(tmpdir(), `ideagen-${id}-`));
    try {
      let r: Run;
      if (id === 'agy') {
        // agy takes the prompt as an argument. Too long, or behind a .cmd shim that cannot carry
        // newlines: put it in a file and point the agent at it.
        let arg = prompt;
        if (prompt.length > MAX_ARG || isBatch(cmd)) {
          await writeFile(join(cwd, 'prompt.md'), prompt, 'utf8');
          arg = 'Read the file prompt.md in the current folder and do exactly what it says. Reply with only the JSON it asks for.';
        }
        r = await run(cmd, ['-p', arg, '--model', model, '--mode', 'accept-edits', '--output-format', 'json', '--print-timeout', `${timeoutS}s`], {
          cwd, timeoutMs: (timeoutS + 30) * 1000,
        });
        const out = outerJson(r.stdout);
        if (r.code !== 0 || out?.status !== 'SUCCESS') throw failure(label, r, [out?.error, out?.finished_reason, out ? '' : r.stdout.slice(0, 200)].filter(Boolean).join(' '), timeoutS);
        return String(out.response ?? '');
      }
      // Claude Code reads the prompt from stdin. Without an API key in its environment it uses the
      // signed-in subscription; with one it would bill the key instead.
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
      delete env.ANTHROPIC_BASE_URL;
      r = await run(cmd, ['-p', '--output-format', 'json', '--model', model, '--disallowedTools', 'Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch'], {
        cwd, stdin: prompt, timeoutMs: (timeoutS + 30) * 1000, env,
      });
      const parsed = outerJson(r.stdout);
      const out = Array.isArray(parsed) ? parsed.findLast((m: any) => m?.type === 'result') : parsed;
      if (r.code !== 0 || !out || out.is_error) throw failure(label, r, [out?.result, out?.subtype, out ? '' : r.stdout.slice(0, 200)].filter(Boolean).join(' '), timeoutS);
      return String(out.result ?? '');
    } catch (e: any) {
      if (e instanceof CliError) throw e;
      throw new CliError('unreachable', `${label}: could not start ${cmd[0]} (${e?.code ?? e?.message ?? e})`);
    } finally {
      await rm(cwd, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
  });
}

/** Connection test: the CLI starts and reports a version. The models are suggestions; any name the CLI accepts works,
 * and only a real call tells whether a name is accepted (see probeModels in providers.ts). */
export async function cliModels(id: CliId): Promise<string[]> {
  const { label } = CLIS[id];
  const cmd = findBin(id);
  if (!cmd) throw new CliError('unreachable', `${label}: "${CLIS[id].bin}" is not on PATH. Install it, or set ${CLIS[id].env} to its full path.`);
  const cwd = isAbsolute(tmpdir()) ? tmpdir() : process.cwd();
  let r: Run;
  try {
    r = await run(cmd, ['--version'], { cwd, timeoutMs: 20_000 });
  } catch (e: any) {
    throw new CliError('unreachable', `${label}: could not start ${cmd[0]} (${e?.code ?? e?.message ?? e})`);
  }
  if (r.code !== 0) throw failure(label, r, r.stdout.slice(0, 200));
  return CLIS[id].models;
}
