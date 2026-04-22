#!/usr/bin/env bash
# Weekly adversarial audit — spawns Ensemble team to review recent code changes.
# Runs via launchd (com.openclaw.weekly-audit) every Sunday at 06:00 UTC.
set -euo pipefail

ENSEMBLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRYPTO_DIR="$HOME/.openclaw/workspace/skills/crypto-trading-platform"
DASHBOARD_URL="http://127.0.0.1:3000"

# Get recent changes (last 7 days)
cd "$CRYPTO_DIR"
CHANGES=$(git log --oneline --since="7 days ago" 2>/dev/null | head -20)
CHANGED_FILES=$(git diff --stat HEAD~20 HEAD --name-only 2>/dev/null | head -30)

if [ -z "$CHANGES" ]; then
  echo "[weekly-audit] No changes in last 7 days — skipping"
  exit 0
fi

TASK_DESC="Weekly adversarial audit of recent code changes (last 7 days):

Changes:
$CHANGES

Key files modified:
$CHANGED_FILES

BUILDER: Review all changes for correctness, security, and performance. Summarize what was changed and why.
ADVERSARY: Try to break the changes. Look for: race conditions, missing error handling, security vulnerabilities, edge cases, stale data paths. Write specific test cases that expose issues."

# Create collab task via dashboard API
curl -sf -X POST "$DASHBOARD_URL/api/tasks" \
  -H "Content-Type: application/json" \
  -d "$(python3 -c "
import json
print(json.dumps({
    'title': 'Weekly adversarial audit',
    'body': '''$TASK_DESC''',
    'priority': 'P3',
    'source': 'weekly-audit',
    'tags': ['collab', 'audit'],
    'collab_template': 'adversarial',
    'assignee': 'code-monkey'
}))
")" >/dev/null 2>&1 && echo "[weekly-audit] Task created" || echo "[weekly-audit] Task creation failed"
