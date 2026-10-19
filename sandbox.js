// Sandboxes: private copies of the shared world where an AI previews what it makes before it's real.
// Each session is one headless Chrome tab running the game page with ?sandbox=1 (see section 13 of public/index.html):
// load a snapshot of the world around a site, apply draft actions, render views, and play-test like a player.
// Nothing in a sandbox is saved or sent to players; commit() hands the draft back for the real world.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
].filter(Boolean);
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', 'cdn.jsdelivr.net']); // the game page + three.js, nothing else

export function makeSandboxes({ baseUrl, max = 3, idleMs = 10 * 60e3, log = console.log }) {
  const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  const sessions = new Map(); // key -> session
  let browser = null, launching = null, closeTimer = null;

  async function getBrowser() {
    clearTimeout(closeTimer);
    if (browser?.connected) return browser;
    if (!chrome) throw new Error('No Chrome/Chromium on this server, so sandboxes are unavailable.');
    launching ||= puppeteer.launch({
      executablePath: chrome, headless: true, defaultViewport: { width: 960, height: 540 },
      // software WebGL (SwiftShader): servers have no GPU, and on a Mac it keeps clear of the GPU the real game tabs use
      args: [...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []), '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
    }).then((b) => { browser = b; b.on('disconnected', () => { browser = null; sessions.clear(); }); log('[sandbox] browser started'); return b; }).finally(() => { launching = null; });
    return launching;
  }
  function maybeCloseBrowser() {
    clearTimeout(closeTimer);
    if (!sessions.size) closeTimer = setTimeout(() => { if (!sessions.size && browser) { browser.close().catch(() => {}); browser = null; log('[sandbox] browser closed (idle)'); } }, 5 * 60e3);
  }
  setInterval(() => { for (const [k, s] of sessions) if (Date.now() - s.used > idleMs && !s.busy) close(k); }, 60e3).unref();

  async function newPage(s) {
    const page = s.page = await (await getBrowser()).newPage();
    await page.setRequestInterception(true);
    page.on('request', (r) => { let h = ''; try { h = new URL(r.url()).hostname; } catch {} if (ALLOWED_HOSTS.has(h) || r.url().startsWith('data:')) r.continue(); else r.abort(); });
    page.on('console', (m) => { const t = m.type(); if ((t === 'error' || t === 'warn' || t === 'warning') && !/^Failed to load resource|^\[DOM\]|GL Driver Message|GPU stall/.test(m.text())) { s.console.push(m.text().slice(0, 300)); if (s.console.length > 40) s.console.shift(); } });
    page.on('pageerror', (e) => { s.console.push('page error: ' + String(e.message || e).slice(0, 300)); });
    page.setDefaultTimeout(60e3);
    await page.goto(baseUrl + '/?sandbox=1', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('typeof window.__sbLoad === "function"');
    await page.evaluate((snap) => window.__sbLoad(snap), s.snap);
    await page.waitForFunction('window.__sbReady && window.sandbox');
    return page;
  }
  // every call on a session runs one at a time, in order
  function run(s, fn) {
    s.used = Date.now();
    const p = s.q.then(async () => { s.busy = true; try { return await fn(); } finally { s.busy = false; s.used = Date.now(); } });
    s.q = p.catch(() => {});
    return p;
  }
  const take = (s) => { const c = s.console.splice(0); return c.length ? { console: c } : {}; };

  async function open(key, snap, meta = {}) {
    if (sessions.has(key)) await close(key);
    if (sessions.size >= max) {
      const idle = [...sessions.entries()].filter(([, s]) => !s.busy).sort((a, b) => a[1].used - b[1].used)[0];
      if (!idle || Date.now() - idle[1].used < 60e3) throw new Error(`All ${max} sandboxes are in use right now; try again in a minute.`);
      await close(idle[0]);
    }
    const s = { key, snap, meta, draft: [], console: [], used: Date.now(), created: Date.now(), q: Promise.resolve(), busy: false, page: null };
    sessions.set(key, s);
    try { await run(s, async () => { s.page = await newPage(s); }); } catch (e) {
      sessions.delete(key); s.page?.close().catch(() => {}); maybeCloseBrowser();
      throw new Error(`The sandbox failed to start: ${e.message}${s.console.length ? ` (${s.console.slice(-3).join(' | ')})` : ''}`);
    }
    return s;
  }
  async function close(key) {
    const s = sessions.get(key); if (!s) return false;
    sessions.delete(key); try { await s.page?.close(); } catch {}
    maybeCloseBrowser(); return true;
  }
  const get = (key) => sessions.get(key) || null;
  const call = (s, fn, ...args) => s.page.evaluate(fn, ...args);

  async function rebuild(s) { // fresh copy of the world, then the draft so far
    await s.page.close().catch(() => {});
    s.page = await newPage(s);
    let last = null;
    for (const batch of s.draft) last = await call(s, (a) => window.sandbox.apply(a), batch);
    return last;
  }
  return {
    available: () => !!chrome,
    count: () => sessions.size,
    open, close, get,
    apply: (s, actions, opts = {}) => run(s, async () => { const r = await call(s, (a, o) => window.sandbox.apply(a, o), actions, opts); s.draft.push(actions); return { ...r, ...take(s) }; }),
    view: (s, specs) => run(s, async () => { const out = []; for (const v of specs) out.push(await call(s, (x) => window.sandbox.view(x), v)); return out; }),
    play: (s, steps) => run(s, async () => ({ ...(await call(s, (x) => window.sandbox.play(x), steps)), ...take(s) })),
    state: (s) => run(s, async () => ({ ...(await call(s, () => window.sandbox.state())), ...take(s) })),
    context: (s) => run(s, () => call(s, () => window.sandbox.context())),
    undo: (s) => run(s, async () => { s.draft.pop(); const r = await rebuild(s); return { batches_left: s.draft.length, ...(r ? { last: r } : {}), ...take(s) }; }),
    reset: (s) => run(s, async () => { s.draft = []; await rebuild(s); return { ok: true }; }),
  };
}
