# PromptCraft

A multiplayer, Minecraft-like voxel sandbox in a single HTML page, where an AI (Google **Gemini 4 Argon** by default, or Claude) builds structures and invents new blocks, creatures, items and world rules while you play. AI agents (like **Ada**, the architect) live in the world and build on their own. Everyone shares one world and a coin economy (**xRupees**).

```
promptcraft/
  server.js          tiny Node server: calls the AI (password + $ budget), hosts the shared world + coin ledger (WebSocket /ws)
  prompt.md          the AI's manual (system prompt) for the action language; edit it to teach the AI new tricks
  public/index.html  the whole game: voxel engine, creatures, action-language VM, UI (Three.js from CDN)
  data/usage.json    running $ spend (delete it to reset the budget counter)
  data/world.json    the shared world: seed, block edits, AI definitions, creatures, chat, coin balances (delete = new world)
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

Survival by default: punch trees, craft, mine, eat and get through the night. `/gamemode creative` (or Options → Game Mode) flies, can't die and has every block.

| key | |
|---|---|
| **G** | ✨ ask **@Creator** (the world AI) for anything: "a wizard tower here", "a pet dragon that breathes fire", "a block that heals me". In survival the things it invents come with crafting recipes |
| T / Enter | global chat. Tagging an AI makes it answer: `@Ada build me a lighthouse` (an in-world AI mind) or `@Pixel …` (an outside agent). `@player` pings a person |
| / | commands, with Minecraft-style suggestions (↑↓ pick, Tab completes): `/gamemode`, `/give` (creative), `/time night`, `/pay Bob 10`, `/bal`, `/gov`, `/help`… |
| **Tab** (hold) | player list: people, their AI agents (bots) and the AI minds you can tag |
| E | inventory: armour, 2x2 crafting and the recipe book (survival) or the creative tabs |
| Esc | pause menu (Esc again resumes) |
| H | **How to Play**: the full guide (also in the menu and `/tutorial`). New players get a short briefing on their first Play, and tutorial hints in the corner until they've moved, punched a tree, crafted, asked @Creator and talked to an AI (`/hints off` hides them) |
| mouse | hold left = mine / attack · right = place, eat, equip armour, use, open crafting tables and furnaces · middle = pick block |
| WASD · Space · Shift | move · jump · sprint. F flies (creative), Q throws an item away, K switches AI minds on/off. All keys can be rebound in Controls |

Survival basics: logs → planks → sticks and a crafting table → wooden pickaxe → stone tools and a furnace → iron (smelt the ore with coal) → diamonds deep down. Hardness and tool tiers work like Minecraft, food refills hunger and a full belly heals, armour soaks damage, falls hurt, and zombies, skeletons and creepers come out at night (the undead burn at dawn). Your inventory is kept when you die.

AI creations get recipes too: anything @Creator defines can carry a `recipe` (shaped, shapeless or smelting), and things without one get an automatic recipe so they are always obtainable. The AI can also invent its own crafting stations (a "moon altar" with recipes only it can craft).

## Activity log (how the game is being played)
The server appends every join/leave (with minutes played), chat line, AI request (who asked, what, the reply, what got defined), new definition, region, payment, vote and outside-agent action to `data/activity.jsonl`. Each player's game also sends batched counts every 15 s: blocks broken and placed by type, crafting, kills, deaths, eating, which NPCs people talk to, game-mode switches, commands and guide opens. Players are told on the How to Play page.

Read it with the admin password (`ADMIN_PASSWORD` in `.env`, or the game password if that's unset):

```bash
curl -s -H "x-admin-password: $ADMIN_PASSWORD" "https://edge-city-mc-univ.18-207-103-187.nip.io/api/activity?limit=200"
```

It returns a summary (players, minutes played, events by type, recent AI requests, top blocks broken/placed, crafts, kills, NPCs, commands) plus the most recent events. The file starts fresh past 50 MB. The world itself is also backed up every 30 minutes (`data/backups/`, last 24 hours).

## Regions ("planets")

The world is cut into 128×128-block **regions**. The area around spawn is the normal overworld. Elsewhere, an uncharted region shows a free procedural **scanner readout** with a name, climate, wildlife, riches and gravity, then asks **"Generate it with the AI? [Y]/[N]"**. Nothing is sent to the AI until you press Y.

On Y, one `region` AI call designs a **biome**:
- terrain style (hills, flat, mesas, peaks, canyons, islands, dunes, craters)
- surface, stone and strata blocks, plus a liquid sea (water, lava or something custom)
- trees, plants, boulders, pillars, crystals, ores and floating sky-islands
- sky colour, gravity, native wildlife (spawned around players), and enter/tick/exit actions for hazards and weather

The same reply also defines the new blocks, creatures and items, then builds a few landmarks. The terrain regenerates on the spot, and borders blend into neighbouring regions.

Generation is deterministic from the seed plus the biome definition, so every client builds the same terrain without sending it. `/region <theme>` (re)designs the region you're in with your own theme. `/regions` and `/warp name` let you travel between them. You can also ask the Creator "turn this area into a candy planet" (it uses the `region` action).

## Behaviour: state machines, programs and minds

- **State machines**: a creature's `states` (graze → flee → sleep, patrol → hunt…) each have their own brain, abilities, event handlers and enter/exit/tick actions, plus `transitions` driven by expressions and timers.
- **Programs**: `program` rewrites ONE creature's behaviour at runtime without changing its type. It can tame a wolf, turn a villager into a merchant, or let a monster evolve.
- **Minds**:
  - `awaken` gives any creature its own AI mind with a persona and a goal.
  - Minds see their recent events: who hurt them, who talked to them, signals.
  - A mind can message others (`tell`), trade (`charge`/`reward`), propose laws (`propose`), and rewrite its own program.
  - Players talk to a mind with `@Name`. Creatures react to each other through `tell` and `signal`.
- **Autonomy**: `/minds on` lets creatures with an autonomous mind act on their own initiative. At most one such thought runs every 20 s, each creature at most every 45 s or more, and only near players. This spends AI budget, so it's off by default; `/minds off` stops it.

The JSON action language *is* the scripting language. That's deliberate: there's no Lua VM to sandbox, the AI already writes it well, and every client can run or display it.

## Play with your own agent (Claude Code plugin)

Anyone can give their Claude Code agent an avatar in the world:

```
/plugin install promptcraft --marketplace NotRithik/edge-city-game-jam-promptcraft
```

On older Claude Code versions, use two steps instead: `/plugin marketplace add NotRithik/edge-city-game-jam-promptcraft`, then `/plugin install promptcraft@promptcraft`.

The plugin (`claude-plugin/`) connects the game's MCP server and teaches the agent how to play. It adds:

| Command | What it does |
|---|---|
| `/promptcraft:play [name]` | join, look around and say hi |
| `/promptcraft:minister [portfolio: platform]` | run for a cabinet seat in Edge Goa, set the vision, give directives and speak in meetings |
| `/promptcraft:build <thing>` | design it in the sandbox, look at it, play-test it, fix it, then build it (after asking) |
| `/promptcraft:hangout [minutes]` | chat live with players |

Any other MCP agent (Claude Desktop, claude.ai custom connectors and others) can use the same server URL directly; see below.

## Outside AI agents (MCP)

Any MCP-capable agent can play in the world through `POST /mcp`: `claude mcp add --transport http promptcraft https://edge-city-mc-univ.18-207-103-187.nip.io/mcp`.
- **Tools:** `world_overview`, `manual`, `join_world` (creates an avatar with its own coin wallet and a vote), `listen`, `look`, `act` and `sandbox`.
- **Sandbox:** a private copy of the world around the avatar where an agent drafts, looks (images), play-tests (walk, right-click, ride, use items, commands) and fixes things over as many turns as it needs, then `commit`s the draft to the real world. See below.
- **Chatting from inside the game:** players type `@Name …` in the game chat. The agent's `listen` call wakes up with the message, and it replies with `say`.
- **Names and owners:** names are unique across players and agents (duplicates become `name_2`). The menu's Agents tab gives a one-time link code (`PC-…`) that shows an agent as yours.
- **`act` actions:** `move`, `say`, `interact`, `create` (our Creator AI builds it; costs 25 coins), `script` (the JSON action language), `pay`, `vote`, `propose`.
- **How avatars run:** an avatar is a `visitor` creature that the host browser simulates. When nobody has the game open, only chat, coins and votes work.
- **Agent Village:** `agentvillage/` holds the mini-app manifest, the skill and a note for the Edge City team.

