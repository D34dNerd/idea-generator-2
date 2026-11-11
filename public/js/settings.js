// App settings live in this browser (localStorage): API keys, provider
// addresses, the model for each role, the projects folder, the Obsidian vault, the global budget.
// They are pushed to the local server, which holds them in memory only.

import { api } from './api.js';

const KEY = 'ideagen.settings.v1';
export const ROLES = ['distill', 'expand', 'combine', 'judge', 'summary', 'research', 'x', 'brief'];
export const PROVIDER_IDS = ['openrouter', 'anthropic', 'openai', 'groq', 'google', 'azure', 'ollama', 'mlx', 'lmstudio', 'custom', 'agy', 'claudecode'];

const SONNET = 'openrouter:anthropic/claude-sonnet-5.5';
export const DEFAULTS = {
  keys: {},
  baseUrls: { ollama: 'http://localhost:11434', mlx: 'http://localhost:8080/v1', lmstudio: 'http://localhost:1234/v1', azure: '', custom: '' },
  models: { distill: SONNET, expand: SONNET, combine: SONNET, judge: SONNET, summary: SONNET, research: SONNET, x: 'openrouter:x-ai/grok-4.3', brief: SONNET },
  projectsRoot: '~/Projekt/idea-projects',
  vaultRoot: '',
  vaultMinMedal: 2,
  maxUsdPerDay: 5,
  // What a new board starts with, so the jury and the autopilot are set up once, not per board.
  // Kept in the browser only; it is sent along when a board is created.
  boardDefaults: { judgeGuidance: '', autopilotSeconds: null, rate: null },
};

export function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    /* corrupt: start from defaults */
  }
  return {
    keys: { ...DEFAULTS.keys, ...saved.keys },
    baseUrls: { ...DEFAULTS.baseUrls, ...saved.baseUrls },
    models: { ...DEFAULTS.models, ...saved.models },
    projectsRoot: saved.projectsRoot || DEFAULTS.projectsRoot,
    vaultRoot: saved.vaultRoot ?? DEFAULTS.vaultRoot,
    vaultMinMedal: [0, 1, 2, 3].includes(saved.vaultMinMedal) ? saved.vaultMinMedal : DEFAULTS.vaultMinMedal,
    maxUsdPerDay: Number.isFinite(saved.maxUsdPerDay) ? saved.maxUsdPerDay : DEFAULTS.maxUsdPerDay,
    boardDefaults: { ...DEFAULTS.boardDefaults, ...saved.boardDefaults },
  };
}

/** Push to the server; returns provider status (which keys it has, where from). */
export function pushSettings(s) {
  return api('PUT', '/api/runtime-settings', s);
}

/** The part of a new board's config that comes from the app settings (unset values are left to the server's defaults). */
export function newBoardConfig(s) {
  const d = s.boardDefaults ?? {};
  const config = {};
  if (d.judgeGuidance) config.judgeGuidance = d.judgeGuidance;
  if (Number.isFinite(d.autopilotSeconds)) config.autopilotSeconds = d.autopilotSeconds;
  if (d.rate && Number.isFinite(d.rate.stepsPerHour) && Number.isFinite(d.rate.usdPerDay)) config.rate = d.rate;
  return config;
}

export async function saveSettings(s) {
  localStorage.setItem(KEY, JSON.stringify(s));
  return pushSettings(s);
}

/** Providers the current models depend on, so we can warn about a missing key. */
export function providersInUse(s) {
  return [...new Set(ROLES.map((r) => providerOf(s.models[r])))];
}

export function providerOf(ref = '') {
  const i = ref.indexOf(':');
  const head = i > 0 ? ref.slice(0, i) : '';
  return PROVIDER_IDS.includes(head) ? head : 'openrouter';
}
