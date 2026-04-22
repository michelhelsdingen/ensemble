# COLLAB VERDICT — 2026-04-14

## Discovery Findings

### 1. Launch and ownership are still race-prone

- `scripts/collab-launch.sh:29-39` uses a probe-then-start flow for `server.ts`. Two launchers started at nearly the same time can both observe healthcheck failure and both spawn `tsx server.ts`; one loses on `EADDRINUSE`, but the launcher still pays a noisy failed-start path instead of using a single-instance lock.
- `scripts/collab-launch.sh:46-65` does "find active team on same CWD" and only later `POST /api/ensemble/teams` at `:103-105`. That is not atomic. Two launchers on the same working directory can both miss the active team window and both create fresh teams.
- `scripts/collab-launch.sh:121` writes `/tmp/collab-team-id.txt` as a global singleton. Concurrent teams overwrite each other's "latest team" pointer, so any tooling that follows that file can attach to the wrong collaboration.
- `services/ensemble-service.ts:335-342` creates the team first, then checks `getActiveTeamsByWorkingDir(cwd)`. Because the check happens after `createTeam()`, it helps decide worktree isolation but does not prevent duplicate active teams on the same directory.
- `lib/ensemble-registry.ts:87-107` serializes writes to `teams.json`, but it does not provide a compare-and-swap primitive for "only create a new team if no active team exists for this cwd". Locking prevents file corruption, not semantic duplication.

### 2. Prompt rules still permit low-value communication loops

- `services/ensemble-service.ts:321-328` requires a strict `analyze -> team-say -> team-read -> respond` cadence after every analysis step. In practice that can reward acknowledgements over work.
- The recent log `/tmp/ensemble/7dc68c69-c386-4f0a-8305-7e581320de52/messages.jsonl` shows the exact failure mode: after the work packet was frozen, the pair devolved into repeated `Idle.` and `Acknowledged. Stay idle.` messages from `2026-04-14T17:39:02Z` through `17:40:51Z`.
- Another recent trace, `5ff51bca...`, reportedly stayed alive for roughly 35 hours with 19 repeated status messages and no semantic progress. That points to a broader problem than one bad pair: the system detects temporal silence, not semantic stagnation.
- The current LEAD text at `services/ensemble-service.ts:300-306` enforces ownership, but it still does not define an explicit state transition like "once worker is parked, stop messaging unless there is a blocker or a requested review". That omission is what allows acknowledgement loops.
- The WORKER text at `services/ensemble-service.ts:309-313` says to "report what you changed" and "surface blockers", but it never says what *not* to send. That leaves room for heartbeat spam that satisfies the letter of the prompt and hurts the system.

### 3. Message and runtime traces still show stuck-state classes

- `/tmp/ensemble/32aa9329-646c-4c6c-a2d5-4642a6153ae8/messages.jsonl` is empty. That is a real "team exists but no communication ever started" signature and should be treated as a startup failure class, not just a quiet team.
- `/tmp/ensemble/fcdf6b8d-69ae-41b8-bec8-047d4d477be3/messages.jsonl` contains watchdog-style progress pings without corresponding task work. That is benign by itself, but it shows the feed can contain status noise indistinguishable from useful progress unless the consumer understands message intent.
- The same `fcdf6b8d...` pattern is also consistent with prompt-delivery silent failure: an agent can come up and send generic status without ever visibly acknowledging the actual task body.
- A reported `62588a71...` trace with `.finished` but zero messages is even stronger evidence that prompt delivery or startup can fail before any agent-level heartbeat is recorded.
- A reported `71041b04...` research-heavy session ending in "waiting for instructions" shows that analysis/verdict tasks still lack a clean terminal state once no further steering arrives.
- Because `scripts/collab-launch.sh:166-176` treats "at least one line appeared in `messages.jsonl`" as evidence that agents are communicating, a single greeting or watchdog ping is enough to satisfy the launch success path even if the collaboration never becomes productive.

### 4. `pasteFromFile` verification is better, but still weak

- `lib/agent-runtime.ts:233-239` extracts the first 6+ letter word as the signature. That is a weak discriminator for prompts that begin with common words like "Progress", "ROLE", or "Task"; the pane may already contain that token from prior output and produce a false positive.
- `lib/agent-runtime.ts:242-262` retries only once and only checks whether the signature is visible anywhere in the last 100 lines. It does not confirm that the full prompt arrived, that the prompt landed at the input cursor, or that the receiving TUI has actually accepted the paste as a new submission.
- The routine always sends two `Enter` presses (`:246-248`). That is a pragmatic workaround, but it also means a partially pasted prompt can still be submitted twice, which is the failure mode the verification should be protecting against.
- There is no explicit error on persistent verification failure. The code warns and continues, so upstream code can believe delivery succeeded when the prompt was truncated or injected into scrollback.
- That warning also never reaches `messages.jsonl` or the team feed. From an operator perspective, "prompt verification failed twice" remains invisible unless someone is watching stderr on the host process.

### 5. `server.ts` is stable enough for a single process, not bulletproof for orchestration

