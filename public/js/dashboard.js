// Trends across all boards, by keyword. The table is the primary form (it is
// also the accessible view); each row carries a one-series sparkline of ideas
// per day with a hover crosshair, a signed change against the previous period,
// and a meter for the mean jury score (3–15).

import { api } from './api.js';
import { $, h, clear, svg } from './dom.js';
import { t, getLang, errorText } from './i18n.js';

const S = { days: 30, keyword: null, onOpenIdea: null, data: null };

export async function openDashboard({ keyword = null, onOpenIdea }) {
  S.keyword = keyword;
  S.onOpenIdea = onOpenIdea;
  const root = $('#dashboard');
  root.hidden = false;
  root.focus();
  await load();
}

function close() {
  $('#dashboard').hidden = true;
  $('#viz-tip').classList.remove('show');
}

async function load() {
  const root = $('#dashboard');
  try {
    S.data = await api('GET', `/api/dashboard?days=${S.days}`);
  } catch (e) {
    clear(root, h('p', { class: 'error' }, errorText(e)));
    return;
  }
  render();
  if (S.keyword) drill(S.keyword);
}

const fmt = (n) => new Intl.NumberFormat(getLang() === 'sv' ? 'sv-SE' : 'en-GB', { notation: 'compact' }).format(n);

function tile(label, value) {
  return h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, label), h('div', { class: 'tile-value' }, fmt(value)));
}

/** One series: a 2px line, the latest day marked, hover snaps to the day. */
function sparkline(series, days, keyword) {
  const W = 132, H = 30, pad = 3;
  const max = Math.max(1, ...series);
  const x = (i) => pad + (i * (W - pad * 2)) / Math.max(1, series.length - 1);
  const y = (v) => H - pad - (v / max) * (H - pad * 2);
  const pts = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const hair = svg('line', { x1: 0, x2: 0, y1: 0, y2: H, class: 'hair', visibility: 'hidden' });
  const dot = svg('circle', { r: 3.5, class: 'spark-dot', visibility: 'hidden' });
  const last = series.length - 1;
  const el = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'spark', role: 'img',
    'aria-label': `${keyword}: ${series.reduce((a, b) => a + b, 0)} / ${days.length}` },
    svg('line', { x1: pad, x2: W - pad, y1: H - pad, y2: H - pad, class: 'base' }),
    svg('polyline', { points: pts, class: 'spark-line' }),
    svg('circle', { cx: x(last), cy: y(series[last]), r: 2.5, class: 'spark-now' }),
    hair, dot,
  );
  const tip = $('#viz-tip');
  el.addEventListener('pointermove', (e) => {
    const r = el.getBoundingClientRect();
    const i = Math.max(0, Math.min(last, Math.round(((e.clientX - r.left - pad) / (W - pad * 2)) * last)));
    hair.setAttribute('x1', x(i)); hair.setAttribute('x2', x(i)); hair.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(series[i])); dot.setAttribute('visibility', 'visible');
    clear(tip, h('strong', {}, String(series[i])), ` ${t('count').toLowerCase()} · ${days[i]}`);
    tip.style.left = `${e.clientX + 12}px`;
    tip.style.top = `${e.clientY - 30}px`;
    tip.classList.add('show');
  });
  el.addEventListener('pointerleave', () => {
    hair.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    tip.classList.remove('show');
  });
  return el;
}

function change(recent, previous) {
  const d = recent - previous;
  const arrow = d > 0 ? '▲' : d < 0 ? '▼' : '–';
  return h('span', { class: `delta ${d > 0 ? 'up' : d < 0 ? 'down' : ''}` }, `${arrow} ${d > 0 ? '+' : ''}${d}`);
}

function meter(mean) {
  if (mean == null) return h('span', { class: 'muted' }, '–');
  const pct = Math.max(0, Math.min(1, (mean - 3) / 12)) * 100;
  return h('span', { class: 'jury' },
    h('span', { class: 'jury-track', role: 'img', 'aria-label': `${mean} / 15` }, h('span', { class: 'jury-fill', style: { width: `${pct}%` } })),
    h('span', { class: 'jury-num' }, mean.toFixed(1)),
  );
}

