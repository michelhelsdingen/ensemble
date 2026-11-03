#!/usr/bin/env bash
# collab-smoke.sh — Start a real team, exchange a message, break it down cleanly.
# Usage: collab-smoke.sh [--runs N] [--agents a,b] [--keep]
#
# One run proves the whole chain on this machine: preflight, spawn, readiness,
# prompt delivery, a message in both directions, disband, and no tmux session
# left behind. Repeat it; a chain that only works once is not fixed.
#
# Default line-up is glm (sendKeys) + grok (pasteFromFile) so both delivery
# paths are exercised, with agents that are cheap to run. The task is as small
# as a task can be: greet, read, answer in one line, done.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./collab-paths.sh
source "$SCRIPT_DIR/collab-paths.sh"

RUNS=1
AGENTS="${COLLAB_SMOKE_AGENTS:-glm,grok}"
KEEP=0
API="${ENSEMBLE_URL:-http://localhost:23000}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --runs) shift; RUNS="${1:-1}" ;;
    --agents) shift; AGENTS="${1:-}" ;;
    --keep) KEEP=1 ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 1 ;;
  esac
  shift
done
case "$RUNS" in ''|*[!0-9]*) printf 'needs a whole number of runs\n' >&2; exit 1 ;; esac

G='\033[92m'; RED='\033[91m'; YEL='\033[93m'; D='\033[2m'; BD='\033[1m'; R='\033[0m'
pass() { printf "    ${G}✓${R} %s\n" "$*"; }
fout() { printf "    ${RED}✗${R} %s\n" "$*"; }

TAAK='Dit is een rookproef, geen onderzoek. Stuur met team-say precies één korte groet aan je teamgenoot, lees met team-read of de ander iets heeft gestuurd, reageer daarop in één regel, en stuur daarna <<COLLAB_DONE>>. Lees geen bestanden, schrijf niets, en draai geen commandos.'

GESLAAGD=0
MISLUKT=0

for RUN in $(seq 1 "$RUNS"); do
  printf "\n  ${BD}rookproef %s/%s${R} ${D}(%s)${R}\n" "$RUN" "$RUNS" "$AGENTS"
  WERKMAP=$(mktemp -d "${TMPDIR:-/tmp}/collab-smoke-XXXXXX")
  UITVOER=$(mktemp "${TMPDIR:-/tmp}/collab-smoke-out-XXXXXX")
  RUN_OK=1

  COLLAB_MONITOR=none COLLAB_SKIP_POSTCHECK=1 \
    "$SCRIPT_DIR/collab-launch.sh" "$WERKMAP" "$TAAK" "$AGENTS" > "$UITVOER" 2>&1
  LAUNCH_EXIT=$?
  TEAM_ID=$(grep -o 'TEAM_ID=[0-9a-f-]*' "$UITVOER" | tail -1 | cut -d= -f2)

  if [ -z "$TEAM_ID" ]; then
    fout "geen team-id in de uitvoer van de launcher (exit $LAUNCH_EXIT)"
    sed 's/^/      /' "$UITVOER" | tail -15
    MISLUKT=$((MISLUKT + 1))
    rm -rf "$WERKMAP" "$UITVOER"
    continue
  fi

  if [ "$LAUNCH_EXIT" = "0" ]; then
    pass "team live (exit 0)"
  else
    fout "launcher exit $LAUNCH_EXIT"
    sed 's/^/      /' "$UITVOER" | tail -15
    RUN_OK=0
  fi

  # Heen en weer: elke agent die het team startte moet zelf iets hebben gezegd.
  BERICHTEN=$(curl -sf "$API/api/ensemble/teams/$TEAM_ID" 2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
team = data.get('team', {})
namen = {a['name'] for a in team.get('agents', []) if a.get('status') != 'replaced'}
sprekers = {m['from'] for m in data.get('messages', []) if m.get('from') in namen}
print(' '.join(sorted(namen - sprekers)) or 'ALLEMAAL')
" 2>/dev/null || echo "ONLEESBAAR")
  if [ "$BERICHTEN" = "ALLEMAAL" ]; then
    pass "elke agent heeft zelf een bericht gestuurd"
  else
    fout "geen bericht van: $BERICHTEN"
    RUN_OK=0
  fi

  TEAM_NAAM=$(curl -sf "$API/api/ensemble/teams/$TEAM_ID" 2>/dev/null \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['team']['name'])" 2>/dev/null || echo "")

  if curl -sf -X POST "$API/api/ensemble/teams/$TEAM_ID/disband" > /dev/null 2>&1; then
    pass "team opgeheven"
  else
    fout "disband mislukte"
    RUN_OK=0
  fi

  # Niets mag overblijven. Dit is de controle die vier dagen lang niemand deed.
  RESTANTEN=""
  if [ -n "$TEAM_NAAM" ]; then
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      RESTANTEN=$(tmux ls 2>/dev/null | cut -d: -f1 | grep "^${TEAM_NAAM}-" || true)
      [ -z "$RESTANTEN" ] && break
      sleep 1
    done
  fi
  if [ -z "$RESTANTEN" ]; then
    pass "geen tmux-sessie van dit team over"
  else
    fout "sessies blijven draaien: $(printf '%s' "$RESTANTEN" | tr '\n' ' ')"
    RUN_OK=0
  fi

  if [ "$RUN_OK" = "1" ]; then GESLAAGD=$((GESLAAGD + 1)); else MISLUKT=$((MISLUKT + 1)); fi
  if [ "$KEEP" = "1" ]; then
    printf "    ${D}uitvoer: %s, werkmap: %s${R}\n" "$UITVOER" "$WERKMAP"
  else
    rm -rf "$WERKMAP" "$UITVOER"
  fi
done

printf "\n  ${BD}Uitslag${R}  %s geslaagd, %s mislukt van %s\n\n" "$GESLAAGD" "$MISLUKT" "$RUNS"
[ "$MISLUKT" = "0" ]
