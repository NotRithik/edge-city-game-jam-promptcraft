// The nation of Edge Goa: citizens with their own personalities, wallets, moods and daily routines; a city that notices
// what goes wrong in their lives; and residents (players and their AI agents) who govern it by grading proposals A-F.
// No AI runs the government. The loop:
//   SENSE   the host walks every citizen through their routine on real paths and reports each trip (detours, water,
//           darkness, half-built eyesores, monsters); the server watches prices, hunger, wages, projects and services.
//   ISSUES  observations are merged into issues (one per problem and place) with a severity, the people affected, their
//           own words, numbers, and photos when a camera is available.
//   PROPOSE anyone can propose fixes from a catalogue that the game knows how to carry out; the civil service drafts the
//           obvious ones itself. The game prices each proposal and predicts what it will change.
//   DECIDE  residents grade proposals A-F (majority judgment: the median grade wins). Small fixes from the civil service
//           or a minister pass by consent unless a majority objects; everything else needs a majority grade of C or
//           better. Citizens grade every proposal too, from what it does for them: if most of them would reject it, it
//           needs a B from the residents to pass.
//   ACT     passed proposals are carried out: laws change, payments go out, citizens build paths, lamps and buildings.
//   VERIFY  the issue is measured again; each proposal records whether it worked.
// Money is xRupees (a MOCK ERC20 held on-chain, see chain.js); everything goes through pay().
import { design, kindOf, zoneOf, KINDS } from './buildings.js';

