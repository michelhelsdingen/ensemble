#!/usr/bin/env bash
# collab-launch.sh — All-in-one team launcher with clean output
# Usage: collab-launch.sh <working-dir> <task-description>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=./collab-paths.sh
source "$SCRIPT_DIR/collab-paths.sh"

CWD="${1:-.}"
TASK="${2:?Usage: collab-launch.sh <cwd> <task>}"
AGENTS="${3:-}"  # Optional: comma-separated agent names (e.g. "gemini,claude")
API="${ENSEMBLE_URL:-http://localhost:23000}"
HOST_ID="${ENSEMBLE_HOST_ID:-local}"

# ─── Colors ───
G='\033[92m'; C='\033[96m'; D='\033[2m'; W='\033[97m'; BD='\033[1m'; R='\033[0m'
CHECK="${G}✓${R}"
SPIN="${C}●${R}"

echo ""
echo -e "  ${BD}${W}◈ ensemble collab${R}"
echo -e "  ${D}${TASK:0:80}${R}"
echo ""

# ─── 1. Server ───
if curl -sf "$API/api/v1/health" > /dev/null 2>&1; then
  echo -e "  ${CHECK} Server running"
else
  echo -ne "  ${SPIN} Starting server..."
  cd "$REPO_DIR" && ./node_modules/.bin/tsx server.ts > /tmp/ensemble-server.log 2>&1 &
  for _ in $(seq 1 8); do sleep 1; curl -sf "$API/api/v1/health" > /dev/null 2>&1 && break; done
  if curl -sf "$API/api/v1/health" > /dev/null 2>&1; then
    echo -e "\r  ${CHECK} Server started       "
  else
    echo -e "\r  \033[91m✗${R} Server failed to start"; exit 1
  fi
fi

# ─── 2. Create team (use env vars to avoid quoting hell) ───
TEAM_NAME="collab-$(python3 -c 'import random,time; print(str(time.time_ns()//1000000)+"-"+str(random.randint(1000,9999)))')"
PAYLOAD_FILE=$(mktemp)
TNAME="$TEAM_NAME" TDESC="$TASK" TCWD="$CWD" THOST="$HOST_ID" TAGENTS="$AGENTS" PFILE="$PAYLOAD_FILE" python3 -c "
import json, os
agents_str = os.environ.get('TAGENTS', '')
if agents_str:
    names = [a.strip() for a in agents_str.split(',')]
    agents = [{'program': names[0], 'role': 'lead', 'hostId': os.environ['THOST']}]
    for n in names[1:]:
        agents.append({'program': n, 'role': 'worker', 'hostId': os.environ['THOST']})
else:
    agents = [
        {'program': 'codex', 'role': 'lead', 'hostId': os.environ['THOST']},
        {'program': 'claude code', 'role': 'worker', 'hostId': os.environ['THOST']}
    ]
json.dump({
    'name': os.environ['TNAME'],
    'description': os.environ['TDESC'],
    'agents': agents,
    'feedMode': 'live',
    'workingDirectory': os.environ['TCWD']
}, open(os.environ['PFILE'], 'w'))
"
RESULT=$(curl -sf -X POST "$API/api/ensemble/teams" \
  -H "Content-Type: application/json" \
  -d @"$PAYLOAD_FILE")
rm -f "$PAYLOAD_FILE"

TEAM_ID=$(echo "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['team']['id'])")
RUNTIME_DIR="$(collab_runtime_dir "$TEAM_ID")"
MESSAGES_FILE="$(collab_messages_file "$TEAM_ID")"
BRIDGE_PID_FILE="$(collab_bridge_pid "$TEAM_ID")"
BRIDGE_LOG_FILE="$(collab_bridge_log "$TEAM_ID")"
POLLER_PID_FILE="$(collab_poller_pid "$TEAM_ID")"
FEED_FILE="$(collab_feed_file "$TEAM_ID")"
TEAM_ID_FILE="$(collab_team_id_file "$TEAM_ID")"

mkdir -p "$RUNTIME_DIR" "$(dirname "$MESSAGES_FILE")" "$(dirname "$FEED_FILE")"
touch "$MESSAGES_FILE"
printf '%s\n' "$TEAM_ID" > "$TEAM_ID_FILE"
# Also write to a well-known location so callers can find the latest team ID
printf '%s\n' "$TEAM_ID" > /tmp/collab-team-id.txt
echo -e "  ${CHECK} Team created ${D}(${TEAM_NAME})${R}"

# ─── 3. Bridge (writes its own PID file via single-instance guard) ───
nohup "$SCRIPT_DIR/ensemble-bridge.sh" "$TEAM_ID" "$API" >> "$BRIDGE_LOG_FILE" 2>&1 &
echo -e "  ${CHECK} Bridge started"

