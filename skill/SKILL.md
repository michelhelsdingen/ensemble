---
name: collab
description: Start a collaborative AI team (Codex + Claude) to work on a task together. Use when the user says "werk samen met Codex", "collab", "team onderzoek", "laat Codex en Claude samenwerken", or wants multiple AI agents to analyze, research, or solve something together autonomously.
allowed-tools: Bash, Read, Write, Agent, TaskOutput
metadata:
  author: michel
  version: 6.2.0
---

# Collab: Autonomous AI Team Collaboration

**Language rule:** ALWAYS respond in the same language the user used to invoke /collab. If the user writes in English, all your output (status updates, summaries, everything) must be in English. If Dutch, respond in Dutch. Never mix languages.

For a single review, a team is often overkill; use single-agent delegation if available.

Launch a Codex + Claude team. Runtime files are namespaced under `/tmp/ensemble/<TEAM_ID>/`.

## Script Paths

Every script lives in `__ENSEMBLE_DIR__/scripts/` and MUST be called with its full path and
`.sh` extension. They are not on `$PATH`, and the permission allowlist installed by
`setup-claude-code.sh` only covers the full paths. Calling a bare `collab-launch` fails.

Set this once per session and reuse it:

```bash
ES="__ENSEMBLE_DIR__/scripts"
```

| Script | Purpose |
|---|---|
| `collab-launch.sh` | Start a team (runs preflight, opens the monitor, arms postcheck) |
| `collab-poll.sh` | Single-shot message poll with seen-state tracking |
| `collab-status.sh` | Dashboard of active and recent collabs |
| `collab-rescue.sh` | Re-inject prompts when `messages.jsonl` stays empty |
| `collab-replay.sh` | Replay a finished session in the terminal |
| `collab-livefeed.sh` | Live colored feed (non-tmux) |
| `collab-cleanup.sh` | Remove old finished runtime dirs (dry-run by default) |
| `collab-orphans.sh` | Stop tmux sessions of teams that are over (dry-run by default) |
| `collab-smoke.sh` | Start a real team, exchange a message, break it down; `--runs N` |
| `open-herdr-monitor.sh` | Open the monitor in a herdr pane, called by launch |
| `open-orca-webfeed.sh` | Open the browser feed beside an Orca bot chat |
| `collab-preflight.sh` | Auth/DNS/service checks, auto-run by launch |
| `collab-postcheck.sh` | Agent health check ~30s after spawn, auto-armed by launch |

## Path Convention
All collab artifacts live in `/tmp/ensemble/<TEAM_ID>/`:
- `messages.jsonl` — agent + ensemble message log
- `summary.txt` — written on disband by ensemble-service
- `bridge.pid`, `bridge.log` — bridge process
- `poller.pid`, `feed.txt` — background poller
- `postcheck.log`: output of the automatic post-spawn health check
- `prompts/`, `delivery/` — agent prompt/delivery files
- `.finished` — written by ensemble-service AFTER summary.txt
- `team-id` — team ID marker
- `sessions`: this team's tmux session names, one per line, written by ensemble-service on
  every successful agent spawn; what postcheck and rescue use to only touch this team's panes

## Workflow

### Step 0: Detect environment
```bash
case "$("$ES/collab-monitor-mode.sh" "$(pwd)")" in
  herdr) echo "HERDR" ;;
  orca) echo "ORCA_PANE" ;;
  orca-webfeed) echo "ORCA_WEBFEED" ;;
  split) echo "TMUX_YES" ;;
  iterm) echo "ITERM_NATIVE" ;;
  *) echo "TMUX_NO" ;;
esac
```

Six monitor modes:
- `HERDR`: inside a herdr workspace; `collab-launch.sh` asks herdr for the split
- `ORCA_PANE`: inside an Orca terminal pane; `collab-launch.sh` opens a terminal split
- `ORCA_WEBFEED`: inside an Orca bot chat without a terminal pane; a local browser feed opens on the right
- `TMUX_YES`: already inside tmux; `collab-launch.sh` opens a split pane right
- `ITERM_NATIVE`: macOS iTerm2 without tmux; `collab-launch.sh` uses `osascript` to open a native iTerm split pane (no `tmux attach` needed)
- `TMUX_NO`: fallback: detached tmux session the user must attach to

