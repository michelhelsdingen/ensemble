#!/usr/bin/env bash
# collab-smoke.sh — Start a real team, exchange a message, break it down cleanly.
# Usage: collab-smoke.sh [--runs N] [--agents a,b] [--monitor mode] [--keep]
#
# One run proves the whole chain on this machine: preflight, spawn, readiness,
# prompt delivery, a message in both directions, disband, and no tmux session
# left behind, the monitor's own session included. Repeat it; a chain that only
# works once is not fixed.
#
# Default line-up is glm (sendKeys) + grok (pasteFromFile) so both delivery
# paths are exercised, with agents that are cheap to run. --agents "" leaves the
# choice to the configured plan, which is the path a real launch takes. The task
# is as small as a task can be: greet, read, answer in one line, done.
#
# --monitor takes what COLLAB_MONITOR takes (none, tmux, iterm, herdr, orca).
# Default none; use tmux to prove the monitor session is cleaned up too.
# --template takes a key from collab-templates.json (review, implement,
# research, debug), the path the 03-11 failure went down.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=./collab-paths.sh
source "$SCRIPT_DIR/collab-paths.sh"

RUNS=1
AGENTS="${COLLAB_SMOKE_AGENTS:-glm,grok}"
AGENTS_GEZET=0
MONITOR="${COLLAB_SMOKE_MONITOR:-none}"
TEMPLATE="${COLLAB_SMOKE_TEMPLATE:-}"
KEEP=0
API="${ENSEMBLE_URL:-http://localhost:23000}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --runs) shift; RUNS="${1:-1}" ;;
    --agents) shift; AGENTS="${1:-}"; AGENTS_GEZET=1 ;;
    --monitor) shift; MONITOR="${1:-none}" ;;
    --template) shift; TEMPLATE="${1:-}" ;;
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
# Startduur per run, voor de slotregel. Snelheid hoort bij de proef: gemeten
# 03-11-2026 duurde een start 18 seconden plus een wachtlus van 120.
LIVE_TIJDEN=""
SPREEK_TIJDEN=""
nu_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }

team_cleanup_residuals() {
  local team_name="$1" team_id="$2" runtime_dir="$3" repo_dir="$4"
  local residuals="" sessions="" name pid worktrees="" short_id

  sessions=$(tmux ls 2>/dev/null | cut -d: -f1 \
    | grep -E "^(${team_name}-|ensemble-${team_id}\$)" || true)
  if [ -n "$sessions" ]; then
    residuals="tmux-sessies: $(printf '%s' "$sessions" | tr '\n' ' ')"
  fi

  for name in bridge poller; do
    [ -f "$runtime_dir/$name.pid" ] || continue
    pid=$(cat "$runtime_dir/$name.pid" 2>/dev/null || true)
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    if kill -0 "$pid" 2>/dev/null; then
      [ -z "$residuals" ] || residuals+=$'\n'
      residuals+="$name-proces draait (pid $pid)"
    fi
  done

  short_id="${team_id:0:8}"
  while IFS= read -r name; do
    case "$name" in
      "branch refs/heads/collab/$team_id/"*|"branch refs/heads/ensemble/$short_id")
        [ -z "$worktrees" ] || worktrees+=$'\n'
        worktrees+="${name#branch refs/heads/}"
        ;;
    esac
  done < <(git -C "$repo_dir" worktree list --porcelain 2>/dev/null | awk '$1 == "branch"')
  if [ -n "$worktrees" ]; then
    [ -z "$residuals" ] || residuals+=$'\n'
    residuals+="git-worktrees: $(printf '%s' "$worktrees" | tr '\n' ' ')"
  fi

  if [ -n "$residuals" ]; then
    printf '%s\n' "$residuals"
    return 1
  fi
  return 0
}

