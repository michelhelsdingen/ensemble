#!/usr/bin/env bash
# collab-orphans.sh — Stop tmux sessions left behind by teams that are over.
# Usage: collab-orphans.sh [--force] [--min-age-minutes N]
#
# collab-cleanup.sh removes runtime directories and never touches tmux, so a
# team whose sessions outlived it kept them for good. Measured 03-11-2026:
# collab-1793370919814-7089-mimo-5 had been running since 30 October and
# collab-1793655026254-9985-agy-3 since 2 November, both long past their teams.
#
# A session counts as orphaned when its name starts with a team prefix
# ('collab-<timestamp>-<random>-') or is a monitor ('ensemble-<team-id>'), and
# no team in the register is still forming or active for it. Sessions younger
# than the age threshold are spared: a team that is being created right now is
# not in the register yet.
#
# Without --force this only prints what it would do. If the register cannot be
# read, nothing is removed and the exit code is 2: without it there is no way
# to tell a live team from a dead one.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

API="${ENSEMBLE_URL:-http://localhost:23000}"
MODE="dry-run"
MIN_AGE_MINUTES="${COLLAB_ORPHAN_MIN_AGE_MINUTES:-60}"

R='\033[0m'; RED='\033[91m'; GRN='\033[92m'; YEL='\033[93m'; D='\033[2m'; W='\033[97m'; BD='\033[1m'

usage() {
  cat <<'EOF'
Usage: collab-orphans.sh [--force] [--min-age-minutes N]

  --force              Kill the orphaned sessions instead of listing them.
  --min-age-minutes N  Spare sessions younger than N minutes (default 60).
  -h, --help           Show this help text.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --force) MODE="force" ;;
    --min-age-minutes)
      shift
      MIN_AGE_MINUTES="${1:-}"
      case "$MIN_AGE_MINUTES" in
        ''|*[!0-9]*) printf '%s\n' "--min-age-minutes needs a whole number of minutes" >&2; exit 1 ;;
      esac
      ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n\n' "$1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

echo ""
echo -e "  ${BD}${W}◈ collab orphans${R}"
echo -e "  ${D}mode: ${MODE} | spares sessions younger than ${MIN_AGE_MINUTES}m${R}"
echo ""

SESSIONS=""
HAS_TMUX=false
if command -v tmux > /dev/null 2>&1; then
  HAS_TMUX=true
  SESSIONS=$(tmux list-sessions -F $'#{session_name}\t#{session_created}' 2>/dev/null || true)
