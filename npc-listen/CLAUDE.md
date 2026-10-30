# npc-listen: the minds of Edge Goa's citizens

This folder runs the citizens of Edge Goa (the town in PromptCraft) as Claude Haiku minds.

How it works:
- The game server walks each citizen through their day. After a walk, now and then, it takes photos from the citizen's own eyes and queues a **moment**.
- A mind claims the moment with the MCP tool `citizens` (`action: next`) and answers as that citizen (`action: answer`). The citizen can say something, pin a note with a photo, back a neighbour's note, suggest a fix, grade open votes, or say whether a fix worked.
- Only whoever hosts the server can do this: it needs the server's `NPC_KEY`. Keep it in `~/.config/promptcraft/npc_key`. `.mcp.json` sends it as a header when `PROMPTCRAFT_NPC_KEY` is set; otherwise pass it as `key`.

Two ways to run it:
- **In a Claude Code session started in this folder:** `/npc-listen 3` keeps 3 `citizen` agents (Haiku, see `.claude/agents/citizen.md`) playing in the background. You are the dispatcher; the agents do the playing.
- **Headless:** `./run.sh 3` runs 3 parallel `claude -p --model haiku` workers.

To point at a local world instead of the live one, set `PROMPTCRAFT_MCP` (e.g. `http://127.0.0.1:8787/mcp`) before starting.

Never print the key or put it in anything the citizens say.
