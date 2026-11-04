#!/usr/bin/env bash
# collab-launch.sh — All-in-one team launcher with clean output
# Usage: collab-launch.sh <working-dir> <task-description> [agents-csv] [template]
#
#   agents-csv  comma-separated agent keys from agents.json (first = lead).
#               Default: codex (lead) + claude code (worker).
#   template    key from collab-templates.json: review|implement|research|debug.
#               Also settable via COLLAB_TEMPLATE. Empty = generic lead/worker roles.
#
# Monitor selection (env vars):
#   COLLAB_MONITOR=auto     (default) herdr, Orca or iTerm pane, else tmux
#   COLLAB_MONITOR=orca     open in the current Orca pane
#   COLLAB_MONITOR=iterm    force iTerm split
#   COLLAB_MONITOR=tmux     force a detached tmux session (old behavior)
#   COLLAB_MONITOR=none     no monitor at all
#   COLLAB_ORCA_MODE=split (default) | tab   how Orca opens the monitor
#   COLLAB_ITERM_MODE=split (default) | tab | window   how iTerm opens the monitor
# COLLAB_WORKTREE=team creates a retained shared git worktree for local agents.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=./collab-paths.sh
source "$SCRIPT_DIR/collab-paths.sh"

CWD="${1:-.}"
TASK="${2:?Usage: collab-launch.sh <cwd> <task> [agents] [template]}"
# Optional: comma-separated agent names (e.g. "agy,claude"). Falls back to
# COLLAB_AGENTS so a preferred line-up can be set once in the shell instead of
# being retyped every run; collab-preflight.sh already reads the same variable.
# Precedence: 3rd argument > COLLAB_AGENTS > configured plan > default pair.
# Only the positional argument is explicit; environment and plan selections
# keep preflight's automatic fallback.
AGENTS="${3:-${COLLAB_AGENTS:-}}"
AGENTS_SOURCE="explicit"
if [ -z "${3:-}" ]; then
  AGENTS_SOURCE="env"
fi
# Optional collab template key from collab-templates.json (review|implement|research|debug).
# Assigns explicit roles to each agent instead of the generic lead/worker prompt.
TEMPLATE="${4:-${COLLAB_TEMPLATE:-}}"

# ─── Auto-fallback to codex-only when claude auth is dead (set by preflight) ───
# Preflight writes OVERRIDE_FILE when an agent probe selects a fallback. The
# default is under the shared runtime root and can be overridden by callers.
# Only kicks in if caller didn't specify AGENTS explicitly.
OVERRIDE_FILE="${COLLAB_OVERRIDE_FILE:-$(collab_runtime_root)/collab-agents-override.txt}"
rm -f "$OVERRIDE_FILE"
API="${ENSEMBLE_URL:-http://localhost:23000}"
HOST_ID="${ENSEMBLE_HOST_ID:-local}"

# Resolve a configured plan before preflight so its agents are the ones probed.
# The query uses the same merged base and user agent config as the server.
# The task is passed as a positional argument, never interpolated into shell code.
if [ -z "$AGENTS" ]; then
  KNOWN_AGENTS=$("$REPO_DIR/node_modules/.bin/tsx" "$SCRIPT_DIR/agent-config-query.ts" keys) || KNOWN_AGENTS='[]'
  PLAN_RESULT=$(python3 - "$KNOWN_AGENTS" "$TASK" <<'PY'
import json, os, signal, subprocess, sys

command = os.environ.get('ENSEMBLE_PLAN_CMD', '').strip()
if not command:
    config_path = os.environ.get('ENSEMBLE_CONFIG', os.path.expanduser('~/.config/ensemble/config.json'))
    try:
        with open(config_path) as source:
            command = json.load(source).get('planCommand', '')
    except (OSError, ValueError, AttributeError):
        command = ''
if not isinstance(command, str) or not command.strip():
    sys.exit(1)
try:
    known = set(json.loads(sys.argv[1]))
    process = subprocess.Popen(
        ['/bin/bash', '-c', command + ' "$@"', 'ensemble-plan', sys.argv[2]],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True,
    )
    try:
        output, _ = process.communicate(timeout=20)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        sys.exit(1)
    if process.returncode:
        sys.exit(1)
    plan = json.loads(output)
    agents = plan.get('agents')
    if not isinstance(agents, list) or not agents or not all(isinstance(key, str) for key in agents):
        sys.exit(1)
    agents = [key for key in agents if key in known]
    if not agents:
        sys.exit(1)
    template = plan.get('template', '')
    reason = plan.get('reason', '')
    if not isinstance(template, str) or not isinstance(reason, str):
        sys.exit(1)
    clean = lambda value: ' '.join(value.split()).replace('\x1f', ' ')
    print('\x1f'.join([','.join(agents), clean(template), clean(reason)[:120]]))
except (OSError, ValueError, AttributeError, TypeError):
    sys.exit(1)
PY
  ) || PLAN_RESULT=""
  if [ -n "$PLAN_RESULT" ]; then
    IFS=$'\x1f' read -r AGENTS PLAN_TEMPLATE PLAN_REASON <<< "$PLAN_RESULT"
    AGENTS_SOURCE="plan"
    if [ -z "$TEMPLATE" ]; then TEMPLATE="$PLAN_TEMPLATE"; fi
    echo "Plan: agents=$AGENTS, template=${TEMPLATE:-none}${PLAN_REASON:+ ($PLAN_REASON)}"
  fi
