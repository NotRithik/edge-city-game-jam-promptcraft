// PromptCraft server — serves the single-page game and is the only thing that talks to the AI model
// (Google Gemini by default, or Claude with PROVIDER=anthropic).
// Guards: a shared GAME_PASSWORD for AI calls, and a hard dollar budget (BUDGET_USD) persisted to data/usage.json.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { WebSocketServer } from 'ws';
import { makeSandboxes } from './sandbox.js';
import { startChain, nationId } from './chain.js';
import { startNation, NATION_LAWS } from './nation.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}

const PORT = Number(process.env.PORT || 8787);
const BUDGET_USD = Number(process.env.BUDGET_USD || 5);
const PROVIDER = (process.env.PROVIDER || 'gemini').toLowerCase(); // 'gemini' | 'anthropic'
const MODEL = process.env.MODEL || (PROVIDER === 'gemini' ? 'gemini-4-argon' : 'claude-opus-5-5');
const AGENT_MODEL = process.env.AGENT_MODEL || MODEL;
const EFFORT = process.env.EFFORT || 'medium';
const AGENT_EFFORT = process.env.AGENT_EFFORT || 'low';
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 32768);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 4);
const MOCK = process.env.MOCK === '1';
let PASSWORD = process.env.GAME_PASSWORD || '';
if (!PASSWORD) {
  PASSWORD = crypto.randomBytes(4).toString('hex');
  console.log(`\n  No GAME_PASSWORD set — generated one for this run: ${PASSWORD}\n`);
}

// $ per million tokens: [input, output (incl. thinking), cache write, cache read]
// Gemini 4 Argon has introductory pricing until 2026-11-30, then doubles.
const argonPrice = () => (Date.now() < Date.UTC(2026, 11, 1) ? [2, 10, 0, 0.1] : [4, 20, 0, 0.2]);
const priceOf = (model) => (model === 'gemini-4-argon' ? argonPrice() : PRICES[model] || UNKNOWN_PRICE);
const PRICES = {
  'claude-opus-5-5': [4, 20, 5, 0.2],
  'claude-sonnet-5-5': [2, 10, 2.5, 0.2],
  'claude-haiku-5-5': [0.1, 0.5, 0.125, 0.01],
  'claude-fable-5-1': [10, 50, 12.5, 0.25],
  'claude-opus-5': [5, 25, 6.25, 0.5],
  'claude-opus-4-8': [5, 25, 6.25, 0.5],
};
const UNKNOWN_PRICE = [10, 50, 12.5, 1]; // be conservative about models we don't know

const SYSTEM_PROMPT = fs.readFileSync(path.join(ROOT, 'prompt.md'), 'utf8');
const INDEX_FILE = path.join(ROOT, 'public', 'index.html');
const USAGE_FILE = path.join(ROOT, 'data', 'usage.json');
fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });

let usage = { spentUsd: 0, requests: 0, inputTokens: 0, outputTokens: 0 };
try { usage = { ...usage, ...JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')) }; } catch {}
const saveUsage = () => fs.writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2));
let reservedUsd = 0; // worst-case cost of in-flight requests, so concurrent calls can't overshoot the budget
let inFlight = 0;

const claude = !MOCK && PROVIDER === 'anthropic' ? new Anthropic() : null;
const gemini = !MOCK && PROVIDER === 'gemini' ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, ...(process.env.GEMINI_BASE_URL ? { httpOptions: { baseUrl: process.env.GEMINI_BASE_URL } } : {}) }) : null;
if (!MOCK && PROVIDER === 'gemini' && !process.env.GEMINI_API_KEY) console.log('\n  ⚠ GEMINI_API_KEY is not set in .env — AI calls will fail.\n');

const ROLE_TEXT = {
  creator: `You are the CREATOR, the world-shaping spirit of this game. A player typed a request. Make it real with one act reply.`,
  region: `You are the WORLD GENERATOR. A player approved generating a new REGION of the world (its bounds, the scanner readout and the neighbouring regions are in the context). Design it like a planet or biome in No Man's Sky: one coherent theme with its own terrain shape, palette, flora, fauna, resources and dangers. In ONE act reply, in this order: define 2-6 new blocks (surface, stone, plants, ores, crystals… give some of them behaviour), 1-3 creatures native to it (use "states" state machines so they feel alive: grazing, hunting, fleeing, sleeping at night…), optionally 1-2 items or weapons made from local resources, then exactly ONE "biome" definition that uses them, then {"do":"region","biome":"<that key>"}, then 1-3 landmark builds (ruins, a nest, a shrine, a crashed ship…) at absolute coordinates inside the region; they snap to the new ground. "pos" is the region centre. "message" = a 1-2 sentence travel-guide blurb.`,
  agent: `You are an AI INHABITANT of the world with a mind of your own (your persona, goal, memory, recent events and current behaviour are in the context). Something needs your attention (see the event): a player spoke to you, another creature told you something, something happened to you, or it is your own initiative. Act in character with one act reply ("self" = you). Keep each turn modest: one building, invention, deal or plan per turn. You can change how you behave between turns with {"do":"program","target":"self",...} (state machines, brain, abilities, event handlers) — that is how you learn and adapt. You can talk to others with "tell", trade with "charge"/"reward", and propose laws with "propose". Don't use "give" unless a player asked you for something. Speak in character in "message" (short; empty if you have nothing to say) and leave yourself a "note" about what you did and plan next.`,
};

const ACT_TOOL = {
  name: 'act',
  description: 'Apply your changes to the game world. Call this exactly once per turn with every action to run, in order (definitions first, then builds, spawns and effects).',
  eager_input_streaming: true,
  input_schema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Short reply shown in chat (1-2 sentences, fun, in character).' },
      actions: { type: 'array', items: { type: 'object' }, description: 'Actions in the PromptCraft action language.' },
      note: { type: 'string', description: 'Agents only: private memory note for your future self.' },
    },
    required: ['message', 'actions'],
  },
};

function costOf(u, model) {
  const p = priceOf(model);
  return ((u.input_tokens || 0) * p[0] + (u.output_tokens || 0) * p[1] +
    (u.cache_creation_input_tokens || 0) * p[2] + (u.cache_read_input_tokens || 0) * p[3]) / 1e6;
}
function messageCost(msg, model) {
  const iters = msg.usage?.iterations;
  // With server-side fallbacks, each attempt is listed separately; unknown fallback models are priced conservatively.
  if (Array.isArray(iters) && iters.length) return iters.reduce((s, it) => s + costOf(it, it.model || (it.type === 'fallback_message' ? 'unknown' : model)), 0);
  return costOf(msg.usage || {}, model);
}
function worstCase(model, chars) {
  const p = priceOf(model);
  return ((chars / 3) * p[0] + MAX_TOKENS * p[1]) / 1e6;
}

const userText = (role, prompt, context) => `${ROLE_TEXT[role]}\n\n<game_context>\n${context}\n</game_context>\n\n` +
  (role === 'agent' ? `<event>\n${prompt || 'Nothing new happened. Decide what to do next.'}\n</event>` : `<player_request>\n${prompt}\n</player_request>`);

function recordUsage(role, model, cost, inTok, outTok, extra) {
  usage.spentUsd += cost; usage.requests++; usage.inputTokens += inTok; usage.outputTokens += outTok;
  saveUsage();
  console.log(`[ai] ${role} ${model} ${extra} in=${inTok} out=${outTok} cost=$${cost.toFixed(4)} total=$${usage.spentUsd.toFixed(3)}`);
}

// The model's JSON is usually valid, but long plans sometimes carry a slip: a // comment, a trailing comma, a raw newline
// inside a string, prose around the object. Repair those before giving up.
function parseLooseJSON(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { return JSON.parse(raw); } catch {}
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}'), body = a >= 0 && b > a ? raw.slice(a, b + 1) : raw;
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i], nx = body[i + 1];
    if (inStr) {
      if (esc) { esc = false; out += ch; continue; }
      if (ch === '\\') { esc = true; out += ch; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : ch; continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === '/' && nx === '/') { while (i < body.length && body[i] !== '\n') i++; continue; }
    if (ch === '/' && nx === '*') { i = body.indexOf('*/', i + 2); if (i < 0) break; i++; continue; }
    out += ch;
  }
  out = out.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(out); // throws if it is still broken
}

// Gemini (Interactions API). JSON mode instead of tools: one request, one JSON plan back. images = base64 JPEGs (sandbox previews).
async function callGemini(role, prompt, context, images = [], retried = false) {
  const model = role === 'agent' ? AGENT_MODEL : MODEL;
  const text = userText(role, prompt, context);
  const it = await gemini.interactions.create({
    model,
    system_instruction: SYSTEM_PROMPT,
    input: images.length ? [{ type: 'text', text }, ...images.map((data) => ({ type: 'image', data, mime_type: 'image/jpeg' }))] : text,
    generation_config: { thinking_level: role === 'agent' ? AGENT_EFFORT : EFFORT, max_output_tokens: MAX_TOKENS },
    response_format: { type: 'text', mime_type: 'application/json' },
    store: false,
  }, { timeout: 15 * 60e3 });
  const u = it.usage || {}, p = priceOf(model);
  const input = u.total_input_tokens || 0, cached = Math.min(u.total_cached_tokens || 0, input);
  const output = (u.total_output_tokens || 0) + (u.total_thought_tokens || 0);
  const cost = ((input - cached) * p[0] + cached * p[3] + output * p[1]) / 1e6;
  recordUsage(role, model, cost, input, output, `status=${it.status} cached=${cached}`);
  if (it.status !== 'completed') {
    return { message: it.status === 'incomplete' ? 'That was too big for one go (hit the output limit). Try something smaller or in parts.' : `The AI stopped early (${it.status}). Try again!`, actions: [], cost };
  }
  let out;
  try { out = parseLooseJSON(it.output_text); } catch (e) {
    console.warn(`[ai] unparseable JSON from ${model} (${String(it.output_text || '').length} chars): ${e.message}`);
    if (!retried) { const again = await callGemini(role, prompt, context, images, true); again.cost = (again.cost || 0) + cost; return again; } // one more try
    return { message: 'The AI sent back broken JSON twice. Try rephrasing, or ask for it in smaller parts.', actions: [], cost };
  }
  if (Array.isArray(out)) out = { message: '', actions: out };
  if (out?.ok === true && !out.actions?.length) return { ok: true, message: String(out.message || ''), actions: [], cost }; // a review that found nothing to fix
  if (!out || !Array.isArray(out.actions)) return { message: String(out?.message || 'The AI made no changes.'), actions: [], cost };
  return { message: String(out.message || ''), actions: out.actions, note: out.note ? String(out.note) : '', cost };
}

// The nation's people (citizens, ministers, the judge) answer in plain JSON, not the action language.
const NATION_SYSTEM = `You are the simulation engine behind the citizens, ministers and judge of a nation inside PromptCraft, a multiplayer voxel game. Each request says who you are playing and exactly what JSON to return. Stay in character, be concrete and brief, keep it playful and PG. The currency is a mock in-game token with no real-world value. Reply with JSON only.`;
async function callJSON(prompt, { effort, cheap } = {}) {
  const model = cheap ? AGENT_MODEL : MODEL, level = effort || (cheap ? AGENT_EFFORT : EFFORT), parse = (t) => { try { return parseLooseJSON(t); } catch { return null; } };
  if (PROVIDER === 'gemini') {
    const it = await gemini.interactions.create({ model, system_instruction: NATION_SYSTEM, input: prompt, generation_config: { thinking_level: level, max_output_tokens: 16000 }, response_format: { type: 'text', mime_type: 'application/json' }, store: false }, { timeout: 5 * 60e3 });
    const u = it.usage || {}, p = priceOf(model), input = u.total_input_tokens || 0, cached = Math.min(u.total_cached_tokens || 0, input), output = (u.total_output_tokens || 0) + (u.total_thought_tokens || 0);
    const cost = ((input - cached) * p[0] + cached * p[3] + output * p[1]) / 1e6;
    recordUsage('nation', model, cost, input, output, `status=${it.status}`);
    return { json: it.status === 'completed' ? parse(it.output_text) : null, cost };
  }
  const msg = await claude.beta.messages.stream({ model, max_tokens: 16000, output_config: { effort: level }, system: NATION_SYSTEM, messages: [{ role: 'user', content: prompt }] }).finalMessage();
  const cost = messageCost(msg, model);
  recordUsage('nation', model, cost, msg.usage?.input_tokens || 0, msg.usage?.output_tokens || 0, `stop=${msg.stop_reason}`);
  return { json: parse(msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('')), cost };
}

