#!/usr/bin/env bash
# Print the monitor selected for a launch directory without starting a team.
set -euo pipefail

WORK_DIR="${1:-.}"
PREF="${COLLAB_MONITOR:-auto}"

orca_available() {
  if [ -n "${ORCA_CLI_COMMAND:-}" ]; then
    command -v "$ORCA_CLI_COMMAND" >/dev/null 2>&1 || [ -x "$ORCA_CLI_COMMAND" ]
  else
    command -v orca >/dev/null 2>&1 || [ -x /Applications/Orca.app/Contents/Resources/bin/orca ]
  fi
}

case "$PREF" in
  none|herdr|orca|orca-webfeed|iterm) printf '%s\n' "$PREF"; exit 0 ;;
  tmux) if [ -n "${TMUX:-}" ]; then echo split; else echo session; fi; exit 0 ;;
esac

if [ "${HERDR_ENV:-}" = 1 ] && command -v herdr >/dev/null 2>&1; then
  echo herdr
elif [ -n "${ORCA_AGENT_PANE:-}" ] && orca_available; then
  echo orca
elif [ -n "${TMUX:-}" ]; then
  echo split
else
  BOT_ROOT="${HOME:-}/.orca/bots"
  REAL_WORK_DIR="$(cd "$WORK_DIR" 2>/dev/null && pwd -P || true)"
  REAL_BOT_ROOT="$(cd "$BOT_ROOT" 2>/dev/null && pwd -P || true)"
  if [ -n "$REAL_BOT_ROOT" ] && [[ "$REAL_WORK_DIR" == "$REAL_BOT_ROOT"/* ]] \
      && [ -z "${ORCA_AGENT_PANE:-}" ] && [ -z "${HERDR_ENV:-}" ] \
      && [ -z "${TERM_PROGRAM:-}" ] && orca_available; then
    echo orca-webfeed
  elif [ "$(uname)" = Darwin ] && [ "${TERM_PROGRAM:-}" = iTerm.app ]; then
    echo iterm
  else
    echo session
  fi
fi
