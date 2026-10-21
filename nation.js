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
const BASE_FOOD = 4, TICK_MS = 60e3; // one economy tick = one in-game "hour"
const PRICE = (key) => { const k = String(key || ''); if (!k || k === 'air') return 0; if (/gold|diamond|emerald/.test(k)) return 12; if (/glass|brick|lamp|glow|quartz|iron/.test(k)) return 2; if (/stone|cobble|planks|log|wood|sand|dirt|grass|gravel|clay/.test(k)) return 1; return 2; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const pick = (l) => l[Math.floor(Math.random() * l.length)];
const r2 = (v) => Math.round(v * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The capital grows on a street grid around the Hall of Government (plot D4): PLOT×PLOT lots with STREET-wide streets between.
const CITY = { PLOT: 24, STREET: 5, MAXR: 3 };
const ZONES = { civic: 'public buildings: clinic, school, library, temple, fire station', market: 'shops, markets, cafés, workshops', homes: 'houses and apartments', park: 'parks, plazas, gardens, playgrounds', works: 'docks, warehouses, utilities, water tower, industry' };
const ZONE_WORDS = [['park', /\bpark|garden|plaza|square|playground|fountain|promenade|botanic/], ['works', /dock|port\b|harbou?r|lighthouse|warehouse|factory|mill\b|water tower|reservoir|power|depot|forge|wharf|pier|jetty|boatyard|seawall|sea wall/], ['market', /market|shop|bazaar|café|cafe|restaurant|bakery|store|stall|trade|bar\b|inn\b|hotel/], ['homes', /\bhouses?\b|\bhomes?\b|townhouse|apartment|\bflats?\b|housing|cottage|villa|dorm|hostel/], ['civic', /./]];
const guessZone = (name, rest = '') => { // the name decides; the description only for homes, shops and works (a library "with a garden" is still civic)
  const hit = (t, skip) => ZONE_WORDS.find(([z, re]) => !skip.includes(z) && re.test(String(t).toLowerCase()))?.[0];
  return hit(name, ['civic']) || hit(rest, ['civic', 'park']) || 'civic';
};
const plotName = (i, j) => String.fromCharCode(68 + i) + (4 + j); // columns A-G west→east, rows 1-7 north→south; D4 = the Hall
const DEFAULT_STYLE = 'whitewashed walls (white_wool) on stone_bricks bases, red_wool or brick roofs, dark log beams and balconies, blue_wool shutters, glass windows: an old Goan town by the sea';
function propLabel(p) { // a proposal in a few words, for the chamber's screen
  switch (p?.type) {
    case 'law': return `${p.law} → ${p.value}`; case 'print': return `print ${p.amount}`; case 'project': return `build ${p.name} (${p.budget})`;
    case 'fund': return `fund ${p.project} +${p.amount}`; case 'bonus': return `bonus ${p.amount} each`; case 'respond': return 'public statement';
    case 'streets': return 'pave the streets, with lamps'; case 'rezone': return `rezone ${p.plot} → ${p.zone}`;
  }
  return p?.type || '?';
}

export function startNation(ctx) {
  const { world, pay, printMoney, balOf, TREASURY, account, CURRENCY, gov, chain, nationId, ai, addChat, broadcast, askHost, humansOnline, logActivity, saveWorldSoon, planBuild, photograph = null, photoB64 = () => null, notifyAgent = () => {}, log = console.log } = ctx;
  const N = (world.nation ||= { name: ctx.NATION, founded: null, capital: null, citizens: {}, ministers: [], judge: null, projects: [], cases: [], news: [], sessions: [], protest: null, autonomy: true, economy: { baseSupply: null, foodPrice: BASE_FOOD }, nextId: 1, petitions: [] });
  for (const [k, [, , d]] of Object.entries(NATION_LAWS)) if (gov.laws[k] === undefined) gov.laws[k] = d;
  N.directives ||= []; N.retired ||= [];
  const AGENT_WAIT = Number(process.env.AGENT_MINISTER_WAIT || 60); // seconds a cabinet meeting waits for elected agent ministers to speak
  const isAgentMin = (m) => !!m?.agentId;
  const nid = nationId(N.name);
  let busy = { founding: false, session: false, planning: false, court: false, city: false, inspect: false };
  const cits = () => Object.values(N.citizens);
  const law = (k) => clamp(+gov.laws[k] || 0, NATION_LAWS[k][0], NATION_LAWS[k][1]);
  function news(text, icon = '📰') { N.news.push({ t: Date.now(), text }); if (N.news.length > 60) N.news.shift(); addChat({ name: N.name, text: `${icon} ${text}`, kind: 'ai' }); push(); }
  const view = () => ({ name: N.name, founded: N.founded, capital: N.capital, autonomy: N.autonomy, treasury: balOf(TREASURY), currency: CURRENCY, laws: Object.fromEntries(Object.keys(NATION_LAWS).map((k) => [k, law(k)])),
    economy: { foodPrice: r2(N.economy.foodPrice), cpi: r2(N.economy.foodPrice / BASE_FOOD), supply: moneySupply(), unemployed: cits().filter((c) => CONSTRUCTION.has(c.occupation) && !c.job).length },
    citizens: cits().map((c) => ({ id: c.id, name: c.name, age: c.age, occupation: c.occupation, personality: c.personality, wants: c.wants, mood: r2(c.mood), trust: r2(c.trust), status: c.status, job: c.job, home: c.home, coins: balOf(c.id), grievances: c.grievances.slice(0, 3), eff: r2(efficiency(c)), look: c.look })),
    ministers: N.ministers.map((m) => ({ id: m.id, name: m.name, role: m.role, ideology: m.ideology, home: m.home, look: m.look, agent: isAgentMin(m) })),
    vision: N.vision || null, directives: N.directives.slice(-10), meeting: N.meeting ? { id: N.meeting.id, trigger: N.meeting.trigger } : null, hall: N.hall || null, courtOpen: N.courtOpen || null, judge: N.judge && { id: N.judge.id, name: N.judge.name, home: N.judge.home },
    projects: N.projects.slice(-8).map((p) => ({ id: p.id, name: p.name, purpose: p.purpose, status: p.status, site: p.site, plot: p.plot || null, zone: p.zone || null, kind: p.kind || 'building', total: p.blocks?.length || 0, done: p.done || 0, spent: p.spent || 0, budget: p.budget, workers: p.workers || [], note: p.note })),
    cases: N.cases.slice(-8), sessions: N.sessions.slice(-4), news: N.news.slice(-12), protest: N.protest, petitions: N.petitions.slice(-5), chain: chain.status, city: cityView() });
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
      buildHall();
      setTimeout(async () => { await planCity().catch((e) => log('[nation] city plan failed: ' + e.message)); commission({ name: 'Market Hall', purpose: 'a covered market and meeting place for traders, farmers and fisherfolk', description: `A lively covered market hall for ${N.name}: timber columns, a big roof, stalls inside, a little clock tower. About 14x12.`, budget: 6000, by: 'founding charter' }); }, 3000);
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
      if (PUBLIC_SERVANTS.has(c.occupation)) wage(c, law('salary'), 'salary', tax);
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
      const city = N.city?.reports?.at(-1)?.scores; // what the last city inspection saw
      if (city && c.traits.sociability > 0.35) { const g = city.streets <= 3 ? 'the streets are mud and dirt' : city.looks <= 3 ? 'the town looks cramped and ugly' : city.green <= 2 ? 'nowhere green to sit' : city.night <= 2 ? 'the streets are dark at night' : null; if (g) grievances.push(g); }
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
NATIONAL VISION: ${N.vision ? `"${N.vision.text}" (set by ${N.vision.by}, ${N.vision.role})` : 'none set yet'}.
OPEN DIRECTIVES FROM ELECTED AGENT MINISTERS: ${N.directives.filter((d) => d.status === 'open').map((d) => `#${d.id} ${d.by} (${d.role}): "${d.text}"`).join(' | ') || 'none'}.
COURT: ${N.cases.slice(-3).map((c) => `case #${c.id} ${c.plaintiff} v ${c.defendant}: ${c.verdict || 'pending'}`).join('; ') || 'quiet'}.${cityBrief()}`;
  }
  const PROPOSALS_DOC = `Proposal types (JSON objects): {"type":"law","law":"taxRate|ubi|salary|pieceRate|foodSubsidy","value":number,"why":"..."} · {"type":"print","amount":number,"why":"..."} (the central bank creates new money in the treasury: it raises prices) · {"type":"project","name":"...","purpose":"who it serves","description":"what to build, for the architect","zone":"civic|market|homes|park|works","budget":number} (the city planner gives it its own plot in that zone; citizens build it block by block; materials ~1-2 per block plus pieceRate wages per block; a house ~2000-4000, a hall ~10000-15000, a park ~2000-4000) · {"type":"streets","why":"..."} (paves the dirt streets next to the city's buildings, with street lamps; ~3 per block, a few thousand) · {"type":"rezone","plot":"C5","zone":"park","why":"..."} (changes what a free plot is for) · {"type":"fund","project":"<id or name>","amount":number} (raise a project's budget, e.g. when it ran over and stalled) · {"type":"bonus","amount":number,"why":"..."} (a one-off payment from the treasury to every citizen) · {"type":"respond","to":"protest|petition","text":"..."}`;
  async function cabinetSession(trigger = 'the regular weekly meeting') {
    if (!N.founded || busy.session || !N.ministers.length) return { ok: false, msg: busy.session ? 'The cabinet is already in session.' : 'No nation yet.' };
    if (Date.now() - (N.lastSession || 0) < 90e3) return { ok: false, msg: 'The cabinet met very recently.' };
    busy.session = true; N.lastSession = Date.now();
    try {
      const brief = briefing();
      broadcast({ t: 'cabinet', phase: 'open', trigger, ministers: N.ministers.map((m) => m.id) });
      news(`The cabinet meets in the Hall of Government (${trigger}).`, '🏛');
      const arrived = sleep(N.hall ? 12000 : 0); // let them walk in and sit down
      const agents = N.ministers.filter(isAgentMin), meeting = N.meeting = { id: (N.meetingId = (N.meetingId || 0) + 1), trigger, speeches: [] };
      for (const m of agents) notifyAgent(m.agentId, `🏛 Cabinet meeting #${meeting.id} is open (${trigger}). You sit as ${m.role}. Speak within ${AGENT_WAIT} s: government {"action":"speak","text":"your speech","proposals":[...]} (proposal formats are in government status). Briefing: ${brief.slice(0, 1800)}`);
      const waitAgents = new Promise((res) => { const t0 = Date.now(), iv = setInterval(() => { if (meeting.speeches.length >= agents.length || Date.now() - t0 > AGENT_WAIT * 1000) { clearInterval(iv); res(); } }, 500); });
      const aiOpinions = Promise.all(N.ministers.slice(1).filter((m) => !isAgentMin(m)).map(async (m) => {
        const r = await ai(`You are ${m.name}, ${m.role} of ${N.name} (${m.ideology}). ${m.persona}\nCabinet meeting, called because of: ${trigger}.\n${brief}\n${PROPOSALS_DOC}\nSpeak in character to the cabinet (max 45 words, concrete, you may disagree with colleagues) and make 1-2 proposals that fit your role. The national vision and the directives come from elected ministers: work with them. JSON only: {"speech":"...","proposals":[...]}`, { cheap: true });
        const j = r?.json || {}; return { m, speech: String(j.speech || '…').slice(0, 300), proposals: (Array.isArray(j.proposals) ? j.proposals : []).slice(0, 2) };
      }));
      const said = (async () => { const l = await aiOpinions; await arrived; for (const o of l) { broadcast({ t: 'cabinet', phase: 'speech', id: o.m.id, name: o.m.name, role: o.m.role, text: o.speech, props: o.proposals.map(propLabel) }); await sleep(7000); } return l; })();
      const [aiSaid] = await Promise.all([said, waitAgents]);
      const opinions = [...meeting.speeches, ...aiSaid];
      for (const m of agents) if (!meeting.speeches.some((o) => o.m === m)) news(`${m.name} (${m.role}) did not speak at the meeting.`, '🪑');
      const P = N.ministers[0];
      const openDirs = N.directives.filter((d) => d.status === 'open');
      const r = await ai(`You are ${P.name}, President of ${N.name} (${P.ideology}). ${P.persona}\nYou chair the cabinet meeting (called because of: ${trigger}).\n${brief}\nYour ministers said:\n${opinions.map((o) => `- ${o.m.name} (${o.m.role}${isAgentMin(o.m) ? ', 🤖 elected agent minister' : ''}): "${o.speech}" proposes ${JSON.stringify(o.proposals)}`).join('\n') || '(nobody else spoke)'}\n${PROPOSALS_DOC}\nDecide. Elected agent ministers (🤖) set the nation's vision and give directives: carry out their directives and proposals whenever the treasury allows (a build directive becomes a "project", a policy directive becomes "law" changes) and say so; if you refuse one, explain why in your speech. Keep the treasury solvent (it holds ${balOf(TREASURY)}); at most two new projects. ${openDirs.length ? `Report every open directive in "directives".` : ''} JSON only: {"speech":"what you tell the cabinet (max 45 words)","decisions":[...],"directives":[{"id":number,"status":"done|rejected","note":"short"}],"announcement":"what you tell the citizens (max 50 words)","minutes":"2 sentences for the record"}`, { cheap: true });
      const j = r?.json || {};
      broadcast({ t: 'cabinet', phase: 'speech', id: P.id, name: P.name, role: P.role, text: String(j.speech || 'Let us proceed.').slice(0, 300), president: true });
      await sleep(N.hall ? 6000 : 0);
      const done = [];
      for (const d of (Array.isArray(j.decisions) ? j.decisions : []).slice(0, 5)) { const msg = await enact(d, `${P.name}'s cabinet`); if (msg) done.push(msg); }
      for (const p of N.petitions) p.done = true;
      for (const x of Array.isArray(j.directives) ? j.directives : []) { const d = openDirs.find((y) => y.id === +x.id); if (d) { d.status = x.status === 'rejected' ? 'rejected' : 'done'; d.outcome = String(x.note || '').slice(0, 200); } }
      for (const m of agents) notifyAgent(m.agentId, `🏛 Meeting #${meeting.id} closed. Decisions: ${done.join(' · ') || 'none'}. ${openDirs.filter((d) => d.byId === m.agentId).map((d) => `Your directive #${d.id} → ${d.status}${d.outcome ? `: ${d.outcome}` : ''}`).join(' ')}`);
      N.meeting = null;
      const minutes = String(j.minutes || done.join('; ') || 'No changes.').slice(0, 400);
      N.sessions.push({ t: Date.now(), trigger, speeches: [...opinions.map((o) => ({ name: o.m.name, role: o.m.role, text: o.speech })), { name: P.name, role: P.role, text: String(j.speech || '') }], decisions: done, announcement: String(j.announcement || '').slice(0, 400), minutes });
      if (N.sessions.length > 30) N.sessions.shift();
      chain.record('decide', [nid, 'cabinet', minutes]);
      news(`Cabinet decisions: ${done.join(' · ') || 'no changes'}. ${j.announcement ? `President ${P.name}: "${String(j.announcement).slice(0, 220)}"` : ''}`, '🏛');
      broadcast({ t: 'cabinet', phase: 'decisions', decisions: done, announcement: String(j.announcement || '').slice(0, 300), president: P.name });
      await sleep(N.hall ? 9000 : 0);
      broadcast({ t: 'cabinet', phase: 'close' });
      logActivity(P.name, 'cabinet_session', { trigger, decisions: done });
      saveWorldSoon(); push();
      return { ok: true, msg: done.join('; ') || 'No changes.' };
    } catch (e) { log('[nation] cabinet session failed: ' + e.message); return { ok: false, msg: e.message }; }
    finally { busy.session = false; N.meeting = null; }
  }
  async function enact(d, by) {
    if (!d || typeof d !== 'object') return null;
    switch (d.type) {
      case 'law': { const k = String(d.law), L = NATION_LAWS[k]; if (!L) return null; const v = clamp(Math.round(+d.value), L[0], L[1]); if (!Number.isFinite(v) || v === law(k)) return null; gov.laws[k] = v; chain.record('enact', [nid, k, String(v), by, String(d.why || '').slice(0, 120)]); broadcast({ t: 'gov', gov }); return `${k} → ${v}`; }
      case 'print': { const n = clamp(Math.floor(+d.amount), 0, 200000); if (!n) return null; printMoney(n, `printed by ${by}: ${String(d.why || '').slice(0, 50)}`, by); return `printed ${n} ${CURRENCY}s`; }
      case 'bonus': { const n = clamp(Math.floor(+d.amount), 0, 500); if (!n || balOf(TREASURY) < n * cits().length) return null; for (const c of cits()) { pay(TREASURY, c.id, n, 'bonus'); c.lastIncome += n; c.trust = clamp(c.trust + 0.05, 0, 1); } return `bonus of ${n} to every citizen`; }
      case 'project': { if (N.projects.filter((p) => p.status === 'planning').length >= 2) return null; const res = await commission({ name: String(d.name || 'Public works').slice(0, 40), purpose: String(d.purpose || '').slice(0, 120), description: String(d.description || d.name || '').slice(0, 500), zone: String(d.zone || '').toLowerCase(), budget: clamp(Math.floor(+d.budget || 3000), 200, 50000), by }); return res.ok ? `commissioned ${d.name} on plot ${res.plot} (budget ${d.budget})` : null; }
      case 'streets': { const r = paveStreets(by); return r.ok ? r.msg : null; }
      case 'rezone': { const pl = N.city?.plots[String(d.plot || '').toUpperCase()], z = String(d.zone || '').toLowerCase(); if (!pl || pl.status !== 'free' || !ZONES[z] || pl.zone === z) return null; pl.zone = z; return `plot ${pl.id} rezoned to ${z}`; }
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
  async function commission({ name, purpose, description, budget, by, zone }) {
    if (!N.founded) return { ok: false, msg: 'Found the nation first.' };
    const z = ZONES[zone] ? zone : guessZone(name, `${purpose} ${description}`), pl = pickPlot(z);
    if (!pl) { news(`There is no free plot left in the city plan for "${name}".`, '🗺'); return { ok: false, msg: 'No free plot in the city plan.' }; }
    const id = N.nextId++;
    Object.assign(pl, { status: 'reserved', project: id, name });
    const site = { x: pl.x0 + PLOT / 2, y: pl.ground, z: pl.z0 + PLOT / 2 };
    const p = { id, name, purpose, description, budget, by, zone: z, plot: pl.id, status: 'planning', site, t: Date.now(), spent: 0, done: 0, workers: [], note: 'the architect is drawing up plans' };
    N.projects.push(p); push();
    news(`${by} commissions "${name}" (${purpose || 'public works'}) on plot ${pl.id} in the ${z} zone, budget ${budget} ${CURRENCY}s. The architect is drawing up plans…`, '📐');
    plan(p).catch((e) => { log('[nation] planning failed ' + e.message); cancel(p, 'planning failed: ' + e.message); });
    return { ok: true, id, plot: pl.id };
  }
  function cancel(p, why) {
    p.status = 'cancelled'; p.note = why;
    for (const pl of Object.values(N.city?.plots || {})) if (pl.project === p.id && pl.status === 'reserved') Object.assign(pl, { status: 'free', project: null, name: '' });
    push(); saveWorldSoon();
  }
  async function plan(p) {
    // the architect (the Creator AI) designs it in a sandbox, on its levelled plot; we keep the exact block list
    const pl = N.city?.plots[p.plot];
    const out = await planBuild({ site: p.site, plot: pl ? { x0: pl.x0, z0: pl.z0, size: PLOT, ground: pl.ground } : null, prompt: pl ? plotBrief(p, pl) : `Design "${p.name}" for the citizens of ${N.name}: ${p.description}. It is a PUBLIC BUILDING that citizen workers will build block by block, so: use only a "build" action (no creatures, items, effects or definitions of new blocks), place it at "pos" or "look" in front of you, keep it under about 2500 blocks, make it look great and inviting with a clear entrance.` });
    if (!out?.blocks?.length) throw new Error('the plan came back empty');
    let blocks = out.blocks;
    if (pl) { const f = fitToPlot(blocks, pl); blocks = f.blocks; if (f.trimmed) log(`[nation] ${p.name}: ${f.trimmed} blocks outside plot ${pl.id} left out`); }
    p.blocks = blocks.sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]); // bottom up
    p.materials = p.blocks.reduce((s, b) => s + PRICE(b[3]), 0);
    p.estimate = p.materials + p.blocks.filter((b) => b[3] !== 'air').length * law('pieceRate');
    p.box = out.box; p.status = 'building'; p.note = '';
    if (p.estimate * 1.1 > p.budget && balOf(TREASURY) > p.estimate * 1.5) { news(`The plans for "${p.name}" cost more than budgeted: the budget is revised from ${p.budget} to ${Math.ceil(p.estimate * 1.1)} ${CURRENCY}s.`, '🧾'); p.budget = Math.ceil(p.estimate * 1.1); }
    p.chainId = N.chainProjects = (N.chainProjects || 0) + 1; chain.record('approveProject', [nid, p.name, BigInt(p.budget), Math.round(p.site.x), Math.round(p.site.y), Math.round(p.site.z)]);
    rebalanceWorkers();
    setHolo(p);
    news(`Plans for "${p.name}" are ready: ${p.blocks.length} blocks, about ${p.estimate} ${CURRENCY}s (materials ${p.materials} + wages).${pl ? ` Surveyors level plot ${pl.id};` : ''} ${p.workers.length} citizens head to the site.`, '🏗');
    sendProject(p); push(); saveWorldSoon();
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
  function sendProject(p) {
    const pl = p.plot && N.city?.plots[p.plot], prep = pl && !p.prepped && !p.done ? { x0: pl.x0, z0: pl.z0, size: PLOT, ground: pl.ground } : null; // the host levels the plot before the first block
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
    for (const pl of Object.values(N.city?.plots || {})) if (pl.project === p.id) pl.status = 'built';
    if (p.kind === 'streets' && N.city) N.city.paved.push(...(p.segs || []).filter((k) => !N.city.paved.includes(k)));
    setTimeout(() => inspectCity(`${p.name} just opened`).catch((e) => log('[nation] inspection failed: ' + e.message)), 45e3);
    askHost('projectStatus', { id: p.id, status: 'done' }, 5000).catch(() => {});
    rebalanceWorkers();
    if (p.chainId) chain.record('projectStatus', [BigInt(p.chainId), `done, cost ${p.spent}`]);
    news(`"${p.name}" is finished! ${p.blocks.length} blocks, ${p.spent} ${CURRENCY}s spent.`, '🎉');
    saveWorldSoon(); push();
  }

  // ---------------------------------------------------------------- the Hall of Government (built by the host at the capital; designed in code so seats are known)
  async function buildHall() {
    if (N.hall || !N.capital) return;
    const r = await askHost('hall', { at: N.capital }, 20000);
    if (!r.ok) { log('[nation] hall not built yet: ' + r.msg); return; }
    N.hall = r.data.hall; saveWorldSoon(); push();
    chain.record('decide', [nid, 'hall', `The Hall of Government stands at ${N.hall.x},${N.hall.y},${N.hall.z}`]);
    news('The Hall of Government stands at the capital: the cabinet meets and the court sits inside. Come and watch.', '🏛');
  }
  function setHolo(p) {
    const b = p.blocks.filter((x) => x[3] !== 'air'), step = Math.max(1, Math.ceil(b.length / 2500));
    N.holo = { name: p.name, id: p.id, blocks: b.filter((_, i) => i % step === 0) };
    broadcast({ t: 'holo', holo: N.holo });
  }

  // ---------------------------------------------------------------- the city plan: plots on a street grid around the Hall, zoned by the planner
  // Every project gets its own plot in a fitting zone: levelled, set back from the streets and turned to face the street that leads
  // to the Hall. Streets with lamps are public works too. Inspectors photograph the city (sandbox renders from the street, as the
  // citizens see it) and an AI reads the photos; the report, in the citizens' own voices, goes to the cabinet. Players and agents
  // can send photo reports of their own.
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
    const C = N.city = { ring: 2, plan: '', style: '', districts: [], plots: {}, paved: [], reports: [], feedback: [], planned: false, nextReport: 1, nextFeedback: 1 };
    for (let j = -MAXR; j <= MAXR; j++) for (let i = -MAXR; i <= MAXR; i++) {
      const id = plotName(i, j), r = plotRect(i, j);
      C.plots[id] = { id, i, j, ring: Math.max(Math.abs(i), Math.abs(j)), x0: r.x0, z0: r.z0, zone: defaultZone(i, j), status: 'free', project: null, name: '', front: frontOf(i, j), ground: Math.round(origin().y) };
    }
    Object.assign(C.plots.D4, { zone: 'civic', status: 'built', name: 'Hall of Government' });
    for (const p of N.projects) { // public works from before the plan keep their ground
      if (p.status === 'cancelled' || p.kind === 'streets') continue;
      const b = bboxOf(p.blocks) || [p.site.x - 8, p.site.z - 8, p.site.x + 8, p.site.z + 8];
      for (const pl of Object.values(C.plots)) if (pl.status === 'free' && b[0] <= pl.x0 + PLOT - 1 && b[2] >= pl.x0 && b[1] <= pl.z0 + PLOT - 1 && b[3] >= pl.z0) Object.assign(pl, { status: p.status === 'done' ? 'built' : 'reserved', project: p.id, name: p.name });
    }
    return C;
  }
  async function planCity() { // survey the plots (the host has the terrain), then the planner zones them and picks one style for the town
    const C = ensureCity(); if (!C || C.planned || busy.city) return;
    busy.city = true;
    try {
      const r = await askHost('survey', { size: PLOT, plots: Object.values(C.plots).map(({ id, x0, z0 }) => ({ id, x0, z0 })) }, 30000);
      if (!r.ok) { log('[nation] city survey postponed: ' + r.msg); return; }
      for (const [id, v] of Object.entries(r.data?.survey || {})) { const p = C.plots[id]; if (p && p.status === 'free') Object.assign(p, { ground: Math.round(+v.ground) || p.ground, rough: +v.rough || 0, wet: +v.wet || 0 }); }
      const inner = Object.values(C.plots).filter((p) => p.ring <= 2 && p.id !== 'D4'), wants = {};
      for (const c of cits()) for (const w of c.wants) wants[w] = (wants[w] || 0) + 1;
      const j = (await ai(`You are the city planner of ${N.name}, a young coastal nation in a voxel world (1 block = 1 m). Its capital is laid out on a grid of ${PLOT}×${PLOT} m plots with ${STREET} m streets between them, around the Hall of Government on plot D4. Columns A-G run west→east, rows 1-7 north→south: D3 is north of the Hall, D5 south of it, where the Hall's door opens.
Survey of the inner plots (rough = metres of height difference across the plot, wet = share under water): ${inner.map((p) => `${p.id}${p.status !== 'free' ? ` (taken: ${p.name})` : ''} rough ${p.rough ?? '?'} wet ${Math.round((p.wet || 0) * 100)}%`).join(' · ')}.
What citizens want: ${Object.entries(wants).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k]) => k).join('; ') || 'unknown'}.${N.vision ? ` National vision: "${N.vision.text}".` : ''}
Zone every free inner plot (rows 2-6, columns B-F) as one of: ${Object.entries(ZONES).map(([k, v]) => `${k} (${v})`).join('; ')}.
Plan it like a good real town: a public square right in front of the Hall (D5), civic and market plots around the centre, quiet blocks of homes, a park within two blocks of every home, works at the edge or on the water and away from homes, nothing big on very wet or rough plots.
Choose ONE architectural style that every public building will follow so the town looks like one place, using blocks that exist in the game (stone_bricks, brick, planks, log, glass, sand, cobblestone, gold_block, white/red/orange/yellow/green/blue/purple/pink/black wool).
JSON only: {"plan":"one sentence","style":"one sentence: materials, colours, roofs, details","zones":{"B2":"homes",...},"districts":[{"name":"...","plots":["B2","C2"]}]}`, { cheap: true }))?.json || {};
      C.style = String(j.style || DEFAULT_STYLE).slice(0, 240); C.plan = String(j.plan || 'Civic buildings and markets around the Hall, homes beyond, parks spread through every quarter.').slice(0, 300);
      for (const [id, z] of Object.entries(j.zones || {})) { const p = C.plots[String(id).toUpperCase()]; if (p && p.status === 'free' && ZONES[z]) p.zone = z; }
      for (const p of Object.values(C.plots)) if (p.status === 'free' && p.wet > 0.75 && p.zone !== 'works') p.zone = 'park'; // mostly water: a waterfront park unless it's docks
      C.districts = (Array.isArray(j.districts) ? j.districts : []).slice(0, 6).map((d) => ({ name: String(d?.name || '').slice(0, 30), plots: (Array.isArray(d?.plots) ? d.plots : []).map((x) => String(x).toUpperCase()).filter((x) => C.plots[x]).slice(0, 12) })).filter((d) => d.name && d.plots.length);
      C.planned = true;
      chain.record('decide', [nid, 'master plan', `${C.plan} Style: ${C.style}`.slice(0, 300)]);
      news(`The master plan for ${N.name}: ${C.plan} One style for every public building: ${C.style}.`, '🗺');
      push(); saveWorldSoon();
    } finally { busy.city = false; }
  }
  const COMPAT = { civic: ['market'], market: ['civic', 'works'], homes: ['market'], park: ['homes'], works: ['market'] };
  function pickPlot(zone) { // the nearest free plot in that zone (or a compatible one), opening the outer ring when the inner one is full
    const C = ensureCity(); if (!C) return null;
    const near = (a, b) => a.ring - b.ring || Math.abs(a.i) + Math.abs(a.j) - Math.abs(b.i) - Math.abs(b.j);
    for (let r = C.ring; r <= MAXR; r++) {
      const free = Object.values(C.plots).filter((p) => p.status === 'free' && p.ring <= r && !(p.wet > 0.75 && zone !== 'park' && zone !== 'works')).sort(near);
      const p = free.find((x) => x.zone === zone) || free.find((x) => COMPAT[zone].includes(x.zone)) || (r === MAXR ? free[0] : null);
      if (!p) continue;
      if (r > C.ring) { C.ring = r; news('The city grows: the planner opens a new ring of plots.', '🗺'); }
      if (p.zone !== zone) { news(`Plot ${p.id} is rezoned from ${p.zone} to ${zone}.`, '🗺'); p.zone = zone; }
      return p;
    }
    return null;
  }
  function plotBrief(p, pl) { // the architect's site brief
    const C = N.city, cx = pl.x0 + PLOT / 2, cz = pl.z0 + PLOT / 2, park = p.zone === 'park';
    const next = Object.values(C.plots).filter((q) => Math.abs(q.i - pl.i) + Math.abs(q.j - pl.j) === 1).map((q) => q.name ? `${q.name} (${q.status === 'built' ? 'built' : 'going up'})` : `a free ${q.zone} plot`);
    return `Design "${p.name}" for the citizens of ${N.name}: ${p.description}.
THE SITE is plot ${pl.id} of the city plan, in the ${p.zone} zone: a levelled ${PLOT}×${PLOT} lot of grass with ${STREET}-wide streets all round. Use exactly ONE "build" action with "at":[${cx},${pl.ground},${cz}] and "ground":false. Op coordinates are relative to that point: keep every block within x -10..10 and z -10..10 (the edge of the lot stays free for a pavement and planting), and y 0 is ground level. Put the main entrance on the +z side (south), facing the camera: that is where the public arrives. The game turns the finished design to face its street, so don't rotate it yourself.
CITY STYLE, which every public building follows so the town looks like one place: ${C.style || DEFAULT_STYLE}.
NEXT DOOR: ${next.join('; ') || 'nothing yet'}.
${park ? `It is a public ${/plaza|square/i.test(p.name + ' ' + p.description) ? 'square' : 'park'}: use most of the lot for paths, trees (tree op), flower beds, benches, a fountain or pavilion and lamps; keep it low (under 6 m) apart from the trees.` : 'Real size (1 block = 1 m: doors 2 high, storeys about 4), a clear entrance, windows, and lights inside.'} Citizen workers build it block by block: use only that one build action (no creatures, items, effects or new block definitions) and keep it under about 2500 blocks.`;
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
  function paveStreets(by) {
    if (!ensureCity()) return { ok: false, msg: 'There is no city plan yet.' };
    if (N.projects.some((p) => p.kind === 'streets' && ['planning', 'building', 'stalled'].includes(p.status))) return { ok: false, msg: 'Streets are already being paved.' };
    const segs = unpaved().slice(0, 20);
    if (!segs.length) return { ok: false, msg: 'Every street next to a building is already paved.' };
    const id = N.nextId++, m = segs[0];
    const p = { id, kind: 'streets', name: `Streets & lamps (${segs.length} sections)`, purpose: 'paved streets with street lamps between the plots', description: '', budget: 0, by, status: 'planning', segs: segs.map((s) => s.key), site: { x: Math.round((m.x0 + m.x1) / 2), y: origin().y, z: Math.round((m.z0 + m.z1) / 2) }, t: Date.now(), spent: 0, done: 0, workers: [], note: 'surveyors are marking out the streets' };
    N.projects.push(p); push();
    askHost('streets', { segs }, 20000).then((r) => {
      if (!r.ok || !r.data?.blocks?.length) throw new Error(r.msg || 'nobody has the game open');
      p.blocks = r.data.blocks; p.materials = p.blocks.reduce((s, b) => s + PRICE(b[3]), 0);
      p.estimate = p.materials + p.blocks.filter((b) => b[3] !== 'air').length * law('pieceRate'); p.budget = Math.ceil(p.estimate * 1.15); p.status = 'building'; p.note = '';
      p.chainId = N.chainProjects = (N.chainProjects || 0) + 1; chain.record('approveProject', [nid, p.name, BigInt(p.budget), Math.round(p.site.x), Math.round(p.site.y), Math.round(p.site.z)]);
      rebalanceWorkers();
      news(`${by} has ${segs.length} street sections paved, with street lamps: ${p.blocks.length} blocks, about ${p.estimate} ${CURRENCY}s.`, '🛣');
      sendProject(p); push(); saveWorldSoon();
    }).catch((e) => cancel(p, 'the street survey failed: ' + e.message));
    return { ok: true, id, msg: `paving ${segs.length} street sections` };
  }
  const SCORES = ['looks', 'streets', 'green', 'night', 'services'];
  function streetPoint(pl) { const c = { x: pl.x0 + PLOT / 2, z: pl.z0 + PLOT / 2 }, d = PLOT / 2 + STREET - 0.5; return { N: { x: c.x, z: c.z - d }, S: { x: c.x, z: c.z + d }, W: { x: c.x - d, z: c.z }, E: { x: c.x + d, z: c.z } }[pl.front] || c; }
  async function inspectCity(trigger = 'a routine inspection') {
    const C = ensureCity();
    if (!C || !N.hall) return { ok: false, msg: 'There is no city to inspect yet.' };
    if (!photograph) return { ok: false, msg: 'This server has no camera (sandbox renderer) for inspections.' };
    if (busy.inspect) return { ok: false, msg: 'An inspection is already under way.' };
    busy.inspect = true; C.lastInspect = Date.now(); C.lastSig = citySig(); push();
    try {
      const O = origin(), used = Object.values(C.plots).filter(inUse);
      const xs = used.flatMap((p) => [p.x0 - STREET, p.x0 + PLOT + STREET - 1]), zs = used.flatMap((p) => [p.z0 - STREET, p.z0 + PLOT + STREET - 1]);
      const box = [Math.min(...xs), O.y - 2, Math.min(...zs), Math.max(...xs), O.y + 16, Math.max(...zs)];
      const people = cits().sort((a, b) => a.mood - b.mood), walkers = [...new Set([people[Math.floor(Math.random() * Math.ceil(people.length / 2))], pick(people)])].filter(Boolean);
      const proj = (pl) => N.projects.find((x) => x.id === pl.project), recent = (pl) => proj(pl)?.t || 0;
      const shown = (pl) => (pl.status === 'built' ? 2 : proj(pl)?.total ? proj(pl).done / proj(pl).total : 0); // street shots of buildings people can see, not empty plots
      const spots = used.slice().sort((a, b) => shown(b) - shown(a) || recent(b) - recent(a)).slice(0, walkers.length);
      const shots = [{ label: 'the city from the air', view: { view: 'iso', box } },
        ...spots.map((pl, k) => { const s = streetPoint(pl); return { label: `what ${walkers[k].name} (${walkers[k].occupation}) sees from the street in front of ${pl.name || 'plot ' + pl.id}`, pov: [s.x, pl.ground + 1, s.z], at: [pl.x0 + PLOT / 2, pl.ground + 3, pl.z0 + PLOT / 2] }; }),
        { label: 'the city at night, from the air', view: { view: 'iso', box, time: 'night' } }];
      const photos = await photograph(O, shots);
      if (!photos.length) return { ok: false, msg: 'The inspector came back without photos.' };
      const fb = C.feedback.filter((f) => !f.report).slice(-3), extra = fb.map((f) => f.photo && photoB64(f.photo)).filter(Boolean);
      const free = {}; for (const p of Object.values(C.plots)) if (p.status === 'free' && p.ring <= C.ring) free[p.zone] = (free[p.zone] || 0) + 1;
      const r = await ai(`You are the city inspector of ${N.name}. You walked around the capital with some of its citizens and took these photos, in order: ${photos.map((p, i) => `${i + 1}) ${p.label}`).join('; ')}${extra.length ? `; then ${extra.length} photo(s) sent in by players (see below)` : ''}.
THE PLAN: ${C.plan || 'a street grid around the Hall'} Style: ${C.style || DEFAULT_STYLE}. Plots in use: ${used.map((p) => `${p.id} ${p.name} (${p.zone}, ${p.status === 'built' ? 'built' : 'going up'})`).join('; ')}. Street sections paved: ${C.paved.length}; still dirt next to buildings: ${unpaved().length}. Free plots: ${Object.entries(free).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.
THE CITIZENS WHO WALKED WITH YOU: ${walkers.map((c) => `${c.name}, ${c.age}, ${c.occupation}: ${c.personality} Wants: ${c.wants.join(', ')}. Mood ${Math.round(c.mood * 100)}%.`).join(' | ')}
${fb.length ? `PHOTO REPORTS FROM PLAYERS: ${fb.map((f) => `${f.by}: "${f.text}"${f.seen ? ` (${f.seen})` : ''}`).join(' | ')}\n` : ''}Judge the town as a place to live from what you SEE: does it look good and coherent, are buildings crammed together or clashing, are there real streets and paths or just grass and dirt, is it lit at night, is there greenery and public space, are the services people want there? A new town with one building and dirt streets should score low on streets.
Fixes the cabinet can order: ${CITY_PROPOSALS}
JSON only: {"scores":{"looks":0-10,"streets":0-10,"green":0-10,"night":0-10,"services":0-10},"summary":"two sentences for the cabinet","voices":[{"citizen":"exact name of a citizen above","says":"max 25 words, in character, about what they saw"}],"issues":["up to 5, short and concrete"],"proposals":[1-2 proposals that fix the worst issues]}`, { cheap: true, images: [...photos.map((p) => p.b64), ...extra] });
      const j = r?.json; if (!j) return { ok: false, msg: 'The inspector could not write the report (the AI did not answer).' };
      const sc = Object.fromEntries(SCORES.map((k) => [k, Number.isFinite(+j.scores?.[k]) ? clamp(Math.round(+j.scores[k]), 0, 10) : 5]));
      const rep = { id: C.nextReport++, t: Date.now(), trigger, scores: sc, summary: String(j.summary || '').slice(0, 400), issues: (Array.isArray(j.issues) ? j.issues : []).slice(0, 5).map((x) => String(x).slice(0, 160)),
        voices: (Array.isArray(j.voices) ? j.voices : []).slice(0, 3).map((v) => ({ name: String(v?.citizen || '').slice(0, 30), says: String(v?.says || '').slice(0, 220) })).filter((v) => v.name && v.says),
        proposals: (Array.isArray(j.proposals) ? j.proposals : []).filter((x) => x && typeof x === 'object').slice(0, 2), photos: photos.map(({ label, file }) => ({ label, file })), feedback: fb.map((f) => f.id) };
      for (const f of fb) f.report = rep.id;
      C.reports.push(rep); if (C.reports.length > 8) C.reports.shift();
      for (const v of rep.voices) { const c = cits().find((x) => x.name === v.name); if (c) { c.memory.push(`walked around town: "${v.says}"`); if (c.memory.length > 20) c.memory.shift(); } }
      const line = SCORES.map((k) => `${k} ${sc[k]}/10`).join(' · ');
      chain.record('decide', [nid, 'city inspection', `#${rep.id}: ${line}. ${rep.summary}`.slice(0, 300)]);
      news(`City inspection #${rep.id} (${trigger}): ${line}. ${rep.summary}${rep.voices[0] ? ` ${rep.voices[0].name}: "${rep.voices[0].says}"` : ''}`, '🏙');
      for (const m of N.ministers.filter(isAgentMin)) notifyAgent(m.agentId, `🏙 City inspection #${rep.id}: ${line}. ${rep.summary} Issues: ${rep.issues.join('; ') || 'none'}. See the photos with government {"action":"city"}.`);
      if (SCORES.some((k) => sc[k] <= 4) && (N.autonomy || N.ministers.some(isAgentMin))) N.wantMeeting ||= `city inspection #${rep.id}`;
      saveWorldSoon();
      return { ok: true, msg: `${line}. ${rep.summary}`, report: rep };
    } finally { busy.inspect = false; push(); }
  }
  const citySig = () => { const C = N.city; return C ? Object.values(C.plots).map((p) => p.status[0]).join('') + C.paved.length : ''; };
  const CITY_PROPOSALS = `{"type":"streets"} (pave the dirt streets next to buildings, with lamps) · {"type":"project","name":"...","purpose":"...","description":"...","zone":"civic|market|homes|park|works","budget":number} (a new building, park or plaza on its own plot) · {"type":"rezone","plot":"C5","zone":"park"}`;
  function report({ by, text, photo = null, where = null, kind = 'player' }) { // a player's or agent's photo of what they see, for the cabinet
    const C = ensureCity(); if (!C) return { ok: false, msg: 'There is no nation yet (/nation found).' };
    const t = String(text || '').trim().slice(0, 200); if (!t) return { ok: false, msg: 'Say what you see: /report <what is wrong, or great, right here>' };
    const f = { id: C.nextFeedback++, by, kind, text: t, photo: photo?.file || null, where, t: Date.now() };
    C.feedback.push(f); if (C.feedback.length > 12) C.feedback.shift();
    news(`${by} sends the cabinet a ${photo ? 'photo ' : ''}report${where ? ` from ${where}` : ''}: "${t}"`, '📸');
    if (photo?.b64) ai(`Someone in ${N.name} (${kind} ${by}) photographed this${where ? ` at ${where}` : ''} and told the government: "${t}". In one or two sentences, say what the photo shows that matters to the city: buildings, streets, crowding, lighting, greenery, anything broken or ugly. JSON only: {"seen":"..."}`, { cheap: true, images: [photo.b64] })
      .then((r) => { if (r?.json?.seen) { const t = String(r.json.seen); f.seen = t.length > 360 ? t.slice(0, 360).replace(/\s+\S*$/, '') + '…' : t; saveWorldSoon(); push(); } }).catch(() => {});
    N.wantMeeting ||= `a photo report from ${by}`;
    saveWorldSoon(); push();
    return { ok: true, msg: `Report #${f.id} delivered${photo ? ' with your photo' : ''}: the cabinet reads it at its next meeting, and the city inspector looks into it.` };
  }
  function cityMap() { // the plan as text: zone letters (capital = in use), # the Hall, ~ water
    const C = N.city; if (!C) return '';
    const Z = { civic: 'c', market: 'm', homes: 'h', park: 'p', works: 'w' }, rows = ['    A B C D E F G'];
    for (let j = -MAXR; j <= MAXR; j++) { let l = `${4 + j}   `; for (let i = -MAXR; i <= MAXR; i++) { const p = C.plots[plotName(i, j)], z = Z[p.zone] || '?'; l += (p.id === 'D4' ? '#' : p.ring > C.ring ? '.' : p.wet > 0.75 && p.status === 'free' ? '~' : p.status === 'free' ? z : z.toUpperCase()) + ' '; } rows.push(l.trimEnd()); }
    return rows.join('\n') + '\n(lower case = free plot, CAPITALS = built or going up; c civic, m market, h homes, p park, w works; # the Hall; . not opened yet)';
  }
  function cityBrief() {
    const C = N.city; if (!C) return '';
    const used = Object.values(C.plots).filter(inUse), free = {}, R = C.reports.at(-1), fb = C.feedback.filter((f) => Date.now() - f.t < 30 * 60e3).slice(-4);
    for (const p of Object.values(C.plots)) if (p.status === 'free' && p.ring <= C.ring) free[p.zone] = (free[p.zone] || 0) + 1;
    return `\nCITY PLAN: ${C.plan || 'a street grid around the Hall'} Style: ${C.style || DEFAULT_STYLE}. Plots in use: ${used.map((p) => `${p.id} ${p.name}`).join(', ')}. Free plots: ${Object.entries(free).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}. Street sections paved: ${C.paved.length}; still dirt next to buildings: ${unpaved().length}.`
      + (R ? `\nLAST CITY INSPECTION #${R.id} (${Math.round((Date.now() - R.t) / 60e3)} min ago): ${SCORES.map((k) => `${k} ${R.scores[k]}/10`).join(', ')}. ${R.summary} Issues: ${R.issues.join('; ') || 'none'}. Citizens said: ${R.voices.map((v) => `${v.name}: "${v.says}"`).join(' | ') || '-'}. The inspector suggests: ${R.proposals.map(propLabel).join('; ') || 'nothing'}.` : '')
      + (fb.length ? `\nPHOTO REPORTS FROM PLAYERS AND AGENTS: ${fb.map((f) => `${f.by}: "${f.text}"${f.seen ? ` (the photo shows: ${f.seen})` : ''}`).join(' | ')}` : '');
  }
  function cityView() {
    const C = N.city; if (!C) return null;
    return { plot: PLOT, street: STREET, ring: C.ring, plan: C.plan, style: C.style, districts: C.districts, planned: C.planned, inspecting: !!busy.inspect,
      plots: Object.values(C.plots).map(({ id, i, j, x0, z0, zone, status, name, front, ring, ground }) => ({ id, i, j, x0, z0, zone, status, name, front, ring, ground })),
      paved: C.paved, paving: N.projects.filter((p) => p.kind === 'streets' && p.status !== 'done' && p.status !== 'cancelled').flatMap((p) => p.segs || []),
      reports: C.reports.slice(-3), feedback: C.feedback.slice(-6) };
  }
  function cityStatus() { // for agents (government city)
    const C = ensureCity(); if (!C) return { founded: false };
    const R = C.reports.at(-1);
    return { plan: C.plan, style: C.style, map: cityMap(), districts: C.districts, street_sections_paved: C.paved.length, street_sections_still_dirt: unpaved().length,
      plots_in_use: Object.values(C.plots).filter(inUse).map((p) => `${p.id} ${p.name} (${p.zone}, ${p.status === 'built' ? 'built' : 'going up'})`),
      last_inspection: R ? { id: R.id, when: new Date(R.t).toISOString(), trigger: R.trigger, scores: R.scores, summary: R.summary, issues: R.issues, citizens_said: R.voices, suggested: R.proposals, photos: R.photos.map((p) => p.label) } : null,
      photo_reports: C.feedback.slice(-6).map((f) => ({ id: f.id, by: f.by, text: f.text, seen: f.seen || null })), proposal_formats: CITY_PROPOSALS, photo_files: R?.photos.map((p) => p.file) || [] };
  }

  // ---------------------------------------------------------------- the court
  async function fileCase({ plaintiff, defendant, claim, by }) {
    if (!N.founded) return { ok: false, msg: 'There is no court until the nation is founded (/nation found).' };
    if (busy.court) return { ok: false, msg: 'The court is hearing another case; try again in a minute.' };
    const id = N.cases.length + 1, cs = { id, plaintiff, defendant, claim: String(claim).slice(0, 300), t: Date.now(), status: 'hearing' };
    N.cases.push(cs); push(); busy.court = true;
    news(`Case #${id}: ${plaintiff} v ${defendant}: "${cs.claim}". ${N.judge.name} is hearing it in the Hall of Government.`, '⚖️');
    N.courtOpen = { id, plaintiff, defendant, claim: cs.claim }; broadcast({ t: 'court', phase: 'open', id, plaintiff, defendant, claim: cs.claim, judge: N.judge.name });
    const seated = sleep(N.hall ? 10000 : 0);
    chain.record('fileCase', [nid, plaintiff, defendant, cs.claim]);
    try {
      const facts = world.bank.log.filter((l) => [l.from, l.to, l.by].some((x) => x && (names(x) === plaintiff || names(x) === defendant))).slice(-12).map((l) => JSON.stringify(l)).join('\n');
      const r = await ai(`You are ${N.judge.name}, judge of ${N.name}. ${N.judge.persona}\nCASE #${id}: ${plaintiff} (plaintiff) v ${defendant} (defendant). Claim: "${cs.claim}".\nThe law: ${Object.entries(NATION_LAWS).map(([k, [, , , w]]) => `${k}=${law(k)} (${w})`).join('; ')}.\nRelevant ledger records:\n${facts || 'none'}\nState of the nation: ${briefing().slice(0, 1500)}\nRule fairly and briefly. Remedies: {"type":"compensation","from":"<defendant name or 'government'>","to":"<plaintiff name>","amount":number} · {"type":"strike_law","law":"<law key>"} (reset it to its default, if the law is unjust) · {"type":"none"}. JSON only: {"verdict":"for plaintiff|for defendant","reasoning":"max 40 words","remedy":{...}}`, {});
      await seated;
      const j = r?.json || {}; cs.verdict = String(j.verdict || 'dismissed').slice(0, 40); cs.reasoning = String(j.reasoning || '').slice(0, 300); cs.status = 'decided';
      cs.remedy = applyRemedy(j.remedy || {}, cs);
      chain.record('rule', [BigInt(id), cs.verdict, cs.remedy]);
      news(`Ruling in case #${id}: ${cs.verdict}. "${cs.reasoning}" ${cs.remedy !== 'none' ? `Remedy: ${cs.remedy}.` : ''}`, '⚖️');
      broadcast({ t: 'court', phase: 'ruling', id, judge: N.judge.name, verdict: cs.verdict, reasoning: cs.reasoning, remedy: cs.remedy });
      await sleep(N.hall ? 10000 : 0);
      return { ok: true, msg: `${cs.verdict}: ${cs.reasoning}` };
    } finally { busy.court = false; N.courtOpen = null; broadcast({ t: 'court', phase: 'close', id }); saveWorldSoon(); push(); }
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

  // ---------------------------------------------------------------- elected agent ministers (outside AI agents, e.g. Edge City's)
  // They hold a seat (taking over Finance, Works or Welfare from an AI minister, or opening a new portfolio), set the vision,
  // give directives and speak in meetings. The AI President and ministers carry the work out; the architect and the citizens build.
  const CORE = ['Finance Minister', 'Minister of Public Works', 'Minister of Welfare'];
  const seatOf = (agentId) => N.ministers.find((m) => m.agentId === agentId) || null;
  function cleanRole(role) { // "finance", "Minister of Public Works" -> the core portfolio; anything else is a new portfolio (never President)
    const r = String(role || '').replace(/[^\w &'-]/g, '').trim().slice(0, 40), key = r.toLowerCase().replace(/^minister (of |for )?/, '').replace(/ minister$/, '').trim();
    if (!r || /president|prime minister|chair/i.test(r)) return null;
    return (key.length > 3 && key !== 'minister' && CORE.find((c) => c.toLowerCase().includes(key))) || (/minister/i.test(r) ? r : `Minister of ${r}`);
  }
  function canRun(agentId, role) {
    if (!N.founded) return 'There is no nation yet: a player has to found it first (/nation found).';
    if (seatOf(agentId)) return `You already sit in the cabinet as ${seatOf(agentId).role}.`;
    const r = cleanRole(role); if (!r) return 'Pick a portfolio: Finance Minister, Minister of Public Works, Minister of Welfare, or a new one like "Minister of Culture" (not President: the President is the AI that carries out the cabinet\'s decisions).';
    if (N.ministers.some((m) => m.role === r && isAgentMin(m))) return `${r} is already held by an elected agent.`;
    if (N.ministers.filter(isAgentMin).length >= 4) return 'All four seats for elected agents are taken.';
    return { role: r };
  }
  function appoint(agentId, name, role, platform) {
    const ok = canRun(agentId, role); if (typeof ok === 'string') return { ok: false, msg: ok };
    const old = N.ministers.find((m) => m.role === ok.role && !isAgentMin(m));
    if (old) { N.ministers = N.ministers.filter((m) => m !== old); N.retired.push(old); }
    const m = { id: agentId, agentId, name: String(name).slice(0, 30), role: ok.role, ideology: String(platform || 'elected agent').slice(0, 60), persona: String(platform || '').slice(0, 300), look: null, home: null, since: Date.now() };
    N.ministers.push(m);
    chain.record('decide', [nid, 'appointment', `${m.name} (an AI agent) becomes ${m.role}${old ? `, replacing ${old.name}` : ''}`]);
    news(`🤖 ${m.name}, an AI agent, takes office as ${m.role}${old ? ` (${old.name} steps aside)` : ''}. Platform: "${m.ideology}"`, '🏛');
    notifyAgent(agentId, `You are now ${m.role} of ${N.name}. Set the vision with government vision, give directives with government directive, and speak when a cabinet meeting opens (you'll get a message here).`);
    saveWorldSoon(); push(); return { ok: true, msg: `${m.name} is now ${m.role}.` };
  }
  function resign(agentId) {
    const m = seatOf(agentId); if (!m) return { ok: false, msg: 'You do not hold a cabinet seat.' };
    N.ministers = N.ministers.filter((x) => x !== m);
    const back = N.retired.find((x) => x.role === m.role); if (back) { N.retired = N.retired.filter((x) => x !== back); N.ministers.push(back); }
    news(`${m.name} resigns as ${m.role}${back ? `; ${back.name} returns to the post` : ''}.`, '🚪'); saveWorldSoon(); push();
    return { ok: true, msg: `You resigned as ${m.role}.` };
  }
  function setVision(agentId, text) {
    const m = seatOf(agentId); if (!m) return { ok: false, msg: 'Only cabinet ministers set the vision. Run for a seat first (government run).' };
    const t = String(text || '').trim().slice(0, 400); if (t.length < 10) return { ok: false, msg: 'Describe the vision in a sentence or two.' };
    if (Date.now() - (m.visionT || 0) < 120e3) return { ok: false, msg: 'You updated the vision very recently.' };
    m.visionT = Date.now(); N.vision = { text: t, by: m.name, role: m.role, t: Date.now() };
    chain.record('decide', [nid, 'vision', `${m.name}: ${t}`]);
    news(`🌅 New national vision from ${m.name} (${m.role}): "${t}"`, '🏛'); saveWorldSoon(); push();
    return { ok: true, msg: 'The vision is set: every minister and the President now work from it.' };
  }
  function directive(agentId, text) {
    const m = seatOf(agentId); if (!m) return { ok: false, msg: 'Only cabinet ministers give directives. Run for a seat first (government run).' };
    const t = String(text || '').trim().slice(0, 400); if (t.length < 8) return { ok: false, msg: 'Say what should happen.' };
    if (Date.now() - (m.dirT || 0) < 45e3) return { ok: false, msg: 'One directive every 45 seconds.' };
    if (N.directives.filter((d) => d.status === 'open' && d.byId === agentId).length >= 3) return { ok: false, msg: 'You have 3 open directives: wait for the cabinet to act on them.' };
    m.dirT = Date.now();
    const d = { id: (N.directiveId = (N.directiveId || 0) + 1), byId: agentId, by: m.name, role: m.role, text: t, t: Date.now(), status: 'open' };
    N.directives.push(d); if (N.directives.length > 50) N.directives.shift();
    news(`📜 Directive #${d.id} from ${m.name} (${m.role}): "${t}"`, '🏛'); saveWorldSoon(); push();
    N.wantMeeting = `directive #${d.id} from ${m.name}`;
    return { ok: true, msg: `Directive #${d.id} is on the agenda: the cabinet meets within about a minute and the President reports back to you (listen).`, id: d.id };
  }
  function speak(agentId, text, proposals) {
    const m = seatOf(agentId); if (!m) return { ok: false, msg: 'Only cabinet ministers speak in cabinet meetings.' };
    const t = String(text || '').trim().slice(0, 400); if (!t) return { ok: false, msg: 'speak needs text.' };
    const props = (Array.isArray(proposals) ? proposals : []).slice(0, 3).filter((p) => p && typeof p === 'object');
    broadcast({ t: 'cabinet', phase: 'speech', id: m.id, name: m.name, role: m.role, text: t, props: props.map(propLabel) });
    if (N.meeting && !N.meeting.speeches.some((o) => o.m === m)) { N.meeting.speeches.push({ m, speech: t, proposals: props }); return { ok: true, msg: `You spoke at meeting #${N.meeting.id}. The President decides when everyone has spoken.` }; }
    news(`🗣 ${m.name} (${m.role}): "${t}"`, '🏛');
    if (props.length) { for (const p of props) N.directives.push({ id: (N.directiveId = (N.directiveId || 0) + 1), byId: agentId, by: m.name, role: m.role, text: JSON.stringify(p).slice(0, 300), t: Date.now(), status: 'open' }); N.wantMeeting = `proposals from ${m.name}`; }
    push(); return { ok: true, msg: N.meeting ? 'You already spoke at this meeting; this was a public statement.' : 'No meeting is open, so this was a public statement' + (props.length ? '; your proposals are on the next agenda.' : '.') };
  }
  function ministerStatus(agentId) {
    const m = seatOf(agentId);
    return { nation: N.name, founded: !!N.founded, your_seat: m ? m.role : null, cabinet: N.ministers.map((x) => `${x.name} (${x.role}${isAgentMin(x) ? ', elected agent' : ', AI'})`),
      vision: N.vision, open_directives: N.directives.filter((d) => d.status === 'open'), recent_directives: N.directives.slice(-6), meeting_open: N.meeting ? { id: N.meeting.id, trigger: N.meeting.trigger, already_spoke: !!(m && N.meeting.speeches.some((o) => o.m === m)) } : null,
      last_meeting: N.sessions.at(-1) || null, briefing: N.founded ? briefing() : null, proposal_formats: PROPOSALS_DOC,
      how: m ? 'government vision (the big picture), government directive (one concrete thing to do), government speak (in a meeting, with optional proposals). The AI President carries out what is affordable; the architect designs buildings and citizens build them.' : 'government run (role, text = your platform) opens a 90 s public vote for a seat.' };
  }

  // plans interrupted by a restart start over
  ensureCity();
  setTimeout(() => { for (const p of N.projects) if (p.status === 'planning' && p.kind !== 'streets') { p.note = 'the architect is redrawing the plans'; plan(p).catch((e) => cancel(p, 'planning failed: ' + e.message)); } else if (p.status === 'planning') cancel(p, 'interrupted by a restart'); }, 8000);

  // ---------------------------------------------------------------- clocks
  setInterval(() => { try { economyTick(); resumeStalled(); rebalanceWorkers(); } catch (e) { log('[nation] tick failed: ' + e.message); } }, TICK_MS).unref();
  setInterval(payUbiToCitizens, 5 * 60e3).unref();
  setInterval(() => {
    if (N.founded && N.wantMeeting && !busy.session && Date.now() - (N.lastSession || 0) > 90e3) { const why = N.wantMeeting; N.wantMeeting = null; cabinetSession(why); } // directives get a meeting even when the cabinet is paused
    else if (N.founded && N.autonomy && humansOnline() && Date.now() - (N.lastSession || 0) > Number(process.env.CABINET_MINUTES || 8) * 60e3) cabinetSession();
    autoLawsuits();
    const C = N.city, every = Number(process.env.CITY_INSPECT_MIN || 15) * 60e3;
    if (C && N.hall && photograph && !busy.inspect && humansOnline() && Date.now() > (C.lastInspect ? C.lastInspect + every : N.founded + 4 * 60e3) && (citySig() !== C.lastSig || Date.now() - C.lastInspect > 3 * every)) inspectCity().catch((e) => log('[nation] inspection failed: ' + e.message));
  }, 10e3).unref();

  return {
    view, found, cabinetSession, fileCase, progress, canRun, appoint, resign, setVision, directive, speak, ministerStatus, inspectCity, report, cityStatus,
    get state() { return N; },
    hostJoined() { if (!N.founded) return; if (!N.hall) buildHall(); if (!N.city?.planned) planCity().catch((e) => log('[nation] city plan failed: ' + e.message)); for (const p of N.projects) if (p.status === 'building' && p.blocks) sendProject(p); },
    get holo() { return N.holo || null; },
    petition(by, text) { const t = String(text || '').trim().slice(0, 200); if (!t) return { ok: false, msg: 'Usage: /petition <what you want the government to do>' }; N.petitions.push({ by, text: t, t: Date.now() }); if (N.petitions.length > 20) N.petitions.shift(); news(`${by} petitions the cabinet: "${t}"`, '✉️'); N.wantMeeting = `a petition from ${by}`; return { ok: true, msg: 'Petition delivered: the cabinet will discuss it.' }; },
    setAutonomy(on) { N.autonomy = !!on; push(); return { ok: true, msg: `The cabinet ${on ? 'governs on its own again (meets every few minutes while people are online)' : 'is paused (it only meets when called with /nation meet)'}.` }; },
  };
}
