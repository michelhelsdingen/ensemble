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

An explicit third argument disables the auto-fallback that preflight uses to swap out a dead
agent. `COLLAB_AGENTS` is the standard set and keeps fallback enabled. Every substitution is
printed as a warning. A broken agent named as the third argument becomes a hard preflight failure.

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

`Team is live!` only prints when there is evidence: at least one message exchanged
(`messages.jsonl` is non-empty). Without that evidence within the wait window the script warns
instead and exits non-zero, pointing at `collab-rescue.sh <team-id>` as the recovery path.

| Exit | Meaning |
|---|---|
| 0 | Team live, monitor open |
| 1 | Server failed to start, or preflight failed |
| 9 | Preflight found an agent waiting on a startup dialog (passed through) |
| 3 | Team created but no message exchanged within the wait window |
| 4 | Bridge or poller process died immediately after starting |

Every exit that happens after the team is created prints a `TEAM_ID=<id>` trailer, including the
failing ones, so a caller can always find the runtime directory to investigate or rescue. Grep
for that line instead of reading `/tmp/collab-team-id.txt`, which is global and gets overwritten
when two collabs run at the same time.

---

## collab-preflight.sh

**Verifies the agents can actually work before a team is spawned.** Run automatically by
`collab-launch.sh`; skip with `COLLAB_SKIP_PREFLIGHT=1`.

```bash
./scripts/collab-preflight.sh [agents-csv]
```

Only the CLIs in the explicit argument or `COLLAB_AGENTS` are checked, so a codex quota wall
does not block a `grok,claude` run. When neither is supplied, the default pair is checked.
The codex check is a real `codex exec` that must compute a sum and answer with the result: an
auth mode that rejects the configured model answers with an ordinary error containing no quota
wording, and used to be reported as healthy right before the agent spawned and sat silent all
session.

Before those checks, preflight starts every requested agent in a throwaway tmux session exactly
as a team does, and refuses to launch (exit 9) when one of them is sitting on a dialog. The
`codex exec` check above cannot see this: `exec` has no TUI. Measured 03-11-2026, codex 0.164.0
opened a modal "Hooks need review" whose selection arrow is its own readyMarker, so preflight
was green, the team launched, the prompt was pasted into the dialog three times and nobody said
anything. The dialog is never answered for you: trusting code that may run outside the sandbox
is your decision. Start that CLI once in a terminal, answer it, launch again. Skip the probe
with `COLLAB_SKIP_STARTPROBE=1`; it costs no tokens, only a few seconds of startup.

If the tmux DNS resolver is stale, preflight auto-fixes it with `tmux kill-server`, but refuses
to do that while any `collab-*` tmux session is running: that kill would take a working team
down with it. Finish or disband those teams first, or run `tmux kill-server` yourself once
they're clear.

A `brew upgrade` of node deletes the Cellar directory the running service was started from.
The process keeps going on a binary that is no longer on disk, macOS can then no longer
revalidate its code signature, and every read under a protected folder returns `EPERM` with
no other symptom. Health stayed green because it only checks the credential store, which
lives outside those folders, so the team was created before anything failed. Preflight now
asks the service whether its own `execPath` still exists and whether it can really read the
repo, and restarts it through launchd when it cannot. It refuses to restart while a team is
active, because team state lives in the service's memory: disband that team first.

| Exit | Meaning |
|---|---|
| 0 | Safe to launch |
| 1 | Ensemble service not running |
| 2 | Service is stale (started without auth, restart it) |
| 3 | Claude CLI broken, or a *named* agent is unavailable |
| 4 | Codex CLI broken |
| 5 | DNS/network issue |
| 6 | Grok CLI broken |
| 7 | Health hook reports a selected agent down or limited, with no permitted healthy fallback |
| 8 | Service runtime cannot spawn agents: it runs a deleted binary or cannot read the repo |
| 9 | An agent CLI is waiting on a startup dialog only the user may answer |

---

## collab-postcheck.sh

**Verifies agents are healthy after spawning.** Run in the background by `collab-launch.sh`
(~25s after spawn); skip with `COLLAB_SKIP_POSTCHECK=1`.

```bash
./scripts/collab-postcheck.sh <team-id> [wait-seconds]
```

It only ever looks at the tmux sessions that belong to this team, read from
`<runtime-dir>/sessions`, the register the service writes on every successful spawn. Without
that register (an older team, or one that failed before a single agent spawned) postcheck has
nothing to check and exits `0` without touching anything.

After the wait, it captures each of those panes and greps for known fatal patterns ("Not logged
in", a DNS/network failure, an auth error). If it finds one, or if zero messages were exchanged
in the wait window, it kills only this team's sessions and prints the diagnosis.

| Exit | Meaning |
|---|---|
| 0 | Agents healthy, or nothing to check (no register, or an empty one) |
| 1 | Team-id not found |
| 2 | An agent is in a fatal error state, or zero messages after the wait; team is killed |

---

## collab-rescue.sh

**Manually delivers prompts that never reached the agents.** The symptom: the team's tmux panes
are visible, but `messages.jsonl` stays empty because the service's readiness pattern never
matched (codex's prompt format varies enough that this happens occasionally).

```bash
./scripts/collab-rescue.sh <team-id>
./scripts/collab-rescue.sh              # falls back to /tmp/collab-team-id.txt
```

It reads `<runtime-dir>/sessions` for this team's tmux sessions and matches each one against the
agent prompt files in `<runtime-dir>/prompts/` by name, so it only ever delivers into panes that
belong to the requested team. Without that register (a team not started by this launcher) it
refuses outright rather than guessing. For each session it pastes the prompt, sends Enter, and
for Claude panes watches for the "[Pasted text" indicator to send a follow-up Enter before it
gives up.

Exits `0` if the team already looked active (more than two messages) or delivery produced new
messages within 10s; exits `1` on a missing team-id, runtime dir, prompts, or session register;
exits `2` if delivery ran but no new messages showed up, in which case it prints the `tmux
attach` command for each session so you can look yourself.

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
three are always kept. Abandoned directories, without a marker, are removed after 24h too,
whether they ever held a message or not: a directory that holds messages is not protected,
because a team can also just be legitimately still running past 24h without having disbanded.
Before either kind of directory is removed, any bridge/poller process still pointing at it is
stopped first (TERM, escalating to KILL after 2s if it ignores that): a directory disappearing
out from under a live process used to leave it running for days.

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
- Retries server errors and rate limits (429, 408) with exponential backoff; other client
  errors (4xx) are skipped, not retried
- Single-instance guard (won't double-start)
- Stops promptly on TERM/INT: an in-flight retry backoff is interrupted rather than run to
  completion, and the message it was posting is not counted as delivered, so it is retried from
  the top on the next start
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
