#!/usr/bin/env bash
# collab-preflight.sh — Verify collab dependencies BEFORE spawning a team.
#
# Usage: collab-preflight.sh [agents-csv]
#   agents-csv  which agents this run will spawn (also via COLLAB_AGENTS).
#               Empty = the default codex + claude pair.
#               Only the listed CLIs are checked, so a codex quota wall no
#               longer blocks a grok+claude run.
#
# Exit codes:
#   0 — all checks passed, safe to launch
#   1 — service down (start required)
#   2 — service is stale (started in shell without auth — restart required)
#   3 — claude CLI broken (auth or binary issue)
#   4 — codex CLI broken (auth or binary issue)
#   5 — DNS/network issue
#   6 — grok CLI broken (auth or binary issue)
#
# Each failure prints exactly what's wrong + the fix command.

set -uo pipefail

API="${ENSEMBLE_URL:-http://localhost:23000}"
SERVICE_MAX_AGE_HOURS="${COLLAB_SERVICE_MAX_AGE:-24}"

# ─── Which agents does this run need? ───
REQUESTED_AGENTS="${1:-${COLLAB_AGENTS:-}}"
EXPLICIT_AGENTS=1
if [ -z "$REQUESTED_AGENTS" ]; then
  REQUESTED_AGENTS="codex,claude"
  EXPLICIT_AGENTS=0
fi

# Lowercased once, so the matcher stays bash 3.2 safe (no ${var,,} on macOS).
REQUESTED_LC=$(printf '%s' "$REQUESTED_AGENTS" | tr 'A-Z' 'a-z')

# wants <name> — is this agent part of the run? Substring match mirrors
# resolveAgentProgram() in lib/agent-config.ts, so "claude code" matches "claude".
wants() {
  case "$REQUESTED_LC" in
    *"$1"*) return 0 ;;
    *) return 1 ;;
  esac
}

R='\033[0m'; RED='\033[91m'; GRN='\033[92m'; YEL='\033[93m'; BD='\033[1m'

fail() {
  local code=$1; shift
  echo -e "  ${RED}✗${R} $*" >&2
  exit "$code"
}
ok() {
  echo -e "  ${GRN}✓${R} $*"
}
warn() {
  echo -e "  ${YEL}!${R} $*"
}

echo -e "${BD}collab preflight${R}"

# ─── 1. Ensemble service ───
if ! curl -sf "$API/api/v1/health" > /dev/null 2>&1; then
  fail 1 "Ensemble service NOT running on $API
     Fix: cd ~/Documents/ensemble && nohup ./node_modules/.bin/tsx server.ts > /tmp/ensemble-server.log 2>&1 &"
fi
ok "Ensemble service responding"

# ─── 2. Service age (stale state catches the 2026-05-08 issue) ───
# This whole block used to be a no-op on Linux, which is the opposite of harmless: it is the
# check that catches a service started in a shell without credentials, the cause of several
# silent all-agents-dead sessions. Two macOS assumptions hid it. `pgrep` is not installed on a
# minimal image (procps), and `date -j -f` is BSD-only, so on GNU date the substitution came
# back empty and the age comparison was skipped without a word.
if command -v pgrep > /dev/null 2>&1; then
  SERVER_PID=$(pgrep -f "tsx server.ts" | head -1)
else
  SERVER_PID=$(ps -eo pid=,args= 2>/dev/null | awk '/tsx server\.ts/ && !/awk/ {print $1; exit}')
