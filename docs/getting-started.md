---
title: Getting Started
nav_order: 2
---

# Getting Started

## Prerequisites

| Requirement | Why |
|---|---|
| **Node.js 18+** | Runtime for the ensemble server |
| **tmux** | Always used to run the agents themselves. Also the live TUI monitor on Linux; on macOS the monitor uses an iTerm2 or herdr pane instead (see below) |
| **Python 3.6+** | Used by collab scripts for message parsing |
| **curl** | Used in scripts and examples |
| **macOS or Linux** | Shell scripts require a Unix environment |
| **Codex + Claude Code CLIs** | The default agent pair, codex as lead ([Codex](https://github.com/openai/codex), [Claude Code](https://docs.anthropic.com/en/docs/claude-code)) |

> **Platform support:** Ensemble runs on macOS and Linux only. Windows (including WSL) is not tested or supported.

### Monitor: where the live view opens

The live TUI monitor is just a viewer, and it opens wherever you already are:

| Situation | Monitor |
|---|---|
| Inside a [herdr](https://github.com/herdrdev/herdr) workspace | herdr pane (checked first) |
| Already inside tmux | tmux split pane |
| macOS + iTerm2, not in tmux | native iTerm2 split pane via `osascript` |
| Linux, or no iTerm2 | detached tmux session (`tmux attach -t ensemble-<team-id>`) |

On Linux you get the tmux path, which is the one to expect if you are following this guide on a
server. Override with `COLLAB_MONITOR=herdr|tmux|iterm|none`, and change the layout with
`COLLAB_ITERM_MODE=split|tab|window` or `COLLAB_HERDR_MODE=split|tab`.

### Install tmux

Required on every platform: agents always run inside tmux sessions, even when the monitor does not.

```bash
# macOS
brew install tmux

# Ubuntu/Debian
sudo apt install tmux

# Verify
tmux -V
```

### Install AI agent CLIs

You need **both Codex and Claude Code** installed (the default team, codex leads):

```bash
# Claude Code (Anthropic)
npm install -g @anthropic-ai/claude-code

# Codex (OpenAI)
npm install -g @openai/codex
```

> **Want to use other agents?** Ensemble is agent-agnostic. You can add Grok, Gemini CLI (experimental), Aider, or any CLI tool via `agents.json`, and run teams of three. See [Configuration → Supported Agents](configuration#supported-agents) for details.

Each agent CLI manages its own API keys. Make sure they're configured before running ensemble:

| Agent | Auth setup | Where to get a key |
|---|---|---|
| **Claude Code** | Run `claude auth login` (opens browser) or set `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com/) |
| **Codex** | Run `codex login` (ChatGPT account) or set `OPENAI_API_KEY` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| **Grok** (optional) | Run `grok login`, then add `hints = { project_picker_disabled = true }` to `~/.grok/config.toml` | [x.ai](https://x.ai/) |

```bash
# Example: add to your ~/.zshrc or ~/.bashrc
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
```

> **Cost note:** Each agent uses its own API credits, so a third agent is roughly a third more. A typical two-agent session of ~10 minutes costs roughly $0.10 to $0.50 depending on task complexity and models used.

> **Tip:** Test that your agent CLI works standalone before using it with ensemble. Run `claude --version` or `codex --version` to verify installation, then try a simple prompt to confirm your API key works.

---

## Install & Run

### 1. Clone and install

```bash
git clone https://github.com/michelhelsdingen/ensemble.git
cd ensemble
npm install
```

### 2. Start the server

Open a terminal and keep it running:

```bash
npm run dev
```

You should see: `[Ensemble] Server running on http://127.0.0.1:23000`

On macOS, `./scripts/install-launchd.sh` registers the server as a launchd agent
instead: it starts at login, restarts after a crash, and logs to
`/tmp/ensemble-server.log`. Run it from a shell where your agent CLIs work; the
agent inherits that shell's PATH. Remove it again with `--uninstall`.

### 3. Verify (in a second terminal)

```bash
curl http://localhost:23000/api/v1/health
```

Expected response:
```json
{"status":"healthy","version":"1.0.0"}
```

> **Troubleshooting:** If you get "Connection refused", make sure `npm run dev` is still running in your other terminal. If port 23000 is in use, you'll see a clear error message suggesting you check for other ensemble instances.

---

## Your first team

### Option 1: Via the CLI (easiest)

```bash
# Check server status
npx ensemble status

# List teams (empty at first)
npx ensemble teams
```

### Option 2: Via API (curl)

Create a team with two agents reviewing your project:

```bash
curl -X POST http://localhost:23000/api/ensemble/teams \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-first-team",
    "description": "Review the README and suggest improvements",
    "agents": [
      { "program": "claude", "role": "lead" },
      { "program": "codex", "role": "worker" }
    ],
    "workingDirectory": "'$(pwd)'"
  }'
```

> **Note:** Replace `$(pwd)` with the path to the project you want the agents to work on.

The response includes the team `id` — you'll need it for the next steps.

### Option 3: Via collab script (Claude Code integration)

If you use Claude Code, the collab script wraps everything into one command:

```bash
./scripts/collab-launch.sh "$(pwd)" "Review the README and suggest improvements"
```

This creates a team, runs preflight, starts the bridge, opens a TUI monitor, and begins the collaboration automatically. On macOS the monitor pops up in a new iTerm2 or herdr pane, so you do not need to attach to anything. On Linux it starts a detached tmux session and prints the attach command.

### Watch it live

On macOS the monitor is already visible in the pane that `collab-launch` opened. On Linux, attach to the tmux session it printed. To (re)open it manually:

```bash
# Open the TUI monitor (replace <team-id> with your actual team ID)
npx ensemble monitor <team-id>

# Or monitor the most recent team
npx ensemble monitor --latest

# Linux / tmux fallback: attach to the detached session
tmux attach -t ensemble-<team-id>
```

### Monitor keybindings

| Key | Action |
|---|---|
| `s` | Steer entire team (send a message) |
| `1`-`4` | Steer specific agent by number |
| `j`/`k` | Scroll message history |
| `d` | Disband team (stop and summarize) |
| `q` | Quit monitor |

### Steer and disband

```bash
# Send a steering message to redirect the team
npx ensemble steer <team-id> "Focus on the auth module instead"

# Or via API
curl -X POST http://localhost:23000/api/ensemble/teams/<team-id> \
  -H "Content-Type: application/json" \
  -d '{"from": "user", "to": "team", "content": "Focus on the auth module"}'

# Disband (stop the team and get a summary)
curl -X DELETE http://localhost:23000/api/ensemble/teams/<team-id>
```

---

## What happens under the hood

1. **Server receives team request**: validates agents, creates team record
2. **Agents spawn**: each gets its own tmux session with the task prompt
3. **Communication**: agents use `team-say`/`team-read` scripts to exchange messages
4. **Bridge**: the ensemble-bridge polls for new messages and delivers them between agents
5. **Monitor**: TUI shows the conversation in real time
6. **Auto-disband**: when every agent has sent the completion sentinel, the team wraps up automatically
7. **Summary**: results are persisted and optionally sent via Telegram

---

## Common issues

| Problem | Solution |
|---|---|
| "Connection refused" on curl | Make sure `npm run dev` is running in another terminal |
| "Port 23000 already in use" | Another ensemble server is running. Stop it or use a different port via `ENSEMBLE_PORT` |
| Agent doesn't respond | Run `./scripts/collab-preflight.sh` on its own. It probes each CLI you name and prints the exact failure and fix |
| "command not found: tmux" | Install tmux (see prerequisites above) |

---

## Next steps

- [Configuration](configuration): customize agents, ports, hosts, Telegram notifications
- [API Reference](api): all HTTP endpoints with examples
- [CLI Reference](cli): command line usage and monitor keybindings
- [Collab Scripts](collab-scripts): shell scripts for Claude Code integration
- [Architecture](architecture): how it all fits together