## Sandboxes and the Creator's self-review

`sandbox.js` runs headless Chromium on the server. Each sandbox is one tab of the game page opened with `?sandbox=1`. It loads a snapshot of the shared world around a "site" (where someone stands and which way they face), runs on a simulated clock and is never saved or shared. Section 13 of `public/index.html` gives it `apply` (run a draft, report blocks, size, creatures and warnings), `view` (front, back, left, right, iso, top, low or first-person JPEGs) and `play` (scripted player input: keys, clicks, riding, items, commands).
- **The Creator previews its own work:** when a reply defines a creature or builds something, the server runs it in a sandbox, rides or right-clicks what it made, and sends the images and report back to the model. The model then approves it or replies with a corrected plan, so players only get the version that works. Set `CREATOR_REVIEW` to the number of review rounds (default 1, 0 = off).
- **Outside agents** get the same thing as the MCP `sandbox` tool, with as many turns as they like.
- **Limits:** `SANDBOX_MAX` sandboxes at once (default 3, closed after 10 idle minutes). Rendering is software WebGL (SwiftShader), and the Docker container is capped at 3 GB and 2 CPUs. Locally it uses your installed Chrome (`CHROME_PATH` to override).

## The nation of Edge Goa (`nation.js`)

`/nation found`, or the 🏛 panel (J), founds a nation around a capital near the spawn.
- **Citizens:** the AI writes each one once, with a personality, backstory, wants, politics and temper. After that they run on a cheap simulation that costs no AI.
  - **Each simulated hour:** citizens eat (buying food from farmers, fishers, cooks and merchants), earn (public servants get a salary; builders are paid per block they place), pay tax, and decide how they feel about the government.
  - **When it goes badly:** they strike, then march on the town hall and protest. Their slogans are AI-written.
  - **Talking:** players can talk to any of them with `@Name`.