fi
if [ -n "$SERVER_PID" ]; then
  # GNU ps reports elapsed seconds directly; BSD/macOS ps does not, so fall back to parsing the
  # start time there. Trying etimes first keeps Linux on the simpler path.
  AGE_SECS=$(ps -p "$SERVER_PID" -o etimes= 2>/dev/null | tr -d ' ')
  if ! printf '%s' "${AGE_SECS:-}" | grep -qE '^[0-9]+$'; then
    PROC_START_EPOCH=$(ps -p "$SERVER_PID" -o lstart= 2>/dev/null | xargs -I{} date -j -f "%a %b %d %T %Y" "{}" +%s 2>/dev/null)
    if [ -n "$PROC_START_EPOCH" ]; then
      AGE_SECS=$(( $(date +%s) - PROC_START_EPOCH ))
    else
      AGE_SECS=""
    fi
  fi
  if [ -n "$AGE_SECS" ]; then
    AGE_HRS=$((AGE_SECS / 3600))
    if [ "$AGE_HRS" -gt "$SERVICE_MAX_AGE_HOURS" ]; then
      # Under launchd (scripts/install-launchd.sh) a stale service is a restart
      # away, so do that here instead of sending the user to a shell one-liner.
      LAUNCHD_LABEL="${ENSEMBLE_LAUNCHD_LABEL:-dev.ensemble.server}"
      LAUNCHD_TARGET="gui/$(id -u)/$LAUNCHD_LABEL"
      if command -v launchctl > /dev/null 2>&1 && launchctl print "$LAUNCHD_TARGET" > /dev/null 2>&1; then
        warn "Ensemble service is ${AGE_HRS}h old — restarting it through launchd ($LAUNCHD_LABEL)"
        launchctl kickstart -k "$LAUNCHD_TARGET"
        RESTARTED=0
        for _ in $(seq 1 10); do
          sleep 1
          if curl -sf "$API/api/v1/health" > /dev/null 2>&1; then RESTARTED=1; break; fi
        done
        if [ "$RESTARTED" = 1 ]; then
          ok "Ensemble service restarted (fresh process under launchd)"
        else
          fail 2 "Ensemble service did not come back within 10s after launchctl kickstart; check /tmp/ensemble-server.log"
        fi
      else
        fail 2 "Ensemble service is ${AGE_HRS}h old (>${SERVICE_MAX_AGE_HOURS}h threshold)
     This is the 2026-05-08 stale-state issue: agents will spawn with broken auth.
     Fix: pkill -f 'tsx server.ts' && cd ~/Documents/ensemble && nohup ./node_modules/.bin/tsx server.ts > /tmp/ensemble-server.log 2>&1 &
     Or install the launchd agent once (scripts/install-launchd.sh) and preflight restarts it for you."
      fi
    else
      ok "Ensemble service age: ${AGE_HRS}h (within ${SERVICE_MAX_AGE_HOURS}h limit)"
    fi
  else
    warn "Could not determine service age (no usable ps) — stale-service check skipped"
  fi
else
  warn "Could not find the server process — stale-service check skipped"
fi

# ─── 3. DNS reachability ───
# Resolve through python3, which every collab script already depends on, instead of `host`.
# `host` ships in bind9-host and is absent from a minimal Linux install; because the old check
# only asked whether the command succeeded, a missing binary was reported as "DNS lookup
# failed ... check internet connection / VPN / DNS resolver". That sends someone debugging a
# network that works. getaddrinfo also goes through the same resolver the agent CLIs use, so
# it tests the thing we actually care about.
resolves() {
  python3 - "$1" <<'PY' > /dev/null 2>&1
import socket, sys
socket.getaddrinfo(sys.argv[1], 443)
PY
}
for HOSTNAME in api.openai.com api.anthropic.com; do
  if ! resolves "$HOSTNAME"; then
    fail 5 "DNS lookup failed for $HOSTNAME
     Fix: check internet connection / VPN / DNS resolver"
  fi
done
ok "DNS resolves api.openai.com + api.anthropic.com"

# ─── 3b. TMUX DNS-staleness check (regression 2026-05-13) ───
# Het tmux-server proces cached zijn eigen libc-resolver. Na uren draaien valt
# getaddrinfo() in tmux-spawned children silent uit ("Unknown host") terwijl
# resolven op shell-niveau het wel doet. Resultaat: codex/claude in tmux krijgen
# stream-disconnects bij elke api-call. Detecteer in een verse pane;
# faal → kill-server (effe geen attached clients = veilig).
#
# Resolve via python3, niet via ping: ping ontbreekt op een kale image (iputils),
# en dan meldde deze check "inconclusive" met een rauwe shell-fout erin. python3
# is toch al een harde dependency van deze scripts, en getaddrinfo() test exact
# de resolver waar het hier om gaat.
TMUX_DNS_SESS="preflight-dns-$$"
TMUX_DNS_OUT="/tmp/preflight-dns-$$.out"
rm -f "$TMUX_DNS_OUT"
tmux new-session -d -s "$TMUX_DNS_SESS" -c /tmp 2>/dev/null
tmux send-keys -t "$TMUX_DNS_SESS" -l "python3 -c \"import socket;socket.getaddrinfo('api.openai.com',443);print('TMUXDNS_OK')\" > $TMUX_DNS_OUT 2>&1; echo PROBEDONE_$$ >> $TMUX_DNS_OUT"
tmux send-keys -t "$TMUX_DNS_SESS" C-m
for _ in $(seq 1 8); do
  grep -q "PROBEDONE_$$" "$TMUX_DNS_OUT" 2>/dev/null && break
  sleep 0.5