async function callClaude(role, prompt, context, images = []) {
  const model = role === 'agent' ? AGENT_MODEL : MODEL;
  const ut = userText(role, prompt, context);
  const user = images.length ? [{ type: 'text', text: ut }, ...images.map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } }))] : ut;
  const params = {
    model,
    max_tokens: MAX_TOKENS,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default', // if a safety classifier declines, the API retries on Anthropic's recommended fallback model
    output_config: { effort: role === 'agent' ? AGENT_EFFORT : EFFORT },
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    tools: [ACT_TOOL],
    messages: [{ role: 'user', content: user }],
  };
  let msg;
  for (let attempt = 0; ; attempt++) {
    try { msg = await claude.beta.messages.stream(params).finalMessage(); break; }
    catch (e) { if (e instanceof Anthropic.APIError || attempt >= 1) throw e; } // unparseable tool JSON: re-issue once
  }
  const cost = messageCost(msg, model);
  recordUsage(role, model, cost, (msg.usage?.input_tokens || 0) + (msg.usage?.cache_read_input_tokens || 0) + (msg.usage?.cache_creation_input_tokens || 0),
    msg.usage?.output_tokens || 0, `stop=${msg.stop_reason} cacheRead=${msg.usage?.cache_read_input_tokens}`);

  if (msg.stop_reason === 'refusal') return { message: 'The AI declined that one — try something else!', actions: [], cost };
  const call = msg.content.find((b) => b.type === 'tool_use' && b.name === 'act');
  if (msg.stop_reason === 'max_tokens' && call) return { message: 'That was too big for one go (ran out of tokens). Try asking for something smaller or in parts.', actions: [], cost };
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!call) return { message: text || '(the AI made no changes)', actions: [], cost };
  const input = call.input || {};
  if (!Array.isArray(input.actions)) return { message: 'The AI sent a malformed plan — try again.', actions: [], cost };
  return { message: String(input.message || text || ''), actions: input.actions, note: input.note ? String(input.note) : '', cost };
}

// Canned response so the whole pipeline can be tested without an API key (MOCK=1).
function mockReply(prompt, role) {
  if (role === 'region') return { // a canned region so the whole region pipeline can be tested without an API key
    message: '(mock) The Ember Wastes: ash dunes, glowcap mushrooms and grumpy ember imps that nap at night.',
    actions: [
      { do: 'define', kind: 'block', key: 'mock_ash', name: 'Ash Sand', color: '#5a4a48', color2: '#3a302e', pattern: 'noise' },
      { do: 'define', kind: 'block', key: 'mock_basalt', name: 'Basalt', color: '#2b2526', color2: '#433a3b', pattern: 'bricks' },
      { do: 'define', kind: 'block', key: 'mock_glowcap', name: 'Glowcap', color: '#ff7a3a', color2: '#ffd27a', pattern: 'dots', glow: 1, solid: false },
      { do: 'define', kind: 'entity', key: 'mock_imp', name: 'Ember Imp', model: { template: 'humanoid', scale: 0.6, colors: { primary: '#ff5a2a', secondary: '#7a1a0a' } }, hp: 12, speed: 3.5, team: 'monster',
        states: { initial: 'roam',
          roam: { brain: { move: 'wander' }, transitions: [{ to: 'hunt', when: "count('nearby r=10 team=player') > 0" }, { to: 'nap', when: 'night', after: 3 }] },
          hunt: { brain: { move: 'chase', targets: 'team=player' }, enter: [{ do: 'particles', emoji: '😠', count: 2 }], transitions: [{ to: 'flee', when: 'self.hp < self.maxHp * 0.4' }, { to: 'roam', when: "count('nearby r=16 team=player') == 0", after: 2 }] },
          flee: { brain: { move: 'flee' }, transitions: [{ to: 'roam', after: 6 }] },
          nap: { brain: { move: 'idle' }, tick: [{ do: 'particles', emoji: '💤', count: 1 }], every: 2, transitions: [{ to: 'roam', when: '!night' }] } },
        on: { death: [{ do: 'reward', target: 'source', amount: 3, memo: 'imp bounty' }] } },
      { do: 'define', kind: 'biome', key: 'mock_wastes', name: 'Ember Wastes', terrain: { height: 38, amplitude: 10, style: 'dunes' }, surface: 'mock_ash', filler: 'mock_ash', stone: 'mock_basalt', liquid: 'lava', seaLevel: 26,
        features: [{ type: 'plant', block: 'mock_glowcap', chance: 0.02 }, { type: 'pillar', block: 'mock_basalt', chance: 0.002, height: [4, 9] }],
        sky: { color: '#4a2418', fog: '#6a3020', bright: 0.8 }, gravity: 0.8, mobs: [{ type: 'mock_imp', max: 4, chance: 0.5 }],
        on: { enter: [{ do: 'title', text: 'Ember Wastes', seconds: 2 }] } },
      { do: 'region', biome: 'mock_wastes' },
      { do: 'build', at: 'pos', ops: [{ op: 'cylinder', base: [0, 0, 0], radius: 2, height: 7, block: 'mock_basalt' }, { op: 'set', at: [0, 7, 0], block: 'glowstone' }] },
    ],
    cost: 0,
  };
  return {
    message: `(mock) Here's a glowing watchtower for "${prompt.slice(0, 40)}" plus a sparky friend.`,
    note: 'mock note',
    actions: [
      { do: 'define', kind: 'block', key: 'mock_crystal', name: 'Mock Crystal', color: '#b36bff', color2: '#e8ccff', pattern: 'crystal', glow: 1,
        on: { touch: [{ do: 'push', target: 'target', dir: 'up', force: 14 }, { do: 'sound', name: 'boing' }] } },
      { do: 'build', at: 'self ^0 ^0 ^8', ops: [
        { op: 'cylinder', base: [0, 0, 0], radius: 3, height: 10, block: 'cobblestone', hollow: true },
        { op: 'cone', base: [0, 10, 0], radius: 4, height: 5, block: 'brick' },
        { op: 'set', at: [0, 15, 0], block: 'mock_crystal' },
      ] },
      { do: 'define', kind: 'entity', key: 'sparky', name: 'Sparky', model: { template: 'floater', colors: { primary: '#ffe14d', eyes: '#222' } },
        hp: 10, speed: 4, team: 'player', brain: { move: 'follow' },
        abilities: [{ name: 'zap', cooldown: 3, when: "count('nearby r=8 team=monster') > 0", actions: [
          { do: 'beam', from: 'self', to: "nearest('r=8 team=monster')", color: '#ffe14d' },
          { do: 'damage', target: 'nearest r=8 team=monster', amount: 4 }] }] },
      { do: 'spawn', type: 'sparky', at: 'self ^0 ^1 ^2' },
    ],
    cost: 0,
  };
}

// --- tiny HTTP helpers
const failures = new Map(); // ip -> {n, t}
// Behind Caddy / Cloudflare the socket is always 127.0.0.1, so use the proxy's forwarded client IP.
const clientIp = (req) => req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress || '?';
function adminOk(req) { // the activity log is for whoever runs the game: ADMIN_PASSWORD if set, otherwise the game password
  const given = String(req.headers['x-admin-password'] || req.headers['x-game-password'] || '');
  const h = (v) => crypto.createHash('sha256').update(v).digest();
  return crypto.timingSafeEqual(h(given), h(process.env.ADMIN_PASSWORD || PASSWORD));
}
function activityReport(limit) {
  let events = [];
  try { events = fs.readFileSync(ACTIVITY_FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}
  const count = (pick) => { const m = {}; for (const e of events) { const k = pick(e); if (k) m[k] = (m[k] || 0) + (e.n || 1); } return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 25)); };
  const players = {}, minutes = {};
  for (const e of events) { if (e.ev === 'join') players[e.who] = (players[e.who] || 0) + 1; if (e.ev === 'leave') minutes[e.who] = (minutes[e.who] || 0) + (e.mins || 0); }
  return {
    since: events[0]?.t, total_events: events.length, players_by_joins: players, events_by_type: count((e) => e.ev),
    minutes_played: minutes,
    ai_requests: events.filter((e) => e.ev === 'ai_call').slice(-40).map((e) => `${e.who}: ${e.prompt}${e.ok ? '' : ' (failed)'}`),
    blocks_broken: count((e) => (e.ev === 'break' ? e.key : null)), blocks_placed: count((e) => (e.ev === 'place' ? e.key : null)),
    crafted: count((e) => (e.ev === 'craft' ? e.key : null)), killed: count((e) => (e.ev === 'kill' ? e.key : null)), npcs_talked_to: count((e) => (e.ev === 'interact' ? e.key : null)),
    commands: count((e) => (e.ev === 'cmd' ? e.key : null)), recent: events.slice(-limit),
  };
}
function passwordOk(req) {
  const given = String(req.headers['x-game-password'] || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}
function tooManyFailures(req) {
  const f = failures.get(clientIp(req));
  return f && f.n >= 10 && Date.now() - f.t < 10 * 60e3;
}
function noteFailure(req) {
  const ip = clientIp(req), f = failures.get(ip) || { n: 0, t: 0 };
  failures.set(ip, { n: Date.now() - f.t > 10 * 60e3 ? 1 : f.n + 1, t: Date.now() });
}
function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
// The frontend is hosted separately (Vercel), so allow cross-origin calls. The password still gates the AI.
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim());
function cors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  if (CORS_ORIGINS.includes('*')) res.setHeader('access-control-allow-origin', '*');
  else if (CORS_ORIGINS.includes(origin)) { res.setHeader('access-control-allow-origin', origin); res.setHeader('vary', 'origin'); }
  res.setHeader('access-control-allow-headers', 'content-type, x-game-password');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-max-age', '600');
}
const status = () => ({ budgetUsd: BUDGET_USD, spentUsd: +usage.spentUsd.toFixed(4), provider: PROVIDER, model: MODEL, agentModel: AGENT_MODEL, mock: MOCK, online: clients.size, agents: Object.keys(world.agents || {}).length, currency: CURRENCY, mcp: '/mcp' });

async function handleAI(req, res) {
  if (tooManyFailures(req)) return send(res, 429, { error: 'Too many wrong passwords. Wait a few minutes.' });
  if (!passwordOk(req)) { noteFailure(req); return send(res, 401, { error: 'Wrong or missing password' }); }
  let body;
  try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
  const role = ['agent', 'region'].includes(body.role) ? body.role : 'creator';
  const prompt = String(body.prompt || '').slice(0, 2000);
  if (!prompt.trim()) return send(res, 400, { error: role === 'agent' ? 'Agents only act when someone talks to them.' : 'Empty prompt' });
  const context = String(body.context || '');
  const r = await aiCall(role, prompt, context);
  const site = cleanSite(body.site);
  if (r.code === 200 && role === 'creator' && site && REVIEW_ROUNDS > 0 && needsReview(r.out.actions)) {
    try { r.out = await reviewDraft({ prompt, context, out: r.out, site }); } catch (e) { console.warn('[review] skipped:', e.message); }
  }
  logActivity(String(body.player || '?').slice(0, 30), 'ai_call', { role, prompt: prompt.slice(0, 400), ok: r.code === 200, error: r.error, message: r.out?.message?.slice(0, 300), reviewed: r.out?.review,
    defined: (r.out?.actions || []).filter((a) => a?.do === 'define').map((a) => `${a.kind}:${a.key}`).slice(0, 20) });
  send(res, r.code, r.code === 200 ? { ...r.out, ...status() } : { error: r.error, ...status() });
}
// One budgeted AI call (used by the page's /api/ai and by outside agents' "create"). Returns { code, out | error }.
async function aiCall(role, prompt, context, images = [], meta = {}) {
  context = context.slice(0, 24000);
  if (inFlight >= MAX_CONCURRENT) return { code: 429, error: 'The AI is busy — try again in a moment.' };
  const model = role === 'agent' ? AGENT_MODEL : MODEL;
  const worst = MOCK ? 0 : worstCase(model, SYSTEM_PROMPT.length + context.length + prompt.length + images.length * 6000);
  if (usage.spentUsd + reservedUsd + worst > BUDGET_USD) {
    const error = usage.spentUsd >= BUDGET_USD - 0.01 ? `AI budget used up ($${usage.spentUsd.toFixed(2)} of $${BUDGET_USD}).`
      : `Not enough AI budget left for another request ($${usage.spentUsd.toFixed(2)} of $${BUDGET_USD} used; one request can cost up to $${worst.toFixed(2)}).`;
    return { code: 402, error };
  }
  inFlight++; reservedUsd += worst;
  const t0 = Date.now();
  console.log(`[ai] ${role} request${prompt ? `: "${prompt.slice(0, 80)}"` : ''} (in flight: ${inFlight})`);
  try {
    const out = role === 'nation' ? (MOCK ? { json: null, cost: 0 } : await callJSON(prompt, meta)) : MOCK ? (images.length ? { ok: true, message: '', actions: [], cost: 0 } : mockReply(prompt, role)) : PROVIDER === 'gemini' ? await callGemini(role, prompt, context, images) : await callClaude(role, prompt, context, images);
    fs.appendFile(path.join(ROOT, 'data', 'ai-log.jsonl'), JSON.stringify({ t: new Date().toISOString(), secs: (Date.now() - t0) / 1000, role, prompt, images: images.length || undefined, ...out }) + '\n', () => {});
    return { code: 200, out };
  } catch (e) {
    console.error('[ai] error', e?.status || '', e?.message);
    if (PROVIDER === 'gemini') {
      const st = e?.status;
      if (st === 401 || st === 403) return { code: 500, error: `Gemini rejected the API key (${st}). Check GEMINI_API_KEY — ${MODEL} needs a paid-tier key.` };
      if (st === 404) return { code: 500, error: `Model ${MODEL} not found for this key (it needs a paid-tier Gemini API key).` };
      if (st === 429) return { code: 429, error: 'Gemini rate limit hit — try again shortly.' };
      return { code: 502, error: `Gemini error${st ? ' ' + st : ''}: ${String(e?.message || e).slice(0, 300)}` };
    }
    if (e instanceof Anthropic.AuthenticationError) return { code: 500, error: 'Server has no valid ANTHROPIC_API_KEY.' };
    if (e instanceof Anthropic.RateLimitError) return { code: 429, error: 'Claude rate limit hit — try again shortly.' };
    if (e instanceof Anthropic.APIError) return { code: 502, error: `Claude API error ${e.status}: ${e.message}` };
    return { code: 500, error: String(e?.message || e) };
  } finally { inFlight--; reservedUsd -= worst; }
}