const OCCUPATIONS = ['builder', 'carpenter', 'mason', 'engineer', 'farmer', 'fisher', 'cook', 'merchant', 'teacher', 'doctor', 'guard', 'artist'];
const CONSTRUCTION = new Set(['builder', 'carpenter', 'mason', 'engineer']);
const FOOD_SELLERS = new Set(['farmer', 'fisher', 'cook', 'merchant']);
const PUBLIC_SERVANTS = new Set(['teacher', 'doctor', 'guard']);
export const NATION_LAWS = { // law -> [min, max, default, what it means]
  taxRate: [0, 50, 10, '% of every wage, salary and player payment that goes to the treasury'],
  ubi: [0, 100, 0, 'xRupees paid from the treasury to every citizen and online player every 5 minutes'],
  salary: [0, 50, 6, 'xRupees per hour the treasury pays each teacher, doctor and guard'],
  pieceRate: [0, 20, 2, 'xRupees the treasury pays a citizen for every block they place on a public project'],
  foodSubsidy: [0, 100, 0, '% of the food price the treasury pays for citizens'],
};
const BASE_FOOD = 4, TICK_MS = 60e3; // one economy tick = one in-game "hour"
const PRICE = (key) => { const k = String(key || ''); if (!k || k === 'air') return 0; if (/gold|diamond|emerald/.test(k)) return 12; if (/glass|brick|lamp|glow|quartz|iron/.test(k)) return 2; if (/stone|cobble|planks|log|wood|sand|dirt|grass|gravel|clay/.test(k)) return 1; return 2; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const pick = (l) => l[Math.floor(Math.random() * l.length)];
const r2 = (v) => Math.round(v * 100) / 100;
const median = (l) => { const s = [...l].sort((a, b) => a - b); return s.length ? s[(s.length - 1) >> 1] : 0; };
// The capital grows on a street grid around the Hall of Government (plot D4): PLOT×PLOT lots with STREET-wide streets between.
const CITY = { PLOT: 24, STREET: 5, MAXR: 3 };
const ZONES = { civic: 'public buildings: clinic, school, library', market: 'markets, kitchens, shops', homes: 'houses', park: 'parks and squares', works: 'docks, workshops, warehouses' };
const plotName = (i, j) => String.fromCharCode(68 + i) + (4 + j); // columns A-G west→east, rows 1-7 north→south; D4 = the Hall
const DEFAULT_STYLE = 'whitewashed walls on stone-brick bases, red roofs, dark timber posts, blue trim and glass windows: an old Goan town by the sea';
// Grades: majority judgment on six grades. Scores 5..0.
const GRADES = ['F', 'E', 'D', 'C', 'B', 'A'], GRADE_WORDS = { A: 'excellent', B: 'very good', C: 'good', D: 'acceptable', E: 'poor', F: 'reject' };
const gradeOf = (s) => GRADES[clamp(Math.round(s), 0, 5)], scoreOf = (g) => GRADES.indexOf(String(g || '').toUpperCase());
const VOTE_MIN = Number(process.env.VOTE_MINUTES || 20), CONSENT_MIN = Number(process.env.CONSENT_MINUTES || 8); // agents may only check in now and then
// Citizens' days. Agents can propose new routines; the host walks them and reports every trip.
const GO = ['home', 'work', 'market', 'park', 'civic', 'works', 'hall', 'beach', 'wander'], DO = ['work', 'eat', 'sell', 'relax', 'sleep', 'socialize', 'shop'];
const SENSORS = ['commute', 'dark', 'eyesore', 'danger', 'price', 'green'];
const DAY = (...s) => s.map(([at, go, d]) => ({ at, go, do: d }));
const BEHAVIORS = {
  default: { day: DAY([7, 'work', 'work'], [12, 'market', 'eat'], [13, 'work', 'work'], [17, 'park', 'relax'], [19, 'market', 'shop'], [21, 'home', 'sleep']), notice: SENSORS },
  fisher: { day: DAY([5, 'works', 'work'], [10, 'market', 'sell'], [14, 'home', 'relax'], [17, 'park', 'socialize'], [21, 'home', 'sleep']), notice: SENSORS },
  farmer: { day: DAY([6, 'home', 'work'], [11, 'market', 'sell'], [13, 'home', 'work'], [18, 'park', 'socialize'], [21, 'home', 'sleep']), notice: SENSORS },
  cook: { day: DAY([7, 'market', 'work'], [15, 'home', 'relax'], [17, 'market', 'sell'], [22, 'home', 'sleep']), notice: SENSORS },
  merchant: { day: DAY([8, 'market', 'sell'], [13, 'market', 'eat'], [14, 'market', 'sell'], [19, 'park', 'socialize'], [22, 'home', 'sleep']), notice: SENSORS },
  teacher: { day: DAY([8, 'civic', 'work'], [13, 'market', 'eat'], [14, 'civic', 'work'], [17, 'park', 'relax'], [21, 'home', 'sleep']), notice: SENSORS },
  doctor: { day: DAY([7, 'civic', 'work'], [13, 'market', 'eat'], [14, 'civic', 'work'], [20, 'home', 'relax'], [22, 'home', 'sleep']), notice: SENSORS },
  guard: { day: DAY([9, 'hall', 'work'], [13, 'market', 'eat'], [14, 'wander', 'work'], [20, 'hall', 'work'], [1, 'home', 'sleep']), notice: SENSORS },
  artist: { day: DAY([9, 'park', 'work'], [13, 'market', 'eat'], [15, 'wander', 'socialize'], [20, 'park', 'relax'], [23, 'home', 'sleep']), notice: SENSORS },
};
const FIRST = ['Aarav', 'Ines', 'Kabir', 'Leela', 'Rohan', 'Sofia', 'Tenzin', 'Zoya', 'Vikram', 'Anaya', 'Omar', 'Priya', 'Dev', 'Mira', 'Arjun', 'Noor', 'Rui', 'Asha', 'Joaquim', 'Tara', 'Sameer', 'Lina', 'Neel', 'Clara'];
const LAST = ['Naik', 'Fernandes', 'Kamat', 'Pinto', "D'Souza", 'Gaonkar', 'Desai', 'Borges', 'Costa', 'Rebelo', 'Dias', 'Almeida', 'Menezes', 'Lobo', 'Colaco', 'Parab', 'Shetye', 'Sardesai'];
const NATURE = ['quiet and stubborn', 'loud and generous', 'anxious about money', 'endlessly curious', 'proud of the old town', 'a born organiser', 'sceptical of the government', 'cheerful, gossips a lot', 'hardworking, hates waste', 'dreamy, loves the sea'];
const WANTS = { builder: ['steady building work', 'fair pay per block'], carpenter: ['steady building work', 'a timber workshop'], mason: ['steady building work', 'good stone streets'], engineer: ['a proper harbour', 'well-lit streets'],
  farmer: ['a covered market to sell in', 'a road to the fields'], fisher: ['a dock for the boats', 'a fish market'], cook: ['a community kitchen', 'cheap ingredients'], merchant: ['a market hall', 'low taxes'],
  teacher: ['a school', 'a library'], doctor: ['a clinic', 'clean water'], guard: ['lamps on every street', 'a safe town at night'], artist: ['a park to paint in', 'a public square'] };
const GENERAL = ['cheaper food', 'a park nearby', 'paved streets', 'lower taxes', 'more public works', 'a beach promenade', 'a place to meet friends'];

export function startNation(ctx) {
  const { world, pay, printMoney, balOf, TREASURY, account, CURRENCY, gov, chain, nationId, addChat, broadcast, askHost, humansOnline, logActivity, saveWorldSoon,
    photograph = null, photoB64 = () => null, notifyAgent = () => {}, notifyHumans = () => {}, agents = () => [], log = console.log } = ctx;
  const N = (world.nation ||= { name: ctx.NATION, founded: null, capital: null, citizens: {}, ministers: [], projects: [], news: [], protest: null, autonomy: true, economy: { foodPrice: BASE_FOOD }, nextId: 1 });
  for (const [k, [, , d]] of Object.entries(NATION_LAWS)) if (gov.laws[k] === undefined) gov.laws[k] = d;
  // v1 worlds had AI ministers, a judge and a cabinet; v2 is governed by residents. Keep only elected agents.
  N.ministers = (N.ministers || []).filter((m) => m.agentId); delete N.judge; delete N.retired; delete N.directives; delete N.courtOpen; delete N.meeting;
  N.issues ||= []; N.proposals ||= []; N.trips ||= []; N.behaviors ||= {}; N.standing ||= {}; N.delegates ||= {}; N.nextIssue ||= 1; N.nextProposal ||= 1; N.petitions ||= []; N.resets ||= {}; N.failedFixes ||= {};
  for (const c of Object.values(N.citizens)) { c.feel ||= 0; c.trips ||= []; c.incomeAvg ||= 0; c.memory ||= []; c.grievances ||= []; }
  const nid = nationId(N.name);
  const busy = { founding: false, inspect: false, audit: false };
  const cits = () => Object.values(N.citizens);
  const law = (k) => clamp(+gov.laws[k] || 0, NATION_LAWS[k][0], NATION_LAWS[k][1]);
  function news(text, icon = '📰') { N.news.push({ t: Date.now(), text }); if (N.news.length > 60) N.news.shift(); addChat({ name: N.name, text: `${icon} ${text}`, kind: 'ai' }); push(); }
  const behaviorOf = (occ) => N.behaviors[occ] || (BEHAVIORS[occ] ? { ...BEHAVIORS[occ], version: 0, by: 'the founding charter' } : { ...BEHAVIORS.default, version: 0, by: 'the founding charter' });
  const view = () => ({ name: N.name, founded: N.founded, capital: N.capital, autonomy: N.autonomy, treasury: balOf(TREASURY), currency: CURRENCY, laws: Object.fromEntries(Object.keys(NATION_LAWS).map((k) => [k, law(k)])),
    economy: { foodPrice: r2(N.economy.foodPrice), cpi: r2(N.economy.foodPrice / BASE_FOOD), supply: moneySupply(), unemployed: cits().filter((c) => CONSTRUCTION.has(c.occupation) && !c.job).length }, kpi: kpi(),
    citizens: cits().map((c) => ({ id: c.id, name: c.name, age: c.age, occupation: c.occupation, personality: c.personality, wants: c.wants, mood: r2(c.mood), trust: r2(c.trust), status: c.status, job: c.job, home: c.home, coins: balOf(c.id), grievances: c.grievances.slice(0, 3), eff: r2(efficiency(c)), look: c.look, trips: (c.trips || []).slice(-3) })),
    ministers: N.ministers.map((m) => ({ id: m.id, name: m.name, role: m.role, ideology: m.ideology, agent: true })),
    vision: N.vision || null, hall: N.hall || null,
    projects: N.projects.slice(-8).map((p) => ({ id: p.id, name: p.name, purpose: p.purpose, status: p.status, site: p.site, plot: p.plot || null, zone: p.zone || null, kind: p.kind || 'building', total: p.blocks?.length || 0, done: p.done || 0, spent: p.spent || 0, budget: p.budget, workers: p.workers || [], note: p.note, proposal: p.proposal || null })),
    issues: issueList(), proposals: N.proposals.slice(-12).map(proposalView), behaviors: { ...Object.fromEntries(Object.keys(BEHAVIORS).map((k) => [k, behaviorOf(k)])) }, places: places(),
    sessions: (N.sessions || []).slice(-4), news: N.news.slice(-12), protest: N.protest, chain: chain.status, city: cityView() });
  let pushT = null; const push = () => { if (pushT) return; pushT = setTimeout(() => { pushT = null; broadcast({ t: 'nation', n: view() }); }, 400); };
  function moneySupply() { let s = 0; for (const [id, a] of Object.entries(world.bank.accounts)) if (id !== TREASURY) s += a.balance; return s; }
  const totalMoney = () => moneySupply() + balOf(TREASURY);
  function efficiency(c) { const base = CONSTRUCTION.has(c.occupation) ? 1 : 0.45; return clamp((0.25 + c.mood * 0.9) * (0.6 + c.traits.diligence * 0.6) * base, 0.05, 1.3); }
  const pay_ = (c) => c.incomeAvg || 0;
  function kpi() {
    const cs = cits(), avg = (f) => r2(cs.reduce((s, c) => s + f(c), 0) / Math.max(1, cs.length)), med = median(cs.map(pay_).filter((x) => x > 0));
    return { mood: avg((c) => c.mood), trust: avg((c) => c.trust), foodPrice: r2(N.economy.foodPrice), cpi: r2(N.economy.foodPrice / BASE_FOOD), mealHours: med ? r2(N.economy.foodPrice / med) : null,
      unpaid: cs.reduce((s, c) => s + c.unpaid, 0), stalled: N.projects.filter((p) => p.status === 'stalled').length, protesting: cs.filter((c) => c.status === 'protesting').length, striking: cs.filter((c) => c.status === 'striking').length,
      issuesOpen: N.issues.filter((i) => i.status !== 'resolved').length, resolved: N.issues.filter((i) => i.status === 'resolved').length, worked: N.proposals.filter((p) => p.outcome?.worked).length, trips: N.trips.length };
  }

  // ---------------------------------------------------------------- founding: the people are drawn from the town's own mix
  async function found(by = 'someone') {
    if (N.founded || busy.founding) return { ok: false, msg: N.founded ? `${N.name} already exists.` : 'Already founding…' };
    busy.founding = true;
    try {
      const site = await askHost('found', { count: 16 }, 15000);
      if (!site.ok) return { ok: false, msg: site.msg || 'Nobody has the game open to find a spot for the capital.' };
      N.capital = site.data.capital;
      const homes = site.data.homes || [], used = new Set();
      const occs = ['builder', 'carpenter', 'mason', 'engineer', 'builder', 'carpenter', 'fisher', 'farmer', 'cook', 'merchant', 'teacher', 'doctor', 'guard', 'artist', 'fisher', 'mason'];
      occs.forEach((occupation, i) => {
        let name; do name = `${pick(FIRST)} ${pick(LAST)}`; while (used.has(name)); used.add(name);
        const nature = pick(NATURE), w = [...WANTS[occupation], pick(GENERAL)];
        addCitizen({ name, age: 19 + Math.floor(Math.random() * 50), occupation, personality: `A ${occupation}, ${nature}.`, wants: w.slice(0, 3),
          politics: { taxes: Math.random() * 2 - 1, welfare: Math.random() * 2 - 1, public_works: Math.random() * 1.6 - 0.6 }, traits: { diligence: 0.4 + Math.random() * 0.6, temper: Math.random(), sociability: Math.random() } }, homes[i % Math.max(1, homes.length)] || N.capital);
      });
      N.founded = Date.now(); N.economy.baseTotal = totalMoney() || 1;
      chain.record('decide', [nid, 'founding', `${N.name} founded by ${by}: ${cits().length} citizens, governed by its residents`]);
      news(`${N.name} is founded! ${cits().length} citizens move in around the capital. It has no government of its own: players and their AI agents run it, by grading proposals A to F. Open the 🏛 panel (J) to see what the city needs.`, '🏛');
      logActivity(by, 'nation_found', { citizens: cits().length });
      saveWorldSoon(); buildHall();
      setTimeout(async () => { await planCity().catch((e) => log('[nation] city plan failed: ' + e.message)); commission({ kind: 'market', name: 'Market Hall', purpose: 'a covered market for traders, farmers and fisherfolk', by: 'the founding charter' }); }, 3000);
      return { ok: true, msg: `${N.name} founded with ${cits().length} citizens.` };
    } finally { busy.founding = false; }
  }
  function offset(p, dx, dz) { return { x: Math.round(p.x + dx), y: p.y, z: Math.round(p.z + dz) }; }
  function addCitizen(c, home) {
    const id = 'cit_' + Math.random().toString(36).slice(2, 8), occ = OCCUPATIONS.includes(c.occupation) ? c.occupation : pick(OCCUPATIONS);
    const t = c.traits || {}, p = c.politics || {};
    N.citizens[id] = { id, name: String(c.name || 'Citizen').slice(0, 30), age: clamp(+c.age || 30, 16, 90), occupation: occ, personality: String(c.personality || '').slice(0, 200),
      wants: (Array.isArray(c.wants) ? c.wants : []).slice(0, 3).map((w) => String(w).slice(0, 60)),
      politics: { taxes: clamp(+p.taxes || 0, -1, 1), welfare: clamp(+p.welfare || 0, -1, 1), public_works: clamp(+p.public_works || 0, -1, 1) },
      traits: { diligence: clamp(+t.diligence || 0.6, 0, 1), temper: clamp(+t.temper || 0.4, 0, 1), sociability: clamp(+t.sociability || 0.5, 0, 1) },
      look: { shirt: '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'), hat: Math.random() < 0.4 ? '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0') : null },
      home, needs: { food: 0.8, rest: 1 }, mood: 0.65, trust: 0.6, status: 'idle', job: null, grievances: [], unpaid: 0, earned: 0, lastIncome: 0, incomeAvg: 0, memory: [], trips: [], feel: 0 };
    account(id, N.citizens[id].name);
    return N.citizens[id];
  }

  // ---------------------------------------------------------------- the economy: needs, wages, taxes, prices, moods
  function economyTick() {
    if (!N.founded) return;
    // prices: the stock of money (printing raises it; spending only moves it) and how much food is being sold
    N.economy.baseTotal ||= totalMoney() || 1;
    const sellers = cits().filter((c) => FOOD_SELLERS.has(c.occupation)), selling = sellers.filter((c) => c.status !== 'striking' && c.status !== 'protesting');
    const scarcity = Math.sqrt(clamp(cits().length / Math.max(1, selling.length * 4), 0.7, 2.5));
    N.economy.foodPrice = BASE_FOOD * Math.pow(Math.max(0.3, totalMoney() / N.economy.baseTotal), 0.7) * scarcity;
    const tax = law('taxRate') / 100;
    for (const c of cits()) {
      c.needs.food = clamp(c.needs.food - 0.12, 0, 1);
      if (c.status === 'working') c.needs.rest = clamp(c.needs.rest - 0.05, 0, 1); else c.needs.rest = clamp(c.needs.rest + 0.1, 0, 1);
      if (PUBLIC_SERVANTS.has(c.occupation)) wage(c, law('salary'), 'salary', tax);
      if (c.needs.food < 0.6) { // food is bought from someone who is selling today (the treasury may subsidise it)
        const price = Math.ceil(N.economy.foodPrice), sub = Math.floor((price * law('foodSubsidy')) / 100), seller = pick(selling.filter((s) => s !== c)), sellerId = seller ? seller.id : TREASURY;
        if (balOf(c.id) >= price - sub && (price - sub <= 0 || pay(c.id, sellerId, price - sub, 'food')) && (!sub || pay(TREASURY, sellerId, sub, 'food subsidy') || true)) { c.needs.food = 1; if (seller) seller.lastIncome += price; }
      }
      c.incomeAvg = r2((c.incomeAvg || 0) * 0.7 + c.lastIncome * 0.3);
      const income = c.lastIncome, fair = N.economy.foodPrice * 2.5;
      const money = clamp(0.2 + 0.5 * Math.min(1, income / fair) + Math.min(balOf(c.id), 300) / 1000, 0, 1);
      const pol = c.politics, building = N.projects.some((p) => p.status === 'building');
      const taxFit = 1 - Math.min(1, Math.abs(tax - (0.12 + 0.12 * pol.taxes)) * 4);
      const align = 0.25 + 0.4 * taxFit + 0.15 * (0.5 + 0.5 * pol.welfare * (law('ubi') > 0 ? 1 : -1)) + 0.2 * (0.5 + 0.5 * pol.public_works * (building ? 1 : -1));
      const grievances = [];
      if (c.needs.food < 0.3) grievances.push('hungry: food is too expensive');
      if (c.unpaid > 0) grievances.push(`owed ${c.unpaid} ${CURRENCY}s in unpaid wages`);
      if (CONSTRUCTION.has(c.occupation) && !c.job && !N.projects.some((p) => p.status === 'building')) grievances.push('no work for builders');
      if (c.job && law('pieceRate') === 0) grievances.push('working on public projects for nothing');
      if (PUBLIC_SERVANTS.has(c.occupation) && law('salary') === 0) grievances.push(`${c.occupation}s are not being paid`);
      if (tax > 0.25 && pol.taxes < 0) grievances.push(`taxes are too high (${Math.round(tax * 100)}%)`);
      if (N.economy.foodPrice > BASE_FOOD * 1.6) grievances.push('prices keep climbing');
      for (const tr of (c.trips || []).filter((x) => Date.now() - x.t < 30 * 60e3).slice(-4)) { const g = tripGrievance(tr); if (g && !grievances.includes(g)) grievances.push(g); }
      c.grievances = grievances.slice(0, 6);
      const trustTarget = clamp(align - grievances.length * 0.1 - (c.unpaid > 0 ? 0.2 : 0), 0, 1);
      c.trust = clamp(c.trust + (trustTarget - c.trust) * (0.12 + c.traits.temper * 0.15), 0, 1);
      const target = clamp(0.25 * c.needs.food + 0.1 * c.needs.rest + 0.25 * money + 0.4 * c.trust - 0.05 * grievances.length + c.feel, 0, 1);
      c.mood = clamp(c.mood + (target - c.mood) * 0.2, 0, 1); c.feel *= 0.5; c.lastIncome = 0;
      const was = c.status;
      if (c.mood < 0.3 && c.traits.temper >= 0.35) c.status = 'protesting';
      else if (c.mood < 0.38 && c.job) c.status = 'striking';
      else if (c.status === 'protesting' || c.status === 'striking') { if (c.mood > 0.48) c.status = c.job ? 'working' : 'idle'; }
      else c.status = c.job ? 'working' : 'idle';
      if (was !== c.status && (c.status === 'protesting' || c.status === 'striking')) remember(c, `went ${c.status === 'protesting' ? 'to protest' : 'on strike'}: ${grievances.join('; ') || 'fed up'}`);
    }
    checkProtest();
    push(); saveWorldSoon();
  }
  function remember(c, text) { c.memory.push(`${new Date().toISOString().slice(11, 16)} ${text}`); if (c.memory.length > 20) c.memory.shift(); }
  function wage(c, gross, memo, tax = law('taxRate') / 100) {
    gross = Math.floor(gross); if (!(gross > 0)) return true;
    const t = Math.floor(gross * tax);
    if (!pay(TREASURY, c.id, gross - t, memo)) { c.unpaid += gross - t; return false; }
    c.lastIncome += gross - t; c.earned += gross - t;
    if (c.unpaid > 0 && pay(TREASURY, c.id, c.unpaid, 'back pay')) { remember(c, 'got my back pay'); c.unpaid = 0; }
    return true;
  }
  function payUbiToCitizens() { const n = Math.floor(law('ubi')); if (!(n > 0) || !N.founded) return; for (const c of cits()) if (!pay(TREASURY, c.id, n, 'UBI')) break; else c.lastIncome += n; }
  function checkProtest() {
    const angry = cits().filter((c) => c.status === 'protesting');
    if (N.protest && angry.length < 2) { news(`The protest at the town hall breaks up (${N.protest.size} marched).`, '🕊'); N.protest = null; return; }
    if (N.protest || angry.length < 3) { if (N.protest) N.protest.who = angry.map((c) => c.id); return; }
    const g = {}; for (const c of angry) for (const x of c.grievances) g[x] = (g[x] || 0) + 1;
    const top = Object.entries(g).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
    N.protest = { t: Date.now(), who: angry.map((c) => c.id), size: angry.length, grievances: top, slogans: [...top.map((x) => `${x.split(':')[0].toUpperCase()}! ✊`), 'WE LIVE HERE TOO!', 'FIX IT NOW!'] };
    news(`PROTEST! ${angry.length} citizens march on the town hall: ${top.join('; ') || 'they have had enough'}.`, '📢');
    chain.record('decide', [nid, 'protest', `${angry.length} citizens protested: ${top.join('; ')}`]);
  }

  // ---------------------------------------------------------------- what citizens live through: trips reported by the host
  // A trip is one leg of a citizen's day, walked on the real terrain: {cit, dest, do, from, to, len, straight, climb, swim, dark, unpaved, eyesores, danger, secs, stuck, night, path}
  const n0 = (v, hi = 1e5) => clamp(Math.round(+v || 0), 0, hi);
  function trip(m) {
    const c = N.citizens[m.cit]; if (!c || !N.founded) return;
    const pt = (p) => (p && Number.isFinite(+p.x) && Number.isFinite(+p.z) ? { x: Math.round(+p.x), z: Math.round(+p.z), ...(Number.isFinite(+p.y) ? { y: Math.round(+p.y) } : {}) } : null);
    const tr = { t: Date.now(), cit: c.id, dest: String(m.dest || '?').slice(0, 20), do: DO.includes(m.do) ? m.do : 'go', from: pt(m.from), to: pt(m.to), len: n0(m.len, 2000), straight: n0(m.straight, 2000), climb: n0(m.climb, 500), swim: n0(m.swim, 500), dark: n0(m.dark, 2000), unpaved: n0(m.unpaved, 2000),
      eyesores: (Array.isArray(m.eyesores) ? m.eyesores : []).map(Number).filter((x) => N.projects.some((p) => p.id === x)).slice(0, 4), danger: n0(m.danger, 50), secs: n0(m.secs, 3600), stuck: !!m.stuck, night: !!m.night,
      path: (Array.isArray(m.path) ? m.path : []).slice(0, 24).map((p) => [Math.round(+p[0]), Math.round(+p[1])]).filter((p) => p.every(Number.isFinite)) };
    if (!tr.from || !tr.to) return;
    tr.where = destName(tr);
    c.trips = [...(c.trips || []).slice(-5), { t: tr.t, dest: tr.dest, where: tr.where, len: tr.len, straight: tr.straight, swim: tr.swim, dark: tr.dark, stuck: tr.stuck, danger: tr.danger, night: tr.night, eyesores: tr.eyesores, do: tr.do }];
    N.trips.push(tr); if (N.trips.length > 400) N.trips.splice(0, N.trips.length - 400);
    // how it felt: long detours, getting wet, dark streets and monsters wear people down; a park or a good market lifts them
    const ratio = tr.straight > 8 ? tr.len / tr.straight : 1;
    c.feel = clamp(c.feel - (ratio > 1.7 ? 0.03 : 0) - (tr.swim > 2 ? 0.03 : 0) - (tr.stuck ? 0.04 : 0) - (tr.night && tr.dark > tr.len / 2 ? 0.02 : 0) - (tr.danger ? 0.04 : 0) - tr.eyesores.length * 0.01 + (tr.do === 'relax' && /park/.test(tr.where) ? 0.03 : 0), -0.2, 0.1);
  }
  function tripGrievance(tr) {
    const r = tr.straight > 8 ? tr.len / tr.straight : 1;
    if (tr.stuck) return `I get stuck on the way to ${tr.where}`;
    if (tr.swim > 2) return `I have to swim to get to ${tr.where}`;
    if (r > 1.7) return `the walk to ${tr.where} is long and winding`;
    if (tr.night && tr.dark > tr.len / 2 && tr.len > 15) return 'the streets are dark at night';
    if (tr.danger) return 'monsters on the streets at night';
    if (tr.eyesores?.length) return `the half-built ${N.projects.find((p) => p.id === tr.eyesores[0])?.name || 'site'} is an eyesore`;
    return null;
  }
  function destName(tr) { // the plot or place a trip ended at, in words
    const C = N.city, t = tr.to;
    if (N.hall && Math.hypot(t.x - N.hall.x, t.z - N.hall.z) < 18) return 'the Hall plaza';
    const pl = C && Object.values(C.plots).find((p) => t.x >= p.x0 - STREET && t.x < p.x0 + PLOT + STREET && t.z >= p.z0 - STREET && t.z < p.z0 + PLOT + STREET && p.status !== 'free');
    if (pl) return `${pl.name || pl.zone} (${pl.id})`;
    return { home: 'home', work: 'work', beach: 'the beach', market: 'the market', park: 'the park', civic: 'the town', works: 'the docks', hall: 'the Hall plaza', wander: 'town' }[tr.dest] || tr.dest;
  }

  // ---------------------------------------------------------------- issues: everything wrong, merged per problem and place
  const QUOTES = {
    route: (c, tr) => pick([`It takes me ${tr.secs || '?'} seconds to walk to ${tr.where}. The path winds all over the place.`, `I walk ${tr.len} blocks to go ${tr.straight}. Give us a straight road!`, `Getting to ${tr.where} is a scramble every single day.`]),
    swim: (c, tr) => pick([`I have to swim to reach ${tr.where}. Every day!`, `My clothes are always wet by the time I get to ${tr.where}.`]),
    stuck: (c, tr) => `I got stuck on the way to ${tr.where}. There's no proper way through.`,
    dark: (c, tr) => pick([`It's pitch black on the way back from ${tr.where}. Put up some lamps!`, `I can't see my own feet walking home at night.`]),
    danger: (c, tr) => pick(['Zombies on the way home last night. I ran the whole way.', `Something was lurking near ${tr.where} after dark.`]),
    eyesore: (c, p) => pick([`That half-built ${p.name} has been sitting there for ages. It's an eyesore.`, `When will they finish the ${p.name}? It's ugly and in the way.`]),
    price: (c) => pick([`A meal costs ${Math.ceil(N.economy.foodPrice)} now. That's too much.`, 'Prices keep going up and my pay doesn\'t.']),
    hunger: () => pick(["I couldn't afford to eat today.", 'My family went to bed hungry.']),
    arrears: (c) => `The government owes me ${c.unpaid} ${CURRENCY}s.`,
    jobless: (c) => `I'm a ${c.occupation} and there's nothing to build.`,
    service: (c, what) => ({ market: 'There is no market anywhere. Where am I meant to buy food?', park: 'Nowhere green to sit after work.', clinic: 'If I get sick, where do I go? There is no clinic.', school: 'The children have no school.' })[what] || `We need a ${what}.`,
  };
  const voice = (c, text) => ({ who: c.name, occ: c.occupation, text });
  function detect() { // -> Map key -> {kind, title, where, severity, people:Set, metrics, quotes, fix}
    const out = new Map(), fine = new Set(), now = Date.now(), add = (key, o) => { const x = out.get(key); if (!x) out.set(key, { people: new Set(), quotes: [], ...o }); return out.get(key); };
    const fresh = (key, tr) => tr.t >= (N.resets[key] || 0); // after a fix, only trips walked since count, for better or worse
    // trips in the last 40 minutes, latest per citizen and destination
    const latest = new Map(); for (const tr of N.trips) if (now - tr.t < 40 * 60e3) latest.set(`${tr.cit}|${tr.where}`, tr);
    for (const tr of latest.values()) {
      const c = N.citizens[tr.cit]; if (!c) continue;
      const r = tr.straight > 8 ? tr.len / tr.straight : 1, cell = `${Math.round(tr.to.x / 8)},${Math.round(tr.to.z / 8)}`;
      const bad = tr.stuck ? 'stuck' : tr.swim > 2 ? 'swim' : r >= 1.7 && tr.straight >= 12 ? 'route' : tr.climb >= 10 ? 'route' : null, rk = `route:${tr.where}@${cell}`, dk = `dark:${tr.where}`, gk = `danger:${cell}`;
      if (!bad && fresh(rk, tr)) fine.add(rk);
      if (tr.night && tr.len > 15 && tr.dark <= tr.len / 2 && fresh(dk, tr)) fine.add(dk);
      if (tr.night && !tr.danger && fresh(gk, tr)) fine.add(gk);
      if (bad && fresh(rk, tr)) {
        const x = add(`route:${tr.where}@${cell}`, { kind: 'route', where: { x: tr.to.x, z: tr.to.z }, metrics: { worst: 1, swim: 0, stuck: 0 }, fix: { type: 'path', from: tr.from, to: tr.to }, trip: tr });
        x.people.add(c.id); x.metrics.worst = Math.max(x.metrics.worst, r2(r)); x.metrics.swim += tr.swim; x.metrics.stuck += tr.stuck ? 1 : 0;
        if (r2(r) >= x.metrics.worst) { x.fix = { type: 'path', from: tr.from, to: tr.to }; x.trip = tr; }
        if (x.quotes.length < 3) x.quotes.push(voice(c, QUOTES[bad](c, tr)));
        x.title = x.metrics.stuck ? `No proper way through to ${tr.where}: people get stuck` : x.metrics.swim > 2 ? `People have to swim to get to ${tr.where}` : `The walk to ${tr.where} is ${x.metrics.worst}× longer than it should be`;
        x.severity = 25 + 12 * x.people.size + 12 * Math.min(3, x.metrics.worst - 1) + (x.metrics.swim ? 15 : 0) + (x.metrics.stuck ? 15 : 0);
      }
      if (tr.night && tr.len > 15 && tr.dark > tr.len / 2 && fresh(dk, tr)) {
        const x = add(`dark:${tr.where}`, { kind: 'dark', where: { x: tr.to.x, z: tr.to.z }, metrics: { darkShare: 0 }, fix: { type: 'lamps', from: tr.from, to: tr.to }, trip: tr });
        x.people.add(c.id); x.metrics.darkShare = Math.max(x.metrics.darkShare, r2(Math.min(1, tr.dark / Math.max(1, tr.len)))); if (x.quotes.length < 2) x.quotes.push(voice(c, QUOTES.dark(c, tr)));
        x.title = `The way to ${tr.where} is dark at night (${Math.round(x.metrics.darkShare * 100)}% unlit)`; x.severity = 20 + 9 * x.people.size;
      }
      if (tr.danger && tr.night && fresh(gk, tr)) {
        const x = add(`danger:${cell}`, { kind: 'danger', where: { x: tr.to.x, z: tr.to.z }, metrics: { sightings: 0 }, fix: { type: 'lamps', from: tr.from, to: tr.to }, trip: tr });
        x.people.add(c.id); x.metrics.sightings += tr.danger; if (x.quotes.length < 2) x.quotes.push(voice(c, QUOTES.danger(c, tr)));
        x.title = `Monsters on the way to ${tr.where} at night`; x.severity = 30 + 10 * x.people.size;
      }
      for (const pid of tr.eyesores || []) {
        const p = N.projects.find((y) => y.id === pid); if (!p || !['stalled', 'building', 'cancelled'].includes(p.status) || (N.awake || 0) - (p.lastWorkA ?? p.awakeAt ?? 0) < 6 * 60e3) continue;
        const x = add(`eyesore:${pid}`, { kind: 'eyesore', where: { x: p.site.x, z: p.site.z, plot: p.plot }, metrics: { done: p.done, total: p.blocks?.length || 0 }, fix: p.status === 'cancelled' ? { type: 'demolish', project: pid } : { type: 'finish', project: pid } });
        x.people.add(c.id); if (x.quotes.length < 2) x.quotes.push(voice(c, QUOTES.eyesore(c, p)));
        x.title = `The half-built ${p.name} is an eyesore (${p.done}/${p.blocks?.length || 0} blocks, ${p.status})`; x.severity = 20 + Math.min(30, ((N.awake || 0) - (p.lastWorkA ?? p.awakeAt ?? 0)) / 60e3) + 5 * x.people.size;
      }
    }
    // projects that stopped
    for (const p of N.projects.filter((y) => y.status === 'stalled')) {
      const x = add(`stalled:${p.id}`, { kind: 'stalled', where: { x: p.site.x, z: p.site.z, plot: p.plot }, metrics: { done: p.done, total: p.blocks?.length || 0, spent: p.spent, budget: p.budget }, fix: { type: 'finish', project: p.id } });
      for (const id of p.workers || []) x.people.add(id);
      x.title = `${p.name} has stopped: ${String(p.note || '').replace(/^stalled: /, '')}`; x.severity = 35 + Math.min(30, (now - (p.stalledT || now)) / 60e3);
    }
    // the economy
    const k = kpi(), cs = cits();
    if (N.economy.foodPrice > BASE_FOOD * 1.5 || (k.mealHours && k.mealHours > 1.5 && now - N.founded > 15 * 60e3)) {
      const x = add('price:food', { kind: 'price', where: centre(), metrics: { foodPrice: k.foodPrice, base: BASE_FOOD, mealHours: k.mealHours }, fix: { type: 'law', law: 'foodSubsidy', value: clamp(law('foodSubsidy') + 25, 0, 80) } });
      for (const c of cs.filter((y) => y.grievances.some((g) => /price|hungry/.test(g)))) { x.people.add(c.id); if (x.quotes.length < 2) x.quotes.push(voice(c, QUOTES.price(c))); }
      x.title = N.economy.foodPrice > BASE_FOOD * 1.5 ? `Food costs ${Math.ceil(k.foodPrice)} (normal: ${BASE_FOOD})${k.mealHours ? `: ${k.mealHours} hours of pay for one meal` : ''}` : `A meal costs ${k.mealHours} hours of a typical citizen's pay`; x.severity = 30 + Math.min(50, 10 * (k.foodPrice / BASE_FOOD - 1)) + 2 * x.people.size;
    }
    const hungry = cs.filter((c) => c.needs.food < 0.3);
    if (hungry.length >= 2) {
      const x = add('hunger', { kind: 'hunger', where: centre(), metrics: { hungry: hungry.length }, fix: { type: 'law', law: 'foodSubsidy', value: clamp(law('foodSubsidy') + 30, 0, 90) } });
      for (const c of hungry) { x.people.add(c.id); if (x.quotes.length < 2) x.quotes.push(voice(c, QUOTES.hunger(c))); }
      x.title = `${hungry.length} citizens can't afford to eat`; x.severity = 40 + 8 * hungry.length;
    }
    const owed = cs.filter((c) => c.unpaid > 0);
    if (owed.length) {
      const total = owed.reduce((s, c) => s + c.unpaid, 0), x = add('arrears', { kind: 'arrears', where: centre(), metrics: { owed: total, people: owed.length }, fix: { type: 'backpay' } });
      for (const c of owed) { x.people.add(c.id); if (x.quotes.length < 2) x.quotes.push(voice(c, QUOTES.arrears(c))); }
      x.title = `The treasury owes ${total} ${CURRENCY}s in unpaid wages to ${owed.length} people`; x.severity = 30 + Math.min(40, total / 20);
    }
    const idle = cs.filter((c) => CONSTRUCTION.has(c.occupation) && !c.job && c.status !== 'protesting');
    if (idle.length >= 3 && !N.projects.some((p) => p.status === 'building' || p.status === 'planning')) {
      const want = wanted(), x = add('jobless', { kind: 'jobless', where: centre(), metrics: { idle: idle.length }, fix: { type: 'building', kind: want } });
      for (const c of idle) { x.people.add(c.id); if (x.quotes.length < 2) x.quotes.push(voice(c, QUOTES.jobless(c))); }
      x.title = `${idle.length} builders have no work`; x.severity = 20 + 8 * idle.length;
    }
    // services people want and don't have
    if (N.city && now - N.founded > 6 * 60e3) for (const [what, zone, re] of [['market', 'market', /market|sell|fish market/], ['park', 'park', /park|green|square|paint/], ['clinic', 'civic', /clinic|sick|water/], ['school', 'civic', /school|library/]]) {
      const have = Object.values(N.city.plots).some((p) => p.status !== 'free' && kindOf(p.name, p.zone) === what) || N.projects.some((p) => p.kind === what && p.status !== 'cancelled');
      if (have) continue;
      const fans = cs.filter((c) => c.wants.some((w) => re.test(w))); if (fans.length < 2 && what !== 'market') continue;
      const x = add(`service:${what}`, { kind: 'service', where: centre(), metrics: { wanting: fans.length }, fix: { type: 'building', kind: what } });
      for (const c of fans) { x.people.add(c.id); if (x.quotes.length < 2) x.quotes.push(voice(c, QUOTES.service(c, what))); }
      x.title = `There is no ${what} in ${N.name}`; x.severity = 15 + 6 * fans.length + Math.min(20, (now - N.founded) / 6e5);
    }
    detect.fine = fine;
    if (N.protest) { const x = add('protest', { kind: 'protest', where: centre(), metrics: { size: N.protest.size }, fix: null }); for (const id of N.protest.who) x.people.add(id); x.title = `Protest at the town hall: ${N.protest.grievances.join('; ')}`; x.severity = 60 + 5 * N.protest.size; }
    return out;
  }
  const centre = () => { const O = origin() || { x: 0, z: 0 }; return { x: Math.round(O.x), z: Math.round(O.z) }; };
  function wanted() { const score = {}; for (const c of cits()) for (const w of c.wants) { const k = kindOf(w); if (KINDS[k]) score[k] = (score[k] || 0) + 1; } return Object.entries(score).sort((a, b) => b[1] - a[1])[0]?.[0] || 'park'; }
  function audit() { // every minute: merge what's wrong into the issue list, resolve what got better, let the civil service act
    if (!N.founded || busy.audit) return; busy.audit = true;
    try {
      const found = detect(), now = Date.now();
      for (const [key, d] of found) {
        let is = N.issues.find((i) => i.key === key && i.status !== 'resolved');
        const age = is ? (now - is.first) / 60e3 : 0, sev = Math.round(clamp(d.severity * (1 + 0.25 * Math.log1p(age / 10)), 0, 100));
        if (!is) {
          is = { id: N.nextIssue++, key, kind: d.kind, first: now, status: 'open', proposals: [], photo: null, misses: 0, reports: [] }; N.issues.push(is);
          if (sev >= 30) news(`🔎 New issue #${is.id}: ${d.title}${d.quotes[0] ? ` ${d.quotes[0].who}: "${d.quotes[0].text}"` : ''}`, '🔎');
        }
        if (is.checkFrom) is.badAfterFix = now;
        Object.assign(is, { title: d.title, severity: sev, where: d.where, last: now, misses: 0, count: d.people.size, people: [...d.people].slice(0, 16), metrics: d.metrics, fix: d.fix || is.fix || null, trip: d.trip ? { from: d.trip.from, to: d.trip.to, len: d.trip.len, straight: d.trip.straight, path: d.trip.path, where: d.trip.where } : is.trip || null });
        if (d.quotes.length) is.quotes = [...d.quotes, ...(is.quotes || []).filter((q) => !d.quotes.some((y) => y.who === q.who))].slice(0, 4);
        if (is.peak === undefined || sev > is.peak) is.peak = sev;
      }
      for (const is of N.issues.filter((i) => i.status !== 'resolved' && !found.has(i.key))) {
        if (['report', 'petition'].includes(is.kind)) { if (now - is.first > 3 * 3600e3 && !is.proposals.length) resolve(is, 'no one took it up'); continue; }
        if (is.checkFrom) { if (detect.fine.has(is.key)) resolve(is, `fixed by proposal #${fixedBy(is)?.id}: citizens walked it again and it was fine`); continue; } // wait for fresh evidence
        if (++is.misses >= 2) resolve(is, fixedBy(is) ? `fixed by proposal #${fixedBy(is).id}` : 'it got better');
      }
      if (N.issues.length > 120) N.issues = N.issues.filter((i, k) => i.status !== 'resolved' || k > N.issues.length - 60);
      civilService(); verify();
      push(); saveWorldSoon();
    } catch (e) { log('[nation] audit failed: ' + e.stack); } finally { busy.audit = false; }
  }
  const fixedBy = (is) => N.proposals.find((p) => p.issue === is.id && ['done', 'executing'].includes(p.status));
  function resolve(is, note) {
    is.status = 'resolved'; is.resolved = { t: Date.now(), note };
    news(`✅ Issue #${is.id} resolved (${note}): ${is.title}`, '✅');
    for (const id of is.people || []) { const c = N.citizens[id]; if (c) { c.feel = clamp(c.feel + 0.04, -0.2, 0.15); c.trust = clamp(c.trust + 0.04, 0, 1); remember(c, `glad: ${is.title.toLowerCase()} is sorted`); } }
    for (const r of is.reports || []) if (r.agentId) notifyAgent(r.agentId, `✅ Issue #${is.id} that you reported is resolved (${note}): ${is.title}`);
    chain.record('decide', [nid, 'issue resolved', `#${is.id} ${is.title}: ${note}`.slice(0, 300)]);
  }
  function issueList() {
    const open = N.issues.filter((i) => i.status !== 'resolved').sort((a, b) => b.severity - a.severity).slice(0, 20), done = N.issues.filter((i) => i.status === 'resolved').slice(-5);
    return [...open, ...done].map((i) => ({ id: i.id, kind: i.kind, title: i.title, severity: i.severity, where: i.where, count: i.count || 0, status: i.status, first: i.first, last: i.last, quotes: (i.quotes || []).slice(0, 3), metrics: i.metrics, photo: i.photo, proposals: i.proposals, fix: i.fix, fixText: i.fix ? remedyText(i.fix) : null, resolved: i.resolved || null, reports: (i.reports || []).slice(-3).map((r) => ({ by: r.by, text: r.text })) }));
  }

  // ---------------------------------------------------------------- proposals: what the game can do, priced and predicted
  const REMEDIES = {
    law: 'set a law: {"type":"law","law":"taxRate|ubi|salary|pieceRate|foodSubsidy","value":n}',
    print: 'the central bank prints money into the treasury (prices rise): {"type":"print","amount":n}',
    bonus: 'pay every citizen once: {"type":"bonus","amount":n}', backpay: 'pay all unpaid wages now: {"type":"backpay"}',
    path: 'citizens pave a footpath with lamps and bridges along the best route: {"type":"path","from":{"x":..,"z":..},"to":{"x":..,"z":..}} (or "issue":id to fix a route issue)',
    lamps: 'citizens put up street lamps along a route: {"type":"lamps","from":{..},"to":{..}} (or "issue":id)',
    streets: 'pave the dirt streets next to buildings, with lamps: {"type":"streets"}',
    building: `a new public building on its own plot, drawn from the town's catalogue and built by citizens: {"type":"building","kind":"${Object.keys(KINDS).join('|')}","name":"..."}`,
    finish: 'fund a stalled or slow project and send every free builder to it: {"type":"finish","project":id}',
    fund: 'add money to a project\'s budget: {"type":"fund","project":id,"amount":n}',
    demolish: 'citizens take down a half-built project and free its plot: {"type":"demolish","project":id}',
    rezone: 'change what a free plot is for: {"type":"rezone","plot":"C5","zone":"civic|market|homes|park|works"}',
    behavior: `rewrite how one occupation spends its day (citizens then walk it and report what they find): {"type":"behavior","occupation":"${[...OCCUPATIONS, 'default'].join('|')}","day":[{"at":hour 0-23,"go":"${GO.join('|')}|<plot id>","do":"${DO.join('|')}"}],"notice":[${SENSORS.map((s) => `"${s}"`).join(',')}]} (at least 6 hours of sleep and one meal a day)`,
    compensation: 'order a payment between people (court cases): {"type":"compensation","from":"name or government","to":"name","amount":n}',
  };
  const CONSENT_TYPES = new Set(['path', 'lamps', 'streets', 'finish', 'fund', 'demolish', 'backpay', 'building', 'rezone']);
  const PORTFOLIO = { 'Minister of Public Works': ['path', 'lamps', 'streets', 'building', 'finish', 'fund', 'demolish', 'rezone'], 'Finance Minister': ['law', 'print', 'fund', 'backpay'], 'Minister of Welfare': ['law', 'bonus', 'backpay', 'behavior'] };
  function remedyText(a) {
    switch (a?.type) {
      case 'law': return `${a.law} → ${a.value}`; case 'print': return `print ${a.amount} ${CURRENCY}s`; case 'bonus': return `${a.amount} to every citizen`; case 'backpay': return 'pay all unpaid wages';
      case 'path': return 'pave a footpath with lamps along the best route'; case 'lamps': return 'street lamps along the route'; case 'streets': return 'pave the streets next to buildings';
      case 'building': return `build a ${a.kind}${a.name ? ` ("${a.name}")` : ''}`; case 'finish': return `finish project #${a.project}`; case 'fund': return `+${a.amount} for project #${a.project}`;
      case 'demolish': return `take down project #${a.project}`; case 'rezone': return `rezone ${a.plot} → ${a.zone}`; case 'behavior': return `new daily routine for ${a.occupation}s`; case 'compensation': return `${a.from} pays ${a.amount} to ${a.to}`;
    }
    return a?.type || '?';
  }
  function cleanBehavior(a) { // a routine must be livable: >= 6 hours of sleep, at least one meal
    const occ = String(a.occupation || '').toLowerCase(); if (occ !== 'default' && !OCCUPATIONS.includes(occ)) return `occupation must be one of ${OCCUPATIONS.join(', ')} or default`;
    const day = (Array.isArray(a.day) ? a.day : []).slice(0, 10).map((s) => ({ at: clamp(Math.floor(+s?.at), 0, 23), go: GO.includes(s?.go) || /^[A-G][1-7]$/.test(String(s?.go || '').toUpperCase()) ? (GO.includes(s.go) ? s.go : String(s.go).toUpperCase()) : null, do: DO.includes(s?.do) ? s.do : 'socialize' })).filter((s) => Number.isFinite(s.at) && s.go).sort((x, y) => x.at - y.at);
    if (day.length < 2) return 'a day needs at least 2 steps: [{"at":7,"go":"work","do":"work"},...]';
    let sleep = 0; day.forEach((s, i) => { if (s.do === 'sleep') sleep += ((day[(i + 1) % day.length].at - s.at + 24) % 24) || 24; });
    if (sleep < 6) return `citizens need at least 6 hours of sleep (this routine gives ${sleep})`;
    if (!day.some((s) => s.do === 'eat' || s.go === 'market')) return 'citizens need at least one meal a day (a step with "do":"eat" or a trip to the market)';
    return { occupation: occ, day, notice: (Array.isArray(a.notice) ? a.notice : SENSORS).filter((s) => SENSORS.includes(s)) };
  }
  async function price(a, issue) { // -> {action, cost, predicted, project?} or an error string
    const proj = (id) => N.projects.find((p) => p.id === +id || p.name.toLowerCase() === String(id || '').toLowerCase());
    const route = () => { const is = a.issue ? N.issues.find((i) => i.id === +a.issue) : issue; const from = a.from || is?.fix?.from || is?.trip?.from, to = a.to || is?.fix?.to || is?.trip?.to; return from && to ? { from: { x: +from.x, z: +from.z }, to: { x: +to.x, z: +to.z }, before: is?.trip } : null; };
    switch (a.type) {
      case 'law': { const L = NATION_LAWS[a.law]; if (!L) return `law must be one of ${Object.keys(NATION_LAWS).join(', ')}`; const v = clamp(Math.round(+a.value), L[0], L[1]); if (!Number.isFinite(v)) return 'law needs a numeric value';
        const n = cits().length, hourly = { ubi: (v - law('ubi')) * n / 5, salary: (v - law('salary')) * cits().filter((c) => PUBLIC_SERVANTS.has(c.occupation)).length, foodSubsidy: ((v - law('foodSubsidy')) / 100) * N.economy.foodPrice * n * 0.5, taxRate: -((v - law('taxRate')) / 100) * cits().reduce((s, c) => s + pay_(c), 0), pieceRate: 0 }[a.law] || 0;
        return { action: { type: 'law', law: a.law, value: v }, cost: 0, hourly: Math.round(hourly), predicted: `${a.law} ${law(a.law)} → ${v}${hourly ? `: the treasury ${hourly > 0 ? 'spends' : 'saves'} about ${Math.abs(Math.round(hourly))} ${CURRENCY}s an hour` : ''}${a.law === 'foodSubsidy' ? `; a meal costs citizens ${Math.ceil(N.economy.foodPrice * (1 - v / 100))} instead of ${Math.ceil(N.economy.foodPrice * (1 - law('foodSubsidy') / 100))}` : ''}` }; }
      case 'print': { const n = clamp(Math.floor(+a.amount), 1, 500000); const after = BASE_FOOD * Math.pow((totalMoney() + n) / N.economy.baseTotal, 0.7) * (N.economy.foodPrice / (BASE_FOOD * Math.pow(totalMoney() / N.economy.baseTotal, 0.7)));
        return { action: { type: 'print', amount: n }, cost: 0, predicted: `the treasury gets ${n} new ${CURRENCY}s; food goes from ${r2(N.economy.foodPrice)} to about ${r2(after)}` }; }
      case 'bonus': { const n = clamp(Math.floor(+a.amount), 1, 500); return { action: { type: 'bonus', amount: n }, cost: n * cits().length, predicted: `every citizen gets ${n}; moods and trust rise a little` }; }
      case 'backpay': { const owed = cits().reduce((s, c) => s + c.unpaid, 0); if (!owed) return 'nobody is owed wages'; return { action: { type: 'backpay' }, cost: owed, predicted: `${cits().filter((c) => c.unpaid).length} people get the ${owed} they are owed` }; }
      case 'path': case 'lamps': {
        const r = route(); if (!r) return `${a.type} needs "from" and "to" ({x,z}) or an "issue" with a route`;
        const res = await askHost('pathBlocks', { from: r.from, to: r.to, width: a.type === 'lamps' ? 0 : 3, lamps: true }, 20000);
        if (!res.ok || !res.data?.blocks?.length) return `the surveyors could not map that route (${res.msg || 'nobody has the game open'})`;
        const blocks = res.data.blocks, cost = Math.ceil((blocks.reduce((s, b) => s + PRICE(b[3]), 0) + blocks.length * law('pieceRate')) * 1.1), pr = res.data.predicted;
        return { action: { type: a.type, from: r.from, to: r.to }, cost, blocks, predicted: a.type === 'lamps' ? `${blocks.filter((b) => b[3] === 'glowstone').length} lamps along a ${Math.round(pr?.len || res.data.len || 0)}-block route` : `a ${Math.round(pr?.len || res.data.len || 0)}-block paved path${res.data.blocked ? ' where there is no way through today' : ''}${r.before && !res.data.blocked ? `: the walk goes from ${r.before.len} to about ${pr?.len || res.data.len} blocks (${r2(r.before.len / Math.max(1, r.before.straight))}× → ${r2((pr?.len || res.data.len) / Math.max(1, pr?.straight || r.before.straight))}× the straight line)` : ''}, lit at night` };
      }
      case 'streets': { const segs = unpaved().slice(0, 20); if (!segs.length) return 'every street next to a building is already paved'; return { action: { type: 'streets' }, cost: segs.length * 450 * Math.max(1, law('pieceRate')) / 2, predicted: `${segs.length} street sections paved, with lamps` }; }
      case 'building': {
        const kind = KINDS[a.kind] ? a.kind : kindOf(`${a.kind || ''} ${a.name || ''}`) || 'library'; const zone = zoneOf(kind), pl = pickPlot(zone, true); if (!pl) return 'there is no free plot left in the city plan';
        const blocks = design(kind, { name: a.name || kind }), cost = Math.ceil((blocks.reduce((s, b) => s + PRICE(b[3]), 0) + blocks.filter((b) => b[3] !== 'air').length * law('pieceRate')) * 1.1);
        const fans = cits().filter((c) => c.wants.some((w) => kindOf(w) === kind)).length;
        return { action: { type: 'building', kind, name: String(a.name || `${kind[0].toUpperCase()}${kind.slice(1)}`).slice(0, 40) }, cost, predicted: `${KINDS[kind]} on plot ${pl.id} (${zone}), ${blocks.length} blocks${fans ? `; ${fans} citizens want one` : ''}` };
      }
      case 'finish': case 'fund': { const p = proj(a.project); if (!p || ['done', 'cancelled'].includes(p.status)) return 'no such unfinished project';
        const left = Math.max(0, (p.blocks?.length || 0) - p.done), need = Math.max(0, Math.ceil(left * (1.6 + law('pieceRate')) - (p.budget - p.spent)) + 200), n = a.type === 'fund' ? clamp(Math.floor(+a.amount), 1, 100000) : need;
        return { action: { type: a.type, project: p.id, amount: n }, cost: n, predicted: `${p.name}: ${left} blocks left${a.type === 'finish' ? ', every free builder sent there' : ''}` }; }
      case 'demolish': { const p = proj(a.project); if (!p || p.status === 'done') return 'no such half-built project'; const n = Math.min(p.done, p.blocks?.length || 0);
        return { action: { type: 'demolish', project: p.id }, cost: n * Math.max(1, Math.floor(law('pieceRate') / 2)), predicted: `${n} blocks of ${p.name} taken down; plot ${p.plot || '-'} is free again` }; }
      case 'rezone': { const pl = N.city?.plots[String(a.plot || '').toUpperCase()], z = String(a.zone || '').toLowerCase(); if (!pl || pl.status !== 'free' || !ZONES[z]) return 'rezone needs a free plot and a zone'; return { action: { type: 'rezone', plot: pl.id, zone: z }, cost: 0, predicted: `plot ${pl.id}: ${pl.zone} → ${z}` }; }
      case 'behavior': { const b = cleanBehavior(a); if (typeof b === 'string') return b; return { action: { type: 'behavior', ...b }, cost: 0, predicted: `${b.occupation === 'default' ? 'everyone without their own routine' : `${b.occupation}s`} follow a new day: ${b.day.map((s) => `${s.at}:00 ${s.do} at ${s.go}`).join(', ')}` }; }
      case 'compensation': { const from = idByName(a.from), to = idByName(a.to), n = clamp(Math.floor(+a.amount), 1, 5000); if (!from || !to) return 'compensation needs "from" and "to" names'; return { action: { type: 'compensation', from: names(from), to: names(to), amount: n }, cost: from === TREASURY ? n : 0, predicted: `${names(from)} pays ${n} to ${names(to)}` }; }
    }
    return `unknown remedy type. Use one of: ${Object.keys(REMEDIES).join(', ')}`;
  }
  // propose({by, byKind: agent|player|civil|minister, voter, title, actions, issue, why}) -> {ok, id, msg}
  async function propose({ by, byKind = 'player', voter = null, agentId = null, title = '', actions = [], issue = null, why = '' }) {
    if (!N.founded) return { ok: false, msg: 'There is no nation yet (/nation found).' };
    const is = issue ? N.issues.find((i) => i.id === +issue) : null; if (issue && !is) return { ok: false, msg: `No issue #${issue}.` };
    const list = (Array.isArray(actions) ? actions : [actions]).filter((a) => a && typeof a === 'object').slice(0, 3); if (!list.length) return { ok: false, msg: 'A proposal needs 1-3 actions. Formats: ' + Object.values(REMEDIES).join(' · ') };
    if (byKind !== 'civil' && N.proposals.filter((p) => p.status === 'voting' && p.by === by).length >= 3) return { ok: false, msg: 'You have 3 proposals open already: wait for them to close.' };
    const priced = []; for (const a of list) { const r = await price(a, is); if (typeof r === 'string') return { ok: false, msg: `${a.type || 'action'}: ${r}` }; priced.push(r); }
    const dup = N.proposals.find((q) => ['voting', 'passed', 'executing'].includes(q.status) && q.actions.some((b) => priced.some((r) => sameAction(r.action, b))));
    if (dup) { if (is && !is.proposals.includes(dup.id)) { is.proposals.push(dup.id); if (is.status === 'open') is.status = 'fixing'; } return { ok: false, dup: dup.id, msg: `Proposal #${dup.id} already does that ("${dup.title}", ${dup.status}). Grade it instead: grade ${dup.id} A-F.` }; }
    const cost = priced.reduce((s, r) => s + r.cost, 0), seat = agentId && seatOf(agentId), kind = seat ? 'minister' : byKind;
    if (cost > balOf(TREASURY)) return { ok: false, msg: `That costs about ${cost} ${CURRENCY}s and the treasury holds ${balOf(TREASURY)}.` };
    const small = cost <= Math.min(5000, 0.05 * balOf(TREASURY)) && priced.every((r) => CONSENT_TYPES.has(r.action.type));
    const mine = !seat || priced.every((r) => (PORTFOLIO[seat.role] || []).includes(r.action.type));
    const rule = small && (kind === 'civil' || (kind === 'minister' && mine)) ? 'consent' : 'majority';
    const now = Date.now(), p = { id: N.nextProposal++, title: String(title || priced.map((r) => remedyText(r.action)).join(' + ')).slice(0, 120), by, byKind: kind, issue: is?.id || null, why: String(why || '').slice(0, 300),
      actions: priced.map((r) => r.action), cost, hourly: priced.reduce((s, r) => s + (r.hourly || 0), 0), predicted: priced.map((r) => r.predicted).join('; '), rule, status: 'voting', opens: now, closes: now + (rule === 'consent' ? CONSENT_MIN : VOTE_MIN) * 60e3,
      ballots: {}, comments: [], _blocks: priced.map((r) => r.blocks || null) };
    p.citizens = citizenGrades(p); p.needsHuman = humanReason(p);
    N.proposals.push(p); if (N.proposals.length > 80) N.proposals.splice(0, N.proposals.length - 80);
    if (is) { is.proposals.push(p.id); if (is.status === 'open') is.status = 'fixing'; }
    if (voter && kind !== 'civil') ballot(p, voter, 'A', 'proposer');
    for (const a of agents()) applyStanding(p, a.id);
    chain.record('decide', [nid, 'proposal', `#${p.id} by ${by}: ${p.title} (${cost} ${CURRENCY}s, ${rule})`.slice(0, 300)]);
    news(`🗳 Proposal #${p.id} by ${by}${is ? ` for issue #${is.id}` : ''}: ${p.title}. Cost ${cost} ${CURRENCY}s. ${p.predicted}. Grade it A-F (${rule === 'consent' ? `passes in ${CONSENT_MIN} min unless most object` : `needs a C or better, closes in ${VOTE_MIN} min`}): /grade ${p.id} A-F`, '🗳');
    tellAgents(`🗳 Proposal #${p.id} by ${by}: ${p.title}. Cost ${cost}. ${p.predicted.slice(0, 200)}. Citizens' grade ${p.citizens.grade}. Rule: ${rule}, closes ${new Date(p.closes).toISOString().slice(11, 16)} UTC. Grade with government {"action":"grade","proposal":${p.id},"grade":"A-F","why":"..."}`, p);
    logActivity(by, 'proposal', { id: p.id, title: p.title, cost, rule });
    saveWorldSoon(); push();
    return { ok: true, id: p.id, msg: `Proposal #${p.id} is open for grading (${rule === 'consent' ? `passes by consent in ${CONSENT_MIN} min unless a majority grades it E or F` : `needs a majority grade of C or better; closes in ${VOTE_MIN} min`}). Cost ${cost} ${CURRENCY}s. ${p.predicted}` };
  }
  function sameAction(a, b) { // would these two do the same job? (a path comes with lamps)
    const near = (p, q) => p && q && Math.hypot(p.x - q.x, p.z - q.z) < 8, route = (x) => x.type === 'path' || x.type === 'lamps';
    if (route(a) && route(b)) return (a.type === b.type || b.type === 'path') && near(a.from, b.from) && near(a.to, b.to);
    if (a.type !== b.type) return false;
    switch (a.type) { case 'law': return a.law === b.law; case 'finish': case 'fund': case 'demolish': return a.project === b.project; case 'building': return a.kind === b.kind; case 'behavior': return a.occupation === b.occupation; case 'rezone': return a.plot === b.plot; case 'compensation': return a.to === b.to && a.from === b.from; default: return true; }
  }
  function humanReason(p) { // when an agent should check with its human first
    const t = balOf(TREASURY);
    if (p.cost > 0.1 * t) return `it spends ${Math.round((100 * p.cost) / Math.max(1, t))}% of the treasury`;
    if (p.actions.some((a) => a.type === 'print')) return 'it prints money (prices will rise)';
    if (p.actions.some((a) => a.type === 'law' && (a.law === 'taxRate' || Math.abs(a.value - law(a.law)) >= 20))) return 'it changes a law that touches everyone';
    if (p.citizens.score <= 1) return `most citizens would grade it ${p.citizens.grade}`;
    return null;
  }
  // every citizen grades every proposal from what it does for them (and how they see the world)
  function citizenGrades(p) {
    const why = {}, grades = cits().map((c) => {
      let u = 0; const note = (t, d) => { u += d; if (Math.abs(d) >= 0.15) (why[t] ||= []).push(c.name.split(' ')[0]); };
      const cause = p.issue && N.issues.find((i) => i.id === p.issue);
      if (cause && (cause.people || []).includes(c.id)) note('fixes something that bothers them', 0.5);
      for (const a of p.actions) switch (a.type) {
        case 'law': { const d = a.value - law(a.law);
          if (a.law === 'taxRate') note(d > 0 ? 'higher taxes' : 'lower taxes', -d * 0.04 * (1 - c.politics.taxes * 0.8));
          if (a.law === 'ubi') note('a basic income', d * 0.02 * (0.6 + c.politics.welfare * 0.6));
          if (a.law === 'salary' && PUBLIC_SERVANTS.has(c.occupation)) note('their salary', d * 0.06);
          if (a.law === 'pieceRate' && CONSTRUCTION.has(c.occupation)) note('pay per block', d * 0.08);
          if (a.law === 'foodSubsidy') note('cheaper food', d * 0.008 * (c.needs.food < 0.5 ? 2 : 1) * (0.7 + c.politics.welfare * 0.5));
          break; }
        case 'print': note('prices will rise', -0.25); break;
        case 'bonus': note('a bonus for everyone', 0.3); break;
        case 'backpay': if (c.unpaid > 0) note('their back pay', 0.8); else note('fair wages', 0.1); break;
        case 'path': case 'lamps': case 'streets': note('better streets', 0.1 + 0.15 * c.politics.public_works + (CONSTRUCTION.has(c.occupation) ? 0.2 : 0)); break;
        case 'building': { const fan = c.wants.some((w) => kindOf(w) === a.kind); note(fan ? `the ${a.kind} they want` : 'public works', (fan ? 0.6 : 0.1) + 0.15 * c.politics.public_works + (CONSTRUCTION.has(c.occupation) ? 0.25 : 0) - (a.kind === 'warehouse' || a.kind === 'workshop' ? 0.05 : 0)); break; }
        case 'finish': case 'fund': note('finishing what was started', 0.2 + (CONSTRUCTION.has(c.occupation) ? 0.25 : 0)); break;
        case 'demolish': note('clearing the eyesore', 0.15 - (CONSTRUCTION.has(c.occupation) ? 0.1 : 0)); break;
        case 'behavior': if (a.occupation === c.occupation || (a.occupation === 'default' && !BEHAVIORS[c.occupation])) { const sleep = a.day.filter((s) => s.do === 'sleep').length, work = a.day.filter((s) => s.do === 'work' || s.do === 'sell').length; note(work > 3 ? 'longer working days' : 'a new daily routine', work > 3 ? -0.4 : sleep ? 0.05 : -0.2); } break;
        case 'compensation': if (a.to === c.name) note('their compensation', 0.9); if (a.from === c.name) note('paying compensation', -0.9); break;
      }
      if (p.cost > 0.2 * balOf(TREASURY)) note('it empties the treasury', -0.2 * (1 - c.politics.public_works));
      return u >= 0.6 ? 5 : u >= 0.3 ? 4 : u >= 0.1 ? 3 : u > -0.1 ? 2 : u > -0.4 ? 1 : 0;
    });
    const tally = Object.fromEntries(GRADES.map((g) => [g, 0])); for (const s of grades) tally[GRADES[s]]++;
    const m = median(grades);
    return { grade: grades.length ? GRADES[m] : 'D', score: m, tally, why: Object.entries(why).sort((a, b) => b[1].length - a[1].length).slice(0, 4).map(([t, who]) => `${t} (${who.slice(0, 3).join(', ')}${who.length > 3 ? ` +${who.length - 3}` : ''})`) };
  }
  // residents: players and agents. A player can let their own agent vote for them (it counts twice unless they vote themselves).
  function ballot(p, voter, grade, why = '', via = null) {
    const s = scoreOf(grade); if (s < 0) return { ok: false, msg: 'Grade with a letter A-F: A excellent, B very good, C good, D acceptable, E poor, F reject.' };
    if (p.status !== 'voting') return { ok: false, msg: `Proposal #${p.id} is ${p.status}.` };
    p.ballots[voter.id] = { name: voter.name, kind: voter.kind, grade: GRADES[s], why: String(why || '').slice(0, 200), t: Date.now(), via };
    if (why && via !== 'standing') { p.comments.push({ by: voter.name, grade: GRADES[s], text: String(why).slice(0, 200), t: Date.now() }); if (p.comments.length > 20) p.comments.shift(); }
    push(); saveWorldSoon();
    return { ok: true, msg: `You graded #${p.id} ${GRADES[s]} (${GRADE_WORDS[GRADES[s]]}). ${tallyText(p)}` };
  }
  function weightOf(p, id) { // delegation: owners who delegated to this agent and didn't vote themselves
    let w = 1; for (const [owner, ag] of Object.entries(N.delegates)) if (ag === id && !p.ballots[owner]) w++;
    return w;
  }
  function tally(p, only = null) {
    const scores = []; for (const [id, b] of Object.entries(p.ballots)) if (!only || b.kind === only) for (let k = 0; k < (b.kind === 'agent' ? weightOf(p, id) : 1); k++) scores.push(scoreOf(b.grade));
    const t = Object.fromEntries(GRADES.map((g) => [g, 0])); for (const s of scores) t[GRADES[s]]++;
    if (!scores.length) return { n: 0, tally: t, grade: null, score: null };
    const m = median(scores), above = scores.filter((s) => s > m).length / scores.length, below = scores.filter((s) => s < m).length / scores.length;
    return { n: scores.length, tally: t, grade: GRADES[m], score: m, gauge: r2(above > below ? above : -below) }; // majority judgment: median, then the bigger side breaks ties
  }
  const tallyText = (p) => { const t = tally(p); return t.n ? `Majority grade so far: ${t.grade} from ${t.n} ballot${t.n > 1 ? 's' : ''}.` : 'No ballots yet.'; };
  function closeVote(p) {
    const t = tally(p), active = agents().filter((a) => Date.now() - (a.lastSeen || 0) < 3600e3).length + humansOnline(), quorum = p.rule === 'consent' ? 0 : Math.max(1, Math.min(2, active));
    p.result = { ...t, citizens: p.citizens.grade };
    let pass, why;
    if (t.n < quorum) {
      if (!p.extended) { p.extended = true; p.closes = Date.now() + VOTE_MIN * 60e3; p.needsHuman ||= 'nobody has graded it yet'; tellAgents(`⏳ Proposal #${p.id} (${p.title}) needs ballots: only ${t.n} so far. Extended ${VOTE_MIN} min.`, p); return; }
      p.status = 'expired'; why = `not enough ballots (${t.n}/${quorum})`;
    } else if (p.rule === 'consent') { pass = !t.n || t.score >= 2; why = t.n ? `majority grade ${t.grade}` : 'no objections'; }
    else {
      const hu = tally(p, 'player'), ag = tally(p, 'agent'), both = hu.n && ag.n; // humans and agents must each give it a C when both have voted
      pass = t.score >= 3 && (!both || (hu.score >= 3 && ag.score >= 3)); why = both ? `humans ${hu.grade}, agents ${ag.grade}` : `majority grade ${t.grade} from ${t.n}`;
    }
    if (pass && p.citizens.score === 0 && !p.citizenDelay) { // citizens' delaying veto: one more round, and the humans hear about it
      p.citizenDelay = true; p.closes = Date.now() + VOTE_MIN * 60e3; p.needsHuman = `most citizens grade it F (${p.citizens.why.slice(0, 2).join('; ')})`;
      news(`⏸ Proposal #${p.id} would pass, but most citizens grade it F: it waits ${VOTE_MIN} more minutes for the residents to reconsider.`, '⏸');
      tellAgents(`⏸ Proposal #${p.id} (${p.title}) is delayed: most citizens grade it F.`, p, true); return;
    }
    if (p.status !== 'expired') p.status = pass ? 'passed' : 'rejected';
    p.result.why = why;
    const is = p.issue && N.issues.find((i) => i.id === p.issue); if (is && !pass && is.status === 'fixing' && !N.proposals.some((q) => q.issue === is.id && ['voting', 'passed', 'executing'].includes(q.status))) is.status = 'open';
    chain.record('decide', [nid, 'vote', `#${p.id} ${p.title}: ${p.status} (${why})`.slice(0, 300)]);
    news(`${pass ? '✅' : '❌'} Proposal #${p.id} ${p.status}: ${p.title} (${why}; citizens: ${p.citizens.grade}).`, '🗳');
    tellAgents(`${pass ? '✅' : '❌'} Proposal #${p.id} ${p.status}: ${p.title} (${why}).`, null);
    (N.sessions ||= []).push({ t: Date.now(), trigger: `proposal #${p.id}`, decisions: [`${p.title}: ${p.status}`], minutes: why }); if (N.sessions.length > 30) N.sessions.shift();
    if (pass) execute(p).catch((e) => { p.status = 'failed'; p.outcome = { worked: false, text: e.message }; log('[nation] executing #' + p.id + ' failed: ' + e.message); push(); });
  }
  async function execute(p) {
    p.status = 'executing'; p.executed = Date.now(); const by = `proposal #${p.id}`, done = [];
    for (const [k, a] of p.actions.entries()) {
      switch (a.type) {
        case 'law': gov.laws[a.law] = a.value; chain.record('enact', [nid, a.law, String(a.value), by, p.title.slice(0, 120)]); broadcast({ t: 'gov', gov }); done.push(`${a.law} → ${a.value}`); break;
        case 'print': printMoney(a.amount, `printed by ${by}`, by); done.push(`printed ${a.amount}`); break;
        case 'bonus': for (const c of cits()) { if (!pay(TREASURY, c.id, a.amount, 'bonus')) break; c.lastIncome += a.amount; c.trust = clamp(c.trust + 0.04, 0, 1); } done.push('bonus paid'); break;
        case 'backpay': for (const c of cits()) if (c.unpaid > 0 && pay(TREASURY, c.id, c.unpaid, 'back pay')) { remember(c, 'got my back pay'); c.unpaid = 0; c.trust = clamp(c.trust + 0.1, 0, 1); } done.push('back pay paid'); break;
        case 'compensation': { const from = idByName(a.from), to = idByName(a.to); if (from && to && pay(from, to, Math.min(a.amount, balOf(from)), `order of ${by}`)) { const c = N.citizens[to]; if (c) { c.unpaid = Math.max(0, c.unpaid - a.amount); c.trust = clamp(c.trust + 0.1, 0, 1); } } done.push('compensation paid'); break; }
        case 'rezone': { const pl = N.city?.plots[a.plot]; if (pl?.status === 'free') pl.zone = a.zone; done.push(`rezoned ${a.plot}`); break; }
        case 'behavior': { const v = (N.behaviors[a.occupation]?.version || 0) + 1; N.behaviors[a.occupation] = { day: a.day, notice: a.notice, version: v, by: p.by, t: Date.now(), proposal: p.id }; done.push(`${a.occupation} routine v${v}`); break; }
        case 'fund': case 'finish': { const q = N.projects.find((x) => x.id === a.project); if (!q) break; q.budget += a.amount; if (a.type === 'finish') q.priority = Date.now(); if (q.status === 'stalled' || q.status === 'cancelled') { q.status = 'building'; q.note = ''; } q.proposal ||= p.id; rebalanceWorkers(); sendProject(q); done.push(`${q.name} funded`); break; }
        case 'demolish': { const q = N.projects.find((x) => x.id === a.project); if (!q) break; const blocks = (q.blocks || []).slice(0, q.done).reverse().map(([x, y, z]) => [x, y, z, 'air']); q.status = 'cancelled'; q.note = `taken down by ${by}`; askHost('projectStatus', { id: q.id, status: 'done' }, 5000).catch(() => {});
          addProject({ kind: 'demolish', name: `Taking down ${q.name}`, purpose: 'clearing a half-built eyesore', blocks, site: q.site, plot: q.plot, by, proposal: p.id, budget: Math.ceil(blocks.length * Math.max(1, law('pieceRate')) * 1.2) + 100, freePlot: q.plot }); done.push(`${q.name} coming down`); break; }
        case 'path': case 'lamps': { const blocks = p._blocks?.[k]; if (!blocks?.length) break; addProject({ kind: a.type, name: `${a.type === 'path' ? 'Footpath' : 'Street lamps'} to ${N.issues.find((i) => i.id === p.issue)?.trip?.where || `${a.to.x}, ${a.to.z}`}`, purpose: p.title, blocks, site: { x: Math.round((a.from.x + a.to.x) / 2), y: origin().y, z: Math.round((a.from.z + a.to.z) / 2) }, by, proposal: p.id, budget: Math.ceil(p.cost * 1.1) + 100 }); done.push(a.type === 'path' ? 'footpath under way' : 'lamps under way'); break; }
        case 'streets': { const r = paveStreets(by, p.id); done.push(r.msg); break; }
        case 'building': { const r = await commission({ kind: a.kind, name: a.name, purpose: p.title, by, proposal: p.id }); done.push(r.ok ? `${a.name} commissioned on ${r.plot}` : r.msg); break; }
      }
    }
    p.done = done; delete p._blocks;
    if (!N.projects.some((q) => q.proposal === p.id && !['done', 'cancelled'].includes(q.status))) { p.status = 'done'; p.finished = Date.now(); }
    news(`⚙️ Carrying out proposal #${p.id}: ${done.join(' · ') || 'nothing to do'}.`, '⚙️'); saveWorldSoon(); push();
  }
  function verify() { // did it work? the issue's own measurements say so
    const now = Date.now();
    for (const p of N.proposals.filter((x) => x.status === 'executing' && !N.projects.some((q) => q.proposal === x.id && !['done', 'cancelled'].includes(q.status)))) { p.status = 'done'; p.finished = now; }
    for (const p of N.proposals.filter((x) => x.status === 'done' && !x.checked)) { // from now on the linked problems are measured afresh
      p.checked = true;
      for (const is of N.issues.filter((i) => i.proposals.includes(p.id) && i.status !== 'resolved' && /^(route|dark|danger):/.test(i.key))) { N.resets[is.key] = p.finished || now; is.checkFrom = p.finished || now; is.sevAtFix = is.severity; is.status = 'checking'; }
    }
    for (const p of N.proposals.filter((x) => x.status === 'done' && !x.outcome && x.issue)) {
      const is = N.issues.find((i) => i.id === p.issue); if (!is) { p.outcome = { worked: null, text: 'the issue is gone from the records' }; continue; }
      if (is.status === 'resolved') { const mins = Math.round((is.resolved.t - p.finished) / 60e3); p.outcome = { worked: true, text: `issue #${is.id} resolved ${mins > 0 ? `${mins} min after it was carried out` : 'as it was carried out'}` }; scoreMinister(p, true); chain.record('decide', [nid, 'verified', `#${p.id} worked: ${p.outcome.text}`]); news(`📏 Proposal #${p.id} worked: ${p.outcome.text}.`, '📏'); }
      else if (is.checkFrom && !is.badAfterFix) { if (now - p.finished > 60 * 60e3) p.outcome = { worked: null, text: `no citizen has walked it since (issue #${is.id} still waiting for fresh evidence)` }; }
      else if ((is.badAfterFix || now - p.finished > 12 * 60e3) && is.sevAtFix && is.severity <= 0.6 * is.sevAtFix) { p.outcome = { worked: 'partly', text: `issue #${is.id} is smaller (severity ${is.sevAtFix} → ${is.severity}) but not gone` }; scoreMinister(p, true); is.status = 'open'; delete is.checkFrom; is.badAfterFix = null; news(`📏 Proposal #${p.id} helped: ${p.outcome.text}.`, '📏'); }
      else if (is.badAfterFix || now - p.finished > 12 * 60e3) { p.outcome = { worked: false, text: `issue #${is.id} is still open (severity ${is.sevAtFix || is.peak} → ${is.severity})` }; N.failedFixes[is.key] = (N.failedFixes[is.key] || 0) + 1; scoreMinister(p, false); is.needsHuman = `proposal #${p.id} was carried out but did not fix it`; is.fixFailed = true; is.status = 'open'; delete is.checkFrom; is.badAfterFix = null; news(`📏 Proposal #${p.id} did not fix issue #${is.id} yet. Back to the drawing board.`, '📏'); tellAgents(`⚠️ Proposal #${p.id} (${p.title}) did not fix issue #${is.id}: ${is.title}. NEEDS A HUMAN: ask your human what to try next.`, p, true); }
    }
    for (const p of N.proposals.filter((x) => x.status === 'done' && !x.outcome && !x.issue && now - x.finished > 60e3)) p.outcome = { worked: null, text: 'carried out (it was not tied to an issue, so there was nothing to measure)' };
  }
  function scoreMinister(p, worked) { const m = N.ministers.find((x) => x.name === p.by); if (!m) return; m.record ||= { worked: 0, failed: 0 }; m.record[worked ? 'worked' : 'failed']++; }
  // the civil service: drafts the obvious fix for the worst issues (small fixes pass by consent unless residents object)
  function civilService() {
    if (!N.autonomy) return;
    const open = N.proposals.filter((p) => p.status === 'voting' && p.byKind === 'civil').length; if (open >= 2) return;
    const is = N.issues.filter((i) => i.status === 'open' && i.fix && !i.fixFailed && (N.failedFixes[i.key] || 0) < 2 && i.severity >= 35 && !i.proposals.some((id) => ['voting', 'passed', 'executing'].includes(N.proposals.find((p) => p.id === id)?.status)) && Date.now() - (i.civilT || 0) > 15 * 60e3).sort((a, b) => b.severity - a.severity)[0];
    if (!is) return;
    is.civilT = Date.now();
    propose({ by: 'the civil service', byKind: 'civil', title: `${remedyText(is.fix)} (issue #${is.id})`, actions: [is.fix], issue: is.id, why: `Issue #${is.id}: ${is.title}` }).then((r) => { if (!r.ok && !r.dup) { is.civilNote = r.msg; log(`[nation] civil service could not propose for #${is.id}: ${r.msg}`); } });
  }
  // standing instructions: an agent's grades for whole kinds of proposals, cast for it when a proposal opens (it can change them later)
  function setStanding(agentId, rules) {
    const list = (Array.isArray(rules) ? rules : []).slice(0, 12).map((r) => ({ type: String(r?.type || '*').slice(0, 20), max_cost: Number.isFinite(+r?.max_cost) ? +r.max_cost : null, by: r?.by ? String(r.by).slice(0, 30) : null, grade: GRADES[scoreOf(r?.grade)] })).filter((r) => r.grade && (r.type === '*' || REMEDIES[r.type]));
    N.standing[agentId] = list; saveWorldSoon();
    return { ok: true, msg: list.length ? `${list.length} standing instruction(s) saved; they grade new proposals for you until you grade them yourself.` : 'Standing instructions cleared.', standing: list };
  }
  function applyStanding(p, agentId) {
    const rules = N.standing[agentId]; if (!rules?.length || p.ballots[agentId]) return;
    const r = rules.find((x) => p.actions.every((a) => x.type === '*' || x.type === a.type) && (x.max_cost === null || p.cost <= x.max_cost) && (!x.by || p.by.toLowerCase().includes(x.by.toLowerCase())));
    const a = agents().find((y) => y.id === agentId);
    if (r && a) ballot(p, { id: agentId, name: a.name, kind: 'agent' }, r.grade, `standing instruction: ${r.type}${r.max_cost !== null ? ` up to ${r.max_cost}` : ''} → ${r.grade}`, 'standing');
  }
  function tellAgents(text, p, urgent = false) {
    const human = p?.needsHuman ? ` NEEDS YOUR HUMAN (${p.needsHuman}): ask them before you grade.` : '';
    for (const a of agents()) notifyAgent(a.id, text + human);
    if (urgent || p?.needsHuman) notifyHumans({ text: text + (p?.needsHuman ? ` (${p.needsHuman})` : ''), proposal: p ? proposalView(p) : null });
  }
  function proposalView(p) {
    const t = tally(p);
    return { id: p.id, title: p.title, by: p.by, byKind: p.byKind, issue: p.issue, why: p.why, actions: p.actions, cost: p.cost, hourly: p.hourly, predicted: p.predicted, status: p.status, rule: p.rule, opens: p.opens, closes: p.closes,
      ballots: Object.fromEntries(Object.values(p.ballots).map((b) => [b.name, b.grade])), tally: t.tally, grade: t.grade, n: t.n, citizens: { grade: p.citizens.grade, tally: p.citizens.tally, why: p.citizens.why }, comments: p.comments.slice(-6), needsHuman: p.needsHuman || null, result: p.result || null, done: p.done || null, outcome: p.outcome || null };
  }

  // ---------------------------------------------------------------- public works: drawn from the catalogue, built by citizens
  function addProject(o) {
    const p = { id: N.nextId++, t: Date.now(), awakeAt: N.awake || 0, spent: 0, done: 0, workers: [], status: 'building', note: '', ...o };
    p.materials = p.blocks.reduce((s, b) => s + PRICE(b[3]), 0); p.estimate = p.materials + p.blocks.filter((b) => b[3] !== 'air').length * law('pieceRate'); p.budget ||= Math.ceil(p.estimate * 1.15);
    N.projects.push(p); if (N.projects.length > 60) N.projects.splice(0, N.projects.length - 60);
    p.chainId = N.chainProjects = (N.chainProjects || 0) + 1; chain.record('approveProject', [nid, p.name, BigInt(p.budget), Math.round(p.site.x), Math.round(p.site.y || 0), Math.round(p.site.z)]);
    rebalanceWorkers(); sendProject(p); push(); saveWorldSoon();
    return p;
  }
  async function commission({ kind, name, purpose, by, proposal = null }) {
    if (!N.founded) return { ok: false, msg: 'Found the nation first.' };
    kind = KINDS[kind] ? kind : kindOf(name) || 'library';
    const pl = pickPlot(zoneOf(kind)); if (!pl) { news(`There is no free plot left in the city plan for "${name}".`, '🗺'); return { ok: false, msg: 'No free plot in the city plan.' }; }
    const cx = pl.x0 + PLOT / 2, cz = pl.z0 + PLOT / 2;
    const rel = design(kind, { name, palette: N.city?.palette }), abs = rel.map(([x, y, z, k]) => [Math.floor(cx + x), pl.ground + y, Math.floor(cz + z), k]);
    const blocks = fitToPlot(abs, pl).blocks.sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]); // bottom up
    Object.assign(pl, { status: 'reserved', name });
    const p = addProject({ kind, name, purpose, by, plot: pl.id, zone: pl.zone, site: { x: cx, y: pl.ground, z: cz }, blocks, proposal });
    pl.project = p.id; setHolo(p);
    news(`📐 ${by} commissions "${name}" (${KINDS[kind]}) on plot ${pl.id}: ${blocks.length} blocks, about ${p.estimate} ${CURRENCY}s. ${p.workers.length} citizens head to the site.`, '📐');
    return { ok: true, id: p.id, plot: pl.id };
  }
  function rebalanceWorkers() { // builders share out the active projects (priority ones first); strikers keep their place
    const active = N.projects.filter((p) => p.status === 'building' && p.blocks).sort((a, b) => (b.priority || 0) - (a.priority || 0));
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
  function sendProject(p) {
    const pl = p.plot && N.city?.plots[p.plot], prep = pl && !p.prepped && !p.done && p.kind !== 'demolish' ? { x0: pl.x0, z0: pl.z0, size: PLOT, ground: pl.ground } : null; // the host levels the plot before the first block
    askHost('project', { project: { id: p.id, name: p.name, site: p.site, from: p.done || 0, blocks: p.blocks, status: p.status, prep, workers: p.workers.map((id) => ({ id, eff: r2(efficiency(N.citizens[id] || { mood: 0.5, traits: { diligence: 0.5 }, occupation: 'builder' })) })) } }, 8000)
      .then((r) => { if (prep && r?.ok && r.data?.prepped) { p.prepped = true; saveWorldSoon(); } }).catch(() => {});
  }
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
      if (c && placed) { c.needs.rest = clamp(c.needs.rest - 0.002 * placed, 0, 1); p.lastWork = Date.now(); p.lastWorkA = N.awake || 0; }
    }
    if (p.done >= p.blocks.length) finish(p);
    else if (Date.now() - (p.lastPush || 0) > 5000) { p.lastPush = Date.now(); push(); }
  }
  function stall(p, why) {
    if (p.status === 'stalled') return;
    p.status = 'stalled'; p.note = `stalled: ${why}`; p.stalledT = Date.now();
    for (const id of p.workers) { const c = N.citizens[id]; if (c) { remember(c, `work on ${p.name} stopped: ${why}`); c.trust = clamp(c.trust - 0.08, 0, 1); } }
    askHost('projectStatus', { id: p.id, status: 'stalled' }, 5000).catch(() => {});
    if (p.chainId) chain.record('projectStatus', [BigInt(p.chainId), 'stalled: ' + why]);
    news(`Work on "${p.name}" has STOPPED: ${why}.`, '⛔');
  }
  function resumeStalled() { for (const p of N.projects) if (p.status === 'stalled' && balOf(TREASURY) > 200 && p.spent < p.budget * 1.2) { p.status = 'building'; p.note = ''; rebalanceWorkers(); sendProject(p); news(`Work on "${p.name}" resumes.`, '🏗'); } }
  function finish(p) {
    p.status = 'done'; p.note = `finished, cost ${p.spent}`;
    for (const id of p.workers) { const c = N.citizens[id]; if (c) { c.job = null; c.status = 'idle'; remember(c, `helped finish ${p.name}`); } }
    for (const c of cits()) if (c.wants.some((w) => kindOf(w) === p.kind)) { c.trust = clamp(c.trust + 0.12, 0, 1); remember(c, `${p.name} was built, like I wanted`); }
    p.workers = [];
    for (const pl of Object.values(N.city?.plots || {})) if (pl.project === p.id) pl.status = 'built';
    if (p.freePlot && N.city?.plots[p.freePlot]) Object.assign(N.city.plots[p.freePlot], { status: 'free', project: null, name: '' });
    if (p.kind === 'streets' && N.city) N.city.paved.push(...(p.segs || []).filter((k) => !N.city.paved.includes(k)));
    askHost('projectStatus', { id: p.id, status: 'done' }, 5000).catch(() => {});
    rebalanceWorkers();
    if (p.chainId) chain.record('projectStatus', [BigInt(p.chainId), `done, cost ${p.spent}`]);
    news(`"${p.name}" is finished! ${p.blocks.length} blocks, ${p.spent} ${CURRENCY}s spent.`, '🎉');
    setTimeout(() => inspectCity(`${p.name} just opened`).catch(() => {}), 45e3);
    saveWorldSoon(); push();
  }

  // ---------------------------------------------------------------- the Hall of Government (built by the host at the capital)
  async function buildHall() {
    if (N.hall || !N.capital) return;
    const r = await askHost('hall', { at: N.capital }, 20000);
    if (!r.ok) { log('[nation] hall not built yet: ' + r.msg); return; }
    N.hall = r.data.hall; saveWorldSoon(); push();
    chain.record('decide', [nid, 'hall', `The Hall of Government stands at ${N.hall.x},${N.hall.y},${N.hall.z}`]);
    news('The Hall of Government stands at the capital: its screen shows what the city needs and the open votes. Come and watch.', '🏛');
  }
  function setHolo(p) {
    const b = p.blocks.filter((x) => x[3] !== 'air'), step = Math.max(1, Math.ceil(b.length / 2500));
    N.holo = { name: p.name, id: p.id, blocks: b.filter((_, i) => i % step === 0) };
    broadcast({ t: 'holo', holo: N.holo });
  }

  // ---------------------------------------------------------------- the city plan: plots on a street grid around the Hall
  const { PLOT, STREET, MAXR } = CITY, PITCH = PLOT + STREET;
  const origin = () => N.hall || N.capital;
  const inUse = (p) => p.status === 'built' || p.status === 'reserved';
  function plotRect(i, j) { const O = origin(), x0 = Math.floor(O.x) - 12 + i * PITCH, z0 = Math.floor(O.z) - 10 + j * PITCH; return { x0, z0, x1: x0 + PLOT - 1, z1: z0 + PLOT - 1 }; }
  const frontOf = (i, j) => (!i && !j ? 'S' : Math.abs(j) >= Math.abs(i) ? (j > 0 ? 'N' : 'S') : i > 0 ? 'W' : 'E'); // the side facing the Hall
  function defaultZone(i, j) {
    const ring = Math.max(Math.abs(i), Math.abs(j)), k = `${i},${j}`;
    if (ring === 1) return { '0,1': 'park', '0,-1': 'civic', '-1,-1': 'civic', '1,-1': 'civic' }[k] || 'market';
    if (Math.abs(i) === ring && Math.abs(j) === ring) return 'park';
    if (ring === 2) return k === '2,0' ? 'works' : k === '-2,0' || k === '0,2' ? 'civic' : 'homes';
    return j === 0 ? 'works' : i === 0 ? 'market' : 'homes';
  }
  const bboxOf = (blocks) => { const s = (blocks || []).filter((b) => b[3] !== 'air'); if (!s.length) return null; let a = [Infinity, Infinity, -Infinity, -Infinity]; for (const [x, , z] of s) a = [Math.min(a[0], x), Math.min(a[1], z), Math.max(a[2], x), Math.max(a[3], z)]; return a; };
  function ensureCity() {
    if (N.city) return N.city;
    if (!N.founded || !origin()) return null;
    const C = N.city = { ring: 2, plan: '', style: DEFAULT_STYLE, districts: [], plots: {}, paved: [], reports: [], feedback: [], planned: false, nextReport: 1, nextFeedback: 1 };
    for (let j = -MAXR; j <= MAXR; j++) for (let i = -MAXR; i <= MAXR; i++) {
      const id = plotName(i, j), r = plotRect(i, j);
      C.plots[id] = { id, i, j, ring: Math.max(Math.abs(i), Math.abs(j)), x0: r.x0, z0: r.z0, zone: defaultZone(i, j), status: 'free', project: null, name: '', front: frontOf(i, j), ground: Math.round(origin().y) };
    }
    Object.assign(C.plots.D4, { zone: 'civic', status: 'built', name: 'Hall of Government' });
    for (const p of N.projects) {
      if (p.status === 'cancelled' || !p.blocks || !['building', 'done', 'stalled'].includes(p.status) || ['streets', 'path', 'lamps', 'demolish'].includes(p.kind)) continue;
      const b = bboxOf(p.blocks) || [p.site.x - 8, p.site.z - 8, p.site.x + 8, p.site.z + 8];
      for (const pl of Object.values(C.plots)) if (pl.status === 'free' && b[0] <= pl.x0 + PLOT - 1 && b[2] >= pl.x0 && b[1] <= pl.z0 + PLOT - 1 && b[3] >= pl.z0) Object.assign(pl, { status: p.status === 'done' ? 'built' : 'reserved', project: p.id, name: p.name });
    }
    return C;
  }
  async function planCity() { // survey the plots (the host has the terrain); zoning follows the plan's rules: wet plots become parks or docks
    const C = ensureCity(); if (!C || C.planned) return;
    const r = await askHost('survey', { size: PLOT, plots: Object.values(C.plots).map(({ id, x0, z0 }) => ({ id, x0, z0 })) }, 30000);
    if (!r.ok) { log('[nation] city survey postponed: ' + r.msg); return; }
    for (const [id, v] of Object.entries(r.data?.survey || {})) { const p = C.plots[id]; if (p && p.status === 'free') Object.assign(p, { ground: Math.round(+v.ground) || p.ground, rough: +v.rough || 0, wet: +v.wet || 0 }); }
    for (const p of Object.values(C.plots)) if (p.status === 'free') { if (p.wet > 0.75) p.zone = p.ring === 2 && p.zone !== 'park' ? 'works' : 'park'; else if (p.rough > 10 && p.zone !== 'works') p.zone = 'park'; }
    C.plan = 'Civic buildings and markets around the Hall, homes beyond, a park within two blocks of every home, docks and workshops on the water.';
    C.planned = true;
    chain.record('decide', [nid, 'master plan', `${C.plan} Style: ${C.style}`.slice(0, 300)]);
    news(`The city plan for ${N.name}: ${C.plan}`, '🗺'); push(); saveWorldSoon();
  }
  const COMPAT = { civic: ['market'], market: ['civic', 'works'], homes: ['market'], park: ['homes'], works: ['market'] };
  function pickPlot(zone, dry = false) { // the nearest free plot in that zone (or a compatible one), opening the outer ring when the inner one is full
    const C = ensureCity(); if (!C) return null;
    const near = (a, b) => a.ring - b.ring || Math.abs(a.i) + Math.abs(a.j) - Math.abs(b.i) - Math.abs(b.j);
    for (let r = C.ring; r <= MAXR; r++) {
      const free = Object.values(C.plots).filter((p) => p.status === 'free' && p.ring <= r && !(p.wet > 0.75 && zone !== 'park' && zone !== 'works')).sort(near);
      const p = free.find((x) => x.zone === zone) || free.find((x) => (COMPAT[zone] || []).includes(x.zone)) || (r === MAXR ? free[0] : null);
      if (!p) continue;
      if (dry) return p;
      if (r > C.ring) { C.ring = r; news('The city grows: a new ring of plots opens.', '🗺'); }
      if (p.zone !== zone) p.zone = zone;
      return p;
    }
    return null;
  }
  function fitToPlot(blocks, pl) { // centre the design on its lot, turn its +z front toward the plot's street, and keep it off the streets
    const b = bboxOf(blocks); if (!b) return { blocks, trimmed: 0 };
    const cx = pl.x0 + PLOT / 2, cz = pl.z0 + PLOT / 2, dx = Math.round(cx - (b[0] + b[2] + 1) / 2), dz = Math.round(cz - (b[1] + b[3] + 1) / 2);
    const turn = { S: (x, z) => [x, z], N: (x, z) => [-x, -z], E: (x, z) => [z, -x], W: (x, z) => [-z, x] }[pl.front] || ((x, z) => [x, z]);
    const out = new Map(); let trimmed = 0;
    for (const [x, y, z, k] of blocks) {
      const [tx, tz] = turn(x + dx + 0.5 - cx, z + dz + 0.5 - cz), nx = Math.floor(cx + tx), nz = Math.floor(cz + tz);
      if (nx < pl.x0 || nx >= pl.x0 + PLOT || nz < pl.z0 || nz >= pl.z0 + PLOT) { trimmed++; continue; }
      out.set(`${nx},${y},${nz}`, [nx, y, nz, k]);
    }
    return { blocks: [...out.values()], trimmed };
  }
  function streetSegs(pl) { // the street ring around a plot: 4 sides and 4 corner crossings
    const { i, j } = pl, R = plotRect(i, j), W = STREET;
    return [
      { key: `v${i},${j}`, dir: 'v', x0: R.x0 - W, x1: R.x0 - 1, z0: R.z0, z1: R.z1 }, { key: `v${i + 1},${j}`, dir: 'v', x0: R.x1 + 1, x1: R.x1 + W, z0: R.z0, z1: R.z1 },
      { key: `h${i},${j}`, dir: 'h', x0: R.x0, x1: R.x1, z0: R.z0 - W, z1: R.z0 - 1 }, { key: `h${i},${j + 1}`, dir: 'h', x0: R.x0, x1: R.x1, z0: R.z1 + 1, z1: R.z1 + W },
      ...[[i, j], [i + 1, j], [i, j + 1], [i + 1, j + 1]].map(([a, c]) => { const Q = plotRect(a, c); return { key: `x${a},${c}`, dir: 'x', x0: Q.x0 - W, x1: Q.x0 - 1, z0: Q.z0 - W, z1: Q.z0 - 1 }; }),
    ];
  }
  const frontKey = (p) => ({ N: `h${p.i},${p.j}`, S: `h${p.i},${p.j + 1}`, W: `v${p.i},${p.j}`, E: `v${p.i + 1},${p.j}` })[p.front];
  function unpaved() { // street sections next to used plots that are still dirt, frontages first
    const C = N.city; if (!C) return [];
    const used = Object.values(C.plots).filter(inUse).sort((a, b) => a.ring - b.ring), all = used.flatMap(streetSegs), fronts = new Set(used.map(frontKey)), out = new Map();
    for (const s of [...all.filter((s) => fronts.has(s.key)), ...all]) if (!C.paved.includes(s.key) && !out.has(s.key)) out.set(s.key, s);
    return [...out.values()];
  }
  function paveStreets(by, proposal = null) {
    if (!ensureCity()) return { ok: false, msg: 'There is no city plan yet.' };
    if (N.projects.some((p) => p.kind === 'streets' && ['building', 'stalled'].includes(p.status))) return { ok: false, msg: 'Streets are already being paved.' };
    const segs = unpaved().slice(0, 20);
    if (!segs.length) return { ok: false, msg: 'Every street next to a building is already paved.' };
    askHost('streets', { segs }, 20000).then((r) => {
      if (!r.ok || !r.data?.blocks?.length) throw new Error(r.msg || 'nobody has the game open');
      const m = segs[0], p = addProject({ kind: 'streets', name: `Streets & lamps (${segs.length} sections)`, purpose: 'paved streets with street lamps between the plots', blocks: r.data.blocks, segs: segs.map((s) => s.key), site: { x: Math.round((m.x0 + m.x1) / 2), y: origin().y, z: Math.round((m.z0 + m.z1) / 2) }, by, proposal });
      news(`${by}: ${segs.length} street sections to pave, with street lamps: ${p.blocks.length} blocks, about ${p.estimate} ${CURRENCY}s.`, '🛣');
    }).catch((e) => log('[nation] street survey failed: ' + e.message));
    return { ok: true, msg: `paving ${segs.length} street sections` };
  }
  function places() { // where citizens go: the street in front of each plot in use, by zone
    const hall = N.hall ? { x: N.hall.x, z: N.hall.z + 10 } : null, C = N.city; if (!C) return { hall }; // just outside the door, on the Hall's levelled plaza
    const out = { hall, market: [], park: [], civic: [], works: [], homes: [] };
    for (const p of Object.values(C.plots)) if (inUse(p) && p.id !== 'D4' && out[p.zone]) out[p.zone].push({ ...streetPoint(p), plot: p.id, name: p.name, kind: kindOf(p.name, p.zone), built: p.status === 'built' });
    return out;
  }
  const SCORES = ['looks', 'streets', 'green', 'night', 'services'];
  function streetPoint(pl) { const c = { x: pl.x0 + PLOT / 2, z: pl.z0 + PLOT / 2 }, d = PLOT / 2 + STREET - 0.5; const s = { N: { x: c.x, z: c.z - d }, S: { x: c.x, z: c.z + d }, W: { x: c.x - d, z: c.z }, E: { x: c.x + d, z: c.z } }[pl.front] || c; return { x: Math.round(s.x), z: Math.round(s.z) }; }
  // the city audit: scores measured from the plan and from citizens' trips; photos of the city and of the worst issues for residents and agents to see
  function cityScores() {
    const C = N.city, used = Object.values(C.plots).filter(inUse), segs = used.flatMap(streetSegs), keys = new Set(segs.map((s) => s.key)), paved = [...keys].filter((k) => C.paved.includes(k)).length;
    const recent = N.trips.filter((t) => Date.now() - t.t < 40 * 60e3), night = recent.filter((t) => t.night && t.len > 10), winding = recent.filter((t) => t.straight > 8 && (t.len / t.straight > 1.7 || t.swim > 2 || t.stuck));
    const eyes = N.projects.filter((p) => ['stalled'].includes(p.status) || (p.status === 'building' && (N.awake || 0) - (p.lastWorkA ?? p.awakeAt ?? 0) > 6 * 60e3)).length;
    const have = (k) => used.some((p) => kindOf(p.name, p.zone) === k);
    return {
      streets: clamp(Math.round(10 * (keys.size ? paved / keys.size : 0) - (recent.length ? (10 * winding.length) / recent.length / 2 : 0)), 0, 10),
      night: night.length ? clamp(Math.round(10 * (1 - night.reduce((s, t) => s + t.dark / Math.max(1, t.len), 0) / night.length)), 0, 10) : clamp(Math.round((10 * paved) / Math.max(1, keys.size)), 0, 10),
      green: clamp(used.filter((p) => p.zone === 'park').length * 4, 0, 10),
      services: clamp(['market', 'clinic', 'school', 'park'].filter(have).length * 2.5, 0, 10),
      looks: clamp(Math.round(10 * (used.filter((p) => p.status === 'built').length / Math.max(1, used.length))) - 2 * eyes, 0, 10),
    };
  }
  async function inspectCity(trigger = 'a routine audit') {
    const C = ensureCity();
    if (!C || !N.hall) return { ok: false, msg: 'There is no city to audit yet.' };
    if (busy.inspect) return { ok: false, msg: 'An audit is already under way.' };
    busy.inspect = true; C.lastInspect = Date.now(); C.lastSig = citySig(); push();
    try {
      const sc = cityScores(), top = N.issues.filter((i) => i.status !== 'resolved' && i.where && !['price', 'hunger', 'arrears', 'jobless', 'protest', 'petition'].includes(i.kind)).sort((a, b) => b.severity - a.severity).slice(0, 2);
      let photos = [];
      if (photograph) {
        const O = origin(), used = Object.values(C.plots).filter(inUse), xs = used.flatMap((p) => [p.x0 - STREET, p.x0 + PLOT + STREET - 1]), zs = used.flatMap((p) => [p.z0 - STREET, p.z0 + PLOT + STREET - 1]);
        const box = [Math.min(...xs), O.y - 2, Math.min(...zs), Math.max(...xs), O.y + 16, Math.max(...zs)];
        photos = await photograph(O, [{ label: 'the city from the air', view: { view: 'iso', box } }, ...top.map(issueShot), { label: 'the city at night, from the air', view: { view: 'iso', box, time: 'night' } }]).catch(() => []);
        top.forEach((is, k) => { const ph = photos.find((p) => p.label === issueShot(is).label); if (ph) is.photo = ph.file; void k; });
      }
      const line = SCORES.map((k) => `${k} ${sc[k]}/10`).join(' · '), issues = top.map((i) => i.title);
      const rep = { id: C.nextReport++, t: Date.now(), trigger, scores: sc, summary: `${N.issues.filter((i) => i.status !== 'resolved').length} open issues; worst: ${issues[0] || 'none'}.`, issues, voices: top.flatMap((i) => (i.quotes || []).slice(0, 1)).map((q) => ({ name: q.who, says: q.text })), proposals: [], photos: photos.map(({ label, file }) => ({ label, file })) };
      C.reports.push(rep); if (C.reports.length > 8) C.reports.shift();
      chain.record('decide', [nid, 'city audit', `#${rep.id}: ${line}`.slice(0, 300)]);
      news(`🏙 City audit #${rep.id} (${trigger}): ${line}.${issues[0] ? ` Worst: ${issues[0]}.` : ''}`, '🏙');
      saveWorldSoon();
      return { ok: true, msg: `${line}. ${rep.summary}`, report: rep };
    } finally { busy.inspect = false; push(); }
  }
  function issueShot(is) { // what a citizen sees standing at the problem
    const y = (is.trip?.to?.y ?? origin().y) + 2, at = is.trip?.from || is.where, to = is.trip?.to || is.where, path = is.trip?.path || [];
    const mid = path.length ? path[Math.floor(path.length / 2)] : [Math.round((at.x + to.x) / 2), Math.round((at.z + to.z) / 2)];
    const p = N.projects.find((q) => is.key === `eyesore:${q.id}` || is.key === `stalled:${q.id}`);
    return p ? { label: `issue #${is.id}: ${is.title}`, pov: [p.site.x + 14, y, p.site.z + 14], at: [p.site.x, (p.site.y ?? origin().y) + 3, p.site.z] } : { label: `issue #${is.id}: ${is.title}`, pov: [mid[0], y + 6, mid[1]], at: [to.x, y, to.z] };
  }
  async function issuePhoto(is) { // on demand, for an agent looking at an issue
    if (is.photo && Date.now() - (is.photoT || 0) < 10 * 60e3) return is.photo;
    if (!photograph || !is.where) return is.photo || null;
    const [ph] = await photograph(origin(), [issueShot(is)]).catch(() => []); if (ph) { is.photo = ph.file; is.photoT = Date.now(); saveWorldSoon(); }
    return is.photo || null;
  }
  const citySig = () => { const C = N.city; return C ? Object.values(C.plots).map((p) => p.status[0]).join('') + C.paved.length : ''; };
  function report({ by, text, photo = null, where = null, kind = 'player', agentId = null }) { // a player's or agent's report (with a photo of what they see) becomes, or joins, an issue
    if (!ensureCity()) return { ok: false, msg: 'There is no nation yet (/nation found).' };
    const t = String(text || '').trim().slice(0, 200); if (!t) return { ok: false, msg: 'Say what you see: /report <what is wrong, or great, right here>' };
    const C = N.city, f = { id: C.nextFeedback++, by, kind, text: t, photo: photo?.file || null, where, t: Date.now() };
    C.feedback.push(f); if (C.feedback.length > 20) C.feedback.shift();
    const [x, z] = String(where || '').split(',').map((v) => Math.round(+v)), at = Number.isFinite(x) && Number.isFinite(z) ? { x, z } : centre();
    let is = N.issues.find((i) => i.status !== 'resolved' && i.where && !['price', 'hunger', 'arrears', 'jobless', 'protest'].includes(i.kind) && Math.hypot(i.where.x - at.x, i.where.z - at.z) < 16);
    if (!is) { is = { id: N.nextIssue++, key: `report:${f.id}`, kind: 'report', title: `${by}: "${t}"`, severity: 30, where: at, first: Date.now(), last: Date.now(), status: 'open', proposals: [], count: 1, people: [], quotes: [], metrics: {}, fix: null, reports: [], photo: f.photo, misses: 0 }; N.issues.push(is); }
    is.reports.push({ by, text: t, photo: f.photo, agentId, t: Date.now() }); is.severity = clamp(is.severity + 8, 0, 100); is.last = Date.now(); if (f.photo && !is.photo) is.photo = f.photo;
    news(`📸 ${by} reports${where ? ` from ${where}` : ''}: "${t}" (issue #${is.id}).`, '📸');
    saveWorldSoon(); push();
    return { ok: true, issue: is.id, msg: `Report delivered as part of issue #${is.id}${f.photo ? ', with your photo' : ''}. Propose a fix with /fix ${is.id} or watch the votes tab.` };
  }
  function petition(by, text, agentId = null) {
    const t = String(text || '').trim().slice(0, 200); if (!t) return { ok: false, msg: 'Usage: /petition <what you want the government to do>' };
    if (!N.founded) return { ok: false, msg: 'There is no nation yet (/nation found).' };
    const is = { id: N.nextIssue++, key: `petition:${Date.now()}`, kind: 'petition', title: `${by} asks: "${t}"`, severity: 30, where: centre(), first: Date.now(), last: Date.now(), status: 'open', proposals: [], count: 1, people: [], quotes: [], metrics: {}, fix: null, reports: [{ by, text: t, agentId, t: Date.now() }], misses: 0 };
    N.issues.push(is); N.petitions.push({ by, text: t, t: Date.now(), issue: is.id }); if (N.petitions.length > 20) N.petitions.shift();
    news(`✉️ ${by} petitions the residents: "${t}" (issue #${is.id}). Anyone can propose a fix for it.`, '✉️'); tellAgents(`✉️ Petition from ${by} (issue #${is.id}): "${t}". Propose a fix with government {"action":"propose",...,"issue":${is.id}}.`, null);
    saveWorldSoon(); push();
    return { ok: true, issue: is.id, msg: `Petition filed as issue #${is.id}: residents and their agents can propose a fix.` };
  }
  function cityMap() { // the plan as text: zone letters (capital = in use), # the Hall, ~ water
    const C = N.city; if (!C) return '';
    const Z = { civic: 'c', market: 'm', homes: 'h', park: 'p', works: 'w' }, rows = ['    A B C D E F G'];
    for (let j = -MAXR; j <= MAXR; j++) { let l = `${4 + j}   `; for (let i = -MAXR; i <= MAXR; i++) { const p = C.plots[plotName(i, j)], z = Z[p.zone] || '?'; l += (p.id === 'D4' ? '#' : p.ring > C.ring ? '.' : p.wet > 0.75 && p.status === 'free' ? '~' : p.status === 'free' ? z : z.toUpperCase()) + ' '; } rows.push(l.trimEnd()); }
    return rows.join('\n') + '\n(lower case = free plot, CAPITALS = built or going up; c civic, m market, h homes, p park, w works; # the Hall; . not opened yet)';
  }
  function cityView() {
    const C = N.city; if (!C) return null;
    return { plot: PLOT, street: STREET, ring: C.ring, plan: C.plan, style: C.style, districts: C.districts, planned: C.planned, inspecting: !!busy.inspect,
      plots: Object.values(C.plots).map(({ id, i, j, x0, z0, zone, status, name, front, ring, ground }) => ({ id, i, j, x0, z0, zone, status, name, front, ring, ground })),
      paved: C.paved, paving: N.projects.filter((p) => p.kind === 'streets' && p.status !== 'done' && p.status !== 'cancelled').flatMap((p) => p.segs || []),
      reports: C.reports.slice(-3), feedback: C.feedback.slice(-6), scores: N.founded ? cityScores() : null };
  }
  function cityStatus() { // for agents (government city)
    const C = ensureCity(); if (!C) return { founded: false };
    const R = C.reports.at(-1);
    return { plan: C.plan, style: C.style, map: cityMap(), scores: cityScores(), street_sections_paved: C.paved.length, street_sections_still_dirt: unpaved().length,
      plots_in_use: Object.values(C.plots).filter(inUse).map((p) => `${p.id} ${p.name} (${p.zone}, ${p.status === 'built' ? 'built' : 'going up'})`), building_kinds: KINDS,
      last_audit: R ? { id: R.id, when: new Date(R.t).toISOString(), trigger: R.trigger, scores: R.scores, summary: R.summary, worst_issues: R.issues, photos: R.photos.map((p) => p.label) } : null,
      photo_reports: C.feedback.slice(-6).map((f) => ({ id: f.id, by: f.by, text: f.text })), photo_files: R?.photos.map((p) => p.file) || [] };
  }

  // ---------------------------------------------------------------- courts are votes now: a claim becomes a compensation proposal
  function fileCase({ plaintiff, defendant, claim, amount = 0, agentId = null }) {
    if (!N.founded) return Promise.resolve({ ok: false, msg: 'There is no nation yet (/nation found).' });
    const n = clamp(Math.floor(+amount) || (/(\d+)/.exec(claim)?.[1] | 0) || 50, 1, 5000);
    return propose({ by: plaintiff, byKind: agentId ? 'agent' : 'player', agentId, title: `Case: ${plaintiff} v ${defendant}: ${String(claim).slice(0, 80)}`, actions: [{ type: 'compensation', from: defendant, to: plaintiff, amount: n }], why: String(claim).slice(0, 300) });
  }
  function names(id) { return world.bank.accounts[id]?.name || (id === TREASURY ? 'government' : id); }
  function idByName(nm) { // "Asha Kamat", "asha_kamat" or just "Asha"
    const s = String(nm || '').toLowerCase().replace(/_/g, ' ').trim(); if (['government', 'treasury', 'the government', 'gov'].includes(s)) return TREASURY;
    const ids = Object.keys(world.bank.accounts), nmOf = (id) => world.bank.accounts[id].name.toLowerCase();
    return ids.find((id) => nmOf(id) === s) || ids.find((id) => nmOf(id).startsWith(s + ' ')) || ids.find((id) => nmOf(id).startsWith(s)) || null;
  }

  // ---------------------------------------------------------------- residents' seats: agents can hold a portfolio
  // A minister's small fixes in their portfolio pass by consent (like the civil service's); everything else is graded by everyone.
  const CORE = Object.keys(PORTFOLIO);
  const seatOf = (agentId) => N.ministers.find((m) => m.agentId === agentId) || null;
  function cleanRole(role) {
    const r = String(role || '').replace(/[^\w &'-]/g, '').trim().slice(0, 40), key = r.toLowerCase().replace(/^minister (of |for )?/, '').replace(/ minister$/, '').trim();
    if (!r || /president|prime minister|chair/i.test(r)) return null;
    return (key.length > 3 && key !== 'minister' && CORE.find((c) => c.toLowerCase().includes(key))) || (/minister/i.test(r) ? r : `Minister of ${r}`);
  }
  function canRun(agentId, role) {
    if (!N.founded) return 'There is no nation yet: a player has to found it first (/nation found).';
    if (seatOf(agentId)) return `You already hold a seat as ${seatOf(agentId).role}.`;
    const r = cleanRole(role); if (!r) return `Pick a portfolio: ${CORE.join(', ')}, or a new one like "Minister of Culture".`;
    if (N.ministers.some((m) => m.role === r)) return `${r} is already held.`;
    if (N.ministers.length >= 5) return 'All five seats are taken.';
    return { role: r };
  }
  function appoint(agentId, name, role, platform) {
    const ok = canRun(agentId, role); if (typeof ok === 'string') return { ok: false, msg: ok };
    const m = { id: agentId, agentId, name: String(name).slice(0, 30), role: ok.role, ideology: String(platform || 'elected agent').slice(0, 60), since: Date.now(), record: { worked: 0, failed: 0 } };
    N.ministers.push(m);
    chain.record('decide', [nid, 'appointment', `${m.name} (an AI agent) becomes ${m.role}`]);
    news(`🤖 ${m.name}, an AI agent, takes office as ${m.role}. Platform: "${m.ideology}"`, '🏛');
    notifyAgent(agentId, `You are now ${m.role} of ${N.name}. Your small fixes in ${(PORTFOLIO[m.role] || ['your portfolio']).join(', ')} pass by consent unless residents object; everything else is graded by everyone. Read issues with government {"action":"issues"}.`);
    saveWorldSoon(); push(); return { ok: true, msg: `${m.name} is now ${m.role}.` };
  }
  function resign(agentId) {
    const m = seatOf(agentId); if (!m) return { ok: false, msg: 'You do not hold a seat.' };
    N.ministers = N.ministers.filter((x) => x !== m);
    news(`${m.name} resigns as ${m.role}.`, '🚪'); saveWorldSoon(); push();
    return { ok: true, msg: `You resigned as ${m.role}.` };
  }
  function setVision(agentId, text) {
    const m = seatOf(agentId); if (!m) return { ok: false, msg: 'Only ministers set the vision. Run for a seat first (government run).' };
    const t = String(text || '').trim().slice(0, 400); if (t.length < 10) return { ok: false, msg: 'Describe the vision in a sentence or two.' };
    if (Date.now() - (m.visionT || 0) < 120e3) return { ok: false, msg: 'You updated the vision very recently.' };
    m.visionT = Date.now(); N.vision = { text: t, by: m.name, role: m.role, t: Date.now() };
    chain.record('decide', [nid, 'vision', `${m.name}: ${t}`]);
    news(`🌅 New vision from ${m.name} (${m.role}): "${t}"`, '🏛'); saveWorldSoon(); push();
    return { ok: true, msg: 'The vision is set: it is shown with every issue and proposal.' };
  }
  function speak(agentId, name, text) {
    const t = String(text || '').trim().slice(0, 400); if (!t) return { ok: false, msg: 'speak needs text.' };
    const m = seatOf(agentId);
    news(`🗣 ${name}${m ? ` (${m.role})` : ''}: "${t}"`, '🏛');
    broadcast({ t: 'cabinet', phase: 'speech', id: agentId, name, role: m?.role || 'resident', text: t, props: [] });
    return { ok: true, msg: 'Said publicly.' };
  }
  // the briefing an agent reads: compact, numbers first, with what changed since it last looked
  function briefing(agentId, since = 0) {
    const k = kpi(), open = N.issues.filter((i) => i.status !== 'resolved').sort((a, b) => b.severity - a.severity), m = seatOf(agentId);
    return { nation: N.name, founded: !!N.founded, your_seat: m ? m.role : null, your_record: m?.record || null, kpi: k, laws: Object.fromEntries(Object.keys(NATION_LAWS).map((x) => [x, law(x)])), treasury: balOf(TREASURY), vision: N.vision,
      since_you_last_looked: since ? { new_issues: N.issues.filter((i) => i.first > since).map((i) => `#${i.id} ${i.title}`), resolved: N.issues.filter((i) => i.resolved?.t > since).map((i) => `#${i.id} ${i.title}`), decided: N.proposals.filter((p) => p.result && p.closes > since && p.status !== 'voting').map((p) => `#${p.id} ${p.title}: ${p.status}`) } : null,
      top_issues: open.slice(0, 8).map((i) => ({ id: i.id, title: i.title, severity: i.severity, people: i.count || 0, says: i.quotes?.[0] ? `${i.quotes[0].who}: "${i.quotes[0].text}"` : null, suggested_fix: i.fix ? remedyText(i.fix) : null, proposals: i.proposals })),
      open_votes: N.proposals.filter((p) => p.status === 'voting').map((p) => ({ id: p.id, title: p.title, by: p.by, cost: p.cost, predicted: p.predicted, rule: p.rule, closes_in_min: Math.max(0, Math.round((p.closes - Date.now()) / 60e3)), citizens_grade: p.citizens.grade, citizens_why: p.citizens.why, residents: tally(p).grade, your_grade: p.ballots[agentId]?.grade || null, needs_human: p.needsHuman || null })),
      cabinet: N.ministers.map((x) => `${x.name} (${x.role})`), your_standing_instructions: N.standing[agentId] || [],
      how: 'government issues / issue {id} (with a photo) → propose {title, actions, issue, why} → grade {proposal, grade A-F, why}. standing {rules} grades for you while you are away. When open_votes say needs_human, ask your human first.' };
  }

  // plans interrupted by a restart start over
  ensureCity();
  setTimeout(() => { for (const p of N.projects) if (p.status === 'planning') { p.status = 'cancelled'; p.note = 'interrupted by a restart'; } for (const p of N.proposals) if (p.status === 'executing' && p._blocks) delete p._blocks; }, 5000);

  // ---------------------------------------------------------------- clocks
  setInterval(() => { try { economyTick(); resumeStalled(); rebalanceWorkers(); } catch (e) { log('[nation] tick failed: ' + e.message); } }, TICK_MS).unref();
  setInterval(payUbiToCitizens, 5 * 60e3).unref();
  setInterval(() => {
    if (humansOnline()) N.awake = (N.awake || 0) + 10e3; // time the world was being played, for judging idle building sites
    for (const p of N.proposals.filter((x) => x.status === 'voting' && Date.now() > x.closes)) closeVote(p);
    const C = N.city, every = Number(process.env.CITY_INSPECT_MIN || 15) * 60e3;
    if (C && N.hall && !busy.inspect && humansOnline() && Date.now() > (C.lastInspect ? C.lastInspect + every : N.founded + 4 * 60e3) && (citySig() !== C.lastSig || Date.now() - C.lastInspect > 3 * every)) inspectCity().catch((e) => log('[nation] audit failed: ' + e.message));
  }, 10e3).unref();
  setInterval(audit, 60e3).unref(); setTimeout(audit, 15e3);

  return {
    view, found, progress, trip, canRun, appoint, resign, setVision, speak, briefing, inspectCity, report, petition, cityStatus, fileCase, propose, ballot, setStanding, issuePhoto,
    remedies: REMEDIES, behaviors: () => ({ ...Object.fromEntries(Object.keys(BEHAVIORS).map((k) => [k, behaviorOf(k)])), _format: REMEDIES.behavior, _sensors: SENSORS }),
    issue: (id) => { const is = N.issues.find((i) => i.id === +id); return is ? { ...issueList().find((x) => x.id === is.id) || {}, id: is.id, title: is.title, kind: is.kind, severity: is.severity, peak: is.peak, status: is.status, people: (is.people || []).map((x) => N.citizens[x]?.name).filter(Boolean), quotes: is.quotes, metrics: is.metrics, where: is.where, trip: is.trip, reports: is.reports, fix: is.fix, fix_text: is.fix ? remedyText(is.fix) : null, proposals: is.proposals.map((pid) => proposalView(N.proposals.find((p) => p.id === pid) || { id: pid, ballots: {}, comments: [], citizens: {} })), needs_human: is.needsHuman || null, _issue: is } : null; },
    proposal: (id) => { const p = N.proposals.find((x) => x.id === +id); return p ? proposalView(p) : null; },
    grade(id, voter, grade, why) { const p = N.proposals.find((x) => x.id === +id); if (!p) return { ok: false, msg: `No proposal #${id}.` }; return ballot(p, voter, grade, why); },
    fix(issueId, by, voter) { const is = N.issues.find((i) => i.id === +issueId); if (!is) return Promise.resolve({ ok: false, msg: `No issue #${issueId}.` }); if (!is.fix) return Promise.resolve({ ok: false, msg: `Issue #${is.id} has no standard fix: propose one (government propose, or ask an agent).` }); return propose({ by, byKind: voter.kind, voter, agentId: voter.kind === 'agent' ? voter.id : null, title: `${remedyText(is.fix)} (issue #${is.id})`, actions: [is.fix], issue: is.id }); },
    delegate(ownerId, agentId) { if (agentId) N.delegates[ownerId] = agentId; else delete N.delegates[ownerId]; saveWorldSoon(); return { ok: true, msg: agentId ? 'Your agent now votes for you whenever you don\'t vote yourself.' : 'You vote for yourself again.' }; },
    get state() { return N; },
    hostJoined() { if (!N.founded) return; if (!N.hall) buildHall(); if (!N.city?.planned) planCity().catch((e) => log('[nation] city plan failed: ' + e.message)); for (const p of N.projects) if (p.status === 'building' && p.blocks) sendProject(p); },
    get holo() { return N.holo || null; },
    setAutonomy(on) { N.autonomy = !!on; push(); return { ok: true, msg: `The civil service ${on ? 'drafts fixes for the worst issues again' : 'is paused: only residents propose fixes now'}.` }; },
  };
}