done
tmux kill-session -t "$TMUX_DNS_SESS" 2>/dev/null
TMUX_DNS_RESULT=$(cat "$TMUX_DNS_OUT" 2>/dev/null || echo "")
rm -f "$TMUX_DNS_OUT"

if echo "$TMUX_DNS_RESULT" | grep -q "TMUXDNS_OK"; then
  ok "TMUX DNS resolver healthy"
elif echo "$TMUX_DNS_RESULT" | grep -qE "gaierror|Name or service not known|Unknown host|cannot resolve|Temporary failure"; then
  warn "TMUX DNS resolver stale — auto-fix: killing tmux server"
  # Save list of any attached clients (rare since iTerm clients live elsewhere)
  ATTACHED=$(tmux list-clients 2>/dev/null | wc -l | tr -d ' ')
  if [ "$ATTACHED" -gt "0" ]; then
    warn "  $ATTACHED tmux client(s) attached — skipping kill (would disrupt user)"
    warn "  Manual fix: detach clients (Ctrl+B d) en re-run /collab"
    fail 5 "TMUX DNS dead and clients attached — cannot auto-fix"
  fi
  tmux kill-server 2>/dev/null
  sleep 0.5
  ok "TMUX server killed; new spawns will inherit fresh resolver"
else
  warn "TMUX DNS probe inconclusive: ${TMUX_DNS_RESULT:0:120}"
fi

# ─── 4. Codex CLI auth ───
if ! wants codex; then
  ok "Codex not in this run (agents: $REQUESTED_AGENTS) — skipping codex checks"
  CODEX_DEAD=0
else
if ! command -v codex > /dev/null 2>&1; then
  fail 4 "codex binary not in PATH
     Fix: install codex CLI or check PATH"
fi
CODEX_AUTH=$(codex login status 2>&1 | head -1)
if echo "$CODEX_AUTH" | grep -qiE "logged in"; then
  ok "Codex authenticated: ${CODEX_AUTH:0:60}"
else
  fail 4 "Codex not authenticated. Status: $CODEX_AUTH
     Fix: codex login"
fi

# ─── 4a. Codex quota probe (regression 2026-05-13: 'usage limit hit' isn't ──
#         caught by `codex login status` — only by an actual exec call). Run a
#         minimal `codex exec` and look for the limit-message. Costs ~1 token.
# The probe demands a sentinel back rather than merely checking for error words.
# Testing "did codex answer" is not the same as "does codex work": an auth mode
# that rejects the configured model answers with an ordinary HTTP 400, contains
# no quota wording, and used to be reported as healthy — after which the agent
# spawned, reported ready, and then sat silent for the whole session.
# (2026-08-11: a ChatGPT-auth account rejecting an API-only model name did
# exactly this.)
# stdin MUST be /dev/null (2026-08-14, codex-cli 0.147.0): with an inherited
# stdin that stays open, `codex exec` treats it as extra prompt input, prints
# "Reading additional input from stdin..." and blocks until the timeout kills
# it. The probe then finds no sentinel and disables a perfectly healthy codex.
# Only shows up when preflight is called from a caller whose stdin is a live
# pipe (an agent shell, CI), which is exactly where a false negative hurts.
CODEX_PROBE_OUT=$(timeout 40 codex exec --dangerously-bypass-approvals-and-sandbox \
  "Reply with exactly this and nothing else: PROBE-OK-7391" < /dev/null 2>&1)
