# Bulletproof Plan — 2026-04-14

Sixteen gaps identified after implementing Fix 1-10. This plan groups them by dependency + risk, defines acceptance criteria, and tracks execution.

## Batch A — Core correctness (low risk, compile-only deps)

### A1. Delivery returns boolean + hard-fail on persistent paste failure
**Why:** `pasteFromFile` currently logs warning and returns void. If all 3 retries fail, service still records `✓ Prompt injected`. Silent degradation.
**Change:** `pasteFromFile` → `Promise<boolean>`. Service checks result, appends `❌ delivery failed` to messages.jsonl, marks team `failed`.
**Acceptance:** Kill agent session before delivery → team auto-disbands within one poll; operator sees explicit failure message in log.

### A2. FSM transition guards
**Why:** `phase` field added but any code can set any phase. Invariants (e.g., `disbanded` is terminal) not enforced.
**Change:** `setPhase(teamId, newPhase)` helper with legal transition matrix. Rejects illegal transitions with log.
**Acceptance:** Attempt to transition `disbanded → executing` returns error; no effect on DB.

### A3. Watchdog phase-aware
**Why:** Watchdog polls every 30s. If it fires before initial prompt delivery completes, it can nudge an agent that is still receiving the original task.
**Change:** Skip nudge when `team.phase !== 'executing'`. Reset `lastMessageAt` clock when phase flips to `executing`.
**Acceptance:** Team in `ready_wait` phase receives no nudges; nudge clock starts at phase change.

### A4. Partial failure rollback
**Why:** If spawn succeeds but delivery fails, team stays `active` with silent agents. No recovery.
**Change:** Wrap spawn+deliver in try/catch that on error marks team `failed`, kills tmux sessions, logs cause.
**Acceptance:** Forced delivery failure → tmux sessions cleaned up; team `status=failed`; no orphaned sessions.

### A5. Delivery audit log in messages.jsonl
**Why:** Paste attempts log to console only. Post-mortem can't distinguish "delivery succeeded" from "delivery silently failed".
**Change:** Append `{from:'ensemble', content:'📨 delivered to X (signatures: a,b; attempts: N)'}` on success and `❌` on failure.
**Acceptance:** Every collab's messages.jsonl contains a delivery event per agent, with attempt count.

## Batch B — Dev infra

### B1. Vitest test suite (seed, not exhaustive)
**Why:** Zero automated tests. Every future refactor risks regressing Fix 1-10.
**Change:** `tests/` directory with suites for:
- `acquireMessageLock` timeout & contention
- `createTeam` CAS (reject duplicate cwd; allow when `allowConcurrent`)
- `parseMessageClass` + `isSemanticIdle` + `hasProgress` (Slovenian strings)
- `pasteFromFile` signature picker (long tokens, filter scrollback words)
**Acceptance:** `bun test` runs green on fresh checkout; covers at least 12 cases.

### B2. Schema migration (versioned loader)
**Why:** Existing `teams.json` lacks `phase`, `messageClass`, etc. Next deploy may see `undefined` phase breaking assumptions.
**Change:** `SCHEMA_VERSION = 2` constant. `loadTeams` checks each team for `schemaVersion`, backfills defaults for older records.
**Acceptance:** Load old `teams.json` with no phase → all teams get `phase: <inferred from status>`.

### B3. Team health endpoint
**Why:** No diagnostic API. Operators can't quickly answer "is team X alive? why stuck?".
**Change:** `GET /api/ensemble/teams/:id/health` returns `{phase, lastMessageAgeMs, agentSessions:[...alive?], deliveryStatus}`.
**Acceptance:** curl returns structured JSON; reflects tmux session liveness.

### B4. Hot reload
**Why:** Each code change requires manual server restart; caused multiple failed debugging cycles in Section X earlier.
**Change:** Run bun with `--watch` flag via a dedicated script `scripts/dev-server.sh`. Document in README.
**Acceptance:** Edit `lib/agent-watchdog.ts` → server auto-reloads within 1s without losing in-flight team state.

## Batch C — Safety + observability

