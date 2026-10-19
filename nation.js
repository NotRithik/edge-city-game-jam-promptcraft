// The nation of Edge Goa: citizens with their own personalities, wallets and moods; an AI cabinet that debates and
// governs; a court; and public works that citizens build block by block, paid in xRupees (a MOCK ERC20 held on-chain,
// see chain.js). Everything that costs money goes through pay(), so treasury, wages, taxes and purchases are real
// on-chain moves. The server owns the simulation; the host browser shows it (citizens walking, building, protesting).
const OCCUPATIONS = ['builder', 'carpenter', 'mason', 'engineer', 'farmer', 'fisher', 'cook', 'merchant', 'teacher', 'doctor', 'guard', 'artist'];
const CONSTRUCTION = new Set(['builder', 'carpenter', 'mason', 'engineer']);
const FOOD_SELLERS = new Set(['farmer', 'fisher', 'cook', 'merchant']);
const PUBLIC_SERVANTS = new Set(['teacher', 'doctor', 'guard']);
export const NATION_LAWS = { // law -> [min, max, default, what it means]; the cabinet (and player votes) set these
  taxRate: [0, 50, 10, '% of every wage, salary and player payment that goes to the treasury'],
  ubi: [0, 100, 0, 'xRupees paid from the treasury to every citizen and online player every 5 minutes'],
  salary: [0, 50, 6, 'xRupees per hour the treasury pays each teacher, doctor and guard'],
  pieceRate: [0, 20, 2, 'xRupees the treasury pays a citizen for every block they place on a public project'],
  foodSubsidy: [0, 100, 0, '% of the food price the treasury pays for citizens'],
};
const BASE_FOOD = 4, TICK_MS = 60e3, HOUR_TICKS = 1; // one economy tick = one in-game "hour"
const PRICE = (key) => { const k = String(key || ''); if (!k || k === 'air') return 0; if (/gold|diamond|emerald/.test(k)) return 12; if (/glass|brick|lamp|glow|quartz|iron/.test(k)) return 2; if (/stone|cobble|planks|log|wood|sand|dirt|grass|gravel|clay/.test(k)) return 1; return 2; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const pick = (l) => l[Math.floor(Math.random() * l.length)];
const r2 = (v) => Math.round(v * 100) / 100;

export function startNation(ctx) {
  const { world, pay, printMoney, balOf, TREASURY, account, CURRENCY, gov, chain, nationId, ai, addChat, notice, broadcast, askHost, humansOnline, logActivity, saveWorldSoon, planBuild, log = console.log } = ctx;
  const N = (world.nation ||= { name: ctx.NATION, founded: null, capital: null, citizens: {}, ministers: [], judge: null, projects: [], cases: [], news: [], sessions: [], protest: null, autonomy: true, economy: { baseSupply: null, foodPrice: BASE_FOOD }, nextId: 1, petitions: [] });
  for (const [k, [, , d]] of Object.entries(NATION_LAWS)) if (gov.laws[k] === undefined) gov.laws[k] = d;
  const nid = nationId(N.name);
  let busy = { founding: false, session: false, planning: false, court: false };
  const cits = () => Object.values(N.citizens);
  const law = (k) => clamp(+gov.laws[k] || 0, NATION_LAWS[k][0], NATION_LAWS[k][1]);
  function news(text, icon = '📰') { N.news.push({ t: Date.now(), text }); if (N.news.length > 60) N.news.shift(); addChat({ name: N.name, text: `${icon} ${text}`, kind: 'ai' }); push(); }
  const view = () => ({ name: N.name, founded: N.founded, capital: N.capital, autonomy: N.autonomy, treasury: balOf(TREASURY), currency: CURRENCY, laws: Object.fromEntries(Object.keys(NATION_LAWS).map((k) => [k, law(k)])),
    economy: { foodPrice: r2(N.economy.foodPrice), cpi: r2(N.economy.foodPrice / BASE_FOOD), supply: moneySupply(), unemployed: cits().filter((c) => CONSTRUCTION.has(c.occupation) && !c.job).length },
    citizens: cits().map((c) => ({ id: c.id, name: c.name, age: c.age, occupation: c.occupation, personality: c.personality, wants: c.wants, mood: r2(c.mood), trust: r2(c.trust), status: c.status, job: c.job, home: c.home, coins: balOf(c.id), grievances: c.grievances.slice(0, 3), eff: r2(efficiency(c)), look: c.look })),
    ministers: N.ministers.map((m) => ({ id: m.id, name: m.name, role: m.role, ideology: m.ideology, home: m.home, look: m.look })), judge: N.judge && { id: N.judge.id, name: N.judge.name, home: N.judge.home },
    projects: N.projects.slice(-8).map((p) => ({ id: p.id, name: p.name, purpose: p.purpose, status: p.status, site: p.site, total: p.blocks?.length || 0, done: p.done || 0, spent: p.spent || 0, budget: p.budget, workers: p.workers || [], note: p.note })),
    cases: N.cases.slice(-8), sessions: N.sessions.slice(-4), news: N.news.slice(-12), protest: N.protest, petitions: N.petitions.slice(-5), chain: chain.status });
  const push = () => broadcast({ t: 'nation', n: view() });
  function moneySupply() { let s = 0; for (const [id, a] of Object.entries(world.bank.accounts)) if (id !== TREASURY) s += a.balance; return s; }
  function efficiency(c) { const base = CONSTRUCTION.has(c.occupation) ? 1 : 0.45; return clamp((0.25 + c.mood * 0.9) * (0.6 + c.traits.diligence * 0.6) * base, 0.05, 1.3); }

  // ---------------------------------------------------------------- founding: the AI writes the people once
  async function found(by = 'someone') {
    if (N.founded || busy.founding) return { ok: false, msg: N.founded ? `${N.name} already exists.` : 'Already founding…' };
    busy.founding = true;
    try {
      const site = await askHost('found', { count: 16 }, 15000);
      if (!site.ok) return { ok: false, msg: site.msg || 'Nobody has the game open to find a spot for the capital.' };
      N.capital = site.data.capital;
      const r = await ai(`Found the nation of ${N.name}: a sunny coastal town in a voxel world (Edge City Goa vibes: builders, surfers, makers, AI researchers). Invent its first 16 CITIZENS, its CABINET of 4 ministers and a JUDGE. Make them feel like real, specific people with different needs, politics and tempers, so they will disagree.
Occupations to use (several builders/carpenters/masons/engineers, since public works need them): ${OCCUPATIONS.join(', ')}.
Reply with JSON only:
{"citizens":[{"name":"First Last","age":34,"occupation":"carpenter","personality":"one vivid sentence","backstory":"one sentence","wants":["2-3 concrete wants, e.g. a clinic nearby, lower taxes, a beach bar"],"politics":{"taxes":-1..1 (+1 = happy to pay taxes),"welfare":-1..1,"public_works":-1..1},"traits":{"diligence":0..1,"temper":0..1 (1 = quick to protest),"sociability":0..1},"catchphrase":"short","shirt":"#hex","hat":"#hex or null"}],
 "ministers":[{"name":"","role":"President|Finance Minister|Minister of Public Works|Minister of Welfare","ideology":"a few words","persona":"two sentences: style, priorities, a flaw","shirt":"#hex"}],
 "judge":{"name":"","persona":"two sentences"}}`, { effort: 'medium' });
      const j = r?.json || {};
      const homes = site.data.homes || [];
      const list = (Array.isArray(j.citizens) && j.citizens.length ? j.citizens : fallbackCitizens(16)).slice(0, 24);
      list.forEach((c, i) => addCitizen(c, homes[i % Math.max(1, homes.length)] || N.capital));
      const roles = ['President', 'Finance Minister', 'Minister of Public Works', 'Minister of Welfare'];
      N.ministers = roles.map((role, i) => { const m = (j.ministers || []).find((x) => x?.role === role) || (j.ministers || [])[i] || {}; return { id: 'min_' + i, role, name: String(m.name || ['Asha Kamat', 'Rui Fernandes', 'Dev Naik', 'Maya Pinto'][i]).slice(0, 30), ideology: String(m.ideology || ['pragmatic centrist', 'fiscal hawk', 'builder-in-chief', 'big-hearted populist'][i]).slice(0, 60), persona: String(m.persona || 'Earnest and opinionated.').slice(0, 300), look: { shirt: m.shirt || '#24304a', hat: '#111111' }, home: offset(N.capital, -3 + i * 2, 3) }; });
      N.judge = { id: 'judge', name: String(j.judge?.name || 'Justice Leela Rao').slice(0, 30), persona: String(j.judge?.persona || 'Calm, exacting, allergic to excuses; rules by the letter of the law but cares about fairness.').slice(0, 300), home: offset(N.capital, 0, -4) };
      for (const m of [...N.ministers, N.judge]) account(m.id, m.name);
      N.founded = Date.now(); N.economy.baseSupply = moneySupply() || 1;
      chain.record('decide', [nid, 'founding', `${N.name} founded by ${by}: ${cits().length} citizens, cabinet led by ${N.ministers[0].name}, judge ${N.judge.name}`]);
      news(`${N.name} is founded! ${cits().length} citizens move in around the capital. President ${N.ministers[0].name} leads a cabinet of ${N.ministers.length}; ${N.judge.name} runs the court. Talk to anyone with @Name.`, '🏛');
      logActivity(by, 'nation_found', { citizens: cits().length });
      saveWorldSoon();
      setTimeout(() => commission({ name: 'Town Hall', purpose: 'the seat of government: a cabinet chamber, a courtroom and a public square', description: `A handsome town hall for ${N.name}: stone and timber, a clock tower, a cabinet chamber, a courtroom and a small plaza in front. About 15x15, two storeys.`, budget: 6000, by: 'founding charter' }), 3000);
      return { ok: true, msg: `${N.name} founded with ${cits().length} citizens.` };
    } finally { busy.founding = false; }
  }
  function offset(p, dx, dz) { return { x: Math.round(p.x + dx), y: p.y, z: Math.round(p.z + dz) }; }
  function addCitizen(c, home) {
    const id = 'cit_' + Math.random().toString(36).slice(2, 8), occ = OCCUPATIONS.includes(c.occupation) ? c.occupation : pick(OCCUPATIONS);
    const t = c.traits || {}, p = c.politics || {};
    N.citizens[id] = { id, name: String(c.name || 'Citizen').slice(0, 30), age: clamp(+c.age || 30, 16, 90), occupation: occ, personality: String(c.personality || '').slice(0, 200), backstory: String(c.backstory || '').slice(0, 200),
      wants: (Array.isArray(c.wants) ? c.wants : []).slice(0, 3).map((w) => String(w).slice(0, 60)), catchphrase: String(c.catchphrase || '').slice(0, 60),
      politics: { taxes: clamp(+p.taxes || 0, -1, 1), welfare: clamp(+p.welfare || 0, -1, 1), public_works: clamp(+p.public_works || 0, -1, 1) },
      traits: { diligence: clamp(+t.diligence || 0.6, 0, 1), temper: clamp(+t.temper || 0.4, 0, 1), sociability: clamp(+t.sociability || 0.5, 0, 1) },
      look: { shirt: /^#[0-9a-f]{6}$/i.test(c.shirt) ? c.shirt : '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'), hat: /^#[0-9a-f]{6}$/i.test(c.hat || '') ? c.hat : null },
      home, needs: { food: 0.8, rest: 1 }, mood: 0.65, trust: 0.6, status: 'idle', job: null, grievances: [], unpaid: 0, earned: 0, lastIncome: 0, memory: [] };
    account(id, N.citizens[id].name);
    return N.citizens[id];
  }
  function fallbackCitizens(n) { // only if the AI is unavailable (MOCK mode, budget)
    const F = ['Aarav', 'Ines', 'Kabir', 'Leela', 'Rohan', 'Sofia', 'Tenzin', 'Zoya', 'Vikram', 'Anaya', 'Omar', 'Priya', 'Dev', 'Mira', 'Arjun', 'Noor'], L = ['Naik', 'Fernandes', 'Kamat', 'Pinto', "D'Souza", 'Gaonkar', 'Rao', 'Sharma'];
    return Array.from({ length: n }, (_, i) => ({ name: `${F[i % F.length]} ${pick(L)}`, age: 20 + Math.floor(Math.random() * 45), occupation: i < 6 ? ['builder', 'carpenter', 'mason', 'engineer', 'builder', 'carpenter'][i] : pick(OCCUPATIONS), personality: 'Practical, a bit stubborn, loves the sea.', wants: ['steady work', 'fair taxes'], politics: { taxes: Math.random() * 2 - 1, welfare: Math.random() * 2 - 1, public_works: Math.random() * 2 - 1 }, traits: { diligence: Math.random(), temper: Math.random(), sociability: Math.random() } }));
  }

  // ---------------------------------------------------------------- the economy: needs, wages, taxes, prices, moods
  function economyTick() {
    if (!N.founded) return;
    const supply = moneySupply(), base = N.economy.baseSupply || supply || 1;
    N.economy.foodPrice = BASE_FOOD * Math.pow(Math.max(0.2, supply / base), 0.7); // print money -> prices climb
    const tax = law('taxRate') / 100, sellers = cits().filter((c) => FOOD_SELLERS.has(c.occupation));
    for (const c of cits()) {
      c.needs.food = clamp(c.needs.food - 0.12, 0, 1);
      if (c.status === 'working') c.needs.rest = clamp(c.needs.rest - 0.05, 0, 1); else c.needs.rest = clamp(c.needs.rest + 0.1, 0, 1);
      // public servants are on the government payroll
      if (PUBLIC_SERVANTS.has(c.occupation)) wage(c, law('salary') * HOUR_TICKS, 'salary', tax);
      // food: bought from a farmer, fisher, cook or merchant (the treasury may subsidise it)
      if (c.needs.food < 0.6) {
        const price = Math.ceil(N.economy.foodPrice), sub = Math.floor((price * law('foodSubsidy')) / 100), seller = sellers.length ? pick(sellers.filter((s) => s !== c)) || TREASURY : TREASURY;
        const sellerId = seller === TREASURY ? TREASURY : seller.id;
        if (balOf(c.id) >= price - sub && (price - sub <= 0 || pay(c.id, sellerId, price - sub, 'food')) && (!sub || pay(TREASURY, sellerId, sub, 'food subsidy') || true)) c.needs.food = 1;
      }
      // mood: needs + money + how they feel about the government
      const income = c.lastIncome, fair = N.economy.foodPrice * 2.5; // take-home pay an hour that feels fair
      const money = clamp(0.2 + 0.5 * Math.min(1, income / fair) + Math.min(balOf(c.id), 300) / 1000, 0, 1);
      const pol = c.politics, building = N.projects.some((p) => p.status === 'building');
      const taxFit = 1 - Math.min(1, Math.abs(tax - (0.12 + 0.12 * pol.taxes)) * 4); // each citizen has a tax rate they think is fair (0-24%)
      const align = 0.25 + 0.4 * taxFit + 0.15 * (0.5 + 0.5 * pol.welfare * (law('ubi') > 0 ? 1 : -1)) + 0.2 * (0.5 + 0.5 * pol.public_works * (building ? 1 : -1));
      const grievances = [];
      if (c.needs.food < 0.3) grievances.push('hungry: food is too expensive');
      if (c.unpaid > 0) grievances.push(`owed ${c.unpaid} ${CURRENCY}s in unpaid wages`);
      if (CONSTRUCTION.has(c.occupation) && !c.job && !N.projects.some((p) => p.status === 'building')) grievances.push('no work for builders');
      if (c.job && law('pieceRate') === 0) grievances.push('working on public projects for nothing');
      if (PUBLIC_SERVANTS.has(c.occupation) && law('salary') === 0) grievances.push(`${c.occupation}s are not being paid`);
      if (tax > 0.25 && pol.taxes < 0) grievances.push(`taxes are too high (${Math.round(tax * 100)}%)`);
      if (N.economy.foodPrice > BASE_FOOD * 1.6) grievances.push('prices keep climbing');
      c.grievances = grievances;
      const trustTarget = clamp(align - grievances.length * 0.12 - (c.unpaid > 0 ? 0.2 : 0), 0, 1);
      c.trust = clamp(c.trust + (trustTarget - c.trust) * (0.12 + c.traits.temper * 0.15), 0, 1);
      const target = clamp(0.25 * c.needs.food + 0.1 * c.needs.rest + 0.25 * money + 0.4 * c.trust - 0.06 * grievances.length, 0, 1);
      c.mood = clamp(c.mood + (target - c.mood) * 0.2, 0, 1); // moods move slowly: a few in-game hours
      c.lastIncome = 0;
      // when it gets bad: stop working well, then strike, then protest
      const was = c.status;
      if (c.mood < 0.3 && c.traits.temper >= 0.35) c.status = 'protesting';
      else if (c.mood < 0.38 && c.job) c.status = 'striking';
      else if (c.status === 'protesting' || c.status === 'striking') { if (c.mood > 0.48) c.status = c.job ? 'working' : 'idle'; }
      else c.status = c.job ? 'working' : 'idle';
      if (was !== c.status && (c.status === 'protesting' || c.status === 'striking')) c.memory.push(`${new Date().toISOString().slice(11, 16)} went ${c.status === 'protesting' ? 'to protest' : 'on strike'}: ${grievances.join('; ') || 'fed up'}`);
    }
    checkProtest();
    push(); saveWorldSoon();
  }
  function wage(c, gross, memo, tax = law('taxRate') / 100) {
    gross = Math.floor(gross); if (!(gross > 0)) return true;
    const t = Math.floor(gross * tax);
    if (!pay(TREASURY, c.id, gross - t, memo)) { c.unpaid += gross - t; return false; }
    c.lastIncome += gross - t; c.earned += gross - t;
    if (c.unpaid > 0 && pay(TREASURY, c.id, c.unpaid, 'back pay')) { c.memory.push('got my back pay'); c.unpaid = 0; }
    return true;
  }
  function payUbiToCitizens() { const n = Math.floor(law('ubi')); if (!(n > 0) || !N.founded) return; for (const c of cits()) if (!pay(TREASURY, c.id, n, 'UBI')) break; else c.lastIncome += n; }

  // ---------------------------------------------------------------- protests
  async function checkProtest() {
    const angry = cits().filter((c) => c.status === 'protesting');
    if (N.protest && angry.length < 2) { news(`The protest at the town hall breaks up (${N.protest.size} marched).`, '🕊'); N.protest = null; return; }
    if (N.protest || angry.length < 3) { if (N.protest) N.protest.who = angry.map((c) => c.id); return; }
    const g = {}; for (const c of angry) for (const x of c.grievances) g[x] = (g[x] || 0) + 1;
    const top = Object.entries(g).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
    N.protest = { t: Date.now(), who: angry.map((c) => c.id), size: angry.length, grievances: top, slogans: top.map((x) => `${x.split(':')[0].toUpperCase()}! ✊`) };
    news(`PROTEST! ${angry.length} citizens march on the town hall: ${top.join('; ') || 'they have had enough'}.`, '📢');
    chain.record('decide', [nid, 'protest', `${angry.length} citizens protested: ${top.join('; ')}`]);
    const r = await ai(`Citizens of ${N.name} are protesting at the town hall. Their grievances: ${top.join('; ')}. Their personalities: ${angry.slice(0, 5).map((c) => `${c.name} (${c.occupation}): ${c.personality}`).join(' | ')}. Write 6 short, punchy protest chants or sign slogans (max 7 words each, funny but pointed, no slurs). JSON only: {"slogans":["..."]}`, { cheap: true });
    if (N.protest && Array.isArray(r?.json?.slogans)) { N.protest.slogans = r.json.slogans.slice(0, 6).map((s) => String(s).slice(0, 60)); push(); }
    if (N.autonomy) setTimeout(() => cabinetSession('a protest outside'), 20e3);
  }

  // ---------------------------------------------------------------- the cabinet: ministers debate, the President decides
  function briefing() {
    const cs = cits(), avg = (f) => r2(cs.reduce((s, c) => s + f(c), 0) / Math.max(1, cs.length));
    const g = {}; for (const c of cs) for (const x of c.grievances) g[x] = (g[x] || 0) + 1;
    const wants = {}; for (const c of cs) for (const w of c.wants) wants[w] = (wants[w] || 0) + 1;
    return `NATION ${N.name} — treasury ${balOf(TREASURY)} ${CURRENCY}s (on-chain, mock ERC20). Money in citizens' and players' hands: ${moneySupply()}. Food price ${r2(N.economy.foodPrice)} (base ${BASE_FOOD}; it rises when money is printed).
LAWS: ${Object.entries(NATION_LAWS).map(([k, [lo, hi, , what]]) => `${k}=${law(k)} (${lo}-${hi}: ${what})`).join('; ')}.
CITIZENS (${cs.length}): average mood ${avg((c) => c.mood)}, trust in government ${avg((c) => c.trust)}; ${cs.filter((c) => c.status === 'protesting').length} protesting, ${cs.filter((c) => c.status === 'striking').length} on strike, ${cs.filter((c) => CONSTRUCTION.has(c.occupation) && !c.job).length} builders without work. Unpaid wages owed: ${cs.reduce((s, c) => s + c.unpaid, 0)}.
TOP GRIEVANCES: ${Object.entries(g).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} (${v})`).join('; ') || 'none'}.
WHAT PEOPLE WANT: ${Object.entries(wants).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k).join('; ')}.
PROJECTS: ${N.projects.slice(-5).map((p) => `#${p.id} ${p.name} [${p.status}${p.blocks ? ` ${p.done || 0}/${p.blocks.length} blocks` : ''}, spent ${p.spent || 0}/${p.budget}]${p.note ? ' ' + p.note : ''}`).join('; ') || 'none'}.
RECENT NEWS: ${N.news.slice(-5).map((n) => n.text).join(' | ')}
PLAYER PETITIONS: ${N.petitions.filter((p) => !p.done).map((p) => `${p.by}: "${p.text}"`).join(' | ') || 'none'}.
COURT: ${N.cases.slice(-3).map((c) => `case #${c.id} ${c.plaintiff} v ${c.defendant}: ${c.verdict || 'pending'}`).join('; ') || 'quiet'}.`;
  }
  const PROPOSALS_DOC = `Proposal types (JSON objects): {"type":"law","law":"taxRate|ubi|salary|pieceRate|foodSubsidy","value":number,"why":"..."} · {"type":"print","amount":number,"why":"..."} (the central bank creates new money in the treasury: it raises prices) · {"type":"project","name":"...","purpose":"who it serves","description":"what to build, for the architect","budget":number} (citizens build it block by block; materials ~1-2 per block plus pieceRate wages per block; a house ~2000-4000, a hall ~10000-15000) · {"type":"fund","project":"<id or name>","amount":number} (raise a project's budget, e.g. when it ran over and stalled) · {"type":"bonus","amount":number,"why":"..."} (a one-off payment from the treasury to every citizen) · {"type":"respond","to":"protest|petition","text":"..."}`;
  async function cabinetSession(trigger = 'the regular weekly meeting') {
    if (!N.founded || busy.session || !N.ministers.length) return { ok: false, msg: busy.session ? 'The cabinet is already in session.' : 'No nation yet.' };
    if (Date.now() - (N.lastSession || 0) < 90e3) return { ok: false, msg: 'The cabinet met very recently.' };
    busy.session = true; N.lastSession = Date.now();
    try {
      const brief = briefing();
      broadcast({ t: 'cabinet', phase: 'open', trigger, ministers: N.ministers.map((m) => m.id) });
      news(`The cabinet meets (${trigger}).`, '🏛');
      const opinions = await Promise.all(N.ministers.slice(1).map(async (m) => {
        const r = await ai(`You are ${m.name}, ${m.role} of ${N.name} (${m.ideology}). ${m.persona}\nCabinet meeting, called because of: ${trigger}.\n${brief}\n${PROPOSALS_DOC}\nSpeak in character to the cabinet (max 45 words, concrete, you may disagree with colleagues) and make 1-2 proposals that fit your role. JSON only: {"speech":"...","proposals":[...]}`, { cheap: true });
        const j = r?.json || {}; return { m, speech: String(j.speech || '…').slice(0, 300), proposals: (Array.isArray(j.proposals) ? j.proposals : []).slice(0, 2) };
      }));
      for (const o of opinions) broadcast({ t: 'cabinet', phase: 'speech', id: o.m.id, name: o.m.name, role: o.m.role, text: o.speech });
      const P = N.ministers[0];
      const r = await ai(`You are ${P.name}, President of ${N.name} (${P.ideology}). ${P.persona}\nYou chair the cabinet meeting (called because of: ${trigger}).\n${brief}\nYour ministers said:\n${opinions.map((o) => `- ${o.m.name} (${o.m.role}): "${o.speech}" proposes ${JSON.stringify(o.proposals)}`).join('\n')}\n${PROPOSALS_DOC}\nDecide. You may adopt, change or reject proposals; keep the treasury solvent (it holds ${balOf(TREASURY)}); at most one new project. JSON only: {"speech":"what you tell the cabinet (max 45 words)","decisions":[...],"announcement":"what you tell the citizens (max 50 words)","minutes":"2 sentences for the record"}`, { cheap: true });
      const j = r?.json || {};
      broadcast({ t: 'cabinet', phase: 'speech', id: P.id, name: P.name, role: P.role, text: String(j.speech || 'Let us proceed.').slice(0, 300) });
      const done = [];
      for (const d of (Array.isArray(j.decisions) ? j.decisions : []).slice(0, 4)) { const msg = await enact(d, `${P.name}'s cabinet`); if (msg) done.push(msg); }
      for (const p of N.petitions) p.done = true;
      const minutes = String(j.minutes || done.join('; ') || 'No changes.').slice(0, 400);
      N.sessions.push({ t: Date.now(), trigger, speeches: [...opinions.map((o) => ({ name: o.m.name, role: o.m.role, text: o.speech })), { name: P.name, role: P.role, text: String(j.speech || '') }], decisions: done, announcement: String(j.announcement || '').slice(0, 400), minutes });
      if (N.sessions.length > 30) N.sessions.shift();
      chain.record('decide', [nid, 'cabinet', minutes]);
      news(`Cabinet decisions: ${done.join(' · ') || 'no changes'}. ${j.announcement ? `President ${P.name}: "${String(j.announcement).slice(0, 220)}"` : ''}`, '🏛');
      broadcast({ t: 'cabinet', phase: 'close' });
      logActivity(P.name, 'cabinet_session', { trigger, decisions: done });
      saveWorldSoon(); push();
      return { ok: true, msg: done.join('; ') || 'No changes.' };
    } catch (e) { log('[nation] cabinet session failed: ' + e.message); return { ok: false, msg: e.message }; }
    finally { busy.session = false; }
  }
  async function enact(d, by) {
    if (!d || typeof d !== 'object') return null;
    switch (d.type) {
      case 'law': { const k = String(d.law), L = NATION_LAWS[k]; if (!L) return null; const v = clamp(Math.round(+d.value), L[0], L[1]); if (!Number.isFinite(v) || v === law(k)) return null; gov.laws[k] = v; chain.record('enact', [nid, k, String(v), by, String(d.why || '').slice(0, 120)]); broadcast({ t: 'gov', gov }); return `${k} → ${v}`; }
      case 'print': { const n = clamp(Math.floor(+d.amount), 0, 200000); if (!n) return null; printMoney(n, `printed by ${by}: ${String(d.why || '').slice(0, 50)}`, by); return `printed ${n} ${CURRENCY}s`; }
      case 'bonus': { const n = clamp(Math.floor(+d.amount), 0, 500); if (!n || balOf(TREASURY) < n * cits().length) return null; for (const c of cits()) { pay(TREASURY, c.id, n, 'bonus'); c.lastIncome += n; c.trust = clamp(c.trust + 0.05, 0, 1); } return `bonus of ${n} to every citizen`; }
      case 'project': { if (N.projects.some((p) => p.status === 'planning')) return null; const res = await commission({ name: String(d.name || 'Public works').slice(0, 40), purpose: String(d.purpose || '').slice(0, 120), description: String(d.description || d.name || '').slice(0, 500), budget: clamp(Math.floor(+d.budget || 3000), 200, 50000), by }); return res.ok ? `commissioned ${d.name} (budget ${d.budget})` : null; }
      case 'fund': { // top up a project's budget (and restart it if the money had run out)
        const p = N.projects.find((x) => x.id === +d.project || x.name.toLowerCase() === String(d.project || '').toLowerCase()); const n = clamp(Math.floor(+d.amount), 0, 100000);
        if (!p || !n || p.status === 'done' || p.status === 'cancelled') return null;
        p.budget += n; if (p.status === 'stalled' && balOf(TREASURY) > 200) { p.status = 'building'; p.note = ''; rebalanceWorkers(); sendProject(p); }
        return `${p.name} budget +${n} (now ${p.budget})`;
      }
      case 'respond': { const t = String(d.text || '').slice(0, 200); if (t) news(`${by}: "${t}"`, '💬'); if (d.to === 'protest') for (const c of cits()) if (c.status === 'protesting') c.trust = clamp(c.trust + 0.03, 0, 1); return t ? 'responded publicly' : null; }
    }
    return null;
  }

  // ---------------------------------------------------------------- public works: planned by the architect AI, built by citizens
  async function commission({ name, purpose, description, budget, by }) {
    if (!N.founded) return { ok: false, msg: 'Found the nation first.' };
    const id = N.nextId++, k = N.projects.length;
    const ang = (k * 72 + 20) * Math.PI / 180, R = 20 + 6 * Math.floor(k / 5);
    const site = { x: Math.round(N.capital.x + Math.cos(ang) * R), y: N.capital.y, z: Math.round(N.capital.z + Math.sin(ang) * R) };
    const p = { id, name, purpose, description, budget, by, status: 'planning', site, t: Date.now(), spent: 0, done: 0, workers: [], note: 'the architect is drawing up plans' };
    N.projects.push(p); push();
    news(`${by} commissions "${name}" (${purpose || 'public works'}), budget ${budget} ${CURRENCY}s. The architect is drawing up plans…`, '📐');
    plan(p).catch((e) => { p.status = 'cancelled'; p.note = 'planning failed: ' + e.message; log('[nation] planning failed ' + e.message); push(); });
    return { ok: true, id };
  }
  async function plan(p) {
    busy.planning = true;
    try {
      // the architect (the Creator AI) designs it in a sandbox at the site; we keep the exact block list
      const out = await planBuild({ site: p.site, prompt: `Design "${p.name}" for the citizens of ${N.name}: ${p.description}. It is a PUBLIC BUILDING that citizen workers will build block by block, so: use only a "build" action (no creatures, items, effects or definitions of new blocks), place it at "pos" or "look" in front of you, keep it under about 2500 blocks, make it look great and inviting with a clear entrance.` });
      if (!out?.blocks?.length) throw new Error('the plan came back empty');
      p.blocks = out.blocks.sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]); // bottom up
      p.materials = p.blocks.reduce((s, b) => s + PRICE(b[3]), 0);
      p.estimate = p.materials + p.blocks.filter((b) => b[3] !== 'air').length * law('pieceRate');
      p.box = out.box; p.status = 'building'; p.note = '';
      if (p.estimate * 1.1 > p.budget && balOf(TREASURY) > p.estimate * 1.5) { news(`The plans for "${p.name}" cost more than budgeted: the budget is revised from ${p.budget} to ${Math.ceil(p.estimate * 1.1)} ${CURRENCY}s.`, '🧾'); p.budget = Math.ceil(p.estimate * 1.1); }
      p.chainId = N.chainProjects = (N.chainProjects || 0) + 1; chain.record('approveProject', [nid, p.name, BigInt(p.budget), Math.round(p.site.x), Math.round(p.site.y), Math.round(p.site.z)]);
      rebalanceWorkers();
      news(`Plans for "${p.name}" are ready: ${p.blocks.length} blocks, about ${p.estimate} ${CURRENCY}s (materials ${p.materials} + wages). ${p.workers.length} citizens head to the site.`, '🏗');
      sendProject(p); push(); saveWorldSoon();
    } finally { busy.planning = false; }
  }
  function rebalanceWorkers() { // builders, carpenters, masons and engineers share out the active projects (max 6 each); strikers keep their place
    const active = N.projects.filter((p) => p.status === 'building' && p.blocks);
    const pool = cits().filter((c) => CONSTRUCTION.has(c.occupation) && c.status !== 'protesting');
    const per = Math.min(6, Math.ceil(pool.length / Math.max(1, active.length))), want = new Map(active.map((p) => [p.id, []])), placed = new Set();
    for (const c of pool) if (c.job && want.has(c.job) && want.get(c.job).length < per) { want.get(c.job).push(c.id); placed.add(c.id); }
    for (const c of pool) { if (placed.has(c.id)) continue; const p = active.find((x) => want.get(x.id).length < per); if (p) { want.get(p.id).push(c.id); placed.add(c.id); } }
    for (const c of cits()) {
      const pid = [...want.entries()].find(([, l]) => l.includes(c.id))?.[0] ?? null;
      if (c.job !== pid) { c.job = pid; if (c.status === 'working' || c.status === 'idle') c.status = pid ? 'working' : 'idle'; }
    }
    for (const p of active) { const nw = want.get(p.id); if (nw.join() !== (p.workers || []).join()) { p.workers = nw; sendProject(p); } }
  }
  function sendProject(p) { askHost('project', { project: { id: p.id, name: p.name, site: p.site, from: p.done || 0, blocks: p.blocks, status: p.status, workers: p.workers.map((id) => ({ id, eff: r2(efficiency(N.citizens[id] || { mood: 0.5, traits: { diligence: 0.5 }, occupation: 'builder' })) })) } }, 8000).catch(() => {}); }
  function progress(m) { // the host placed blocks: pay for materials and wages, block by block
    const p = N.projects.find((x) => x.id === m.id); if (!p || p.status !== 'building' || !p.blocks) return;
    const sellers = cits().filter((c) => c.occupation === 'merchant' || c.occupation === 'mason');
    for (const [cid, n] of Object.entries(m.by || {})) {
      if (p.status !== 'building') break;
      const c = N.citizens[cid]; let placed = 0;
      for (let i = 0; i < Math.min(+n || 0, 200); i++) {
        const b = p.blocks[p.done]; if (!b) break;
        const mat = PRICE(b[3]), w = b[3] === 'air' ? Math.max(1, Math.floor(law('pieceRate') / 2)) : law('pieceRate');
        if (p.spent + mat + w > p.budget * 1.25 || balOf(TREASURY) < mat + w) { stall(p, balOf(TREASURY) < mat + w ? 'the treasury is empty' : 'it ran over budget'); break; }
        if (mat) pay(TREASURY, sellers.length ? pick(sellers).id : TREASURY, mat, `materials: ${p.name}`);
        if (c) wage(c, w, `building ${p.name}`); p.spent += mat + w; p.done++; placed++;
      }
      if (c && placed) { c.needs.rest = clamp(c.needs.rest - 0.002 * placed, 0, 1); }
    }
    if (p.done >= p.blocks.length) finish(p);
    else if (Date.now() - (p.lastPush || 0) > 5000) { p.lastPush = Date.now(); push(); }
  }
  function stall(p, why) {
    if (p.status === 'stalled') return;
    p.status = 'stalled'; p.note = `stalled: ${why}`;
    for (const id of p.workers) { const c = N.citizens[id]; if (c) { c.memory.push(`work on ${p.name} stopped: ${why}`); c.trust = clamp(c.trust - 0.08, 0, 1); } }
    askHost('projectStatus', { id: p.id, status: 'stalled' }, 5000).catch(() => {});
    if (p.chainId) chain.record('projectStatus', [BigInt(p.chainId), 'stalled: ' + why]);
    news(`Work on "${p.name}" has STOPPED: ${why}. ${p.workers.length} citizens are left idle.`, '⛔');
  }
  function resumeStalled() {
    for (const p of N.projects) if (p.status === 'stalled' && balOf(TREASURY) > 200 && p.spent < p.budget * 1.2) { p.status = 'building'; p.note = ''; rebalanceWorkers(); sendProject(p); news(`Work on "${p.name}" resumes.`, '🏗'); }
  }
  function finish(p) {
    p.status = 'done'; p.note = `finished, cost ${p.spent}`;
    for (const id of p.workers) { const c = N.citizens[id]; if (c) { c.job = null; c.status = 'idle'; c.memory.push(`helped finish ${p.name}`); } }
    const words = (p.name + ' ' + p.purpose).toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    for (const c of cits()) if (c.wants.some((w) => words.some((x) => w.toLowerCase().includes(x)))) { c.trust = clamp(c.trust + 0.12, 0, 1); c.memory.push(`${p.name} was built, like I wanted`); }
    p.workers = [];
    askHost('projectStatus', { id: p.id, status: 'done' }, 5000).catch(() => {});
    rebalanceWorkers();
    if (p.chainId) chain.record('projectStatus', [BigInt(p.chainId), `done, cost ${p.spent}`]);
    news(`"${p.name}" is finished! ${p.blocks.length} blocks, ${p.spent} ${CURRENCY}s spent.`, '🎉');
    saveWorldSoon(); push();
  }

  // ---------------------------------------------------------------- the court
  async function fileCase({ plaintiff, defendant, claim, by }) {
    if (!N.founded) return { ok: false, msg: 'There is no court until the nation is founded (/nation found).' };
    if (busy.court) return { ok: false, msg: 'The court is hearing another case; try again in a minute.' };
    const id = N.cases.length + 1, cs = { id, plaintiff, defendant, claim: String(claim).slice(0, 300), t: Date.now(), status: 'hearing' };
    N.cases.push(cs); push(); busy.court = true;
    news(`Case #${id}: ${plaintiff} v ${defendant}: "${cs.claim}". ${N.judge.name} is hearing it.`, '⚖️');
    chain.record('fileCase', [nid, plaintiff, defendant, cs.claim]);
    try {
      const facts = world.bank.log.filter((l) => [l.from, l.to, l.by].some((x) => x && (names(x) === plaintiff || names(x) === defendant))).slice(-12).map((l) => JSON.stringify(l)).join('\n');
      const r = await ai(`You are ${N.judge.name}, judge of ${N.name}. ${N.judge.persona}\nCASE #${id}: ${plaintiff} (plaintiff) v ${defendant} (defendant). Claim: "${cs.claim}".\nThe law: ${Object.entries(NATION_LAWS).map(([k, [, , , w]]) => `${k}=${law(k)} (${w})`).join('; ')}.\nRelevant ledger records:\n${facts || 'none'}\nState of the nation: ${briefing().slice(0, 1500)}\nRule fairly and briefly. Remedies: {"type":"compensation","from":"<defendant name or 'government'>","to":"<plaintiff name>","amount":number} · {"type":"strike_law","law":"<law key>"} (reset it to its default, if the law is unjust) · {"type":"none"}. JSON only: {"verdict":"for plaintiff|for defendant","reasoning":"max 40 words","remedy":{...}}`, {});
      const j = r?.json || {}; cs.verdict = String(j.verdict || 'dismissed').slice(0, 40); cs.reasoning = String(j.reasoning || '').slice(0, 300); cs.status = 'decided';
      cs.remedy = applyRemedy(j.remedy || {}, cs);
      chain.record('rule', [BigInt(id), cs.verdict, cs.remedy]);
      news(`Ruling in case #${id}: ${cs.verdict}. "${cs.reasoning}" ${cs.remedy !== 'none' ? `Remedy: ${cs.remedy}.` : ''}`, '⚖️');
      return { ok: true, msg: `${cs.verdict}: ${cs.reasoning}` };
    } finally { busy.court = false; saveWorldSoon(); push(); }
  }
  function names(id) { return world.bank.accounts[id]?.name || (id === TREASURY ? 'government' : id); }
  function idByName(nm) { // "Asha Kamat", "asha_kamat" or just "Asha"
    const s = String(nm || '').toLowerCase().replace(/_/g, ' ').trim(); if (['government', 'treasury', 'the government', 'gov'].includes(s)) return TREASURY;
    const ids = Object.keys(world.bank.accounts), nmOf = (id) => world.bank.accounts[id].name.toLowerCase();
    return ids.find((id) => nmOf(id) === s) || ids.find((id) => nmOf(id).startsWith(s + ' ')) || ids.find((id) => nmOf(id).startsWith(s)) || null;
  }
  function applyRemedy(rm, cs) {
    if (rm.type === 'compensation') {
      const from = idByName(rm.from), to = idByName(rm.to), n = Math.min(clamp(Math.floor(+rm.amount), 0, 5000), from ? balOf(from) : 0);
      if (from && to && n > 0 && pay(from, to, n, `court order #${cs.id}`)) { const c = N.citizens[to]; if (c) { c.unpaid = Math.max(0, c.unpaid - n); c.trust = clamp(c.trust + 0.1, 0, 1); } return `${rm.from} pays ${n} to ${rm.to}`; }
      return 'compensation ordered but could not be paid';
    }
    if (rm.type === 'strike_law' && NATION_LAWS[rm.law]) { gov.laws[rm.law] = NATION_LAWS[rm.law][2]; chain.record('enact', [nid, rm.law, String(gov.laws[rm.law]), `court, case #${cs.id}`, 'struck down']); broadcast({ t: 'gov', gov }); return `law ${rm.law} struck down (back to ${gov.laws[rm.law]})`; }
    return 'none';
  }
  function autoLawsuits() { // citizens owed real money take the government to court (rarely)
    if (busy.court || !N.founded) return;
    const c = cits().filter((x) => x.unpaid >= 30 && !x.sued).sort((a, b) => b.unpaid - a.unpaid)[0];
    if (c && Math.random() < 0.5) { c.sued = true; fileCase({ plaintiff: c.name, defendant: 'government', claim: `I am owed ${c.unpaid} ${CURRENCY}s in unpaid wages`, by: c.name }); }
  }

  // ---------------------------------------------------------------- clocks
  setInterval(() => { try { economyTick(); resumeStalled(); rebalanceWorkers(); } catch (e) { log('[nation] tick failed: ' + e.message); } }, TICK_MS).unref();
  setInterval(payUbiToCitizens, 5 * 60e3).unref();
  setInterval(() => { if (N.founded && N.autonomy && humansOnline() && Date.now() - (N.lastSession || 0) > Number(process.env.CABINET_MINUTES || 8) * 60e3) cabinetSession(); autoLawsuits(); }, 30e3).unref();

  return {
    view, push, found, cabinetSession, commission, fileCase, progress,
    get state() { return N; },
    hostJoined() { if (!N.founded) return; for (const p of N.projects) if (p.status === 'building' && p.blocks) sendProject(p); },
    petition(by, text) { const t = String(text || '').trim().slice(0, 200); if (!t) return { ok: false, msg: 'Usage: /petition <what you want the government to do>' }; N.petitions.push({ by, text: t, t: Date.now() }); if (N.petitions.length > 20) N.petitions.shift(); news(`${by} petitions the cabinet: "${t}"`, '✉️'); if (N.autonomy) setTimeout(() => cabinetSession(`a petition from ${by}`), 5000); return { ok: true, msg: 'Petition delivered: the cabinet will discuss it.' }; },
    setAutonomy(on) { N.autonomy = !!on; push(); return { ok: true, msg: `The cabinet ${on ? 'governs on its own again (meets every few minutes while people are online)' : 'is paused (it only meets when called with /nation meet)'}.` }; },
    citizenState(id) { const c = N.citizens[id]; return c && { mood: c.mood, status: c.status, grievances: c.grievances, coins: balOf(c.id), job: c.job, unpaid: c.unpaid, memory: c.memory.slice(-5) }; },
  };
}