**Check `HERDR_ENV` first, and never conclude "iTerm" from `TERM_PROGRAM` alone.**
herdr owns the terminal and draws its own panes inside a host session, but passes
`TERM_PROGRAM=iTerm.app` straight through. An AppleScript split then opens a real iTerm
pane outside the layout the user is watching: it succeeds, reports success, and is never
seen. `HERDR_ENV=1` is the reliable signal (`HERDR_PANE_ID`, `HERDR_TAB_ID` and
`HERDR_WORKSPACE_ID` name the exact pane).

Force a specific mode with `COLLAB_MONITOR=herdr|orca|orca-webfeed|tmux|iterm|none`, change the herdr layout
with `COLLAB_HERDR_MODE=split|tab`, or the iTerm layout with
`COLLAB_ITERM_MODE=split|tab|window` (both default `split`).

### Step 1: Launch the team
```bash
"$ES/collab-launch.sh" "$(pwd)" "$TASK_DESCRIPTION" [AGENTS] [TEMPLATE]
```

**Agent selection (3rd argument, optional).** Comma-separated keys from `agents.json`;
the first one becomes lead. Default when omitted: `codex` (lead) + `claude code` (worker).
Available keys: `codex`, `claude`, `grok`, `agy`, `gemini`, `glm`, `opencode` (all defined in `agents.json`).
When configured, `healthCommand` checks which agents are currently usable
and catches an unavailable CLI before launch. An unknown key is not an error: `resolveAgentProgram()`
falls back to `claude`, so a typo silently spawns a second claude instead of failing.
Only pass this when the user explicitly names agents in the task (for example, "use agy and claude").
Preflight checks only the CLIs you name here, so a codex quota wall does not block a
`grok,claude` run. Naming agents explicitly also disables the auto-fallback: a dead agent
becomes a hard failure instead of a silent swap. It travels to the team as `agentsExplicit`,
so a stalling agent is not replaced mid-run either: whoever picks their own line-up does not
get a different model added behind their back. The feed says so when it happens.

Also settable via `COLLAB_AGENTS`, for a preferred line-up you do not want to retype
(`export COLLAB_AGENTS="codex,claude,grok"`). Precedence: 3rd argument > `COLLAB_AGENTS` >
the default pair. Only the argument counts as naming your agents; `COLLAB_AGENTS` is a standing
preference and keeps the auto-fallback, with every swap printed as a warning.

**Template selection (4th argument, optional).** A key from `collab-templates.json` that
gives each agent an explicit role instead of the generic lead/worker prompt. Also settable
via `COLLAB_TEMPLATE`. Pick one when the task clearly matches:

| Template | Roles | Use when the task is |
|---|---|---|
| `review` | REVIEWER + CRITIC | reviewing existing code |
| `implement` | ARCHITECT + DEVELOPER | building a feature |
| `research` | RESEARCHER-A + RESEARCHER-B | comparing options or exploring a topic |
| `debug` | REPRODUCER + ANALYST | chasing a bug |

Leave it empty if the task does not fit cleanly. A wrong template is worse than none.

**Extract TEAM_ID** from the launch output (last line is `TEAM_ID=<id>`):
```bash
TEAM_ID=$(printf '%s\n' "$LAUNCH_OUTPUT" | sed -n 's/^TEAM_ID=//p' | tail -1)
```
Do not read `/tmp/collab-team-id.txt` unless you have no launch output: it is a single
global file that a concurrent collab overwrites.