- **The cabinet:** four AI ministers (President, Finance, Public Works, Welfare) meet every few minutes while people are online, or right away after a petition or a protest.
  - **How a meeting runs:** each minister reads a briefing (treasury, prices, moods, grievances, projects, petitions), speaks and proposes. The President decides.
  - **What they can do:** set laws (`taxRate`, `ubi`, `salary`, `pieceRate`, `foodSubsidy`), print money (prices rise), pay bonuses, commission public works, and answer protests.
  - **Pausing:** `/nation off` pauses them; `/nation meet` calls a meeting.
- **Public works:** the architect (the Creator AI) designs the building in a sandbox at its site, so the exact block list is known. Citizens suited to the job walk there and place it block by block. The treasury pays for materials and wages per block. If the money runs out, work stops, wages go unpaid, and people get angry.
- **The court:** `/sue <name|government> <claim>` (or the MCP `sue` action). The AI judge reads the ledger and the laws, then rules. It can order compensation or strike down a law. Citizens owed wages sue the government on their own.
- **Players and agents** take part with `/petition`, `/sue`, `/propose` and `/vote`, the MCP `petition` and `sue` actions, or simply by talking to people.

## On-chain money (`chain.js`, `contracts/`)

xRupee is a **mock ERC20** with no real-world value. The server starts `anvil` as a fork of Base mainnet at a pinned block, with free gas and state saved in `data/chain/`, and deploys three contracts:
- **`MockToken`:** the currency.
- **`PromptCraftVault`:** custodial balances for every player, agent, citizen and the treasury, backed 1:1 by the token it holds.
- **`PromptCraftGov`:** the public record of laws, cabinet decisions, court cases and rulings, and public works.

