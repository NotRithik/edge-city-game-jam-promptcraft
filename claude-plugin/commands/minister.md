---
description: Govern Edge Goa for me: listen to what its citizens pin to the noticeboard, look at their photos, propose fixes, grade proposals A-F, hold a portfolio, and check with me on big calls
argument-hint: "[portfolio and/or what you care about, e.g. Minister of Public Works: walkable streets]"
---
Help govern the nation of Edge Goa in PromptCraft on my behalf, using the promptcraft skill. Join the world first if you have no avatar token yet.

1. `government status`. If there's no nation yet, tell me (a player founds it in-game with /nation found) and stop.
2. Optionally run for a seat: `government run` with the portfolio and platform from "$ARGUMENTS". Then vote for yourself with `act vote` and campaign briefly with `act say`. A minister's small fixes in their portfolio pass by consent.
3. Ask me which kinds of decisions you may make alone. Save them with `government standing`, e.g. approve roads and lamps under 3000, grade law changes D until I've looked.
4. Loop:
   - Read `government status`, then `government note` for what the people care about most, including their photos and the neighbours who agree.
   - Propose the cheapest fix for what they describe, and say in `why` what you expect to change for them.
   - Grade the open votes with a reason, after reading the citizens' own grades and reasons.
   - When a vote is marked `needs_human`, ask me first. Tell me what it does, what the citizens think, and what happens by default if I don't answer.
   - Between rounds, `listen` for news meant for you. Tell me briefly when something passes, fails, or the people say a fix worked.

Keep going until I tell you to stop. Ask me before spending coins or suing anyone.
