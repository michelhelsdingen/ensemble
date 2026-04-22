#!/usr/bin/env bash
# team-say — Send a message to your team feed
# Works inside sandboxed environments (no network needed - writes to file)
# Usage: team-say <team-id> <from> <to> <message>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=./collab-paths.sh
source "$SCRIPT_DIR/collab-paths.sh"

TEAM_ID="$1"; FROM="$2"; TO="$3"; shift 3; MSG="$*"
FILE="$(collab_messages_file "$TEAM_ID")"
DIR="$(dirname "$FILE")"
LOCK_DIR="$FILE.lock"
mkdir -p "$DIR"
touch "$FILE"
python3 -c "
import json
import os
import sys
import time
import uuid
from datetime import datetime, timezone

team_id, sender, recipient, content, output_path, lock_dir = sys.argv[1:7]
msg = {
    'id': str(uuid.uuid4()),
    'teamId': team_id,
    'from': sender,
    'to': recipient,
    'content': content,
    'type': 'chat',
    'timestamp': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
}

# Acquire mkdir-based lock (compatible with ensemble-registry.ts appendMessage).
# Fail loudly on timeout instead of appending without the lock — otherwise two
# concurrent writers under contention produce torn JSONL rows (exactly the
# scenario the lock was meant to prevent).
start = time.time()
acquired = False
while time.time() - start < 5.0:
    try:
        os.mkdir(lock_dir)
        acquired = True
        break
    except FileExistsError:
        try:
            if time.time() - os.stat(lock_dir).st_mtime > 10.0:
                import shutil; shutil.rmtree(lock_dir, ignore_errors=True)
                continue
        except OSError:
            pass
        time.sleep(0.05)

if not acquired:
    print(f'team-say: timed out acquiring lock at {lock_dir} after 5s', file=sys.stderr)
    sys.exit(2)

try:
    with open(output_path, 'a', encoding='utf-8') as f:
        f.write(json.dumps(msg) + '\n')
finally:
    import shutil; shutil.rmtree(lock_dir, ignore_errors=True)
" "$TEAM_ID" "$FROM" "$TO" "$MSG" "$FILE" "$LOCK_DIR"

echo "Sent to $TO"
