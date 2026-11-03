#!/usr/bin/env bash
# collab-rescue.sh: retry unresponsive team agents and verify their response.
#
# Symptoom: team draait, agents zichtbaar in tmux/iTerm, maar messages.jsonl is leeg
# en /tmp/ensemble-server.log toont "did not become ready within 60s".
#
# Oorzaak: ensemble-service wacht op een readiness-pattern voor injectie. Codex CLI's
# patroon matcht soms niet, dus prompts blijven in prompts/<agent>.txt liggen zonder
# ooit naar de agent te gaan.
#
# A successful tmux command alone does not prove that the agent started a turn.
#
# Gebruik:
#   collab-rescue.sh <TEAM_ID> [agent-name ...]
#   collab-rescue.sh         # gebruikt /tmp/collab-team-id.txt
#
# With no agent names, retry only agents without a message.

set -euo pipefail

TEAM_ID="${1:-$(cat /tmp/collab-team-id.txt 2>/dev/null || true)}"
if [ "$#" -gt 0 ]; then shift; fi
REQUESTED_AGENTS=("$@")

if [ -z "$TEAM_ID" ]; then
  echo "FOUT: geen team-id opgegeven en /tmp/collab-team-id.txt niet gevonden" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=collab-paths.sh
. "$SCRIPT_DIR/collab-paths.sh"
RD="$(collab_runtime_dir "$TEAM_ID")"

if [ ! -d "$RD" ]; then
  echo "FOUT: team-dir bestaat niet: $RD" >&2
  exit 1
fi

if [ ! -d "$RD/prompts" ]; then
  echo "FOUT: prompts/ ontbreekt in team-dir; niets te redden" >&2
  exit 1
fi

# De sessies van dit team staan in het register dat de service wegschrijft
# (services/ensemble-service.ts, vlak voor Phase 2). Hiervoor pakte rescue de
# eerste tmux-sessie met een codex-1 erin, zonder enige vergelijking met het
# gevraagde team-id: de prompts van dit team belandden dan in de panes van een
# willekeurig ander team. En een team zonder codex werd nooit gevonden, terwijl
# dat nou juist het geval is waarvoor rescue bedoeld is.
if [ ! -f "$RD/sessions" ]; then
  echo "FOUT: geen sessieregister voor $TEAM_ID; dit team is niet door deze launcher gestart" >&2
  exit 1
fi

if [ ! -s "$RD/sessions" ]; then
  echo "FOUT: sessieregister voor $TEAM_ID is leeg" >&2
  exit 1
fi

echo "team-id: $TEAM_ID"
echo "sessies: $(tr '\n' ' ' < "$RD/sessions")"
echo

agent_messages() {
  python3 - "$RD/messages.jsonl" "$1" <<'PY'
import json, sys
count = 0
try:
    with open(sys.argv[1]) as messages:
        for line in messages:
            try:
                if json.loads(line).get('from') == sys.argv[2]:
                    count += 1
            except (ValueError, TypeError):
                pass
except FileNotFoundError:
    pass
print(count)
PY
}

agent_requested() {
  [ "${#REQUESTED_AGENTS[@]}" -eq 0 ] && return 0
  local requested
  for requested in ${REQUESTED_AGENTS[@]+"${REQUESTED_AGENTS[@]}"}; do
    [ "$requested" = "$1" ] && return 0
  done
  return 1
}

deliver_to_session() {
  local SESSION="$1"
  local PROMPT_FILE="$2"
  local AGENT_NAME="$3"

  if [ ! -f "$PROMPT_FILE" ]; then
    echo "  $AGENT_NAME: prompt bestand ontbreekt: $PROMPT_FILE" >&2
    return 1
  fi

  if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "  $AGENT_NAME: tmux sessie '$SESSION' bestaat niet" >&2
    return 1
  fi

  # Kijken voor we plakken. Tot 03-11-2026 plakte rescue blind: codex stond
  # modaal in zijn hooks-dialoog en drie pogingen op rij verdwenen daarin,
  # zonder dat iemand kon zien waarom. Dezelfde toets als de service gebruikt.
  if [ -x "$REPO_DIR/node_modules/.bin/tsx" ]; then
    PANE_DIALOOG=$("$REPO_DIR/node_modules/.bin/tsx" "$SCRIPT_DIR/pane-ready.ts" "$SESSION" "$AGENT_NAME" 2>/dev/null)
    PANE_STAAT=$?
    case "$PANE_STAAT" in
      10)
        echo "  $AGENT_NAME: wacht op een dialoog die alleen jij mag beantwoorden: \"${PANE_DIALOOG}\"" >&2
        echo "    Opnieuw afleveren helpt hier niet. Start die CLI eenmalig in een gewone terminal en beantwoord de vraag." >&2
        return 1
        ;;
      11)
        echo "  $AGENT_NAME: pane is nog niet gereed voor invoer; even wachten en opnieuw proberen" >&2
        return 1
        ;;
    esac
  fi

  # Het beeld van voor de paste, om straks te zien of de pane hem aannam.
  local VOOR
  VOOR="$(tmux capture-pane -t "$SESSION" -p 2>/dev/null | tail -20 || true)"

  local BUFNAME="rescue-${AGENT_NAME}-$$"
  tmux load-buffer -b "$BUFNAME" "$PROMPT_FILE"
  tmux paste-buffer -b "$BUFNAME" -t "$SESSION"
  tmux delete-buffer -b "$BUFNAME" 2>/dev/null || true

  # Wachten tot de pane de paste toont, in plaats van een vaste 5 (codex) of 1
  # seconde. Daarna de Enter; die komt in de pty-stroom achter de tekst aan.
  local NU=""
  local WACHT
  for WACHT in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    NU="$(tmux capture-pane -t "$SESSION" -p 2>/dev/null | tail -20 || true)"
    [ "$NU" != "$VOOR" ] && break
    sleep 0.25
  done
  tmux send-keys -t "$SESSION" Enter

  # Een CLI die een grote paste eerst samenvat ("[Pasted text ...]") wil nog een
  # Enter. Kijken in plaats van vaste stappen van 1, 2 en 3 seconden, en dit
  # geldt voor elke CLI die zo'n melding toont, niet alleen voor een agent met
  # "claude" in zijn naam (rescue keek naar de naam, de service naar het
  # programma: een glm-agent liep deze stap daardoor altijd mis).
  local RONDE
  for RONDE in 1 2 3; do
    NU="$(tmux capture-pane -t "$SESSION" -p 2>/dev/null | tail -20 || true)"
    case "$NU" in
      *"[Pasted text"*|*"paste again to expand"*) tmux send-keys -t "$SESSION" Enter; sleep 0.5 ;;
      *) break ;;
    esac
  done

  # Nam de pane iets aan? Zo niet, dan helpt opnieuw plakken ook niet.
  NU="$(tmux capture-pane -t "$SESSION" -p 2>/dev/null | tail -20 || true)"
  if [ "$NU" = "$VOOR" ]; then
    echo "  $AGENT_NAME: de pane heeft niets aangenomen (beeld onveranderd)" >&2
    return 1
  fi
  echo "  $AGENT_NAME: prompt aangenomen door de pane, wacht op agentbericht"
}