fi

# ─── Colors ───
G='\033[92m'; C='\033[96m'; D='\033[2m'; W='\033[97m'; BD='\033[1m'; R='\033[0m'
CHECK="${G}✓${R}"
SPIN="${C}●${R}"

echo ""
echo -e "  ${BD}${W}◈ ensemble collab${R}"
echo -e "  ${D}${TASK:0:80}${R}"
echo ""

# ─── 1. Server ───
if curl -sf "$API/api/v1/health" > /dev/null 2>&1; then
  echo -e "  ${CHECK} Server running"
else
  echo -ne "  ${SPIN} Starting server..."
  cd "$REPO_DIR" && ./node_modules/.bin/tsx server.ts > /tmp/ensemble-server.log 2>&1 &
  # Eerst kijken, dan pas slapen, en in kleinere stappen. Andersom kostte een
  # server die na 100ms klaar was altijd minstens een volle seconde.
  for _ in $(seq 1 40); do curl -sf "$API/api/v1/health" > /dev/null 2>&1 && break; sleep 0.2; done
  if curl -sf "$API/api/v1/health" > /dev/null 2>&1; then
    echo -e "\r  ${CHECK} Server started       "
  else
    echo -e "\r  \033[91m✗${R} Server failed to start"; exit 1
  fi
fi

# ─── 1b. Preflight checks (auth + DNS + service age) ───
# Skip with COLLAB_SKIP_PREFLIGHT=1 if needed.
# Pass the requested agents so preflight only checks the CLIs this run needs.
PREFLIGHT_INPUT_AGENTS="$AGENTS"
if [ "${COLLAB_SKIP_PREFLIGHT:-0}" != "1" ]; then
  if COLLAB_AGENTS_SOURCE="$AGENTS_SOURCE" "$SCRIPT_DIR/collab-preflight.sh" "$AGENTS" 2>&1 | sed 's/^/  /'; then
    :
  else
    PREFLIGHT_EXIT=${PIPESTATUS[0]}
    echo -e "\n  ${R}\033[91m✗${R} Preflight FAILED — fix above issues then re-run."
    echo -e "  ${D}(bypass with COLLAB_SKIP_PREFLIGHT=1, but agents will likely fail)${R}"
    # 7 (geen gezonde fallback) en 9 (een agent wacht op een startdialoog)
    # vragen om een andere actie dan "probeer opnieuw", dus die codes gaan
    # ongewijzigd naar de aanroeper.
    case "$PREFLIGHT_EXIT" in
      7|9) exit "$PREFLIGHT_EXIT" ;;
    esac
    exit 1
  fi
fi

if [ "$AGENTS_SOURCE" != "explicit" ] && [ -f "$OVERRIDE_FILE" ]; then
  OVERRIDE_AGENTS=$(cat "$OVERRIDE_FILE" 2>/dev/null || echo "")
  if [ -n "$OVERRIDE_AGENTS" ]; then
    AGENTS="$OVERRIDE_AGENTS"
    FALLBACK_DIFF=$(python3 - "${PREFLIGHT_INPUT_AGENTS:-codex,claude}" "$OVERRIDE_AGENTS" <<'PY'
import sys

def normalize(s):
    return [x.strip().lower() for x in s.split(',') if x.strip()]

before = normalize(sys.argv[1])
after = normalize(sys.argv[2])

if before != after:
    removed = [a for a in before if a not in after]
    added = [a for a in after if a not in before]
    if removed and len(removed) == len(added):
        print(', '.join(f"{r} -> {a}" for r, a in zip(removed, added)))
    elif before and after:
        print(f"{','.join(before)} -> {','.join(after)}")
    else:
        print(','.join(after))
PY
    ) || FALLBACK_DIFF=""
    if [ -n "$FALLBACK_DIFF" ]; then
      echo -e "  \033[93m!\033[0m Auto-fallback: $FALLBACK_DIFF (zie preflight)"
    fi
  fi
fi

# ─── 2. Create team (use env vars to avoid quoting hell) ───
TEAM_NAME="collab-$(python3 -c 'import random,time; print(str(time.time_ns()//1000000)+"-"+str(random.randint(1000,9999)))')"
PAYLOAD_FILE=$(mktemp)
TNAME="$TEAM_NAME" TDESC="$TASK" TCWD="$CWD" THOST="$HOST_ID" TAGENTS="$AGENTS" TTEMPLATE="$TEMPLATE" TWORKTREE="${COLLAB_WORKTREE:-}" TEXPLICIT="$AGENTS_SOURCE" PFILE="$PAYLOAD_FILE" python3 -c "
import json, os
agents_str = os.environ.get('TAGENTS', '')
if agents_str:
    names = [a.strip() for a in agents_str.split(',')]
    agents = [{'program': names[0], 'role': 'lead', 'hostId': os.environ['THOST']}]
    for n in names[1:]:
        agents.append({'program': n, 'role': 'worker', 'hostId': os.environ['THOST']})
else:
    agents = [
        {'program': 'codex', 'role': 'lead', 'hostId': os.environ['THOST']},
        {'program': 'claude code', 'role': 'worker', 'hostId': os.environ['THOST']},
    ]