# ─── 4. Monitor ───
MONITOR_ENV_PREFIX=""
for KEY in ENSEMBLE_URL ENSEMBLE_DATA_DIR ENSEMBLE_PORT ENSEMBLE_HOST ENSEMBLE_CORS_ORIGIN ENSEMBLE_AGENTS_CONFIG ENSEMBLE_AGENT_FLAGS ENSEMBLE_HOST_ID; do
  VALUE="${!KEY:-}"
  if [ -n "$VALUE" ]; then
    MONITOR_ENV_PREFIX+="$KEY=$(printf '%q' "$VALUE") "
  fi
done
MONITOR_CMD="cd '$REPO_DIR' && ${MONITOR_ENV_PREFIX}node --import tsx cli/monitor.ts $TEAM_ID"
if [ -n "${TMUX:-}" ]; then
  tmux split-window -h -l '40%' "$MONITOR_CMD"
  echo -e "  ${CHECK} Monitor opened ${D}(right panel)${R}"
  MONITOR_MODE="split"
else
  MONITOR_SESSION="ensemble-$TEAM_ID"
  tmux kill-session -t "$MONITOR_SESSION" 2>/dev/null || true
  tmux new-session -d -s "$MONITOR_SESSION" -c "$REPO_DIR" \
    "node --import tsx cli/monitor.ts $TEAM_ID"
  echo -e "  ${CHECK} Monitor ready ${D}(tmux attach -t $MONITOR_SESSION)${R}"
  MONITOR_MODE="session"
fi

# ─── 5. Background poller ───
nohup bash -c '
TID="'"$TEAM_ID"'"
MESSAGES_FILE="'"$MESSAGES_FILE"'"
FEED_FILE="'"$FEED_FILE"'"
S=0
while true; do
  M=$(wc -l < "$MESSAGES_FILE" 2>/dev/null | tr -d " "); [ -z "$M" ] && M=0
  if [ "$M" -gt "$S" ]; then
    tail -n +"$((S+1))" "$MESSAGES_FILE" >> "$FEED_FILE" 2>/dev/null
    S=$M
  fi
  sleep 5
done' > /dev/null 2>&1 &
printf '%s\n' "$!" > "$POLLER_PID_FILE"

# ─── 6. Wait for agents ───
echo -ne "  ${SPIN} Agents spawning..."
for _ in $(seq 1 12); do
  sleep 1
  MC=$(wc -l < "$MESSAGES_FILE" 2>/dev/null | tr -d ' ' || echo "0")
  [ "${MC:-0}" -gt "0" ] && break
done
MC=$(wc -l < "$MESSAGES_FILE" 2>/dev/null | tr -d ' ' || echo "0")
if [ "${MC:-0}" -gt "0" ]; then
  echo -e "\r  ${CHECK} Agents communicating ${D}(${MC} messages)${R}"
else
  echo -e "\r  ${SPIN} Agents warming up...       "
fi

# ─── Output ───
echo ""
# Build dynamic agent list for display
AGENT_NAMES=$(curl -sf "$API/api/ensemble/teams/$TEAM_ID" 2>/dev/null \
  | python3 -c "import json,sys; t=json.load(sys.stdin); print(' + '.join(a['name'] for a in t['team']['agents']))" 2>/dev/null \
  || echo "agents")
echo -e "  ${BD}${G}Team is live!${R} ${W}${AGENT_NAMES}${R} are collaborating."
echo ""
if [ "$MONITOR_MODE" = "split" ]; then
  echo -e "  ${D}┌─ Monitor (right panel) ───────────────┐${R}"
else
  echo -e "  ${D}┌─ Monitor ─────────────────────────────┐${R}"
  echo -e "  ${D}│${R}  ${D}tmux attach -t $MONITOR_SESSION${R}      ${D}│${R}"
fi
echo -e "  ${D}│${R}  ${W}s${R}     ${D}steer team${R}                     ${D}│${R}"
echo -e "  ${D}│${R}  ${W}1${R}/${W}2${R}   ${D}steer codex / claude${R}           ${D}│${R}"
echo -e "  ${D}│${R}  ${W}j${R}/${W}k${R}   ${D}scroll${R}                         ${D}│${R}"
echo -e "  ${D}│${R}  ${W}d${R}     ${D}disband team${R}                   ${D}│${R}"
echo -e "  ${D}│${R}  ${W}q${R}     ${D}quit monitor${R}                   ${D}│${R}"
echo -e "  ${D}└───────────────────────────────────────┘${R}"
echo ""
