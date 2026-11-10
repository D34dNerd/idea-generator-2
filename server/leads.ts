// The lead panel: fresh material to seed a board with, aimed at the board's goal.
//
// X trends: Grok with OpenRouter's native web search, which can see X. The
// model writes the leads, but a lead is only kept if its URL is among the
// citations the SEARCH ENGINE returned, so we never show a post the model made up.
// (Measured 2026-11-02: 5 of 6 leads were cited, ~48 s and ~$0.04 per refresh.)
//
// AI research: Hugging Face's free paper APIs (today's trending papers plus a
// semantic search on the goal, last 12 months). An LLM picks the six most
// useful for the goal and writes a hook for each.

import type { ChatFn, Lang } from './llm.ts';

export type LeadDraft = { title: string; summary: string; hook: string; url: string; meta: Record<string, unknown> };
type Paper = { id: string; title: string; summary: string; published: string; upvotes: number };

const LANG_NAME: Record<Lang, string> = { sv: 'idiomatic Swedish', en: 'English', pt: 'natural Brazilian Portuguese' };
const DEFAULT_TOPIC = 'new technology, AI tools, and new ways people actually use them';

const leadProps = {
  title: { type: 'string', description: 'Short title, 2–8 words.' },
  summary: { type: 'string', description: 'What is happening, 1–2 sentences, at most 40 words.' },
  hook: { type: 'string', description: 'One sentence: a new idea this could inspire for the goal.' },
};
const X_SCHEMA = {
  type: 'object',
  properties: {
    leads: {
      type: 'array',
      items: {
        type: 'object',
        properties: { ...leadProps, url: { type: 'string', description: 'The x.com URL of one real post you found.' } },
        required: ['title', 'summary', 'hook', 'url'],
        additionalProperties: false,
      },
    },
  },
  required: ['leads'],
  additionalProperties: false,
};
const RESEARCH_SCHEMA = {
  type: 'object',
  properties: {
    leads: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The paper id exactly as given in brackets.' }, ...leadProps },
        required: ['id', 'title', 'summary', 'hook'],
        additionalProperties: false,
      },
    },
  },
  required: ['leads'],
  additionalProperties: false,
};

const clean = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

