---
title: Configuration
nav_order: 3
---

# Configuration

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ENSEMBLE_PORT` | `23000` | Server listening port |
| `ENSEMBLE_URL` | `http://localhost:23000` | CLI target URL |
| `ENSEMBLE_DATA_DIR` | `~/.ensemble` | Data directory for team persistence |
| `ENSEMBLE_CORS_ORIGIN` | localhost only | Comma-separated allowed CORS origins |
| `ENSEMBLE_PROJECT` | auto-detect | Project name for summaries |
| `ENSEMBLE_AGENTS_CONFIG` | Project `agents.json` | Path to replacement base agents config |
| `ENSEMBLE_AGENTS_EXTRA` | `~/.config/ensemble/agents.json` | Path to optional user agents config |
| `ENSEMBLE_AGENT_FLAGS` | — | Override agent CLI flags |
| `ENSEMBLE_WATCHDOG_NUDGE_MS` | `90000` | Time (ms) before idle agent nudge |
| `ENSEMBLE_WATCHDOG_STALL_MS` | `180000` | Time (ms) before stall detection |
| `ENSEMBLE_TELEGRAM_BOT_TOKEN` | — | Telegram bot token for notifications |
| `ENSEMBLE_TELEGRAM_CHAT_ID` | — | Telegram chat ID for notifications |
| `ENSEMBLE_CREATED_BY` | `$USER` | Creator ID for team metadata |

### Example `.env`

```bash
ENSEMBLE_PORT=23000
ENSEMBLE_TELEGRAM_BOT_TOKEN=123456:ABC-DEF
ENSEMBLE_TELEGRAM_CHAT_ID=your-chat-id
```

---

## Agent programs (agents.json)

The project `agents.json` file defines which AI agents ensemble can spawn. `ENSEMBLE_AGENTS_CONFIG` replaces this base list. An optional user file at `~/.config/ensemble/agents.json` is loaded on top; set `ENSEMBLE_AGENTS_EXTRA` to use a different path.

```json
{
  "codex": {
    "name": "codex",
    "command": "codex",
    "flags": ["--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust"],
    "readyMarker": "›",
    "inputMethod": "pasteFromFile",
    "color": "blue",
    "icon": "◆"
  },
  "claude": {
    "name": "claude",
    "command": "claude",
    "flags": ["--permission-mode", "auto"],
    "readyMarker": "❯",
    "inputMethod": "sendKeys",
    "color": "green",
    "icon": "●"
  },
  "glm": {
    "name": "glm",
    "command": "glm",
    "flags": ["--permission-mode", "auto"],
    "readyMarker": "\u276f",
    "inputMethod": "sendKeys",
    "color": "magenta",
    "icon": "\u25c8"
  },
  "grok": {
    "name": "grok",
    "command": "grok",
    "flags": ["--always-approve", "--trust"],
    "readyMarker": "❯",
    "inputMethod": "pasteFromFile",
    "color": "white",
    "icon": "✕"
  }
}
```

