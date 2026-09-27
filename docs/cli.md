---
title: CLI Reference
nav_order: 5
---

# CLI Reference

## ensemble CLI

```bash
# Run via tsx
npx tsx cli/ensemble.ts <command>

# Or if linked
ensemble <command>
```

### Commands

| Command | Description |
|---|---|
| `status` | Check server health |
| `teams` / `ls` | List all teams |
| `monitor [teamId]` | Open TUI monitor |
| `monitor --latest` | Monitor most recent team |
| `steer <teamId> "msg"` | Send steering message to team |
| `help` | Show help |

### Examples

```bash
# Check server
ensemble status

# List active teams
ensemble teams

# Watch the latest team
ensemble monitor --latest

# Redirect a team's focus
ensemble steer abc-123 "Stop the current approach and focus on testing"
```

---

## TUI Monitor

The terminal monitor (`cli/monitor.ts`) provides a real-time view of agent collaboration.

### Keybindings

| Key | Action |
|---|---|
| `s` | Steer entire team (opens input) |
| `1`-`4` | Steer specific agent by index (1 = lead, then the workers in order) |
| `j` / `k` or `↓` / `↑` | Scroll message history |
| `d` | Disband team |
| `q` | Quit monitor |
| `ESC` | Cancel input |

### Where the monitor opens

`collab-launch.sh` starts the monitor for you, in a herdr pane, an iTerm2 split, a tmux split or
a detached tmux session depending on where you are. In the herdr and iTerm cases the pane closes
itself when the team disbands, so `q` is only needed if you want to stop watching early. See
[Collab Scripts](collab-scripts#collab-launchsh) for the selection order.

### Idle detection

After 60 seconds of no activity combined with completion signals, the monitor shows an action menu:

- Show summary
- Let team continue working
- Steer with new goal
- Disband team

---

## npm scripts

```bash
npm run dev       # Start server (development)
npm run start     # Start server (production)
npm run build     # TypeScript typecheck (no emit)
npm run lint      # ESLint
npm run monitor   # Open TUI monitor for latest team
npm run cli       # Run ensemble CLI
npm run smoketest # Check agent startup markers in isolated tmux sessions
```

The smoketest checks every agent in `agents.json` by default. Missing commands are reported but do not fail the run. To select agents or change the per-agent timeout, use `npm run smoketest -- codex claude --timeout 30`. It prints JSON on stdout and a short summary on stderr. Each agent gets a temporary working directory and a separate tmux socket. No prompt is sent.
