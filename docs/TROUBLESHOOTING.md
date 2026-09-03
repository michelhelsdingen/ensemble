# Collab Troubleshooting

## "Agents spawn but no output / Not logged in / DNS errors"

**Recurring root cause** (observed 2026-05-04, 2026-05-06, 2026-05-08): The
ensemble service inherits the env of the shell that started it. If you start
`tsx server.ts` from a shell that lacks credentials (no recent `claude` login,
no `codex login`, missing PATH entries), every agent spawned afterward
inherits that broken env.

Symptoms in the agent panes:
- Claude: `Not logged in · Please run /login`
- Codex: `stream disconnected before completion: failed to lookup address information`

### Fix
```bash
pkill -f 'tsx server.ts'
cd ~/Documents/ensemble && nohup ./node_modules/.bin/tsx server.ts > /tmp/ensemble-server.log 2>&1 &
```

Then re-run `/collab` from the same shell where `claude --print "ok"` and
`codex login status` both succeed.

On macOS you can hand the service to launchd instead, once:
```bash
./scripts/install-launchd.sh
```
It then starts at login, comes back after a crash, and restarts on demand with
`launchctl kickstart -k gui/$(id -u)/dev.ensemble.server`. The agent carries the
PATH of the shell that installed it, so install from a shell where the agent CLIs
work. When preflight finds the service older than 24h it does the kickstart itself.

### Why the preflight catches it
`scripts/collab-preflight.sh` runs before every team spawn, and checks only the CLIs the run
actually needs (`collab-preflight.sh codex,claude,grok`, or `COLLAB_AGENTS`):

1. Service health check
2. Service age (>24h = likely stale env, fail loud)
3. DNS resolve api.openai.com + api.anthropic.com
4. tmux DNS probe: a fresh pane must be able to resolve, because a long-running tmux server
   caches its own resolver and children start failing while the shell still works
5. Codex: `codex login status` says "Logged in", **and** a real `codex exec` returns the exact
   sentinel `PROBE-OK-7391`. Asking only whether codex answers is not the same as asking
   whether codex works: a model that the current auth mode rejects returns an ordinary error
   with no quota wording, which used to score healthy right before the agent went silent for
   the whole session
6. Grok (when requested): `grok models` reports logged in, and the project-picker hint is set
7. Claude: `claude auth status` reports `"loggedIn": true`, run **inside a fresh tmux pane**
   with `CLAUDECODE` unset, because that is the context agents actually spawn in. Running it in
   the caller's shell passed while the spawned agent was logged out

Exit codes: 0 ok, 1 service down, 2 stale service, 3 claude broken or a named agent
unavailable, 4 codex broken, 5 DNS, 6 grok broken.

### Named agents fail loudly, unnamed ones fall back

If you name your agents (third argument to `collab-launch.sh`, or `COLLAB_AGENTS`), a broken one
is a hard failure with exit 3. Only the implicit default pair gets the auto-fallback that drops
to codex-only or claude-only. This is deliberate: if you asked for three agents you want to hear
that one is broken, not silently get two.

### Why the postcheck catches it
`scripts/collab-postcheck.sh` runs 30s after spawn (background):
- Captures all agent tmux panes
- Greps for "Not logged in", "stream disconnected", "401 Unauthorized"
- If any match: kills team, prints diagnosis + suggested fix

## "The monitor never appears"

Inside a [herdr](https://github.com/herdrdev/herdr) workspace, `TERM_PROGRAM` still reports
`iTerm.app`. Ensemble checks `HERDR_ENV=1` first for that reason; if you are running some other
terminal multiplexer that does the same thing, force the mode with
`COLLAB_MONITOR=herdr|tmux|iterm|none`. The launcher prints which mode it picked, and the herdr
path also logs to `/tmp/collab-herdr-last.log` (iTerm: `/tmp/ensemble-iterm.err`).

## Bypass for advanced users
- `COLLAB_SKIP_PREFLIGHT=1` — skip preflight (NOT recommended)
- `COLLAB_SKIP_POSTCHECK=1` — skip postcheck
- `COLLAB_SERVICE_MAX_AGE=48` — allow older service (default 24h)
