#!/usr/bin/env bash
# collab-cleanup.sh — Clean up old finished and abandoned collab runtime directories.
# Usage: collab-cleanup.sh [--force]
#
# Finished: has a .finished marker (written on disband). The latest 3 and anything
# under 24h are kept. Abandoned: no marker (a launch that died before the agents
# spoke, a stray lock directory, or a team that never disbanded); removed after
# 24h. Any lingering bridge/poller process is stopped first, with a KILL if it
# ignores the TERM, whichever bucket the directory fell in.
#
# Let op: een levend proces beschermt de map NIET. Dat is met opzet, want de
# wezen die dit script moet opruimen hebben juist wel een draaiende bridge: die
# liep tot 20-09-2026 door na een gewone kill. Een team dat legitiem langer dan
# 24 uur bezig is en nog geen .finished heeft, wordt dus ook opgeruimd. Daarom
# is verwijderen nooit de default: zonder --force toont dit script alleen wat
# het zou doen.
# COLLAB_RUNTIME_ROOT overrides the root, for tests.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./collab-paths.sh
source "$SCRIPT_DIR/collab-paths.sh"

ENSEMBLE_ROOT="$(collab_runtime_root)"
API="${ENSEMBLE_URL:-http://localhost:23000}"
KEEP_RECENT=3
MIN_AGE_SECONDS=$((24 * 60 * 60))
MODE="dry-run"

G='\033[92m'; C='\033[96m'; D='\033[2m'; W='\033[97m'; Y='\033[93m'; R='\033[0m'; BD='\033[1m'

usage() {
  cat <<'EOF'
Usage: collab-cleanup.sh [--force]

Options:
  --force   Delete eligible runtime directories instead of printing a dry-run.
  -h, --help  Show this help text.
EOF
}

human_kb() {
  local kb="${1:-0}"
  if [ "$kb" -ge 1048576 ]; then
    awk -v kb="$kb" 'BEGIN { printf "%.1f GB", kb / 1048576 }'
  elif [ "$kb" -ge 1024 ]; then
    awk -v kb="$kb" 'BEGIN { printf "%.1f MB", kb / 1024 }'
  else
    printf '%s KB' "$kb"
  fi
}

mtime_epoch() {
  local path="${1:?path required}"
  if stat -f '%m' "$path" >/dev/null 2>&1; then
    stat -f '%m' "$path"
  else
    stat -c '%Y' "$path"
  fi
}

finished_entries() {
  [ -d "$ENSEMBLE_ROOT" ] || return 0
  find "$ENSEMBLE_ROOT" -mindepth 2 -maxdepth 2 -type f -name .finished -print0 |
    while IFS= read -r -d '' marker; do
      local runtime_dir ts
      runtime_dir="$(dirname "$marker")"
      ts="$(mtime_epoch "$marker")"
      printf '%s\t%s\n' "$ts" "$runtime_dir"
    done | sort -rn
}

# Newest mtime of a directory and everything in it.
newest_mtime() {
  local dir="${1:?dir required}" newest=0 ts
  while IFS= read -r -d '' entry; do
    ts="$(mtime_epoch "$entry")"
    [ "$ts" -gt "$newest" ] && newest="$ts"
  done < <(find "$dir" -print0)
  printf '%s\n' "$newest"
}

# Directories without a .finished marker, whether they ever held a message or
# not: precies de 28 mappen die eerder voor altijd bleven staan, want een map
# mét berichten telde nooit als verlaten, ook niet nadat het bridge/poller-
# proces allang was gestopt. De leeftijdsdrempel verderop beschermt een team
# dat nog maar net bezig is; stop_team_processes stopt vlak voor het weggooien
# alsnog elk proces dat toevallig nog leeft.
abandoned_entries() {
  [ -d "$ENSEMBLE_ROOT" ] || return 0
  find "$ENSEMBLE_ROOT" -mindepth 1 -maxdepth 1 -type d -print0 |
    while IFS= read -r -d '' runtime_dir; do
      [ -f "$runtime_dir/.finished" ] && continue
      printf '%s\t%s\n' "$(newest_mtime "$runtime_dir")" "$runtime_dir"
    done | sort -rn
}