if echo "$CODEX_PROBE_OUT" | grep -qiE "hit your usage limit|usage limit|rate.?limit|quota"; then
  RESET_TIME=$(echo "$CODEX_PROBE_OUT" | grep -oE "try again at[^.]*\." | head -1)
  warn "Codex quota dead: ${RESET_TIME:-(unknown reset time)} — codex disabled this run"
  CODEX_DEAD=1
elif ! echo "$CODEX_PROBE_OUT" | grep -q "PROBE-OK-7391"; then
  # Drop hook/MCP chatter so the real error stays visible.
  CODEX_TAIL=$(echo "$CODEX_PROBE_OUT" | grep -viE '^hook:|rmcp::|^tokens used' | tail -3)
  warn "Codex answered but produced nothing usable — codex disabled this run"
  warn "  Last lines: ${CODEX_TAIL:-(no output)}"
  warn "  Often the configured model is not valid for the current auth mode."
  warn "  Check: codex login status  +  the model in ~/.codex/config.toml"
  CODEX_DEAD=1
else
  ok "Codex works (probe returned its sentinel)"
  CODEX_DEAD=0
fi

# ─── 4b. Codex update-prompt suppression (regression van 2026-05-10) ───
# Codex CLI toont op startup een interactieve "Update available!" prompt zodra
# latest_version > dismissed_version in ~/.codex/version.json. De ensemble
# spawn-flow stuurt vervolgens een Enter, wat optie 1 (update now) selecteert
# → codex draait `brew upgrade` en exit terug naar zsh, waarna alle prompt-
# berichten in de zsh shell belanden (en de pane corrupt raakt). Hard-block:
# zet dismissed_version gelijk aan latest_version vóór elke spawn.
CODEX_VERSION_FILE="${HOME}/.codex/version.json"
if [ -f "$CODEX_VERSION_FILE" ]; then
  CODEX_PROMPT_STATE=$(VERSION_FILE="$CODEX_VERSION_FILE" python3 - <<'PY'
import json, os, sys
path = os.environ['VERSION_FILE']
try:
    with open(path) as f:
        data = json.load(f)
except Exception as e:
    print(f"unreadable: {e}")
    sys.exit(0)
latest = data.get('latest_version')
dismissed = data.get('dismissed_version')
if not latest:
    print("no-latest")
    sys.exit(0)
if dismissed == latest:
    print(f"already-dismissed:{latest}")
    sys.exit(0)
data['dismissed_version'] = latest
with open(path, 'w') as f:
    json.dump(data, f)
print(f"dismissed:{latest}")
PY
)
  case "$CODEX_PROMPT_STATE" in
    already-dismissed:*) ok "Codex update-prompt al gedismissed (${CODEX_PROMPT_STATE#already-dismissed:})" ;;
    dismissed:*)         ok "Codex update-prompt onschadelijk gemaakt (${CODEX_PROMPT_STATE#dismissed:})" ;;
    no-latest)           warn "Codex version.json zonder latest_version (kan ok zijn na verse install)" ;;
    unreadable:*)        warn "Codex version.json onleesbaar — startup-prompt kan herstarten ($CODEX_PROMPT_STATE)" ;;
    *)                   warn "Codex version.json check onverwacht: $CODEX_PROMPT_STATE" ;;
  esac
else
  warn "Codex version.json niet gevonden (~/.codex/version.json) — startup-prompt-suppressie skipped"
fi
fi  # end: wants codex

