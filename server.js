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
  agent: `You are an AI INHABITANT of the world (your persona is in the context). A player just spoke to you (see the event). Answer in character and, if they asked for something, do it with one act reply. Keep each turn modest: one building or one invention per turn. Don't use "give" unless the player asked you for something. Speak in character in "message" (short) and leave yourself a "note" about what you did and plan next.`,
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

// Gemini (Interactions API). JSON mode instead of tools: one request, one JSON plan back.
async function callGemini(role, prompt, context) {
  const model = role === 'agent' ? AGENT_MODEL : MODEL;
  const it = await gemini.interactions.create({
    model,
    system_instruction: SYSTEM_PROMPT,
    input: userText(role, prompt, context),
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
  const raw = String(it.output_text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  let out;
  try { out = JSON.parse(raw); } catch { return { message: 'The AI sent back broken JSON. Try again.', actions: [], cost }; }
  if (Array.isArray(out)) out = { message: '', actions: out };
  if (!out || !Array.isArray(out.actions)) return { message: String(out?.message || 'The AI made no changes.'), actions: [], cost };
  return { message: String(out.message || ''), actions: out.actions, note: out.note ? String(out.note) : '', cost };
}

async function callClaude(role, prompt, context) {
  const model = role === 'agent' ? AGENT_MODEL : MODEL;
  const user = userText(role, prompt, context);
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
function mockReply(prompt) {
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
const status = () => ({ budgetUsd: BUDGET_USD, spentUsd: +usage.spentUsd.toFixed(4), provider: PROVIDER, model: MODEL, agentModel: AGENT_MODEL, mock: MOCK });

async function handleAI(req, res) {
  if (tooManyFailures(req)) return send(res, 429, { error: 'Too many wrong passwords. Wait a few minutes.' });
  if (!passwordOk(req)) { noteFailure(req); return send(res, 401, { error: 'Wrong or missing password' }); }
  let body;
  try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
  const role = body.role === 'agent' ? 'agent' : 'creator';
  const prompt = String(body.prompt || '').slice(0, 2000);
  const context = String(body.context || '').slice(0, 24000);
  if (!prompt.trim()) return send(res, 400, { error: role === 'agent' ? 'Agents only act when someone talks to them.' : 'Empty prompt' });
  if (inFlight >= MAX_CONCURRENT) return send(res, 429, { error: 'The AI is busy — try again in a moment.' });
  const model = role === 'agent' ? AGENT_MODEL : MODEL;
  const worst = MOCK ? 0 : worstCase(model, SYSTEM_PROMPT.length + context.length + prompt.length);
  if (usage.spentUsd + reservedUsd + worst > BUDGET_USD) {
    const msg = usage.spentUsd >= BUDGET_USD - 0.01 ? `AI budget used up ($${usage.spentUsd.toFixed(2)} of $${BUDGET_USD}).`
      : `Not enough AI budget left for another request ($${usage.spentUsd.toFixed(2)} of $${BUDGET_USD} used; one request can cost up to $${worst.toFixed(2)}).`;
    return send(res, 402, { error: msg, ...status() });
  }
  inFlight++; reservedUsd += worst;
  const t0 = Date.now();
  console.log(`[ai] ${role} request${prompt ? `: "${prompt.slice(0, 80)}"` : ''} (in flight: ${inFlight})`);
  try {
    const out = MOCK ? mockReply(prompt) : PROVIDER === 'gemini' ? await callGemini(role, prompt, context) : await callClaude(role, prompt, context);
    send(res, 200, { ...out, ...status() });
    fs.appendFile(path.join(ROOT, 'data', 'ai-log.jsonl'), JSON.stringify({ t: new Date().toISOString(), secs: (Date.now() - t0) / 1000, role, prompt, ...out }) + '\n', () => {});
  } catch (e) {
    console.error('[ai] error', e?.status || '', e?.message);
    if (PROVIDER === 'gemini') {
      const st = e?.status;
      if (st === 401 || st === 403) send(res, 500, { error: `Gemini rejected the API key (${st}). Check GEMINI_API_KEY — ${MODEL} needs a paid-tier key.` });
      else if (st === 404) send(res, 500, { error: `Model ${MODEL} not found for this key (it needs a paid-tier Gemini API key).` });
      else if (st === 429) send(res, 429, { error: 'Gemini rate limit hit — try again shortly.' });
      else send(res, 502, { error: `Gemini error${st ? ' ' + st : ''}: ${String(e?.message || e).slice(0, 300)}` });
    } else if (e instanceof Anthropic.AuthenticationError) send(res, 500, { error: 'Server has no valid ANTHROPIC_API_KEY.' });
    else if (e instanceof Anthropic.RateLimitError) send(res, 429, { error: 'Claude rate limit hit — try again shortly.' });
    else if (e instanceof Anthropic.APIError) send(res, 502, { error: `Claude API error ${e.status}: ${e.message}` });
    else send(res, 500, { error: String(e?.message || e) });
  } finally { inFlight--; reservedUsd -= worst; }
}

http.createServer(async (req, res) => {
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
    if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, status());
    if (req.method === 'POST' && url.pathname === '/api/check') {
      if (tooManyFailures(req)) return send(res, 429, { ok: false, error: 'Too many wrong passwords. Wait a few minutes.' });
      const ok = passwordOk(req); if (!ok) noteFailure(req);
      return send(res, ok ? 200 : 401, { ok, ...status() });
    }
    if (req.method === 'POST' && url.pathname === '/api/ai') return await handleAI(req, res);
    send(res, 404, { error: 'not found' });
  } catch (e) { console.error(e); if (!res.headersSent) send(res, 500, { error: 'server error' }); }
}).listen(PORT, () => {
  console.log(`PromptCraft on http://localhost:${PORT}  provider=${PROVIDER} model=${MODEL} agents=${AGENT_MODEL} budget=$${BUDGET_USD} spent=$${usage.spentUsd.toFixed(3)}${MOCK ? '  [MOCK MODE]' : ''}`);
  console.log(`Share it: npm run tunnel   (cloudflared quick tunnel)`);
});
