#!/usr/bin/env bash
# collab-postcheck.sh — Verify agents are healthy AFTER spawning.
#
# Run 30 seconds after collab-launch to detect early failures.
# Usage: collab-postcheck.sh <team-id> [wait-seconds]
#
# Exit codes:
#   0 — agents healthy (or messages already exchanged)
#   1 — team-id not found
#   2 — agent stuck in error state (kills team, prints diagnosis), of nul
#       berichten na de wachttijd (team blijft leven, roep collab-rescue.sh aan)

set -uo pipefail

TEAM_ID="${1:?Usage: collab-postcheck.sh <team-id> [wait-seconds]}"
WAIT="${2:-30}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=collab-paths.sh
. "$SCRIPT_DIR/collab-paths.sh"
RD="$(collab_runtime_dir "$TEAM_ID")"

R='\033[0m'; RED='\033[91m'; GRN='\033[92m'; YEL='\033[93m'; BD='\033[1m'

if [ ! -d "$RD" ]; then
  echo -e "${RED}✗${R} Team $TEAM_ID not found at $RD" >&2
  exit 1
fi

# Alleen de sessies van dit team. Eerder stond hier een tmux-scan op de vorm van
# de sessienaam, waardoor een fout in team A alle sessies van team B meenam.
if [ -f "$RD/sessions" ]; then
  SESSIONS=$(cat "$RD/sessions")
else
  echo -e "${YEL}!${R} Geen sessieregister voor $TEAM_ID (ouder team?), postcheck slaat over"
  exit 0
fi
if [ -z "$SESSIONS" ]; then
  echo -e "${YEL}!${R} Sessieregister is leeg, niets te controleren"
  exit 0
fi

echo -e "${BD}collab postcheck (waiting ${WAIT}s for agents to settle)${R}"
sleep "$WAIT"

ERRORS_FOUND=0
ERROR_LOG=""

for s in $SESSIONS; do
  PANE_OUT=$(tmux capture-pane -t "$s" -p 2>/dev/null || true)
  if [ -z "$PANE_OUT" ]; then continue; fi

  # Check for known fatal error patterns
  if echo "$PANE_OUT" | grep -qiE "Not logged in|Please run /login"; then
    ERRORS_FOUND=$((ERRORS_FOUND + 1))
    ERROR_LOG="$ERROR_LOG\n  $s: NOT LOGGED IN — claude session expired"
  fi

  if echo "$PANE_OUT" | grep -qiE "stream disconnected before completion|failed to lookup address"; then
    ERRORS_FOUND=$((ERRORS_FOUND + 1))
    ERROR_LOG="$ERROR_LOG\n  $s: NETWORK/DNS FAILURE — codex couldn't reach API"
  fi

  if echo "$PANE_OUT" | grep -qiE "401 Unauthorized|authentication required|invalid api key"; then
    ERRORS_FOUND=$((ERRORS_FOUND + 1))
    ERROR_LOG="$ERROR_LOG\n  $s: AUTH FAILURE — invalid credentials"
  fi
done

# Check each spawned agent independently. The session register stores names
# prefixed with the team name; prompt filenames and message senders use the
# agent's short name.
MSG_COUNT=0
if [ -f "$RD/messages.jsonl" ]; then
  MSG_COUNT=$(wc -l < "$RD/messages.jsonl" | tr -d ' ')
fi
SILENT_AGENTS=$(python3 - "$RD/sessions" "$RD/prompts" "$RD/messages.jsonl" <<'PY'
import glob
import json
import os
import sys

sessions_path, prompts_dir, messages_path = sys.argv[1:]
agent_names = [os.path.basename(name)[:-4] for name in glob.glob(os.path.join(prompts_dir, '*.txt'))]
active = set()
try:
    with open(messages_path, encoding='utf-8') as source:
        for line in source:
            try:
                sender = json.loads(line).get('from')
            except (json.JSONDecodeError, AttributeError):
                continue
            if isinstance(sender, str):
                active.add(sender)
except OSError:
    pass

with open(sessions_path, encoding='utf-8') as source:
    sessions = [line.strip() for line in source if line.strip()]
for session in sessions:
    matches = [name for name in agent_names if session.endswith('-' + name)]
    if not matches:
        print(session)
        continue
    agent_name = max(matches, key=len)
    if agent_name not in active:
        print(agent_name)
PY
)

if [ "$ERRORS_FOUND" -gt 0 ]; then
  echo -e "${RED}✗ Postcheck FAILED — $ERRORS_FOUND agent(s) in error state${R}" >&2
  echo -e "$ERROR_LOG" >&2
  echo -e "\n${YEL}Disbanding team $TEAM_ID...${R}" >&2
  for s in $SESSIONS; do tmux kill-session -t "$s" 2>/dev/null || true; done
  [ -f "$RD/bridge.pid" ] && kill "$(cat $RD/bridge.pid)" 2>/dev/null || true
  [ -f "$RD/poller.pid" ] && kill "$(cat $RD/poller.pid)" 2>/dev/null || true
  echo -e "${YEL}Suggested fix:${R}" >&2
  echo "  pkill -f 'tsx server.ts' && cd ~/Documents/ensemble && nohup ./node_modules/.bin/tsx server.ts > /tmp/ensemble-server.log 2>&1 &" >&2
  echo "  Then re-run /collab" >&2
  exit 2
fi

if [ -n "$SILENT_AGENTS" ]; then
  echo -e "${RED}✗${R} Geen bericht ontvangen van deze agent(s) na ${WAIT}s:" >&2
  while IFS= read -r agent; do [ -z "$agent" ] || echo "  - $agent" >&2; done <<< "$SILENT_AGENTS"
  echo -n "  Opnieuw afleveren: scripts/collab-rescue.sh $TEAM_ID" >&2
  while IFS= read -r agent; do [ -z "$agent" ] || printf ' %q' "$agent" >&2; done <<< "$SILENT_AGENTS"
  echo >&2
  exit 2
fi

echo -e "${GRN}✓${R} All registered agents sent a message; $MSG_COUNT messages exchanged"

exit 0
