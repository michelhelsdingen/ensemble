#!/usr/bin/env bash
# collab-launch.sh — All-in-one team launcher with clean output
# Usage: collab-launch.sh <working-dir> <task-description> [agents-csv] [template]
#
#   agents-csv  comma-separated agent keys from agents.json (first = lead).
#               Default: codex (lead) + claude code (worker).
#   template    key from collab-templates.json: review|implement|research|debug.
#               Also settable via COLLAB_TEMPLATE. Empty = generic lead/worker roles.
#
# Monitor selection (env vars):
#   COLLAB_MONITOR=auto     (default) iTerm split on macOS+iTerm2, else tmux session
#   COLLAB_MONITOR=iterm    force iTerm split
#   COLLAB_MONITOR=tmux     force a detached tmux session (old behavior)
#   COLLAB_MONITOR=none     no monitor at all
#   COLLAB_ITERM_MODE=split (default) | tab | window   how iTerm opens the monitor
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=./collab-paths.sh
source "$SCRIPT_DIR/collab-paths.sh"

CWD="${1:-.}"
TASK="${2:?Usage: collab-launch.sh <cwd> <task> [agents] [template]}"
# Optional: comma-separated agent names (e.g. "gemini,claude"). Falls back to
# COLLAB_AGENTS so a preferred line-up can be set once in the shell instead of
# being retyped every run; collab-preflight.sh already reads the same variable.
# Precedence: 3rd argument > COLLAB_AGENTS > the service default (codex+claude).
# Note this also disables the auto-fallback below, which is intended: naming
# your agents, by argument or by env, means a dead one is a hard failure.
AGENTS="${3:-${COLLAB_AGENTS:-}}"
# Optional collab template key from collab-templates.json (review|implement|research|debug).
# Assigns explicit roles to each agent instead of the generic lead/worker prompt.
TEMPLATE="${4:-${COLLAB_TEMPLATE:-}}"

# ─── Auto-fallback to codex-only when claude auth is dead (set by preflight) ───
# Preflight writes /tmp/collab-agents-override.txt when claude tmux-probe failed.
# Only kicks in if caller didn't specify AGENTS explicitly.
if [ -z "$AGENTS" ] && [ -f /tmp/collab-agents-override.txt ]; then
  AGENTS=$(cat /tmp/collab-agents-override.txt 2>/dev/null || echo "")
  if [ -n "$AGENTS" ]; then
    echo -e "  \033[93m!\033[0m Auto-fallback aktief: agents=$AGENTS (zie preflight)"
  fi
fi
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

# ─── 1b. Preflight checks (auth + DNS + service age) ───
# Skip with COLLAB_SKIP_PREFLIGHT=1 if needed.
# Pass the requested agents so preflight only checks the CLIs this run needs.
if [ "${COLLAB_SKIP_PREFLIGHT:-0}" != "1" ]; then
  if ! "$SCRIPT_DIR/collab-preflight.sh" "$AGENTS" 2>&1 | sed 's/^/  /'; then
    echo -e "\n  ${R}\033[91m✗${R} Preflight FAILED — fix above issues then re-run."
    echo -e "  ${D}(bypass with COLLAB_SKIP_PREFLIGHT=1, but agents will likely fail)${R}"
    exit 1
  fi
fi

# ─── 2. Create team (use env vars to avoid quoting hell) ───
TEAM_NAME="collab-$(python3 -c 'import random,time; print(str(time.time_ns()//1000000)+"-"+str(random.randint(1000,9999)))')"
PAYLOAD_FILE=$(mktemp)
TNAME="$TEAM_NAME" TDESC="$TASK" TCWD="$CWD" THOST="$HOST_ID" TAGENTS="$AGENTS" TTEMPLATE="$TEMPLATE" PFILE="$PAYLOAD_FILE" python3 -c "
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
payload = {
    'name': os.environ['TNAME'],
    'description': os.environ['TDESC'],
    'agents': agents,
    'feedMode': 'live',
    'workingDirectory': os.environ['TCWD']
}
template = os.environ.get('TTEMPLATE', '').strip()
if template:
    payload['templateName'] = template
