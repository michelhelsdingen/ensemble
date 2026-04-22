#!/usr/bin/env bash
# ensemble-bridge — Watches message file and posts to API
# Usage: ensemble-bridge.sh <team-id> [api-url]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./collab-paths.sh
source "$SCRIPT_DIR/collab-paths.sh"

TEAM_ID="${1:?Usage: ensemble-bridge.sh <team-id>}"
API="${2:-http://localhost:23000}"
RUNTIME_DIR="$(collab_runtime_dir "$TEAM_ID")"
FILE="$(collab_messages_file "$TEAM_ID")"
PID_FILE="$(collab_bridge_pid "$TEAM_ID")"
POSTED_FILE="$(collab_bridge_posted_file "$TEAM_ID")"
RESULT_FILE="$(collab_bridge_result_file "$TEAM_ID")"
FINISHED_FILE="$(collab_finished_marker "$TEAM_ID")"

mkdir -p "$RUNTIME_DIR"
touch "$FILE"

cleanup() {
  rm -f "$PID_FILE"
}

trap cleanup EXIT INT TERM

if [ -f "$PID_FILE" ]; then
  EXISTING_PID="$(tr -d ' ' < "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$EXISTING_PID" ] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo "[bridge] Already running for $TEAM_ID (pid $EXISTING_PID)"
    exit 0
  fi
fi

printf '%s\n' "$$" > "$PID_FILE"

if ! curl -sf "$API/api/v1/health" > /dev/null 2>&1; then
  echo "[bridge] health check failed for $API"
  exit 1
fi

if [ -f "$POSTED_FILE" ]; then
  POSTED=$(tr -d ' ' < "$POSTED_FILE" 2>/dev/null)
else
  POSTED=0
  echo "0" > "$POSTED_FILE"
fi

echo "[bridge] Watching $FILE"

while true; do
  if [ -f "$FINISHED_FILE" ]; then
    echo "[bridge] finished marker detected"
    # Auto-generate replay HTML
    if [ "${ENSEMBLE_REPLAY:-true}" = "true" ]; then
      REPLAY_FILE="$RUNTIME_DIR/replay.html"
      if python3 "$SCRIPT_DIR/generate-replay.py" "$TEAM_ID" --output "$REPLAY_FILE" 2>/dev/null; then
        echo "[bridge] replay saved: $REPLAY_FILE"
      fi
    fi
    echo "[bridge] stopping"
    exit 0
  fi

  TOTAL=$(wc -l < "$FILE" 2>/dev/null | tr -d ' ')
  POSTED=$(cat "$POSTED_FILE" 2>/dev/null | tr -d ' ')
  [ -z "$TOTAL" ] && TOTAL=0
  [ -z "$POSTED" ] && POSTED=0
  if [ "$POSTED" -gt "$TOTAL" ] 2>/dev/null; then
    POSTED=0
    echo "0" > "$POSTED_FILE"
  fi

  if [ "$TOTAL" -gt "$POSTED" ]; then
    # Process new lines — only advance posted counter on success.
    NEW_POSTED=$(python3 -c "
import json, sys, time, urllib.error, urllib.request
from itertools import islice

team_id = '$TEAM_ID'
api = '$API'
posted = $POSTED
last_success = posted

with open('$FILE') as f:
    for i, line in enumerate(islice(f, posted, None), start=posted):
        line = line.strip()
        if not line:
            last_success = i + 1
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            print(f'[bridge] skip malformed JSON line {i}: {line[:80]}', file=sys.stderr, flush=True)
            last_success = i + 1
            continue

        if not isinstance(msg, dict):
            print(f'[bridge] skip non-object line {i}', file=sys.stderr, flush=True)
            last_success = i + 1
            continue

        content = msg.get('content','')
        if not content:
            last_success = i + 1
            continue

        data = json.dumps({
            'from': msg.get('from',''),
            'to': msg.get('to','team'),
            'content': content,
            'id': msg.get('id',''),
            'timestamp': msg.get('timestamp',''),
        }).encode()

        req = urllib.request.Request(
            f'{api}/api/ensemble/teams/{team_id}',
            data=data,
            headers={'Content-Type': 'application/json'},
            method='POST'
        )
        success = False
        for attempt in range(10):
            try:
                with urllib.request.urlopen(req, timeout=5):
                    pass
                success = True
                break
            except urllib.error.HTTPError as e:
                # 429 (rate limit) and 408 (request timeout) are transient —
                # must be retried or messages are silently lost. 5xx obviously.
                # Other 4xx (400/401/403/404) indicate bad payload or missing
                # team: log loudly and skip so one bad line cannot stall the
                # feed forever.
                if e.code in (408, 429) or e.code >= 500:
                    delay = min(30.0, 0.5 * (2 ** attempt))
                    print(f'[bridge] transient {e.code} line {i}, retry {attempt+1}/10 in {delay:.1f}s: {e}', file=sys.stderr, flush=True)
                    if attempt == 9:
                        break
                    time.sleep(delay)
                else:
                    print(f'[bridge] client error {e.code} on line {i}, DROPPING: {e}', file=sys.stderr, flush=True)
                    success = True  # skip permanently — bad request will never succeed
                    break
            except (urllib.error.URLError, OSError) as e:
                delay = min(30.0, 0.5 * (2 ** attempt))
                print(f'[bridge] network error line {i}, retry {attempt+1}/10 in {delay:.1f}s: {e}', file=sys.stderr, flush=True)
                if attempt == 9:
                    break
                time.sleep(delay)
        if not success:
            print(f'[bridge] giving up on line {i} after 10 retries', file=sys.stderr, flush=True)
            break

        fr = msg.get('from','?')
        to = msg.get('to','?')
        c = content[:60]
        print(f'[bridge] {fr} -> {to}: {c}...', file=sys.stderr, flush=True)
        last_success = i + 1

# Output the last successfully posted line number
print(last_success, flush=True)
" 1>"$RESULT_FILE" 2>&1)

    # Echo captured stderr (diagnostic messages) so they appear in bridge log
    [ -n "$NEW_POSTED" ] && echo "$NEW_POSTED" >&2

    # Read the last line (the counter) from stdout
    RESULT=$(cat "$RESULT_FILE" 2>/dev/null | tail -1)
    if [ -n "$RESULT" ] && [ "$RESULT" -ge "$POSTED" ] 2>/dev/null; then
      printf '%s\n' "$RESULT" > "$POSTED_FILE"
    fi
  fi

  sleep 1
done
