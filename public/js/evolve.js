// Evolution autopilot: decides the next move. Pure, no DOM, no network.
//
// Not random merging: parents are picked by tournament selection on the
// judge's score, among the fitter part of the board, and close kin are not
// crossed. Half the time it "mutates" instead, expanding a strong idea that
// has not been expanded yet, which brings new material into the pool.

import { fitness, medal } from './score.js';

export const pairKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

/** The words that carry an idea: lowercase, no accents, four letters or more. */
export function wordSet(idea) {
  const text = `${idea?.title ?? ''} ${idea?.pitch ?? ''}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Short tokens count only when they carry a digit ("V8", "3D"): those are names, not glue words.
  return new Set((text.match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 4 || (w.length >= 2 && /\d/.test(w))));
}

/** How alike two ideas read, 0–1: shared words over all words (Jaccard). Language-neutral and free. */
export function similarity(a, b) {
  const x = a instanceof Set ? a : wordSet(a);
  const y = b instanceof Set ? b : wordSet(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

/**
 * From this similarity up, a new idea is a rewording of one already on the board.
 * Measured on 142 real ideas: models paraphrase, so the same idea reworded shares
 * about a quarter of its words and only near-copies pass 0.5. This catches the
 * copies; `overused` and the jury's view of similar ideas handle the paraphrases.
 */
export const DUPLICATE_AT = 0.5;

// Glue words of four letters or more in the three languages; they say nothing about a theme.
const GLUE = new Set(
  ('para pelo pela como mais onde quando sobre entre cada este esta esse essa isso seus suas numa pelos pelas tambem muito ainda apenas atraves usando tempo real meio forma ' +
    'with that this from into their they them your have will each when where while which what more than over using real time ' +
    'till fran over under eller inte detta dessa genom varje sina deras kan ska').split(' '),
);

/**
 * Words the board is stuck on: those in at least `share` of its ideas, most common
 * first, leaving out the goal's own words (the goal is supposed to be everywhere).
 * Empty until the board has `min` ideas.
 */
export function overused(ideas, goal = '', { share = 0.3, min = 8, top = 10 } = {}) {
  if (ideas.length < min) return [];
  const inGoal = new Set([...wordSet({ title: goal }), ...GLUE]);
  const count = new Map();
  for (const i of ideas) for (const w of wordSet(i)) if (!inGoal.has(w)) count.set(w, (count.get(w) ?? 0) + 1);
  return [...count]
    .filter(([, n]) => n / ideas.length >= share)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([w]) => w);
}

/**
 * Ideas a board can stop showing: judged, no medal, and not on the way to anything
 * better. Seeds stay, unjudged ideas stay, and so does every ancestor of an idea
 * that stays, so a medal never loses its family line. Nothing is deleted: the
 * jury's rejections are what the generators learn from.
 */
export function hiddenWeak(ideas, edges) {
  const keep = new Set(ideas.filter((i) => i.kind === 'seed' || medal(i) !== 0).map((i) => i.id));
  const parentsOf = new Map();
  for (const e of edges) {
    if (!parentsOf.has(e.to)) parentsOf.set(e.to, []);
    parentsOf.get(e.to).push(e.from);
  }
  const queue = [...keep];
  while (queue.length) {
    for (const p of parentsOf.get(queue.pop()) ?? []) {
      if (!keep.has(p)) { keep.add(p); queue.push(p); }
    }
  }
  return new Set(ideas.filter((i) => !keep.has(i.id)).map((i) => i.id));
}

/** Ideas that can breed: judged or hand-medalled. */
export function population(ideas) {
  return ideas.filter((i) => fitness(i) != null);
}

/** Pairs that must not be bred again: already combined, or parent and child. */
export function usedPairs(ideas, edges) {
  const kindOf = new Map(ideas.map((i) => [i.id, i.kind]));
  const parentsOf = new Map();
  const used = new Set();
  for (const e of edges) {
    used.add(pairKey(e.from, e.to));
    if (!parentsOf.has(e.to)) parentsOf.set(e.to, []);
    parentsOf.get(e.to).push(e.from);
  }
  for (const [child, parents] of parentsOf) {
    if (kindOf.get(child) === 'combine' && parents.length === 2) used.add(pairKey(parents[0], parents[1]));
  }
  return used;
}

/**
 * Close kin: siblings (a shared parent) and grandparent–grandchild. Crossing them
 * mostly rewrites what they already share. Parent–child is in usedPairs.
 */
export function kinPairs(edges) {
  const parentsOf = new Map();
  for (const e of edges) {
    if (!parentsOf.has(e.to)) parentsOf.set(e.to, []);
    parentsOf.get(e.to).push(e.from);
  }
  const kin = new Set();
  const childrenOf = new Map();
  for (const [child, parents] of parentsOf) {
    for (const p of parents) {
      if (!childrenOf.has(p)) childrenOf.set(p, []);
      childrenOf.get(p).push(child);
      for (const g of parentsOf.get(p) ?? []) kin.add(pairKey(g, child));
    }
  }
  for (const kids of childrenOf.values()) {
    for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) kin.add(pairKey(kids[i], kids[j]));
  }
  return kin;
}

/**
 * Who may breed: once the board has more than eight judged ideas, only the
 * fitter 60 % (at least six). Without a cut, every weak idea stays a parent forever.
 */
export function breeders(pool) {
  if (pool.length <= 8) return pool;
  const keep = Math.max(6, Math.ceil(pool.length * 0.6));
  return [...pool].sort((a, b) => fitness(b) - fitness(a) || b.id - a.id).slice(0, keep);
}

/** Ideas that already have expand-children. */
export function expandedIds(ideas, edges) {
  const kindOf = new Map(ideas.map((i) => [i.id, i.kind]));
  const out = new Set();
  for (const e of edges) if (kindOf.get(e.to) === 'expand') out.add(e.from);
  return out;
}

function tournament(pool, k, rng) {
  let best = null;
  for (let i = 0; i < k; i++) {
    const c = pool[Math.floor(rng() * pool.length)];
    if (!best || fitness(c) > fitness(best)) best = c;
  }
  return best;
}

/**
 * @param {Array} ideas  ideas on the board (with id, kind, scores)
 * @param {Array} edges  {from, to}
 * @param {object} opts  rng, busy (Set of ids being worked on), inFlight (Set of pair keys to leave alone),
 *                       noExpand (Set of ids whose expansion only gave repeats), mutationRate, k (tournament size)
 * @returns {{type:'combine', a, b} | {type:'expand', idea} | null}
 */
export function nextMove(ideas, edges, opts = {}) {
  // Half the moves expand: an expansion reads the jury's critique of its parent and
  // repairs it, which is where quality climbs. Crossing alone only reshuffles.
  const { rng = Math.random, busy = new Set(), inFlight = new Set(), noExpand = new Set(), mutationRate = 0.5, k = 3 } = opts;
  const pool = breeders(population(ideas).filter((i) => !busy.has(i.id)));
  const expanded = expandedIds(ideas, edges);
  const used = usedPairs(ideas, edges);
  const kin = kinPairs(edges);

  const bestUnexpanded = () =>
    [...pool].sort((a, b) => fitness(b) - fitness(a)).find((i) => !expanded.has(i.id) && !noExpand.has(i.id));

  if (pool.length < 3 || rng() < mutationRate) {
    const idea = bestUnexpanded();
    if (idea) return { type: 'expand', idea };
  }

  if (pool.length >= 2) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const a = tournament(pool, k, rng);
      const rest = pool.filter((i) => i.id !== a.id);
      const b = tournament(rest, k, rng);
      const key = pairKey(a.id, b.id);
      if (used.has(key) || inFlight.has(key)) continue;
      // Prefer unrelated parents; settle for kin only when nothing else turns up.
      if (attempt < 30 && kin.has(key)) continue;
      return { type: 'combine', a, b };
    }
  }

  const idea = bestUnexpanded();
  return idea ? { type: 'expand', idea } : null;
}

/**
 * Has quality moved? Mean fitness of the first and the latest `window` bred
 * ideas (seeds and guests excluded: a bare topic scores low by design and
 * would flatter the climb, and guests were bred on another board), plus the best so far.
 */
export function evolutionStats(ideas, window = 8) {
  const bred = ideas
    .filter((i) => i.kind !== 'seed' && i.kind !== 'guest' && fitness(i) != null)
    .sort((a, b) => a.id - b.id);
  const mean = (xs) => (xs.length ? xs.reduce((s, i) => s + fitness(i), 0) / xs.length : null);
  const generation = ideas.reduce((g, i) => Math.max(g, i.generation || 0), 0);
  return {
    count: bred.length,
    generation,
    first: mean(bred.slice(0, window)),
    latest: bred.length > window ? mean(bred.slice(-window)) : null,
    best: bred.length ? Math.max(...bred.map(fitness)) : null,
  };
}
