// A fixed reference board, run for N autopilot steps with real models, so that
// a change to the prompts or the evolution can be measured instead of guessed.
// Same goal, same seed, same number of steps every time; each run is appended
// to data/benchmarks.jsonl with the git commit, and compared with the last run
// on the same goal.
//
//   npm run benchmark -- --gen agy:<model> --judge claudecode:sonnet
//   npm run benchmark -- --gen agy:<model> --judge claudecode:sonnet --steps 30 --label "nichos"
//
// Options: --steps N (20) · --goal "…" · --seed "…" · --guidance "…" (jury) · --label "…"
//          --lang pt|en|sv (pt) · --keep (keep the board's database in data/)
//
// Subscription CLIs cost nothing but quota; a run of 20 steps is roughly 30–60 model calls.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { DEFAULT_APP_SETTINGS, ROLES, makeChat } from '../server/providers.ts';
import { medal, onGoal, scoreSum } from '../public/js/score.js';
import { similarity } from '../public/js/evolve.js';

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};

const gen = arg('gen');
const judgeModel = arg('judge');
if (!gen || !judgeModel) {
  console.error('Usage: npm run benchmark -- --gen agy:<model> --judge claudecode:sonnet [--steps 20] [--label "…"]');
  process.exit(2);
}
const steps = Math.max(1, Number(arg('steps', '20')) || 20);
const goal = arg('goal', 'Guias de montagem em realidade aumentada que uma pessoa usa sozinha em casa, construídos inteiramente por agentes de IA')!;
const seedText = arg('seed', 'Guia RA para montar móveis: o celular reconhece cada peça e mostra onde ela entra, passo a passo')!;
const guidance = arg('guidance', '');
const lang = (arg('lang', 'pt') as 'pt' | 'en' | 'sv');
const label = arg('label', '');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dbFile = join(dataDir, `benchmark-${stamp}.db`);

const settings = structuredClone(DEFAULT_APP_SETTINGS);
for (const r of ROLES) settings.models[r] = gen;
settings.models.judge = judgeModel;

const repo = openDb(dbFile);
const engine = createEngine({ repo, chat: makeChat(() => settings), settings: () => settings, gitInit: false });
const board = repo.createBoard({ title: `Benchmark ${stamp}`, goal, config: { lang, judgeGuidance: guidance } });
repo.insertIdea({ boardId: board.id, title: seedText.split(':')[0].slice(0, 120), pitch: seedText.includes(':') ? seedText.slice(seedText.indexOf(':') + 1).trim() : '', kind: 'seed', x: 0, y: 0, generation: 0 });

console.log(`Benchmark: ${steps} steps · generate ${gen} · judge ${judgeModel}${label ? ` · ${label}` : ''}\nGoal: ${goal}\n`);
const started = Date.now();
const did: Record<string, number> = {};
let errors = 0;
let inARow = 0;
for (let n = 1; n <= steps; n++) {
  const t = Date.now();
  try {
    const r = await engine.autoStep(board.id);
    const key = r.did === 'idle' ? `idle:${r.reason}` : r.did;
    did[key] = (did[key] ?? 0) + 1;
    inARow = 0;
    console.log(`  ${String(n).padStart(3)}  ${key.padEnd(18)} ${((Date.now() - t) / 1000).toFixed(0).padStart(4)} s`);
    if (r.did === 'idle' && (r.reason === 'exhausted' || r.reason === 'nothing_to_do')) break;
  } catch (e: any) {
    errors++;
    inARow++;
    console.log(`  ${String(n).padStart(3)}  error ${e?.code ?? ''}: ${String(e?.message ?? e).slice(0, 160)}`);
    if (inARow >= 3) {
      console.log('\nThree errors in a row: stopping.');
      break;
    }
  }
}
await engine.idle();

// ---------------------------------------------------------------- metrics

const ideas = repo.listIdeas(board.id);
const bred = ideas.filter((i) => i.kind !== 'seed' && scoreSum(i) != null);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (x: number | null, d = 2) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

