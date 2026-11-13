import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffMs, createAutopilot, nextLocalMidnight, rateCheck, type RateInput } from '../server/autopilot.ts';
import { openDb } from '../server/db.ts';
import { createBus, createEngine } from '../server/engine.ts';
import { DEFAULT_APP_SETTINGS, ProviderError, type ChatRequest } from '../server/providers.ts';

const T = Date.parse('2026-11-02T12:00:00');
const base: RateInput = {
  now: T, steps: [], lastAt: 0, paceSeconds: 10, stepsPerHour: 60, boardSpent: 0, boardUsdPerDay: 1,
  globalSpent: 0, globalUsdPerDay: 5, errors: 0, lastErrorAt: 0,
};

test('rate limiter: budgets, backoff, hourly window, pace', () => {
  assert.deepEqual(rateCheck(base), { ok: true });
  assert.deepEqual(rateCheck({ ...base, globalSpent: 5 }), { ok: false, reason: 'global_budget', until: nextLocalMidnight(T) });
  assert.equal((rateCheck({ ...base, boardSpent: 1.2 }) as any).reason, 'board_budget');
  assert.equal((rateCheck({ ...base, boardSpent: 0.99 }) as any).ok, true);
  // 0 = free models only: nothing spent keeps running, the first paid cent stops it
  assert.equal(rateCheck({ ...base, boardUsdPerDay: 0, boardSpent: 0 }).ok, true);
  assert.equal((rateCheck({ ...base, boardUsdPerDay: 0, boardSpent: 0.001 }) as any).reason, 'board_budget');

  assert.deepEqual([1, 2, 3, 10].map(backoffMs), [30_000, 60_000, 120_000, 900_000]);
  assert.equal((rateCheck({ ...base, errors: 2, lastErrorAt: T - 30_000 }) as any).reason, 'backoff');
  assert.equal(rateCheck({ ...base, errors: 2, lastErrorAt: T - 61_000 }).ok, true);

  const steps = [T - 3_500_000, T - 1000];
  assert.deepEqual(rateCheck({ ...base, steps, stepsPerHour: 2 }), { ok: false, reason: 'hourly', until: T - 3_500_000 + 3_600_000 });
  assert.equal(rateCheck({ ...base, steps: [T - 3_700_000, T - 1000], stepsPerHour: 2 }).ok, true, 'old steps leave the window');

  assert.deepEqual(rateCheck({ ...base, lastAt: T - 4000 }), { ok: false, reason: 'pace', until: T + 6000 });
});

test('local midnight is the next calendar day at 00:00', () => {
  const m = new Date(nextLocalMidnight(T));
  assert.deepEqual([m.getDate(), m.getHours(), m.getMinutes()], [3, 0, 0]);
});

function fakeEngineFor(repo: ReturnType<typeof openDb>) {
  const bus = createBus();
  const steps: number[] = [];
  let fail = false;
  return {
    steps,
    setFail: (v: boolean) => (fail = v),
    engine: {
      bus,
      async autoStep(boardId: number) {
        if (fail) throw Object.assign(new Error('no key'), { code: 'no_key' });
        steps.push(boardId);
        repo.addSpend(boardId, 0.3);
        return { did: 'combine' as const };
      },
    } as any,
  };
}

test('scheduler: only auto boards run, at their pace, within their limits', async () => {
  const repo = openDb(':memory:');
  let now = T;
  const { engine, steps, setFail } = fakeEngineFor(repo);
  const ap = createAutopilot({ repo, engine, settings: () => DEFAULT_APP_SETTINGS, now: () => now });
  const auto = repo.createBoard({ title: 'Auto', config: { mode: 'auto', autopilotSeconds: 10, rate: { stepsPerHour: 3, usdPerDay: 100 } } });
  repo.createBoard({ title: 'Manual' });
  const flush = () => new Promise((r) => setTimeout(r, 5));

  await ap.tick(); await flush();
  assert.deepEqual(steps, [auto.id], 'the manual board never runs');
  now += 5_000; await ap.tick(); await flush();
  assert.equal(steps.length, 1);
  assert.equal(ap.status(auto.id).state, 'pace');
  now += 5_000; await ap.tick(); await flush();
  now += 10_000; await ap.tick(); await flush();
  assert.equal(steps.length, 3);
  now += 10_000; await ap.tick(); await flush();
  assert.equal(steps.length, 3, 'three steps per hour');
  assert.equal(ap.status(auto.id).state, 'hourly');

  // Errors back off, and the status says why.
  now += 3_600_000; setFail(true);
  await ap.tick(); await flush();
  assert.equal(ap.status(auto.id).state, 'error');
  assert.equal(ap.status(auto.id).code, 'no_key');
  now += 15_000; await ap.tick(); await flush();
  assert.equal(ap.status(auto.id).state, 'backoff');
  assert.equal(ap.status(auto.id).code, 'no_key', 'the reason stays on screen while backing off');
  assert.ok(ap.status(auto.id).message);
  setFail(false);
  now += 30_000; await ap.tick(); await flush();
  assert.equal(steps.length, 4, 'recovers after the backoff');
  assert.equal(ap.status(auto.id).message, undefined, 'and the old error is gone');

  // Budget: the board has spent 4 × $0.30; a $1 cap stops it until midnight.
  repo.updateBoard(auto.id, { config: { rate: { stepsPerHour: 3, usdPerDay: 1 } } });
  now += 20_000; await ap.tick(); await flush();
  assert.equal(ap.status(auto.id).state, 'board_budget');
  assert.equal(steps.length, 4);

  repo.updateBoard(auto.id, { config: { mode: 'manual' } });
  await ap.tick();
  assert.equal(ap.status(auto.id).state, 'manual');
});