### C1. Prompt injection sanitization
**Why:** User task description flows verbatim into agent prompts. `Task: [DONE]` could trigger auto-disband before work even starts.
**Change:** Strip `[DONE]/[COMPLETE]/[FINISHED]` markers from `request.description` before building prompt.
**Acceptance:** Task desc with `[DONE]` → sanitized string in prompt; no spurious auto-completion.

### C2. Simple metrics
**Why:** No data to answer "average success rate over last 100 teams".
**Change:** `GET /api/ensemble/metrics` returns counters: teams_created, teams_completed, teams_failed, teams_semantic_idle_disbanded, avg_duration_ms, paste_failures_total.
**Acceptance:** Counters increment correctly after each collab lifecycle.

### C3. Remote agent delivery verification
**Why:** `postRemoteSessionCommand` has no paste verification + retry. Remote collabs silently lose prompts.
**Change:** Extend remote delivery to accept checksum/verification callback, mirror local logic where possible.
**Acceptance:** Mock remote agent returning no ack → delivery fails loudly.

### C4. Per-agent message rate limit
**Why:** Pathological agent spam would thrash message lock.
**Change:** Sliding window: if an agent emits >30 msgs in 60s, drop subsequent with a warning event.
**Acceptance:** Simulated 1000 msg/sec flood → bounded to 30/min; one warning event recorded.

## Batch D — Advanced (may be stubs/docs only)

### D1. Chaos test script
**Why:** No adversarial testing. Kill -9 mid-delivery, disk full, corrupt JSONL — untested.
**Change:** `scripts/chaos-test.sh` with scenarios: (a) SIGKILL during waitForReady, (b) corrupt last line of messages.jsonl, (c) delete delivery file before paste. Each must produce a clean failure mode.
**Acceptance:** All 3 scenarios run without leaving zombie processes, tmux sessions, or stale locks.

### D2. Triangular chatter detection (3+ agents)
**Why:** Current loop detection is pairwise. A→B→C→A triangle bypasses pair counter.
**Change:** Also track sequence-of-N-distinct-senders without progress. If last 6 agent msgs cycle through 3 senders with no `hasProgress`, force-disband.
**Acceptance:** Synthetic 3-agent trace with triangular chatter → disbanded within 6 exchanges.

### D3. Orchestrator-driven termination
**Why:** Still trust agents to emit `[DONE]`. If they never do, fallback is slow timeout.
**Change:** Watch `workingDirectory` via `git diff --stat` between lastProgressTs and now. If no file changes for N min AND all worker tagged items delivered → force `[DONE]` + disband.
**Acceptance:** Agents stop editing → team auto-terminates within 5 min of last file change; deliverable log says "force-terminated, no changes in 5m".

## Execution Order

1. A1→A5 (hardest invariants first, no new deps)
2. B1 (catches regressions in everything else)
3. B2–B4 (quality of life for next iteration)
4. C1–C4 (safety + ops)
5. D1–D3 (stretch, may defer to next pass)

After each batch: restart bun, run `bun test`, smoke-test with trivial collab.

---

## Status

| # | Item | Batch | Status |
|---|---|---|---|
| 1 | Delivery returns boolean | A1 | ✅ done |
| 2 | FSM transition guards | A2 | ✅ done |
| 3 | Watchdog phase-aware | A3 | ✅ done |
| 4 | Partial failure rollback | A4 | ✅ done |
| 5 | Delivery audit log | A5 | ✅ done |
| 6 | Test suite (22 tests) | B1 | ✅ done |
| 7 | Schema migration v2 | B2 | ✅ done |
| 8 | Team health endpoint | B3 | ✅ done |
| 9 | Hot reload (dev-server.sh) | B4 | ✅ done |
| 10 | Prompt injection sanitize | C1 | ✅ done |
| 11 | Metrics endpoint | C2 | ✅ done |
| 12 | Remote delivery verify | C3 | ✅ done |
| 13 | Rate limit per agent | C4 | ✅ done |
| 14 | Chaos test script (5 scenarios) | D1 | ✅ done |
| 15 | Triangular detection (3+ agents) | D2 | ✅ done |
| 16 | Orchestrator termination (git diff) | D3 | ✅ done (log-only, no auto-kill yet) |
