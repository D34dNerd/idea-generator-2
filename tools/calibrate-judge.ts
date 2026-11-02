// Calibrate the judge against known-weak and known-strong ideas, with the
// real model. Costs money (about 22 judge calls), so it is not part of
// `npm test`. Any provider works; keys come from the environment:
//   npm run calibrate
//   npm run calibrate -- --model anthropic:claude-haiku-5-5
//   npm run calibrate -- --model ollama:qwen3:8b
// Re-run it whenever you point the judge at a different model.
//
// The weak set includes ideas the OLD IdeaSphere judge rated 3/3 "gold"
// ("fire", "electric cars"). The new judge must not.

import { makeLLM } from '../server/llm.ts';
import { DEFAULT_APP_SETTINGS, makeChat } from '../server/providers.ts';
import { medalFromSum } from '../public/js/score.js';

const WEAK = [
  'fire',
  'Electric cars',
  'En app för att hitta nya vänner',
  'Använd AI för att förbättra vården',
  'Make cities greener',
  'Solpaneler på taken',
];

const STRONG = [
  'Reservdelsbibliotek: Folkbiblioteken 3D-skannar och skriver ut trasiga plastdetaljer till hushållsapparater på beställning, så att en bruten lucka inte gör att en fungerande diskmaskin kasseras.',
  'Elmätaren som anhöriglarm: En billig sensor på elmätaren känner igen apparaters strömsignaturer och skickar sms till anhöriga när en äldre persons morgonrutin med vattenkokare och kaffebryggare uteblir.',
  'Skolbussen som paketbil: Landsbygdens skolbussar tar paket och apotekspåsar i ett låst bagageutrymme mellan morgon- och eftermiddagsturen, så att glesbygden får dagliga leveranser utan nya fordon.',
  "Pothole map from bus suspensions: accelerometers already fitted in city buses flag repeated jolts at the same GPS spot, and the road department gets a ranked repair list every morning.",
  "Receipt-to-swap coach: the grocery chain's loyalty app turns each receipt into three concrete swaps for the next shop that cut saturated fat, each costing the same or less.",
];

const modelArg = process.argv.indexOf('--model');
const model = modelArg > 0 ? process.argv[modelArg + 1] : DEFAULT_APP_SETTINGS.models.judge;
const RUNS = 2;

const llm = makeLLM(makeChat(() => DEFAULT_APP_SETTINGS));
const board = { goal: '' };
const asIdea = (text: string) => {
  const [title, ...rest] = text.split(': ');
  return rest.length ? { title, pitch: rest.join(': ') } : { title: text, pitch: '' };
};

let cost = 0;
async function judgeAll(texts: string[]) {
  return Promise.all(
    texts.map(async (text) => {
      const runs = [];
      for (let r = 0; r < RUNS; r++) {
        const { judgement, costUsd } = await llm.judge({ model, board, idea: asIdea(text), lang: 'sv' });
        cost += costUsd;
        runs.push(judgement);
      }
      return { text, runs, sums: runs.map((j) => j.originality + j.feasibility + j.impact) };
    }),
  );
}

console.log(`Judge model: ${model}, ${RUNS} runs per idea\n`);
const [weak, strong] = await Promise.all([judgeAll(WEAK), judgeAll(STRONG)]);
const MEDAL = ['–', '🥉', '🥈', '🥇'];
for (const [label, rows] of [['WEAK', weak], ['STRONG', strong]] as const) {
  console.log(label);
  for (const r of rows) {
    const j = r.runs[0];
    console.log(
      `  ${r.sums.map((s) => String(s).padStart(2)).join(' ')}  ${r.sums.map((s) => MEDAL[medalFromSum(s)!]).join('')}  ` +
        `O${j.originality} F${j.feasibility} I${j.impact}  ${r.text.slice(0, 48)}`,
    );
    console.log(`        ↳ ${j.reason}`);
  }
}

const mean = (rows: typeof weak) => rows.flatMap((r) => r.sums).reduce((a, b) => a + b, 0) / (rows.length * RUNS);
const weakMax = Math.max(...weak.flatMap((r) => r.sums));
const gap = mean(strong) - mean(weak);
const strongGold = strong.flatMap((r) => r.sums).filter((s) => s >= 13).length;
const spread = Math.max(...[...weak, ...strong].map((r) => Math.max(...r.sums) - Math.min(...r.sums)));

console.log(`\nweak mean ${mean(weak).toFixed(1)}, max ${weakMax} · strong mean ${mean(strong).toFixed(1)} · gap ${gap.toFixed(1)}`);
console.log(`strong ideas reaching gold: ${strongGold} of ${strong.length * RUNS} · largest run-to-run spread: ${spread}`);
console.log(`cost: $${cost.toFixed(4)}`);

const failures = [];
if (weakMax >= 9) failures.push(`a weak idea reached a medal (sum ${weakMax} ≥ 9)`);
if (gap < 3) failures.push(`strong and weak are only ${gap.toFixed(1)} apart (need ≥ 3)`);
if (failures.length) {
  console.log(`\nFAIL: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nPASS: weak ideas earn no medal, and the judge separates weak from strong.');
