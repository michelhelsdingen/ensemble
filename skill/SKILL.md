---
name: collab
description: Start a collaborative AI team (Codex + Claude) to work on a task together. Use when the user says "werk samen met Codex", "collab", "team onderzoek", "laat Codex en Claude samenwerken", or wants multiple AI agents to analyze, research, or solve something together autonomously.
allowed-tools: Bash, Read, Write, Agent, TaskOutput
metadata:
  author: michel
  version: 6.3.0
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
| `collab-wait.sh` | Wait for the summary in the background; `COLLAB_WAIT_TIMEOUT` (exit 2) means wait again |
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
| `collab-postcheck.sh` | Agent health check ~30s after spawn, auto-armed by launch; only reports, stops at once for a team that is already over |

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

### Step 0: Start directly, do not pre-check

Do not run a mode check or a plan check first. `collab-launch.sh` decides the agent line-up and the
monitor itself and prints the result, so read it from the launch output (Step 1): the
`Plan: agents=...` line, `MONITOR_MODE=<mode>` and `TEAM_ID=<id>`.

The monitor is chosen from the directory the launch is started in (the caller's physical `$PWD`),
not from the team's working directory. `MONITOR_MODE` is the mode that was really used, including a
fallback to `session` when the chosen monitor could not be opened:

| `MONITOR_MODE` | Meaning | Tell the user (Step 2) |
|---|---|---|
| `herdr` | inside a herdr workspace; herdr opened a split | "Team is live in the new herdr pane on the right." |
| `orca` | inside an Orca terminal pane; a terminal split opened | "Team is live in the new Orca terminal pane on the right." |
| `orca-webfeed` | inside an Orca bot chat without a terminal pane; a local browser feed opened on the right | "Team is live in the Orca browser feed on the right." |
| `split` | already inside tmux; a pane opened on the right | "Team is live in the right tmux pane." |
| `iterm` | macOS iTerm2 without tmux; a native iTerm split opened (no `tmux attach` needed) | "Team is live in the new iTerm pane on the right." |
| `session` | fallback: detached tmux session the user must attach to | "`tmux attach -t ensemble-$TEAM_ID`: live TUI monitor (steer, disband, scroll)" |
| `none` | no monitor (`COLLAB_MONITOR=none`, or the launch stopped before one was opened) | say that no monitor is open |

**herdr is checked before iTerm, and `TERM_PROGRAM` alone never means iTerm.**
herdr owns the terminal and draws its own panes inside a host session, but passes
`TERM_PROGRAM=iTerm.app` straight through. An AppleScript split then opens a real iTerm
pane outside the layout the user is watching: it succeeds, reports success, and is never
seen. `HERDR_ENV=1` is the reliable signal (`HERDR_PANE_ID`, `HERDR_TAB_ID` and
`HERDR_WORKSPACE_ID` name the exact pane). The launcher already does this; you only read the result.

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
and catches an unavailable CLI before launch. A name that is not an agent is an error: preflight stops with exit `7`
and names the agents that do exist (see the exit code table below).
Only pass this when the user explicitly names agents in the task (for example, "use agy and claude").
Preflight checks only the CLIs you name here, so a codex quota wall does not block a
`grok,claude` run. Naming agents explicitly also disables the auto-fallback: a dead agent
becomes a hard failure instead of a silent swap. It travels to the team as `agentsExplicit`,
so a stalling agent is not replaced mid-run either: whoever picks their own line-up does not
get a different model added behind their back. The feed says so when it happens.

Also settable via `COLLAB_AGENTS`, for a preferred line-up you do not want to retype
(`export COLLAB_AGENTS="codex,claude,grok"`). Precedence: 3rd argument > `COLLAB_AGENTS` >
the configured plan (`planCommand`) > the default pair. Only the argument counts as naming your agents; `COLLAB_AGENTS` is a standing
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

**Read three things from the launch output**, which ends with `MONITOR_MODE=<mode>` and
`TEAM_ID=<id>` (that order, also on the failure paths that already print `TEAM_ID=`), and which
contains one `Plan: agents=<keys>, template=<name or none>` line:
```bash
TEAM_ID=$(printf '%s\n' "$LAUNCH_OUTPUT" | sed -n 's/^TEAM_ID=//p' | tail -1)
MONITOR_MODE=$(printf '%s\n' "$LAUNCH_OUTPUT" | sed -n 's/^MONITOR_MODE=//p' | tail -1)
PLAN=$(printf '%s\n' "$LAUNCH_OUTPUT" | sed -n 's/^Plan: //p' | tail -1)
```
Use `PLAN` to tell the user which agents run. Do not read `/tmp/collab-team-id.txt` unless you
have no launch output: it is a single global file that a concurrent collab overwrites.

**Check the exit code before Step 2.** Only tell the user the team is live when the output has the
exact line `Team is live!` and the exit code is `0`. `collab-launch.sh` exits with:

| Exit | Team exists? | Meaning | Do |
|---|---|---|---|
| `0` | yes | started; `Team is live!` is printed. `nog geen bericht van: <agent>` is fine: that agent is thinking | go to Step 2 |
| `1` | no | preflight failed (service, auth, DNS or CLI problem) or the server did not start; the fix command is printed | run the fix, relaunch once |
| `3` | yes | the prompt never reached an agent (`Prompt niet aangekomen bij: <agent>`) | look at that pane (`tmux attach -t <team-name>-<agent>`), report what is on it; rescue only helps once the cause is gone |
| `4` | yes | the bridge died right after starting; the team keeps running without a link to the API (a poller that does not come up is only a warning) | report it; the printed bridge command restarts it |
| `5` | no | the service refused to create the team, its own reason is on the next line | correct the cause; nothing to clean up or rescue |
| `7` | no | preflight: an unavailable requested agent, no healthy fallback, or a name that is not an agent (typo; the message lists the agents that exist) | correct the name or pick a healthy agent; `7` lists healthy alternatives |
| `9` | no | preflight: an agent CLI waits on a startup dialog only the user may answer; the message names the CLI and the dialog | see below |

Exits `3` and `4` print `MONITOR_MODE=` and `TEAM_ID=` trailers anyway, and neither means the team was
cleaned up: no script here ends a team, so say what is wrong and leave the decision to the user. A
quiet agent is not a failed start: do not rescue it, do not relaunch, and do not tell the user
something went wrong.

**Exit `9` is not a fault to retry.** Never answer such a dialog for the user and never relaunch
with `COLLAB_SKIP_STARTPROBE=1`: trusting code that may run outside the sandbox is their decision.
Tell them, in their language, which CLI it is and that they should start it once in a normal
terminal, answer the question, and then launch again. Offer to start the team without that agent if
the task allows it.

### Step 1b: Health checks (automatic, do not re-run)

- **Preflight** runs inside `collab-launch.sh` before the team is created. It checks the
  service, agent CLI auth, and DNS. Do not paper over a failure with `COLLAB_SKIP_PREFLIGHT=1`
  unless the user asks. Preflight also starts every requested agent once in a throwaway tmux
  session, which is how it finds a dialog that `codex exec` and `claude auth status` cannot see,
  and it restarts a service that is older than the service code on disk.

  | Preflight exit | Meaning | Launcher exit |
  |---|---|---|
  | `1` | service down | `1` |
  | `2` | service started in an unauthenticated shell (restart it) | `1` |
  | `3` | claude CLI broken | `1` |
  | `4` | codex CLI broken | `1` |
  | `5` | DNS/network | `1` |
  | `6` | grok CLI broken | `1` |
  | `7` | health hook reports an unavailable requested agent or no healthy fallback, or the name is not an agent | `7` |
  | `8` | the service cannot spawn agents (deleted binary or unreadable repo) | `1` |
  | `9` | an agent CLI waits on a startup dialog only the user may answer | `9` |

  Only `7` and `9` reach you unchanged; every other preflight failure is exit `1` from the launcher,
  with the preflight message printed above it.
- **Postcheck** is armed automatically and fires ~25s after spawn. It only looks at this team's own
  tmux sessions and it never ends a team. It exits `0` at once for a team that already has `.finished`
  or is disbanded. Otherwise, if an agent is in an error state it prints the diagnosis and exits `2`;
  if the service says a prompt was never delivered (or knows nothing and no message arrived), it names
  the silent agents, prints a rescue command and exits `2`. The output is in
  `/tmp/ensemble/<TEAM_ID>/postcheck.log`. Read that file before guessing, and remember the team is
  still running.

### Step 2: Tell the user where the monitor is

Use the message for `MONITOR_MODE` from the table in Step 0, together with `PLAN`.

### Step 3: Monitoring — the user MUST see the conversation

**CRITICAL RULE**: The user wants to SEE the team's conversation as it happens. Every poll result must be presented clearly and formatted as a readable conversation. Do NOT just dump raw output — format it as a proper dialogue.

#### If `MONITOR_MODE` is `session` or `none`: poll and PRESENT messages inline

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

#### If `herdr`: background summary watcher

Same as `split`: the monitor pane is visible to the user, so don't inline-poll. Wait for
completion in the background (see `split`) and present the final summary. The monitor closes its own herdr
pane on exit (pane id in `/tmp/ensemble/<TEAM_ID>/herdr-pane-id`), so no `tmux kill-session`.

#### If `orca` or `orca-webfeed`: background summary watcher

The monitor is visible in Orca. Wait for completion in the background (see `split`) and present the
final summary. The browser feed keeps the last state and the summary on the page and says
"Team afgerond, feed gestopt" once its local server has stopped. Its pane stays open for the user to
read the result; do not close it.

#### If `iterm`: background summary watcher

Same as `split`: the monitor pane is visible to the user, so don't inline-poll. Wait for completion in the background (see `split`) and present the final summary when done. On cleanup, the iTerm pane lives on: the user closes it with `q` or Cmd+W. Do NOT try to `tmux kill-session` (no tmux session exists in this mode).

#### If `split`: background summary watcher

Monitor visible in right pane. Wait in the background with the wait script, with
`run_in_background: true` and `timeout: 3600000`:
```bash
"$ES/collab-wait.sh" "$TEAM_ID"
```
It looks every 2 seconds for `.finished` or `summary.txt`. On completion it prints `COLLAB_COMPLETE`
followed by the summary and exits `0`. After 3300 seconds (`--max <s>` changes that) it prints
`COLLAB_WAIT_TIMEOUT` and exits `2`: the team is still running, so start the same command again.
Measured runs took up to 21 minutes, so expect to wait more than once only for unusually long runs.
Exit `1` means the team directory does not exist.

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
| Postcheck reported a problem, or the team seems stuck | `cat /tmp/ensemble/$TEAM_ID/postcheck.log`, it names the broken or silent agent; the team is still running |
| An agent never got its prompt (exit `3`, or postcheck names it, and the cause is fixed) | `"$ES/collab-rescue.sh" "$TEAM_ID" <agent>`, re-injects the prompt the service failed to deliver. Without a team id it only works when exactly one team is active; with more it stops and lists them |
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