payload = {
    'name': os.environ['TNAME'],
    'description': os.environ['TDESC'],
    'agents': agents,
    'feedMode': 'live',
    'workingDirectory': os.environ['TCWD']
}
if os.environ.get('TWORKTREE') == 'team':
    payload['worktree'] = 'team'
# Een met de hand opgegeven ploeg mag de service niet aanvullen of omwisselen.
if os.environ.get('TEXPLICIT') == 'explicit':
    payload['agentsExplicit'] = True
template = os.environ.get('TTEMPLATE', '').strip()
if template:
    payload['templateName'] = template
json.dump(payload, open(os.environ['PFILE'], 'w'))
"
# Hier stond `curl -sf`, en -f gooit bij een HTTP-fout het antwoord weg en geeft
# exit 22. Onder `set -e` stapte het script daar meteen uit: exitcode 22, die in
# geen enkele tabel staat, en een leeg scherm. Gemeten 04-11-2026 met de
# typefout `grk`: de service antwoordde netjes met 400 en
# `Unknown agent(s): "grk". Available: ...`, en juist die regel haalde het
# scherm niet. Nu halen we de code en het antwoord apart op.
ANTWOORD_FILE=$(mktemp "${TMPDIR:-/tmp}/collab-create-XXXXXX")
HTTP_CODE=$(curl -s -o "$ANTWOORD_FILE" -w '%{http_code}' -X POST "$API/api/ensemble/teams" \
  -H "Content-Type: application/json" \
  -d @"$PAYLOAD_FILE" || echo "000")
rm -f "$PAYLOAD_FILE"
RESULT=$(cat "$ANTWOORD_FILE" 2>/dev/null || echo "")
rm -f "$ANTWOORD_FILE"