**Check that the launch actually succeeded** before doing Step 2. `collab-launch.sh` can fail
after the team already exists: exit `3` means a team was created but the prompt never reached an
agent; exit `4` means the bridge died right after starting, and then the team keeps running without
a link to the API (a poller that does not come up is only a warning). Both print a `TEAM_ID=`
trailer anyway, but neither one printed `Team is live!`. Only tell the user the team is live when
that exact line is in the output. Neither code means the team was cleaned up: since 04-11-2026 no
script here ends a team, so say what is wrong and leave the decision to the user.

**Exits before the team exists.** Exit `7` from preflight now also covers a name that is not an
agent at all (a typo): the message names the agents that do exist, so correct the name instead of
retrying. Exit `5` means the service refused to create the team and its own reason is printed on
the next line. Both happen in about a second and no team was created, so there is nothing to clean
up and nothing to rescue.

**A quiet agent is not a failed start.** The launcher returns as soon as every pane has taken its
prompt, so a successful launch can print `nog geen bericht van: <agent>`. That agent is thinking;
the monitor will show its first message. Do not rescue it, do not relaunch, and do not tell the
user something went wrong. Only `Prompt niet aangekomen bij: <agent>` (exit 3) is a real delivery
failure: the pane took nothing. Rescue will not help until the cause is gone, so look at that
pane (`tmux attach -t <team-name>-<agent>`) and report what is on it.

**Exit `9` is not a fault to retry.** An agent CLI is sitting on a startup dialog that only the
user may answer, and the message names the CLI and the dialog. Never answer such a dialog for
them and never relaunch with `COLLAB_SKIP_STARTPROBE=1`: trusting code that may run outside the
sandbox is their decision. Tell them, in their language, which CLI it is and that they should
start it once in a normal terminal, answer the question, and then launch again. Offer to start
the team without that agent if the task allows it.

### Step 1b: Health checks (automatic, do not re-run)

- **Preflight** runs inside `collab-launch.sh` before the team is created. It checks the
  service, agent CLI auth, and DNS. Non-zero exit means launch aborted with the fix command
  printed. Do not paper over it with `COLLAB_SKIP_PREFLIGHT=1` unless the user asks.
  Exit codes: `1` service down, `2` service started in an unauthenticated shell (restart it),
  `3` claude CLI broken, `4` codex CLI broken, `5` DNS/network, `6` grok CLI broken,
  `7` health hook reports an unavailable requested agent or no healthy fallback,
  `8` the service cannot spawn agents (deleted binary or unreadable repo),
  `9` an agent CLI waits on a startup dialog only the user may answer.
  Exit `7` and `9` are also returned by the launcher unchanged. `7` lists healthy alternatives;
  for `9` see above.
  Preflight also starts every requested agent once in a throwaway tmux session, which is how it
  finds a dialog that `codex exec` and `claude auth status` cannot see, and it restarts a
  service that is older than the service code on disk.
- **Postcheck** is armed automatically and fires ~25s after spawn. It only ever looks at this
  team's own tmux sessions. If an agent is stuck in an error state, or zero messages were
  exchanged in its wait window, it kills the team and writes the diagnosis to
  `/tmp/ensemble/<TEAM_ID>/postcheck.log`. If a team dies within the first minute, read that
  file before guessing.

### Step 2: Tell the user where the monitor is

- `HERDR`: "Team is live in the new herdr pane on the right."
- `ORCA_PANE`: "Team is live in the new Orca terminal pane on the right."
- `ORCA_WEBFEED`: "Team is live in the Orca browser feed on the right."
- `TMUX_YES`: "Team is live in the right tmux pane."
- `ITERM_NATIVE`: "Team is live in the new iTerm pane on the right."
- `TMUX_NO`: "`tmux attach -t ensemble-$TEAM_ID` — live TUI monitor (steer, disband, scroll)"

### Step 3: Monitoring — the user MUST see the conversation

**CRITICAL RULE**: The user wants to SEE the team's conversation as it happens. Every poll result must be presented clearly and formatted as a readable conversation. Do NOT just dump raw output — format it as a proper dialogue.

#### If `TMUX_NO`: poll and PRESENT messages inline

Use `collab-poll.sh` — a single-shot poller that tracks state automatically and gives clean output.

