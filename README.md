# ensemble

**Multi-agent collaboration engine** — AI agents that work as one.

Ensemble orchestrates AI agents into collaborative teams. Out of the box it pairs **Codex (lead) + Claude Code (worker)**. They communicate, share findings, and solve problems together in real time. Teams of three (adding Grok) work too. The live TUI monitor opens where you are already looking: a **herdr pane** inside a herdr workspace, a **native iTerm split pane** on macOS + iTerm2 (no tmux needed), or a tmux session elsewhere. Agents themselves are orchestrated via the ensemble bridge. The monitor is just a viewer.

> **Status:** Experimental developer tool. macOS and Linux only.

## Features

- **Team orchestration**: spawn multi-agent teams with a single command
- **Real-time messaging**: agents communicate via a structured message bus
- **TUI monitor**: live viewer that opens in a herdr pane, a native iTerm2 split pane on macOS, or tmux elsewhere
- **Auto-disband**: completion detection ends teams when every agent has signalled done
- **Multi-host support**: run agents across local and remote machines
- **CLI & HTTP API**: full control via command line or REST endpoints

**[Full documentation →](https://michelhelsdingen.github.io/ensemble/)**

## Quick Start

### Prerequisites

- Node.js 18+, Python 3.6+, curl
- [tmux](https://github.com/tmux/tmux) — required on Linux; optional on macOS (only used as a fallback if iTerm2 is not available)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [Codex](https://github.com/openai/codex) CLIs installed

### Install & Run

```bash
git clone https://github.com/michelhelsdingen/ensemble.git
cd ensemble
npm install

# Start the server (keep this running)
npm run dev
# ...or on macOS, once, to keep it running across reboots:
./scripts/install-launchd.sh
```

### Verify (in a second terminal)

```bash
curl http://localhost:23000/api/v1/health
# → {"status":"healthy","version":"1.0.0"}
```

### Create your first team

```bash
# Via CLI
npx ensemble status

# Via API — create a team of two agents
curl -X POST http://localhost:23000/api/ensemble/teams \
  -H "Content-Type: application/json" \
  -d '{
    "name": "review-team",
    "description": "Review the authentication module",
    "agents": [
      { "program": "claude", "role": "lead" },
      { "program": "codex", "role": "worker" }
    ],
    "workingDirectory": "'$(pwd)'"
  }'

# Watch the collaboration live
npx ensemble monitor --latest

# Steer the team
npx ensemble steer <team-id> "focus on the auth module"
```

Or use the all-in-one collab script:

```bash
./scripts/collab-launch.sh "$(pwd)" "Review the authentication module"
```

## Claude Code: `/collab` command

Ensemble ships with a skill for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Once installed, just type:

```
/collab "Review the auth module for security issues"
```

Claude spawns a Codex + Claude team, shows their conversation live in your terminal, and presents a summary when done. One-command setup:

```bash
./scripts/setup-claude-code.sh
```

This installs the skill, configures permissions, and verifies prerequisites. See the [full setup guide](https://michelhelsdingen.github.io/ensemble/configuration#claude-code-integration) for details.

## Supported Agents

The default team is **Codex (lead) + Claude Code (worker)**. This is the tested, production-ready combination.

| Agent | Status | How to use |
|---|---|---|
| **Codex + Claude Code** | Fully tested | Default, just run `/collab` or `collab-launch.sh` |
| **Grok CLI** | Tested in three-agent teams | Add explicitly (see below) |
| **Gemini CLI** | Experimental | Add explicitly (see below) |
| **Aider** | Untested | Add explicitly (see below) |
| **Any CLI tool** | Via `agents.json` | [Add a custom agent](https://michelhelsdingen.github.io/ensemble/configuration#adding-a-custom-agent) |

### Using a different team composition

Four ways to change which agents are on your team:

**1. Name them in your `/collab` prompt:**
```
/collab "Review the auth module with gemini and claude"
```

**2. Pass them as the third argument to `collab-launch.sh`:**
```bash
# Comma-separated. First agent = lead, rest = workers.
./scripts/collab-launch.sh "$(pwd)" "Security audit" codex,claude,grok
```

**3. Set `COLLAB_AGENTS` once in your shell**, for a line-up you do not want to retype:
```bash
export COLLAB_AGENTS="codex,claude,grok"
./scripts/collab-launch.sh "$(pwd)" "Security audit"   # runs all three
```

Precedence is: third argument > `COLLAB_AGENTS` > the default pair. Naming your agents, by
argument *or* by env var, also turns off the auto-fallback: a dead agent then fails preflight
loudly instead of being quietly swapped for a working one. That is deliberate. If you asked for
three agents you want to hear that one of them is broken, not get two and no explanation.

**4. Specify agents in the API call:**
```bash
curl -X POST http://localhost:23000/api/ensemble/teams \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-team",
    "description": "Security audit",
    "agents": [
      { "program": "codex", "role": "lead" },
      { "program": "claude", "role": "worker" },
      { "program": "gemini", "role": "worker" }
    ],
    "workingDirectory": "'$(pwd)'"
  }'
```

> **Note on Gemini:** Gemini CLI can join teams and send messages, but is experimental. It may stop responding due to free-tier rate limits or internal agent delegation issues in Gemini's TUI. For best results, configure a paid API key via `gemini /auth`.

## How It Works

1. **Create a team**: define agents and their task via API or CLI
2. **Agents spawn**: each agent is started by the ensemble bridge with the task prompt
3. **Communication**: agents use `team-say`/`team-read` scripts to exchange messages
4. **Monitor**: watch the collaboration unfold in real time via the TUI monitor (herdr pane, iTerm split pane on macOS, or tmux)
5. **Auto-disband**: when every agent signals completion, results are summarized and persisted

### Monitor selection

`collab-launch` picks the best viewer automatically:

| Situation | Monitor |
|---|---|
| Inside a [herdr](https://github.com/herdrdev/herdr) workspace | **herdr pane** (checked first) |
| Already inside tmux | tmux split pane (right) |
| macOS + iTerm2, no tmux | **native iTerm2 split pane** |
| Linux, or no iTerm2 | detached tmux session (`tmux attach -t ensemble-<id>`) |

herdr is checked before iTerm2 on purpose: herdr draws its own panes inside a host iTerm
session but passes `TERM_PROGRAM=iTerm.app` through unchanged. Trusting that would open a real
iTerm split *outside* the layout you are looking at, so the monitor would never be seen.
`HERDR_ENV=1` is the reliable signal. The pane is labelled after your project directory and
closes itself when the team disbands.

Override with env vars:

- `COLLAB_MONITOR=herdr\|tmux\|iterm\|none`: force a specific mode (or disable the monitor)
- `COLLAB_ITERM_MODE=split\|tab\|window`: iTerm layout (default `split`)
- `COLLAB_HERDR_MODE=split\|tab`: herdr layout (default `split`)

On macOS, you never need `tmux attach` for the monitor.

## Configuration

Copy `.env.example` to `.env` and adjust as needed. Key variables:

| Variable | Default | Description |
|---|---|---|
| `ENSEMBLE_PORT` | `23000` | Server port |
| `ENSEMBLE_URL` | `http://localhost:23000` | CLI target URL |
| `ENSEMBLE_DATA_DIR` | `~/.ensemble` | Data directory |
| `ENSEMBLE_CORS_ORIGIN` | localhost only | Allowed CORS origins |

See [full configuration docs](https://michelhelsdingen.github.io/ensemble/configuration) for all options including Telegram notifications, multi-host setup, and agent customization.

## Documentation

- [Getting Started](https://michelhelsdingen.github.io/ensemble/getting-started) — Prerequisites, install, first team
- [Configuration](https://michelhelsdingen.github.io/ensemble/configuration) — Environment variables, agents, hosts
- [API Reference](https://michelhelsdingen.github.io/ensemble/api) — All HTTP endpoints
- [CLI Reference](https://michelhelsdingen.github.io/ensemble/cli) — Commands and monitor keybindings
- [Collab Scripts](https://michelhelsdingen.github.io/ensemble/collab-scripts) — Shell scripts for automation
- [Architecture](https://michelhelsdingen.github.io/ensemble/architecture) — How it all fits together

## License

[MIT](LICENSE)
