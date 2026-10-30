#!/usr/bin/env bash
# Give Edge Goa's citizens their minds: N headless Claude Haiku workers, each playing a few moments per run, in parallel.
# Usage: ./run.sh [workers=3]. Set PROMPTCRAFT_MCP=http://127.0.0.1:8787/mcp for a local world. Ctrl-C stops them all.
set -uo pipefail
cd "$(dirname "$0")"
N="${1:-3}"
export PROMPTCRAFT_NPC_KEY="${PROMPTCRAFT_NPC_KEY:-$(cat ~/.config/promptcraft/npc_key 2>/dev/null)}"
[ -n "$PROMPTCRAFT_NPC_KEY" ] || { echo "No NPC key: put the server's NPC_KEY in ~/.config/promptcraft/npc_key"; exit 1; }
PROMPT="$(awk 'f>=2; /^---$/{f++}' .claude/agents/citizen.md)" # the citizen agent's instructions, without its front matter
mkdir -p logs
worker() {
  while true; do
    echo "--- $(date +%T) run" >> "logs/worker-$1.log"
    claude -p --model haiku --mcp-config .mcp.json --strict-mcp-config --allowedTools mcp__promptcraft__citizens --max-turns 40 "$PROMPT" >> "logs/worker-$1.log" 2>&1
    sleep 3
  done
}
trap 'trap - INT TERM; kill 0' INT TERM
for i in $(seq 1 "$N"); do worker "$i" & done
echo "$N citizen minds running ($(date +%T)); logs in npc-listen/logs/. Ctrl-C to stop."
wait
