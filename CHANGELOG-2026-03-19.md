# Ensemble — Changelog 19 maart 2026

> +5,036 regels code | 25 bestanden | 56 tests | 12 collab sessies | ~2 uur

## Samenvatting

Grote infrastructuur-overhaul van het ensemble multi-agent collaboration systeem. Gedreven door competitieve analyse (oh-my-claudecode 10k stars, overstory 1k stars, myclaude 2.5k stars) en uitgevoerd via een autonome self-improvement loop: elke 8 minuten lanceerde een codex+claude team de volgende verbetering.

---

## A. Infrastructuur — Multi-Collab Isolatie & Stabiliteit

### A1. Namespaced Runtime Paths

**Probleem**: Alle tmp-bestanden lagen los in `/tmp/` met hardcoded namen. Twee collabs tegelijk → file conflicts.

**Oplossing**: Alle runtime files nu onder `/tmp/orchestra/<teamId>/`:

```
/tmp/orchestra/<teamId>/
  messages.jsonl      # agent berichten
  summary.txt         # disband samenvatting
  bridge.pid/log      # bridge process
  poller.pid/feed.txt # achtergrond poller
  prompts/            # agent prompt files
  delivery/           # message delivery files
  .finished           # disband marker
  team-id             # team ID
```

**Files**: `lib/collab-paths.ts` (TypeScript), `scripts/collab-paths.sh` (shell mirror)

**Testen**:
```bash
# Pad functies werken correct
node -e "import('./lib/collab-paths.ts').then(m => console.log(m.collabRuntimeDir('test-123')))"
# → /tmp/orchestra/test-123
```

### A2. Bridge Hardening

**Probleem**: Bridge had geen health check, geen retry, geen single-instance guard. Bij API down liep hij eindeloos.

**Oplossing** (`scripts/orchestra-bridge.sh`):
- **Single-instance guard**: PID file + `kill -0` check. Tweede bridge voor zelfde team → exit.
- **Health check**: Bij start curl naar `/api/v1/health`. Geen response → exit.
- **Exponential backoff**: 10 retries per bericht, 0.5s→30s delay.
- **Trap cleanup**: PID file opruimen bij exit/SIGTERM/SIGINT.
- **`.finished` detection**: Stopt automatisch als team disbanded is.

**Testen**:
```bash
# Start bridge voor een team, probeer tweede → "Already running"
scripts/orchestra-bridge.sh test-id http://localhost:23000 &
scripts/orchestra-bridge.sh test-id http://localhost:23000
# → [bridge] Already running for test-id (pid XXXXX)
```

### A3. Atomic JSONL Writes

**Probleem**: Concurrent writes naar messages.jsonl → corrupte JSON regels.

**Oplossing**: `scripts/team-say.sh` gebruikt nu Python `fcntl.flock` voor exclusive file locking. Cross-platform (macOS + Linux).

**Testen**:
```bash
# Parallel writes → geen corruptie
for i in $(seq 1 10); do
  /usr/local/bin/team-say test-atomic agent-$i team "message $i" &
done
wait
wc -l /tmp/orchestra/test-atomic/messages.jsonl  # → 10
python3 -c "import json; [json.loads(l) for l in open('/tmp/orchestra/test-atomic/messages.jsonl')]"  # geen errors
```

### A4. Auto-Accept Permissions

**Probleem**: Codex en Claude Code vroegen goedkeuring bij elke file write → collab blokkeerde.

**Oplossing** (`agents.json`):
- Codex: `--full-auto` flag
- Claude Code: `--dangerously-skip-permissions` flag

**Testen**: Start een collab → agents schrijven files zonder prompts.

### A5. Collab Livefeed & Polling

**Probleem**: `collab-livefeed.sh` blokkeerde de Bash tool → user zag NIETS tot het team klaar was.

**Oplossing**: Skill v5.2.0 gebruikt nu korte poll-commands (elke 15-20s) die tussentijds resultaat tonen. De livefeed is er nog voor directe terminal gebruik.

**Verbeteringen livefeed** (`scripts/collab-livefeed.sh`):
- Batch Python parsing (alle regels tegelijk ipv per regel)
- Trap cleanup bij SIGTERM/SIGINT
- Heartbeat dots bij stilte
- `.finished` marker detection

---

## B. Nieuwe Features (8 Improvement Rounds)

### B1. Telegram Notifications (Round 1)

Bij team disband wordt automatisch een samenvatting naar Telegram gestuurd.

**Configuratie**: Bot token + chat ID in de code (hardcoded, uit CLAUDE.md).

**Testen**:
```bash
# Handmatige test
curl -s "https://api.telegram.org/bot***REDACTED***:AAEnd0GTwLhMXVacFFfLCaNniVh_JmdoB4U/sendMessage" \
  -d "chat_id=***REDACTED***" -d "text=Test ensemble notification"
```