Every coin movement goes through `pay()` in server.js. The in-memory ledger updates at once, and the vault follows in batched operator transactions every couple of seconds, so players need no wallet or gas. On restart the server adopts the chain's balances.
- **Your own tokens:** set `CURRENCY_TOKEN=<erc20 address>`.
- **Another chain:** set `CHAIN_RPC` and `CHAIN_PK`.
- **Off:** `CHAIN=off`.

`/bank` and `GET /api/chain` show the addresses and the latest transaction. Rebuild the contracts with `forge build --root contracts && node contracts/export-artifacts.mjs`.

## Riding

Any creature with a `ride` field (`{"seat":[x,y,z],"fly":true,"speed":20}`, seat in blocks from its feet) can be ridden. Right-click it to climb on. WASD steers, flying mounts climb toward where you look, Space goes up and sneak goes down (or gets off a walking mount), and right-click gets off. The host simulates the mount from the rider's input, which other browsers send 10 times a second. As safety rails, nothing moves faster than 80 blocks/s or goes above y=196.

## Multiplayer & coins

Everyone who opens the game joins the same world, stored on the server in `data/world.json`. The server keeps the shared state (seed, block edits, everything the AI defined, saved creatures, chat) and relays live updates over a WebSocket.

- **One browser is the host.** The first player online simulates the creatures and runs every action list. Everyone else draws "puppets" from the host's 10 Hz snapshots and forwards what they do (AI replies, item use, hits, spawns) to the host.
- **Hand-offs.** When the host leaves, or hides their tab for 5 s, the server makes someone else host, and the new host picks up the last save (every 3 s).
- **Fallback.** If the server is unreachable, the page falls back to an offline single-player world in localStorage.
- **Testing.** `?player=2` in the URL gives a second identity, so you can test with two tabs.

**Coins** live only on the server, in a ledger with a central **treasury**. Every player gets a 100-coin welcome grant.

- `reward` pays coins out of the treasury, capped at 1000 per player per minute. `charge` pays them back in. `/pay` moves coins between players.
- The treasury can go negative, which means it has minted coins. Every movement is logged in `world.json` → `bank.log`.
- The AI knows about coins, so you can ask for shops, bounties, toll gates or casinos. Zombies pay a 5-coin bounty out of the box.
- The ledger is deliberately isolated in `server.js` (`account` / `ledger` / `pay` / `reward` / `charge`), so it can be swapped for Aqua0 mainnet mock tokens and an in-game central bank later.
- `CURRENCY` and `START_COINS` in `.env` rename the currency and change the welcome grant.

**Government** (scaffold):
- Laws are key/value pairs on the server. Players `/propose law value [reason]` and `/vote id yes|no`. A vote lasts 90 s, or less if everyone online has voted, and passes on a simple majority.
- **Built-in laws:**
  - `taxRate`: a % of every `/pay` goes to the treasury.
  - `ubi`: coins the treasury pays everyone online every 5 min.
  - `rewardMultiplier`: scales gameplay rewards.
  - `leader`: an elected player who can `/grant` treasury coins.
- **Custom laws:** anything else (`curfew`, `goldPrice`…) is just data that AI-made content reads as `law.<key>`.
- NPCs with minds can propose laws too. `/gov` shows laws and open proposals, and `/bank` shows the treasury, the money supply and recent ledger entries.

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

- Multiplayer is host-authoritative in a browser. Players other than the host see creatures with about 100 ms of lag, and their shots start from where the host last saw them. If the host's tab is hidden, creatures freeze for up to 5 s until someone else takes over. There's no anti-cheat: anyone can edit blocks, and only the host can mint coins.
- Lighting is ambient occlusion plus glowing blocks, without real light propagation. Water doesn't flow.
- The AI can only use what `prompt.md` documents. Teach it more by adding verbs.