json.dump(payload, open(os.environ['PFILE'], 'w'))
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
FEED_FILE="$(collab_feed_file "$TEAM_ID")"
TEAM_ID_FILE="$(collab_team_id_file "$TEAM_ID")"

mkdir -p "$RUNTIME_DIR" "$(dirname "$MESSAGES_FILE")" "$(dirname "$FEED_FILE")"
touch "$MESSAGES_FILE"
printf '%s\n' "$TEAM_ID" > "$TEAM_ID_FILE"
# Also write to a well-known location so callers can find the latest team ID.
# NOTE: this file is global and gets overwritten by concurrent launches. Callers
# that support parallel collabs should read the TEAM_ID=... line from stdout instead.
printf '%s\n' "$TEAM_ID" > /tmp/collab-team-id.txt
echo -e "  ${CHECK} Team created ${D}(${TEAM_NAME})${R}"
if [ -n "$TEMPLATE" ]; then
  echo -e "  ${CHECK} Template ${D}${TEMPLATE}${R}"
fi

# ─── 3. Bridge (writes its own PID file via single-instance guard) ───
nohup "$SCRIPT_DIR/ensemble-bridge.sh" "$TEAM_ID" "$API" >> "$BRIDGE_LOG_FILE" 2>&1 &
echo -e "  ${CHECK} Bridge started"

# ─── 4. Monitor ───
# Monitor selection order (override via COLLAB_MONITOR=herdr|tmux|iterm|none):
#   1. herdr pane   — if running inside a herdr workspace
#   2. tmux split   — if already inside a tmux session
#   3. iTerm split  — on macOS when iTerm2 is the active terminal (or forced)
#   4. tmux detached session — cross-platform fallback
#
# herdr comes first and must be checked before iTerm: herdr owns the terminal
# and draws its own panes inside a host iTerm session, but passes TERM_PROGRAM
# through unchanged. Trusting TERM_PROGRAM there opens a real iTerm split
# outside the layout the user is watching, so the monitor is never seen.
MONITOR_ENV_PREFIX=""
for KEY in ENSEMBLE_URL ENSEMBLE_DATA_DIR ENSEMBLE_PORT ENSEMBLE_HOST ENSEMBLE_CORS_ORIGIN ENSEMBLE_AGENTS_CONFIG ENSEMBLE_AGENT_FLAGS ENSEMBLE_HOST_ID; do
  VALUE="${!KEY:-}"
  if [ -n "$VALUE" ]; then
    MONITOR_ENV_PREFIX+="$KEY=$(printf '%q' "$VALUE") "
  fi
done
MONITOR_CMD="cd '$REPO_DIR' && ${MONITOR_ENV_PREFIX}node --import tsx cli/monitor.ts $TEAM_ID"
MONITOR_PREF="${COLLAB_MONITOR:-auto}"

use_herdr=false
if [ "$MONITOR_PREF" = "herdr" ]; then
  use_herdr=true
elif [ "$MONITOR_PREF" = "auto" ] && [ "${HERDR_ENV:-}" = "1" ] && command -v herdr > /dev/null 2>&1; then
  use_herdr=true
fi

use_iterm=false
if [ "$MONITOR_PREF" = "iterm" ]; then
  use_iterm=true
elif [ "$MONITOR_PREF" = "auto" ] && [ "$use_herdr" = false ] && [ -z "${TMUX:-}" ] \
     && [ "$(uname)" = "Darwin" ] && [ "${TERM_PROGRAM:-}" = "iTerm.app" ]; then
  use_iterm=true
fi

if [ "$MONITOR_PREF" = "none" ]; then
  echo -e "  ${CHECK} Monitor skipped ${D}(COLLAB_MONITOR=none)${R}"
  MONITOR_MODE="none"
