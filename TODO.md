# Ensemble — Release Checklist

Deze checklist dateert van vóór de eerste release. De meeste P0's en een deel van de
P1's zijn intussen opgelost (zie hieronder). Wat resteert staat onder Open.

## P0: Release Blockers (opgelost)

| # | Issue | Status |
|---|-------|--------|
| 1 | Geen LICENSE file | Opgelost: `LICENSE` (MIT) in repo root |
| 2 | Geen README.md | Opgelost: `README.md` in repo root |
| 3 | Geen CI/CD (.github/workflows/) | Opgelost: `.github/workflows/ci.yml` + `pages.yml` |
| 4 | Open CORS * + 0.0.0.0 binding | Opgelost: CORS whitelist via `ENSEMBLE_CORS_ORIGIN`, default bind `127.0.0.1` (server.ts) |
| 5 | Geen auth/rate limiting op API | Deels opgelost: per-IP rate limiting in server.ts, er is nog geen auth |
| 6 | Hardcoded permissive agent commands | Opgelost: flags staan nu per agent in `agents.json`, niet hardcoded in `agent-spawner.ts` |
| 7 | strict: false in tsconfig | Opgelost: `strict: true` (tsconfig.json:7) |

## P1: Belangrijk

| # | Issue | Status |
|---|-------|--------|
| 1 | Geen test suite, geen test/lint scripts in package.json | Opgelost: `npm test` (vitest) + `npm run lint`, `tests/` map |
| 2 | JSONL persistence zonder file locking, race conditions bij multi-process | Opgelost: lock met timeout in `lib/ensemble-registry.ts` |
| 3 | ~~Undocumented ai-maestro dependency~~ → renamed to ~/.ensemble | Opgelost |
| 4 | execAsync met string interpolation, command injection risk in agent-runtime | Open: nog steeds template strings naar `execAsync` in `lib/agent-runtime.ts`, namen lopen wel door `sanitizeName()`, niet apart geverifieerd of dat afdoende is |
| 5 | Shell script embeds variabelen in inline Python, ensemble-bridge.sh | Opgelost: script is nu pure bash, geen ingebedde Python meer |
| 6 | Code duplicatie in cli/monitor.ts (apiGet/apiPost + polling) | Opgelost: apiGet/apiPost samengevoegd in `cli/api-client.ts`, gedeeld door `cli/monitor.ts` en `cli/ensemble.ts`; polling bewust lokaal gehouden wegens verschillende levenscycli |
| 7 | Geen CONTRIBUTING.md | Opgelost: `CONTRIBUTING.md` in repo root |
| 8 | Geen .gitignore voor generated/temp files | Opgelost: `.gitignore` aanwezig |

## P2: Nice-to-haves (nog open)

- **iTerm2 split-pane visibility voor parallelle agents**: inmiddels gebouwd (herdr pane / native iTerm split / tmux fallback, zie README "Monitor selection"). Item kan vervallen.
- API docs (OpenAPI/Swagger): `docs/api.md` bestaat, maar is handgeschreven proza, geen OpenAPI/Swagger-spec
- Plugin/extensibility system voor custom agent programs: grotendeels opgelost via `agents.json` (zie README "Add a custom agent"), geen losse plugin-laag
- Persistent storage beyond JSONL (SQLite etc.): nog steeds JSONL
- Health check endpoint verbeteren (meer diagnostics): nog open
- Configurable agent timeout/retry: nog open (alleen een vaste 15s timeout voor remote hosts in `agent-spawner.ts`)
- Structured logging (niet console.log): nog open, `console.log`/`console.error` nog verspreid over server.ts/lib/services

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
