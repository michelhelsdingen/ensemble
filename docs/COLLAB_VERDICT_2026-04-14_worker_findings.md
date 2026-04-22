# COLLAB_VERDICT 2026-04-14 — Worker Findings (claude-2)

Companion evidence file for `COLLAB_VERDICT_2026-04-14.md` (owned by codex-1).
Scope: failure-mode audit of `services/ensemble-service.ts` + `scripts/collab-launch.sh`, pattern mining of 5 recent `messages.jsonl` runtimes, and prompt-template improvement proposals.

## 1. Failure Modes in Current Infrastructure

### Idle / watchdog (ensemble-service.ts)

- **F1 — Semantic idle not detected.** `services/ensemble-service.ts:136-168` `shouldAutoDisband` only measures *temporal* idle (timestamp gap). Agents looping `Acknowledged` / `standing by` / `Še delam` every <120s reset `lastTimestamp`, so `idleForMs` never crosses `LOW_CONFIDENCE_IDLE_THRESHOLD_MS` (300s). Evidence: team `5ff51bca` lived 35h with 19 near-identical status repeats.
- **F2 — Completion patterns too narrow.** `services/ensemble-service.ts:48-60`. `HIGH_CONFIDENCE` requires literal `[DONE]`/`[COMPLETE]`/`[FINISHED]` brackets — agents rarely emit those spontaneously. `LOW_CONFIDENCE` requires two *distinct* agents within a 60s window (`COMPLETION_SIGNAL_WINDOW_MS`); if one agent falls silent, disband never fires. Bare `done`/`complete` also match inside negations.
- **F3 — Re-reads per tick.** `services/ensemble-service.ts:107` `checkIdleTeams` calls `getMessages()` for every active team every 15s; for 500+ msg sessions this is repeated full-file I/O.
- **F4 — 120s hang on single-signal disband.** `SINGLE_SIGNAL_IDLE_THRESHOLD_MS=120_000` (`services/ensemble-service.ts:45`). One `[DONE]` on a team whose partner crashed still holds the session open for two minutes.
- **F10 — `appendMessage` not behind a lock in the service layer.** Concurrent writes by bridge + agent to the same `messages.jsonl` can interleave lines under contention.

### Launch-time races (collab-launch.sh)

- **F5 — UUID-prefix collision in orphan detection.** `scripts/collab-launch.sh:58` greps `^${ACTIVE_TEAM}-|-${ACTIVE_TEAM:0:8}-`. The 8-char prefix form can match an unrelated team whose first 8 UUID chars collide with the active one (non-zero probability with enough historical sessions).
- **F6 — Unsupervised server spawn.** `scripts/collab-launch.sh:33` starts `tsx server.ts` with plain `&`, no `nohup`, no PID file. If the launching shell exits during the health-probe race window the server can die with it, and there is no PID file for later clean shutdown.
- **F7 — Poller reads mid-write.** `scripts/collab-launch.sh:149-161` polls via `wc -l` on `messages.jsonl` while the bridge appends; a partial line can be counted and double-flushed to the feed on the next tick.
- **F8 — First-message timer too short for Codex.** `scripts/collab-launch.sh:166-170` waits only 12s for the first message; Codex cold start is ~110s, so healthy launches routinely display the misleading `warming up…` state.
- **F9 — Concurrent cleanup race.** `scripts/collab-launch.sh:43` runs `collab-cleanup.sh --force` in background concurrently with launch. If a team is created in the same second that cleanup is scanning, there is no coordination guaranteeing the new runtime dir is skipped.
- **F11 — Server-start TOCTOU.** `scripts/collab-launch.sh:29-39` two simultaneous launchers can both observe “down”, both spawn `tsx server.ts`, and the second loses the port-bind race — producing an orphaned `tsx` plus error noise. Fix: `flock /tmp/ensemble-server.lock` around the probe+spawn.
- **F12 — No compare-and-swap on team creation.** `scripts/collab-launch.sh:46-66` reads active teams then posts `POST /api/ensemble/teams` unconditionally. `ensemble-registry` serializes the WRITE but does not enforce the read-then-write invariant, so two parallel launchers on the same cwd can both pass the “no active” check and both create teams. Fix: server-side `?ifNoActiveForCwd=<realpath>` re-check under the registry lock, returning `409` if violated.
- **F13 — Global latest-id file.** `scripts/collab-launch.sh:121` writes `/tmp/collab-team-id.txt` unconditionally; concurrent launches stomp each other. Low stakes but misleading for any tool that reads “the latest team.” Suggest per-cwd file keyed on `sha1(realpath)`.