> **Model selection:** By default, each agent uses its own default model. To specify a model, add it to the `flags` array, e.g. `["--dangerously-bypass-approvals-and-sandbox", "-m", "o3"]` for Codex or `["--permission-mode", "auto", "--model", "sonnet"]` for Claude. Check each agent's docs for available models.
>
> **Codex users:** `--full-auto` was removed in Codex CLI 0.147.0. If you copied it from an older config, `codex exec` now exits with `unexpected argument '--full-auto' found`. Use `--sandbox workspace-write` for a sandboxed run, or the bypass flag above for the unattended one ensemble ships with.
```

### Fields

| Field | Type | Description |
|---|---|---|
| `name` | string | Unique identifier (used in API) |
| `command` | string | CLI command to launch the agent |
| `flags` | string[] | Default CLI arguments |
| `readyMarker` | string | Terminal prompt character (readiness detection) |
| `inputMethod` | `"pasteFromFile"` or `"sendKeys"` | How to deliver multi-line prompts |
| `color` | string | Display color in TUI monitor |
| `icon` | string | Single character icon for TUI |

### Adding a custom agent

Any CLI tool that reads from stdin and writes to stdout can be an ensemble agent. Create `~/.config/ensemble/agents.json`, or set `ENSEMBLE_AGENTS_EXTRA` to another file, with an entry like this:

```json
{
  "my-agent": {
    "name": "my-agent",
    "command": "/usr/local/bin/my-agent",
    "flags": ["--auto"],
    "readyMarker": ">",
    "inputMethod": "sendKeys",
    "color": "cyan",
    "icon": "▶"
  }
}
```

New keys are added to the base list. If a key already exists, the user entry replaces the entire base entry, so include every required field. Invalid entries are skipped with a warning, and a missing or unreadable user file leaves the base list available. Changes to either file are picked up without restarting the service. `ENSEMBLE_AGENTS_CONFIG` still replaces the base list before the user file is applied.

The agent must support `team-say` and `team-read` shell commands in its PATH for inter-agent communication.

### Supported agents

The default team is **Codex (lead) + Claude Code (worker)**. This is the fully tested combination.

**What "tested" means here.** Every agent below was started for real and timed, on 03 and
04-11-2026: 56 launches for `codex`, `claude`, `glm` and `grok`, and then `agy`, `mimo` and
`opencode` one at a time plus in pairs. Time from the command to the team being live, and time
until the agent sent its own first message: `opencode` 11.5s/14.7s, `glm` 9.7s/60.5s, `mimo`
16.8s/145.7s, `agy` 21.2s/30.6s. In pairs (two runs each): `agy`+`opencode` 13.9s, `mimo`+`glm`
17.5s, `codex`+`claude` 15.7s, `glm`+`grok` 10.9s, all passing. `gemini` is the one entry with no
measured start: its CLI is not installed here, and `agy` covers Google's models instead. Note the
spread in that second number: it is the model thinking, not ensemble starting, which is why the
launcher reports a team as live on delivery and not on the first message.

| Agent | Status | Default? | Notes |
|---|---|---|---|
| **Codex** | Fully tested | Yes (lead) | Uses `pasteFromFile` input, `--dangerously-bypass-approvals-and-sandbox` and `--dangerously-bypass-hook-trust` flags |
| **Claude Code** | Fully tested | Yes (worker) | Uses `sendKeys` input |
| **Grok CLI** | Tested in three-agent teams | No | Uses `pasteFromFile`, `--always-approve --trust`. Needs `hints = { project_picker_disabled = true }` in `~/.grok/config.toml`, otherwise the agent hangs on a directory picker in a fresh pane. |
| **Antigravity CLI (`agy`)** | Configured | No | Uses `sendKeys`, `--dangerously-skip-permissions`, and unsets `GEMINI_API_KEY` and `GOOGLE_API_KEY` before launch. |
| **Gemini CLI** | Experimental | No | Uses `pasteFromFile`, `--yolo` flag. May stop responding due to free-tier rate limits or internal TUI issues. Use a paid API key (`gemini /auth`) for best results. |
| **GLM** | Tested in four-agent teams | No | Runs Claude Code against the Z.ai endpoint, so it behaves like `claude` (`sendKeys`, `--permission-mode auto`) with a GLM model underneath. Needs a `glm` command on PATH that sets `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`. |
| **MiMo Code CLI** | Configured | No | `mimo`, `--trust --dangerously-skip-permissions`, file-based prompt delivery |
| **opencode** | Untested | No | Basic config included in `agents.json`, `sendKeys` input |
| **Any CLI tool** | Custom | No | See [Adding a custom agent](#adding-a-custom-agent) |

#### How to use a non-default agent

You don't need to change any config. Just tell ensemble which agents you want:

```bash
# Via collab-launch.sh (first agent = lead, rest = workers)
./scripts/collab-launch.sh "$(pwd)" "Security audit" codex,claude,agy

# Via /collab in Claude Code — name the agents in your prompt
/collab "Review auth with agy and claude"

# Via API — specify the agents array
```

### Input methods

- **`sendKeys`** — Types the prompt character by character into the tmux pane. Works with most agents. Simpler but slower for large prompts.
- **`pasteFromFile`** — Writes the prompt to a temp file and pastes it via tmux buffer. Faster for large prompts. Required by Codex and Gemini CLI.

---

## Collab templates (collab-templates.json)

Pre-defined team configurations for common tasks. Each template assigns specialized roles to the agents:

| Template | Description | Roles |
|---|---|---|
| `review` | Code Review | Reviewer + Critic |
| `implement` | Implementation | Architect + Developer |
| `research` | Research | Researcher-A + Researcher-B |
| `debug` | Debug | Reproducer + Analyst |

Use via API: `"templateName": "review"` in the create team request. The template assigns roles and focus areas automatically.

---

## Multi-host setup

Run agents on different machines. Configure in `~/.ensemble/hosts.json`:

```json
{
  "hosts": [
    {
      "id": "local",
      "name": "laptop",
      "url": "http://localhost:23000",
      "enabled": true
    },
    {
      "id": "gpu-server",
      "name": "Remote GPU",
      "url": "http://192.168.1.100:23000",
      "enabled": true
    }
  ]
}
```

Each host runs its own ensemble server. Agents specify `hostId` to control placement:

```json
{
  "agents": [
    { "program": "claude", "hostId": "local" },
    { "program": "codex", "hostId": "gpu-server" }
  ]
}
```

Host discovery order: exact hostname match → `"local"` keyword → IP match → URL match.

---

## Telegram notifications

Get notified when teams finish. Set up:

1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Get your chat ID (send `/start` to your bot, then check `https://api.telegram.org/bot<token>/getUpdates`)
3. Set environment variables:

