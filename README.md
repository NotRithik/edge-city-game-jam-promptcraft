# PromptCraft

A Minecraft-like voxel sandbox in a single HTML page, where an AI (Google **Gemini 4 Argon** by default, or Claude) builds structures and invents new blocks, creatures, items and world rules while you play. AI agents (like **Ada**, the architect) live in the world and build on their own.

```
promptcraft/
  server.js          tiny Node server: serves the game, calls the AI, enforces password + $ budget
  prompt.md          the AI's manual (system prompt) for the action language; edit it to teach the AI new tricks
  public/index.html  the whole game: voxel engine, creatures, action-language VM, UI (Three.js from CDN)
  data/usage.json    running $ spend (delete it to reset the budget counter)
```

## Run it

```bash
cd promptcraft
npm install
cp .env.example .env    # then set GEMINI_API_KEY and GAME_PASSWORD (budget defaults to $100)
npm start               # http://localhost:8787
```

**Live:** play at **https://edge-city-mc-univ.vercel.app**.
- **Frontend:** `public/index.html` on Vercel, project `edge-city-mc-univ`. Redeploy with `vercel deploy public --prod --yes --project edge-city-mc-univ`.
- **Backend:** the API only, running as the `edge-city-mc-univ` Docker container on the AWS VM (18.207.103.187). The VM's Caddy serves it at `https://edge-city-mc-univ.18-207-103-187.nip.io` and forwards to `127.0.0.1:18787`. Redeploy with `./deploy.sh` after changing `server.js`, `prompt.md` or `.env`. The spend counter lives on the VM in `~/edge-city-mc-univ/data/usage.json`.
- **Local:** when opened from localhost, the page calls its own server (`npm start`). Anywhere else, it calls the AWS backend (`API_BASE` in `index.html`).

To share a local copy instead, run `npm run tunnel` in a second terminal. It starts a Cloudflare quick tunnel and prints a `https://*.trycloudflare.com` URL.

- **Password:** players type `GAME_PASSWORD` in the menu (Esc) to unlock the AI. Without it the game still works, but nothing is sent to the model. If you don't set one, the server makes one up and prints it at startup. 10 wrong guesses from the same IP locks that IP out for 10 minutes.
- **Budget:** the server prices every call from the token counts it gets back and saves the total in `data/usage.json`. Once `BUDGET_USD` is used up, it refuses AI calls. Before each call it sets aside that call's worst-case cost (about $0.50 at the default settings), so even calls running in parallel can't push you over the cap. The HUD shows `$spent / $budget`.
- **No key yet?** `MOCK=1 npm start` replies with a canned build, so you can test everything else.

**Models:** the default is `PROVIDER=gemini` with `gemini-4-argon`. It needs a paid-tier key from [AI Studio](https://aistudio.google.com/apikey); the free tier returns a "not found" error. Argon costs $2 in / $10 out per million tokens until 2026-11-30, then $4 / $20. The budget tracker switches to the new price on that date by itself. `EFFORT` / `AGENT_EFFORT` set Argon's thinking level (`low|medium|high`). For Claude instead, set `PROVIDER=anthropic` and `ANTHROPIC_API_KEY`; the model then defaults to `claude-opus-5-5`, and Claude's safety-check fallbacks are enabled. The AI only runs when a player asks: a ✨ request, an `@Ada …` message, or using an AI-made item or block that calls `ask_ai`. There are no background turns.

## Play

| key | |
|---|---|
| **G** | ✨ ask the AI for anything: "a wizard tower here", "a pet dragon that breathes fire", "a block that heals me", "make it night and spawn ghosts" |
| T / Enter | chat. `@Ada build me a lighthouse` talks to an agent. `/help` lists commands (`/undo`, `/spawn`, `/give`, `/time night`, `/god`, `/new`…) |
| E | inventory: every block, item and creature, including the ones the AI made |
| F | fly · WASD/Space/Shift move · left click break/attack · right click place/use/interact · K agents on/off |

The world saves to the browser's localStorage. Each player has their own world, but everyone shares the AI password and budget.

## How it works: a few primitives that chain together

The AI never writes code. It sends back one JSON object of actions that the game runs. Gemini returns it in JSON mode; Claude calls an `act` tool. There are only five kinds of building block:

1. **Definitions** are plain data: `block`, `entity` (creature), `item`, `ability` (reusable macro), `rule` (world-wide trigger), `structure` (blueprint). Redefining a key updates everything already in the world on the spot.
2. **Events → action lists.** Blocks react to `touch / interact / break / place / tick / near / signal`. Creatures react to `spawn / tick / hurt / death / interact / touch / attack / signal`, and also have `abilities` that fire automatically. Items have `use / hit`. Rules fire on a timer (`every`) or on events.
3. **~40 verbs.** Control flow (`if, repeat, wait, forEach, pick, call, set`), world (`build, setBlock, explode, define`), creatures (`spawn, damage, push, effect, shoot, setStat, moveTo…`), FX (`particles, sound, beam, title, sky…`) and meta (`signal`, `ask_ai`).
4. **Who / where / how much.** Selectors (`"nearest r=10 team=monster"`), positions (`"self ^0 ^1 ^5"`, `"look"`, `[x,y,z]`), directions (`"toward target"`) and expressions (`"self.hp < 5 && rand() < 0.3"`) can go in almost any parameter.
5. **Build ops** for structures: `box, hollow, sphere, cylinder, cone, roof, layers (ASCII voxel art), repeat, mirror, tree, flatten, use…`

That combination gives you a lot for free. Splitting slimes are just a `death` handler that spawns smaller copies of itself. A turret block is `near` + `shoot`. A pressure plate that opens a door is `touch` → `signal` → `signal` handler → `build`. Since `ask_ai` is itself a verb, AI-made things can call the AI again (wishing wells, mutation shrines). That call is limited to once every 20s.

**Agents** are creatures with an `agent: {persona, goal}` field. When a player talks to one (`@Ada …`), the page sends the server what the agent can see plus its memory notes. Claude answers with actions, a line of speech and a new memory note. They use the same action language as everything else.

## Extending (jam tips)

- **New primitive:** add a function to `VERBS` in `index.html` (`myVerb: (a, c) => {...}`, where `a` holds the params and `c` the context with `self/target/pos/vars`), then document it in `prompt.md` so the AI knows it exists.
- **New build op:** add a `case` in `expandOps`. **New creature body:** add a template in `templateParts`. **New block look:** add a pattern in `paintTile`.
- **Debug:** `game.run([{do:'say',text:'hi'}])` in the browser console, `/def key` prints a definition, and `/undo` reverts the last build.

### Toward the Plants-vs-Zombies mode

Everything it needs already exists as primitives: teams, turret brains (`move: "turret"`), `near`-triggered trap and turret blocks, projectiles, `rule` timers for waves, global vars for score/energy (`set … on:"global"`), and `title` for wave banners. A background "director" AI is just a timed rule that calls the AI, e.g. ask the Creator for:

> "Every 90 seconds, ask the AI to design a new zombie variant and send a wave of them at me, and invent a new defensive plant block I can place."

To make it a real game mode, the next steps would be a fixed lane map (a `structure`), a resource counter in the HUD (`globals`), and a `director` role in `server.js` (`ROLE_TEXT`) with its own context builder in the page that describes wave state.

## Known limits

- Single player per browser. There's no multiplayer sync; the tunnel shares the game and the AI, not one world.
- Lighting is ambient occlusion plus glowing blocks, without real light propagation. Water doesn't flow.
- The AI can only use what `prompt.md` documents. Teach it more by adding verbs.
