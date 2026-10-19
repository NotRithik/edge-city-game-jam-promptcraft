// The on-chain side of PromptCraft's economy (MOCK tokens, no real-world value).
// Money is a real ERC20 (MockToken here; any ERC20 via CURRENCY_TOKEN later) held by PromptCraftVault, which keeps
// every game account's balance (players, AI agents, citizens, the treasury). The server moves value with batched
// operator transactions, so players need no wallet or gas. Laws, cabinet decisions, court rulings and public works
// are recorded in PromptCraftGov.
// By default this starts a local anvil node forked from Base mainnet (free gas, state saved in data/chain/);
// CHAIN_RPC + CHAIN_PK point it at any other EVM chain instead, and CHAIN=off turns it off.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, createWalletClient, http, keccak256, toHex, parseUnits, formatUnits, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // anvil's well-known dev account #0 (local chains only)
const ART = JSON.parse(fs.readFileSync(new URL('./chain-artifacts.json', import.meta.url), 'utf8'));
function isAnvil(pid) { // only ever kill our own leftover anvil, never a process that reused its pid
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('anvil'); } catch {}
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).includes('anvil'); } catch { return false; }
}
export const accountId = (id) => keccak256(toHex('promptcraft:' + id));
export const nationId = (name) => keccak256(toHex('promptcraft-nation:' + name));

