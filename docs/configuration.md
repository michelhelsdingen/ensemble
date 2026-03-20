---
title: Configuration
---

# Configuration

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ENSEMBLE_PORT` | `23000` | Server listening port |
| `ENSEMBLE_URL` | `http://localhost:23000` | CLI target URL |
| `ENSEMBLE_DATA_DIR` | `~/.aimaestro` | Data directory for team persistence |
| `ENSEMBLE_HOST_ID` | `local` | Host identifier for agent spawning |
| `ENSEMBLE_CORS_ORIGIN` | localhost only | Comma-separated allowed CORS origins |
| `ENSEMBLE_PROJECT` | auto-detect | Project name for summaries |
| `ENSEMBLE_AGENTS_CONFIG` | `./agents.json` | Path to custom agents config |
| `ENSEMBLE_AGENT_FLAGS` | — | Override agent CLI flags |
| `ENSEMBLE_WATCHDOG_NUDGE_MS` | `90000` | Time (ms) before idle agent nudge |
| `ENSEMBLE_WATCHDOG_STALL_MS` | `180000` | Time (ms) before stall detection |
| `ENSEMBLE_TELEGRAM_BOT_TOKEN` | — | Telegram bot token for notifications |
| `ENSEMBLE_TELEGRAM_CHAT_ID` | — | Telegram chat ID for notifications |
| `ENSEMBLE_CREATED_BY` | `$USER` | Creator ID for team metadata |

### Example `.env`

```bash
ENSEMBLE_PORT=23000
ENSEMBLE_HOST_ID=macbook
ENSEMBLE_TELEGRAM_BOT_TOKEN=123456:ABC-DEF
ENSEMBLE_TELEGRAM_CHAT_ID=your-chat-id
```

---

## Agent programs (agents.json)

The `agents.json` file defines which AI agents ensemble can spawn. Located in the project root by default, override with `ENSEMBLE_AGENTS_CONFIG`.

```json
{
  "codex": {
    "name": "codex",
    "command": "codex",
    "flags": ["--full-auto", "-m", "gpt-5.4"],
    "readyMarker": "›",
    "inputMethod": "pasteFromFile",
    "color": "blue",
    "icon": "◆"
  },
  "claude": {
    "name": "claude",
    "command": "claude",
    "flags": ["--dangerously-skip-permissions"],
    "readyMarker": "❯",
    "inputMethod": "sendKeys",
    "color": "green",
    "icon": "●"
  }
}
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

Any CLI tool that reads from stdin and writes to stdout can be an ensemble agent. Add it to `agents.json`:

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

The agent must support `team-say` and `team-read` shell commands in its PATH for inter-agent communication.

### Input methods

- **`sendKeys`** — Types the prompt character by character into the tmux pane. Works with most agents. Simpler but slower for large prompts.
- **`pasteFromFile`** — Writes the prompt to a temp file and pastes it via tmux buffer. Faster for large prompts. Codex requires this method.

---

## Collab templates (collab-templates.json)

Pre-defined team configurations for common tasks:

```json
{
  "review": {
    "description": "Code Review",
    "agents": [
      { "program": "codex", "role": "lead" },
      { "program": "claude", "role": "worker" }
    ]
  },
  "implement": {
    "description": "Implementation",
    "agents": [
      { "program": "claude", "role": "lead" },
      { "program": "codex", "role": "worker" }
    ]
  },
  "debug": {
    "description": "Debug",
    "agents": [
      { "program": "codex", "role": "lead" },
      { "program": "claude", "role": "worker" }
    ]
  }
}
```

Use via API: `"templateName": "review"` in the create team request.

---

## Multi-host setup

Run agents on different machines. Configure in `~/.aimaestro/hosts.json`:

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

To use ensemble from Claude Code, add to `~/.claude/settings.json`:

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

This allows Claude Code to launch and monitor collab teams without permission prompts.

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
- Agents run with permissive flags (`--dangerously-skip-permissions`, `--full-auto`)
- Server binds to localhost by default
- Do **not** expose to the internet without adding authentication

For production use, consider running behind a reverse proxy with auth.