case "$HTTP_CODE" in
  200|201) ;;
  *)
    # Eén keer lezen, en bij onleesbare JSON (een proxy die HTML teruggeeft)
    # de ruwe tekst tonen: iets is altijd beter dan niets.
    REDEN=$(printf '%s' "$RESULT" | python3 -c "
import json, sys
ruw = sys.stdin.read()
try:
    data = json.loads(ruw)
    print(data.get('error') or data.get('message') or json.dumps(data)[:400])
except Exception:
    print(' '.join(ruw.split())[:400])
" 2>/dev/null || true)
    echo -e "  \033[91m✗${R} De service wil dit team niet aanmaken (HTTP ${HTTP_CODE})" >&2
    if [ -n "$REDEN" ]; then
      printf '    %s\n' "$REDEN" >&2
    else
      echo "    Geen uitleg in het antwoord; kijk in /tmp/ensemble-server.log" >&2
    fi
    exit 5
    ;;
esac

TEAM_ID=$(printf '%s' "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['team']['id'])" 2>/dev/null || true)
if [ -z "$TEAM_ID" ]; then
  echo -e "  \033[91m✗${R} De service gaf geen team-id terug (HTTP ${HTTP_CODE})" >&2
  printf '    %s\n' "$(printf '%s' "$RESULT" | head -c 300)" >&2
  exit 5
fi
RUNTIME_DIR="$(collab_runtime_dir "$TEAM_ID")"
# De aanroepers (de collab-skill, cleanroom-test.sh) lezen het team-id van de
# laatste TEAM_ID=-regel uit onze stdout. Bij een vroege exit moet die regel er
# dus ook staan: zonder team-id kan niemand het herstelpad volgen dat we in de
# foutmelding aanraden.
print_team_id_trailer() {
  echo "TEAM_ID=$TEAM_ID"
}

# Het team blijft staan, ook als wij het niet meer kunnen begeleiden.
#
# Op 03-11-2026 liet ik een exit 4 het team zelf opheffen, omdat het anders
# actief in het register bleef staan met draaiende sessies. Een uur later gooide
# precies die opruiming een werkend team weg, omdat de poller even niet opkwam.
# Sinds 04-11-2026 geldt de regel: geen script in deze gereedschapskist heft een
# team op. De agents draaien, hun werk is er nog, en wij melden alleen wat er
# mis is en wat je kunt doen.
meld_half_gestart_team() {
  echo -e "  \033[93m!${R} Het team draait wel; alleen jij heft een team op." >&2
  echo "    Bridge opnieuw starten: $SCRIPT_DIR/ensemble-bridge.sh $TEAM_ID $API" >&2
  echo "    Of opheffen:            curl -s -X POST $API/api/ensemble/teams/$TEAM_ID/disband" >&2
}

MESSAGES_FILE="$(collab_messages_file "$TEAM_ID")"
BRIDGE_PID_FILE="$(collab_bridge_pid "$TEAM_ID")"
BRIDGE_LOG_FILE="$(collab_bridge_log "$TEAM_ID")"
POLLER_PID_FILE="$(collab_poller_pid "$TEAM_ID")"
FEED_FILE="$(collab_feed_file "$TEAM_ID")"
TEAM_ID_FILE="$(collab_team_id_file "$TEAM_ID")"

collab_ensure_runtime_dir "$TEAM_ID" >/dev/null
mkdir -p "$(dirname "$MESSAGES_FILE")" "$(dirname "$FEED_FILE")"
touch "$MESSAGES_FILE"
printf '%s\n' "$TEAM_ID" > "$TEAM_ID_FILE"
# $RUNTIME_DIR/sessions (welke tmux-sessies bij dit team horen) wordt door de
# service zelf geschreven, in services/ensemble-service.ts vóór Phase 2. Dat is
# de ene plek waar de sessienaam ontstaat; dit script bouwt 'm niet opnieuw op.
# Also write to a well-known location so callers can find the latest team ID.
# NOTE: this file is global and gets overwritten by concurrent launches. Callers
# that support parallel collabs should read the TEAM_ID=... line from stdout instead.
printf '%s\n' "$TEAM_ID" > "${COLLAB_TEAM_ID_FILE:-/tmp/collab-team-id.txt}"
echo -e "  ${CHECK} Team created ${D}(${TEAM_NAME})${R}"
if [ -n "$TEMPLATE" ]; then
  echo -e "  ${CHECK} Template ${D}${TEMPLATE}${R}"
fi

# ─── 3. Bridge (writes its own PID file via single-instance guard) ───
nohup "$SCRIPT_DIR/ensemble-bridge.sh" "$TEAM_ID" "$API" >> "$BRIDGE_LOG_FILE" 2>&1 &
# Even kijken of hij het overleeft. Hiervoor kwam het vinkje er altijd, ook als
# de bridge meteen stuksloeg op zijn health check en het team dus nooit een
# bericht naar de API zou sturen. Kijken tot het pid-bestand er is, niet een
# vaste 0,3 seconde: dat bestand staat er normaal binnen 30 milliseconden.
BRIDGE_JOB=$!
# Zelfde als bij de poller hieronder: eerst de job zelf, want het pid-bestand
# kan net nog niet geschreven zijn, en wachten tot het proces er niet meer is
# scheelt de volle wachttijd bij een bridge die echt omvalt.
for _ in $(seq 1 60); do
  [ -s "$BRIDGE_PID_FILE" ] && break
  kill -0 "$BRIDGE_JOB" 2>/dev/null || break
  sleep 0.05
done
BRIDGE_PID=$(cat "$BRIDGE_PID_FILE" 2>/dev/null || echo "")
if [ -z "$BRIDGE_PID" ] && kill -0 "$BRIDGE_JOB" 2>/dev/null; then BRIDGE_PID="$BRIDGE_JOB"; fi
if [ -n "$BRIDGE_PID" ] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
  echo -e "  ${CHECK} Bridge started ${D}(pid $BRIDGE_PID)${R}"
else
  echo -e "  \033[91m✗${R} Bridge stopte direct, zie $BRIDGE_LOG_FILE" >&2
  meld_half_gestart_team
  print_team_id_trailer
  exit 4
fi

# ─── 4. Monitor ───
# Monitor selection order (override via COLLAB_MONITOR=herdr|orca|tmux|iterm|none):
#   1. herdr pane: if running inside a herdr workspace
#   2. Orca pane: if running inside Orca and its CLI is available
#   3. tmux split: if already inside a tmux session
#   4. iTerm split: on macOS when iTerm2 is the active terminal (or forced)
#   5. tmux detached session: cross-platform fallback
#
# herdr and Orca own their panes and must both be checked before iTerm. herdr
# draws its panes inside a host iTerm session but passes TERM_PROGRAM through
# unchanged, so trusting TERM_PROGRAM there opens a real iTerm split outside the
# layout the user is watching: it succeeds, reports success, and is never seen.
# HERDR_ENV=1 and ORCA_AGENT_PANE are the reliable signals.
MONITOR_ENV_PREFIX=""
for KEY in ENSEMBLE_URL ENSEMBLE_DATA_DIR ENSEMBLE_PORT ENSEMBLE_HOST ENSEMBLE_CORS_ORIGIN ENSEMBLE_AGENTS_CONFIG ENSEMBLE_AGENTS_EXTRA ENSEMBLE_AGENT_FLAGS ENSEMBLE_HOST_ID; do
  VALUE="${!KEY:-}"
  if [ -n "$VALUE" ]; then
    MONITOR_ENV_PREFIX+="$KEY=$(printf '%q' "$VALUE") "
  fi
done
MONITOR_CMD="cd '$REPO_DIR' && ${MONITOR_ENV_PREFIX}node --import tsx cli/monitor.ts $TEAM_ID"
MONITOR_PREF="${COLLAB_MONITOR:-auto}"

use_herdr=false
if [ "$MONITOR_PREF" = "herdr" ]; then
  use_herdr=true
elif [ "$MONITOR_PREF" = "auto" ] && [ "${HERDR_ENV:-}" = "1" ] && command -v herdr > /dev/null 2>&1; then
  use_herdr=true
fi

use_orca=false
if [ "$MONITOR_PREF" = "orca" ]; then
  use_orca=true
elif [ "$MONITOR_PREF" = "auto" ] && [ "$use_herdr" = false ] \
     && [ -n "${ORCA_AGENT_PANE:-}" ] \
     && { command -v orca >/dev/null 2>&1 || [ -x /Applications/Orca.app/Contents/Resources/bin/orca ]; }; then
  use_orca=true
fi

use_iterm=false
if [ "$MONITOR_PREF" = "iterm" ]; then
  use_iterm=true
elif [ "$MONITOR_PREF" = "auto" ] && [ "$use_herdr" = false ] && [ "$use_orca" = false ] && [ -z "${TMUX:-}" ] \
     && [ "$(uname)" = "Darwin" ] && [ "${TERM_PROGRAM:-}" = "iTerm.app" ]; then
  use_iterm=true
fi

if [ "$MONITOR_PREF" = "none" ]; then
  echo -e "  ${CHECK} Monitor skipped ${D}(COLLAB_MONITOR=none)${R}"
  MONITOR_MODE="none"
elif [ "$use_herdr" = true ]; then
  HERDR_MODE="${COLLAB_HERDR_MODE:-split}"
  if HERDR_RESULT=$("$SCRIPT_DIR/open-herdr-monitor.sh" "$REPO_DIR" "$TEAM_ID" "$HERDR_MODE" 2>/tmp/ensemble-herdr.err); then
    # Eerst de pane-id lezen, dan pas het vinkje. Vindt de sed niets, dan komt
    # er geen herdr-pane-id op schijf en blijft de pane na afloop openstaan
    # terwijl de gebruiker al een geslaagde start had gezien.
    MONITOR_MODE="herdr"
    HERDR_PANE=$(printf '%s\n' "$HERDR_RESULT" | sed -n 's/.*new_pane_id=\([^ ]*\).*/\1/p' | tail -1)
    if [ -n "$HERDR_PANE" ]; then
      printf '%s\n' "$HERDR_PANE" > "$RUNTIME_DIR/herdr-pane-id"
      echo -e "  ${CHECK} Monitor opened ${D}(herdr ${HERDR_MODE})${R}"
    else
      echo -e "  \033[93m!${R} Monitor gestart maar herdr gaf geen pane-id terug (zie /tmp/collab-herdr-last.log)"
    fi
  else
    echo -e "  ${D}herdr launch failed: $(head -1 /tmp/ensemble-herdr.err 2>/dev/null)${R}"
    echo -e "  ${D}Falling back to tmux session...${R}"
    MONITOR_SESSION="ensemble-$TEAM_ID"
    tmux kill-session -t "$MONITOR_SESSION" 2>/dev/null || true
    tmux new-session -d -s "$MONITOR_SESSION" -c "$REPO_DIR" \
      "node --import tsx cli/monitor.ts $TEAM_ID"
    echo -e "  ${CHECK} Monitor ready ${D}(tmux attach -t $MONITOR_SESSION)${R}"
    MONITOR_MODE="session"
  fi
elif [ "$use_orca" = true ]; then
  ORCA_MODE="${COLLAB_ORCA_MODE:-split}"
  if ORCA_RESULT=$("$SCRIPT_DIR/open-orca-monitor.sh" "$REPO_DIR" "$TEAM_ID" "$ORCA_MODE" 2>/tmp/ensemble-orca.err); then
    ORCA_TERMINAL=$(printf '%s\n' "$ORCA_RESULT" | sed -n 's/.*new_pane_id=\([^ ]*\).*/\1/p' | tail -1)
    if [ -n "$ORCA_TERMINAL" ]; then
      echo -e "  ${CHECK} Monitor opened ${D}(Orca ${ORCA_MODE})${R}"
      MONITOR_MODE="orca"
    else
      echo -e "  \033[93m!${R} Monitor gestart maar Orca gaf geen terminal-id terug (zie /tmp/collab-orca-last.log)"
      MONITOR_MODE="orca"
    fi
  else
    echo -e "  ${D}Orca launch failed: $(head -1 /tmp/ensemble-orca.err 2>/dev/null)${R}"
    echo -e "  ${D}Falling back to tmux session...${R}"
    MONITOR_SESSION="ensemble-$TEAM_ID"
    tmux kill-session -t "$MONITOR_SESSION" 2>/dev/null || true
    tmux new-session -d -s "$MONITOR_SESSION" -c "$REPO_DIR" \
      "node --import tsx cli/monitor.ts $TEAM_ID"
    echo -e "  ${CHECK} Monitor ready ${D}(tmux attach -t $MONITOR_SESSION)${R}"
    MONITOR_MODE="session"
  fi
elif [ -n "${TMUX:-}" ] && [ "$MONITOR_PREF" != "iterm" ]; then
  tmux split-window -h -l '40%' "$MONITOR_CMD"
  echo -e "  ${CHECK} Monitor opened ${D}(right panel)${R}"
  MONITOR_MODE="split"
elif [ "$use_iterm" = true ]; then
  ITERM_MODE="${COLLAB_ITERM_MODE:-split}"
  # Forward ITERM_SESSION_ID so the split lands in the pane the user actually
  # invoked collab from, not the frontmost iTerm window.
  if ITERM_RESULT=$(ITERM_SESSION_ID="${ITERM_SESSION_ID:-}" "$SCRIPT_DIR/open-iterm-monitor.sh" "$REPO_DIR" "$TEAM_ID" "$ITERM_MODE" 2>/tmp/ensemble-iterm.err); then
    echo -e "  ${CHECK} Monitor opened ${D}(iTerm ${ITERM_MODE})${R}"
    MONITOR_MODE="iterm"
    # Persist the iTerm2 session id so monitor.ts can close its own pane on exit.
    ITERM_SESSION_ID=$(printf '%s\n' "$ITERM_RESULT" | sed -n 's/.*new_session_id=\([^ ]*\).*/\1/p' | tail -1)
    if [ -n "$ITERM_SESSION_ID" ]; then
      printf '%s\n' "$ITERM_SESSION_ID" > "$RUNTIME_DIR/iterm-session-id"
    fi
  else
    echo -e "  ${D}iTerm launch failed: $(head -1 /tmp/ensemble-iterm.err 2>/dev/null)${R}"
    echo -e "  ${D}Falling back to tmux session...${R}"
    MONITOR_SESSION="ensemble-$TEAM_ID"
    tmux kill-session -t "$MONITOR_SESSION" 2>/dev/null || true
    tmux new-session -d -s "$MONITOR_SESSION" -c "$REPO_DIR" \
      "node --import tsx cli/monitor.ts $TEAM_ID"
    echo -e "  ${CHECK} Monitor ready ${D}(tmux attach -t $MONITOR_SESSION)${R}"
    MONITOR_MODE="session"
  fi
else
  MONITOR_SESSION="ensemble-$TEAM_ID"
  tmux kill-session -t "$MONITOR_SESSION" 2>/dev/null || true
  tmux new-session -d -s "$MONITOR_SESSION" -c "$REPO_DIR" \
    "./node_modules/.bin/tsx cli/monitor.ts $TEAM_ID"
  echo -e "  ${CHECK} Monitor ready ${D}(tmux attach -t $MONITOR_SESSION)${R}"
  MONITOR_MODE="session"
fi

# ─── 5. Background poller (writes its own PID file, stops when the team is over) ───
nohup "$SCRIPT_DIR/collab-poller.sh" "$TEAM_ID" "$API" > /dev/null 2>&1 &
# Zelfde controle als bij de bridge: zonder deze check kreeg de poller ook een
# vinkje terwijl hij meteen kon zijn gestopt (bijvoorbeeld omdat $RUNTIME_DIR
# nog niet bestond op het moment dat hij zijn pid-bestand probeerde te zetten).
POLLER_JOB=$!
# Eerst op de job zelf kijken, dan op het pid-bestand: de poller verwijdert dat
# bestand in zijn EXIT-trap, dus een race leest 'm net niet. Gemeten 03-11-2026
# schrijft hij het binnen 45 tot 85 milliseconden; drie seconden is dus ruim,
# ook als de machine vol staat met teams.
for _ in $(seq 1 60); do
  [ -s "$POLLER_PID_FILE" ] && break
  kill -0 "$POLLER_JOB" 2>/dev/null || break
  sleep 0.05
done
POLLER_PID=$(cat "$POLLER_PID_FILE" 2>/dev/null || echo "$POLLER_JOB")
if [ -n "$POLLER_PID" ] && kill -0 "$POLLER_PID" 2>/dev/null; then
  echo -e "  ${CHECK} Poller started ${D}(pid $POLLER_PID)${R}"
else
  # Geen harde fout meer. De poller kopieert alleen berichten naar het
  # feedbestand voor de monitor; de agents werken zonder hem, en de bridge (die
  # de berichten naar de API brengt) is wel een harde eis. Gemeten 03-11-2026
  # viel 1 van de 10 rookproeven om op deze check, waarna een werkend team werd
  # opgeheven met de melding dat het niet gestart was.
  echo -e "  \033[93m!${R} Poller kwam niet op; ik probeer het nog één keer" >&2
  nohup "$SCRIPT_DIR/collab-poller.sh" "$TEAM_ID" "$API" > /dev/null 2>&1 &
  POLLER_JOB=$!
  for _ in $(seq 1 60); do
    [ -s "$POLLER_PID_FILE" ] && break
    kill -0 "$POLLER_JOB" 2>/dev/null || break
    sleep 0.05
  done
  POLLER_PID=$(cat "$POLLER_PID_FILE" 2>/dev/null || echo "$POLLER_JOB")
  if [ -n "$POLLER_PID" ] && kill -0 "$POLLER_PID" 2>/dev/null; then
    echo -e "  ${CHECK} Poller started ${D}(pid $POLLER_PID, tweede poging)${R}"
  else
    echo -e "  \033[93m!${R} Poller blijft weg: de monitorfeed loopt achter, het team zelf werkt gewoon" >&2
  fi
fi

# ─── 6. Wait for agents ───
# Wachten op bewijs, niet op de klok. De service houdt per agent bij hoe ver de
# prompt kwam (pending, delivered, confirmed, failed) en 'confirmed' betekent
# dat die agent zelf een bericht heeft gestuurd. Hiervoor stond hier een vaste
# 12 seconden met een blik op messages.jsonl: te vroeg voor een agent die nog
# opstart, en veel te laat als de aflevering al was mislukt. Een service die
# dit veld niet kent ('unknown') valt terug op de oude telling.
AGENT_WAIT_SECS="${COLLAB_AGENT_WAIT_SECS:-120}"
echo -ne "  ${SPIN} Agents spawning..."
silent_agents() {
  python3 - "$RUNTIME_DIR/sessions" "$RUNTIME_DIR/prompts" "$MESSAGES_FILE" <<'PY'
import glob
import json
import os
import sys

sessions_path, prompts_dir, messages_path = sys.argv[1:]
agent_names = [os.path.basename(name)[:-4] for name in glob.glob(os.path.join(prompts_dir, '*.txt'))]
active = set()
try:
    with open(messages_path, encoding='utf-8') as source:
        for line in source:
            try:
                sender = json.loads(line).get('from')
            except (json.JSONDecodeError, AttributeError):
                continue
            if isinstance(sender, str):
                active.add(sender)
except OSError:
    pass

try:
    with open(sessions_path, encoding='utf-8') as source:
        sessions = [line.strip() for line in source if line.strip()]
except OSError:
    sessions = []

for session in sessions:
    matches = [name for name in agent_names if session.endswith('-' + name)]
    if not matches:
        continue
    agent_name = max(matches, key=len)
    if agent_name not in active:
        print(agent_name)
PY
}
sessions_without_prompt() {
  python3 - "$RUNTIME_DIR/sessions" "$RUNTIME_DIR/prompts" <<'PY'
import glob
import os
import sys

sessions_path, prompts_dir = sys.argv[1:]
agent_names = [os.path.basename(name)[:-4] for name in glob.glob(os.path.join(prompts_dir, '*.txt'))]
try:
    with open(sessions_path, encoding='utf-8') as source:
        sessions = [line.strip() for line in source if line.strip()]
except OSError:
    sessions = []
for session in sessions:
    if not any(session.endswith('-' + name) for name in agent_names):
        print(session)
PY
}
DELIVERY_STATE="unknown"
DELIVERY_FAILED=""
QUIET_AGENTS=""
for _ in $(seq 1 "$AGENT_WAIT_SECS"); do
  DELIVERY_STATE=$(curl -sf "$API/api/ensemble/teams/$TEAM_ID" 2>/dev/null | team_delivery_state)
  case "$DELIVERY_STATE" in
    confirmed) break ;;
    # Aangekomen is gestart. De pane nam de prompt aan en veranderde daarna; dat
    # is het bewijs waar het om ging. Of een agent binnen een minuut iets zegt,
    # is zijn eigen denktijd en geen startprobleem: tot 03-11-2026 wachtte de
    # launcher daar 120 seconden op en riep daarna dat het team niet startte.
    delivered*) QUIET_AGENTS="$(printf '%s' "${DELIVERY_STATE#delivered}" | xargs || true)"; break ;;
    failed*) DELIVERY_FAILED="${DELIVERY_STATE#failed }"; break ;;
    unknown)
      # Een service zonder dit veld: terug naar de telling op het sessieregister.
      SILENT_AGENTS=$(silent_agents)
      if [ -z "$SILENT_AGENTS" ] && [ -s "$RUNTIME_DIR/sessions" ]; then break; fi
      ;;
  esac
  sleep 1
