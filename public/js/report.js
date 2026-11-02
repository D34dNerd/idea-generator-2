// The report: insights, ideas and Claude Code projects across all boards,
// for a chosen period. Conclusions are written on request (one LLM call) and
// saved, so opening the report costs nothing.

import { api } from './api.js';
import { $, h, clear, toast } from './dom.js';
import { t, getLang, errorText } from './i18n.js';

const MEDAL_ICON = ['', '🥉', '🥈', '🥇'];
const S = { days: 30, onOpenIdea: null, onOpenBoard: null };

export async function openReport({ onOpenIdea, onOpenBoard }) {
  S.onOpenIdea = onOpenIdea;
  S.onOpenBoard = onOpenBoard;
  const root = $('#report');
  root.hidden = false;
  root.focus();
  await load();
}

function close() {
  $('#report').hidden = true;
}

async function load() {
  const root = $('#report');
  try {
    render(await api('GET', `/api/report?days=${S.days}`));
  } catch (e) {
    clear(root, h('p', { class: 'error' }, errorText(e)));
  }
}

const startCmd = (path) => `cd "${path}" && claude`;

function ideaLine(i, boardTitle) {
  return h('button', { class: 'rank-item', onclick: () => { close(); S.onOpenIdea?.(i.boardId, i.id); } },
    h('span', { class: 'grow' }, i.title),
    boardTitle ? h('span', { class: 'muted small' }, boardTitle) : null,
    h('span', { class: 'rank-score' }, `${i.sum ?? ''} ${i.medal ? MEDAL_ICON[i.medal] : ''}`),
  );
}

function render(r) {
  const root = $('#report');
  const m = r.totals.medals;
  const period = (n) => h('button', { class: `seg ${S.days === n ? 'on' : ''}`, onclick: () => { S.days = n; load(); } }, t('days', { n }));
  const s = r.synthesis;
  const list = (items) => h('ul', {}, items.map((x) => h('li', {}, x)));

  clear(root,
    h('header', { class: 'dash-head' },
      h('h2', {}, t('report')),
      h('div', { class: 'seg-row', role: 'group' }, period(7), period(30), period(90)),
      h('button', { class: 'btn small', onclick: exportReport }, t('export')),
      h('button', { class: 'icon-btn', 'aria-label': t('close'), title: t('close'), onclick: close }, '✕'),
    ),
    h('div', { class: 'tiles' },
      tile(t('statIdeas'), `${r.totals.ideas}`, t('reportNew', { n: r.totals.newIdeas })),
      tile(t('reportMedals'), `🥇 ${m.gold}  🥈 ${m.silver}  🥉 ${m.bronze}`),
      tile(t('reportProjects'), `${r.totals.projects}`),
      tile(t('reportSpent', { n: S.days }), `$${r.totals.spentUsd.toFixed(2)}`),
    ),

    h('section', { class: 'report-block' },
      h('div', { class: 'row space' },
        h('h3', {}, t('conclusions')),
        h('button', { class: 'btn small primary', onclick: (ev) => synthesize(ev.currentTarget) }, s ? t('rewriteConclusions') : t('writeConclusions')),
      ),
      s
        ? [
            h('p', { class: 'muted small' }, t('conclusionsFrom', { date: new Date(s.createdAt.replace(' ', 'T') + 'Z').toLocaleString(getLang() === 'sv' ? 'sv-SE' : 'en-GB'), n: s.days })),
            h('p', { class: 'headline' }, s.headline),
            h('div', { class: 'grid2' },
              h('div', {}, h('h4', {}, t('insights')), list(s.insights)),
              h('div', {}, h('h4', {}, t('standouts')),
                h('ul', {}, s.standouts.map((x) => h('li', {}, h('strong', {}, x.title), h('span', { class: 'muted' }, ` · ${x.board}`), ` – ${x.why}`)))),
              h('div', {}, h('h4', {}, t('opportunities')), list(s.opportunities)),
              h('div', {}, h('h4', {}, t('nextSteps')), list(s.nextSteps)),
            ),
          ]
        : h('p', { class: 'muted' }, t('conclusionsHint')),
    ),

    h('section', { class: 'report-block' },
      h('h3', {}, t('reportProjects')),
      !r.projects.length
        ? h('p', { class: 'muted' }, t('noProjects'))
        : h('ul', { class: 'project-list' }, r.projects.map((p) =>
            h('li', {},
              h('div', { class: 'row space' },
                h('button', { class: 'linkish', onclick: () => { close(); S.onOpenIdea?.(p.boardId, p.id); } }, h('strong', {}, p.title)),
                h('span', { class: 'muted small' }, `${p.boardTitle}${p.sum != null ? ` · ${p.sum}/15 ${MEDAL_ICON[p.medal] ?? ''}` : ''}`),
              ),
              h('code', { class: 'cmd' }, startCmd(p.path)),
              h('div', { class: 'row' },
                h('button', { class: 'btn small', onclick: () => navigator.clipboard.writeText(startCmd(p.path)).then(() => toast(t('copied'))) }, t('copyStart')),
                h('button', { class: 'btn small', onclick: () => api('POST', `/api/ideas/${p.id}/reveal`, {}).catch((e) => toast(errorText(e), 'error')) }, t('revealProject')),
              ),
            ))),
    ),

    h('section', { class: 'report-boards' },
      r.boards.map((b) =>
        h('article', { class: 'report-board' },
          h('div', { class: 'row space' },
            h('button', { class: 'linkish', onclick: () => { close(); S.onOpenBoard?.(b.id); } }, h('h3', {}, b.title)),
            h('span', { class: 'muted small' }, `${b.ideaCount} ${t('ideasWord')} · ${t('reportNew', { n: b.newIdeas })}${b.mode === 'auto' ? ` · ${t('auto')}` : ''}`),
          ),
          b.goal ? h('p', { class: 'muted' }, b.goal) : null,
          b.summary
            ? h('div', { class: 'board-summary' },
                h('p', {}, b.summary.headline, b.summary.stale ? h('span', { class: 'stale' }, ` (${t('summaryOld')})`) : null),
                b.summary.gaps?.length ? [h('h4', {}, t('gaps')), list(b.summary.gaps)] : null,
                b.summary.nextSteps?.length ? [h('h4', {}, t('nextSteps')), list(b.summary.nextSteps)] : null,
              )
            : h('p', { class: 'muted small' }, t('noBoardSummary')),
          b.best.length ? [h('h4', {}, t('topIdeas')), h('div', {}, b.best.map((i) => ideaLine(i)))] : null,
          b.projects.length ? h('p', { class: 'small' }, `📁 ${b.projects.map((p) => p.title).join(' · ')}`) : null,
        ),
      ),
    ),
  );
}

function tile(label, value, sub) {
  return h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, label), h('div', { class: 'tile-value' }, value), sub ? h('div', { class: 'muted small' }, sub) : null);
}

async function synthesize(btn) {
  btn.disabled = true;
  btn.textContent = t('thinking');
  try {
    render(await api('POST', '/api/report/synthesis', { days: S.days, lang: getLang() }));
  } catch (e) {
    toast(errorText(e), 'error', 8000);
    btn.disabled = false;
  }
}

async function exportReport() {
  try {
    const md = await api('GET', `/api/report.md?days=${S.days}&lang=${getLang()}`);
    const a = h('a', { href: URL.createObjectURL(new Blob([md], { type: 'text/markdown' })), download: `rapport-${new Date().toISOString().slice(0, 10)}.md` });
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    toast(errorText(e), 'error');
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#report').hidden) close();
});
