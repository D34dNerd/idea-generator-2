// Ideas as notes in an Obsidian vault: one Markdown file per idea, in a folder
// per board, with the jury's scores and keywords as properties and the
// parents as [[links]], so the vault's graph mirrors the idea family tree.
// Saving again updates the same note: a note is matched by the idea_id in its
// properties, and a note that belongs to another idea is never overwritten.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { Lang } from './llm.ts';
import { expandHome } from './project.ts';
import { medal, scoreSum } from '../public/js/score.js';

type IdeaLike = {
  id: number; title: string; pitch: string; kind: string; generation: number; sourceUrl?: string | null;
  originality: number | null; feasibility: number | null; impact: number | null; reason: string | null;
  medalOverride: number | null; keywords?: string[]; originBoardTitle?: string | null; createdAt?: string;
};

const L = {
  sv: {
    verdict: 'Juryns bedömning', o: 'Originalitet', f: 'Genomförbarhet', i: 'Effekt', unjudged: 'Inte bedömd ännu', handset: 'medalj satt för hand',
    origin: 'Var idén kom ifrån', goal: 'Tavlans mål', source: 'Källa', guest: 'Gäst från tavlan',
    kinds: { seed: 'Frö', expand: 'Förgrening', combine: 'Korsning', guest: 'Gäst' } as Record<string, string>,
  },
  en: {
    verdict: 'Jury verdict', o: 'Originality', f: 'Feasibility', i: 'Impact', unjudged: 'Not judged yet', handset: 'medal set by hand',
    origin: 'Where the idea came from', goal: 'Board goal', source: 'Source', guest: 'Guest from board',
    kinds: { seed: 'Seed', expand: 'Branch', combine: 'Cross', guest: 'Guest' } as Record<string, string>,
  },
  pt: {
    verdict: 'Veredito do júri', o: 'Originalidade', f: 'Viabilidade', i: 'Impacto', unjudged: 'Ainda não avaliada', handset: 'medalha definida à mão',
    origin: 'De onde a ideia veio', goal: 'Objetivo do quadro', source: 'Fonte', guest: 'Convidada do quadro',
    kinds: { seed: 'Semente', expand: 'Ramificação', combine: 'Cruzamento', guest: 'Convidada' } as Record<string, string>,
  },
};
const MEDAL_NAME = ['', 'bronze', 'silver', 'gold'];
const MEDAL_ICON = ['', ' 🥉', ' 🥈', ' 🥇'];

/** A file or folder name that Obsidian, Windows and macOS all accept, and that works inside [[links]]. */
export function noteName(title: string) {
  const s = title
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 100)
    .replace(/[ .]+$/, '');
  return s || 'idea';
}

/** Keywords as Obsidian tags: no spaces, no punctuation Obsidian would cut at. */
export function toTag(k: string) {
  return k.trim().toLowerCase().replace(/[^\p{L}\p{N}_/-]+/gu, '-').replace(/^-+|-+$/g, '');
}

const q = (s: string) => JSON.stringify(s); // a JSON string is a valid double-quoted YAML string

export function renderNote(a: { idea: IdeaLike; board: { title: string; goal: string }; parents: IdeaLike[]; lang: Lang; date: string }) {
  const t = L[a.lang];
  const i = a.idea;
  const sum = scoreSum(i);
  const m = medal(i);
  const tags = [...new Set(['ideia', ...(i.keywords ?? []).map(toTag).filter(Boolean)])];
  const props = [
    '---',
    `idea_id: ${i.id}`,
    `board: ${q(a.board.title)}`,
    `kind: ${i.kind}`,
    `generation: ${i.generation}`,
    ...(sum != null
      ? [`originality: ${i.originality}`, `feasibility: ${i.feasibility}`, `impact: ${i.impact}`, `score: ${sum}`]
      : []),
    ...(m ? [`medal: ${MEDAL_NAME[m]}`] : []),
    ...(i.sourceUrl ? [`source: ${q(i.sourceUrl)}`] : []),
    `tags: [${tags.map(q).join(', ')}]`,
    `updated: ${a.date}`,
    '---',
  ];
  const body = [`# ${i.title}${MEDAL_ICON[m ?? 0]}`, ''];
  if (i.pitch) body.push(i.pitch, '');
  body.push(`## ${t.verdict}`, '');
  if (sum != null) {
    body.push(`${t.o} ${i.originality} · ${t.f} ${i.feasibility} · ${t.i} ${i.impact} = ${sum}/15${i.medalOverride != null ? ` (${t.handset})` : ''}`, '');
    if (i.reason) body.push(`> ${i.reason}`, '');
  } else body.push(t.unjudged, '');
  body.push(`## ${t.origin}`, '');
  const kind = t.kinds[i.kind] ?? i.kind;
  if (a.parents.length) body.push(`${kind}:`, ...a.parents.map((p) => `- [[${noteName(p.title)}]]`), '');
  else if (i.kind === 'guest' && i.originBoardTitle) body.push(`${t.guest} ${i.originBoardTitle}`, '');
  else body.push(kind, '');
  if (i.sourceUrl) body.push(`${t.source}: ${i.sourceUrl}`, '');
  if (a.board.goal.trim()) body.push(`## ${t.goal}`, '', a.board.goal.trim(), '');
  return [...props, '', ...body].join('\n');
}

/** Is this the note we wrote for this idea? Only then may it be overwritten. */
function isNoteFor(text: string, id: number) {
  const front = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
  return !!front && new RegExp(`^idea_id: ${id}\\s*$`, 'm').test(front[1]);
}

/** Write (or update) the idea's note; returns its path. */
export async function writeNote(a: {
  root: string; idea: IdeaLike; board: { title: string; goal: string }; parents: IdeaLike[]; lang: Lang;
}) {
  const expanded = expandHome(a.root);
  if (!isAbsolute(expanded)) throw new Error(`The vault folder must be an absolute path or start with ~ (got "${a.root}")`);
  const dir = join(resolve(expanded), noteName(a.board.title));
  await mkdir(dir, { recursive: true });
  const text = renderNote({ ...a, date: new Date().toISOString().slice(0, 10) });
  const base = noteName(a.idea.title);
  for (let n = 1; n < 100; n++) {
    const path = join(dir, `${n === 1 ? base : `${base} (${n})`}.md`);
    let existing: string | null = null;
    try {
      existing = await readFile(path, 'utf8');
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e;
    }
    if (existing === null || isNoteFor(existing, a.idea.id)) {
      // 'wx' refuses to clobber a file that appeared since we looked.
      await writeFile(path, text, existing === null ? { flag: 'wx' } : {});
      return path;
    }
  }
  throw new Error(`No free note name for ${base}`);
}
