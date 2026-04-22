#!/usr/bin/env bash
# B4: dev-server with hot reload via bun --watch.
# Kills any existing ensemble server on port 23000 first, then starts a watched
# bun process. Exits cleanly on Ctrl+C.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

# Kill anything bound to the ensemble port (23000) — previous `pkill -9 -f bun`
# was global and stomped unrelated local bun/tsx processes. lsof is scoped to
# one port, and TERM → short wait → KILL gives the old server a chance to
# flush+close cleanly.
PORT="${ENSEMBLE_PORT:-23000}"
OLD_PIDS=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
if [ -n "$OLD_PIDS" ]; then
  echo "[dev-server] killing previous server on :$PORT (pids: $OLD_PIDS)"
  kill -TERM $OLD_PIDS 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    sleep 0.4
    STILL=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
    [ -z "$STILL" ] && break
  done
  STILL=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
  [ -n "$STILL" ] && kill -KILL $STILL 2>/dev/null || true
fi

# Start with --watch. bun re-imports changed modules without full restart
# for most changes; listens on port 23000 by default.
echo "[dev-server] Starting bun --watch server.ts on :23000"
exec bun --watch server.ts
