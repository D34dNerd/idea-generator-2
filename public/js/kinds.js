// Board kinds, shared by the server, the browser and the tests (pure, like score.js).
//
// Every kind keeps the same skeleton: three criteria scored 1–5 into the same
// three slots (originality, feasibility, impact), goal fit 1–5, and medals from
// the sum (score.js). Only what each criterion means changes per kind, so the
// labels here and the jury's rubric in server/kinds.ts. The prompts live on the
// server; this file holds what the UI and the exports need.

export const KINDS = ['ideas', 'niche', 'post', 'video'];

/** Kinds whose boards need to know who they work for ("who we are, what we do"). */
export const NEEDS_BRIEF = ['post', 'video'];

/** A board's kind; boards made before kinds existed are 'ideas'. */
export const kindOf = (board) => (KINDS.includes(board?.config?.kind) ? board.config.kind : 'ideas');

const LABELS = {
  ideas: {
    sv: ['Originalitet', 'Genomförbarhet', 'Effekt'],
    en: ['Originality', 'Feasibility', 'Impact'],
    pt: ['Originalidade', 'Viabilidade', 'Impacto'],
  },
  niche: {
    sv: ['Lucka', 'Åtkomst', 'Efterfrågan'],
    en: ['Gap', 'Access', 'Demand'],
    pt: ['Brecha', 'Acesso', 'Demanda'],
  },
  post: {
    sv: ['Krok', 'Värde', 'Görbarhet'],
    en: ['Hook', 'Value', 'Doability'],
    pt: ['Gancho', 'Valor', 'Execução'],
  },
  video: {
    sv: ['Krok', 'Behållning', 'Görbarhet'],
    en: ['Hook', 'Payoff', 'Doability'],
    pt: ['Gancho', 'Retenção', 'Execução'],
  },
};

const NAMES = {
  ideas: { sv: 'Idéer', en: 'Ideas', pt: 'Ideias' },
  niche: { sv: 'Marknadsnisch', en: 'Market niche', pt: 'Nicho de mercado' },
  post: { sv: 'Inlägg i sociala medier', en: 'Social media post', pt: 'Post para redes sociais' },
  video: { sv: 'Videoidé', en: 'Video idea', pt: 'Ideia de vídeo' },
};

const lang3 = (lang) => (lang === 'sv' || lang === 'en' || lang === 'pt' ? lang : 'en');

/** The three criteria's names for a kind, in slot order (originality, feasibility, impact). */
export const critLabels = (kind, lang) => (LABELS[kind] ?? LABELS.ideas)[lang3(lang)];

/** The name of a kind, for menus and notes. */
export const kindName = (kind, lang) => (NAMES[kind] ?? NAMES.ideas)[lang3(lang)];