**Poll command:**
```bash
"$ES/collab-poll.sh" "$TEAM_ID" --sleep <seconds>
```

Output format: `sender\tcontent` lines, ending with one of:
- `---STATUS:ACTIVE` — new messages were found
- `---STATUS:QUIET` — no new messages (agents in deep work)
- `---STATUS:DONE` — team finished, followed by summary.txt content
- `---STATUS:WAITING` — messages file not yet created

**Presentation rules — THIS IS THE KEY PART:**
After each poll, present the new messages to the user like this:

> **codex-1**: [message content]
>
> **claude-2**: [message content]

Use markdown bold for agent names. Show the FULL message content (up to 500 chars), not truncated summaries. Between polls, add a brief status line like "Team is working... next check in 15s."

**Polling cadence:**
- First poll: `--sleep 10`
- Normal: `--sleep 15` to `--sleep 20`
- If 3+ polls QUIET: `--sleep 30` (agents in deep work)
- On `---STATUS:DONE`: stop polling, present final summary

**When done**, present structured summary + clean up:
```bash
TEAM_ID="<id>" && RD="/tmp/ensemble/$TEAM_ID" && kill "$(cat "$RD/poller.pid" 2>/dev/null)" 2>/dev/null || true; kill "$(cat "$RD/bridge.pid" 2>/dev/null)" 2>/dev/null || true; tmux kill-session -t "ensemble-$TEAM_ID" 2>/dev/null || true
```

#### If `HERDR`: background summary watcher

Same as `TMUX_YES`: the monitor pane is visible to the user, so don't inline-poll. Wait for
completion in the background and present the final summary. The monitor closes its own herdr
pane on exit (pane id in `/tmp/ensemble/<TEAM_ID>/herdr-pane-id`), so no `tmux kill-session`.

#### If `ORCA_PANE` or `ORCA_WEBFEED`: background summary watcher

The monitor is visible in Orca. Wait for completion in the background and present the final
summary. The browser feed shows the last messages and summary before its local server stops.
The browser pane remains until cleanup or the user closes it.

#### If `ITERM_NATIVE`: background summary watcher

Same as `TMUX_YES`: the monitor pane is visible to the user, so don't inline-poll. Wait for completion in the background (same snippet as below) and present the final summary when done. On cleanup, the iTerm pane lives on — the user closes it with `q` or Cmd+W. Do NOT try to `tmux kill-session` (no tmux session exists in this mode).

#### If `TMUX_YES`: background summary watcher

Monitor visible in right pane. Wait in background:
```bash
TEAM_ID="<id>" && RD="/tmp/ensemble/$TEAM_ID" && while [ ! -f "$RD/.finished" ] && [ ! -f "$RD/summary.txt" ]; do sleep 8; done && echo "COLLAB_COMPLETE" && cat "$RD/summary.txt" 2>/dev/null
```
Run with `run_in_background: true`, `timeout: 600000`.

When done: summarize + cleanup poller/bridge PIDs.

## How a team ends

Auto-disband triggers on one of two paths:

1. **Explicit sentinel (preferred).** EVERY active agent sends a team-say whose entire content
   is `<<COLLAB_DONE>>`. This bypasses the message-count minimum and the idle wait. The agent
   prompts already instruct this. The bar is every agent, not two, so a third agent is never
   cut off while its teammates close up.
2. **Idle + completion signals.** A safety net for teams that go quiet without sending the
   sentinel: it needs a minimum number of exchanged messages AND at least 60s of silence.

Ordinary words like "done" or "klaar" in a status update do not kill a team while the
conversation is running. Do not warn agents to avoid those words.

## Troubleshooting

Work through these in order before reporting a failure to the user.