### Prompt delivery observability

- **P4 (pattern) — Silent paste verification failure.** `lib/agent-runtime.ts:242-262` `pasteFromFile` logs a `console.warn` on failed signature match but the warning does not reach `messages.jsonl` or the feed. In runtime `fcdf6b8d` the task prompt never surfaced inside the session — 2 msgs total, no evidence of delivery. After the signature-retry fix this should be rare, but the failure is still *invisible* to the operator.

## 2. Pattern Mining — Last 5 `/tmp/ensemble/*/messages.jsonl`

| Team id (prefix) | Msgs | Code shipped | Observed pattern |
|---|---|---|---|
| `7dc68c69` | 39 | ✅ (4/5 fixes by worker) | Idle loop after work complete (msgs 24-39: `Idle.` / `Acknowledged. Stay idle.`) — confirms F1. |
| `fcdf6b8d` | 2 | ❌ | Prompt-delivery failure; agent acked bridge but task body missing — P4. |
| `5ff51bca` | 26 (over 35h) | ❌ | 19× identical status repeats by lead, worker silent — F1 in its purest form. |
| `62588a71` | 0 | ❌ | Only `.finished` marker; full delivery failure or immediate crash. |
| `71041b04` | 501 (over 120h) | ❌ (research) | Ended in `čakava navodila` — no terminal state for open-ended research tasks. |

### Derived root patterns
- **P1.** Research/audit/verdict tasks have no machine-checkable done-criteria, so agents default to idle-loop waiting-for-input.
- **P2.** Semantic idle (repeated content) is invisible to the current watchdog — only temporal idle counts.
- **P3.** Prompt-delivery failure is silent at the operator level; only post-hoc discoverable by noticing a 0-msg or 2-msg session.
- **P4.** Watchdog nudges are answered with status updates instead of new progress, which *resets* the idle timer and extends the loop indefinitely.

## 3. Prompt-Template Proposals (for `buildPromptPreview`, `services/ensemble-service.ts:273-330`)

Rationale-tagged so the lead can accept/reject individually.

- **PP1 — Deliverable-as-termination.** Append to every prompt: `This session ends when <absolute deliverable path> exists and contains the required sections. Do not continue conversation after that point.` *Why:* kills P1 by binding "done" to an observable filesystem predicate rather than agent self-report.
- **PP2 — Prompt-delivery heartbeat.** Replace `Start NOW: greet your teammate with team-say, then begin.` with: `First action: confirm delivery by running team-say with exactly: RECEIVED:<first 10 words of Task>. Only after that, greet and begin.` *Why:* surfaces P3/F14 within ~10s; if no `RECEIVED:` arrives, launcher can re-paste.
- **PP3 — Stop condition + watchdog etiquette.** Add: `STOP CONDITIONS: After shipping your deliverable, send exactly one [DONE] message with a file list, then exit your main loop. Do NOT respond to watchdog nudges with status updates — respond only with new concrete progress or [DONE]. Repeating a previous status counts as idle.` *Why:* breaks P2/P4 and feeds F2 (produces the bracketed `[DONE]` the watchdog already understands).
- **PP4 — LEAD pre-commits a file.** Replace `Do not delegate everything` with: `Before sending any plan, pre-commit to at least one specific absolute file path YOU will write. Include that path verbatim in your first team-say. The final team-say MUST show edits to that exact path.` *Why:* removes "coordinator-only" escape hatch; makes lead-as-shipper verifiable from messages.jsonl alone.
- **PP5 — Watchdog escalation to auto-disband.** After 3 consecutive watchdog nudges with no new file edit observed on any agent worktree, auto-disband with marker `[STALLED]` and a Telegram summary. *Why:* finite upper bound on stuck sessions; currently unbounded (evidence: 35h, 120h).

## 4. What I edited

- `docs/COLLAB_VERDICT_2026-04-14_worker_findings.md` — this file, new, ~140 lines. No other files modified.

## 5. Suggested Integration

- `COLLAB_VERDICT_2026-04-14.md` (lead-owned) should reference this file under *Discovery Findings* (“See companion: `COLLAB_VERDICT_2026-04-14_worker_findings.md`”) and merge F1–F13, P1–P4, PP1–PP5 as indexed items so future audits can cite them by ID.
