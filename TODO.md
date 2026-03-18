# Ensemble — Release Checklist

## P0 — Release Blockers

| # | Issue | Locatie |
|---|-------|---------|
| 1 | Geen LICENSE file | repo root |
| 2 | Geen README.md | repo root |
| 3 | Geen CI/CD (.github/workflows/) | repo root |
| 4 | Open CORS * + 0.0.0.0 binding | server.ts:15-16, 35-38, 110-112 |
| 5 | Geen auth/rate limiting op API | server.ts |
| 6 | Hardcoded permissive agent commands (--full-auto, --dangerously-skip-permissions) | agent-spawner.ts:35-39, 58-60 |
| 7 | strict: false in tsconfig | tsconfig.json:7 |

## P1 — Belangrijk

| # | Issue |
|---|-------|
| 1 | Geen test suite — geen test/lint scripts in package.json |
| 2 | JSONL persistence zonder file locking — race conditions bij multi-process |
| 3 | Undocumented ai-maestro dependency (~/.aimaestro/{hosts,orchestra}) |
| 4 | execAsync met string interpolation — command injection risk in agent-runtime |
| 5 | Shell script embeds variabelen in inline Python — orchestra-bridge.sh:33-89 |
| 6 | Code duplicatie in cli/monitor.ts:100-133 (apiGet/apiPost + polling) |
| 7 | Geen CONTRIBUTING.md |
| 8 | Geen .gitignore voor generated/temp files |

## P2 — Nice-to-haves

- API docs (OpenAPI/Swagger)
- Plugin/extensibility system voor custom agent programs
- Persistent storage beyond JSONL (SQLite etc.)
- Health check endpoint verbeteren (meer diagnostics)
- Configurable agent timeout/retry
- Structured logging (niet console.log)

## Architecture & Code Quality

**Positief:**
- Clean separation: types/ lib/ services/ cli/ scripts/ — goed gelaagd
- AgentRuntime abstractie is solide
- sanitizeName input sanitization aanwezig
- TypeScript types goed gedefinieerd
- Tmux-based agent orchestration is onderscheidend vs concurrenten

**Feature Gaps vs Competitors (CrewAI/AutoGen/LangGraph/Swarm):**
- Geen built-in tool/function calling framework
- Geen memory/context sharing tussen agents
- Geen workflow graphs of DAG support
- Geen observability/tracing
- Geen agent-to-agent protocol standaard (alleen tmux messaging)

## Decided

- **Repo naam:** `ensemble`
- **GitHub description (SEO):** Multi-agent collaboration engine for real-time team orchestration
- **README hero tagline:** Multi-agent collaboration engine — AI agents that work as one
- **License:** MIT (TBD)
- **Position as:** "experimental developer tool", not "production framework"

## Features to borrow from other frameworks

| From | Feature |
|------|---------|
| CrewAI | Role definitions with goals, task decomposition, HITL |
| LangGraph | Checkpointing, state machines, conditional routing |
| AutoGen | Structured conversation patterns, sandboxing |
| Swarm | Handoff pattern, shared context variables, routines |