| Symptom | Action |
|---|---|
| Team died within a minute | `cat /tmp/ensemble/$TEAM_ID/postcheck.log`, it names the broken agent |
| Agents visible but `messages.jsonl` stays empty | `"$ES/collab-rescue.sh" "$TEAM_ID"`, re-injects the prompts the service failed to deliver |
| Launch aborted before creating a team | Preflight printed the fix command; run it, then relaunch |
| Not sure what is still running | `"$ES/collab-status.sh"` |
| `/tmp` filling up with old runs | `"$ES/collab-cleanup.sh"` (dry-run), then `--force` |
| Want to review a finished session | `"$ES/collab-replay.sh" "$TEAM_ID"`, or open the auto-generated HTML replay |

**Escalation.** Two failed rescue or relaunch attempts on the same task is the limit. Stop,
report to the user what was tried, what the logs said (`postcheck.log`, `bridge.log`,
`/tmp/ensemble-server.log`), and ask how to proceed. Never keep relaunching a team that
fails the same way. Each retry spawns real CLI sessions and burns real tokens.

## Important Notes
- Agents run with auto-accept permissions (configured in agents.json: codex `--dangerously-bypass-approvals-and-sandbox`, claude `--permission-mode auto`). They should NEVER ask for file write approval.
- Do not modify project code during a collab session unless the user explicitly asks
- Do not truncate or remove `messages.jsonl`
- Multiple collabs can run simultaneously — each has own `/tmp/ensemble/<TEAM_ID>/` namespace
- `team-say.sh` uses `fcntl.flock` for atomic JSONL writes
- `ensemble-bridge.sh` has single-instance guard, health check, exponential backoff
- `.finished` and `summary.txt` are written by ensemble-service, NOT by scripts
- Bridge auto-stops when it sees `.finished` marker

## Optional external brain integration

Configuration supports `rosterCommand`, `planCommand`, `eventsCommand`,
`replaceStalledAgents` (default false), and `maxReplacementsPerTeam` (default 2).
Use generic commands such as `"rosterCommand": "my-brain roster"`.
Environment overrides are `ENSEMBLE_ROSTER_CMD`, `ENSEMBLE_PLAN_CMD`,
`ENSEMBLE_EVENTS_CMD`, and `ENSEMBLE_REPLACE_STALLED`.

Hooks are trusted shell code invoked as `/bin/bash -c '<cmd> "$@"' ensemble-<name> <args...>`.
The entire process group is killed on timeout. Roster takes no arguments, has a
5-second timeout, and returns the healthCommand schema: agent keys mapped to
`{ "status": "ok|down|limit|slow|unknown", "detail": "optional" }`.
Plan receives task text as `$1`, has a 20-second timeout, and returns
`{ "agents": ["codex", "mimo"], "template": "implement", "reason": "Complementary roles" }`.
Extra plan fields are ignored. Explicit agents bypass planning; an explicit
template wins. Without agents, `planCommand` chooses the launcher agents and
template before preflight; planned agents keep automatic health fallback.
Failed planning uses the default team.

Events take no arguments, receive exactly one JSON line on stdin followed by EOF,
and have a 5-second timeout. Delivery is nonblocking and nonfatal, with at most one
warning per team. Common fields: `event`, `teamId`, `team`, ISO-8601 `ts`.
Types: `team_started` (`agents`, `cwd`, `branch`), `agent_ready` and `agent_done`
(`agent`), `agent_stalled` and `agent_failed` (`agent`, `detail`), `agent_replaced`
(`agent`, `replacement`, `detail`), `team_finished` (`status`: `ok|failed|stopped`,
`durationS`, `branch`, `cwd`, `detail`). Unavailable fields are omitted.

Launch with `COLLAB_WORKTREE=team` for a shared local git worktree, or send
`worktree: "team"` through the API. All local agents share its branch
`ensemble/<short-team-id>`. The worktree is retained, never automatically merged.
Path and branch appear in the summary and finish event. Replacement checks local
sessions every 20 seconds and preserves role, directory, task, and bounded recent
context. It selects an unused `fallbackOrder` key with status `ok`, using roster,
then health, then no check. Remote replacements remain on the original host. MiMo (`mimo`) is
available as an explicit agent key. Replacement never runs on a team whose agents were named
explicitly.