elif [ "$use_herdr" = true ]; then
  HERDR_MODE="${COLLAB_HERDR_MODE:-split}"
  if HERDR_RESULT=$("$SCRIPT_DIR/open-herdr-monitor.sh" "$REPO_DIR" "$TEAM_ID" "$HERDR_MODE" 2>/tmp/ensemble-herdr.err); then
    echo -e "  ${CHECK} Monitor opened ${D}(herdr ${HERDR_MODE})${R}"
    MONITOR_MODE="herdr"
    HERDR_PANE=$(printf '%s\n' "$HERDR_RESULT" | sed -n 's/.*new_pane_id=\([^ ]*\).*/\1/p' | tail -1)
    if [ -n "$HERDR_PANE" ]; then
      printf '%s\n' "$HERDR_PANE" > "$RUNTIME_DIR/herdr-pane-id"
    fi
  else
    echo -e "  ${D}herdr launch failed: $(head -1 /tmp/ensemble-herdr.err 2>/dev/null)${R}"
    echo -e "  ${D}Falling back to tmux session...${R}"
    MONITOR_SESSION="ensemble-$TEAM_ID"
    tmux kill-session -t "$MONITOR_SESSION" 2>/dev/null || true
    tmux new-session -d -s "$MONITOR_SESSION" -c "$REPO_DIR" \
      "node --import tsx cli/monitor.ts $TEAM_ID"
    echo -e "  ${CHECK} Monitor ready ${D}(tmux attach -t $MONITOR_SESSION)${R}"
    MONITOR_MODE="session"
  fi
elif [ -n "${TMUX:-}" ] && [ "$MONITOR_PREF" != "iterm" ]; then
  tmux split-window -h -l '40%' "$MONITOR_CMD"
  echo -e "  ${CHECK} Monitor opened ${D}(right panel)${R}"
  MONITOR_MODE="split"
elif [ "$use_iterm" = true ]; then
  ITERM_MODE="${COLLAB_ITERM_MODE:-split}"
  # Forward ITERM_SESSION_ID so the split lands in the pane the user actually
  # invoked collab from, not the frontmost iTerm window.
  if ITERM_RESULT=$(ITERM_SESSION_ID="${ITERM_SESSION_ID:-}" "$SCRIPT_DIR/open-iterm-monitor.sh" "$REPO_DIR" "$TEAM_ID" "$ITERM_MODE" 2>/tmp/ensemble-iterm.err); then
    echo -e "  ${CHECK} Monitor opened ${D}(iTerm ${ITERM_MODE})${R}"
    MONITOR_MODE="iterm"
    # Persist the iTerm2 session id so monitor.ts can close its own pane on exit.
    ITERM_SESSION_ID=$(printf '%s\n' "$ITERM_RESULT" | sed -n 's/.*new_session_id=\([^ ]*\).*/\1/p' | tail -1)
    if [ -n "$ITERM_SESSION_ID" ]; then
      printf '%s\n' "$ITERM_SESSION_ID" > "$RUNTIME_DIR/iterm-session-id"
    fi
  else
    echo -e "  ${D}iTerm launch failed: $(head -1 /tmp/ensemble-iterm.err 2>/dev/null)${R}"
    echo -e "  ${D}Falling back to tmux session...${R}"
    MONITOR_SESSION="ensemble-$TEAM_ID"
    tmux kill-session -t "$MONITOR_SESSION" 2>/dev/null || true
    tmux new-session -d -s "$MONITOR_SESSION" -c "$REPO_DIR" \
      "node --import tsx cli/monitor.ts $TEAM_ID"
    echo -e "  ${CHECK} Monitor ready ${D}(tmux attach -t $MONITOR_SESSION)${R}"
    MONITOR_MODE="session"
  fi
else
  MONITOR_SESSION="ensemble-$TEAM_ID"
  tmux kill-session -t "$MONITOR_SESSION" 2>/dev/null || true
  tmux new-session -d -s "$MONITOR_SESSION" -c "$REPO_DIR" \
    "./node_modules/.bin/tsx cli/monitor.ts $TEAM_ID"
  echo -e "  ${CHECK} Monitor ready ${D}(tmux attach -t $MONITOR_SESSION)${R}"
  MONITOR_MODE="session"
fi

