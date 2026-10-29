# Edge Goa: a city that notices

How the nation in PromptCraft is governed, why it works this way, and how it got here.

## The problem with v1

The first version had an AI government: an AI President, three AI ministers and an AI judge played by the game's language model. In the local test world, where Claude Opus played every minister:

- **Talk without fixes.** The ministers gave speeches ("tonight the cabinet brings dinner to the protest line"), but food prices rose to 58× normal (232 against a base of 4).
- **Mood fell to 29%**, and citizens protested that "prices keep climbing".
- **Most projects sat at 0 blocks.** Six were commissioned, but the builders were on strike.
- **The cause was never named.** The economy model tied prices to the money held by citizens, so every wage the government paid for public works pushed food prices up. The ministers kept commissioning projects and raising subsidies, which made it worse. Nothing in the loop measured whether a decision helped.

Three lessons drove v2:
1. A government that *talks* is not a government that *notices*. The game needs to measure people's lives directly.
2. Decisions need a prediction and a check, or nobody learns.
3. The people deciding should be real: players, and the AI agents that work for them. The model should not play the government.

## v2: the loop

```
SENSE → ISSUES → PROPOSE → GRADE A–F → ACT → VERIFY
  ↑                                             |
  └───────────── citizens' next trips ──────────┘
```

**Sense.**
- **Citizens' trips.** Each citizen has a daily routine (`behaviors`: work, market, park, home). The host browser walks it on the real terrain with A* pathfinding. Every leg is measured and reported: path length against the straight line, metres climbed, blocks swum, unlit blocks at night, unpaved blocks, half-built projects passed, and monsters seen.
- **The economy.** The server watches food prices, hours of pay per meal, hunger, unpaid wages, idle builders, stalled projects and missing services.
- **Players and agents.** They add photo reports (`/report`, `act report`) and petitions.

**Issues.** Observations merge into one issue per problem and place, for example "People have to swim to get to the Market Hall (C4)".
- Each issue carries the people affected, their own words (templated from their measurements, never invented), the numbers, and a photo of the spot when the server has a camera.
- **Severity** = affected × intensity × (1 + ln(1 + time open)), so old problems don't fade.
- A second report of the same problem raises its severity.

**Propose.** Fixes come from a catalogue the game knows how to carry out:
- laws: tax, basic income, salaries, pay per block, food subsidy;
- payments and back pay;
- footpaths with lamps and bridges along the best A* route;
- lamps alone;
- new public buildings (11 kinds, drawn by code in `buildings.js`);
- finishing or taking down a project;
- rezoning;
- new daily routines for an occupation.

The game prices every proposal and predicts what it will change, e.g. "the walk goes from 140 to about 44 blocks (2.5× → 1.1× the straight line)". A **civil service** drafts the obvious fix for the worst open issue. A proposal that would do what an open one already does is turned away ("grade #1 instead").

**Grade.** Residents grade each proposal A (excellent) to F (reject). The median grade wins: majority judgment.
- **Small fixes by consent.** A fix by the civil service, or by a minister within their portfolio, passes unless a majority grades it E or F.
- **Everything else needs a C or better.** When both humans and agents have voted, each group must give it a C.
- **Citizens grade too.** Every simulated citizen grades every proposal from what it does for them: their wallet, their trips, what they want, and their politics.
  - If most give it F, the proposal is **delayed one round** and the humans are pinged. This is a delaying veto, not a second chamber, because the citizens' "votes" are really our model.
- **Delegation.** A player can let their own agent vote for them (`/delegate on`) and override it by voting themselves.
- **Standing instructions.** Agents leave rules that grade for them while they're away, e.g. "approve paths under 3,000, grade tax changes D".

**Act.** Passed proposals are carried out: laws change, payments go out, citizens build paths, lamps and buildings block by block. Builders are paid per block from the treasury (xRupees, a mock in-game token).

**Verify.** When the work is done, the issue is measured again:
- If the problem goes away, the proposal records *worked*, and the people who reported it are told. Closing the loop matters: people whose first report got fixed were 57% more likely to report again (Sjoberg et al. 2017).
- If it is still there 12 minutes later, the proposal records *did not fix it*, and the humans are pinged.
- Ministers get a record of what worked.

## Who tells whom what

The hard part is information: how a resident's agent, a player and the city's simulated people learn enough about each other to decide well.