for RUN in $(seq 1 "$RUNS"); do
  printf "\n  ${BD}rookproef %s/%s${R} ${D}(%s, monitor %s, sjabloon %s)${R}\n" \
    "$RUN" "$RUNS" "${AGENTS:-plan kiest}" "$MONITOR" "${TEMPLATE:-geen}"
  WERKMAP=$(mktemp -d "${TMPDIR:-/tmp}/collab-smoke-XXXXXX")
  UITVOER=$(mktemp "${TMPDIR:-/tmp}/collab-smoke-out-XXXXXX")
  RUN_OK=1

  # Postcheck blijft gearmeerd: de proef moet het pad lopen dat een echt team
  # loopt. Nagekeken op 03-11-2026 dat hij een langzamer startend team niet
  # doodt: hij grijpt alleen in bij fatale paneteksten (niet ingelogd, DNS,
  # 401) en adviseert bij stilte alleen een rescue.
  BEGIN_MS=$(nu_ms)
  COLLAB_MONITOR="$MONITOR" \
    "$SCRIPT_DIR/collab-launch.sh" "$WERKMAP" "$TAAK" "$AGENTS" "$TEMPLATE" > "$UITVOER" 2>&1
  LAUNCH_EXIT=$?
  LIVE_MS=$(( $(nu_ms) - BEGIN_MS ))
  TEAM_ID=$(grep -o 'TEAM_ID=[0-9a-f-]*' "$UITVOER" | tail -1 | cut -d= -f2)

  if [ -z "$TEAM_ID" ]; then
    fout "geen team-id in de uitvoer van de launcher (exit $LAUNCH_EXIT)"
    sed 's/^/      /' "$UITVOER" | tail -15
    MISLUKT=$((MISLUKT + 1))
    rm -rf "$WERKMAP" "$UITVOER"
    continue
  fi

  if [ "$LAUNCH_EXIT" = "0" ]; then
    pass "team live (exit 0) in $(python3 -c "print(f'{$LIVE_MS/1000:.1f}')")s"
    LIVE_TIJDEN="$LIVE_TIJDEN $LIVE_MS"
  else
    fout "launcher exit $LAUNCH_EXIT"
    sed 's/^/      /' "$UITVOER" | tail -15
    RUN_OK=0
  fi

  # Heen en weer: elke agent die het team startte moet zelf iets hebben gezegd.
  # De launcher keert sinds 03-11-2026 terug zodra de prompt is aangekomen, dus
  # hier wachten we op het eerste bericht van elke agent. Dat is denktijd van
  # het model, geen starttijd van ensemble, en wordt apart gemeld.
  SPREEK_GRENS="${COLLAB_SMOKE_SPREEK_SECS:-150}"
  for _ in $(seq 1 "$SPREEK_GRENS"); do
    STIL=$(curl -sf "$API/api/ensemble/teams/$TEAM_ID" 2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
team = data.get('team', {})
namen = {a['name'] for a in team.get('agents', []) if a.get('status') != 'replaced'}
sprekers = {m['from'] for m in data.get('messages', []) if m.get('from') in namen}
print(' '.join(sorted(namen - sprekers)) or 'ALLEMAAL')
" 2>/dev/null || echo "ONLEESBAAR")
    [ "$STIL" = "ALLEMAAL" ] && break
    sleep 1
  done
  SPREEK_MS=$(( $(nu_ms) - BEGIN_MS ))
  BERICHTEN=$(curl -sf "$API/api/ensemble/teams/$TEAM_ID" 2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
team = data.get('team', {})
namen = {a['name'] for a in team.get('agents', []) if a.get('status') != 'replaced'}
sprekers = {m['from'] for m in data.get('messages', []) if m.get('from') in namen}
print(' '.join(sorted(namen - sprekers)) or 'ALLEMAAL')
" 2>/dev/null || echo "ONLEESBAAR")
  if [ "$BERICHTEN" = "ALLEMAAL" ]; then
    pass "elke agent heeft zelf een bericht gestuurd, na $(python3 -c "print(f'{$SPREEK_MS/1000:.1f}')")s"
    SPREEK_TIJDEN="$SPREEK_TIJDEN $SPREEK_MS"
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
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    RESTANTEN=$(team_cleanup_residuals "${TEAM_NAAM:-__geen__}" "$TEAM_ID" \
      "$(collab_runtime_dir "$TEAM_ID")" "$REPO_DIR" || true)
    [ -z "$RESTANTEN" ] && break
    sleep 1
  done
  if [ -z "$RESTANTEN" ]; then
    pass "geen tmux-sessie, bridge of poller van dit team over, en geen git-worktree"
  else
    fout "resten na disband: $(printf '%s' "$RESTANTEN" | tr '\n' ' ')"
    RUN_OK=0
  fi

  if [ "$RUN_OK" = "1" ]; then GESLAAGD=$((GESLAAGD + 1)); else MISLUKT=$((MISLUKT + 1)); fi
  if [ "$KEEP" = "1" ]; then
    printf "    ${D}uitvoer: %s, werkmap: %s${R}\n" "$UITVOER" "$WERKMAP"
  else
    rm -rf "$WERKMAP" "$UITVOER"
  fi
done

printf "\n  ${BD}Uitslag${R}  %s geslaagd, %s mislukt van %s\n" "$GESLAAGD" "$MISLUKT" "$RUNS"
samenvat() {
  [ -n "$2" ] || return 0
  python3 -c "
import sys
label = sys.argv[1]
waarden = [int(v) / 1000 for v in sys.argv[2:]]
print(f'  {label}: snelst {min(waarden):.1f}s, traagst {max(waarden):.1f}s, gemiddeld {sum(waarden) / len(waarden):.1f}s')
" "$1" $2
}
samenvat "team live" "$LIVE_TIJDEN"
samenvat "iedereen aan het woord" "$SPREEK_TIJDEN"
printf "\n"
[ "$MISLUKT" = "0" ]