test('autoStep with the real engine: judge first, grow a small pool, then breed', async () => {
  const repo = openDb(':memory:');
  let n = 0;
  const chat = async (r: ChatRequest) => {
    n++;
    const value =
      r.schemaName === 'expand' ? { ideas: [1, 2, 3].map((k) => ({ title: `Idé ${n}.${k}`, pitch: 'p' })) }
      // Scores that keep climbing, so the board never stalls and the test is about breeding alone.
      : r.schemaName === 'judgement' ? { reason: 'r', originality: Math.min(5, 1 + Math.floor(n / 4)), feasibility: 3, impact: 3, keywords: ['k'] }
      : { title: `Korsning ${n}`, pitch: 'p' };
    return { value, costUsd: 0 };
  };
  const engine = createEngine({ repo, chat, settings: () => DEFAULT_APP_SETTINGS, gitInit: false });
  const board = repo.createBoard({ title: 'B' });
  assert.deepEqual(await engine.autoStep(board.id), { did: 'idle', reason: 'empty' });
  repo.insertIdea({ boardId: board.id, title: 'Frö', pitch: '', kind: 'seed', x: 0, y: 0, generation: 0 });

  const did: string[] = [];
  for (let i = 0; i < 10; i++) did.push((await engine.autoStep(board.id)).did);
  assert.equal(did[0], 'judge', 'an unjudged seed is judged first');
  assert.equal(did[1], 'expand', 'a pool under three grows by expanding');
  assert.ok(did.includes('combine'), `breeds once the pool is big enough: ${did.join(',')}`);
  const ideas = repo.listIdeas(board.id);
  assert.ok(ideas.every((i) => i.judgedAt), 'every step leaves its ideas judged');
  assert.ok(ideas.some((i) => i.kind === 'combine' && i.generation >= 2));
});

test('autoStep on a stuck board: a fresh seed (a scout lead first), expanded next; it stops after two that do not help', async () => {
  const repo = openDb(':memory:');
  const asked: string[] = [];
  let n = 0;
  const chat = async (r: ChatRequest) => {
    asked.push(r.schemaName);
    n++;
    const value =
      r.schemaName === 'expand' ? { candidates: [], ideas: [1, 2, 3].map((k) => ({ title: `Gren ${n}.${k}`, pitch: `unik${n}x${k} text` })) }
      : r.schemaName === 'judgement' ? { reason: 'r', originality: 2, feasibility: 2, impact: 2, keywords: ['k'] }
      : { title: `Nytt frö ${n}`, pitch: `helt annan riktning nummer ${n}` };
    return { value, costUsd: 0 };
  };
  const engine = createEngine({ repo, chat, settings: () => DEFAULT_APP_SETTINGS, gitInit: false });
  const board = repo.createBoard({ title: 'B', goal: 'Mål' });
  const add = (title: string, kind: string, s: number) => {
    const i = repo.insertIdea({ boardId: board.id, title, pitch: '', kind: kind as any, x: 0, y: 0, generation: kind === 'seed' ? 0 : 1 });
    repo.saveJudgement(i.id, { originality: s, feasibility: s, impact: s, reason: 'r' });
    return i;
  };
  add('Bästa fröet', 'seed', 4);
  for (let k = 0; k < 8; k++) add(`Platt ${k}`, 'combine', 2);
  repo.replaceLeads(board.id, 'research', [{ title: 'Spår från forskningen', summary: 'Ett fynd', hook: 'h', url: 'https://example.org/p', meta: {} }]);

  const first = await engine.autoStep(board.id);
  assert.equal(first.did, 'seed');
  assert.ok(!asked.includes('seed'), 'an unused lead is planted without a model call');
  const planted = repo.getIdea(first.ids![0])!;
  assert.equal(planted.title, 'Spår från forskningen');
  assert.equal(planted.kind, 'seed');
  assert.ok(planted.judgedAt, 'and judged in the same step');
  assert.equal(repo.listLeads(board.id)[0].ideaId, planted.id);

  const second = await engine.autoStep(board.id);
  assert.equal(second.did, 'expand', 'the fresh seed is expanded before breeding');
  assert.deepEqual(repo.parentsOf(second.ids![0]).map((p) => p.id), [planted.id]);

  // Eight more without progress: no lead left, so the model writes the second fresh seed.
  for (let k = 0; k < 5; k++) add(`Platt igen ${k}`, 'combine', 2);
  asked.length = 0;
  const third = await engine.autoStep(board.id);
  assert.equal(third.did, 'seed');
  assert.ok(asked.includes('seed'));
  for (let k = 0; k < 8; k++) add(`Fortfarande platt ${k}`, 'combine', 2);
  assert.deepEqual(await engine.autoStep(board.id), { did: 'idle', reason: 'exhausted' });
});

