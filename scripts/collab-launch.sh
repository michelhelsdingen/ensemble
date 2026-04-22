#!/usr/bin/env bash
# collab-launch.sh — All-in-one team launcher with clean output
# Usage: collab-launch.sh <working-dir> <task-description>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=./collab-paths.sh
source "$SCRIPT_DIR/collab-paths.sh"

CWD="${1:-.}"
TASK="${2:?Usage: collab-launch.sh <cwd> <task>}"

# Smart CWD: if the task mentions a known project path, use that as CWD
# so agents start in the right directory with correct sandbox access.
if [ "$CWD" = "." ] || echo "$CWD" | grep -q "tools/ensemble"; then
  for candidate in \
    "$HOME/.openclaw/workspace/skills/crypto-trading-platform" \
    "$HOME/projects/brainai-dashboard" \
    "$HOME/.openclaw/workspace"; do
    if echo "$TASK" | grep -qi "$(basename "$candidate")" && [ -d "$candidate" ]; then
      CWD="$candidate"
      break
    fi
  done
fi
# Resolve to absolute path
CWD="$(cd "$CWD" 2>/dev/null && pwd || echo "$CWD")"
AGENTS="${3:-}"  # Optional: comma-separated agent names (e.g. "gemini,claude")
TARGET_PANE="${4:-}"  # Optional: tmux pane ID for monitor split
TEMPLATE_OVERRIDE="${5:-${COLLAB_TEMPLATE:-}}"  # Optional: explicit template name (else auto-detect)
API="http://localhost:23000"
HOST_ID="${ENSEMBLE_HOST_ID:-local}"

# ─── Template auto-detection (fixes dead expert-injection code path) ───
# Previously: no template was ever passed → buildPromptPreview fell through to
# default LEAD/WORKER instructions → expert mental-models in collab-templates.json
# (25 `expert` tags, 7 templates) NEVER loaded. 0/24 historical prompts had
# EXPERT MENTAL MODEL. Now: keyword match on task description selects template,
# user can override via env COLLAB_TEMPLATE or 5th positional arg.
detect_template() {
  local task_lower
  task_lower=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  if [ -n "$TEMPLATE_OVERRIDE" ]; then
    printf '%s' "$TEMPLATE_OVERRIDE"; return
  fi
  # Priority order — more specific first
  if echo "$task_lower" | grep -qE '\b(ultrareview|ultra.review|4.agent.review|security.review)\b'; then
    printf 'ultrareview'; return
  fi
  if echo "$task_lower" | grep -qE '\b(premium.quad|premium quad|critical|live.trading|production.deploy)\b'; then
    printf 'premium-quad'; return
  fi
  if echo "$task_lower" | grep -qE '\b(adversarial|red.team|red team|stress.test)\b'; then
    printf 'adversarial'; return
  fi
  if echo "$task_lower" | grep -qE '\b(crypto.strategy|trading.strategy|backtest|paper.trading|backtesting)\b'; then
    printf 'crypto-strategy'; return
  fi
  if echo "$task_lower" | grep -qE '\b(deep.research|deep.dive|research|raziskava|investigate|forensic|analyze|audit)\b'; then
    printf 'deep-research'; return
  fi
  if echo "$task_lower" | grep -qE '\b(debug|bug|fix|troubleshoot|error|crash|broken|popravi)\b'; then
    printf 'debug'; return
  fi
  if echo "$task_lower" | grep -qE '\b(implement|build|develop|naredi|code|create.*feature|add.*endpoint)\b'; then
    printf 'implement'; return
  fi
  # No template → agents still get sensible LEAD/WORKER defaults (no expert)
  printf ''
}
TEMPLATE_NAME="$(detect_template "$TASK")"

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

# ─── 1b. Background cleanup of stale runtime dirs (>24h old) ───
"$SCRIPT_DIR/collab-cleanup.sh" --force > /dev/null 2>&1 &