/** Compare URLs loosely: host without www, twitter.com = x.com, no query or trailing slash. */
export function normalizeUrl(u: string): string | null {
  try {
    const x = new URL(u);
    const host = x.hostname.toLowerCase().replace(/^www\./, '').replace(/^(mobile\.)?twitter\.com$/, 'x.com');
    return `${host}${x.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

export async function xLeads(a: { chat: ChatFn; model: string; goal: string; lang: Lang }) {
  const topic = a.goal.trim() || DEFAULT_TOPIC;
  const user = [
    `Search X for posts from the last 7 days that show emerging trends, new tools, behaviours or debates relevant to this goal:\n"${topic}"`,
    'Find 6 distinct trends. Each must come from a real post you found in the search results; give that post\'s x.com URL.',
    `Write title, summary and hook in ${LANG_NAME[a.lang]}.`,
  ].join('\n\n');
  const r = await a.chat({
    model: a.model,
    system: 'You are a trend scout. You only report what you actually found in the search results, never from memory.',
    user,
    schemaName: 'leads',
    schema: X_SCHEMA,
    temperature: 0.3,
    maxTokens: 3000,
    plugins: [{ id: 'web', engine: 'native', max_results: 12 }],
  });
  const cited = new Set((r.citations ?? []).map(normalizeUrl).filter(Boolean));
  const all: LeadDraft[] = (Array.isArray(r.value?.leads) ? r.value.leads : []).map((l: any) => ({
    title: clean(l.title, 120),
    summary: clean(l.summary, 400),
    hook: clean(l.hook, 300),
    url: clean(l.url, 500),
    meta: {},
  }));
  const leads = all.filter(
    (l) => l.title && /^https?:\/\/(www\.|mobile\.)?(x|twitter)\.com\//i.test(l.url) && cited.has(normalizeUrl(l.url)),
  );
  return { leads, dropped: all.length - leads.length, costUsd: r.costUsd };
}

function toPaper(raw: any): Paper | null {
  const p = raw?.paper ?? raw;
  if (!p?.id || !p?.title) return null;
  return {
    id: String(p.id),
    title: String(p.title).replace(/\s+/g, ' ').trim(),
    summary: String(p.ai_summary || p.summary || raw.summary || '').replace(/\s+/g, ' ').trim(),
    published: String(p.publishedAt || raw.publishedAt || ''),
    upvotes: Number(p.upvotes) || 0,
  };
}

export async function fetchPapers(goal: string, fetchFn: typeof fetch = fetch): Promise<Paper[]> {
  const get = async (url: string) => {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Hugging Face ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  };
  const [daily, searched] = await Promise.all([
    get('https://huggingface.co/api/daily_papers?limit=60').catch(() => []),
    goal.trim()
      ? get(`https://huggingface.co/api/papers/search?q=${encodeURIComponent(goal.trim().slice(0, 200))}&limit=30`).catch(() => [])
      : Promise.resolve([]),
  ]);
  const yearAgo = Date.now() - 365 * 86_400_000;
  const recent = (p: Paper) => !p.published || Date.parse(p.published) >= yearAgo;
  const seen = new Set<string>();
  const out: Paper[] = [];
  // Goal matches first: they are what the scout should look at most closely.
  for (const p of [...searched.map(toPaper).filter((p) => p && recent(p)), ...daily.map(toPaper)] as (Paper | null)[]) {
    if (p && !seen.has(p.id)) {
      seen.add(p.id);
      out.push(p);
    }
  }
  return out;
}

export async function researchLeads(a: { chat: ChatFn; model: string; goal: string; lang: Lang; papers: Paper[] }) {
  if (!a.papers.length) throw new Error('Hugging Face returned no papers');
  const byId = new Map(a.papers.map((p) => [p.id, p]));
  const list = a.papers
    .slice(0, 80)
    .map((p) => `[${p.id}] ${p.title} (${p.published.slice(0, 10)}, ${p.upvotes} upvotes): ${p.summary.slice(0, 280)}`)
    .join('\n');
  const aim = a.goal.trim()
    ? `the board's goal: "${a.goal.trim()}"`
    : 'new products, services or experiences (the board has no goal yet)';
  const user = [
    `Pick the 6 papers below that could most inspire new ideas for ${aim}. Prefer recent, concrete results that make something newly possible. Skip papers that only improve a benchmark score.`,
    'For each: the id exactly as given, a plain-language title (no jargon), a summary of what the research makes possible, and a hook: one idea it could inspire for the goal.',
    `Write title, summary and hook in ${LANG_NAME[a.lang]}.`,
    `Papers:\n${list}`,
  ].join('\n\n');
  const r = await a.chat({
    model: a.model,
    system: 'You are a research scout who reads AI papers and explains to designers and founders what each one makes possible.',
    user,
    schemaName: 'research',
    schema: RESEARCH_SCHEMA,
    temperature: 0.4,
    maxTokens: 2500,
  });
  const leads: LeadDraft[] = [];
  for (const l of Array.isArray(r.value?.leads) ? r.value.leads : []) {
    const p = byId.get(String(l.id).replace(/^\[|\]$/g, ''));
    if (!p || leads.some((x) => x.meta.paperId === p.id)) continue; // unknown or repeated id: drop
    leads.push({
      title: clean(l.title, 120) || p.title,
      summary: clean(l.summary, 400),
      hook: clean(l.hook, 300),
      url: `https://huggingface.co/papers/${p.id}`,
      meta: { paperId: p.id, paperTitle: p.title, published: p.published.slice(0, 10), upvotes: p.upvotes },
    });
  }
  return { leads, costUsd: r.costUsd };
}