test('the summary\'s gaps reach the generators', async () => {
  const repo = openDb(':memory:');
  const prompts: string[] = [];
  const chat = async (r: ChatRequest) => {
    prompts.push(r.user);
    return { value: { candidates: [], ideas: [{ title: 'Sintetizador no navegador', pitch: 'p' }] }, costUsd: 0 };
  };
  const engine = createEngine({ repo, chat, settings: () => DEFAULT_APP_SETTINGS, gitInit: false });
  const board = repo.createBoard({ title: 'B' });
  const seed = repo.insertIdea({ boardId: board.id, title: 'Solda térmica', pitch: '', kind: 'seed', x: 0, y: 0, generation: 0 });
  repo.setSummary(board.id, {
    headline: 'h', themes: [], strongest: [], nextSteps: [], ideaCount: 1, lang: 'pt', createdAt: '2026-11-12',
    gaps: ['Aplicações 100% digitais que as IAs constroem sozinhas'],
  });
  await engine.expand(seed.id);
  assert.match(prompts[0], /gaps toward the goal:\n- Aplicações 100% digitais/);
});

test('judging in batches: one call for up to three ideas, a skipped verdict judged alone, a failed call fails them together', async () => {
  const repo = openDb(':memory:');
  const calls: ChatRequest[] = [];
  let mode: 'all' | 'skip' | 'fail' = 'all';
  const chat = async (r: ChatRequest) => {
    calls.push(r);
    if (r.schemaName === 'judgements') {
      if (mode === 'fail') throw new ProviderError('rate_limited', 'usage limit');
      const n = (r.user.match(/^Idea \d+:/gm) ?? []).length;
      const verdicts = Array.from({ length: n }, (_, k) => ({ n: k + 1, reason: `r${k + 1}`, fit: 4, originality: 3, feasibility: 3, impact: 2 + k, keywords: ['k'] }));
      return { value: { verdicts: mode === 'skip' ? verdicts.slice(1) : verdicts }, costUsd: 0 };
    }
    if (r.schemaName === 'judgement') return { value: { reason: 'alone', fit: 4, originality: 2, feasibility: 2, impact: 2, keywords: ['k'] }, costUsd: 0 };
    return { value: { candidates: [], ideas: [1, 2, 3].map((k) => ({ title: `Gren ${calls.length}.${k}`, pitch: `unik text ${calls.length} ${k}` })) }, costUsd: 0 };
  };
  const engine = createEngine({ repo, chat, settings: () => DEFAULT_APP_SETTINGS, gitInit: false });
  const board = repo.createBoard({ title: 'B', goal: 'Mål' });
  const seed = (t: string) => repo.insertIdea({ boardId: board.id, title: t, pitch: '', kind: 'seed', x: 0, y: 0, generation: 0 });
  const ids = ['A', 'B', 'C', 'D'].map((t) => seed(t).id);

  // The autopilot judges the first three unjudged ideas in one call.
  assert.equal((await engine.autoStep(board.id)).did, 'judge');
  const batch = calls.filter((c) => c.schemaName === 'judgements');
  assert.equal(batch.length, 1);
  assert.match(batch[0].user, /Idea 3:\nC/);
  assert.match(batch[0].user, /exactly as if it were the only one/);
  assert.deepEqual(ids.slice(0, 3).map((id) => repo.getIdea(id)!.impact), [2, 3, 4], 'each verdict lands on its own idea');
  assert.equal(repo.getIdea(ids[0])!.reason, 'r1');
  assert.equal(repo.getIdea(ids[3])!.judgedAt, null);

  // A verdict the model left out is judged on its own.
  mode = 'skip';
  calls.length = 0;
  const more = ['E', 'F'].map((t) => seed(t).id);
  engine.queueJudge([ids[3], ...more]);
  await engine.idle();
  assert.equal(calls.filter((c) => c.schemaName === 'judgements').length, 1, 'the queue batches too');
  assert.equal(calls.filter((c) => c.schemaName === 'judgement').length, 1);
  assert.equal(repo.getIdea(ids[3])!.reason, 'alone');
  assert.equal(repo.getIdea(more[1])!.reason, 'r3');

  // A failed call fails the batch once: the autopilot backs off instead of retrying each idea.
  mode = 'fail';
  calls.length = 0;
  ['G', 'H'].forEach(seed);
  await assert.rejects(engine.autoStep(board.id), (e: any) => e.code === 'rate_limited');
  assert.equal(calls.length, 1);
});