Na een echte collab: check je Telegram → samenvatting met team naam, duur, messages, per-agent info.

### B2. Smart Agent Roles (Round 2)

Agents krijgen nu rollen gebaseerd op hun positie:
- **Index 0 (LEAD)**: Architectuur, planning, code review. Deelt eerst een plan.
- **Index 1+ (WORKER)**: Implementatie, code schrijven, testen. Wacht op lead's plan.

**Testen**:
```bash
# Start een collab en observeer: codex-1 (LEAD) deelt eerst een plan,
# claude-2 (WORKER) begint pas met implementatie na het plan
```

### B3. Token/Cost Awareness (Round 3)

Bij disband wordt de token usage per agent gescrapet uit hun tmux pane.

**Functie**: `getAgentTokenUsage(sessionName)` in `lib/agent-spawner.ts`
- Regex voor Claude: `NNk tokens`, `NN,NNN tokens`
- Regex voor Codex: `NN% left`
- Fallback: `unknown`

**Testen**:
```bash
# Na een collab, check de summary:
cat /tmp/orchestra/<teamId>/summary.txt
# → Bevat token usage per agent

# Check Telegram bericht → bevat ook tokens
```

### B4. Collab Templates (Round 4)

4 pre-defined collab presets in `collab-templates.json`:

| Template | Agent 1 | Agent 2 |
|----------|---------|---------|
| `review` | Leest en beschrijft code | Zoekt bugs en verbeterpunten |
| `implement` | Plant architectuur | Schrijft code + tests |
| `research` | Onderzoekt onafhankelijk | Onderzoekt onafhankelijk, vergelijkt |
| `debug` | Reproduceert de bug | Analyseert root cause |

**Testen**:
```bash
# Via API met templateName
curl -X POST http://localhost:23000/api/orchestra/teams \
  -H "Content-Type: application/json" \
  -d '{"name":"test","description":"Review my code","templateName":"review","agents":[{"program":"codex","role":"lead"},{"program":"claude code","role":"worker"}]}'

# Unit tests
npx vitest run tests/orchestra.test.ts -t "template"
```

### B5. Git Worktree Isolation (Round 5)

Elke agent krijgt een eigen git worktree + branch. Voorkomt file conflicts bij parallel schrijven.

**Flow**:
1. `createOrchestraTeam()` met `useWorktrees: true`
2. Per local agent: `git worktree add /tmp/orchestra/<teamId>/worktrees/<agent> -b collab/<teamId>/<agent>`
3. Agent werkt in eigen directory
4. Bij disband: merge branches terug → cleanup worktrees → kill sessions

**Opt-in**: `useWorktrees: false` (default) = backward compatible.

**Testen**:
```bash
# Unit tests
npx vitest run tests/orchestra.test.ts -t "worktree"

# Handmatig: na collab met useWorktrees=true
git worktree list  # → toont agent worktrees
git branch -a      # → toont collab/* branches
```

### B6. Staged Workflow (Round 6)

3-fase execution: PLAN → EXEC → VERIFY.

**Flow**:
1. **PLAN**: Agents mogen alleen plannen, geen code schrijven
2. **EXEC**: Na plan-agreement → implementatie
3. **VERIFY**: Elke agent reviewt het werk van de andere

**Key design**: Staged vervangt de normale prompt injectie (niet append). Draait in background.

**Testen**:
```bash
# Via API met staged: true
curl -X POST http://localhost:23000/api/orchestra/teams \
  -H "Content-Type: application/json" \
  -d '{"name":"staged-test","description":"Build X","staged":true,"agents":[...]}'

# Unit tests
npx vitest run tests/staged-workflow.test.ts
npx vitest run tests/orchestra.test.ts -t "staged"
```

### B7. Session Replay (Round 7)

Speel een afgelopen collab sessie opnieuw af in de terminal.

**Script**: `scripts/collab-replay.sh`

**Testen**:
```bash
# Bekijk beschikbare sessies
bash scripts/collab-status.sh --once

# Replay een sessie (instant)
bash scripts/collab-replay.sh <teamId> --speed 0

# Replay met echte timing (2x snelheid)
bash scripts/collab-replay.sh <teamId> --speed 2

# Help
bash scripts/collab-replay.sh --help

# Edge cases
bash scripts/collab-replay.sh nonexistent-id     # → nette error
bash scripts/collab-replay.sh <id> --speed -1     # → "Error: --speed must be >= 0"
```

### B8. Watchdog / Stall Detection (Round 8)

Monitort actieve agents en grijpt in bij stilte.

**Class**: `AgentWatchdog` in `lib/agent-watchdog.ts`

