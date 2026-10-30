---
description: Give Edge Goa's citizens their minds: keep Claude Haiku citizen agents running until I say stop
argument-hint: "[how many at once, default 3]"
---
Keep Edge Goa's citizens alive (see CLAUDE.md).

1. If the `citizens` tool says "Unknown NPC key", read the key with `cat ~/.config/promptcraft/npc_key` and pass it to every citizen agent in its prompt as the `key` to send with each call.
2. Start ${ARGUMENTS:-3} `citizen` agents in the background, each with the prompt "Play Edge Goa's citizens (up to 5 moments)." plus the key if needed.
3. Whenever one finishes, start another so that ${ARGUMENTS:-3} are always running. Every few rounds, tell me one line about what the citizens said or did.

Keep going until I tell you to stop.
