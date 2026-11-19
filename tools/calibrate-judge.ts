// Calibrate the judge against known-weak and known-strong ideas, with the
// real model. Costs money (about 22 single judge calls, 3 fit calls and 6 batched calls), so it is not part of
// `npm test`. Any provider works; keys come from the environment:
//   npm run calibrate
//   npm run calibrate -- --model anthropic:claude-haiku-5-5
//   npm run calibrate -- --model ollama:qwen3:8b
//   npm run calibrate -- --kind niche          (each board kind has its own rubric and references)
// Re-run it whenever you point the judge at a different model.
//
// The weak set includes bare topics ("fire", "electric cars") that an
// uncalibrated LLM judge rated 3/3 "gold". This judge must not.

import { makeLLM } from '../server/llm.ts';
import { packOf, toKind } from '../server/kinds.ts';
import { DEFAULT_APP_SETTINGS, makeChat } from '../server/providers.ts';
import { medalFromSum } from '../public/js/score.js';

const IDEAS_WEAK = [
  'fire',
  'Electric cars',
  'En app för att hitta nya vänner',
  'Använd AI för att förbättra vården',
  'Make cities greener',
  'Solpaneler på taken',
  'Um aplicativo para organizar tarefas',
  'Usar blockchain na educação',
];

const IDEAS_STRONG = [
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
const IDEAS_FIT_GOAL = 'Guias de montagem em realidade aumentada que uma pessoa usa sozinha em casa';
const IDEAS_ON_GOAL = [
  'Guia RA que confere cada passo: o celular compara a foto da peça montada com o modelo 3D do manual e só libera o próximo passo quando a peça certa está no lugar, evitando desmontar o móvel inteiro no fim.',
];
const IDEAS_OFF_GOAL = [
  'Cronômetro de corte para pães: a câmera do celular mede quanto a massa volta ao ser pressionada e avisa o momento exato de cortar e levar ao forno.',
  'Sequenciador térmico para soldagem: um script lê o projeto da placa no KiCad e ordena os pontos de solda para que nenhuma região aqueça duas vezes seguidas.',
];

// Niches: categories and demographics must earn no medal; narrow, painful, reachable groups must.
const NICHE_WEAK = [
  'Pet shops',
  'Pessoas que querem emagrecer',
  'Pequenas empresas que precisam de marketing',
  'Small businesses that need a website',
  'Um app de IA para criadores de conteúdo',
  'Mães que trabalham em casa',
  'Investidores iniciantes',
  'Fitness for busy people',
];
const NICHE_STRONG = [
  'Oficinas de moto sem controle de estoque: oficinas de bairro com 1 a 3 mecânicos perdem vendas porque não sabem se têm a peça e ligam para três distribuidores a cada orçamento. Estão todas nos grupos de WhatsApp dos distribuidores regionais. Oferta: estoque por foto, mantido pelo atendente, por R$ 79 ao mês.',
  'Contadores de MEIs entregadores: escritórios contábeis pequenos com mais de 200 MEIs de aplicativos de entrega refazem à mão a guia de quem atrasou o DAS e perdem dias todo começo de mês. Estão nos cursos e grupos do conselho regional. Oferta: lembrete por WhatsApp com a guia pronta, cobrado do escritório por cliente.',
  'Síndicos profissionais de 10 a 30 prédios: a cada assembleia montam a prestação de contas juntando extratos e notas em PDF e pagam um assistente só para isso. Estão nas associações de síndicos e nos cursos de gestão condominial. Oferta: relatório de assembleia gerado a partir do extrato, R$ 15 por prédio ao mês.',
  'Independent physiotherapists renting rooms by the hour: they lose two or three paid slots a week to no-shows because booking is a WhatsApp chat, and the room owner still charges them. They meet in the same rental buildings and in CPD courses. Offer: a deposit-backed booking link, 3% per paid session.',
  'Small-batch hot sauce makers at farmers markets: every recipe change means a new nutrition label, and a lab charges them about 150 euros each time. They gather in maker groups and on market organisers\' mailing lists. Offer: a label calculator from the recipe, checked against the official food table, 9 euros per label.',
  'Marmorarias que orçam pia por telefone: marmorarias com até 5 funcionários perdem uma visita técnica por orçamento porque o cliente mede errado; gastam meio dia de carro para medir. Compram todas dos mesmos três atacadistas de chapas da região. Oferta: medição por fotos com uma régua impressa, R$ 120 ao mês.',
];
const NICHE_FIT_GOAL = 'Nichos B2B que um consultor de software sozinho, em Santa Catarina, possa atender com pouco dinheiro';
const NICHE_ON_GOAL = [
  'Marmorarias catarinenses que orçam à mão: marmorarias com até 5 funcionários refazem orçamentos em papel e perdem visitas técnicas por medidas erradas. Compram dos mesmos atacadistas de chapas da região. Oferta: sistema simples de orçamento por fotos, R$ 120 ao mês.',
];
const NICHE_OFF_GOAL = [
  'Tutores de cães idosos: donos de cães com mais de 12 anos gastam com remédios caros e não sabem dosar em casa. Estão em grupos de tutores no Instagram. Oferta: caixinha de doses semanais por assinatura.',
  'Turistas argentinos no verão de Florianópolis: perdem tempo procurando praias sem fila e restaurantes que aceitam peso. Estão em grupos de viagem do Facebook. Oferta: guia diário pago por WhatsApp.',
];

// Posts and videos are judged for someone: every reference is for this brief.
const CONTENT_BRIEF =
  'Consultor de software sozinho em Florianópolis. Monta sistemas simples (planilhas, WhatsApp, pequenos apps) para oficinas mecânicas e pequenos comércios da Grande Florianópolis. Fala direto, sem jargão, com casos reais de clientes.';

const POST_WEAK = [
  'Post sobre produtividade',
  '5 dicas para usar melhor a tecnologia na sua empresa',
  'Você sabia que a tecnologia pode ajudar o seu negócio?',
  'Post de bom dia motivacional',
  'Carrossel sobre transformação digital',
  'Reel mostrando o nosso escritório',
  'Top 10 tools for small business',
  'Post: comente SIM se você quer crescer',
];
const POST_STRONG = [
  'Carrossel "A peça estava na prateleira": gancho "Seu mecânico disse que não tinha a peça. Ela estava na prateleira de cima." Em 5 telas, o caso real de uma oficina de Palhoça que perdeu 3 vendas numa semana com estoque de cabeça, e a planilha de 20 minutos que resolveu. Chamada: mande para um dono de oficina que você conhece.',
  'Reel de 30 s "Orçamento em 2 minutos": abre com um cronômetro na tela e a frase "Cliente no balcão: quanto tempo você leva para dar o preço?". Eu monto no celular o orçamento de uma troca de embreagem com a tabela da oficina. Chamada: comente "tabela" que eu mando o modelo.',
  'Post estático "O erro que custa R$ 800 por mês": o número em letras grandes; três linhas explicam que a oficina que não anota a garantia das peças paga o retrabalho do próprio bolso, e o que anotar em cada nota de compra. Chamada: salve para a próxima compra de peças.',
  'Thread "Por que recusei vender um sistema de R$ 30 mil para uma oficina de 2 pessoas": a primeira linha é a frase; em 6 posts conto o que a oficina realmente precisava (uma planilha e um grupo de WhatsApp), quanto custou e o resultado em 60 dias. Chamada: responda com o tamanho da sua oficina.',
  'Story em 4 telas "Adivinhe o prejuízo": enquete com 3 valores de quanto uma oficina perde por mês com o cliente que não volta para a revisão; na tela seguinte, a conta com os números de um cliente meu e o lembrete por WhatsApp que trouxe 12 clientes de volta.',
];
const POST_FIT_GOAL = 'Posts que tragam donos de oficinas mecânicas para a consultoria';
const POST_ON_GOAL = [
  'Carrossel "Quanto custa o cliente que não volta?": gancho com o valor que uma oficina de Biguaçu perdia por mês em revisões esquecidas; em 4 telas, o lembrete por WhatsApp que montei para ela e quantos clientes voltaram. Chamada: mande "revisão" no direct.',
];
const POST_OFF_GOAL = [
  'Carrossel "Pão de fermentação natural em 3 passos": gancho "Seu pão não cresce por causa da água, não do fermento". Mostra a temperatura certa, o tempo de descanso e o teste do dedo. Chamada: salve para o fim de semana.',
  'Reel "Minha rotina de academia às 5h": abre com o despertador tocando; mostro o treino de 40 minutos e o café da manhã. Chamada: comente o seu horário de treino.',
];

const VIDEO_WEAK = [
  'Vídeo sobre tecnologia',
  'Vídeo institucional da empresa',
  'Olá pessoal, hoje vou falar sobre gestão',
  'Vídeo com dicas de produtividade',
  'Vlog do meu dia',
  'Video about AI tools',
  'Tutorial de Excel',
  'Vídeo motivacional para empreendedores',
];
const VIDEO_STRONG = [
  'Short de 45 s "Achei R$ 2.300 parados na prateleira": abre comigo segurando uma caixa de peças empoeirada e dizendo o valor. Beats: contamos com o celular o estoque parado de uma oficina de Palhoça em 10 minutos, mostro a planilha, revelo o total e o que o dono fez com as peças. Final: "quer a planilha? comenta estoque".',
  'Vídeo longo de 12 min "Montei o sistema de uma oficina com R$ 0 em uma tarde": os 3 primeiros segundos mostram o resultado no celular do mecânico. Capítulos: o problema (cliente perdido), a montagem com planilha e WhatsApp, o teste ao vivo com um cliente real e os números depois de 30 dias. Final: link do modelo.',
  'Short de 30 s "Teste: quanto tempo para dar um orçamento?": abre com um cronômetro e "cliente no balcão, valendo!". Beats: o dono da oficina tenta pelo caderno (3 min), depois pela tabela no celular (40 s), corte para a cara dele. Final: "a tabela está no link".',
  'Short de 50 s "O erro que me fez perder um cliente de R$ 15 mil": abro dizendo o valor, olhando para a câmera. Beats: o que prometi, onde errei (sem escopo escrito), o que faço hoje, e o documento de uma página na tela. Final: "salva para não cair nessa".',
  'Vídeo de 8 min "Reagindo ao sistema de R$ 30 mil que venderam para uma oficina": os 3 primeiros segundos mostram a tela confusa e o preço. Beats: aponto 3 telas que ninguém usa, mostro a alternativa simples ao lado e o dono conta quanto pagaria por ela. Final: pergunta nos comentários sobre o sistema de cada um.',
];
const VIDEO_FIT_GOAL = 'Vídeos que tragam donos de oficinas mecânicas para a consultoria';
const VIDEO_ON_GOAL = [
  'Short de 40 s "Cliente sumido, cliente de volta": abre com a tela do WhatsApp recebendo "posso trazer o carro amanhã?". Beats: a lista de revisões vencidas de uma oficina de São José, o lembrete automático que montei, quantos voltaram no mês. Final: "comenta revisão que eu mostro como".',
];
const VIDEO_OFF_GOAL = [
  'Short de 40 s "Pão de fermentação natural em 3 passos": abre com o pão murcho ao lado do pão crescido. Beats: a temperatura da água, o descanso, o teste do dedo. Final: "salva para o domingo".',
  'Vídeo de 10 min "Minha viagem ao Paraguai de moto": abre com a moto na ponte da Amizade. Capítulos: a estrada, a fronteira, as compras e quanto gastei. Final: pergunta qual viagem fazer depois.',
];

const REFS = {
  ideas: { weak: IDEAS_WEAK, strong: IDEAS_STRONG, fitGoal: IDEAS_FIT_GOAL, on: IDEAS_ON_GOAL, off: IDEAS_OFF_GOAL, brief: '' },
  niche: { weak: NICHE_WEAK, strong: NICHE_STRONG, fitGoal: NICHE_FIT_GOAL, on: NICHE_ON_GOAL, off: NICHE_OFF_GOAL, brief: '' },
  post: { weak: POST_WEAK, strong: POST_STRONG, fitGoal: POST_FIT_GOAL, on: POST_ON_GOAL, off: POST_OFF_GOAL, brief: CONTENT_BRIEF },
  video: { weak: VIDEO_WEAK, strong: VIDEO_STRONG, fitGoal: VIDEO_FIT_GOAL, on: VIDEO_ON_GOAL, off: VIDEO_OFF_GOAL, brief: CONTENT_BRIEF },
} as const;
const kindArg = process.argv.indexOf('--kind');
const kind = toKind(kindArg > 0 ? process.argv[kindArg + 1] : 'ideas');
if (!(kind in REFS)) throw new Error(`No calibration references for kind "${kind}" yet`);
const ref = REFS[kind as keyof typeof REFS];
const WEAK = ref.weak, STRONG = ref.strong, FIT_GOAL = ref.fitGoal, ON_GOAL = ref.on, OFF_GOAL = ref.off;
const [C1, C2, C3] = packOf(kind).criteria.map((c) => c[0].toUpperCase());

const modelArg = process.argv.indexOf('--model');
const model = modelArg > 0 ? process.argv[modelArg + 1] : DEFAULT_APP_SETTINGS.models.judge;
const RUNS = 2;

const llm = makeLLM(makeChat(() => DEFAULT_APP_SETTINGS));
const board = { goal: '', config: { kind, brief: ref.brief } };
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

console.log(`Judge model: ${model}, kind: ${kind}, ${RUNS} runs per idea\n`);
const [weak, strong] = await Promise.all([judgeAll(WEAK), judgeAll(STRONG)]);
const MEDAL = ['–', '🥉', '🥈', '🥇'];
for (const [label, rows] of [['WEAK', weak], ['STRONG', strong]] as const) {
  console.log(label);
  for (const r of rows) {
    const j = r.runs[0];
    console.log(
      `  ${r.sums.map((s) => String(s).padStart(2)).join(' ')}  ${r.sums.map((s) => MEDAL[medalFromSum(s)!]).join('')}  ` +
        `${C1}${j.originality} ${C2}${j.feasibility} ${C3}${j.impact}  ${r.text.slice(0, 48)}`,
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
    const { judgement, costUsd } = await llm.judge({ model, board: { goal: FIT_GOAL, config: { kind, brief: ref.brief } }, idea: asIdea(text), lang: 'pt' });
    cost += costUsd;
    return { text, fit: judgement.fit, j: judgement };
  }));
const [on, off] = await Promise.all([fitRuns(ON_GOAL), fitRuns(OFF_GOAL)]);
console.log(`GOAL FIT (goal: ${FIT_GOAL})`);
for (const r of [...on, ...off]) console.log(`  fit ${r.fit ?? '?'}  ${C1}${r.j.originality} ${C2}${r.j.feasibility} ${C3}${r.j.impact}  ${r.text.slice(0, 60)}`);

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