done
MC=$(wc -l < "$MESSAGES_FILE" 2>/dev/null | tr -d ' ' || echo "0")
if [ "$DELIVERY_STATE" = "confirmed" ]; then
  SILENT_AGENTS=""
  echo -e "\r  ${CHECK} All agents communicating ${D}(${MC} messages)${R}"
elif [ "${DELIVERY_STATE#delivered}" != "$DELIVERY_STATE" ]; then
  SILENT_AGENTS=""
  if [ -n "$QUIET_AGENTS" ]; then
    echo -e "\r  ${CHECK} Prompt aangekomen bij alle agents ${D}(${MC} messages)${R}"
    echo -e "  ${D}nog geen bericht van: ${QUIET_AGENTS} — die denkt nog, de monitor laat het zien${R}"
  else
    echo -e "\r  ${CHECK} Prompt aangekomen bij alle agents ${D}(${MC} messages)${R}"
  fi
elif [ -n "$DELIVERY_FAILED" ]; then
  SILENT_AGENTS=$(printf '%s\n' $DELIVERY_FAILED)
  echo -e "\r  \033[91m✗${R} Prompt niet aangekomen bij: ${DELIVERY_FAILED}       "
else
  SILENT_AGENTS=$(silent_agents)
  if [ -z "$SILENT_AGENTS" ] && [ -s "$RUNTIME_DIR/sessions" ]; then
    echo -e "\r  ${CHECK} All agents communicating ${D}(${MC} messages)${R}"
  else
    echo -e "\r  ${SPIN} Waiting for agent messages...       "
  fi