const byGen = new Map<number, typeof bred>();
for (const i of bred) byGen.set(i.generation, [...(byGen.get(i.generation) ?? []), i]);
const generations = [...byGen.keys()].sort((a, b) => a - b).map((g) => {
  const xs = byGen.get(g)!;
  return {
    generation: g,
    ideas: xs.length,
    mean: round(mean(xs.map((i) => scoreSum(i)!))),
    onGoal: round(xs.filter(onGoal).length / xs.length),
    medals: xs.filter((i) => (medal(i) ?? 0) > 0).length,
  };
});
// Diversity: how alike each idea is to its closest other idea (lower is more varied).
const nearest = bred.map((i) => Math.max(0, ...ideas.filter((o) => o.id !== i.id).map((o) => similarity(i, o))));
const half = Math.ceil(bred.length / 2);
const result = {
  date: new Date().toISOString(),
  commit: (() => {
    try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { return null; }
  })(),
  label, goal, seed: seedText, guidance, gen, judge: judgeModel, steps,
  minutes: round((Date.now() - started) / 60000, 1),
  did, errors,
  ideas: bred.length,
  meanSum: round(mean(bred.map((i) => scoreSum(i)!))),
  firstHalf: round(mean(bred.slice(0, half).map((i) => scoreSum(i)!))),
  secondHalf: round(mean(bred.slice(half).map((i) => scoreSum(i)!))),
  best: bred.length ? Math.max(...bred.map((i) => scoreSum(i)!)) : null,
  medals: { bronze: bred.filter((i) => medal(i) === 1).length, silver: bred.filter((i) => medal(i) === 2).length, gold: bred.filter((i) => medal(i) === 3).length },
  onGoal: bred.length ? round(bred.filter(onGoal).length / bred.length) : null,
  nearestSimilarity: round(mean(nearest)),
  generations,
  top: [...bred].sort((a, b) => Number(onGoal(b)) - Number(onGoal(a)) || scoreSum(b)! - scoreSum(a)!).slice(0, 5).map((i) => ({ title: i.title, sum: scoreSum(i), fit: i.fit })),
};

// ---------------------------------------------------------------- report

const log = join(dataDir, 'benchmarks.jsonl');
const previous = existsSync(log)
  ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && r.goal === goal && r.seed === seedText).pop()
  : null;
appendFileSync(log, JSON.stringify(result) + '\n');

console.log('\nGeneration  ideas  mean  on goal  medals');
for (const g of generations) console.log(`  ${String(g.generation).padStart(4)}      ${String(g.ideas).padStart(3)}  ${String(g.mean).padStart(5)}  ${String(Math.round((g.onGoal ?? 0) * 100)).padStart(5)} %  ${String(g.medals).padStart(4)}`);
const fmt = (k: string, v: unknown, p?: unknown) => console.log(`  ${k.padEnd(22)} ${String(v ?? '–').padStart(8)}${previous ? `   (last: ${p ?? '–'})` : ''}`);
console.log(`\n${result.ideas} ideas in ${result.minutes} min, ${errors} errors${previous ? ` · compared with ${previous.commit ?? '?'} ${previous.label ?? ''} of ${String(previous.date).slice(0, 10)}` : ''}`);
fmt('mean sum (3–15)', result.meanSum, previous?.meanSum);
fmt('first → second half', `${result.firstHalf} → ${result.secondHalf}`, previous && `${previous.firstHalf} → ${previous.secondHalf}`);
fmt('best', result.best, previous?.best);
fmt('medals 🥉🥈🥇', `${result.medals.bronze}/${result.medals.silver}/${result.medals.gold}`, previous && `${previous.medals.bronze}/${previous.medals.silver}/${previous.medals.gold}`);
fmt('on goal', result.onGoal == null ? null : `${Math.round(result.onGoal * 100)} %`, previous?.onGoal == null ? null : `${Math.round(previous.onGoal * 100)} %`);
fmt('nearest similarity', result.nearestSimilarity, previous?.nearestSimilarity);
console.log('\nBest ideas:');
for (const t of result.top) console.log(`  ${t.sum}  fit ${t.fit ?? '?'}  ${t.title}`);
console.log(`\nSaved to ${log}`);

if (!process.argv.includes('--keep')) {
  try {
    repo.close();
  } catch { /* ignore */ }
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) rmSync(f, { force: true });
} else {
  console.log(`Board kept in ${dbFile} (open it with DB_FILE=${dbFile} npm start).`);
}