echo "=== prompt-injectie ==="
FAILED=0
MATCHED=()
# Sessie naar promptbestand: de sessie heet altijd "<teamnaam>-<agentnaam>", en
# <agentnaam> is precies de bestandsnaam in prompts/ (zonder .txt). Een
# teamnaam kan zelf koppeltekens of cijfers bevatten, dus een generieke regex
# op de sessienaam terugrekenen naar de agentnaam is niet betrouwbaar. De
# bekende agentnamen uit prompts/ vergelijken met het staartje van de
# sessienaam is dat wel: die naam is nooit dubbelzinnig binnen één team, en dit
# levert ook meteen de echte agentnaam op in plaats van alleen het stukje na
# de laatste streep (dat zou de claude-detectie in deliver_to_session hieronder
# stilletjes hebben uitgeschakeld).
while IFS= read -r SESSION; do
  [ -n "$SESSION" ] || continue
  AGENT_NAME=""
  PROMPT_FILE=""
  for candidate in "$RD/prompts/"*.txt; do
    [ -f "$candidate" ] || continue
    NAME="$(basename "$candidate" .txt)"
    case "$SESSION" in
      *"-${NAME}")
        AGENT_NAME="$NAME"
        PROMPT_FILE="$candidate"
        break
        ;;
    esac
  done
  if [ -z "$AGENT_NAME" ]; then
    echo "  $SESSION: geen promptbestand voor deze sessie gevonden, overgeslagen"
    continue
  fi
  if ! agent_requested "$AGENT_NAME"; then continue; fi
  MATCHED+=("$AGENT_NAME")
  BEFORE=$(agent_messages "$AGENT_NAME")
  if [ "$BEFORE" -gt 0 ]; then
    echo "  $AGENT_NAME: heeft al $BEFORE bericht(en), geen rescue nodig"
    continue
  fi
  # Aangenomen is afgeleverd. Hiervoor stond hier de lus die vandaag ook in de
  # service is weggehaald: drie keer de hele prompt opnieuw plakken omdat de
  # agent binnen 15 seconden nog niets had gezegd. Gemeten 03-11-2026 kostte dat
  # glm 2m40s voor zijn eerste bericht, met drie kopieën van dezelfde opdracht.
  # Een agent die nadenkt is geen mislukte aflevering.
  if ! deliver_to_session "$SESSION" "$PROMPT_FILE" "$AGENT_NAME"; then
    echo "  $AGENT_NAME: prompt NIET afgeleverd; inspecteer tmux attach -t $SESSION" >&2
    FAILED=1
    continue
  fi
  CONFIRMED=0
  for _ in $(seq 1 20); do
    AFTER=$(agent_messages "$AGENT_NAME")
    if [ "$AFTER" -gt "$BEFORE" ]; then
      CONFIRMED=1
      break
    fi
    sleep 1
  done
  if [ "$CONFIRMED" -eq 1 ]; then
    echo "  $AGENT_NAME: bevestigd door eigen bericht"
  else
    echo "  $AGENT_NAME: prompt is aangekomen, nog geen bericht. Die denkt waarschijnlijk nog; kijk mee met tmux attach -t $SESSION"
  fi
done < "$RD/sessions"

# ${A[@]+"${A[@]}"}: een lege array onder `set -u` is op bash 3.2 (de /bin/bash
# van deze machine) een fatale "unbound variable". Deze lus crashte dus in de
# gedocumenteerde standaardvorm van rescue, zonder agentnamen, en dat is precies
# de vorm die de launcher en de postcheck aanraden. Gevonden en gereproduceerd
# 03-11-2026; collab-cleanup.sh gebruikte deze veilige vorm al.
for requested in ${REQUESTED_AGENTS[@]+"${REQUESTED_AGENTS[@]}"}; do
  FOUND=0
  for matched in ${MATCHED[@]+"${MATCHED[@]}"}; do
    if [ "$requested" = "$matched" ]; then FOUND=1; break; fi
  done
  if [ "$FOUND" -eq 0 ]; then
    echo "  $requested: niet gevonden in sessieregister" >&2
    FAILED=1
  fi
done

exit "$FAILED"