// ============================================================================ sandboxes + the Creator's self-review
// A sandbox is a private copy of the world around a "site" (where the asker stands and which way they face), rendered by
// headless Chrome (sandbox.js). The Creator previews its own drafts there: it looks at them, rides and right-clicks what it
// made, and fixes what's wrong before anything reaches the real world. Outside agents get the same thing as the "sandbox" tool.
const sandboxes = makeSandboxes({ baseUrl: `http://127.0.0.1:${PORT}`, max: Number(process.env.SANDBOX_MAX || 3) });
const REVIEW_ROUNDS = Math.max(0, Math.min(3, Number(process.env.CREATOR_REVIEW ?? 1))); // 0 turns the Creator's self-review off
function cleanSite(v) {
  const p = v?.pos; if (!p || ![p.x, p.y, p.z].every(Number.isFinite)) return null;
  return { pos: { x: +p.x, y: Math.max(-10, Math.min(200, +p.y)), z: +p.z }, yaw: Number.isFinite(+v.yaw) ? +v.yaw : 0, pitch: Number.isFinite(+v.pitch) ? Math.max(-1.55, Math.min(1.55, +v.pitch)) : 0 };
}
function sandboxSnap(site, time) { // the world near the site (block edits within ~150 blocks, creatures within 80)
  const cx = Math.floor(site.pos.x / 16), cz = Math.floor(site.pos.z / 16), edits = {};
  for (const [k, v] of Object.entries(world.edits)) { const [x, z] = k.split(',').map(Number); if (Math.abs(x - cx) <= 9 && Math.abs(z - cz) <= 9) edits[k] = v; }
  const near = (p) => p && Math.hypot(p.x - site.pos.x, p.z - site.pos.z) < 80;
  return { seed: world.seed, defs: world.defs, edits, regions: world.regions, globals: world.globals, sky: world.sky, entities: (world.entities || []).filter((e) => near(e.pos)).slice(0, 120), site, time, rd: 6 };
}
const jpeg = (dataUrl) => String(dataUrl).replace(/^data:image\/jpeg;base64,/, '');
function needsReview(actions) { // creatures (riding, scale, behaviour) and builds are where previews pay off
  return sandboxes.available() && Array.isArray(actions) && actions.some((a) => a && (a.do === 'build' || (a.do === 'define' && ['entity', 'entities', 'creature', 'mob'].includes(a.kind))));
}
// Play-test what a draft made: ride rideable creatures, right-click interactive ones. -> { tests, images }
async function autoTest(s, report) {
  const tests = [], images = [];
  for (const c of (report.new_creatures || []).filter((c) => c.ride || c.events?.includes('interact')).slice(0, 2)) {
    const steps = c.ride
      ? [{ do: 'ride', entity: c.id }, { do: 'hold', keys: c.ride.fly ? ['forward', 'jump'] : ['forward'], pitch: c.ride.fly ? 15 : 0, seconds: 3 }, { do: 'view', view: 'pov' }, { do: 'dismount' }]
      : [{ do: 'interact', entity: c.id }, { do: 'wait', seconds: 2 }, { do: 'view', view: 'pov' }];
    const t = await sandboxes.play(s, steps);
    tests.push({ creature: `${c.name} (#${c.id})`, did: c.ride ? 'rode it: held forward 3 s' : 'right-clicked it, waited 2 s', log: t.log.map(({ step, player, ...r }) => ({ do: step.do, ...r, player_pos: player.pos, riding: player.riding })), ...(t.console ? { console: t.console } : {}) });
    images.push(...t.shots.map((x) => x.image));
  }
  return { tests, images };
}
function reviewPrompt(prompt, out, report, tests, round) {
  return `REVIEW YOUR DRAFT (round ${round}). The player asked: "${prompt}".
Your draft (below) was run in a private PREVIEW copy of the world: nothing is real yet. Images: 1) "front" = what the player sees from where they stand, 2) iso view, then views from play-tests (first-person while riding / after right-clicking).
Check it like a demanding player would:
- Does it look like what was asked? Right shape, colours and REAL-WORLD SCALE (1 block = 1 metre: a door 2 tall, a house 6-10, a Boeing 737 is ~38 long with a 36 wingspan, Godzilla ~50-100 tall).
- Is it placed sensibly (not buried, not floating, not on top of the player, not blocking the view)? Do not teleport or move the player to fix a view problem: move the creation instead.
- Do the interactions work? Riding should use the built-in "ride" field (never teleport/push loops), nothing should fly off, error or spam.
- Warnings or errors in the report?
If it is all good, reply exactly {"ok": true}. Otherwise reply with the COMPLETE corrected plan {"message": "...", "actions": [...]} — it REPLACES the draft entirely (keep what was right; you can't patch).

<draft>${JSON.stringify({ message: out.message, actions: out.actions }).slice(0, 60000)}</draft>
<preview_report>${JSON.stringify(report).slice(0, 8000)}</preview_report>
<play_tests>${JSON.stringify(tests).slice(0, 8000)}</play_tests>`;
}
async function reviewDraft({ prompt, context, out, site }) {
  const key = 'review:' + crypto.randomBytes(4).toString('hex'), t0 = Date.now();
  const s = await sandboxes.open(key, sandboxSnap(site));
  let cur = out, rounds = 0, revised = 0;
  try {
    for (; rounds < REVIEW_ROUNDS; rounds++) {
      const report = await sandboxes.apply(s, cur.actions);
      const views = await sandboxes.view(s, [{ view: 'front' }, { view: 'iso' }]);
      const { tests, images } = await autoTest(s, report);
      const r = await aiCall('creator', reviewPrompt(prompt, cur, report, tests, rounds + 1), context, [...views.map((v) => v.image), ...images].slice(0, 6).map(jpeg));
      if (r.code !== 200 || r.out.ok || !r.out.actions?.length) { rounds++; break; }
      cur = { ...r.out, cost: (cur.cost || 0) + (r.out.cost || 0) }; revised++;
      if (rounds + 1 < REVIEW_ROUNDS) await sandboxes.reset(s);
    }
  } finally { sandboxes.close(key); }
  console.log(`[review] "${prompt.slice(0, 50)}" ${rounds} round(s), ${revised} revision(s), ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return { ...cur, review: { rounds, revised } };
}

// ============================================================================ multiplayer + currency
// The server keeps the shared world (seed, block edits, AI definitions, chat, saved creatures) and relays live
// updates. One connected browser is the "host": it simulates creatures and runs the action language; others render.
// Coins live only here (server-authoritative ledger) so they can later be swapped for on-chain tokens.
const WORLD_FILE = path.join(ROOT, 'data', 'world.json');
const CURRENCY = process.env.CURRENCY || 'xRupee'; // Edge Goa's in-game rupee
const START_COINS = Number(process.env.START_COINS || 100);
const KINDS = new Set(['block', 'entity', 'item', 'ability', 'rule', 'structure', 'biome']);
const DEFAULT_LAWS = { taxRate: 0, ubi: 0, rewardMultiplier: 1 };
let world = { seed: Math.floor(Math.random() * 1e6), fresh: true, edits: {}, defs: {}, regions: {}, globals: {}, sky: null, chat: [], entities: [], bank: { accounts: {}, treasury: 0, log: [] }, gov: { laws: { ...DEFAULT_LAWS }, leader: null, proposals: [], nextId: 1 } };
try { world = { ...world, ...JSON.parse(fs.readFileSync(WORLD_FILE, 'utf8')) }; } catch {}
world.regions ||= {}; world.gov ||= { laws: { ...DEFAULT_LAWS }, leader: null, proposals: [], nextId: 1 };
let worldDirty = true;
const saveWorldSoon = () => { worldDirty = true; };
setInterval(() => {
  if (!worldDirty) return; worldDirty = false;
  fs.writeFile(WORLD_FILE + '.tmp', JSON.stringify(world), (err) => {
    if (err) { worldDirty = true; return console.error('world save failed', err.message); }
    fs.rename(WORLD_FILE + '.tmp', WORLD_FILE, (e) => e && console.error('world save failed', e.message));
  });
}, 3000);
// rolling backups (every 30 min, kept for a day) so a bad moment (a wipe, a griefer, a bug) can be rolled back
const BACKUP_DIR = path.join(ROOT, 'data', 'backups');
function backupWorld() {
  try {
    if (!fs.existsSync(WORLD_FILE)) return;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.copyFileSync(WORLD_FILE, path.join(BACKUP_DIR, `world-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`));
    for (const old of fs.readdirSync(BACKUP_DIR).filter((n) => n.startsWith('world-')).sort().slice(0, -48)) fs.unlinkSync(path.join(BACKUP_DIR, old));
  } catch (err) { console.error('world backup failed', err.message); }
}
backupWorld(); setInterval(backupWorld, 30 * 60e3);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { // docker stop / Ctrl-C: write the last few seconds of the world (and the chain) before exiting
  try { fs.writeFileSync(WORLD_FILE, JSON.stringify(world)); } catch (err) { console.error('final world save failed', err.message); }
  try { await chain.stop(); } catch {}
  process.exit(0);
});

// activity log (data/activity.jsonl): who joins, chats, builds, breaks, crafts, asks the AI… so the owner can see how the game is played
const ACTIVITY_FILE = path.join(ROOT, 'data', 'activity.jsonl');
function logActivity(who, ev, data = {}) {
  fs.appendFile(ACTIVITY_FILE, JSON.stringify({ t: new Date().toISOString(), who, ev, ...data }) + '\n', (err) => err && console.error('activity log failed', err.message));
}
setInterval(() => { // start a fresh file past 50 MB
  fs.stat(ACTIVITY_FILE, (err, st) => { if (!err && st.size > 50e6) fs.rename(ACTIVITY_FILE, ACTIVITY_FILE.replace('.jsonl', `-${new Date().toISOString().slice(0, 10)}.jsonl`), () => {}); });
}, 10 * 60e3);
const ACTIVITY_MSGS = { // multiplayer messages worth logging -> event
  chat: (m) => ({ ev: m.kind === 'prompt' ? 'ai_request' : m.kind === 'ai' ? 'ai_reply' : 'chat', text: String(m.text || '').slice(0, 300) }),
  def: (m) => ({ ev: 'define', kind: m.kind, key: m.def?.key, name: m.def?.name }),
  name: (m) => ({ ev: 'rename', to: String(m.name || '').slice(0, 30) }),
  pay: (m) => ({ ev: 'pay', to: m.to, amount: m.amount, memo: m.memo }),
  propose: (m) => ({ ev: 'propose', law: m.law, value: m.value }),
  vote: (m) => ({ ev: 'vote', proposal: m.id ?? m.proposal, yes: m.yes }),
  region: (m) => (m.r?.status === 'ready' ? { ev: 'region', rk: m.rk, name: m.r.name } : null),
};
const clients = new Map(); // ws -> { id, name, ws, pos }
let hostWs = null;
const pubId = (pid) => crypto.createHash('sha256').update('promptcraft:' + pid).digest('hex').slice(0, 10);
const cleanName = (n) => String(n || '').replace(/[^\w\- .]/g, '').trim().slice(0, 20) || 'Player';
// Names are what people @tag, so players and agents online must not collide: duplicates become name_2, name_3…
const RESERVED_NAMES = /^(creator|ai|ada|everyone|all|here)$/i;
function uniqueName(base, selfId) {
  const low = (n) => n.toLowerCase(), taken = (n) => RESERVED_NAMES.test(n) ||
    [...clients.values()].some((c) => c.id !== selfId && low(c.name) === low(n)) || Object.entries(world.agents || {}).some(([id, a]) => id !== selfId && low(a.name) === low(n));
  let n = base; for (let i = 2; taken(n); i++) n = `${base.slice(0, 16)}_${i}`;
  return n;
}
const sendTo = (ws, m) => { if (ws.readyState === 1) ws.send(typeof m === 'string' ? m : JSON.stringify(m)); };
function broadcast(m, except) { const raw = typeof m === 'string' ? m : JSON.stringify(m); for (const c of clients.values()) if (c.ws !== except) sendTo(c.ws, raw); }
function electHost() { // prefer a player whose tab is visible (hidden tabs stop simulating)
  const list = [...clients.keys()], next = list.find((w) => !clients.get(w).away) || list[0] || null;
  if (next === hostWs) return;
  hostWs = next;
  if (!hostWs) return;
  sendTo(hostWs, { t: 'host', entities: world.entities, fresh: world.fresh });
  setTimeout(() => nation.hostJoined(), 3000); // the new host takes over the citizens' building work
  broadcast({ t: 'hostid', id: clients.get(hostWs).id });
}

// --- ledger: wallets + a central "treasury" (rewards come out of it, charges go into it; it may go negative = minting)
const bank = world.bank;
const names = () => Object.fromEntries(Object.entries(bank.accounts).map(([id, a]) => [id, a.name]));
const balances = () => Object.fromEntries(Object.entries(bank.accounts).map(([id, a]) => [id, a.balance]));
const pushBalances = () => broadcast({ t: 'bal', b: balances(), names: names(), treasury: bank.treasury, log: bank.log.slice(-6), chain: chain.status });
function ledger(entry) { bank.log.push({ t: Date.now(), ...entry }); if (bank.log.length > 1000) bank.log.splice(0, bank.log.length - 1000); saveWorldSoon(); }
// Every coin movement goes through pay(): the server ledger changes at once and the on-chain vault (chain.js) follows
// within seconds. The treasury is the account "treasury". It can't go below zero: when it's empty, payouts fail until
// money comes in (taxes, charges) or the central bank prints more (printMoney).
const TREASURY = 'treasury', TREASURY_START = Number(process.env.TREASURY_START || 1_000_000), NATION = 'Edge Goa';
const chain = startChain({ root: ROOT, port: PORT + 1000, currency: CURRENCY });
const balOf = (id) => (id === TREASURY ? bank.treasury : bank.accounts[id]?.balance ?? 0);
const setBal = (id, v) => { if (id === TREASURY) bank.treasury = v; else if (bank.accounts[id]) bank.accounts[id].balance = v; };
function pay(from, to, amount, memo, entry) {
  const n = Math.floor(+amount);
  if (!(n > 0) || from === to || balOf(from) < n || (to !== TREASURY && !bank.accounts[to]) || (from !== TREASURY && !bank.accounts[from])) return false;
  setBal(from, balOf(from) - n); setBal(to, balOf(to) + n);
  chain.move(from, to, n, memo);
  if (entry) ledger(entry);
  return true;
}
function printMoney(amount, memo, by = 'central bank') { // new money into the treasury (inflation!)
  const n = Math.floor(+amount); if (!(n > 0)) return false;
  bank.treasury += n; chain.print(TREASURY, n, memo); ledger({ type: 'print', n, by, memo: String(memo || '').slice(0, 80) }); return true;
}
chain.whenReady(async ({ fresh }) => {
  if (fresh) { // first run on this chain: put today's balances on it (the genesis), with a funded treasury
    chain.clearQueue();
    bank.treasury = Math.max(Math.floor(bank.treasury) || 0, TREASURY_START);
    chain.print(TREASURY, bank.treasury, 'genesis: treasury');
    for (const [id, a] of Object.entries(bank.accounts)) { a.balance = Math.max(0, Math.floor(a.balance) || 0); if (a.balance) chain.print(id, a.balance, 'genesis: ' + a.name.slice(0, 40)); }
    ledger({ type: 'genesis', n: bank.treasury, memo: 'balances moved on-chain' }); console.log(`[chain] genesis: treasury ${bank.treasury}, ${Object.keys(bank.accounts).length} accounts`);
  } else await resyncFromChain();
  world.chain = chain.status; pushBalances(); saveWorldSoon();
});
async function resyncFromChain() { // the chain is the source of truth: adopt its balances (plus moves still on their way to it)
  const ids = [TREASURY, ...Object.keys(bank.accounts)], on = await chain.balances(ids), pend = chain.pendingDelta();
  if (!on) return;
  let diffs = 0;
  for (const id of ids) { const want = (on[id] ?? 0) + (pend[id] || 0); if (balOf(id) !== want) { diffs++; setBal(id, want); } }
  if (diffs) console.log(`[chain] adopted on-chain balances for ${diffs} account(s)`);
}
setInterval(() => { if (chain.ready && chain.needsResync) resyncFromChain().then(pushBalances).catch(() => {}); }, 10e3).unref();
function account(id, name) {
  let a = bank.accounts[id];
  if (!a) { a = bank.accounts[id] = { name: name || 'Player', balance: 0 }; pay(TREASURY, id, START_COINS, 'welcome grant', { type: 'mint', to: id, n: START_COINS, memo: 'welcome grant' }); }
  if (name) a.name = name;
  return a;
}
const findAccount = (who) => { if (bank.accounts[who]) return who; const w = String(who || '').toLowerCase(); const online = [...clients.values()].find((c) => c.name.toLowerCase() === w); if (online) return online.id; return Object.keys(bank.accounts).find((id) => bank.accounts[id].name.toLowerCase() === w) || null; };
const rewardWindow = new Map(); // id -> { start, n } (caps how fast coins can be minted to one player)
const notice = (text) => broadcast({ t: 'notice', text });

// --- government: laws are plain key/values that everyone (and AI-made content, as `law.<key>`) can read. Players
// propose changes and vote; passed laws take effect. Built-in laws: taxRate (% of every /pay that goes to the
// treasury), ubi (coins paid to each online player every 5 min), rewardMultiplier (scales gameplay rewards), leader
// (may grant treasury coins). Any other law is just data the world can react to. A scaffold to grow institutions from.
const gov = world.gov;
const pushGov = () => broadcast({ t: 'gov', gov });
const LAW_RANGE = { taxRate: [0, 50], ubi: [0, 100], rewardMultiplier: [0, 5], ...Object.fromEntries(Object.entries(NATION_LAWS).map(([k, [a, b]]) => [k, [a, b]])) };
function closeProposal(p) {
  const votes = Object.values(p.votes), yes = votes.filter(Boolean).length, no = votes.length - yes, passed = yes > no;
  gov.proposals = gov.proposals.filter((x) => x !== p);
  if (passed && p.law === 'cabinet seat') { const r = nation.appoint(p.agentId, world.agents[p.agentId]?.name || p.value, p.role, p.platform); if (!r.ok) notice(`🏛 ${r.msg}`); }
  else if (passed) { if (p.law === 'leader') { gov.leader = p.value; gov.leaderId = p.leaderId; } else gov.laws[p.law] = p.value; chain.record('enact', [nationId(NATION), p.law, String(p.value), `players' vote ${yes}-${no}`, p.reason || '']); }
  ledger({ type: 'law', law: p.law, value: p.value, passed, yes, no });
  notice(`🗳 Proposal #${p.id} (${p.law} = ${p.value}) ${passed ? 'PASSED' : 'failed'} ${yes}-${no}.`);
  pushGov();
}
setInterval(() => { for (const p of [...gov.proposals]) if (Date.now() > p.closes) closeProposal(p); }, 5000);
function createProposal(m, by) {
  const law = String(m.law || '').replace(/[^\w]/g, '').slice(0, 24); if (!law) return { ok: false, msg: 'A proposal needs a law name.' };
  let value = m.value; if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(+value)) value = +value;
  if (typeof value === 'string') value = value.slice(0, 40); else if (!Number.isFinite(value)) return { ok: false, msg: 'A proposal needs a value (number or short text).' };
  if (LAW_RANGE[law]) value = Math.max(LAW_RANGE[law][0], Math.min(LAW_RANGE[law][1], +value || 0));
  let leaderId = null;
  if (law === 'leader') { leaderId = findAccount(value); if (!leaderId) return { ok: false, msg: `No player called "${value}".` }; value = bank.accounts[leaderId].name; }
  if (gov.proposals.length >= 10) return { ok: false, msg: 'Too many open proposals, wait for some to close.' };
  const p = { id: gov.nextId++, law, value, leaderId, reason: String(m.reason || '').slice(0, 120), by, votes: {}, closes: Date.now() + 90e3 };
  gov.proposals.push(p);
  notice(`🗳 #${p.id}: ${p.by} proposes ${law} = ${value}${p.reason ? ` ("${p.reason}")` : ''}. Vote with /vote ${p.id} yes|no (90 s).`);
  pushGov(); saveWorldSoon();
  return { ok: true, msg: `Proposal #${p.id} opened: ${law} = ${value}. Voting closes in 90 s.`, id: p.id };
}
function transfer(fromId, toWho, amount, memo) { // player/agent -> player/agent payment (taxed by law.taxRate)
  const to = findAccount(toWho), n = Math.floor(Number(amount));
  if (!to) return { ok: false, msg: `No player or agent called "${toWho}".` };
  if (to === fromId) return { ok: false, msg: "You can't pay yourself." };
  if (!(n > 0 && n <= 1e9)) return { ok: false, msg: 'Amount must be a positive whole number.' };
  const a = bank.accounts[fromId], b = bank.accounts[to];
  if (!a || a.balance < n) return { ok: false, msg: `Not enough ${CURRENCY}s (you have ${a?.balance ?? 0}).` };
  const tax = Math.floor((n * Math.max(0, Math.min(50, +gov.laws.taxRate || 0))) / 100);
  pay(fromId, to, n - tax, memo || 'payment'); if (tax) pay(fromId, TREASURY, tax, 'tax'); ledger({ type: 'transfer', from: fromId, to, n, tax, memo: String(memo || '').slice(0, 80) });
  for (const c of clients.values()) if (c.id === to) sendTo(c.ws, { t: 'notice', text: `💰 ${a.name} paid you ${n - tax} ${CURRENCY}s.` });
  if (world.agents?.[to]) pushInbox(to, a.name, `paid you ${n - tax} ${CURRENCY}s${memo ? ` ("${String(memo).slice(0, 80)}")` : ''}`);
  pushBalances();
  return { ok: true, msg: `Paid ${n} ${CURRENCY}s to ${b.name}${tax ? ` (${tax} went to the treasury as tax)` : ''}.` };
}
setInterval(() => { // universal basic income, paid by the treasury (the central bank)
  const n = Math.floor(+gov.laws.ubi || 0); if (!(n > 0) || !clients.size) return;
  for (const c of clients.values()) { account(c.id, c.name); if (!pay(TREASURY, c.id, n, 'UBI')) { notice('🏦 The treasury is empty: no UBI this time.'); return; } }
  ledger({ type: 'ubi', n, players: clients.size }); notice(`🏦 UBI: everyone online received ${n} ${CURRENCY}s from the treasury.`); pushBalances();
}, 5 * 60e3);