# Geef alleen status terug als de service een bruikbaar teamantwoord gaf.
team_status() {
  local team_id="$1" response http_status body
  response="$(curl -sS -w $'\n%{http_code}' "$API/api/ensemble/teams/$team_id" 2>/dev/null)" || return 1
  http_status="${response##*$'\n'}"
  body="${response%$'\n'*}"
  if [ "$http_status" = "404" ]; then
    printf 'not-found\n'
    return 0
  fi
  [ "$http_status" = "200" ] || return 1
  printf '%s' "$body" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
    team = data.get("team", data) if isinstance(data, dict) else None
    status = team.get("status") if isinstance(team, dict) else None
    if not isinstance(status, str) or not status:
        raise ValueError("missing team status")
    print(status)
except Exception:
    sys.exit(1)
' 2>/dev/null
}

for arg in "$@"; do
  case "$arg" in
    --force)
      MODE="force"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n\n' "$arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done

NOW="$(date +%s)"
ENTRIES=()
while IFS= read -r line; do
  ENTRIES+=("$line")
done < <(finished_entries)

ABANDONED=()
while IFS= read -r line; do
  ABANDONED+=("$line")
done < <(abandoned_entries)

TOTAL_FINISHED="${#ENTRIES[@]}"
TOTAL_ABANDONED="${#ABANDONED[@]}"
ABANDONED_ELIGIBLE=0
ABANDONED_REMOVED=0
PRESERVED_RECENT=0
PRESERVED_FRESH=0
ELIGIBLE=0
REMOVED=0
FAILED=0
TOTAL_KB=0
REMOVED_KB=0

echo ""
echo -e "  ${BD}${W}◈ collab cleanup${R}"
echo -e "  ${D}${ENSEMBLE_ROOT}${R}"
echo -e "  ${D}mode: ${MODE} | keep latest ${KEEP_RECENT} | age threshold: 24h${R}"
echo ""

if [ ! -d "$ENSEMBLE_ROOT" ]; then
  echo -e "  ${Y}No runtime root found at ${ENSEMBLE_ROOT}${R}"
  exit 0
fi

if [ "$TOTAL_FINISHED" -eq 0 ] && [ "$TOTAL_ABANDONED" -eq 0 ]; then
  echo -e "  ${Y}No finished or abandoned collabs found.${R}"
  exit 0
fi

# ${ARR[@]+"${ARR[@]}"} keeps set -u happy on an empty array under macOS bash 3.2.
for idx in ${ENTRIES[@]+"${!ENTRIES[@]}"}; do
  entry="${ENTRIES[$idx]}"
  finished_ts="${entry%%$'\t'*}"
  runtime_dir="${entry#*$'\t'}"
  runtime_name="$(basename "$runtime_dir")"
  age_seconds=$((NOW - finished_ts))
  age_hours=$((age_seconds / 3600))
  size_kb="$(du -sk "$runtime_dir" 2>/dev/null | awk '{print $1}')"
  size_kb="${size_kb:-0}"
  TOTAL_KB=$((TOTAL_KB + size_kb))

  if [ "$idx" -lt "$KEEP_RECENT" ]; then
    PRESERVED_RECENT=$((PRESERVED_RECENT + 1))
    echo -e "  ${C}keep${R}    ${runtime_name} ${D}(latest $((idx + 1))/${KEEP_RECENT}, ${age_hours}h old, $(human_kb "$size_kb"))${R}"
    continue
  fi

  if [ "$age_seconds" -lt "$MIN_AGE_SECONDS" ]; then
    PRESERVED_FRESH=$((PRESERVED_FRESH + 1))
    echo -e "  ${C}skip${R}    ${runtime_name} ${D}(finished ${age_hours}h ago, below 24h threshold, $(human_kb "$size_kb"))${R}"
    continue
  fi

  ELIGIBLE=$((ELIGIBLE + 1))
  if [ "$MODE" = "force" ]; then
    stop_team_processes "$runtime_dir"
    if rm -rf "$runtime_dir"; then
      REMOVED=$((REMOVED + 1))
      REMOVED_KB=$((REMOVED_KB + size_kb))
      echo -e "  ${G}remove${R}  ${runtime_name} ${D}(${age_hours}h old, $(human_kb "$size_kb"))${R}"
    else
      FAILED=$((FAILED + 1))
      echo -e "  ${Y}failed${R}  ${runtime_name} ${D}(${age_hours}h old, $(human_kb "$size_kb"))${R}"
    fi
  else
    REMOVED_KB=$((REMOVED_KB + size_kb))
    echo -e "  ${Y}would rm${R} ${runtime_name} ${D}(${age_hours}h old, $(human_kb "$size_kb"))${R}"
  fi
