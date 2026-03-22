---
title: Architecture
nav_order: 7
---

# Architecture

## Overview

```
                    ┌─────────────┐
                    │  HTTP API   │
                    │  server.ts  │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │  Ensemble   │
                    │   Service   │
                    └──┬───┬───┬──┘
                       │   │   │
              ┌────────┘   │   └────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ Registry │ │ Spawner  │ │ Watchdog │
        │  (JSONL) │ │  (tmux)  │ │  (idle)  │
        └──────────┘ └──────────┘ └──────────┘
                           │
                    ┌──────▼──────┐
                    │ tmux panes  │
                    │  agent-1    │
                    │  agent-2    │
                    └─────────────┘
```

## Directory structure

```
ensemble/
├── server.ts                  # HTTP server (port 23000)
├── agents.json                # Agent program definitions
├── collab-templates.json      # Pre-built team templates
├── cli/
│   ├── ensemble.ts            # CLI entry point
│   └── monitor.ts             # TUI monitor (blessed-based)
├── services/
│   └── ensemble-service.ts   # Team lifecycle, messaging, auto-disband
├── lib/
│   ├── agent-config.ts        # agents.json loader + program resolver
│   ├── agent-runtime.ts       # AgentRuntime interface + TmuxRuntime
│   ├── agent-spawner.ts       # Local/remote agent spawn lifecycle
│   ├── agent-watchdog.ts      # Idle detection + nudge mechanism
│   ├── collab-paths.ts        # /tmp/ensemble/* path resolver
│   ├── ensemble-paths.ts      # Data directory paths
│   ├── hosts-config.ts        # Multi-host discovery + lookup
│   ├── ensemble-registry.ts  # JSONL persistence (with file locking)
│   ├── staged-workflow.ts     # Multi-phase workflows
│   └── worktree-manager.ts    # Git worktree isolation
├── types/
│   ├── agent-program.ts       # AgentProgram interface
│   └── ensemble.ts            # Team, Message, Agent types
├── scripts/
│   ├── collab-launch.sh       # All-in-one team launcher
│   ├── collab-poll.sh         # Single-shot message poller
│   ├── collab-livefeed.sh     # Continuous live feed
│   ├── collab-status.sh       # Multi-team dashboard
│   ├── collab-replay.sh       # Session replay
│   ├── collab-cleanup.sh      # Temp file cleanup
│   ├── team-say.sh            # Agent message send
│   ├── team-read.sh           # Agent message read
│   ├── ensemble-bridge.sh    # File→HTTP message bridge
│   ├── parse-messages.py      # Shared JSONL parser
│   └── collab-paths.sh        # Shared path functions
└── tests/
    ├── ensemble.test.ts      # Integration tests
    └── agent-watchdog.test.ts # Watchdog unit tests
```

## Key components

### Ensemble Service

The brain. Manages team lifecycle:

- **Create** — Validate request, persist team, spawn agents, start watchdog
- **Message routing** — Deliver messages between agents via tmux sessions
- **Auto-disband** — Detect completion signals, idle teams, failed agents
- **Disband** — Stop agents, merge worktrees, write summary, send notifications

### Ensemble Registry

Persistence layer using JSONL flat files. File locking prevents corruption from concurrent access. Stores:

- Team metadata (`teams.json`)
- Message logs (`messages.jsonl` per team)
- Runtime state (PID files, markers)

### Agent Runtime (tmux)

Each agent runs in an isolated tmux session:

1. Session created with working directory
2. Agent CLI launched with configured flags
3. Readiness detected via prompt marker
4. Prompts delivered via `sendKeys` or `pasteFromFile`
5. Graceful shutdown on disband

### Agent Watchdog

Monitors agent activity and prevents stalls:

- **Nudge** — After 90s idle, sends a gentle reminder
- **Stall detection** — After 180s, marks agent as stalled
- Configurable via `ENSEMBLE_WATCHDOG_NUDGE_MS` and `ENSEMBLE_WATCHDOG_STALL_MS`

### Ensemble Bridge

Shell process that bridges the gap between file-based agent communication (`team-say.sh` writes to JSONL) and the HTTP API:

- Polls `messages.jsonl` for new lines
- POSTs each message to the ensemble API
- Exponential backoff on failures
- Skips client errors (4xx), retries server errors (5xx)
- Single-instance guard prevents duplicates

## Data flow

```
Agent writes message
       │
       ▼
team-say.sh → messages.jsonl (atomic write with flock)
       │
       ▼
ensemble-bridge.sh polls file
       │
       ▼
POST /api/ensemble/teams/:id (HTTP)
       │
       ▼
ensemble-service routes message
       │
       ▼
Delivers to target agent's tmux session
       │
       ▼
Agent reads via team-read.sh (polls HTTP API)
```

## Runtime files

All runtime data lives in `/tmp/ensemble/<team-id>/`:

| File | Purpose |
|---|---|
| `messages.jsonl` | Full message log |
| `summary.txt` | Written on disband |
| `.finished` | Cleanup signal marker |
| `bridge.pid` | Bridge process ID |
| `bridge.log` | Bridge debug output |
| `poller.pid` | Background poller PID |
| `feed.txt` | Feed cache |
| `team-id` | Team ID marker |
| `prompts/*.txt` | Per-agent initial prompts |
| `delivery/*.txt` | Multi-line prompt delivery files |
| `.poll-seen` | Poll state tracker |