```bash
export ENSEMBLE_TELEGRAM_BOT_TOKEN="123456:ABC-DEF..."
export ENSEMBLE_TELEGRAM_CHAT_ID="your-chat-id"
```

Notifications include: team name, duration, message count, and a brief summary.

---

## Claude Code integration

Ensemble integrates with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) as a `/collab` slash command. This lets you type `/collab "review the auth module"` and Claude will spawn a Codex + Claude team, monitor their conversation, and present results — all without leaving your terminal.

### Quick setup (one command)

From the ensemble directory, run:

```bash
./scripts/setup-claude-code.sh
```

This automatically:
- Installs the `/collab` skill to `~/.claude/skills/collab/`
- Adds script permissions to `~/.claude/settings.json`
- Verifies all prerequisites (Node.js, tmux, Python, agent CLIs)
- Confirms everything is ready

### Manual setup

If you prefer to set things up manually:

**Step 1:** Copy the skill file:

```bash
mkdir -p ~/.claude/skills/collab
cp /path/to/ensemble/skill/SKILL.md ~/.claude/skills/collab/SKILL.md
```

**Step 2:** Add permissions to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "Bash(/path/to/ensemble/scripts/collab-launch.sh:*)",
      "Bash(/path/to/ensemble/scripts/collab-poll.sh:*)",
      "Bash(/path/to/ensemble/scripts/collab-status.sh:*)"
    ]
  }
}
```

Replace `/path/to/ensemble` with the actual path where you cloned the repo.

### Use it

In any Claude Code session:

```
/collab "Review the authentication module for security issues"
```

Claude Code will:
1. Start the ensemble server (if not running)
2. Spawn a Codex + Claude team
3. Show the agent conversation inline as it happens
4. Present a summary when the team finishes

You can also say things like "werk samen met Codex" or "start a collab team" — Claude Code recognizes these as triggers for the collab skill.

### How it works

The `/collab` skill tells Claude Code to:
1. Run `collab-launch.sh` to create the team
2. Poll `collab-poll.sh` for new messages every 15-30 seconds
3. Present each agent's messages as formatted dialogue
4. Clean up when the team finishes or is disbanded

In tmux, the TUI monitor opens in a split pane. Without tmux, messages are polled and displayed inline.

---

## Git worktrees (optional)

Each agent can work in an isolated git worktree:

```json
{
  "useWorktrees": true
}
```

When enabled:
- Each agent gets a separate branch (`team-{name}-{agent}`)
- Changes are automatically merged back on disband
- Prevents file conflicts between agents working on the same repo

---

## Security notes

Ensemble is designed for **local development use**. Be aware:

- No built-in API authentication (rate limiting by IP only)
- Agents run with permissive flags to support unattended execution
- Server binds to localhost by default
- Do **not** expose to the internet without adding authentication

For production use, consider running behind a reverse proxy with auth.

### Why agents need permissive flags

Ensemble agents run autonomously inside `tmux` sessions without a human at the terminal. The flags in `agents.json` remove interactive confirmation prompts so the agents can actually complete work:

| Flag | Agent | Purpose |
|---|---|---|
| `--permission-mode auto` | Claude Code | Allows tool execution, file edits, and shell commands without interactive permission prompts. |
| `--dangerously-bypass-hook-trust` | Codex | Runs already-enabled lifecycle hooks without the startup trust review. Without it, Codex opens a blocking "Hooks need review" dialog whenever a hook is new or changed, which only a human can answer: that aborts preflight (exit 9) and takes the whole team down. A hook the user declined stays disabled, so this flag never enables anything they turned off. It is a trust bypass, so only use it where the hook sources are the operator's own. |
| `--dangerously-bypass-approvals-and-sandbox` | Codex | Runs without approval prompts or sandbox. Replaces the `--full-auto` flag that Codex CLI removed in 0.147.0; the sandboxed equivalent is `--sandbox workspace-write`. |
| `--always-approve --trust` | Grok CLI | Skips per-action approval and the folder-trust dialog. |

These flags are acceptable in the ensemble context because:

- The server binds to `127.0.0.1` only
- Agents operate inside the working directory you specify
- Each team is isolated in its own `tmux` session
- You can monitor agent behavior live via the TUI and message feed

If you add custom agents, grant only the minimum flags required for autonomous operation.

`unsetEnv` is an optional array in each `agents.json` entry. Names must match
`[A-Z_][A-Z0-9_]*`; invalid entries reject the configuration. The spawner unsets
these variables after environment exports, including `agentEnv`, before launching
the CLI. For agy this prevents inherited API keys from selecting paid API tokens
instead of subscription authentication. Its trust prompt uses the existing startup
gate, which confirms the preselected "Yes, I trust this folder" option.