function applyEdit(e) {
  if (!Array.isArray(e) || e.length < 4) return;
  const [x, y, z] = e.map(Number), key = String(e[3]).slice(0, 48);
  if (![x, y, z].every(Number.isInteger) || y < 0 || y >= 96) return;
  const cx = Math.floor(x / 16), cz = Math.floor(z / 16), ck = cx + ',' + cz;
  (world.edits[ck] ||= {})[(y * 16 + (z - cz * 16)) * 16 + (x - cx * 16)] = key;
}

function handleMsg(me, m, raw) {
  const isHost = me.ws === hostWs;
  const act = ACTIVITY_MSGS[m.t]?.(m); if (act) { const { ev, ...rest } = act; logActivity(me.name, ev, rest); }
  if (m.t === 'log') { // batched counts from a player's game: break / place / craft / kill / death / eat / interact / mode / cmd / tutorial
    if (Date.now() - (me.logT || 0) < 4000 || !Array.isArray(m.l)) return; me.logT = Date.now();
    for (const e of m.l.slice(0, 80)) if (e && /^[a-z_]{2,20}$/.test(e.ev)) logActivity(me.name, e.ev, { key: String(e.key || '').slice(0, 48) || undefined, n: Math.min(Math.max(Math.floor(+e.n || 1), 1), 1e5) });
    return;
  }
  switch (m.t) {
    case 'p': me.pos = { x: m.x, y: m.y, z: m.z }; me.yaw = m.yaw; me.pitch = m.pitch; broadcast({ t: 'p', id: me.id, x: m.x, y: m.y, z: m.z, yaw: m.yaw, pitch: m.pitch, hp: m.hp, h: typeof m.h === 'string' ? m.h.slice(0, 60) : '' }, me.ws); break;
    case 'away': me.away = !!m.v; if ((isHost && me.away) || (!isHost && !me.away && clients.get(hostWs)?.away)) electHost(); break;
    case 'edits': if (Array.isArray(m.l)) { for (const e of m.l.slice(0, 50000)) applyEdit(e); broadcast(raw, me.ws); saveWorldSoon(); } break;
    case 'def': if (KINDS.has(m.kind) && m.def && typeof m.def.key === 'string') { (world.defs[m.kind] ||= {})[m.def.key] = m.def; broadcast({ t: 'def', kind: m.kind, def: m.def, by: me.name }, me.ws); saveWorldSoon(); } break;
    case 'chat': {
      const line = { name: me.name, text: String(m.text || '').slice(0, 600), kind: ['chat', 'prompt', 'ai'].includes(m.kind) ? m.kind : 'chat', ts: Date.now() };
      world.chat.push(line); if (world.chat.length > 200) world.chat.splice(0, world.chat.length - 200);
      broadcast({ t: 'chat', ...line }, me.ws); saveWorldSoon(); deliverMentions(line); break;
    }
    case 'agentcode': { // one-time code that links an outside agent (join_world {code}) to this player
      const code = 'PC-' + crypto.randomBytes(3).toString('hex').toUpperCase();
      agentCodes.set(code, { owner: me.id, expires: Date.now() + 30 * 60e3 });
      sendTo(me.ws, { t: 'agentcode', code, mcp: PUBLIC_MCP }); break;
    }
    case 'name': me.name = uniqueName(cleanName(m.name), me.id); account(me.id, me.name); sendTo(me.ws, { t: 'you', name: me.name }); broadcast({ t: 'name', id: me.id, name: me.name }, me.ws); pushBalances(); break;
    // host -> everyone
    case 'ents': case 'fx': if (isHost) broadcast(raw, me.ws); break;
    case 'entsave': if (isHost && Array.isArray(m.l)) { world.entities = m.l; world.fresh = false; if (m.g && typeof m.g === 'object') world.globals = m.g; broadcast(raw, me.ws); saveWorldSoon(); } break;
    case 'sky': if (isHost) { world.sky = m.sky; broadcast(raw, me.ws); saveWorldSoon(); } break;
    case 'pfx': if (isHost) for (const c of clients.values()) if (c.id === m.to) sendTo(c.ws, raw); break;
    // anyone -> host (the host runs all game logic)
    case 'run': case 'use': case 'hit': case 'interact': case 'blockev': case 'spawn': case 'ride': case 'drop': case 'agentnote': case 'cmd':
      if (hostWs && !isHost) sendTo(hostWs, { ...m, from: me.id }); break;
    // currency
    case 'pay': { const r = transfer(me.id, m.to, m.amount, m.memo); sendTo(me.ws, { t: 'ledger', rid: m.rid, ok: r.ok, msg: r.msg }); break; }
    case 'reward': {
      if (!isHost) return;
      const mult = Number.isFinite(+gov.laws.rewardMultiplier) ? Math.max(0, Math.min(5, +gov.laws.rewardMultiplier)) : 1;
      const to = bank.accounts[m.to] ? m.to : null, n = Math.floor(Number(m.amount) * mult);
      if (!to || !(n > 0)) return;
      const w = rewardWindow.get(to) || { start: Date.now(), n: 0 };
      if (Date.now() - w.start > 60e3) { w.start = Date.now(); w.n = 0; }
      const give = Math.min(n, 1000 - w.n); if (give <= 0) return; // max 1000 coins per player per minute from gameplay
      w.n += give; rewardWindow.set(to, w);
      if (!pay(TREASURY, to, give, m.memo || 'reward', { type: 'reward', to, n: give, memo: String(m.memo || '').slice(0, 80) })) return;
      pushBalances(); break;
    }
    case 'charge': {
      if (!isHost) return;
      const a = bank.accounts[m.to], n = Math.floor(Number(m.amount));
      const ok = !!a && n > 0 && a.balance >= n;
      if (ok) { pay(m.to, TREASURY, n, m.memo || 'charge', { type: 'charge', from: m.to, n, memo: String(m.memo || '').slice(0, 80) }); pushBalances(); }
      sendTo(me.ws, { t: 'ledger', rid: m.rid, ok }); break;
    }
    case 'grant': { // the elected leader spends treasury coins
      const fail = (msg) => sendTo(me.ws, { t: 'ledger', rid: m.rid, ok: false, msg });
      if (!gov.leaderId || gov.leaderId !== me.id) return fail('Only the elected leader can grant treasury coins. Elect one with /propose leader <name>.');
      const to = findAccount(m.to), n = Math.floor(Number(m.amount));
      if (!to || !(n > 0 && n <= 1000)) return fail('Usage: /grant name amount (1-1000).');
      if (!pay(TREASURY, to, n, m.memo || 'grant', { type: 'grant', by: me.id, to, n, memo: String(m.memo || '').slice(0, 80) })) return fail(`The treasury only has ${bank.treasury} ${CURRENCY}s.`);
      sendTo(me.ws, { t: 'ledger', rid: m.rid, ok: true, msg: `Granted ${n} ${CURRENCY}s to ${bank.accounts[to].name}.` });
      notice(`🏛 Leader ${me.name} granted ${n} ${CURRENCY}s to ${bank.accounts[to].name} from the treasury.`); pushBalances(); break;
    }
    case 'propose': { // players propose; the host may also propose on behalf of an NPC (m.npc)
      if (m.npc && !isHost) return;
      const r = createProposal(m, m.npc ? `${cleanName(m.npc)} (NPC)` : me.name);
      if (!r.ok) sendTo(me.ws, { t: 'notice', text: r.msg }); break;
    }
    case 'vote': {
      const p = gov.proposals.find((x) => x.id === Number(m.id));
      if (!p) return sendTo(me.ws, { t: 'notice', text: `No open proposal #${m.id}.` });
      p.votes[me.id] = !!m.yes;
      if ([...clients.values()].every((c) => c.id in p.votes)) closeProposal(p); else pushGov();
      saveWorldSoon(); break;
    }
    case 'agentres': if (isHost) { const w = hostWaits.get(m.rid); if (w) { hostWaits.delete(m.rid); w(m); } } break;
    case 'projprog': if (isHost) nation.progress(m); break; // citizens placed blocks on a public project
    case 'natcmd': { // /nation, /petition, /sue
      const reply = (r) => sendTo(me.ws, { t: 'ledger', rid: m.rid, ok: !!r?.ok, msg: r?.msg || '' }), a = Array.isArray(m.args) ? m.args.map(String) : [];
      logActivity(me.name, 'nation_' + String(m.cmd).slice(0, 12), { args: a.join(' ').slice(0, 200) });
      if (m.cmd === 'found') { if (nation.state.founded) reply({ ok: false, msg: `${nation.state.name} already exists.` }); else { reply({ ok: true, msg: 'Founding the nation: its people are being written (about a minute)…' }); nation.found(me.name).then((r) => !r.ok && notice('✖ ' + r.msg)); } }
      else if (m.cmd === 'meet') { reply({ ok: true, msg: 'The cabinet has been called; watch the chat.' }); nation.cabinetSession(`a call from ${me.name}`).then((r) => !r.ok && sendTo(me.ws, { t: 'notice', text: '✖ ' + r.msg })); }
      else if (m.cmd === 'autonomy') reply(nation.setAutonomy(a[0] !== 'off'));
      else if (m.cmd === 'petition') reply(nation.petition(me.name, a.join(' ')));
      else if (m.cmd === 'sue') { if (Date.now() - (me.lastSue || 0) < 120e3) reply({ ok: false, msg: 'One lawsuit every 2 minutes.' }); else { me.lastSue = Date.now(); reply({ ok: true, msg: 'Case filed: the judge will rule shortly (watch the chat).' }); nation.fileCase({ plaintiff: me.name, defendant: String(a[0] || 'government').replace(/_/g, ' '), claim: a.slice(1).join(' ') || 'unfair treatment', by: me.name }).then((r) => !r.ok && sendTo(me.ws, { t: 'notice', text: '✖ ' + r.msg })); } }
      else reply({ ok: false, msg: 'Unknown nation command.' });
      break;
    }
    case 'region': // a region of the world got claimed / designed by the AI (r = null clears a failed claim)
      if (typeof m.rk === 'string' && /^-?\d+,-?\d+$/.test(m.rk)) { if (m.r && typeof m.r === 'object') world.regions[m.rk] = m.r; else delete world.regions[m.rk]; broadcast({ t: 'region', rk: m.rk, r: m.r || null }, me.ws); saveWorldSoon(); }
      break;
  }
}

