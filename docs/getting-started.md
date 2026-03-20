---
title: Getting Started
---

# Getting Started

## Prerequisites

| Requirement | Why |
|---|---|
| **Node.js 18+** | Runtime for the ensemble server |
| **tmux** | Agent sessions run in tmux panes |
| **Python 3.6+** | Used by collab scripts for message parsing |
| **At least one AI agent CLI** | e.g. `claude`, `codex`, `aider`, `gemini` |

### Install tmux

```bash
# macOS
brew install tmux

# Ubuntu/Debian
sudo apt install tmux

# Verify
tmux -V
```

### Install AI agent CLIs

Ensemble supports any CLI-based AI agent. The most common:

```bash
# Claude Code (Anthropic)
npm install -g @anthropic-ai/claude-code

# Codex (OpenAI)
npm install -g @openai/codex

# Aider
pip install aider-chat

# Gemini CLI
npm install -g @anthropic-ai/gemini  # or your preferred method
```

You need **API keys** for your agents — each agent CLI handles its own authentication:

| Agent | Auth setup |
|---|---|
| **Claude Code** | `claude auth login` or set `ANTHROPIC_API_KEY` |
| **Codex** | Set `OPENAI_API_KEY` in your environment |
| **Aider** | Set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` |
| **Gemini** | Set `GOOGLE_API_KEY` or use `gcloud auth` |

Ensemble doesn't manage agent API keys — it spawns agents as CLI processes, and each agent uses whatever credentials you've configured in your shell environment.

---

## Install & Run

```bash
git clone https://github.com/michelhelsdingen/ensemble.git
cd ensemble
npm install
```

### Start the server

```bash
npm run dev
```

The server starts on `http://localhost:23000`. Verify:

```bash
curl http://localhost:23000/api/v1/health
# → {"status":"healthy","version":"1.0.0"}
```

---

## Your first team

### Option 1: Via API

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
    "workingDirectory": "/path/to/your/project"
  }'
```

### Option 2: Via collab script (Claude Code integration)

If you use Claude Code, the collab script wraps everything:

```bash
./scripts/collab-launch.sh "$(pwd)" "Review the README and suggest improvements"
```

This creates a team, starts a bridge, opens a monitor, and begins the collaboration.

### Watch it live

```bash
# TUI monitor (if team ID is abc-123)
npx tsx cli/monitor.ts abc-123

# Or attach to the tmux monitor session
tmux attach -t ensemble-abc-123
```

### Monitor keybindings

| Key | Action |
|---|---|
| `s` | Steer entire team |
| `1`/`2` | Steer specific agent |
| `j`/`k` | Scroll message history |
| `d` | Disband team |
| `q` | Quit monitor |

---

## What happens under the hood

1. **Server receives team request** — validates agents, creates team record
2. **Agents spawn** — each gets a tmux session with the task prompt
3. **Communication** — agents use `team-say`/`team-read` shell commands
4. **Bridge** — the ensemble-bridge polls for new messages and delivers them
5. **Monitor** — TUI shows the conversation in real time
6. **Auto-disband** — when agents signal completion, the team wraps up
7. **Summary** — final results are persisted and optionally sent via Telegram

---

## Next steps

- [Configuration](configuration) — customize agents, ports, hosts
- [API Reference](api) — all HTTP endpoints
- [Collab Scripts](collab-scripts) — shell integration for Claude Code
