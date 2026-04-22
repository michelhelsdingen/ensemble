#!/usr/bin/env bash
# team-read — Read messages from your team feed
# Usage: team-read <team-id>
# Strict mode + bounded timeouts so a hung localhost server cannot block a
# worker indefinitely (agents run this after every send).
set -euo pipefail
URL="${ENSEMBLE_URL:-http://localhost:23000}"
TEAM="${1:?Usage: team-read <team-id>}"
BODY=$(mktemp)
trap 'rm -f "$BODY"' EXIT
if ! curl -sS --connect-timeout 3 --max-time 10 -o "$BODY" \
     -w '' -f "$URL/api/ensemble/teams/$TEAM/feed" 2>/tmp/team-read.err; then
  echo "team-read: feed fetch failed for $TEAM ($(cat /tmp/team-read.err 2>/dev/null))" >&2
  exit 1
fi
python3 -c "
import json,sys
for m in json.load(open(sys.argv[1])).get('messages',[]):
  print(f'{m[\"from\"]} -> {m[\"to\"]}: {m[\"content\"]}')
" "$BODY"
