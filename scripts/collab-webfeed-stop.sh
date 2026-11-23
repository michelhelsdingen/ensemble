#!/usr/bin/env bash
# Stop only a webfeed process identified by this team directory.
set -euo pipefail
RD="${1:?runtime directory required}"
if [ -f "$RD/webfeed.pid" ]; then
  PID="$(cat "$RD/webfeed.pid")"
  if [[ "$PID" =~ ^[0-9]+$ ]]; then
    CMD="$(ps -p "$PID" -o command= 2>/dev/null || true)"
    case "$CMD" in
      *orca-webfeed-server.py*" $(basename "$RD")"*) kill "$PID" 2>/dev/null || true ;;
    esac
  fi
  rm -f "$RD/webfeed.pid" "$RD/webfeed.port"
fi
if [ -s "$RD/webfeed-page-id" ]; then
  PAGE_ID="$(cat "$RD/webfeed-page-id")"
  if [ -n "${ORCA_CLI_COMMAND:-}" ]; then
    ORCA_CLI="$ORCA_CLI_COMMAND"
  elif command -v orca >/dev/null 2>&1; then
    ORCA_CLI="$(command -v orca)"
  else
    ORCA_CLI=/Applications/Orca.app/Contents/Resources/bin/orca
  fi
  if command -v "$ORCA_CLI" >/dev/null 2>&1 || [ -x "$ORCA_CLI" ]; then
    "$ORCA_CLI" tab close --page "$PAGE_ID" --json >/dev/null 2>&1 || true
  fi
  rm -f "$RD/webfeed-page-id"
fi
