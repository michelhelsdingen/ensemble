#!/usr/bin/env bash
# collab-wait.sh: wait until a team has finished, then print its summary.
# Usage: collab-wait.sh <team-id> [--max <seconds>]
#
# Looks every 2 seconds (COLLAB_WAIT_POLL overrides, in seconds) for
# $RUNTIME/<team-id>/.finished or summary.txt.
#
# Output and exit codes:
#   COLLAB_COMPLETE        followed by summary.txt (when present); exit 0
#   COLLAB_WAIT_TIMEOUT    the limit was reached before the team finished; exit 2.
#                          The team is still running: call this script again.
#   exit 1                 usage error or unknown team
#
# The limit defaults to 3300 s, just under a one-hour background-command limit.
# Measured collab runs took up to 21 minutes, so the old 600 s loop gave up on
# 5 of 8 runs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./collab-paths.sh
source "$SCRIPT_DIR/collab-paths.sh"

TEAM_ID="${1:?Usage: collab-wait.sh <team-id> [--max <seconds>]}"
shift
MAX=3300
while [ "$#" -gt 0 ]; do
  case "$1" in
    --max)
      shift
      MAX="${1:-}"
      if ! [[ "$MAX" =~ ^[0-9]+$ ]]; then
        echo "collab-wait: --max needs a whole number of seconds" >&2
        exit 1
      fi
      ;;
    *) echo "collab-wait: unknown argument '$1'" >&2; exit 1 ;;
  esac
  shift
done
if [[ ! "$TEAM_ID" =~ ^[a-zA-Z0-9_.-]+$ ]] || [ "$TEAM_ID" = . ] || [ "$TEAM_ID" = .. ]; then
  echo "collab-wait: invalid team-id" >&2
  exit 1
fi

RD="$(collab_runtime_dir "$TEAM_ID")"
if [ ! -d "$RD" ]; then
  echo "collab-wait: team directory missing: $RD" >&2
  exit 1
fi

POLL="${COLLAB_WAIT_POLL:-2}"
START=$(date +%s)
while [ ! -f "$RD/.finished" ] && [ ! -f "$RD/summary.txt" ]; do
  # -gt: whole-second clock, so "greater than" guarantees at least MAX seconds passed.
  if [ $(( $(date +%s) - START )) -gt "$MAX" ]; then
    echo "COLLAB_WAIT_TIMEOUT"
    exit 2
  fi
  sleep "$POLL"
done
echo "COLLAB_COMPLETE"
cat "$RD/summary.txt" 2>/dev/null || true