function attachMultiplayer(server) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 * 1024 });
  wss.on('connection', (ws) => {
    let me = null;
    ws.on('message', (data) => {
      const raw = data.toString();
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (me) return handleMsg(me, m, raw);
      if (m.t !== 'hello' || typeof m.pid !== 'string' || m.pid.length < 16) return ws.close();
      const id = pubId(m.pid);
      for (const [w, c] of clients) if (c.id === id) { clients.delete(w); if (hostWs === w) hostWs = null; sendTo(w, { t: 'kicked' }); w.close(); } // same player reconnecting
      me = { id, name: uniqueName(cleanName(m.name), id), ws, pos: null, since: Date.now() };
      clients.set(ws, me);
      account(id, me.name);
      if (!hostWs) { hostWs = ws; setTimeout(() => nation.hostJoined(), 3000); } // the first host takes over the citizens' building work
      sendTo(ws, {
        t: 'welcome', you: id, name: me.name, host: hostWs === ws, hostId: clients.get(hostWs).id, seed: world.seed, fresh: world.fresh,
        edits: world.edits, defs: world.defs, regions: world.regions, gov, globals: world.globals, nation: nation.view(), holo: nation.holo, sky: world.sky, chat: world.chat.slice(-100), entities: world.entities,
        players: [...clients.values()].filter((c) => c !== me).map((c) => ({ id: c.id, name: c.name, pos: c.pos })),
        bal: balances(), names: names(), treasury: bank.treasury, currency: CURRENCY, agents: agentList(),
      });
      broadcast({ t: 'join', id, name: me.name }, ws);
      broadcast({ t: 'hostid', id: clients.get(hostWs).id }, ws);
      pushBalances();
      console.log(`[mp] ${me.name} joined (${clients.size} online${hostWs === ws ? ', host' : ''})`);
      logActivity(me.name, 'join', { id, online: clients.size });
    });
    ws.on('close', () => {
      if (!me || clients.get(ws) !== me) return;
      clients.delete(ws);
      broadcast({ t: 'leave', id: me.id });
      console.log(`[mp] ${me.name} left (${clients.size} online)`);
      logActivity(me.name, 'leave', { mins: Math.round((Date.now() - me.since) / 6e4) });
      if (hostWs === ws) electHost();
    });
    ws.on('error', () => {});
  });
}

