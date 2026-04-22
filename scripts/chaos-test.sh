#!/usr/bin/env bash
# D1: Chaos test — validates system recovers cleanly from hostile scenarios.
# Run: bash scripts/chaos-test.sh
# Requires: bun server.ts running on :23000
set -euo pipefail

API="http://localhost:23000"
PASS=0
FAIL=0
TOTAL=0

ok() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "  ❌ $1"; }
cleanup_team() {
  local tid="$1"
  [ -z "$tid" ] && return 0
  # DELETE triggers disbandTeam() which kills every `${team.name}-${agent.name}`
  # session. The previous awk/xargs fallback matched by UUID-8 substring, but
  # session names are derived from team.name (timestamp-based), so the pattern
  # never fired and only served to hide a bug in the happy path.
  local name
  name=$(curl -sf "$API/api/ensemble/teams/$tid" 2>/dev/null \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['team']['name'])" 2>/dev/null || true)
  curl -sf -X DELETE "$API/api/ensemble/teams/$tid" > /dev/null 2>&1 || true
  if [ -n "$name" ]; then
    tmux list-sessions -F '#{session_name}' 2>/dev/null \
      | awk -v n="$name" '$0 ~ "^"n"-" {print}' \
      | xargs -I{} tmux kill-session -t {} 2>/dev/null || true
  fi
}

echo ""
echo "◈ Chaos Test Suite"
echo ""

# ── Scenario 1: CAS rejects duplicate cwd ──
echo "Scenario 1: CAS duplicate team rejection"
R1=$(curl -s -w "%{http_code}" -o /tmp/chaos-1a.json -X POST "$API/api/ensemble/teams" \
  -H 'Content-Type: application/json' \
  -d '{"name":"chaos-1","description":"dup test","workingDirectory":"/tmp/chaos-cwd","agents":[{"program":"codex"},{"program":"claude"}]}')
TID=$(python3 -c "import json; print(json.load(open('/tmp/chaos-1a.json'))['team']['id'])" 2>/dev/null)
R2=$(curl -s -w "%{http_code}" -o /tmp/chaos-1b.json -X POST "$API/api/ensemble/teams" \
  -H 'Content-Type: application/json' \
  -d '{"name":"chaos-1b","description":"dup test 2","workingDirectory":"/tmp/chaos-cwd","agents":[{"program":"codex"},{"program":"claude"}]}')
[ "$R1" = "201" ] && [ "$R2" = "409" ] && ok "CAS: first=201, second=409" || fail "CAS: got $R1, $R2"
cleanup_team "$TID"

# ── Scenario 2: Corrupt JSONL last line ──
echo "Scenario 2: Corrupt JSONL recovery"
R3=$(curl -s -w "%{http_code}" -o /tmp/chaos-2.json -X POST "$API/api/ensemble/teams" \
  -H 'Content-Type: application/json' \
  -d '{"name":"chaos-2","description":"jsonl test","workingDirectory":"/tmp/chaos-jsonl","agents":[{"program":"codex"},{"program":"claude"}]}')
TID2=$(python3 -c "import json; print(json.load(open('/tmp/chaos-2.json'))['team']['id'])" 2>/dev/null)
MSGF="/tmp/ensemble/$TID2/messages.jsonl"
sleep 2
# Append garbage
echo '{broken json 💀' >> "$MSGF" 2>/dev/null || true
# Read should still work (malformed line dropped, not crash)
R4=$(curl -s -w "%{http_code}" -o /dev/null "$API/api/ensemble/teams/$TID2")
[ "$R4" = "200" ] && ok "Corrupt JSONL: read survives (HTTP $R4)" || fail "Corrupt JSONL: crash ($R4)"
cleanup_team "$TID2"

# ── Scenario 3: Kill tmux session mid-run ──
echo "Scenario 3: Kill tmux session → health reflects dead"
R5=$(curl -s -w "%{http_code}" -o /tmp/chaos-3.json -X POST "$API/api/ensemble/teams" \
  -H 'Content-Type: application/json' \
  -d '{"name":"chaos-3","description":"kill test","workingDirectory":"/tmp/chaos-kill","agents":[{"program":"codex"},{"program":"claude"}]}')
TID3=$(python3 -c "import json; print(json.load(open('/tmp/chaos-3.json'))['team']['id'])" 2>/dev/null)
sleep 2
# Kill one agent's tmux session
tmux kill-session -t "chaos-3-codex-1" 2>/dev/null || true
sleep 1
ALIVE=$(curl -s "$API/api/ensemble/teams/$TID3/health" 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
dead = [s['agent'] for s in d.get('sessions',[]) if not s['alive']]
print(','.join(dead) if dead else 'ALL_ALIVE')
" 2>/dev/null)
[[ "$ALIVE" == *"codex-1"* ]] && ok "Killed session: health shows codex-1 dead" || fail "Health didn't detect dead session ($ALIVE)"
cleanup_team "$TID3"

# ── Scenario 4: Rate limit ──
echo "Scenario 4: Rate limit agent spam"
R6=$(curl -s -w "%{http_code}" -o /tmp/chaos-4.json -X POST "$API/api/ensemble/teams" \
  -H 'Content-Type: application/json' \
  -d '{"name":"chaos-4","description":"rate test","workingDirectory":"/tmp/chaos-rate","agents":[{"program":"codex"},{"program":"claude"}]}')
TID4=$(python3 -c "import json; print(json.load(open('/tmp/chaos-4.json'))['team']['id'])" 2>/dev/null)
sleep 1
LAST_CODE="200"
for i in $(seq 1 35); do
  LAST_CODE=$(curl -s -w "%{http_code}" -o /dev/null -X POST "$API/api/ensemble/teams/$TID4" \
    -H 'Content-Type: application/json' \
    -d "{\"from\":\"codex-1\",\"to\":\"team\",\"content\":\"spam msg $i\"}")
done
[ "$LAST_CODE" = "429" ] && ok "Rate limit: 35th msg got 429" || fail "Rate limit: last code=$LAST_CODE"
cleanup_team "$TID4"

# ── Scenario 5: Stale lock cleanup ──
echo "Scenario 5: Stale message lock recovery"
MSGF5="/tmp/ensemble/stale-lock-test/messages.jsonl"
LOCKDIR="$MSGF5.lock"
mkdir -p "$(dirname "$MSGF5")"
touch "$MSGF5"
# Create a stale lock (old mtime)
mkdir -p "$LOCKDIR"
touch -t 200001010000 "$LOCKDIR" 2>/dev/null || true
# appendMessage should recover by stealing the stale lock
bun -e "
import { appendMessage } from './lib/ensemble-registry'
try {
  appendMessage('stale-lock-test', {
    id:'test', teamId:'stale-lock-test', from:'test', to:'team',
    content:'post-stale-lock', type:'chat', timestamp: new Date().toISOString(),
  })
  console.log('OK')
} catch(e) { console.log('FAIL:' + e.message) }
" 2>/dev/null | grep -q 'OK' && ok "Stale lock: recovered and wrote" || fail "Stale lock: could not write"
rm -rf "/tmp/ensemble/stale-lock-test"

echo ""
echo "──────────────────────────"
echo "  Results: $PASS/$TOTAL passed, $FAIL failed"
echo ""