fi

SESSIONS_WITHOUT_PROMPT=$(sessions_without_prompt)
while IFS= read -r session; do
  [ -z "$session" ] || echo -e "  ${D}sessie zonder promptbestand: $session${R}"
done <<< "$SESSIONS_WITHOUT_PROMPT"

# ─── 6b. Postcheck (run in background after 30s — kills team if agents broken) ───
# Skip with COLLAB_SKIP_POSTCHECK=1
if [ "${COLLAB_SKIP_POSTCHECK:-0}" != "1" ]; then
  nohup bash -c "sleep 25 && '$SCRIPT_DIR/collab-postcheck.sh' '$TEAM_ID' 5" \
    > "$RUNTIME_DIR/postcheck.log" 2>&1 &
fi

# ─── Output ───
echo ""
# Build dynamic agent list for display
TEAM_JSON=$(curl -sf "$API/api/ensemble/teams/$TEAM_ID" 2>/dev/null || echo "")
AGENT_NAMES=$(printf '%s' "$TEAM_JSON" \
  | python3 -c "import json,sys; t=json.load(sys.stdin); print(' + '.join(a['name'] for a in t['team']['agents']))" 2>/dev/null \
  || echo "agents")
# Steer hint must follow the real roster: a hardcoded "1/2 codex / claude" is
# wrong for any team that is not the default pair (three agents, or grok).
STEER_KEYS=$(printf '%s' "$TEAM_JSON" \
  | python3 -c "import json,sys; n=len(json.load(sys.stdin)['team']['agents']); print('/'.join(str(i+1) for i in range(min(n,4))))" 2>/dev/null \
  || echo "1/2")
