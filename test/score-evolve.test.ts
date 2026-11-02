import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampScore, fitness, medal, medalFromSum, scoreSum } from '../public/js/score.js';
import { evolutionStats, expandedIds, nextMove, pairKey, usedPairs } from '../public/js/evolve.js';

const idea = (id: number, sum: number | null, extra: any = {}) => {
  const base: any = { id, kind: 'expand', generation: 1, medalOverride: null, ...extra };
  if (sum != null) {
    // spread the sum over three 1–5 scores
    const o = Math.min(5, sum - 2), f = Math.min(5, sum - o - 1), i = sum - o - f;
    Object.assign(base, { originality: o, feasibility: f, impact: i });
  }
  return base;
};

// Deterministic PRNG (mulberry32) so statistical tests are stable.
const rngFrom = (seed: number) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

test('medal thresholds on the 3–15 sum', () => {
  assert.equal(medalFromSum(null), null);
  assert.deepEqual([3, 8, 9, 10, 11, 12, 13, 15].map(medalFromSum), [0, 0, 1, 1, 2, 2, 3, 3]);
});

test('scores are clamped to whole numbers 1–5', () => {
  assert.deepEqual([0, 1, 2.6, 5, 9, 'x', null].map(clampScore), [1, 1, 3, 5, 5, 1, 1]);
});

test('the helper builds the sum it was asked for', () => {
  for (let s = 3; s <= 15; s++) assert.equal(scoreSum(idea(1, s)), s);
});

test('a hand-set medal beats the judge, for display and for breeding', () => {
  const i = idea(1, 6, { medalOverride: 3 });
  assert.equal(medal(i), 3);
  assert.equal(fitness(i), 14);
  assert.equal(medal(idea(2, null)), null);
  assert.equal(fitness(idea(2, null)), null);
});

test('pairs already combined, and parent–child pairs, are not bred again', () => {
  const ideas = [idea(1, 9), idea(2, 9), idea(3, 12, { kind: 'combine' })];
  const edges = [{ from: 1, to: 3 }, { from: 2, to: 3 }];
  const used = usedPairs(ideas, edges);
  assert.ok(used.has(pairKey(1, 2)), 'parents of a combination');
  assert.ok(used.has(pairKey(1, 3)), 'parent and child');
  for (let s = 0; s < 200; s++) {
    const m = nextMove(ideas, edges, { rng: rngFrom(s), mutationRate: 0 });
    if (m?.type === 'combine') {
      assert.ok(!used.has(pairKey(m.a.id, m.b.id)), `bred a used pair ${m.a.id}-${m.b.id}`);
    }
  }
});

test('never combines an idea with itself and skips busy ideas and in-flight pairs', () => {
  const ideas = [idea(1, 10), idea(2, 11), idea(3, 12), idea(4, 13)];
  for (let s = 0; s < 300; s++) {
    const m = nextMove(ideas, [], {
      rng: rngFrom(s), mutationRate: 0, busy: new Set([4]), inFlight: new Set([pairKey(2, 3)]),
    });
    assert.equal(m?.type, 'combine');
    assert.notEqual(m.a.id, m.b.id);
    assert.ok(m.a.id !== 4 && m.b.id !== 4, 'used a busy idea');
    assert.notEqual(pairKey(m.a.id, m.b.id), pairKey(2, 3));
  }
});

test('selection favours fitter parents', () => {
  const ideas = Array.from({ length: 10 }, (_, n) => idea(n + 1, 4 + n)); // sums 4..13
  const count = new Map<number, number>();
  const rng = rngFrom(42);
  for (let n = 0; n < 4000; n++) {
    const m = nextMove(ideas, [], { rng, mutationRate: 0 });
    for (const p of [m.a, m.b]) count.set(p.id, (count.get(p.id) ?? 0) + 1);
  }
  const best = count.get(10) ?? 0;
  const worst = count.get(1) ?? 0;
  assert.ok(best > worst * 5, `best ${best} vs worst ${worst}`);
});

test('a small population is grown by expanding its best unexpanded idea', () => {
  const ideas = [idea(1, 5, { kind: 'seed' }), idea(2, 9, { kind: 'seed' })];
  const m = nextMove(ideas, [], { rng: rngFrom(1) });
  assert.equal(m?.type, 'expand');
  assert.equal(m.idea.id, 2);
  const ideas2 = [...ideas, idea(3, 7), idea(4, 7), idea(5, 7)];
  const edges = [3, 4, 5].map((to) => ({ from: 2, to }));
  assert.deepEqual([...expandedIds(ideas2, edges)], [2]);
});

test('nothing to do on an empty board', () => {
  assert.equal(nextMove([], []), null);
  assert.equal(nextMove([idea(1, null)], []), null);
});

test('evolution stats leave seeds out and compare first and latest windows', () => {
  const ideas = [
    idea(1, 3, { kind: 'seed', generation: 0 }),
    ...Array.from({ length: 8 }, (_, n) => idea(n + 2, 8)),
    ...Array.from({ length: 8 }, (_, n) => idea(n + 10, 12, { generation: 5 })),
  ];
  const s = evolutionStats(ideas);
  assert.equal(s.count, 16);
  assert.equal(s.first, 8);
  assert.equal(s.latest, 12);
  assert.equal(s.best, 12);
  assert.equal(s.generation, 5);
  assert.equal(evolutionStats(ideas.slice(0, 5)).latest, null, 'no "latest" until there is more than one window');
});
