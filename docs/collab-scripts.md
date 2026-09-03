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
./scripts/collab-launch.sh <working-directory> <task-description> [agents] [template]
```

Examples:
```bash
# Default: codex (lead) + claude (worker)
./scripts/collab-launch.sh ~/myproject "Review all API endpoints for security issues"

# Custom agents: comma-separated list (first = lead)
./scripts/collab-launch.sh ~/myproject "Security audit" codex,claude,grok

# With a role template from collab-templates.json
./scripts/collab-launch.sh ~/myproject "Security audit" codex,claude review
```

Both optional arguments have an env-var equivalent, so a line-up or template you always want
does not have to be retyped:

| Argument | Env var | Precedence |
|---|---|---|
| 3rd (`agents`) | `COLLAB_AGENTS` | argument > env var > default pair |
| 4th (`template`) | `COLLAB_TEMPLATE` | argument > env var > generic lead/worker roles |

Naming agents, by argument or by `COLLAB_AGENTS`, also disables the auto-fallback that
preflight uses to swap out a dead agent. A named agent that is broken becomes a hard preflight
failure instead of a silent substitution.

What it does:
1. Starts the ensemble server (if not running)
2. Runs `collab-preflight.sh` for exactly the agents this run needs
3. Creates a team via API
4. Starts the ensemble bridge
5. Opens the TUI monitor, picking the best viewer automatically (see table below)
6. Starts a background message poller
7. Waits for agents to begin communicating

**Monitor selection** (override with `COLLAB_MONITOR=herdr|tmux|iterm|none`):

| Situation | Monitor opened |
|---|---|
| Inside a herdr workspace (`HERDR_ENV=1`) | herdr pane, labelled after the project directory |
| Inside tmux already | tmux split pane (right 40%) |
| macOS + iTerm2, not in tmux | native iTerm2 split pane |
| Linux, or no iTerm2 | detached tmux session (`tmux attach -t ensemble-<id>`) |

herdr is checked before iTerm2: it passes `TERM_PROGRAM=iTerm.app` through unchanged, so
trusting that variable opens a real iTerm split outside the layout you are watching.

Layout overrides: `COLLAB_ITERM_MODE=split|tab|window` and `COLLAB_HERDR_MODE=split|tab`
(both default to `split`).

Output (herdr example, three agents):
```
◈ ensemble collab
  Review all API endpoints for security issues

  ✓ Server running
  ✓ Team created (collab-1774001029143-7384)
  ✓ Bridge started
  ✓ Monitor opened (herdr split)
  ✓ Agents communicating (2 messages)

  Team is live! codex-1 + claude-2 + grok-3 are collaborating.
```

The last line of stdout is a machine-readable `TEAM_ID=<id>` trailer. Grep for that instead of
reading `/tmp/collab-team-id.txt`, which is global and gets overwritten when two collabs run at
the same time.

---

## collab-preflight.sh

**Verifies the agents can actually work before a team is spawned.** Run automatically by
`collab-launch.sh`; skip with `COLLAB_SKIP_PREFLIGHT=1`.

```bash
./scripts/collab-preflight.sh [agents-csv]
```

Only the CLIs you name are checked, so a codex quota wall does not block a `grok,claude` run.
The codex check is a real `codex exec` that must return a sentinel string: an auth mode that
rejects the configured model answers with an ordinary error containing no quota wording, and
used to be reported as healthy right before the agent spawned and sat silent all session.

| Exit | Meaning |
|---|---|
| 0 | Safe to launch |
| 1 | Ensemble service not running |
| 2 | Service is stale (started without auth, restart it) |
| 3 | Claude CLI broken, or a *named* agent is unavailable |
| 4 | Codex CLI broken |
| 5 | DNS/network issue |
| 6 | Grok CLI broken |

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

**Remove finished and abandoned team runtime directories** from `/tmp/ensemble/`. Dry-run by default.

```bash
./scripts/collab-cleanup.sh           # list what would be deleted
./scripts/collab-cleanup.sh --force   # actually delete
```

Finished directories (with a `.finished` marker) are removed after 24h, the latest
three are always kept. Abandoned directories, without a marker and without a single
message (a launch that died before the agents spoke, a stray lock directory), are
removed after 24h as well. A directory that holds messages is never touched: the
team may still be running, and `collab-history.py` reads those messages later.

This does not disband a running team. To end one, press `d` in the monitor or
`POST /api/ensemble/teams/<id>/disband`.

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