STEER_TEXT=$(printf '%s' "$TEAM_JSON" \
  | python3 -c "
import json,sys
names=[a['name'] for a in json.load(sys.stdin)['team']['agents']][:4]
text='steer ' + ' / '.join(names)
print(text if len(text) <= 31 else text[:30] + '…')
" 2>/dev/null || echo "steer agents")
# "Team is live!" alleen bij bewijs. Hiervoor werd deze melding altijd gedrukt,
# ook als de wachtlus hierboven net had vastgesteld dat er nul berichten waren:
# de postcheck meldde daarna "agents may be in deep work", wat een lege pane
# niet is.
if [ -z "$SILENT_AGENTS" ] && [ -s "$RUNTIME_DIR/sessions" ]; then
  echo -e "  ${BD}${G}Team is live!${R} ${W}${AGENT_NAMES}${R} are collaborating."
else
  if [ -n "$DELIVERY_FAILED" ]; then
    echo -e "  ${BD}\033[93mDe prompt is niet aangekomen bij:${R}" >&2
  else
    echo -e "  ${BD}\033[93mNiet alle agents hebben binnen ${AGENT_WAIT_SECS}s een bericht gestuurd:${R}" >&2
  fi
  while IFS= read -r agent; do [ -z "$agent" ] || echo "  - $agent" >&2; done <<< "$SILENT_AGENTS"
  # De service schrijft zijn eigen reden in de feed ("did not signal ready in
  # time", "did not take the prompt: pane not ready (...)"). Die regel haalde
  # het scherm niet, en juist die zegt wat er aan de hand is. Gemeten 04-11-2026
  # met een agent waarvan de readyMarker nooit matcht: de launcher adviseerde
  # rescue, terwijl rescue dezelfde marker toetst en dus niet kan helpen.
  if [ -n "$DELIVERY_FAILED" ]; then
    REDENEN=$(curl -sf "$API/api/ensemble/teams/$TEAM_ID" 2>/dev/null | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
namen = [naam for naam in sys.argv[1].split() if naam]
for bericht in data.get('messages', []):
    if bericht.get('from') != 'ensemble':
        continue
    inhoud = ' '.join(str(bericht.get('content', '')).split())
    if any(naam in inhoud for naam in namen) and ('did not' in inhoud or 'failed' in inhoud or 'ready' in inhoud):
        print(inhoud[:300])
" "$(printf '%s' "$SILENT_AGENTS" | tr '\n' ' ')" 2>/dev/null || true)
    if [ -n "$REDENEN" ]; then
      echo -e "  ${D}Wat de service erover zegt:${R}" >&2
      while IFS= read -r regel; do [ -z "$regel" ] || echo "    $regel" >&2; done <<< "$REDENEN"
    fi
    echo "  Kijk op de pane: tmux attach -t ${TEAM_NAME}-<agent>" >&2
  fi
  echo -n "  Opnieuw afleveren: scripts/collab-rescue.sh $TEAM_ID" >&2
  while IFS= read -r agent; do [ -z "$agent" ] || printf ' %q' "$agent" >&2; done <<< "$SILENT_AGENTS"
  echo >&2
  print_team_id_trailer
  exit 3
fi
echo ""
if [ "$MONITOR_MODE" = "split" ]; then
  echo -e "  ${D}┌─ Monitor (right panel) ───────────────┐${R}"
elif [ "$MONITOR_MODE" = "herdr" ]; then
  echo -e "  ${D}┌─ Monitor (herdr pane) ────────────────┐${R}"
elif [ "$MONITOR_MODE" = "orca" ]; then
  echo -e "  ${D}┌─ Monitor (Orca pane) ─────────────────┐${R}"
elif [ "$MONITOR_MODE" = "iterm" ]; then
  echo -e "  ${D}┌─ Monitor (iTerm native pane) ─────────┐${R}"
elif [ "$MONITOR_MODE" = "none" ]; then
  echo -e "  ${D}┌─ Monitor (skipped) ───────────────────┐${R}"
else
  echo -e "  ${D}┌─ Monitor ─────────────────────────────┐${R}"
  echo -e "  ${D}│${R}  ${D}tmux attach -t $MONITOR_SESSION${R}      ${D}│${R}"
fi
echo -e "  ${D}│${R}  ${W}s${R}     ${D}steer team${R}                     ${D}│${R}"
python3 - "$STEER_KEYS" "$STEER_TEXT" <<'PY'
import sys
keys, text = sys.argv[1], sys.argv[2]
# Box interior is 39 columns wide; keep the key column aligned with the rows above.
left = keys.ljust(5)
pad = ' ' * max(1, 39 - len(f"  {left} {text}"))
print(f"  \033[2m│\033[0m  \033[97m{left}\033[0m \033[2m{text}\033[0m{pad}\033[2m│\033[0m")
PY
echo -e "  ${D}│${R}  ${W}j${R}/${W}k${R}   ${D}scroll${R}                         ${D}│${R}"
echo -e "  ${D}│${R}  ${W}d${R}     ${D}disband team${R}                   ${D}│${R}"
echo -e "  ${D}│${R}  ${W}q${R}     ${D}quit monitor${R}                   ${D}│${R}"
echo -e "  ${D}└───────────────────────────────────────┘${R}"
echo ""
# Machine-readable trailer, safe to grep even when multiple collabs run in parallel.
echo "TEAM_ID=$TEAM_ID"
