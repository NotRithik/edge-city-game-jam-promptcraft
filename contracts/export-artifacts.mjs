// After `forge build --root contracts`: copy each contract's ABI and bytecode into ../chain-artifacts.json (what chain.js deploys).
import fs from 'node:fs';
const dir = new URL('.', import.meta.url).pathname, out = {};
for (const n of ['MockToken', 'PromptCraftVault', 'PromptCraftGov']) {
  const j = JSON.parse(fs.readFileSync(`${dir}out/${n}.sol/${n}.json`, 'utf8'));
  out[n] = { abi: j.abi, bytecode: j.bytecode.object };
}
fs.writeFileSync(`${dir}../chain-artifacts.json`, JSON.stringify(out));
console.log('wrote chain-artifacts.json');
