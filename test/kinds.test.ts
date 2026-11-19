// Board kinds: the skeleton (three slots, fit, medals) is shared; the rubric, the
// criteria's names and the generators are the kind's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { makeLLM, JUDGE_SYSTEM } from '../server/llm.ts';
import { PACKS, packOf, toKind } from '../server/kinds.ts';
import { renderNote } from '../server/vault.ts';
import { boardMarkdown } from '../server/app.ts';
import { KINDS, critLabels, kindOf } from '../public/js/kinds.js';

/** A fake model that records every request and answers with the given value. */
function recorder(value: any) {
  const calls: any[] = [];
  const llm = makeLLM(async (r: any) => {
    calls.push(r);
    return { value, costUsd: 0 };
  });
  return { llm, calls };
}

test('every kind the UI offers has a pack with three criteria and its own judge', () => {
  for (const k of KINDS) {
    const p = PACKS[toKind(k)];
    assert.ok(p, `pack for ${k}`);
    assert.equal(p.criteria.length, 3);
    assert.equal(new Set(p.criteria).size, 3);
    assert.match(p.judgeSystem, /GOAL FIT \(scored separately, 1–5\)/);
    for (const c of p.criteria) assert.match(p.judgeSystem, new RegExp(`^${c.toUpperCase()}\\b`, 'm'), `${k}: rubric for ${c}`);
    for (const lang of ['sv', 'en', 'pt']) assert.equal(critLabels(k, lang).length, 3);
  }
  assert.equal(toKind('nope'), 'ideas');
  assert.equal(kindOf({ config: {} }), 'ideas');
  assert.equal(packOf(undefined).judgeSystem, JUDGE_SYSTEM);
});

test('a niche board is judged on gap, access and demand, stored in the usual slots', async () => {
  const { llm, calls } = recorder({ reason: 'r', fit: 4, gap: 2, access: 5, demand: 3, keywords: ['x'] });
  const board = { goal: 'Nichos B2B no Brasil', config: { kind: 'niche' } };
  const { judgement } = await llm.judge({ model: 'm', board, idea: { title: 'T', pitch: 'P' }, lang: 'pt' });
  assert.deepEqual([judgement.originality, judgement.feasibility, judgement.impact, judgement.fit], [2, 5, 3, 4]);
  assert.equal(calls[0].system, PACKS.niche.judgeSystem);
  assert.deepEqual(calls[0].schema.required, ['reason', 'fit', 'gap', 'access', 'demand', 'keywords']);
  assert.ok(!('originality' in calls[0].schema.properties));
});

test('batched niche verdicts map by the kind\'s keys; one missing a criterion is left for a single call', async () => {
  const { llm } = recorder({
    verdicts: [
      { n: 1, reason: 'a', fit: 3, gap: 1, access: 2, demand: 1, keywords: [] },
      { n: 2, reason: 'b', fit: 3, gap: 4, access: 4, keywords: [] },
    ],
  });
  const board = { goal: 'g', config: { kind: 'niche' } };
  const { judgements } = await llm.judgeMany({ model: 'm', board, lang: 'pt', items: [{ idea: { title: 'a', pitch: '' } }, { idea: { title: 'b', pitch: '' } }] });
  assert.deepEqual([judgements[0]!.originality, judgements[0]!.feasibility, judgements[0]!.impact], [1, 2, 1]);
  assert.equal(judgements[1], null);
});

test('niche generators get the niche rubric, the niche pitch and verdicts in niche terms', async () => {
  const { llm, calls } = recorder({ candidates: [], ideas: [{ title: 'A', pitch: 'B' }] });
  const board = { goal: 'g', config: { kind: 'niche' } };
  const flow = PACKS.niche.flow!;
  await llm.expand({
    model: 'm', flow, board, idea: { title: 'I', pitch: 'p' }, existingTitles: [], lang: 'pt',
    verdict: { originality: 2, feasibility: 3, impact: 4, fit: 5, reason: 'why' }, jury: {},
  });
  const r = calls[0];
  assert.equal(r.system, flow.system);
  assert.match(r.user, /gap 2\/5, access 3\/5, demand 4\/5 \(9\/15\)/);
  assert.match(r.user, /How niches are judged here/);
  assert.equal(r.schema.properties.ideas.items.properties.pitch.description, PACKS.niche.pitch);
});

test('a board keeps the kind it was made as; old boards are idea boards', () => {
  const repo = openDb(':memory:');
  const niche = repo.createBoard({ title: 'N', kind: 'niche', config: { autoProjectOnGold: undefined } });
  assert.equal(niche.config.kind, 'niche');
  assert.equal(niche.config.flow.system, PACKS.niche.flow!.system);
  assert.equal(niche.config.autoProjectOnGold, false);
  const patched = repo.updateBoard(niche.id, { config: { kind: 'ideas', judgeGuidance: 'duro' } })!;
  assert.equal(patched.config.kind, 'niche');
  assert.equal(patched.config.judgeGuidance, 'duro');

  const plain = repo.createBoard({ title: 'I' });
  assert.equal(plain.config.kind, 'ideas');
  assert.equal(plain.config.autoProjectOnGold, true);
  assert.notEqual(plain.config.flow.system, PACKS.niche.flow!.system);
  // A spin-off with the board's config copied in still takes the kind it is given.
  const spun = repo.createBoard({ title: 'S', kind: 'niche', config: { ...plain.config } });
  assert.equal(spun.config.kind, 'niche');
});