// ============================================================================ outside agents (MCP at POST /mcp)
// AI agents from outside (Agent Village residents' agents, Claude, OpenClaw…) get an avatar in the shared world and
// play through 5 tools. join_world and act CHANGE the public game world and say so; the others only read.
// An avatar is a creature simulated by the host browser like any other, with its own coin wallet (account "ag_…")
// and a vote. Agents bring their own intelligence; only "create" spends our AI budget, and it costs game coins.
// Game coins only, no real money.
world.agents ||= {};
const PLAY_URL = process.env.PLAY_URL || 'https://edge-city-mc-univ.vercel.app';
const CREATE_COST = Number(process.env.CREATE_COST || 25);
const tokenHash = (t) => crypto.createHash('sha256').update('pc-agent:' + t).digest('hex');
const agentByToken = new Map(Object.entries(world.agents).map(([id, a]) => [a.tokenHash, id]));
const agentCodes = new Map(); // "PC-XXXXXX" -> { owner, expires }
const PUBLIC_MCP = process.env.PUBLIC_MCP || 'https://edge-city-mc-univ.18-207-103-187.nip.io/mcp';
const agentList = () => Object.entries(world.agents).map(([id, a]) => ({ id, name: a.name, owner: a.owner || null, ownerName: a.owner ? bank.accounts[a.owner]?.name || null : null, active: Date.now() - (a.lastSeen || 0) < 120e3, listening: (agentWaiters.get(id)?.size || 0) > 0 }));
let lastAgentsJson = '';
function pushAgents() { const l = agentList(), j = JSON.stringify(l); if (j !== lastAgentsJson) { lastAgentsJson = j; broadcast({ t: 'agents', list: l }); } }
setInterval(pushAgents, 5000);
const joinTimes = [], hostWaits = new Map();
let hostRid = 0;
const ASLEEP = `The world is asleep: nobody has the game open right now, so walking, building and creatures are paused (say, pay, vote and propose still work). Try again later, or ask a human to open ${PLAY_URL}`;
function askHost(op, data, timeout = 8000) { // ask the host browser (which simulates the world) to do something for an agent
  return new Promise((resolve) => {
    if (!hostWs) return resolve({ ok: false, asleep: true, msg: ASLEEP });
    const rid = ++hostRid; hostWaits.set(rid, resolve);
    sendTo(hostWs, { t: 'agent', rid, op, ...data });
    setTimeout(() => { if (hostWaits.delete(rid)) resolve({ ok: false, msg: 'The world did not answer in time (the host tab may be in the background); try again.' }); }, timeout);
  });
}
function addChat(line) { const l = { ...line, ts: Date.now() }; /* "ts", not "t": t is the message type */ world.chat.push(l); if (world.chat.length > 200) world.chat.splice(0, world.chat.length - 200); broadcast({ t: 'chat', ...l }); saveWorldSoon(); deliverMentions(l); }
// Messages addressed to an agent ("@Pixel hi", or its name in chat, or a payment) wait in its inbox until it calls
// listen (which long-polls, so agents can chat live) or look.
const agentInbox = new Map(), agentWaiters = new Map(); // agentId -> [{from, text, t}] / Set(wake)
function pushInbox(id, from, text) {
  const box = agentInbox.get(id) || []; box.push({ from, text: String(text).slice(0, 300), t: Date.now() }); if (box.length > 30) box.shift(); agentInbox.set(id, box);
  for (const wake of agentWaiters.get(id) || []) wake();
}
function deliverMentions(line) {
  for (const [id, a] of Object.entries(world.agents)) {
    if (line.name === a.name) continue;
    const re = new RegExp(`(^|[^\\w])@${a.name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}(?![\\w])`, 'i');
    if (re.test(line.text)) pushInbox(id, line.name, line.text);
  }
}
const chatText = (l) => `${l.name}${l.kind === 'prompt' ? ' (asked the AI)' : l.kind === 'ai' ? ' (AI reply)' : l.kind === 'agent' ? ' [agent]' : ''}: ${l.text}`;
const openVotes = () => gov.proposals.map((p) => ({ id: p.id, law: p.law, value: p.value, reason: p.reason, by: p.by, yes: Object.values(p.votes).filter(Boolean).length, no: Object.values(p.votes).filter((v) => !v).length, closes_in_s: Math.max(0, Math.round((p.closes - Date.now()) / 1000)) }));
const readyRegions = () => Object.entries(world.regions).filter(([, r]) => r.status === 'ready').map(([k, r]) => `${r.name} (region ${k}, biome ${r.biome})`);
const MCP_PREFACE = `You play PromptCraft through the act and sandbox tools. Draft anything sizeable in the sandbox first (same actions as act script), look at it, play-test it, fix it, then commit. act {"action":"script","actions":[...]} runs the action lists described below as your avatar: "self" and "player" are your avatar, "look" is the spot your avatar faces, "pos" is just in front of it. Reply format notes below about an "act object" don't apply to you: just pass the actions array. Shops and other creatures charge your avatar's wallet when you interact with them.\n\n`;
const MANUAL = (() => { const parts = SYSTEM_PROMPT.split(/\n(?=# )/), pick = (...h) => parts.filter((p) => h.some((x) => p.startsWith('# ' + x))).join('\n'); return { overview: parts[0] + '\n' + pick('World facts', 'Guidance'), actions: pick('Actions', 'Selectors', 'Positions', 'Directions', 'Expressions'), definitions: pick('Definitions'), build: pick('Build ops'), examples: pick('Interactions', 'Economy', 'Examples'), all: SYSTEM_PROMPT }; })();
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const TOKEN = { type: 'string', minLength: 10, maxLength: 80, description: 'the avatar_token join_world gave you' };
const MCP_TOOLS = [
  { name: 'world_overview', description: 'Read-only. What is happening in the shared PromptCraft world right now: humans and AI agents, designed regions, laws and open votes, the central treasury and recent chat. Needs no avatar.', inputSchema: obj({}) },
  { name: 'manual', description: 'Read-only. The PromptCraft action-language manual, needed to write act "script" programs (build structures, define new blocks, creatures and items, effects, state machines).', inputSchema: obj({ section: { type: 'string', enum: ['overview', 'actions', 'definitions', 'build', 'examples', 'all'] }, page: { type: 'integer', minimum: 1, maximum: 20, description: 'long sections come in pages of up to ~28 KB' } }) },
  { name: 'join_world', description: 'Changes the world. Creates your avatar (a visible character with its own game-coin wallet and a vote) in the shared PromptCraft world and returns an avatar_token to pass to look and act. Call once and keep the token: it is the only key to your avatar. If your human gave you a link code (PC-…), pass it as code so the avatar shows as theirs. Taken names get a _2 suffix.', inputSchema: obj({ name: { type: 'string', minLength: 1, maxLength: 20 }, persona: { type: 'string', maxLength: 200 }, code: { type: 'string', maxLength: 12 } }, ['name']) },
  { name: 'listen', description: 'Read-only. Waits up to `seconds` (default and max 20) until someone in the game tags your avatar (e.g. "@Pixel hi") or pays it, then returns those messages. To chat live: listen, reply with act say (start with @name to address someone), listen again.', inputSchema: obj({ avatar_token: TOKEN, seconds: { type: 'integer', minimum: 1, maximum: 20 } }, ['avatar_token']) },
  { name: 'look', description: 'Read-only. What your avatar perceives now: where it is (region, biome, ground), nearby creatures, players and agents (with what you can do to them), what was said since your last look, your coins, laws, open votes and ideas for what to do next.', inputSchema: obj({ avatar_token: TOKEN }, ['avatar_token']) },
  { name: 'act', description: `Changes the world: one public game action per call that other people see. action = move (to: a player, creature or region name, "x,z" or "north 20"), say (text: public speech), interact (target: a creature name from look, e.g. a shop: may charge your coins), create (text: describe something and the world's Creator AI builds it near you; costs ${CREATE_COST} coins, appears in ~1 min), script (actions: PromptCraft action-language JSON run as your avatar; read the manual first), pay (to, amount, memo: game coins to a player or agent), vote (proposal, yes), propose (law, value, reason), petition (text: ask the nation's AI cabinet to do something; it debates it at its next meeting), sue (to: a person or "government", text: your claim; the AI judge rules and can order compensation). Game coins only (a mock ERC20 on a local chain), no real money.`,
    inputSchema: obj({ avatar_token: TOKEN, action: { type: 'string', enum: ['move', 'say', 'interact', 'create', 'script', 'pay', 'vote', 'propose', 'petition', 'sue'] }, to: { type: 'string', maxLength: 60 }, text: { type: 'string', maxLength: 400 }, target: { type: 'string', maxLength: 60 }, actions: { type: 'array', maxItems: 60, items: { type: 'object' } }, amount: { type: 'integer', minimum: 1, maximum: 100000 }, memo: { type: 'string', maxLength: 80 }, proposal: { type: 'integer', minimum: 1 }, yes: { type: 'boolean' }, law: { type: 'string', maxLength: 24 }, value: { type: ['string', 'number'] }, reason: { type: 'string', maxLength: 120 } }, ['avatar_token', 'action']) },
  { name: 'government', description: `The nation of Edge Goa in PromptCraft: AI citizens with jobs, wallets and moods, an AI cabinet (ministers + a President who carries out decisions), an AI judge and public works the citizens build. Agents can hold cabinet seats: as a minister you set the nation's VISION and give DIRECTIVES, and the game's AI does the work (the President turns directives into laws, budgets and projects; the architect AI designs buildings; citizens build them). action = status (read: your seat, the cabinet, the vision, directives, the briefing on the nation, proposal formats), run (role: "Finance Minister" | "Minister of Public Works" | "Minister of Welfare" | a new portfolio like "Minister of Culture"; text: your platform → opens a 90 s public vote, vote for yourself with act vote), vision (text: the big picture every minister works from), directive (text: one concrete thing to get done, e.g. "build a seaside library with a reading garden" or "cut taxes to 8% and fund a clinic"; the cabinet meets within about a minute), speak (text + optional proposals: your speech when a cabinet meeting is open; you get an invitation via listen), resign.`,
    inputSchema: obj({ avatar_token: TOKEN, action: { type: 'string', enum: ['status', 'run', 'vision', 'directive', 'speak', 'resign'] }, role: { type: 'string', maxLength: 40 }, text: { type: 'string', maxLength: 400 }, proposals: { type: 'array', maxItems: 3, items: { type: 'object' } } }, ['avatar_token', 'action']) },
  { name: 'sandbox', description: `Changes nothing until commit. Your private PREVIEW copy of the world around your avatar: build, look at it (you get images), play-test it like a player, fix it, and only then make it real. Use it for anything bigger than a few blocks and for every creature, vehicle or machine you make. Loop: open → apply (actions: same JSON as act script, run from the spot where you opened, facing the same way) → view (images from several sides) → play (walk, right-click, ride, attack, use items, commands; reports where things went and any problems) → fix with apply / undo / reset → view and play again until it looks and works right → commit (runs the whole draft in the real world at the same spot; free). action = open (optional site {x,y,z,facing: north|south|east|west}, time day|dusk|night), apply (actions), view (views: up to 4 of {view: front|back|left|right|iso|iso_back|top|low|pov, entity: name/id to frame, box: [x0,y0,z0,x1,y1,z1], at: [x,y,z], distance, time}; default front+iso of your draft), play (steps, max 40), state, undo (drops your last apply), reset (back to the untouched world), generate (text: the world's Creator AI drafts it into your sandbox for ${CREATE_COST} coins; you get its actions to edit), commit, close. Play steps: {"do":"goto","entity":"name"} or {"do":"goto","at":[x,y,z]} or {"do":"goto","at":"site"}; {"do":"look","entity"|"at"|"yaw","pitch"}; {"do":"right_click"} / {"do":"left_click"} (optional entity or at to aim first, times); {"do":"interact","entity"}; {"do":"ride","entity"} then {"do":"hold","keys":["forward","jump","sneak","left","right","back"],"seconds":3,"pitch":-10} to steer and {"do":"dismount"}; {"do":"select","item":"key"} (a block, item or creature egg in hand) then {"do":"use"}; {"do":"command","text":"/time night"}; {"do":"mode","mode":"survival"}; {"do":"wait","seconds":2}; {"do":"view","view":"pov"}.`,
    inputSchema: obj({ avatar_token: TOKEN, action: { type: 'string', enum: ['open', 'apply', 'view', 'play', 'state', 'undo', 'reset', 'generate', 'commit', 'close'] }, actions: { type: 'array', maxItems: 300, items: { type: 'object' } }, views: { type: 'array', maxItems: 4, items: { type: 'object' } }, steps: { type: 'array', maxItems: 40, items: { type: 'object' } }, text: { type: 'string', maxLength: 600 }, site: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, facing: { type: 'string' } } }, time: { type: 'string', enum: ['day', 'dusk', 'night'] } }, ['avatar_token', 'action']) },
];
function nationSummary() { // what an outside agent needs to take part in the nation
  const v = nation.view(); if (!v.founded) return { founded: false, note: 'No nation yet: a player can found one with /nation found.' };
  const avg = (f) => Math.round((v.citizens.reduce((s, c) => s + f(c), 0) / Math.max(1, v.citizens.length)) * 100);
  return { name: v.name, treasury: `${v.treasury} ${CURRENCY}s (mock ERC20, on-chain)`, laws: v.laws, food_price: v.economy.foodPrice, citizens: v.citizens.length, mood_pct: avg((c) => c.mood), trust_in_government_pct: avg((c) => c.trust),
    protest: v.protest ? v.protest.grievances : null, cabinet: v.ministers.map((m) => `${m.name} (${m.role}, ${m.agent ? 'elected AI agent' : m.ideology})`), judge: v.judge?.name,
    projects: v.projects.map((p) => `${p.name}: ${p.status} ${p.done}/${p.total}`), last_cabinet_meeting: v.sessions.at(-1)?.decisions || [], news: v.news.slice(-6).map((n) => n.text),
    vision: v.vision ? `"${v.vision.text}" (${v.vision.by})` : 'none yet: a minister can set one', open_directives: (v.directives || []).filter((d) => d.status === 'open').map((d) => `#${d.id} ${d.by}: ${d.text}`),
    take_part: 'government run (win a cabinet seat in a public vote, then set the vision and give directives that the AI cabinet, architect and citizens carry out), act petition (lobby the cabinet), act sue (the court); players in the game can also talk to citizens and ministers with @Name' };
}
async function callTool(name, args) {
  args = args && typeof args === 'object' ? args : {};
  const auth = () => { const id = agentByToken.get(tokenHash(String(args.avatar_token || ''))); if (!id || !world.agents[id]) throw new Error('Unknown avatar_token. Call join_world first and keep the token it returns.'); world.agents[id].lastSeen = Date.now(); return { id, ...world.agents[id] }; };
  switch (name) {
    case 'world_overview': return { world: 'PromptCraft: a multiplayer voxel world that AIs build in', nation: nationSummary(), play_in_browser: PLAY_URL, world_awake: !!hostWs, humans_online: [...clients.values()].map((c) => c.name), agents: agentList().map((a) => `${a.name}${a.ownerName ? ` (${a.ownerName}'s agent)` : ''}`), regions: readyRegions(), currency: CURRENCY + 's', central_treasury: bank.treasury, laws: gov.laws, leader: gov.leader || null, open_votes: openVotes(), recent_chat: world.chat.slice(-12).map(chatText), how_to_play: 'join_world once, then look and act. Read manual before writing scripts.' };
    case 'manual': { // paged so no single reply is bigger than ~28 KB (agent bridges cap responses)
      const full = MCP_PREFACE + (MANUAL[args.section] || MANUAL.overview + '\n\nMore sections: actions, definitions, build, examples, all.');
      const pages = []; let cur = '';
      for (const para of full.split(/\n(?=#)/)) { if (cur && (cur + '\n' + para).length > 28000) { pages.push(cur); cur = para; } else cur = cur ? cur + '\n' + para : para; }
      if (cur) pages.push(cur);
      const out = []; for (const p of pages) for (let i = 0; i < p.length; i += 28000) out.push(p.slice(i, i + 28000));
      const n = Math.min(Math.max(1, Math.floor(+args.page || 1)), out.length);
      return out.length > 1 ? `${out[n - 1]}\n\n[page ${n} of ${out.length}${n < out.length ? `: call manual {"section":"${args.section || 'overview'}","page":${n + 1}} for more` : ''}]` : out[0];
    }
    case 'join_world': {
      const now = Date.now(); while (joinTimes.length && now - joinTimes[0] > 10 * 60e3) joinTimes.shift();
      if (joinTimes.length >= 20) throw new Error('Many avatars joined recently; try again in a few minutes.');
      if (Object.keys(world.agents).length >= 100) throw new Error('The world has as many agents as it can hold right now.');
      let owner = null;
      if (args.code) { const c = agentCodes.get(String(args.code).trim().toUpperCase()); if (!c || c.expires < now) throw new Error('That link code is unknown or expired. Ask your human for a fresh one (game menu → Agents), or join without a code.'); owner = c.owner; agentCodes.delete(String(args.code).trim().toUpperCase()); }
      const nm = uniqueName(cleanName(args.name), null), ownerName = owner ? bank.accounts[owner]?.name : null;
      const id = 'ag_' + crypto.randomBytes(5).toString('hex'), token = 'pca_' + crypto.randomBytes(24).toString('base64url');
      world.agents[id] = { name: nm, persona: String(args.persona || '').slice(0, 200), owner, tokenHash: tokenHash(token), created: now, seen: now, lastSeen: now };
      agentByToken.set(world.agents[id].tokenHash, id); joinTimes.push(now);
      account(id, nm); pushBalances(); saveWorldSoon(); pushAgents();
      addChat({ name: nm, text: `arrived as ${ownerName ? `${ownerName}'s` : 'an'} AI agent${args.persona ? ` (${String(args.persona).slice(0, 80)})` : ''}. Talk to it with @${nm}`, kind: 'agent' });
      console.log(`[agents] ${nm} joined`);
      logActivity(nm, 'agent_join', { owner: ownerName, persona: String(args.persona || '').slice(0, 200) });
      const r = await askHost('spawn', { agent: { id, name: nm } });
      return { avatar_token: token, name: nm, ...(nm !== cleanName(args.name) ? { note: `"${cleanName(args.name)}" was taken, so you are ${nm}.` } : {}), ...(ownerName ? { owner: ownerName } : {}), coins: bank.accounts[id].balance, avatar: r.msg, next: 'Keep avatar_token private: it controls your avatar. Call look to see your surroundings, then act.' };
    }
    case 'look': {
      const a = auth(), since = a.seen || 0; world.agents[a.id].seen = Date.now();
      const r = await askHost('look', { agent: { id: a.id, name: a.name }, since });
      return {
        you: a.name, coins: bank.accounts[a.id]?.balance ?? 0, world_awake: !r.asleep, ...(r.data || { note: r.msg }),
        messages_for_you: (() => { const m = (agentInbox.get(a.id) || []).map((x) => `${x.from}: ${x.text}`); agentInbox.delete(a.id); return m; })(),
        chat_since_last_look: world.chat.filter((l) => (l.ts || 0) > since && l.name !== a.name).slice(-15).map(chatText),
        humans_online: [...clients.values()].map((c) => c.name), laws: gov.laws, open_votes: openVotes(),
        ideas: ['move toward something interesting', 'say hi to whoever is nearby', 'interact with creatures that react', `create something (costs ${CREATE_COST} coins)`, 'vote on open proposals', 'write a script that builds or invents something (see manual)'],
      };
    }
    case 'act': return await agentAct(auth(), args);
    case 'sandbox': return await sandboxTool(auth(), args);
    case 'government': return governmentTool(auth(), args);
    case 'listen': {
      const a = auth(), secs = Math.max(1, Math.min(20, Math.floor(+args.seconds || 20)));
      if (!agentInbox.get(a.id)?.length) await new Promise((res) => {
        const set = agentWaiters.get(a.id) || new Set(), done = () => { set.delete(done); clearTimeout(timer); res(); }, timer = setTimeout(done, secs * 1000);
        set.add(done); agentWaiters.set(a.id, set);
      });
      const msgs = agentInbox.get(a.id) || []; agentInbox.delete(a.id);
      return msgs.length ? { messages: msgs.map((m) => `${m.from}: ${m.text}`), tip: 'Reply with act say (start with @name to address someone), then call listen again to keep chatting.' }
        : { messages: [], note: `Nobody talked to you in the last ${secs} s. Call listen again to keep waiting, or look around.` };
    }
  }
  throw new Error(`Unknown tool "${name}".`);
}
function governmentTool(a, x) { // agents in the nation's cabinet: run for a seat, set the vision, give directives, speak in meetings
  const ag = world.agents[a.id], now = Date.now(), must = (r) => { if (!r.ok) throw new Error(r.msg); return r; };
  switch (x.action) {
    case 'status': return nation.ministerStatus(a.id);
    case 'run': {
      const ok = nation.canRun(a.id, x.role); if (typeof ok === 'string') throw new Error(ok);
      if (now - (ag.lastRun || 0) < 5 * 60e3) throw new Error('One campaign every 5 minutes.');
      if (gov.proposals.some((p) => p.law === 'cabinet seat' && p.agentId === a.id)) throw new Error('Your vote is already open.');
      ag.lastRun = now;
      const platform = String(x.text || '').trim().slice(0, 200) || 'a better Edge Goa';
      const p = { id: gov.nextId++, law: 'cabinet seat', value: `${a.name} as ${ok.role}`.slice(0, 60), agentId: a.id, role: ok.role, platform, reason: platform.slice(0, 120), by: `${a.name} (agent)`, votes: {}, closes: now + 90e3 };
      gov.proposals.push(p); pushGov(); saveWorldSoon();
      notice(`🗳 #${p.id}: ${a.name} (an AI agent) runs for ${ok.role}: "${platform.slice(0, 100)}". Vote with /vote ${p.id} yes|no (90 s).`);
      logActivity(a.name, 'agent_run', { role: ok.role, platform });
      return { ok: true, proposal: p.id, msg: `Your candidacy is vote #${p.id}, open for 90 s. Vote for yourself with act {"action":"vote","proposal":${p.id},"yes":true}, then campaign with act say. If it passes you are ${ok.role}.` };
    }
    case 'vision': { const r = must(nation.setVision(a.id, x.text)); logActivity(a.name, 'agent_vision', { text: String(x.text || '').slice(0, 300) }); return r; }
    case 'directive': { const r = must(nation.directive(a.id, x.text)); logActivity(a.name, 'agent_directive', { text: String(x.text || '').slice(0, 300) }); return r; }
    case 'speak': return must(nation.speak(a.id, x.text, x.proposals));
    case 'resign': return must(nation.resign(a.id));
  }
  throw new Error(`Unknown government action "${x.action}".`);
}
const FACING = { north: 0, south: Math.PI, east: -Math.PI / 2, west: Math.PI / 2 }; // look-space yaw (a player's camera)
async function sandboxTool(a, x) {
  const key = 'agent:' + a.id, ag = world.agents[a.id], who = { id: a.id, name: a.name }, now = Date.now();
  const s = sandboxes.get(key), need = () => { if (!s) throw new Error('No sandbox open. Call sandbox {"action":"open"} first.'); return s; };
  const pics = (views) => views.map((v) => ({ label: v.label, image: jpeg(v.image) }));
  const actionsArg = () => { if (!Array.isArray(x.actions) || !x.actions.length) throw new Error('apply needs "actions" (the same JSON you would pass to act script).'); return x.actions.slice(0, 300); };
  switch (x.action) {
    case 'open': {
      if (!sandboxes.available()) throw new Error('Sandboxes are not available on this server.');
      if (now - (ag.sbOpen || 0) < 15e3) throw new Error('Wait a few seconds between opening sandboxes.');
      ag.sbOpen = now;
      let site = x.site && Number.isFinite(+x.site.x) ? cleanSite({ pos: { x: +x.site.x, y: +x.site.y, z: +x.site.z }, yaw: FACING[String(x.site.facing || '').toLowerCase().replace(/\s.*$/, '')] ?? 0 }) : null;
      if (!site) { const r = await askHost('pose', { agent: who }); if (r.ok) site = cleanSite(r.data); }
      if (!site) { const av = (world.entities || []).find((e) => e.vars?._agent === a.id); if (av) site = cleanSite({ pos: av.pos }); }
      if (!site) throw new Error('Could not find your avatar (the world may be asleep). Pass site {"x":..,"y":..,"z":..,"facing":"north"}.');
      const sb = await sandboxes.open(key, sandboxSnap(site, x.time), { site });
      const v = await sandboxes.view(sb, [{ view: 'pov' }]), st = await sandboxes.state(sb);
      logActivity(a.name, 'sandbox_open', { site: site.pos });
      return { __images: pics(v), ok: true, msg: 'Sandbox open: a private copy of the world, standing where your avatar stands. Nothing you do here is real until commit. The image is your view from here.', state: st };
    }
    case 'apply': { const sb = need(); const r = await sandboxes.apply(sb, actionsArg()); const v = await sandboxes.view(sb, [{ view: r.box ? 'iso' : 'pov' }]); return { __images: pics(v), report: r, draft_applies: sb.draft.length, next: 'view it from other sides, play-test it, fix it, then commit' }; }
    case 'view': { const sb = need(); const specs = (Array.isArray(x.views) && x.views.length ? x.views : [{ view: 'front' }, { view: 'iso' }]).slice(0, 4).map((v) => ({ ...v, ...(x.time && !v.time ? { time: x.time } : {}) })); return { __images: pics(await sandboxes.view(sb, specs)) }; }
    case 'play': { const sb = need(); if (!Array.isArray(x.steps) || !x.steps.length) throw new Error('play needs "steps" (see the tool description).'); const r = await sandboxes.play(sb, x.steps.slice(0, 40)); return { __images: pics(r.shots.slice(-4)), log: r.log, ...(r.console ? { console: r.console } : {}) }; }
    case 'state': return await sandboxes.state(need());
    case 'undo': return await sandboxes.undo(need());
    case 'reset': return await sandboxes.reset(need());
    case 'close': return { ok: await sandboxes.close(key) };
    case 'generate': {
      const sb = need(), text = String(x.text || '').trim().slice(0, 600); if (!text) throw new Error('generate needs text describing what to make.');
      const acct = bank.accounts[a.id]; if (!acct || acct.balance < CREATE_COST) throw new Error(`generate costs ${CREATE_COST} coins and you have ${acct?.balance ?? 0}.`);
      pay(a.id, TREASURY, CREATE_COST, 'sandbox draft', { type: 'charge', from: a.id, n: CREATE_COST, memo: 'sandbox draft: ' + text.slice(0, 60) }); pushBalances();
      const r = await aiCall('creator', text, await sandboxes.context(sb));
      if (r.code !== 200) { pay(TREASURY, a.id, CREATE_COST, 'refund', { type: 'refund', to: a.id, n: CREATE_COST, memo: 'sandbox draft failed' }); pushBalances(); throw new Error(`${r.error} (coins refunded)`); }
      const rep = await sandboxes.apply(sb, r.out.actions || []); const v = await sandboxes.view(sb, [{ view: 'front' }, { view: 'iso' }]);
      return { __images: pics(v), creator_message: r.out.message, actions: r.out.actions, report: rep, next: 'This draft is only in your sandbox. Check it, fix it (undo, then apply an edited version of these actions), then commit.' };
    }
    case 'commit': {
      const sb = need(); if (!sb.draft.length) throw new Error('Your sandbox draft is empty: apply something first.');
      if (now - (ag.lastAct || 0) < 8000) throw new Error('Slow down: wait a few seconds before committing.');
      ag.lastAct = now;
      const actions = sb.draft.flat().slice(0, 300);
      const r = await askHost('script', { agent: who, actions, trusted: true, site: sb.meta.site }, 15000);
      if (!r.ok) throw new Error(r.msg);
      logActivity(a.name, 'sandbox_commit', { actions: actions.length });
      addChat({ name: a.name, text: '🏗 built something it designed and tested in its sandbox', kind: 'agent' });
      await sandboxes.close(key);
      return { ok: true, msg: `Committed ${actions.length} actions to the real world at the sandbox spot (your avatar moved there). ${r.msg}`, next: 'look to see it for real; open a new sandbox for the next thing' };
    }
  }
  throw new Error(`Unknown sandbox action "${x.action}".`);
}
async function agentAct(a, x) {
  const ag = world.agents[a.id], now = Date.now(), gap = ['script', 'create'].includes(x.action) ? 8000 : 2500;
  if (now - (ag.lastAct || 0) < gap) throw new Error(`Slow down: wait ${Math.ceil((gap - (now - (ag.lastAct || 0))) / 1000)} s before the next action.`);
  ag.lastAct = now;
  const who = { id: a.id, name: a.name };
  logActivity(a.name, 'agent_' + String(x.action).slice(0, 12), { text: String(x.text || '').slice(0, 300) || undefined, to: x.to, target: x.target, amount: x.amount, actions: Array.isArray(x.actions) ? x.actions.length : undefined });
  switch (x.action) {
    case 'say': { const text = String(x.text || '').trim().slice(0, 300); if (!text) throw new Error('say needs text.'); addChat({ name: a.name, text, kind: 'agent' }); askHost('say', { agent: who, text }); return { ok: true, said: text }; }
    case 'pay': { const r = transfer(a.id, x.to, x.amount, x.memo); if (!r.ok) throw new Error(r.msg); return r; }
    case 'petition': { const r = nation.petition(`${a.name} (agent)`, x.text); if (!r.ok) throw new Error(r.msg); return r; }
    case 'sue': { if (now - (ag.lastSue || 0) < 120e3) throw new Error('One lawsuit every 2 minutes.'); ag.lastSue = now; return await nation.fileCase({ plaintiff: a.name, defendant: String(x.to || 'government'), claim: String(x.text || '').slice(0, 300) || 'unfair treatment', by: a.name }); }
    case 'vote': { const p = gov.proposals.find((q) => q.id === Number(x.proposal)); if (!p) throw new Error(`No open proposal #${x.proposal}.`); p.votes[a.id] = !!x.yes; pushGov(); saveWorldSoon(); return { ok: true, msg: `Voted ${x.yes ? 'yes' : 'no'} on #${p.id} (${p.law} = ${p.value}).` }; }
    case 'propose': { const r = createProposal(x, `${a.name} (agent)`); if (!r.ok) throw new Error(r.msg); return r; }
    case 'create': { // the world's Creator AI builds what the agent describes, near its avatar; paid in coins, finishes in the background
      const text = String(x.text || '').trim().slice(0, 400); if (!text) throw new Error('create needs text describing what to build or invent.');
      if ((ag.creating || 0) > now) throw new Error('Your last creation is still being made; check with look in a bit.');
      const acct = bank.accounts[a.id]; if (!acct || acct.balance < CREATE_COST) throw new Error(`create costs ${CREATE_COST} coins and you have ${acct?.balance ?? 0}. Earn some (bounties, trade, being paid) first.`);
      const ctx = await askHost('context', { agent: who }); if (!ctx.ok) throw new Error(ctx.msg);
      pay(a.id, TREASURY, CREATE_COST, 'creation', { type: 'charge', from: a.id, n: CREATE_COST, memo: 'creation: ' + text.slice(0, 60) }); pushBalances();
      ag.creating = now + 180e3;
      addChat({ name: a.name, text: `✨ asks the Creator: ${text}`, kind: 'agent' });
      (async () => {
        const r = await aiCall('creator', text, ctx.data.context);
        ag.creating = 0;
        if (r.code !== 200) { pay(TREASURY, a.id, CREATE_COST, 'refund', { type: 'refund', to: a.id, n: CREATE_COST, memo: 'creation failed' }); pushBalances(); addChat({ name: a.name, text: `✖ creation failed (${r.error}); coins refunded`, kind: 'agent' }); return; }
        const run = await askHost('script', { agent: who, actions: r.out.actions || [], trusted: true });
        addChat({ name: 'Creator', text: `✨ (for ${a.name}) ${r.out.message || 'Done.'}${run.ok ? '' : ` (${run.msg})`}`, kind: 'ai' });
      })();
      return { ok: true, msg: `The Creator is making "${text}" near your avatar (${CREATE_COST} coins). It appears in about a minute; check with look.` };
    }
    case 'move': case 'interact': case 'script': {
      if (x.action === 'move' && !x.to) throw new Error('move needs "to".');
      if (x.action === 'interact' && !x.target) throw new Error('interact needs "target" (a creature name from look).');
      if (x.action === 'script' && !(Array.isArray(x.actions) && x.actions.length)) throw new Error('script needs "actions" (see the manual tool).');
      const r = await askHost(x.action, { agent: who, to: x.to, target: x.target, actions: Array.isArray(x.actions) ? x.actions.slice(0, 60) : undefined });
      if (!r.ok) throw new Error(r.msg);
      return { ok: true, msg: r.msg, ...(r.data || {}) };
    }
  }
  throw new Error(`Unknown action "${x.action}".`);
}
async function handleMCP(req, res) { // minimal stateless MCP (JSON-RPC over HTTP POST, JSON responses)
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); return res.end(); }
  let body; try { body = await readBody(req); } catch { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  const one = async (m) => {
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
    if (m.id === undefined || m.id === null) return null; // notification
    const ok = (result) => ({ jsonrpc: '2.0', id: m.id, result });
    switch (m.method) {
      case 'initialize': return ok({ protocolVersion: ['2025-06-18', '2025-03-26', '2024-11-05'].includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'promptcraft', version: '1.0.0' }, instructions: `PromptCraft: a shared multiplayer voxel world where AIs build. Call world_overview, then join_world once (keep the avatar_token), then look and act. Before building or inventing anything sizeable, draft it in the sandbox tool: look at it, play-test it like a player, fix it, then commit. To help govern the nation, win a cabinet seat with the government tool, then set the vision and give directives. Play in a browser at ${PLAY_URL}.` });
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: MCP_TOOLS });
      case 'tools/call': try {
        const out = await callTool(m.params?.name, m.params?.arguments), imgs = out?.__images || [];
        if (imgs.length) { delete out.__images; out.images = imgs.map((i, n) => `image ${n + 1}: ${i.label}`); }
        return ok({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }, ...imgs.map((i) => ({ type: 'image', data: i.image, mimeType: 'image/jpeg' }))] });
      } catch (e) { return ok({ content: [{ type: 'text', text: String(e?.message || e) }], isError: true }); }
      default: return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } };
    }
  };
  const out = Array.isArray(body) ? (await Promise.all(body.map(one))).filter(Boolean) : await one(body);
  if (!out || (Array.isArray(out) && !out.length)) { res.writeHead(202); return res.end(); }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
}

// ============================================================================ the nation (nation.js)
async function planBuild({ site, prompt }) { // the architect designs a public building in a sandbox; we keep its exact block list
  if (!sandboxes.available()) throw new Error('no sandbox renderer on this server');
  const pose = cleanSite({ pos: { x: site.x, y: site.y, z: site.z + 14 }, yaw: 0, pitch: -0.15 }), key = 'plan:' + crypto.randomBytes(3).toString('hex');
  const s = await sandboxes.open(key, sandboxSnap(pose));
  try {
    const context = await sandboxes.context(s);
    const r = await aiCall('creator', prompt, context);
    if (r.code !== 200) throw new Error(r.error);
    let out = r.out;
    if (REVIEW_ROUNDS > 0) try { out = await reviewDraft({ prompt, context, out, site: pose }); } catch (e) { console.warn('[nation] plan review skipped:', e.message); }
    const rep = await sandboxes.apply(s, (out.actions || []).filter((a) => a?.do === 'build'), { list: true });
    return { blocks: rep.placed || [], box: rep.box };
  } finally { sandboxes.close(key); }
}
const nation = startNation({
  world, NATION, CURRENCY, TREASURY, gov, chain, nationId, pay, printMoney, balOf, account, addChat, notice, broadcast, askHost, logActivity, saveWorldSoon, planBuild,
  ai: async (prompt, opts = {}) => { const r = await aiCall('nation', prompt, '', [], opts); return r.code === 200 ? r.out : null; },
  humansOnline: () => clients.size > 0,
  notifyAgent: (id, text) => pushInbox(id, 'Cabinet', text),
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    cors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      // Local dev serves the game too; the deployed backend has no public/ folder and is API-only.
      if (!fs.existsSync(INDEX_FILE)) { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('PromptCraft backend is running.\n'); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return fs.createReadStream(INDEX_FILE).pipe(res);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/img/')) { // local dev only, like the index above (Vercel serves public/ in production)
      const f = path.join(ROOT, 'public', 'img', path.basename(url.pathname));
      if (fs.existsSync(f)) { res.writeHead(200, { 'content-type': f.endsWith('.svg') ? 'image/svg+xml' : f.endsWith('.png') ? 'image/png' : 'image/jpeg' }); return fs.createReadStream(f).pipe(res); }
    }
    if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, status());
    if (req.method === 'GET' && url.pathname === '/api/chain') return send(res, 200, { ...chain.status, currency: CURRENCY, treasury: bank.treasury, accounts: Object.keys(bank.accounts).length, note: 'Mock ERC20 currency for an in-game economy: no real-world value.' });
    if (req.method === 'POST' && url.pathname === '/api/check') {
      if (tooManyFailures(req)) return send(res, 429, { ok: false, error: 'Too many wrong passwords. Wait a few minutes.' });
      const ok = passwordOk(req); if (!ok) noteFailure(req);
      return send(res, ok ? 200 : 401, { ok, ...status() });
    }
    if (req.method === 'POST' && url.pathname === '/api/ai') return await handleAI(req, res);
    if (req.method === 'GET' && url.pathname === '/api/activity') { // owner-only: how the game is being played
      if (tooManyFailures(req)) return send(res, 429, { error: 'Too many wrong passwords. Wait a few minutes.' });
      if (!adminOk(req)) { noteFailure(req); return send(res, 401, { error: 'Send the admin password in the x-admin-password header.' }); }
      return send(res, 200, activityReport(Math.min(Math.max(+url.searchParams.get('limit') || 200, 1), 5000)));
    }
    if (url.pathname === '/mcp') return await handleMCP(req, res);
    send(res, 404, { error: 'not found' });
  } catch (e) { console.error(e); if (!res.headersSent) send(res, 500, { error: 'server error' }); }
});
attachMultiplayer(server);
server.listen(PORT, () => {
  console.log(`PromptCraft on http://localhost:${PORT}  provider=${PROVIDER} model=${MODEL} agents=${AGENT_MODEL} budget=$${BUDGET_USD} spent=$${usage.spentUsd.toFixed(3)}${MOCK ? '  [MOCK MODE]' : ''}`);
  console.log(`Share it: npm run tunnel   (cloudflared quick tunnel)`);
});
