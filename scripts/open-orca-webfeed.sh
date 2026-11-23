#!/usr/bin/env bash
# Open a one-team browser feed beside an Orca bot chat.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./collab-paths.sh
source "$SCRIPT_DIR/collab-paths.sh"
TEAM_ID="${1:?team-id required}"
if [[ ! "$TEAM_ID" =~ ^[a-zA-Z0-9_.-]+$ ]] || [ "$TEAM_ID" = . ] || [ "$TEAM_ID" = .. ]; then
  echo "open-orca-webfeed: invalid team-id" >&2
  exit 4
fi
if [ -n "${ORCA_CLI_COMMAND:-}" ]; then
  ORCA_CLI="$ORCA_CLI_COMMAND"
elif command -v orca >/dev/null 2>&1; then
  ORCA_CLI="$(command -v orca)"
else
  ORCA_CLI=/Applications/Orca.app/Contents/Resources/bin/orca
fi
if ! command -v "$ORCA_CLI" >/dev/null 2>&1 && [ ! -x "$ORCA_CLI" ]; then
  echo "open-orca-webfeed: orca CLI not found" >&2
  exit 3
fi
RD="$(collab_runtime_dir "$TEAM_ID")"
[ -d "$RD" ] || { echo "open-orca-webfeed: team directory missing" >&2; exit 4; }
nohup python3 "$SCRIPT_DIR/orca-webfeed-server.py" "$TEAM_ID" > "$RD/webfeed.log" 2>&1 &
JOB=$!
for _ in $(seq 1 50); do
  [ -s "$RD/webfeed.port" ] && break
  kill -0 "$JOB" 2>/dev/null || break
  sleep 0.1
done
if [ ! -s "$RD/webfeed.port" ]; then
  echo "open-orca-webfeed: server failed" >&2
  exit 5
fi
PORT="$(cat "$RD/webfeed.port")"
if ! RESPONSE=$("$ORCA_CLI" tab create --url "http://127.0.0.1:$PORT/" --split right --json); then
  kill "$JOB" 2>/dev/null || true
  echo "open-orca-webfeed: Orca tab creation failed" >&2
  exit 5
fi
if ! PAGE_ID=$(printf '%s' "$RESPONSE" | python3 -c '
import json, sys
try:
    response = json.load(sys.stdin)
    page = response["result"]["browserPageId"]
    if response.get("ok") is False or not isinstance(page, str) or not page:
        raise ValueError("missing browserPageId")
    print(page)
except (KeyError, ValueError, TypeError):
    sys.exit(1)
'); then
  kill "$JOB" 2>/dev/null || true
  echo "open-orca-webfeed: invalid Orca response" >&2
  exit 5
fi
printf '%s\n' "$PAGE_ID" > "$RD/webfeed-page-id"
echo "new_pane_id=$PAGE_ID"