# ─── 4c. Grok CLI auth ───
# Grok blocks on two interactive gates that would freeze a spawned pane:
#   * the project-directory picker (killed by hints.project_picker_disabled)
#   * the folder-trust dialog (killed by the --trust flag in agents.json)
# Both are handled outside this check; here we only verify binary + auth.
if wants grok; then
  if ! command -v grok > /dev/null 2>&1; then
    fail 6 "grok binary not in PATH
     Fix: install the Grok CLI (https://x.ai) or check PATH"
  fi
  # Classify the CLI's answer. Reads the WHOLE output, not just the first line:
  # grok prints update banners above its status line, and a `head -1` grep then
  # reports a perfectly logged-in CLI as logged out. Out-of-credit is checked
  # first because it needs a different fix than logging in (seen 2026-08-21:
  # 402 Payment Required, and the CLI silently waits on an upgrade page).
  grok_auth_state() {
    case "$(printf '%s' "$1" | tr 'A-Z' 'a-z')" in
      *"payment required"*|*402*|*"out of credit"*|*"credit limit"*|*"quota"*)
        echo "no-credit" ;;
      *"logged in"*)
        echo "ok" ;;
      *)
        echo "logged-out" ;;
    esac
  }

  GROK_RETRY_SECS="${COLLAB_GROK_RETRY_SECS:-30}"
  GROK_AUTH=$(timeout 20 grok models 2>&1)
  GROK_STATE=$(grok_auth_state "$GROK_AUTH")

  # Logging in takes half a minute in another window. Rather than failing the
  # whole run and making the caller start over, hand them that window once, but
  # only when someone is actually watching the output.
  if [ "$GROK_STATE" = "logged-out" ] && [ -t 1 ] && [ "$GROK_RETRY_SECS" -gt 0 ]; then
    warn "Grok not logged in. Run 'grok login' in another window, checking again in ${GROK_RETRY_SECS}s"
    sleep "$GROK_RETRY_SECS"
    GROK_AUTH=$(timeout 20 grok models 2>&1)
    GROK_STATE=$(grok_auth_state "$GROK_AUTH")
  fi

  GROK_LINE=$(printf '%s' "$GROK_AUTH" | grep -iE "logged in|payment|credit|quota" | head -1)
  [ -n "$GROK_LINE" ] || GROK_LINE=$(printf '%s' "$GROK_AUTH" | head -1)

  case "$GROK_STATE" in
    ok)
      GROK_MODEL=$(printf '%s' "$GROK_AUTH" | grep -iE "^default model:" | head -1)
      ok "Grok authenticated: ${GROK_LINE:0:60}${GROK_MODEL:+ (${GROK_MODEL})}"
      GROK_DEAD=0
      ;;
    no-credit)
      warn "Grok is logged in but out of credit: ${GROK_LINE:0:80}"
      warn "  This is not an auth problem: the weekly allowance reset date decides, not 'grok login'."
      GROK_DEAD=1
      ;;
    *)
      warn "Grok not authenticated. Status: ${GROK_LINE:0:80}"
      warn "  Fix: grok login"
      GROK_DEAD=1
      ;;
  esac

  # The project-directory picker blocks the very first turn in a fresh pane.
  # It is a one-time hint in ~/.grok/config.toml; warn instead of failing, since
  # a user who has already dismissed it manually is fine either way.
  if [ -f "$HOME/.grok/config.toml" ] && grep -q "project_picker_disabled" "$HOME/.grok/config.toml"; then
    ok "Grok project-picker suppressed"
  else
    warn "Grok project-picker not suppressed — the agent may hang on a directory dialog"
    warn "  Fix: add   hints = { project_picker_disabled = true }   to ~/.grok/config.toml"
  fi
fi

# ─── 5. Claude CLI auth — test in TMUX-context (where agents actually spawn) ───
# REGRESSION 2026-05-13: previous test ran in caller shell. When the caller is a
# Claude Code session under Happy, that shell has in-process auth that does NOT
# propagate to children. Result: preflight passed but spawned claude in tmux
# was "Not logged in", agents died silently. This test now runs in the same
# context as the real spawn (fresh tmux pane, unset CLAUDECODE).
if ! wants claude; then
  ok "Claude not in this run (agents: $REQUESTED_AGENTS) — skipping claude checks"
  CLAUDE_DEAD=0
elif ! command -v claude > /dev/null 2>&1; then
  # Mark it dead and let the decision block below choose, exactly like the codex
  # and grok probes do. Deciding here used to write the codex-only override
  # directly and leave CLAUDE_DEAD unset, so a run that NAMED claude passed
  # preflight with no claude binary at all, and the override it wrote was thrown
  # away by the explicit-agents branch anyway.
  warn "claude binary not in PATH"
  warn "  Fix: install the Claude Code CLI or check PATH"
  CLAUDE_DEAD=1
