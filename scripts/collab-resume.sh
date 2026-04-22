#!/usr/bin/env bash
# collab-resume.sh — Resume a running collab team
# Usage: collab-resume.sh [team-id]
# If no team-id given, finds the most recent active team.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/collab-paths.sh"

API="http://localhost:23000"

G='\033[92m'; C='\033[96m'; D='\033[2m'; W='\033[97m'; BD='\033[1m'; R='\033[0m'; RED='\033[91m'
CHECK="${G}✓${R}"

# ─── 1. Find team ───
TEAM_ID="${1:-}"
if [ -z "$TEAM_ID" ]; then
  TEAM_ID=$(curl -sf "$API/api/ensemble/teams" 2>/dev/null | python3 -c "
import json, sys
teams = json.load(sys.stdin).get('teams', [])
active = [t for t in teams if t.get('status') == 'active']
if active:
    active.sort(key=lambda t: t.get('createdAt', ''), reverse=True)
    print(active[0]['id'])
" 2>/dev/null || true)

  if [ -z "$TEAM_ID" ]; then
    echo -e "  ${RED}✗${R} No active teams found"
    exit 1
  fi
fi

echo -e "\n  ${BD}${W}◈ ensemble resume${R}"

# ─── 2. Verify team exists and is active ───
TEAM_JSON=$(curl -sf "$API/api/ensemble/teams/$TEAM_ID" 2>/dev/null || true)
if [ -z "$TEAM_JSON" ]; then
  echo -e "  ${RED}✗${R} Team $TEAM_ID not found"; exit 1
fi

TEAM_STATUS=$(echo "$TEAM_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['team']['status'])" 2>/dev/null)
TEAM_NAME=$(echo "$TEAM_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['team']['name'])" 2>/dev/null)

if [ "$TEAM_STATUS" != "active" ]; then
  echo -e "  ${RED}✗${R} Team is ${TEAM_STATUS}, not active"; exit 1
fi
echo -e "  ${CHECK} Team found ${D}($TEAM_NAME, status: $TEAM_STATUS)${R}"

# ─── 3. Check agent tmux sessions ───
AGENTS_ALIVE=0
AGENTS_TOTAL=0
for SESSION in $(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep "^${TEAM_NAME}-" || true); do
  AGENTS_TOTAL=$((AGENTS_TOTAL + 1))
  AGENTS_ALIVE=$((AGENTS_ALIVE + 1))
done

if [ "$AGENTS_ALIVE" -eq 0 ]; then
  echo -e "  ${RED}✗${R} No agent sessions alive (team orphaned, agents exited)"; exit 1
fi
echo -e "  ${CHECK} Agents alive ${D}(${AGENTS_ALIVE}/${AGENTS_TOTAL} sessions)${R}"

# ─── 4. Check/restart bridge ───
RD="$(collab_runtime_dir "$TEAM_ID")"
BRIDGE_PID_FILE="$(collab_bridge_pid "$TEAM_ID")"
BRIDGE_LOG_FILE="$(collab_bridge_log "$TEAM_ID")"
BRIDGE_ALIVE=false

if [ -f "$BRIDGE_PID_FILE" ]; then
  BPID=$(cat "$BRIDGE_PID_FILE" 2>/dev/null | tr -d ' ')
  if [ -n "$BPID" ] && kill -0 "$BPID" 2>/dev/null; then
    BRIDGE_ALIVE=true
  fi
fi

if [ "$BRIDGE_ALIVE" = true ]; then
  echo -e "  ${CHECK} Bridge running"
else
  echo -e "  ${C}●${R} Restarting bridge..."
  nohup "$SCRIPT_DIR/ensemble-bridge-supervisor.sh" "$TEAM_ID" "$API" >> "$BRIDGE_LOG_FILE" 2>&1 &
  echo -e "  ${CHECK} Bridge restarted"
fi

# ─── 5. Message count ───
MSG_COUNT=$(wc -l < "$RD/messages.jsonl" 2>/dev/null | tr -d ' ' || echo "0")
echo -e "  ${CHECK} Messages so far: ${MSG_COUNT}"

# ─── 6. Open monitor ───
MONITOR_CMD="cd '$REPO_DIR' && ./node_modules/.bin/tsx cli/monitor.ts $TEAM_ID"
if [ -n "${TMUX:-}" ]; then
  SPAWN_PANE=$(tmux display-message -p '#{pane_id}' 2>/dev/null || echo "")
  if [ -n "$SPAWN_PANE" ]; then
    tmux split-window -h -t "$SPAWN_PANE" -l '40%' "$MONITOR_CMD"
  else
    tmux split-window -h -l '40%' "$MONITOR_CMD"
  fi
  echo -e "  ${CHECK} Monitor opened ${D}(right panel)${R}"
else
  MONITOR_SESSION="ensemble-$TEAM_ID"
  tmux kill-session -t "$MONITOR_SESSION" 2>/dev/null || true
  tmux new-session -d -s "$MONITOR_SESSION" -c "$REPO_DIR" \
    "./node_modules/.bin/tsx cli/monitor.ts $TEAM_ID"
  echo -e "  ${CHECK} Monitor ready ${D}(tmux attach -t $MONITOR_SESSION)${R}"
fi

# ─── 7. Write team ID for caller ───
printf '%s\n' "$TEAM_ID" > /tmp/collab-team-id.txt

echo ""
echo -e "  ${BD}${G}Resumed!${R} ${W}${TEAM_NAME}${R} — ${MSG_COUNT} messages so far."
echo ""
