// Seeds from a link: fetch the page and pull out readable text.
// Deliberately simple: prefer <article>, then <main>, then <body>; drop
// scripts, navigation and other chrome; keep paragraph breaks.

const MAX_BYTES = 2_000_000;
const MAX_CHARS = 6000;

/** A single URL (optionally without scheme), or null if the text is not one. */
export function asUrl(text: string): string | null {
  const t = text.trim();
  if (/\s/.test(t)) return null;
  const candidate = /^https?:\/\//i.test(t) ? t : /^www\.[^\s.]+\.\S+$/i.test(t) ? `https://${t}` : null;
  if (!candidate) return null;
  try {
    const u = new URL(candidate);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  aring: 'å', auml: 'ä', ouml: 'ö', Aring: 'Å', Auml: 'Ä', Ouml: 'Ö', eacute: 'é',
};

export function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string): { title: string; text: string } {
  const titleMatch =
    html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : '';

  let body = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of ['script', 'style', 'noscript', 'svg', 'nav', 'header', 'footer', 'aside', 'form', 'template', 'iframe']) {
    body = body.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
  }
  const pick = (tag: string) => body.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1];
  const main = pick('article') ?? pick('main') ?? pick('body') ?? body;

  const text = decodeEntities(
    main
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|blockquote|section|tr)>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, text: text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n[…]` : text };
}

export async function fetchPage(url: string): Promise<{ title: string; text: string }> {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(12_000),
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'sv,en;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (!/html|text\/plain/i.test(type)) throw new Error(`Not a web page (${type || 'unknown type'})`);
  const buf = await res.arrayBuffer();
  const html = new TextDecoder('utf-8').decode(buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf);
  return /text\/plain/i.test(type) ? { title: '', text: html.slice(0, MAX_CHARS) } : htmlToText(html);
}