# ─── 1c. Check for resumable active team on same CWD ───
# Fetch id AND name: tmux sessions are named ${team.name}-${agent.name}, never
# the UUID. Matching on team.id wrongly reports SESSIONS_ALIVE=0 and kills
# live collabs.
ACTIVE_INFO=$(curl -sf "$API/api/ensemble/teams" 2>/dev/null | python3 -c "
import json, sys, os
cwd = os.path.realpath('$CWD')
teams = json.load(sys.stdin).get('teams', [])
active = [t for t in teams if t.get('status') == 'active' and t.get('workingDirectory') == cwd]
if active:
    active.sort(key=lambda t: t.get('createdAt', ''), reverse=True)
    print(active[0]['id'] + '\t' + active[0].get('name', ''))
" 2>/dev/null || true)
ACTIVE_TEAM="${ACTIVE_INFO%%$'\t'*}"
ACTIVE_NAME=""
[ "$ACTIVE_INFO" != "$ACTIVE_TEAM" ] && ACTIVE_NAME="${ACTIVE_INFO#*$'\t'}"

if [ -n "$ACTIVE_TEAM" ]; then
  SESSIONS_ALIVE=0
  if [ -n "$ACTIVE_NAME" ]; then
    SESSIONS_ALIVE=$(tmux list-sessions -F '#{session_name}' 2>/dev/null \
      | awk -v n="$ACTIVE_NAME" '$0 ~ "^"n"-" {c++} END {print c+0}')
  fi
  if [ "${SESSIONS_ALIVE:-0}" -gt 0 ]; then
    echo -e "  ${C}●${R} Active team found on same directory — resuming..."
    exec "$SCRIPT_DIR/collab-resume.sh" "$ACTIVE_TEAM"
  else
    echo -e "  ${C}●${R} Orphaned team $ACTIVE_TEAM (no live sessions) — disbanding and creating fresh..."
    curl -sf -X DELETE "$API/api/ensemble/teams/$ACTIVE_TEAM" > /dev/null 2>&1 || true
  fi
fi

# ─── 2. Create team (use env vars to avoid quoting hell) ───
TEAM_NAME="collab-$(python3 -c 'import random,time; print(str(time.time_ns()//1000000)+"-"+str(random.randint(1000,9999)))')"
PAYLOAD_FILE=$(mktemp)
TNAME="$TEAM_NAME" TDESC="$TASK" TCWD="$CWD" THOST="$HOST_ID" TAGENTS="$AGENTS" TTEMPLATE="$TEMPLATE_NAME" PFILE="$PAYLOAD_FILE" python3 -c "
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
import re
desc = os.environ['TDESC'].lower()
staged_patterns = [
    r'\bimplement\b', r'\bdevelop\b', r'\bbuild\b', r'\bnaredi\b',
    r'\bplan\b', r'\barhitektur', r'\bdesign\b', r'\bstress.?test\b',
    r'\badversarial\b', r'\bimplement.*(?:and|in)\s+(?:test|review)\b',
]
staged = any(re.search(p, desc) for p in staged_patterns)
payload = {
    'name': os.environ['TNAME'],
    'description': os.environ['TDESC'],
    'agents': agents,
    'feedMode': 'live',
    'workingDirectory': os.environ['TCWD'],
}
if staged:
    payload['staged'] = True
# Fix: pass templateName so ensemble-service::buildPromptPreview actually
# loads the template and injects expert mental models into agent prompts.
tmpl = os.environ.get('TTEMPLATE', '').strip()
if tmpl:
    payload['templateName'] = tmpl
json.dump(payload, open(os.environ['PFILE'], 'w'))
"
[ -n "$TEMPLATE_NAME" ] && echo -e "  ${D}Template: ${TEMPLATE_NAME}${R}"
# Capture status separately so a 409 CAS conflict (someone else created the
# team for this cwd between step 1c and here) becomes a clean resume, not a
# pipefail exit. The API response shape on 409 is { team: existingTeam, ... }.
RESP_FILE=$(mktemp)
HTTP_CODE=$(curl -sS -o "$RESP_FILE" -w '%{http_code}' -X POST "$API/api/ensemble/teams" \
  -H "Content-Type: application/json" \
  -d @"$PAYLOAD_FILE" || echo "000")
rm -f "$PAYLOAD_FILE"
if [ "$HTTP_CODE" = "409" ]; then
  EXIST_ID=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['team']['id'])" "$RESP_FILE" 2>/dev/null || true)
  rm -f "$RESP_FILE"
  if [ -n "$EXIST_ID" ]; then
    echo -e "  ${C}●${R} Concurrent launch claimed this cwd — resuming $EXIST_ID"
    exec "$SCRIPT_DIR/collab-resume.sh" "$EXIST_ID"
  fi
  echo -e "  \033[91m✗${R} 409 conflict without existingTeam in body"; exit 1
fi
if [ "$HTTP_CODE" != "201" ] && [ "$HTTP_CODE" != "200" ]; then
  echo -e "  \033[91m✗${R} Team creation failed: HTTP $HTTP_CODE"
  head -c 400 "$RESP_FILE" 2>/dev/null; echo
  rm -f "$RESP_FILE"; exit 1
fi
RESULT=$(cat "$RESP_FILE")
rm -f "$RESP_FILE"

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