export function startChain({ root, port, currency, log = console.log }) {
  const env = process.env, dir = path.join(root, 'data', 'chain');
  const st = { ready: false, error: null, disabled: env.CHAIN === 'off', queue: [], gov: [], txs: 0, lastTx: null, lastBlock: null, chainId: null, addresses: null, decimals: 18, onReady: [] };
  const api = {
    get ready() { return st.ready; }, get status() { return status(); },
    whenReady: (fn) => (st.ready ? fn() : st.onReady.push(fn)),
    move: (from, to, coins, memo) => op(0, from, to, coins, memo),
    print: (to, coins, memo) => op(1, null, to, coins, memo),
    burn: (from, coins, memo) => op(2, from, null, coins, memo),
    record: (fn, args) => { if (!st.disabled) st.gov.push({ fn, args }); },
    clearQueue: () => { st.queue.length = 0; },
    pendingDelta: () => { const d = {}; for (const o of st.queue) { if (o.fromId) d[o.fromId] = (d[o.fromId] || 0) - o.coins; if (o.toId) d[o.toId] = (d[o.toId] || 0) + o.coins; } return d; },
    get needsResync() { const v = st.needsResync; st.needsResync = false; return v; },
    balances, stop,
  };
  if (st.disabled) { log('[chain] off (CHAIN=off): coins stay in the server ledger only'); return api; }
  fs.mkdirSync(dir, { recursive: true });
  let anvil = null, pub, wallet, me, flushing = false;

  function op(kind, from, to, coins, memo) {
    const n = Math.floor(+coins); if (st.disabled || !(n > 0)) return;
    st.queue.push({ kind, fromId: from, toId: to, coins: n, memo: String(memo || '').slice(0, 60) });
  }
  function status() {
    return { on: !st.disabled, ready: st.ready, error: st.error, chainId: st.chainId, network: env.CHAIN_RPC ? 'custom RPC' : `local anvil fork of Base mainnet${st.forkBlock ? ` @ block ${st.forkBlock}` : ''}`,
      ...(st.addresses || {}), txs: st.txs, lastTx: st.lastTx, lastBlock: st.lastBlock, pending: st.queue.length + st.gov.length };
  }
  async function rpcUp(url) { for (let i = 0; i < 60; i++) { try { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }); if (r.ok) return true; } catch {} await new Promise((r) => setTimeout(r, 500)); } return false; }

  async function boot() {
    let url = env.CHAIN_RPC, key = env.CHAIN_PK;
    if (!url) { // our own anvil, forked from Base at a pinned block so restarts see the same world
      const cfgFile = path.join(dir, 'fork.json');
      let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch {}
      const forkUrl = env.CHAIN_FORK_URL || 'https://mainnet.base.org';
      if (!cfg.block) {
        try { const r = await fetch(forkUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' }); cfg = { forkUrl, block: Number((await r.json()).result) - 5 }; fs.writeFileSync(cfgFile, JSON.stringify(cfg)); }
        catch (e) { cfg = { block: 0 }; log('[chain] could not reach Base to fork; running a fresh local chain instead'); }
      }
      st.forkBlock = cfg.block || null;
      const p = Number(env.CHAIN_PORT || port);
      const args = ['--host', '127.0.0.1', '--port', String(p), '--chain-id', String(env.CHAIN_ID || 84530), '--gas-price', '0', '--block-base-fee-per-gas', '0',
        '--state', path.join(dir, 'anvil-state.json'), '--state-interval', '20', '--silent', ...(cfg.block ? ['--fork-url', forkUrl, '--fork-block-number', String(cfg.block), '--no-rate-limit'] : [])];
      const pidFile = path.join(dir, 'anvil.pid'); // an anvil left over from a crashed run would hold the port and the state
      try { const old = Number(fs.readFileSync(pidFile, 'utf8')); if (old && isAnvil(old)) { process.kill(old, 'SIGTERM'); await new Promise((r) => setTimeout(r, 1500)); } } catch {}
      anvil = spawn(env.ANVIL_PATH || 'anvil', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      if (anvil.pid) fs.writeFileSync(pidFile, String(anvil.pid));
      process.on('exit', () => { try { anvil?.kill('SIGTERM'); } catch {} }); // never outlive the server
      anvil.stderr.on('data', (d) => { const s = String(d).trim(); if (s) log('[anvil] ' + s.slice(0, 300)); });
      anvil.on('exit', (code) => { if (st.ready) log(`[chain] anvil exited (${code})`); st.ready = false; anvil = null; });
      anvil.on('error', (e) => { st.error = 'anvil not found: ' + e.message; });
      url = `http://127.0.0.1:${p}`; key = ANVIL_KEY;
    }
    if (!(await rpcUp(url))) throw new Error(st.error || `no chain at ${url}`);
    me = privateKeyToAccount(key || ANVIL_KEY);
    st.chainId = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' })).json().then((j) => Number(j.result));
    const chain = defineChain({ id: st.chainId, name: 'promptcraft-chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url] } } });
    pub = createPublicClient({ chain, transport: http(url) });
    wallet = createWalletClient({ chain, account: me, transport: http(url) });
    // contracts: reuse the saved deployment if its code is still there, else deploy fresh
    const depFile = path.join(dir, `deploy-${st.chainId}.json`);
    let dep = null; try { dep = JSON.parse(fs.readFileSync(depFile, 'utf8')); } catch {}
    const has = async (a) => !!a && ((await pub.getCode({ address: a })) || '0x') !== '0x';
    let fresh = false;
    if (!dep || !(await has(dep.vault)) || !(await has(dep.gov)) || !(await has(dep.token))) {
      fresh = true;
      const deploy = async (name, args = []) => { const hash = await wallet.deployContract({ abi: ART[name].abi, bytecode: ART[name].bytecode, args }); const r = await pub.waitForTransactionReceipt({ hash }); return r.contractAddress; };
      const vault = await deploy('PromptCraftVault'), gov = await deploy('PromptCraftGov');
      let token = env.CURRENCY_TOKEN;
      if (!token) { token = await deploy('MockToken', [`${currency} (PromptCraft mock)`, currency.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8)]); await waitTx(await wallet.writeContract({ address: token, abi: ART.MockToken.abi, functionName: 'setMinter', args: [vault, true] })); }
      dep = { vault, gov, token, operator: me.address, deployedAt: new Date().toISOString() };
      fs.writeFileSync(depFile, JSON.stringify(dep, null, 2));
      log(`[chain] deployed vault ${vault}, gov ${gov}, ${currency} token ${token} on chain ${st.chainId}`);
    }
    try { st.decimals = Number(await pub.readContract({ address: dep.token, abi: ART.MockToken.abi, functionName: 'decimals' })); } catch {}
    st.addresses = { vault: dep.vault, gov: dep.gov, token: dep.token, operator: dep.operator };
    st.ready = true;
    log(`[chain] ready on ${status().network} (chain ${st.chainId})`);
    st.fresh = fresh;
    for (const fn of st.onReady.splice(0)) { try { await fn({ fresh }); } catch (e) { log('[chain] onReady failed: ' + e.message); } }
  }
  const waitTx = (hash) => pub.waitForTransactionReceipt({ hash });

  async function flush() {
    if (!st.ready || flushing || (!st.queue.length && !st.gov.length)) return;
    flushing = true;
    const ops = st.queue.splice(0, 200), govs = st.gov.splice(0, 20);
    try {
      if (ops.length) {
        const Z = '0x' + '0'.repeat(64), one = (o) => ({ kind: o.kind, token: st.addresses.token, from: o.fromId ? accountId(o.fromId) : Z, to: o.toId ? accountId(o.toId) : Z, amount: parseUnits(String(o.coins), st.decimals), memo: o.memo });
        try {
          const hash = await wallet.writeContract({ address: st.addresses.vault, abi: ART.PromptCraftVault.abi, functionName: 'batch', args: [ops.map(one)] });
          const r = await waitTx(hash); st.txs++; st.lastTx = hash; st.lastBlock = Number(r.blockNumber);
        } catch (e) { // one bad op (e.g. the server and chain disagree on a balance) must not sink the rest
          log(`[chain] batch of ${ops.length} failed (${String(e.shortMessage || e.message).slice(0, 120)}); retrying one by one`);
          for (const o of ops) {
            try { const hash = await wallet.writeContract({ address: st.addresses.vault, abi: ART.PromptCraftVault.abi, functionName: 'batch', args: [[one(o)]] }); const r = await waitTx(hash); st.txs++; st.lastTx = hash; st.lastBlock = Number(r.blockNumber); }
            catch (e2) { log(`[chain] dropped op ${o.kind} ${o.coins} "${o.memo}": ${String(e2.shortMessage || e2.message).slice(0, 100)}`); st.needsResync = true; }
          }
        }
      }
      for (const g of govs) {
        try { const hash = await wallet.writeContract({ address: st.addresses.gov, abi: ART.PromptCraftGov.abi, functionName: g.fn, args: g.args }); const r = await waitTx(hash); st.txs++; st.lastTx = hash; st.lastBlock = Number(r.blockNumber); }
        catch (e) { log(`[chain] gov ${g.fn} failed: ${String(e.shortMessage || e.message).slice(0, 120)}`); }
      }
    } finally { flushing = false; }
  }
  const timer = setInterval(() => flush().catch((e) => log('[chain] flush error ' + e.message)), 2000);
  timer.unref?.();

  async function balances(ids) { // game account ids -> on-chain balances in whole coins
    if (!st.ready || !ids.length) return null;
    const out = {};
    for (let i = 0; i < ids.length; i += 400) {
      const part = ids.slice(i, i + 400);
      const r = await pub.readContract({ address: st.addresses.vault, abi: ART.PromptCraftVault.abi, functionName: 'balancesOf', args: [st.addresses.token, part.map(accountId)] });
      part.forEach((id, j) => { out[id] = Number(formatUnits(r[j], st.decimals)); });
    }
    return out;
  }
  async function stop() { try { await flush(); } catch {} if (anvil) { anvil.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 800)); } }
  api.flush = flush;
  boot().catch((e) => { st.error = e.message; log('[chain] failed to start: ' + e.message + ' (the game keeps running on the server ledger)'); });
  return api;
}