**Flow**:
1. Pollt elke 30s alle actieve teams
2. **Nudge na 90s stilte**: Stuurt "Are you still working? Share your progress." via sendKeys
3. **Stalled na 180s na nudge**: Logt warning, markeert agent als stalled
4. **Reset**: Bij nieuw bericht → timer reset
5. **Cleanup**: Bij team disband → state verwijderd

**Configuratie** (env vars):
- `ENSEMBLE_WATCHDOG_NUDGE_MS` (default: 90000)
- `ENSEMBLE_WATCHDOG_STALL_MS` (default: 180000)

**Testen**:
```bash
# Unit tests (5 tests)
npx vitest run tests/agent-watchdog.test.ts

# Handmatig: start collab, laat een agent 90+ seconden niets doen
# → watchdog stuurt nudge, zichtbaar in monitor
```

---

## C. Nieuwe Scripts

### collab-cleanup.sh
```bash
# Dry-run: wat zou opgeruimd worden
bash scripts/collab-cleanup.sh

# Echt verwijderen
bash scripts/collab-cleanup.sh --force
```
Bewaart altijd de laatste 3 afgeronde collabs. Alleen dirs met `.finished` ouder dan 24h.

### collab-status.sh
```bash
# Snapshot van alle collabs
bash scripts/collab-status.sh --once

# Live dashboard (refresh elke paar seconden)
bash scripts/collab-status.sh
```
Toont: team name, status (groen/geel/rood), messages, laatste bericht, duur, agents.

### collab-replay.sh
```bash
bash scripts/collab-replay.sh <teamId> [--speed N] [--verbose]
```
Speelt sessie af met echte timing, ANSI kleuren, timestamps.

---

## D. Volledige Test Suite

```bash
# Alle tests draaien
cd ~/Documents/ensemble && npx vitest run

# Per test file
npx vitest run tests/orchestra.test.ts      # 50 tests
npx vitest run tests/staged-workflow.test.ts # 1 test
npx vitest run tests/agent-watchdog.test.ts  # 5 tests

# Specifieke test groep
npx vitest run tests/orchestra.test.ts -t "template"
npx vitest run tests/orchestra.test.ts -t "worktree"
npx vitest run tests/orchestra.test.ts -t "staged"
npx vitest run tests/orchestra.test.ts -t "shouldAutoDisband"

# TypeScript check
npx tsc --noEmit
```

**Resultaat**: 3 test files, 56 tests, all passing.

---

## E. End-to-End Test

De beste manier om alles te testen is een echte collab draaien:

```bash
# 1. Start de server
cd ~/Documents/ensemble && npx tsx server.ts

# 2. In een andere terminal: start een collab
scripts/collab-launch.sh "$(pwd)" "Test alle nieuwe features"

# 3. Observeer in de monitor
tmux attach -t ensemble-<teamId>

# 4. Na afloop: check Telegram (notificatie ontvangen?)
# 5. Check summary: cat /tmp/orchestra/<teamId>/summary.txt (token usage?)
# 6. Replay: bash scripts/collab-replay.sh <teamId> --speed 0
# 7. Status: bash scripts/collab-status.sh --once
# 8. Cleanup: bash scripts/collab-cleanup.sh
```

---

## F. Architectuur Overzicht

```
ensemble/
├── server.ts                    # HTTP server (port 23000)
├── agents.json                  # Agent program definitions
├── collab-templates.json        # Collab presets (review/implement/research/debug)
├── lib/
│   ├── collab-paths.ts          # Shared path resolver (TS)
│   ├── agent-spawner.ts         # Agent lifecycle + token scraping
│   ├── agent-watchdog.ts        # Stall detection + auto-nudge
│   ├── staged-workflow.ts       # Plan→Exec→Verify phases
│   ├── worktree-manager.ts      # Git worktree create/merge/destroy
│   ├── orchestra-registry.ts    # Team/message persistence
│   ├── agent-runtime.ts         # tmux abstraction
│   └── agent-config.ts          # agents.json loader
├── services/
│   └── orchestra-service.ts     # Core orchestration logic
├── scripts/
│   ├── collab-paths.sh          # Shared path resolver (shell)
│   ├── collab-launch.sh         # All-in-one team launcher
│   ├── collab-livefeed.sh       # Live terminal feed
│   ├── collab-replay.sh         # Session replay
│   ├── collab-status.sh         # Dashboard
│   ├── collab-cleanup.sh        # Prune old dirs
│   ├── orchestra-bridge.sh      # JSONL→API bridge
│   ├── team-say.sh              # Atomic message write
│   └── team-read.sh             # Read team feed
├── types/
│   └── orchestra.ts             # TypeScript types
└── tests/
    ├── orchestra.test.ts        # 50 tests
    ├── staged-workflow.test.ts  # 1 test
    └── agent-watchdog.test.ts   # 5 tests
```