# ─── State machine marker (observable lifecycle) ───
# Writers move through creating → active → finishing → finished → cleaned.
# Readers query state without piecing together PID tables.
# Atomic write so a reader catching mid-write never sees a truncated value.
STATE_FILE="$RUNTIME_DIR/.state"
write_state() {
  local new_state="$1"
  local tmp
  tmp=$(mktemp "${STATE_FILE}.XXXXXX")
  printf '%s\n' "$new_state" > "$tmp"
  mv -f "$tmp" "$STATE_FILE"
}
write_state "creating"

# ─── Shared latest-team-id: per-launcher-PID file (zero race) + global fallback ───
# Parent that invoked this script as a subprocess should read /tmp/collab-team-$PPID.txt
# to get its OWN team-id, not a concurrent launch's. Global /tmp/collab-team-id.txt
# kept for backward compat but atomically written.
PARENT_PID="${PPID:-0}"
PER_PARENT_FILE="/tmp/collab-team-${PARENT_PID}.txt"
printf '%s\n' "$TEAM_ID" > "$PER_PARENT_FILE"
LATEST_TMP=$(mktemp /tmp/collab-team-id.XXXXXX)
printf '%s\n' "$TEAM_ID" > "$LATEST_TMP"
mv -f "$LATEST_TMP" /tmp/collab-team-id.txt
echo -e "  ${CHECK} Team created ${D}(${TEAM_NAME})${R}"

# ─── 3. Bridge (writes its own PID file via single-instance guard) ───
# Use setsid so bridge-supervisor runs in its own process group. One signal
# (kill -TERM -- -$PGID) then cleanly nukes the entire helper subtree —
# supervisor, bridge child, any grandchildren. No more orphan procs surviving
# a parent exit.
if command -v setsid >/dev/null 2>&1; then
  setsid nohup "$SCRIPT_DIR/ensemble-bridge-supervisor.sh" "$TEAM_ID" "$API" >> "$BRIDGE_LOG_FILE" 2>&1 &
else
  nohup "$SCRIPT_DIR/ensemble-bridge-supervisor.sh" "$TEAM_ID" "$API" >> "$BRIDGE_LOG_FILE" 2>&1 &
fi
# macOS ps reports PGID in column 7 when we ask for it via -o pgid
SUPERVISOR_PID=$!
printf '%s\n' "$SUPERVISOR_PID" > "$RUNTIME_DIR/supervisor.pid"
SUPERVISOR_PGID=$(ps -p "$SUPERVISOR_PID" -o pgid= 2>/dev/null | tr -d ' ')
[ -n "$SUPERVISOR_PGID" ] && printf '%s\n' "$SUPERVISOR_PGID" > "$RUNTIME_DIR/.pgid"
echo -e "  ${CHECK} Bridge started"

# ─── 4. Monitor ───
MONITOR_CMD="cd '$REPO_DIR' && ./node_modules/.bin/tsx cli/monitor.ts $TEAM_ID"
if [ -n "${TMUX:-}" ]; then
  SPAWN_PANE="${TARGET_PANE:-$(tmux display-message -p '#{pane_id}' 2>/dev/null || echo "")}"
  if [ -n "$SPAWN_PANE" ]; then
    tmux split-window -h -t "$SPAWN_PANE" -l '40%' "$MONITOR_CMD"
  else
    tmux split-window -h -l '40%' "$MONITOR_CMD"
  fi
  echo -e "  ${CHECK} Monitor opened ${D}(right panel)${R}"
  MONITOR_MODE="split"
else
  MONITOR_SESSION="ensemble-$TEAM_ID"
  tmux kill-session -t "$MONITOR_SESSION" 2>/dev/null || true
  tmux new-session -d -s "$MONITOR_SESSION" -c "$REPO_DIR" \
    "./node_modules/.bin/tsx cli/monitor.ts $TEAM_ID"
  echo -e "  ${CHECK} Monitor ready ${D}(tmux attach -t $MONITOR_SESSION)${R}"
  MONITOR_MODE="session"
fi

# ─── 5. Background poller (self-exits on .finished marker) ───
FINISHED_MARKER="$RUNTIME_DIR/.finished"
nohup bash -c '
TID="'"$TEAM_ID"'"
MESSAGES_FILE="'"$MESSAGES_FILE"'"
FEED_FILE="'"$FEED_FILE"'"
FINISHED="'"$FINISHED_MARKER"'"
S=0
while true; do
  # Auto-exit once ensemble-service writes the finish marker — prevents
  # zombie tail-feed loops (47 observed in pre-fix forensics).
  [ -f "$FINISHED" ] && exit 0
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
  write_state "active"
else
  echo -e "\r  ${SPIN} Agents warming up...       "
  write_state "active"
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
