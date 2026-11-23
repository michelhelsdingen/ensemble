#!/usr/bin/env bash
# open-herdr-monitor.sh — Open the collab TUI monitor in a herdr pane.
# Usage: open-herdr-monitor.sh <repo-dir> <team-id> [split|tab]
#
# herdr (https://github.com/herdrdev/herdr) is a terminal workspace manager that
# owns the terminal itself: it draws its own panes, tabs and sidebar inside a
# single host terminal session. Splitting the HOST terminal (iTerm2 AppleScript)
# puts the monitor outside the layout the user is looking at, so inside herdr we
# have to ask herdr for the split instead.
#
# Detection note: herdr passes TERM_PROGRAM through unchanged, so a shell inside
# herdr still reports TERM_PROGRAM=iTerm.app. HERDR_ENV is the reliable signal.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./collab-paths.sh
source "$SCRIPT_DIR/collab-paths.sh"

REPO_DIR="${1:?Usage: open-herdr-monitor.sh <repo-dir> <team-id> [split|tab]}"
TEAM_ID="${2:?team-id required}"
MODE="${3:-split}"

LOG="${COLLAB_HERDR_LOG:-/tmp/collab-herdr-last.log}"
echo "=== $(date '+%F %T') open-herdr-monitor ($MODE) team=$TEAM_ID ===" > "$LOG"

if [ "${HERDR_ENV:-}" != "1" ]; then
  echo "open-herdr-monitor: not running inside herdr (HERDR_ENV unset)" >&2
  exit 2
fi

if ! command -v herdr > /dev/null 2>&1; then
  echo "open-herdr-monitor: herdr binary not in PATH" >&2
  exit 3
fi

echo "source_pane=${HERDR_PANE_ID:-unknown} tab=${HERDR_TAB_ID:-unknown} workspace=${HERDR_WORKSPACE_ID:-unknown}" >> "$LOG"

# ─── Create the pane ───
case "$MODE" in
  split)
    if [ -n "${HERDR_PANE_ID:-}" ]; then
      CREATE_JSON=$(herdr pane split --pane "$HERDR_PANE_ID" --direction right --cwd "$REPO_DIR" 2>>"$LOG")
    else
      CREATE_JSON=$(herdr pane split --current --direction right --cwd "$REPO_DIR" 2>>"$LOG")
    fi
    ;;
  tab)
    CREATE_JSON=$(herdr tab create --cwd "$REPO_DIR" 2>>"$LOG")
    ;;
  *)
    echo "open-herdr-monitor: unknown mode '$MODE' (expected split|tab)" >&2
    exit 4
    ;;
esac

printf '%s\n' "$CREATE_JSON" >> "$LOG"

# herdr has moved this around between releases: a split answers with
# result.pane, a tab create with result.root_pane, and older builds used
# result.tab.panes[0]. Parsing lives in its own script so it can be tested
# against all three, and so a shape we have not seen yet still resolves
# instead of handing back an empty pane id. See tests/herdr-pane-id.test.ts.
NEW_PANE=$(printf '%s' "$CREATE_JSON" | python3 "$(dirname "$0")/herdr-pane-id.py" 2>>"$LOG") || {
  echo "open-herdr-monitor: could not read new pane id from herdr response (see $LOG)" >&2
  exit 5
}

if [ -z "$NEW_PANE" ]; then
  echo "open-herdr-monitor: herdr returned an empty pane id (see $LOG)" >&2
  exit 5
fi

echo "new_pane=$NEW_PANE" >> "$LOG"

# ─── Start the monitor in it ───
# herdr runs the command directly, so there is no shell prompt to race against
# and none of the zsh autocorrect trouble the iTerm path has to work around.
herdr pane run "$NEW_PANE" \
  bash -lc "$(collab_monitor_command "$REPO_DIR" "$TEAM_ID" exec)" \
  >> "$LOG" 2>&1

# Label the pane with the project directory, so a workspace with several panes
# still shows which project this monitor belongs to.
PROJECT_NAME=$(basename "$REPO_DIR")
herdr pane rename "$NEW_PANE" "$PROJECT_NAME collab" >> "$LOG" 2>&1 || true

echo "rc=0 pane=$NEW_PANE" >> "$LOG"
echo "new_pane_id=$NEW_PANE"
