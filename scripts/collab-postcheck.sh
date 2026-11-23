#!/usr/bin/env bash
# collab-postcheck.sh — Verify agents are healthy AFTER spawning.
#
# Run 30 seconds after collab-launch to detect early failures.
# Usage: collab-postcheck.sh <team-id> [wait-seconds]
#
# Exit codes:
#   0: agents healthy (or messages already exchanged), or the team is already
#       finished or disbanded (nothing left to check)
#   1 — team-id not found
#   2 — agent stuck in error state (kills team, prints diagnosis), of nul
#       berichten na de wachttijd (team blijft leven, roep collab-rescue.sh aan)

set -uo pipefail

TEAM_ID="${1:?Usage: collab-postcheck.sh <team-id> [wait-seconds]}"
WAIT="${2:-30}"
API="${ENSEMBLE_URL:-http://localhost:23000}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=collab-paths.sh
. "$SCRIPT_DIR/collab-paths.sh"
RD="$(collab_runtime_dir "$TEAM_ID")"

R='\033[0m'; RED='\033[91m'; GRN='\033[92m'; YEL='\033[93m'; BD='\033[1m'

if [ ! -d "$RD" ]; then
  echo -e "${RED}✗${R} Team $TEAM_ID not found at $RD" >&2
  exit 1
fi

# Een team dat klaar of opgeheven is heeft geen postcheck nodig. Zonder deze
# controle adviseerde de postcheck een rescue voor een team dat al was afgerond
# (gemeten: de postcheck.log van een afgerond team noemde vijf agents "stil").
# .finished is het bewijs op schijf; de service is het bewijs voor een team dat
# is opgeheven zonder dat de marker er al staat.
team_is_over() {
  [ -f "$RD/.finished" ] && return 0
  local status
  status=$(curl -sf "$API/api/ensemble/teams/$TEAM_ID" 2>/dev/null | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    print((data.get('team', data) or {}).get('status', ''))
except Exception:
    pass
" 2>/dev/null || true)
  [ "$status" = "disbanded" ]
}
stop_when_over() {
  if team_is_over; then
    echo -e "${GRN}✓${R} Team $TEAM_ID is al afgerond of opgeheven; postcheck stopt, er is niets te redden"
    exit 0
  fi
}
stop_when_over

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
# Het team kan tijdens het wachten klaar zijn gekomen.
stop_when_over

ERRORS_FOUND=0
ERROR_LOG=""

# De prompt van dit team, om hem straks uit de pane-tekst te filteren. De
# taaktekst staat namelijk zelf in de pane: een collab OVER een inlogfout of een
# DNS-storing matchte op zijn eigen opdracht en maakte zijn team dood.
# Gevonden 03-11-2026 door het reviewteam.
PROMPT_TEKST=""
if [ -d "$RD/prompts" ]; then
  PROMPT_TEKST=$(cat "$RD/prompts/"*.txt 2>/dev/null || true)
fi

# Houd alleen de pane-regels over die niet uit de prompt komen. De prompt gaat
# als argument mee, niet via stdin: met een heredoc voor de python-code is stdin
# al bezet, en dan filtert dit niets (nagemeten).
nieuwe_uitvoer() {
  python3 -c '
import sys

pane, prompt = sys.argv[1], " ".join(sys.argv[2].split())
for regel in pane.splitlines():
    kern = " ".join(regel.split())
    if not kern:
        continue
    # Een regel die letterlijk in de prompt staat (ook afgebroken door de
    # pane-breedte) is onze eigen opdracht, geen uitvoer van de agent.
    if len(kern) > 8 and kern in prompt:
        continue
    print(regel)
' "$1" "$2"
}

for s in $SESSIONS; do
  PANE_RUW=$(tmux capture-pane -t "$s" -p 2>/dev/null || true)
  if [ -z "$PANE_RUW" ]; then continue; fi
  PANE_OUT=$(nieuwe_uitvoer "$PANE_RUW" "$PROMPT_TEKST")
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
        continue
    agent_name = max(matches, key=len)
    if agent_name not in active:
        print(agent_name)
PY
)

SESSIONS_WITHOUT_PROMPT=$(python3 - "$RD/sessions" "$RD/prompts" <<'PY'
import glob
import os
import sys

sessions_path, prompts_dir = sys.argv[1:]
agent_names = [os.path.basename(name)[:-4] for name in glob.glob(os.path.join(prompts_dir, '*.txt'))]
with open(sessions_path, encoding='utf-8') as source:
    sessions = [line.strip() for line in source if line.strip()]
for session in sessions:
    if not any(session.endswith('-' + name) for name in agent_names):
        print(session)
PY
)
while IFS= read -r session; do
  [ -z "$session" ] || echo "  sessie zonder promptbestand: $session"
done <<< "$SESSIONS_WITHOUT_PROMPT"

if [ "$ERRORS_FOUND" -gt 0 ]; then
  echo -e "${RED}✗ Postcheck FAILED — $ERRORS_FOUND agent(s) in error state${R}" >&2
  echo -e "$ERROR_LOG" >&2
  # Het team blijft staan. Tot 04-11-2026 hief de postcheck het hier zelf op,
  # en op 03-11 bleek waarom dat verkeerd is: hij grept het zichtbare scherm af,
  # en de geplakte taaktekst staat daar ook. Een collab OVER een inlogfout maakte
  # zo dertig seconden na een geslaagde start zijn eigen team dood. Zo'n melding
  # kan zich vergissen; een opruiming die zich vergist kost het werk van het team.
  # Dus: melden, de opdrachten erbij, en jij beslist.
  echo -e "\n${YEL}Het team blijft staan; alleen jij heft een team op.${R}" >&2
  echo "  Kijken:   tmux attach -t <sessie>" >&2
  echo "  Opheffen: curl -s -X POST $API/api/ensemble/teams/$TEAM_ID/disband" >&2
  echo -e "${YEL}Lijkt de service zelf stuk:${R}" >&2
  echo "  launchctl kickstart -k gui/\$(id -u) dev.ensemble.server" >&2
  exit 2
fi

# De service weet per agent of de prompt is aangekomen. Dat weegt zwaarder dan
# "heeft nog niets gezegd": gemeten 03-11-2026 (team ee1b35b0) riep de postcheck
# 30 seconden na de start dat glm-1 niets had gestuurd, terwijl die de prompt
# had aangenomen en twee minuten later zijn conclusie postte. Alleen als de
# service zegt dat de aflevering écht mislukte, of als ze niets weet, klagen we.
DELIVERY_STATE=$(curl -sf "$API/api/ensemble/teams/$TEAM_ID" 2>/dev/null | team_delivery_state)
case "$DELIVERY_STATE" in
  failed*)
    SILENT_AGENTS=$(printf '%s\n' ${DELIVERY_STATE#failed })
    ;;
  confirmed)
    SILENT_AGENTS=""
    ;;
  delivered*)
    STILLE="${DELIVERY_STATE#delivered }"
    SILENT_AGENTS=""
    echo -e "${GRN}✓${R} Prompt is bij alle agents aangekomen; $MSG_COUNT berichten tot nu toe"
    [ -n "$STILLE" ] && echo -e "  ${YEL}!${R} Nog geen bericht van: $STILLE — die denkt nog, dat is geen storing"
    exit 0
    ;;
esac

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