function render() {
  const d = S.data;
  const root = $('#dashboard');
  const period = (n) => h('button', { class: `seg ${S.days === n ? 'on' : ''}`, onclick: () => { S.days = n; load(); } }, t('days', { n }));
  clear(root,
    h('header', { class: 'dash-head' },
      h('h2', {}, t('dashTitle')),
      h('div', { class: 'seg-row', role: 'group' }, period(7), period(30), period(90)),
      h('button', { class: 'icon-btn', 'aria-label': t('close'), title: t('close'), onclick: close }, '✕'),
    ),
    h('div', { class: 'tiles' },
      tile(t('statIdeas'), d.totals.ideas), tile(t('statBoards'), d.totals.boards),
      tile(t('statKeywords'), d.totals.keywords), tile(t('statRecent', { n: S.days }), d.totals.recent),
    ),
    !d.keywords.length
      ? h('p', { class: 'muted' }, t('dashEmpty'))
      : h('div', { class: 'dash-body' },
          h('div', { class: 'dash-main' },
            h('table', { class: 'trend-table' },
              h('thead', {}, h('tr', {},
                h('th', {}, t('keyword')), h('th', {}, t('trend')), h('th', { class: 'num' }, t('count')),
                h('th', { class: 'num' }, t('change')), h('th', { class: 'num' }, t('onBoards')), h('th', {}, t('meanJury')))),
              h('tbody', {}, d.keywords.map((k) =>
                h('tr', { class: S.keyword === k.keyword ? 'on' : '', tabindex: 0, onclick: () => drill(k.keyword), onkeydown: (e) => e.key === 'Enter' && drill(k.keyword) },
                  h('td', {}, h('button', { class: 'linkish' }, k.keyword)),
                  h('td', {}, sparkline(k.series, d.days, k.keyword)),
                  h('td', { class: 'num' }, String(k.count)),
                  h('td', { class: 'num' }, change(k.recent, k.previous)),
                  h('td', { class: 'num' }, String(k.boards)),
                  h('td', {}, meter(k.meanSum)),
                ))),
            ),
            h('small', { class: 'muted' }, t('tableNote')),
          ),
          h('aside', { class: 'dash-side' },
            h('section', { id: 'drill' }),
            h('section', {},
              h('h3', {}, t('boardKeywords')),
              d.boards.map((b) => h('div', { class: 'board-kw' },
                h('strong', {}, b.title),
                h('div', { class: 'chips' }, b.keywords.map((k) => h('button', { class: 'chip', onclick: () => drill(k.keyword) }, `${k.keyword} · ${k.count}`))),
              )),
            ),
          ),
        ),
  );
}

async function drill(keyword) {
  S.keyword = keyword;
  for (const tr of document.querySelectorAll('.trend-table tbody tr')) tr.classList.toggle('on', tr.querySelector('td')?.textContent === keyword);
  const box = $('#drill');
  if (!box) return;
  try {
    const { ideas } = await api('GET', `/api/keywords/${encodeURIComponent(keyword)}/ideas`);
    clear(box,
      h('h3', {}, t('ideasWith', { k: keyword })),
      h('ul', { class: 'drill-list' }, ideas.map((i) => {
        const sum = i.originality != null ? i.originality + i.feasibility + i.impact : null;
        return h('li', {}, h('button', {
          class: 'rank-item',
          onclick: () => { close(); S.onOpenIdea?.(i.boardId, i.id); },
        }, h('span', { class: 'grow' }, i.title), h('span', { class: 'muted small' }, i.boardTitle), h('span', { class: 'rank-score' }, sum ?? '')));
      })),
    );
  } catch (e) {
    clear(box, h('p', { class: 'error' }, errorText(e)));
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#dashboard').hidden) close();
});