test('notes and exports name the criteria the way the board kind does', () => {
  const idea = {
    id: 1, boardId: 1, title: 'Oficinas de moto', pitch: 'p', kind: 'seed', generation: 0, sourceUrl: null, x: 0, y: 0,
    originality: 4, feasibility: 4, impact: 3, fit: 5, reason: 'r', judgedAt: 'x', medalOverride: null, projectPath: null,
    originIdeaId: null, originBoardId: null, originBoardTitle: null, keywords: [], createdAt: 'x',
  };
  const board = { title: 'B', goal: '', config: { kind: 'niche' } };
  const md = renderNote({ idea, board, parents: [], lang: 'pt', date: '2026-11-19' });
  assert.match(md, /\nboard_kind: niche\n/);
  assert.match(md, /\ngap: 4\naccess: 4\ndemand: 3\nscore: 11\n/);
  assert.match(md, /Brecha 4 · Acesso 4 · Demanda 3 = 11\/15/);

  const repo = openDb(':memory:');
  const b = repo.createBoard({ title: 'B', kind: 'niche' });
  const out = boardMarkdown(b, [idea as any], [], 'pt');
  assert.match(out, /\*Brecha 4 · Acesso 4 · Demanda 3\.\*/);
});

test('the brief reaches generators and the jury when set, and nothing changes when it is empty', async () => {
  const { llm, calls } = recorder({ title: 'T', pitch: 'P', reason: 'r', fit: 3, hook: 3, value: 3, doability: 3, keywords: [] });
  const brief = 'Consultor de software sozinho em Florianópolis; ajuda oficinas pequenas.';
  const post = { goal: 'g', config: { kind: 'post', brief } };
  await llm.distill({ model: 'm', flow: PACKS.post.flow!, board: post, text: 'texto', lang: 'pt' });
  await llm.judge({ model: 'm', board: post, idea: { title: 'I', pitch: 'p' }, lang: 'pt' });
  assert.match(calls[0].user, /Who this board works for[^\n]*\nConsultor de software sozinho/);
  assert.match(calls[1].user, /Who this board works for[^\n]*\nConsultor de software sozinho/);
  assert.equal(calls[1].system, PACKS.post.judgeSystem);

  await llm.judge({ model: 'm', board: { goal: 'g', config: { kind: 'post', brief: '  ' } }, idea: { title: 'I', pitch: 'p' }, lang: 'pt' });
  assert.doesNotMatch(calls[2].user, /Who this board works for/);
});

test('a niche spun off into posts: the niche is the goal, the brief carries over, the seed is rewritten as a post', async () => {
  const { createEngine } = await import('../server/engine.ts');
  const { DEFAULT_APP_SETTINGS } = await import('../server/providers.ts');
  const requests: any[] = [];
  const chat = async (r: any) => {
    requests.push(r);
    const value = r.schemaName === 'seed'
      ? { title: 'Carrossel: a peça que você não tem', pitch: 'Carrossel com o gancho "Quantas vendas você perdeu hoje?".' }
      : { reason: 'r', fit: 4, hook: 3, value: 3, doability: 4, gap: 3, access: 3, demand: 3, keywords: [] };
    return { value, costUsd: 0 };
  };
  const repo = openDb(':memory:');
  const engine = createEngine({ repo, chat: chat as any, settings: () => structuredClone(DEFAULT_APP_SETTINGS), gitInit: false });
  const nicheBoard = repo.createBoard({ title: 'Nichos', kind: 'niche', config: { lang: 'pt', brief: 'Consultor sozinho.' } });
  const niche = repo.insertIdea({ boardId: nicheBoard.id, title: 'Oficinas de moto', pitch: 'Perdem vendas por estoque.', kind: 'seed', sourceUrl: null, x: 0, y: 0, generation: 0 });

  const { board, idea } = await engine.spinoff(niche.id, { kind: 'post' });
  assert.equal(board!.config.kind, 'post');
  assert.equal(board!.config.brief, 'Consultor sozinho.');
  assert.equal(board!.config.flow.system, PACKS.post.flow!.system);
  assert.equal(board!.config.autoProjectOnGold, false);
  assert.equal(board!.goal, 'Posts para redes sociais a partir disto: Oficinas de moto: Perdem vendas por estoque.');
  assert.equal(idea.title, 'Carrossel: a peça que você não tem');
  assert.equal(idea.originIdeaId, niche.id);
  const distill = requests.find((r) => r.schemaName === 'seed');
  assert.equal(distill.system, PACKS.post.flow!.system);
  assert.equal(distill.schema.properties.pitch.description, PACKS.post.pitch);

  // The same kind keeps the old behaviour: the idea itself is the seed, no model call.
  const before = requests.length;
  const same = await engine.spinoff(niche.id, {});
  assert.equal(same.board!.config.kind, 'niche');
  assert.equal(same.idea.title, 'Oficinas de moto');
  assert.ok(requests.slice(before).every((r) => r.schemaName !== 'seed'));
  await engine.idle();
});
