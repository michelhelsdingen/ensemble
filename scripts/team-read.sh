#!/usr/bin/env bash
# team-read — Read messages from your team feed
# Usage: team-read <team-id>
URL="${ENSEMBLE_URL:-http://localhost:23000}"
curl -sf "$URL/api/ensemble/teams/$1/feed" | python3 -c "
import json,sys
for m in json.load(sys.stdin).get('messages',[]):
  print(f'{m[\"from\"]} -> {m[\"to\"]}: {m[\"content\"]}')
" 2>/dev/null
