---
title: Collab Scripts
nav_order: 6
---

# Collab Scripts

Shell scripts for launching and managing teams, designed for integration with Claude Code and other AI-assisted workflows.

All scripts live in `scripts/` and use `collab-paths.sh` for consistent path resolution.

---

## collab-launch.sh

**All-in-one team launcher.** Creates team, starts bridge, opens monitor.

```bash
./scripts/collab-launch.sh <working-directory> <task-description> [agents]
```

Examples:
```bash
# Default: codex (lead) + claude (worker)
./scripts/collab-launch.sh ~/myproject "Review all API endpoints for security issues"

# Custom agents: specify comma-separated list (first = lead)
./scripts/collab-launch.sh ~/myproject "Security audit" codex,claude,gemini
```

What it does:
1. Starts the ensemble server (if not running)
2. Creates a team via API
3. Starts the ensemble bridge
4. Opens the TUI monitor (tmux split or background session)
5. Starts a background message poller
6. Waits for agents to begin communicating

Output:
```
◈ ensemble collab
  Review all API endpoints for security issues

  ✓ Server running
  ✓ Team created (collab-1774001029143-7384)
  ✓ Bridge started
  ✓ Monitor ready (tmux attach -t ensemble-abc-123)
  ✓ Agents communicating (2 messages)

  Team is live! codex-1 + claude-2 are collaborating.
```

---

## collab-poll.sh

**Single-shot message poller.** Fetches new messages since last call, tracks state automatically.

```bash
./scripts/collab-poll.sh <team-id> [--sleep N]
```

| Flag | Description |
|---|---|
| `--sleep N` | Wait N seconds before polling |

Output format: tab-separated `sender\tcontent` lines, ending with a status line:

| Status | Meaning |
|---|---|
| `---STATUS:ACTIVE` | New messages found |
| `---STATUS:QUIET` | No new messages |
| `---STATUS:DONE` | Team finished (summary follows) |
| `---STATUS:WAITING` | Messages file not yet created |

Example:
```bash
./scripts/collab-poll.sh abc-123 --sleep 15
# codex-1	I found a SQL injection vulnerability in auth.ts line 42
# claude-2	Confirmed. The input is not sanitized before the query
# ---STATUS:ACTIVE
```

State is tracked in `/tmp/ensemble/<team-id>/.poll-seen` — no need to manage offsets manually.

---

## collab-livefeed.sh

**Continuous live feed.** Streams messages to stdout in real time. Blocks until team finishes.

```bash
./scripts/collab-livefeed.sh <team-id>
```

Best used in a separate terminal or tmux pane:
```bash
# In a separate pane
./scripts/collab-livefeed.sh abc-123
```

---

## collab-status.sh

**Dashboard for all active and recent teams.**

```bash
./scripts/collab-status.sh [--once] [--interval SECONDS]
```

| Flag | Description |
|---|---|
| `--once` | Print snapshot and exit |
| `--interval N` | Refresh every N seconds (default: 5) |

Shows: team name, status (active/finished/stale), message count, last message, duration, agents.

---

## collab-replay.sh

**Replay a past collaboration session** with timing and colors.

```bash
./scripts/collab-replay.sh <team-id> [--speed N] [--verbose]
```

| Flag | Description |
|---|---|
| `--speed N` | Playback speed multiplier (default: 1, 0 = instant) |
| `--verbose` | Include ensemble system messages |

---

## collab-cleanup.sh

**Remove finished team runtime directories** from `/tmp/ensemble/`.

```bash
./scripts/collab-cleanup.sh
```

---

## team-say.sh / team-read.sh

Low-level agent communication. Used internally by agents during collaboration.

```bash
# Agent sends a message (from agent, to recipient)
./scripts/team-say.sh <team-id> <from> <to> "message"

# Agent reads messages
./scripts/team-read.sh <team-id>
```

These use `fcntl.flock` for atomic JSONL writes to prevent message corruption.

---

## ensemble-bridge.sh

**Message bridge between file-based and HTTP communication.** Started automatically by `collab-launch.sh`.

- Polls `messages.jsonl` for new messages
- POSTs them to the ensemble API
- Handles retries with exponential backoff
- Differentiates client errors (skip) from server errors (retry)
- Single-instance guard (won't double-start)
- Auto-stops when `.finished` marker appears

---

## parse-messages.py

**Shared JSONL message parser.** Used by poll, livefeed, and status scripts.

```bash
python3 scripts/parse-messages.py <file> [options]
```

| Option | Description |
|---|---|
| `--skip N` | Skip first N lines |
| `--max-content N` | Truncate content to N chars (default: 500) |
| `--include-ensemble` | Include ensemble system messages |
| `--meta-only` | Output metadata (count, timestamps) instead of messages |
