import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noteName, renderNote, toTag, writeNote } from '../server/vault.ts';
import { mergeAppSettings } from '../server/providers.ts';

const idea = {
  id: 7, title: 'Bancos que lembram sons', pitch: 'Um banco grava e toca sons da praça.', kind: 'combine', generation: 2,
  originality: 5, feasibility: 3, impact: 4, reason: 'Mecanismo claro.', medalOverride: null, keywords: ['espaço público', 'Som'],
};
const board = { title: 'Praça / Noite', goal: 'Noites mais sociais' };
const parents = [{ ...idea, id: 3, title: 'Banco: memória?' }, { ...idea, id: 4, title: 'Sons da praça' }];

test('note names are safe for Obsidian, Windows and links', () => {
  assert.equal(noteName('Banco: memória? [v2] #1'), 'Banco memória v2 1');
  assert.equal(noteName('a/b\\c'), 'a b c');
  assert.equal(noteName('...'), 'idea');
  assert.equal(noteName('Fim. '), 'Fim');
  assert.equal(toTag('Espaço Público!'), 'espaço-público');
});

test('a note carries scores as properties and parents as links', () => {
  const md = renderNote({ idea, board, parents, lang: 'pt', date: '2026-11-10' });
  assert.match(md, /^---\nidea_id: 7\nboard: "Praça \/ Noite"\n/);
  assert.match(md, /\nscore: 12\nmedal: silver\n/);
  assert.match(md, /\ntags: \["ideia", "espaço-público", "som"\]\n/);
  assert.match(md, /# Bancos que lembram sons 🥈/);
  assert.match(md, /Originalidade 5 · Viabilidade 3 · Impacto 4 = 12\/15/);
  assert.match(md, /Cruzamento:\n- \[\[Banco memória\]\]\n- \[\[Sons da praça\]\]/);
  assert.match(md, /## Objetivo do quadro\n\nNoites mais sociais/);
});

test('saving again updates the same note; a stranger\'s note is never overwritten', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ideagen-vault-'));
  const dir = join(root, 'Praça Noite');
  const p1 = await writeNote({ root, idea, board, parents, lang: 'pt' });
  assert.equal(p1, join(dir, 'Bancos que lembram sons.md'));
  const p2 = await writeNote({ root, idea: { ...idea, pitch: 'Nova pitch.' }, board, parents, lang: 'pt' });
  assert.equal(p2, p1, 'same idea, same note');
  assert.match(readFileSync(p1, 'utf8'), /Nova pitch\./);

  writeFileSync(join(dir, 'Outra.md'), '# Minha nota à mão\n');
  const p3 = await writeNote({ root, idea: { ...idea, id: 8, title: 'Outra' }, board, parents: [], lang: 'pt' });
  assert.equal(p3, join(dir, 'Outra (2).md'));
  assert.equal(readFileSync(join(dir, 'Outra.md'), 'utf8'), '# Minha nota à mão\n', 'hand-written note untouched');
  assert.equal(readdirSync(dir).length, 3);
  await assert.rejects(writeNote({ root: 'relative/vault', idea, board, parents, lang: 'pt' }), /absolute/);
});

test('settings: vault folder and medal threshold are validated', () => {
  assert.equal(mergeAppSettings({ vaultRoot: '~/Obsidian/Vault' }).vaultRoot, '~/Obsidian/Vault');
  assert.equal(mergeAppSettings({ vaultRoot: '~\\Obsidian' }).vaultRoot, '~\\Obsidian');
  assert.equal(mergeAppSettings({ vaultRoot: 'relative' }).vaultRoot, '');
  assert.equal(mergeAppSettings({ vaultMinMedal: 3 }).vaultMinMedal, 3);
  assert.equal(mergeAppSettings({ vaultMinMedal: 9 }).vaultMinMedal, 2);
});