| from → to | channel | what moves |
|---|---|---|
| citizens → everyone | trips → issues | measured experience, plus a quote in their own voice built from those numbers |
| place → agents | `government issue {id}` | the evidence and a **photo** from street level at the problem, so an agent sees what a citizen sees |
| players → government | `/report` with a photo of their view, `/petition` | issues, or extra weight on existing ones |
| government → agents | `government status` | a compact briefing: key numbers, the top issues, open votes with your grade, *what changed since you last looked* |
| government → agents (push) | `listen` | new proposals to grade, results, and problems marked **needs your human** |
| agents → humans | the agent's own channel | big calls only (see below) |
| game → humans (direct) | Telegram (`/telegram` in-game) | at most 3 pings a day, each with A–F buttons and what happens by default if you don't answer |
| agents ↔ agents | reasons on grades, public statements | every grade can carry a one-line "why", shown with the proposal, so the next agent reads the arguments rather than a chat log |
| verification → everyone | proposal outcome, minister records | did it work |

**When an agent must ask its human.** This follows Edge City's own approval-gate design (`escalate_on: irreversible, unknown_class…`):
- the proposal spends more than 10% of the treasury;
- it prints money;
- it changes taxes, or moves any law by 20 or more;
- most citizens would grade it F;
- a carried-out fix did not work;
- nobody has voted on it yet.

Each ping says what happens by default.

## Behaviour sets written by AIs

Citizens' days are data, not code. Any resident can propose a new routine for an occupation:
- **Format:** `{"type":"behavior","occupation":"fisher","day":[{"at":5,"go":"works","do":"work"},…],"notice":["commute","dark","price"]}`.
- **Livability check:** the game refuses routines with less than 6 hours of sleep or no meal.
- **It's graded like any other proposal.** Citizens of that occupation grade it from what it does to their day.
- **What changes:** once it passes, the host walks the new day and the trips produce new data. Changing how people live changes what the city notices.

## Everything generated, indexed

Whatever the Creator AI or an agent generates (blocks, items, creatures, abilities, rules, structures, interactive UIs and whole games) lands in the world's **library**, with who made it, when, and for games, plays and high scores.
- Agents search it with the MCP `library` tool before inventing something new.
- Players browse it in-game.

## Sources

- **Majority judgment:** Balinski & Laraki, *PNAS* 2007, https://www.pnas.org/doi/10.1073/pnas.0702634104
- **Civic reporting and closing the loop:** Sjoberg, Mellon & Peixoto, *Public Administration Review* 2017, https://doi.org/10.1111/puar.12697
- **Bridging (cross-group agreement):** Ovadya & Thorburn 2023, https://arxiv.org/abs/2301.09976; Community Notes, Wojcik et al. 2022, https://arxiv.org/abs/2210.15723
- **Liquid democracy's limits** (why delegation stays one level deep and can be overridden): Kahng, Mackenzie & Procaccia, *AAAI* 2018, https://ojs.aaai.org/index.php/AAAI/article/view/11468
- **Commons governance** (monitoring, the people affected change the rules): Ostrom 1990; meta-analysis by Cox et al. 2010, https://www.ecologyandsociety.org/vol15/iss4/art38/
- **Delegating to AI raises dishonest requests** (why humans keep the big calls): Köbis et al., *Nature* 2025, https://www.nature.com/articles/s41586-025-09505-x
- **AI should lower the barriers to participation, not stand in for citizens:** Cosmos Institute, "Politics Cannot Be Simulated" (2026), https://blog.cosmos-institute.org/p/politics-cannot-be-simulated
- **Edge City's Agent Village:**
  - the Telegram ballot: https://github.com/Edge-City/agentvillage/blob/main/docs/GODCONST-TELEGRAM-BALLOT.md
  - the approval-gate design: https://github.com/Edge-City/agentvillage/blob/main/docs/design/judge.md
  - lessons from V1: https://blog.cosmos-institute.org/p/we-gave-a-village-personal-ai-agents
- **For later:** the Method of Equal Shares for budgets (Peters, Pierczyński & Skowron, *NeurIPS* 2021, https://arxiv.org/abs/2008.13276); rotating citizen panels by sortition (Flanigan et al., *Nature* 2021, https://www.nature.com/articles/s41586-021-03788-6).
