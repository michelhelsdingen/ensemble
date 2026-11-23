#!/usr/bin/env bash
# open-iterm-monitor.sh — Open the collab TUI monitor in a native iTerm2 split pane.
# Usage: open-iterm-monitor.sh <repo-dir> <team-id> [split|tab|window]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./collab-paths.sh
source "$SCRIPT_DIR/collab-paths.sh"

REPO_DIR="${1:?Usage: open-iterm-monitor.sh <repo-dir> <team-id> [split|tab|window]}"
TEAM_ID="${2:?team-id required}"
MODE="${3:-split}"

LOG="${COLLAB_ITERM_LOG:-/tmp/collab-iterm-last.log}"
echo "=== $(date '+%F %T') open-iterm-monitor ($MODE) team=$TEAM_ID ===" > "$LOG"

if [ "$(uname)" != "Darwin" ]; then
  echo "open-iterm-monitor: not macOS" >&2
  exit 2
fi

if ! osascript -e 'tell application "System Events" to (name of processes) contains "iTerm2"' | grep -q true; then
  echo "open-iterm-monitor: iTerm2 is not running" >&2
  exit 3
fi

# Disable zsh CORRECT for this line: prevents "correct 'rcd' to 'cd'" prompt
# wanneer race tussen write-text en shell-init een stray char prepend.
CMD="unsetopt CORRECT 2>/dev/null; $(collab_monitor_command "$REPO_DIR" "$TEAM_ID")"

# iTerm2 sets ITERM_SESSION_ID like "w0t1p0:UUID" in every shell. Strip the
# prefix so we can match session ids via AppleScript.
SOURCE_SESSION_ID=""
if [ -n "${ITERM_SESSION_ID:-}" ]; then
  SOURCE_SESSION_ID="${ITERM_SESSION_ID##*:}"
fi
echo "source_session=$SOURCE_SESSION_ID" >> "$LOG"

# bash 3.2 (macOS system bash) cannot parse heredoc inside $() inside case, so
# the AppleScript is written to a temp file first.
#
# All heredocs below are QUOTED (<<'OSA'). Session id and command travel as
# osascript arguments and are read from argv. With an unquoted delimiter the
# shell expanded the program text itself: the backticks in these very comments
# ran as commands, which is where the stray "write: text is not logged in" and
# "correct: command not found" in the log came from.
_SCPT=$(mktemp /tmp/osa-collab-XXXXXX.applescript)
trap 'rm -f "$_SCPT"' EXIT

case "$MODE" in
  split)
    cat > "$_SCPT" <<'OSA'
on run argv
  set sourceId to item 1 of argv
  set cmdText to item 2 of argv
  tell application "iTerm2"
    activate
    delay 0.15
    if (count of windows) is 0 then
      create window with default profile
    end if
    set winCount to count of windows
    -- Prefer splitting the session the user actually invoked collab from
    -- (via ITERM_SESSION_ID). Fall back to the current session of the
    -- frontmost window if that session cannot be found.
    set foundSession to missing value
    set foundWindow to missing value
    set foundTab to missing value
    if sourceId is not "" then
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if (id of s as string) is sourceId then
              set foundSession to s
              set foundWindow to w
              set foundTab to t
              exit repeat
            end if
          end repeat
          if foundSession is not missing value then exit repeat
        end repeat
        if foundSession is not missing value then exit repeat
      end repeat
    end if
    if foundSession is missing value then
      set foundWindow to first window
      tell foundWindow
        set foundSession to current session
        set foundTab to current tab
      end tell
    end if
    set winId to id of foundWindow
    set tabCount to count of tabs of foundWindow
    tell foundSession
      set newSession to (split vertically with default profile)
      set newId to id of newSession
      -- Wait for the spawned shell (zsh) to fully boot before writing.
      -- Without this, a fast write lands its first chars before the shell
      -- prompt is ready; zsh's autocorrect then mangles the input
      -- (e.g. "cd ..." into "rcd ...") and asks the user to confirm.
      -- 1.5s plus a leading empty line absorbs any stray race-character.
      delay 1.5
      tell newSession
        write text ""
        delay 0.2
        write text cmdText
      end tell
    end tell
    -- Bring the monitor into view. The split lands next to the session that
    -- launched collab, which is often NOT the tab the user is looking at, so
    -- without this the pane opens correctly and is never seen.
    try
      tell foundTab to select
    end try
    return "windows=" & winCount & " window_id=" & winId & " tabs_in_window=" & tabCount & " new_session_id=" & newId
  end tell
end run
OSA
    ;;
  tab)
    cat > "$_SCPT" <<'OSA'
on run argv
  set cmdText to item 2 of argv
  tell application "iTerm2"
    activate
    delay 0.1
    if (count of windows) is 0 then
      create window with default profile
    end if
    tell first window
      set newTab to (create tab with default profile)
      delay 1.5
      tell current session of newTab
        write text ""
        delay 0.2
        write text cmdText
      end tell
      return "new_tab_session=" & (id of current session of newTab as string)
    end tell
  end tell
end run
OSA
    ;;
  window)
    cat > "$_SCPT" <<'OSA'
on run argv
  set cmdText to item 2 of argv
  tell application "iTerm2"
    activate
    delay 0.1
    set newWindow to (create window with default profile)
    delay 1.5
    tell current session of newWindow
      write text ""
      delay 0.2
      write text cmdText
    end tell
    return "new_window_session=" & (id of current session of newWindow as string)
  end tell
end run
OSA
    ;;
  *)
    echo "open-iterm-monitor: unknown mode '$MODE' (expected split|tab|window)" >&2
    exit 4
    ;;
esac

if RESULT=$(osascript "$_SCPT" "$SOURCE_SESSION_ID" "$CMD" 2>>"$LOG"); then
  echo "rc=0 result=$RESULT" >> "$LOG"
  echo "$RESULT"
else
  RC=$?
  echo "rc=$RC — zie $LOG" >&2
  exit 5
fi