fi
ROOT="${COLLAB_RUNTIME_ROOT:-/tmp/ensemble}"
HAS_WEBFEED=false
if [ -d "$ROOT" ]; then
  for RD in "$ROOT"/*; do
    if [ -f "$RD/webfeed-page-id" ] || [ -f "$RD/webfeed.pid" ]; then
      HAS_WEBFEED=true
      break
    fi
  done
fi
if [ -z "$SESSIONS" ] && [ "$HAS_WEBFEED" = false ]; then
  if [ "$HAS_TMUX" = false ]; then
    echo -e "  ${YEL}tmux niet gevonden, niets te doen${R}"
  else
    echo -e "  ${GRN}Geen tmux-sessies${R}"
  fi
  exit 0
fi

# The register decides which teams are still alive. No register, no removal.
TEAMS_JSON=$(curl -sf "$API/api/ensemble/teams" 2>/dev/null || true)
LIVE=$(printf '%s' "$TEAMS_JSON" | python3 -c "
import json, sys
try:
    teams = json.load(sys.stdin).get('teams', [])
except Exception:
    sys.exit(3)
for team in teams:
    if not isinstance(team, dict):
        continue
    if team.get('status') in ('forming', 'active'):
        print(team.get('name', ''))
        print(team.get('id', ''))
" 2>/dev/null) || LIVE="__ONLEESBAAR__"

if [ "$LIVE" = "__ONLEESBAAR__" ]; then
  echo -e "  ${RED}✗${R} Het teamregister op $API is onbereikbaar of onleesbaar."
  echo -e "  ${D}Zonder register is een levend team niet van een dood te onderscheiden, dus er wordt niets opgeruimd.${R}"
  echo ""
  exit 2
fi

LIVE_NAMES=""
LIVE_IDS=""
while IFS= read -r naam && IFS= read -r id; do
  [ -n "$naam" ] && LIVE_NAMES="$LIVE_NAMES $naam"
  [ -n "$id" ] && LIVE_IDS="$LIVE_IDS $id"
done <<< "$LIVE"

NOW=$(date +%s)
MIN_AGE_SECONDS=$((MIN_AGE_MINUTES * 60))
ORPHANS=0
KILLED=0
SPARED=0

# Browser feeds of teams that are over are eligible after the same age threshold:
# finished teams (age of .finished) and teams without .finished that are no longer
# in the register (age of the feed's own pid or page-id file). The second kind is
# a start that failed or a team that was lost: its feed server otherwise ran until
# the hard time limit.
if [ -d "$ROOT" ]; then
  for RD in "$ROOT"/*; do
    [ -d "$RD" ] || continue
    [ -f "$RD/webfeed-page-id" ] || [ -f "$RD/webfeed.pid" ] || continue
    ID="$(basename "$RD")"
    case " $LIVE_IDS " in *" $ID "*) continue ;; esac
    if [ -f "$RD/.finished" ]; then
      MARKER="$RD/.finished"
    elif [ -f "$RD/webfeed.pid" ]; then
      MARKER="$RD/webfeed.pid"
    else
      MARKER="$RD/webfeed-page-id"
    fi
    if stat -f '%m' "$MARKER" >/dev/null 2>&1; then
      FINISHED_TS="$(stat -f '%m' "$MARKER")"
    else
      FINISHED_TS="$(stat -c '%Y' "$MARKER")"
    fi
    [ "$((NOW - FINISHED_TS))" -ge "$MIN_AGE_SECONDS" ] || continue
    if [ "$MODE" = force ]; then
      "$SCRIPT_DIR/collab-webfeed-stop.sh" "$RD"
      echo "  webfeed gestopt: $ID"
    else
      echo "  webfeed wees: $ID (zou gestopt worden)"
    fi
  done
fi

hoort_bij_levend_team() {
  local sessie="$1" naam id
  for naam in $LIVE_NAMES; do
    case "$sessie" in "$naam"-*) return 0 ;; esac
  done
  for id in $LIVE_IDS; do
    [ "$sessie" = "ensemble-$id" ] && return 0
  done
  return 1
}

while IFS=$'\t' read -r SESSIE GESTART; do
  [ -z "$SESSIE" ] && continue
  # Only our own sessions. Everything else is someone's work.
  if [[ ! "$SESSIE" =~ ^collab-[0-9]{13}-[0-9]{4}-[a-zA-Z0-9._-]+$ && ! "$SESSIE" =~ ^ensemble-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
    continue
  fi
  case "$GESTART" in ''|*[!0-9]*) GESTART="$NOW" ;; esac
  AGE=$((NOW - GESTART))
  AGE_H=$((AGE / 3600))

  if hoort_bij_levend_team "$SESSIE"; then
    SPARED=$((SPARED + 1))
    echo -e "  ${GRN}levend${R}   ${SESSIE} ${D}(team draait nog)${R}"
    continue
  fi
  if [ "$AGE" -lt "$MIN_AGE_SECONDS" ]; then
    SPARED=$((SPARED + 1))
    echo -e "  ${GRN}jong${R}     ${SESSIE} ${D}($((AGE / 60))m oud, kan een team zijn dat nu start)${R}"
    continue
  fi

  ORPHANS=$((ORPHANS + 1))
  if [ "$MODE" = "force" ]; then
    if tmux kill-session -t "$SESSIE" 2>/dev/null; then
      KILLED=$((KILLED + 1))
      echo -e "  ${GRN}gestopt${R}  ${SESSIE} ${D}(wees, ${AGE_H}h oud)${R}"
    else
      echo -e "  ${YEL}mislukt${R}  ${SESSIE} ${D}(wees, ${AGE_H}h oud)${R}"
    fi
  else
    echo -e "  ${YEL}wees${R}     ${SESSIE} ${D}(${AGE_H}h oud, zou gestopt worden)${R}"
  fi
done <<< "$SESSIONS"

echo ""
echo -e "  ${BD}Stand${R}"
echo -e "  wezen:    ${ORPHANS}"
echo -e "  gespaard: ${SPARED}"
if [ "$MODE" = "force" ]; then
  echo -e "  gestopt:  ${KILLED}"
else
  echo ""
  echo -e "  ${D}Draai met --force om deze sessies echt te stoppen.${R}"
fi
echo ""