- `server.ts:215-222` handles `EADDRINUSE` correctly, so the server itself is not the weak point for port binding.
- The real risk is orchestration: `scripts/collab-launch.sh:29-39` treats a successful `/api/v1/health` response as proof that the right server instance is available and ready. There is no startup token, pidfile ownership check, or version handshake.
- `server.ts:141-150` forwards team creation straight into `createEnsembleTeam()` with no idempotency key. A retried or duplicated POST can legitimately create multiple teams for the same user intent.
- `server.ts:163-181` authorizes message senders only if the named team is already present in the registry. If the registry is stale or the team disappeared between checks, the code silently skips sender validation and falls through to service-layer handling. That is probably acceptable locally, but it is not a hard guarantee.

### 6. Auto-disband logic still has blind spots

- `services/ensemble-service.ts:107-124` runs every 15 seconds and re-reads full message history through `getMessages()` on each pass. That is acceptable now, but it scales as repeated full-file reads for long sessions.
- `services/ensemble-service.ts:136-168` uses completion-like content plus time-based idle thresholds. It does not detect repeated-content stagnation, so `Status ostaja`, `Idle`, or `standing by` loops can keep a dead collaboration alive indefinitely as long as they arrive before the idle threshold.
- `services/ensemble-service.ts:48-60` uses very narrow high-confidence completion markers (`[DONE]`, `[COMPLETE]`, `[FINISHED]`) and loose low-confidence markers (`done`, `complete`, `klaar`, etc.). That combination is awkward: real completions are often missed, while phrases like `not done` can still match the low-confidence regex.
- `services/ensemble-service.ts:44` waits 120 seconds before disbanding after a single high-confidence signal. If one agent finishes and the other crashes, the session still lingers for two extra minutes.

## Verdict

The infrastructure is materially better than before, but it is not bulletproof.

My rating is **7/10** for robustness.

Rationale:

- The previously known failures were real and important, and the current codebase shows they were addressed in sensible places.
- The remaining issues are now mostly orchestration and behavioral edge cases rather than obvious "system never starts" bugs.
- The largest residual risks are still meaningful: duplicate team creation on concurrent launch, launch success being inferred from low-signal messages, prompt-driven idle loops, and silent prompt-delivery degradation in `pasteFromFile`.
- I would call the system **usable and fairly resilient**, not **provably robust under concurrency and agent misbehavior**.

## Proposed Prompt Improvements

### LEAD template

Current LEAD guidance in `services/ensemble-service.ts:300-306` should add stronger state-machine language:

- Add: `In your first message, commit to at least one specific file path you personally will write.`
- Add: `After the initial plan, only send team-say when you have new findings, a blocker, a review request, or a completed work item. Do not send acknowledgement-only messages.`
- Add: `If the worker is parked, continue your own implementation locally. Do not instruct them to remain idle more than once.`
- Add: `Define DONE explicitly: your own claimed items are implemented or written, worker-delivered items are reviewed or explicitly accepted, and the deliverable file exists on disk at the requested path.`
- Add: `If no new information exists, do not message. Continue working.`

Rationale:

- This directly targets the observed `Idle.` / `Acknowledged.` loop.
- It makes the lead optimize for forward progress instead of communication compliance.
- It converts "co-implement and coordinate" into a concrete completion rule.

### WORKER template

Current WORKER guidance in `services/ensemble-service.ts:309-313` should become stricter about exit conditions:

- Add: `When your assigned work is complete, send one completion packet, then stop messaging unless the lead asks a new question or requests a change.`
- Add: `Do not send heartbeat, idle, acknowledged, or standing-by messages unless there is a real blocker.`
- Add: `If your task is analysis-only, your output must still end in concrete deliverables: findings with file/line refs, recommended changes, and a clear done marker.`
- Add: `If the lead asks you to wait, wait silently after a single acknowledgement.`

Rationale:

- This removes the incentive to satisfy the communication loop with empty status chatter.
- It makes "done" mean "one final packet and then silence", which matches how useful worker handoff should work.

### Shared template changes

- Replace `After EVERY analysis step, run team-say...` with `After every materially new finding or decision, run team-say...`.
- Replace `After EVERY team-say, run team-read...` with `After sending an update, check team-read once before resuming work.`
- Replace `Start NOW: greet your teammate...` with `First action: confirm prompt receipt by sending RECEIVED:<task checksum or first 10 words>`.
- Add explicit message classes: `PLAN`, `FINDING`, `BLOCKER`, `REVIEW`, `DONE`.
- Add an explicit stop condition: `After shipping the deliverable, send exactly one [DONE] message and then stop messaging unless you are asked a new question.`
- Require one-line progress summaries to include ownership and next action, not just status.

Rationale:

- The current cadence over-specifies frequency and under-specifies quality.
- Message classes would let monitors distinguish progress from churn.

## Remaining Risks

- Concurrent launches on the same repository can still create parallel teams and stomp `/tmp/collab-team-id.txt`.
- A team can look "live" after a single greeting even if useful work never starts.
- `pasteFromFile` can still produce false positives and silent degraded delivery.
- Empty or near-empty `messages.jsonl` traces are still possible and need explicit detection/escalation.
- Registry locking protects file integrity, but not high-level invariants like "one active team per cwd".
- The system still depends heavily on prompt compliance; when agents optimize for the prompt literally, they can satisfy rules while reducing actual throughput.
- Semantic-idle loops are still not surfaced as a first-class failure class, so research/verdict tasks can remain "active" while no new work happens.
