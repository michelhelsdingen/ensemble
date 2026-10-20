#!/usr/bin/env bash
# Open the collab TUI monitor beside the current Orca pane or in a new tab.
# Usage: open-orca-monitor.sh <repo-dir> <team-id> [split|tab]
set -euo pipefail

REPO_DIR="${1:?Usage: open-orca-monitor.sh <repo-dir> <team-id> [split|tab]}"
TEAM_ID="${2:?team-id required}"
MODE="${3:-split}"
LOG=/tmp/collab-orca-last.log
echo "=== $(date '+%F %T') open-orca-monitor ($MODE) team=$TEAM_ID ===" > "$LOG"

if [ -z "${ORCA_AGENT_PANE:-}" ]; then
  echo "open-orca-monitor: not running inside an Orca pane (ORCA_AGENT_PANE unset)" >&2
  exit 2
fi

if command -v orca >/dev/null 2>&1; then
  ORCA_CLI=$(command -v orca)
elif [ -x /Applications/Orca.app/Contents/Resources/bin/orca ]; then
  ORCA_CLI=/Applications/Orca.app/Contents/Resources/bin/orca
else
  echo "open-orca-monitor: orca CLI not found" >&2
  exit 3
fi

case "$MODE" in
  split|tab) ;;
  *) echo "open-orca-monitor: unknown mode '$MODE' (expected split|tab)" >&2; exit 4 ;;
esac

if [[ ! "$TEAM_ID" =~ ^[a-zA-Z0-9_.-]+$ ]]; then
  echo "open-orca-monitor: invalid team-id" >&2
  exit 4
fi

# Orca exposes tabId:leafId in the terminal environment, but its split command
# requires the runtime-issued terminal handle. Resolve that exact pane first.
if ! LIST_JSON=$("$ORCA_CLI" terminal list --json 2>>"$LOG"); then
  echo "open-orca-monitor: could not list Orca terminals (see $LOG)" >&2
  exit 5
fi
if ! SOURCE_HANDLE=$(printf '%s' "$LIST_JSON" | python3 -c '
import json, os, sys
try:
    response = json.load(sys.stdin)
    tab, leaf = os.environ["ORCA_AGENT_PANE"].split(":", 1)
    terminals = response["result"]["terminals"]
    matches = [t["handle"] for t in terminals
               if t.get("tabId") == tab and t.get("leafId") == leaf
               and (not os.environ.get("ORCA_WORKTREE_ID")
                    or t.get("worktreeId") == os.environ["ORCA_WORKTREE_ID"])]
    if not response.get("ok") or len(matches) != 1:
        raise ValueError("source pane not found uniquely")
    print(matches[0])
except (KeyError, TypeError, ValueError, AttributeError) as exc:
    print("open-orca-monitor: " + str(exc), file=sys.stderr)
    sys.exit(1)
' 2>>"$LOG"); then
  echo "open-orca-monitor: could not find current Orca pane (see $LOG)" >&2
  exit 5
fi

MONITOR_CMD="cd $(printf '%q' "$REPO_DIR") && exec ./node_modules/.bin/tsx cli/monitor.ts $(printf '%q' "$TEAM_ID")"
if [ "$MODE" = split ]; then
  if ! CREATE_JSON=$("$ORCA_CLI" terminal split --terminal "$SOURCE_HANDLE" --direction vertical --command "$MONITOR_CMD" --json 2>>"$LOG"); then
    echo "open-orca-monitor: Orca split failed (see $LOG)" >&2
    exit 5
  fi
else
  if [ -z "${ORCA_WORKTREE_ID:-}" ]; then
    echo "open-orca-monitor: ORCA_WORKTREE_ID is required for tab mode" >&2
    exit 5
  fi
  if ! CREATE_JSON=$("$ORCA_CLI" terminal create --worktree "id:${ORCA_WORKTREE_ID}" --title "$(basename "$REPO_DIR") collab" --command "$MONITOR_CMD" --json 2>>"$LOG"); then
    echo "open-orca-monitor: Orca tab creation failed (see $LOG)" >&2
    exit 5
  fi
fi

# Orca returns result.split.handle or result.terminal.handle.
if ! NEW_TERMINAL=$(printf '%s' "$CREATE_JSON" | python3 -c '
import json, sys
try:
    response = json.load(sys.stdin)
    if not response.get("ok"):
        raise ValueError("Orca reported failure")
    result = response["result"]
    handle = result["split" if sys.argv[2] == "split" else "terminal"]["handle"]
    if not isinstance(handle, str) or not handle.startswith("term_") or handle == sys.argv[1]:
        raise ValueError("invalid new terminal handle")
    print(handle)
except (KeyError, TypeError, ValueError, AttributeError) as exc:
    print("open-orca-monitor: " + str(exc), file=sys.stderr)
    sys.exit(1)
' "$SOURCE_HANDLE" "$MODE" 2>>"$LOG"); then
  echo "open-orca-monitor: could not read new terminal handle (see $LOG)" >&2
  exit 5
fi

mkdir -p "/tmp/ensemble/$TEAM_ID"
printf '%s\n' "$NEW_TERMINAL" > "/tmp/ensemble/$TEAM_ID/orca-terminal-id"
echo "rc=0 terminal=$NEW_TERMINAL" >> "$LOG"
echo "new_pane_id=$NEW_TERMINAL"