# ─── 5. Background poller (writes its own PID file, stops when the team is over) ───
nohup "$SCRIPT_DIR/collab-poller.sh" "$TEAM_ID" "$API" > /dev/null 2>&1 &

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

# ─── 6b. Postcheck (run in background after 30s — kills team if agents broken) ───
# Skip with COLLAB_SKIP_POSTCHECK=1
if [ "${COLLAB_SKIP_POSTCHECK:-0}" != "1" ]; then
  nohup bash -c "sleep 25 && '$SCRIPT_DIR/collab-postcheck.sh' '$TEAM_ID' 5" \
    > "$RUNTIME_DIR/postcheck.log" 2>&1 &
fi

# ─── Output ───
echo ""
# Build dynamic agent list for display
TEAM_JSON=$(curl -sf "$API/api/ensemble/teams/$TEAM_ID" 2>/dev/null || echo "")
AGENT_NAMES=$(printf '%s' "$TEAM_JSON" \
  | python3 -c "import json,sys; t=json.load(sys.stdin); print(' + '.join(a['name'] for a in t['team']['agents']))" 2>/dev/null \
  || echo "agents")
# Steer hint must follow the real roster: a hardcoded "1/2 codex / claude" is
# wrong for any team that is not the default pair (three agents, or grok).
STEER_KEYS=$(printf '%s' "$TEAM_JSON" \
  | python3 -c "import json,sys; n=len(json.load(sys.stdin)['team']['agents']); print('/'.join(str(i+1) for i in range(min(n,4))))" 2>/dev/null \
  || echo "1/2")
STEER_TEXT=$(printf '%s' "$TEAM_JSON" \
  | python3 -c "
import json,sys
names=[a['name'] for a in json.load(sys.stdin)['team']['agents']][:4]
text='steer ' + ' / '.join(names)
print(text if len(text) <= 31 else text[:30] + '…')
" 2>/dev/null || echo "steer agents")
echo -e "  ${BD}${G}Team is live!${R} ${W}${AGENT_NAMES}${R} are collaborating."
echo ""
if [ "$MONITOR_MODE" = "split" ]; then
  echo -e "  ${D}┌─ Monitor (right panel) ───────────────┐${R}"
elif [ "$MONITOR_MODE" = "herdr" ]; then
  echo -e "  ${D}┌─ Monitor (herdr pane) ────────────────┐${R}"
elif [ "$MONITOR_MODE" = "iterm" ]; then
  echo -e "  ${D}┌─ Monitor (iTerm native pane) ─────────┐${R}"
elif [ "$MONITOR_MODE" = "none" ]; then
  echo -e "  ${D}┌─ Monitor (skipped) ───────────────────┐${R}"
else
  echo -e "  ${D}┌─ Monitor ─────────────────────────────┐${R}"
  echo -e "  ${D}│${R}  ${D}tmux attach -t $MONITOR_SESSION${R}      ${D}│${R}"
fi
echo -e "  ${D}│${R}  ${W}s${R}     ${D}steer team${R}                     ${D}│${R}"
python3 - "$STEER_KEYS" "$STEER_TEXT" <<'PY'
import sys
keys, text = sys.argv[1], sys.argv[2]
# Box interior is 39 columns wide; keep the key column aligned with the rows above.
left = keys.ljust(5)
pad = ' ' * max(1, 39 - len(f"  {left} {text}"))
print(f"  \033[2m│\033[0m  \033[97m{left}\033[0m \033[2m{text}\033[0m{pad}\033[2m│\033[0m")
PY
echo -e "  ${D}│${R}  ${W}j${R}/${W}k${R}   ${D}scroll${R}                         ${D}│${R}"
echo -e "  ${D}│${R}  ${W}d${R}     ${D}disband team${R}                   ${D}│${R}"
echo -e "  ${D}│${R}  ${W}q${R}     ${D}quit monitor${R}                   ${D}│${R}"
echo -e "  ${D}└───────────────────────────────────────┘${R}"
echo ""
# Machine-readable trailer, safe to grep even when multiple collabs run in parallel.
echo "TEAM_ID=$TEAM_ID"
