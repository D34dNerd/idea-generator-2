// Calibrate the judge against known-weak and known-strong ideas, with the
// real model. Costs money (about 22 single judge calls, 3 fit calls and 6 batched calls), so it is not part of
// `npm test`. Any provider works; keys come from the environment:
//   npm run calibrate
//   npm run calibrate -- --model anthropic:claude-haiku-5-5
//   npm run calibrate -- --model ollama:qwen3:8b
// Re-run it whenever you point the judge at a different model.
//
// The weak set includes bare topics ("fire", "electric cars") that an
// uncalibrated LLM judge rated 3/3 "gold". This judge must not.

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
  'Um aplicativo para organizar tarefas',
  'Usar blockchain na educação',
];

const STRONG = [
  'Reservdelsbibliotek: Folkbiblioteken 3D-skannar och skriver ut trasiga plastdetaljer till hushållsapparater på beställning, så att en bruten lucka inte gör att en fungerande diskmaskin kasseras.',
  'Elmätaren som anhöriglarm: En billig sensor på elmätaren känner igen apparaters strömsignaturer och skickar sms till anhöriga när en äldre persons morgonrutin med vattenkokare och kaffebryggare uteblir.',
  'Skolbussen som paketbil: Landsbygdens skolbussar tar paket och apotekspåsar i ett låst bagageutrymme mellan morgon- och eftermiddagsturen, så att glesbygden får dagliga leveranser utan nya fordon.',
  "Pothole map from bus suspensions: accelerometers already fitted in city buses flag repeated jolts at the same GPS spot, and the road department gets a ranked repair list every morning.",
  "Receipt-to-swap coach: the grocery chain's loyalty app turns each receipt into three concrete swaps for the next shop that cut saturated fat, each costing the same or less.",
  'Feira que avisa o fim do estoque: feirantes registram por WhatsApp o que sobrou às 11h, e um robô manda aos moradores do bairro uma lista de xepa com desconto, reduzindo o desperdício no fim da feira.',
  'Agentes de saúde como sensores de dengue: os agentes comunitários fotografam caixas d\'água e calhas nas visitas que já fazem, e o mapa da prefeitura prioriza os quarteirões com mais focos antes da estação chuvosa.',
];

// Goal fit: the same board goal, one idea squarely on it and good ideas that drifted off it.
// A real board meant for AR assembly guides ended, ten generations later, on bread.
const FIT_GOAL = 'Guias de montagem em realidade aumentada que uma pessoa usa sozinha em casa';
const ON_GOAL = [
  'Guia RA que confere cada passo: o celular compara a foto da peça montada com o modelo 3D do manual e só libera o próximo passo quando a peça certa está no lugar, evitando desmontar o móvel inteiro no fim.',
];
const OFF_GOAL = [
  'Cronômetro de corte para pães: a câmera do celular mede quanto a massa volta ao ser pressionada e avisa o momento exato de cortar e levar ao forno.',
  'Sequenciador térmico para soldagem: um script lê o projeto da placa no KiCad e ordena os pontos de solda para que nenhuma região aqueça duas vezes seguidas.',
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

const fitRuns = async (texts: string[]) =>
  Promise.all(texts.map(async (text) => {
    const { judgement, costUsd } = await llm.judge({ model, board: { goal: FIT_GOAL }, idea: asIdea(text), lang: 'pt' });
    cost += costUsd;
    return { text, fit: judgement.fit, j: judgement };
  }));
const [on, off] = await Promise.all([fitRuns(ON_GOAL), fitRuns(OFF_GOAL)]);
console.log(`GOAL FIT (goal: ${FIT_GOAL})`);
for (const r of [...on, ...off]) console.log(`  fit ${r.fit ?? '?'}  O${r.j.originality} F${r.j.feasibility} I${r.j.impact}  ${r.text.slice(0, 60)}`);

console.log(`\nweak mean ${mean(weak).toFixed(1)}, max ${weakMax} · strong mean ${mean(strong).toFixed(1)} · gap ${gap.toFixed(1)}`);
console.log(`strong ideas reaching gold: ${strongGold} of ${strong.length * RUNS} · largest run-to-run spread: ${spread}`);
console.log(`cost: $${cost.toFixed(4)}`);

// The autopilot judges up to three ideas per call. Mixed batches (weak next to strong) must
// score like single calls: no ranking within the batch, no pulling toward the middle.
const mixed = WEAK.map((t, n) => [t, STRONG[n % STRONG.length]]).flat().map((text) => ({ text, weak: WEAK.includes(text) }));
const batched: { weak: boolean; sum: number }[] = [];
for (let n = 0; n < mixed.length; n += 3) {
  const chunk = mixed.slice(n, n + 3);
  const { judgements, costUsd } = await llm.judgeMany({ model, board, lang: 'sv', items: chunk.map((c) => ({ idea: asIdea(c.text) })) });
  cost += costUsd;
  judgements.forEach((j, k) => j && batched.push({ weak: chunk[k].weak, sum: j.originality + j.feasibility + j.impact }));
}
const bMean = (weak: boolean) => { const xs = batched.filter((b) => b.weak === weak).map((b) => b.sum); return xs.reduce((a, b) => a + b, 0) / (xs.length || 1); };
const bWeakMax = Math.max(0, ...batched.filter((b) => b.weak).map((b) => b.sum));
console.log(`BATCHES of 3 (weak and strong mixed): weak mean ${bMean(true).toFixed(1)}, max ${bWeakMax} · strong mean ${bMean(false).toFixed(1)} · ${batched.length} of ${mixed.length} verdicts returned · total cost $${cost.toFixed(4)}`);

const failures = [];
if (batched.length < mixed.length) failures.push(`batched judging returned ${batched.length} of ${mixed.length} verdicts`);
if (bWeakMax >= 9) failures.push(`in a batch, a weak idea reached a medal (sum ${bWeakMax})`);
if (bMean(false) - bMean(true) < 3) failures.push(`in batches, strong and weak are only ${(bMean(false) - bMean(true)).toFixed(1)} apart`);
if (weakMax >= 9) failures.push(`a weak idea reached a medal (sum ${weakMax} ≥ 9)`);
if (gap < 3) failures.push(`strong and weak are only ${gap.toFixed(1)} apart (need ≥ 3)`);
if (on.some((r) => (r.fit ?? 0) < 3)) failures.push('an idea squarely on the goal got goal fit under 3');
if (off.some((r) => r.fit == null || r.fit >= 3)) failures.push('an idea off the goal got goal fit 3 or more');
if (failures.length) {
  console.log(`\nFAIL: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nPASS: weak ideas earn no medal, the judge separates weak from strong, and it tells on-goal from off-goal.');