else
  CLAUDE_PROBE_SESS="collab-preflight-claude-$$"
  CLAUDE_PROBE_OUT="/tmp/collab-preflight-claude-$$.out"
  rm -f "$CLAUDE_PROBE_OUT"
  tmux new-session -d -s "$CLAUDE_PROBE_SESS" -c "$HOME" 2>/dev/null
  tmux send-keys -t "$CLAUDE_PROBE_SESS" -l " unset CLAUDECODE; claude auth status > $CLAUDE_PROBE_OUT 2>&1; echo DONE_$$ >> $CLAUDE_PROBE_OUT"
  tmux send-keys -t "$CLAUDE_PROBE_SESS" C-m
  # Wait up to 8s for probe
  for _ in $(seq 1 16); do
    grep -q "DONE_$$" "$CLAUDE_PROBE_OUT" 2>/dev/null && break
    sleep 0.5
  done
  tmux kill-session -t "$CLAUDE_PROBE_SESS" 2>/dev/null

  CLAUDE_PROBE=$(cat "$CLAUDE_PROBE_OUT" 2>/dev/null || echo "")
  rm -f "$CLAUDE_PROBE_OUT"

  if echo "$CLAUDE_PROBE" | grep -q '"loggedIn": true'; then
    ok "Claude auth verified in spawn-context (tmux)"
    CLAUDE_DEAD=0
  elif echo "$CLAUDE_PROBE" | grep -qE '"loggedIn": false|"authMethod": "none"'; then
    warn "Claude NOT logged in in spawn-context"
    warn "  Fix permanent: open fresh terminal (zonder Happy) en run: claude /login"
    CLAUDE_DEAD=1
  else
    warn "Claude auth-probe inconclusive (probe output: ${CLAUDE_PROBE:0:120})"
    CLAUDE_DEAD=1
  fi
fi

# ─── Decide which agents to spawn ───
CODEX_DEAD="${CODEX_DEAD:-0}"
CLAUDE_DEAD="${CLAUDE_DEAD:-0}"
GROK_DEAD="${GROK_DEAD:-0}"

# When the caller named its agents explicitly, never silently swap in a different
# one: the user asked for these agents, so a dead one is a hard failure they need
# to see. The auto-fallback below only applies to the implicit codex+claude pair.
if [ "$EXPLICIT_AGENTS" = "1" ]; then
  DEAD_LIST=""
  [ "$CODEX_DEAD" = "1" ] && DEAD_LIST="$DEAD_LIST codex"
  [ "$CLAUDE_DEAD" = "1" ] && DEAD_LIST="$DEAD_LIST claude"
  [ "$GROK_DEAD" = "1" ] && DEAD_LIST="$DEAD_LIST grok"
  if [ -n "$DEAD_LIST" ]; then
    rm -f /tmp/collab-agents-override.txt
    fail 3 "Requested agents unavailable:$DEAD_LIST
     You asked for: $REQUESTED_AGENTS
     Fix the agent above, or relaunch naming different agents."
  fi
  rm -f /tmp/collab-agents-override.txt
  echo -e "  ${GRN}${BD}All preflight checks passed${R}"
  exit 0
fi

if [ "$CODEX_DEAD" = "1" ] && [ "$CLAUDE_DEAD" = "1" ]; then
  rm -f /tmp/collab-agents-override.txt
  fail 3 "BEIDE agents zijn dood. /collab kan niet draaien:
     - Codex: usage limit hit (zie waarschuwing hierboven)
     - Claude: not logged in in spawn-context
     Fix: wacht tot codex-quota reset OF run 'claude /login' in een fresh terminal"
elif [ "$CODEX_DEAD" = "1" ]; then
  warn "Auto-fallback: claude-only (codex quota op)"
  echo "claude" > /tmp/collab-agents-override.txt
elif [ "$CLAUDE_DEAD" = "1" ]; then
  # "niet beschikbaar", not "niet ingelogd": claude also counts as dead when the
  # binary is missing entirely, and the old wording sent people to a login screen.
  warn "Auto-fallback: codex-only (claude niet beschikbaar)"
  echo "codex" > /tmp/collab-agents-override.txt
else
  rm -f /tmp/collab-agents-override.txt
fi

echo -e "  ${GRN}${BD}All preflight checks passed${R}"
exit 0