done

for entry in ${ABANDONED[@]+"${ABANDONED[@]}"}; do
  newest_ts="${entry%%$'\t'*}"
  runtime_dir="${entry#*$'\t'}"
  runtime_name="$(basename "$runtime_dir")"
  age_seconds=$((NOW - newest_ts))
  age_hours=$((age_seconds / 3600))

  if [ "$age_seconds" -lt "$MIN_AGE_SECONDS" ]; then
    echo -e "  ${C}skip${R}    ${runtime_name} ${D}(no messages yet, ${age_hours}h old, may still be starting)${R}"
    continue
  fi

  ABANDONED_ELIGIBLE=$((ABANDONED_ELIGIBLE + 1))
  if [ "$MODE" = "force" ]; then
    if ! status="$(team_status "$runtime_name")"; then
      echo -e "  ${Y}skip${R}    ${runtime_name} ${D}(teamstatus niet beschikbaar, map behouden)${R}"
      continue
    fi
    if [ "$status" = "forming" ] || [ "$status" = "active" ]; then
      echo -e "  ${C}skip${R}    ${runtime_name} ${D}(team heeft status ${status}, map behouden)${R}"
      continue
    fi
    stop_team_processes "$runtime_dir"
    if rm -rf "$runtime_dir"; then
      ABANDONED_REMOVED=$((ABANDONED_REMOVED + 1))
      echo -e "  ${G}remove${R}  ${runtime_name} ${D}(abandoned, never a message, ${age_hours}h old)${R}"
    else
      FAILED=$((FAILED + 1))
      echo -e "  ${Y}failed${R}  ${runtime_name} ${D}(abandoned, ${age_hours}h old)${R}"
    fi
  else
    echo -e "  ${Y}would rm${R} ${runtime_name} ${D}(abandoned, never a message, ${age_hours}h old)${R}"
  fi
done

echo ""
echo -e "  ${BD}Stats${R}"
echo -e "  finished dirs:      ${TOTAL_FINISHED}"
echo -e "  kept (latest 3):    ${PRESERVED_RECENT}"
echo -e "  kept (<24h):        ${PRESERVED_FRESH}"
echo -e "  eligible old dirs:  ${ELIGIBLE}"
echo -e "  abandoned dirs:     ${TOTAL_ABANDONED} (${ABANDONED_ELIGIBLE} older than 24h)"
if [ "$MODE" = "force" ]; then
  echo -e "  removed dirs:       ${REMOVED} finished, ${ABANDONED_REMOVED} abandoned"
  echo -e "  failed removals:    ${FAILED}"
  echo -e "  reclaimed:          $(human_kb "$REMOVED_KB")"
else
  echo -e "  would remove:       ${ELIGIBLE} finished, ${ABANDONED_ELIGIBLE} abandoned"
  echo -e "  reclaimable:        $(human_kb "$REMOVED_KB")"
fi
echo -e "  finished footprint: $(human_kb "$TOTAL_KB")"
echo ""

if [ "$MODE" = "dry-run" ]; then
  echo -e "  ${D}Run with --force to delete eligible runtime directories.${R}"
  echo ""
fi
