#!/usr/bin/env bash
# agent-startproef.sh — Meet de start van EEN agent, en laat bij twijfel het
# scherm zien.
#
# Usage: agent-startproef.sh <agent-key> [wacht-seconden]
#
# De rookproef (collab-smoke.sh) bewijst de keten; dit script diagnosticeert een
# agent die daar niet door komt. Verschil: het meldt per agent de afleverstaat
# van de service en print bij elke afwijking de laatste 40 regels van de pane,
# want dat is het enige bewijs waarom een CLI de prompt niet aannam.
#
# Draai dit tegen een EIGEN service, niet de live service:
#   ENSEMBLE_PORT=23010 ENSEMBLE_DATA_DIR=... COLLAB_RUNTIME_ROOT=... tsx server.ts
#   ENSEMBLE_URL=http://localhost:23010 scripts/agent-startproef.sh agy
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/collab-paths.sh"

AGENT="${1:?Usage: agent-startproef.sh <agent-key> [wacht-seconden]}"
WACHT="${2:-120}"
API="${ENSEMBLE_URL:-http://localhost:23000}"
TAAK="Zeg in een enkele korte regel hallo en noem je eigen naam. Stuur daarna <<COLLAB_DONE>>."

nu_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }
R=$'\033[0m'; GRN=$'\033[92m'; RED=$'\033[91m'; YEL=$'\033[93m'; D=$'\033[2m'

WERKMAP=$(mktemp -d "${TMPDIR:-/tmp}/startproef-$AGENT-XXXXXX")
UITVOER=$(mktemp "${TMPDIR:-/tmp}/startproef-out-XXXXXX")

printf "\n%s== %s ==%s %sservice %s%s\n" "$YEL" "$AGENT" "$R" "$D" "$API" "$R"
BEGIN=$(nu_ms)
COLLAB_MONITOR=none COLLAB_SKIP_POSTCHECK=1 \
  "$SCRIPT_DIR/collab-launch.sh" "$WERKMAP" "$TAAK" "$AGENT" > "$UITVOER" 2>&1
EXIT=$?
LIVE_MS=$(( $(nu_ms) - BEGIN ))
TEAM_ID=$(grep -o 'TEAM_ID=[0-9a-f-]*' "$UITVOER" | tail -1 | cut -d= -f2)

printf "  launcher exit %s na %ss\n" "$EXIT" "$(python3 -c "print(f'{$LIVE_MS/1000:.1f}')")"
if [ -z "$TEAM_ID" ]; then
  printf "  %sgeen team-id; uitvoer van de launcher:%s\n" "$RED" "$R"
  sed 's/^/    /' "$UITVOER"
  rm -rf "$WERKMAP" "$UITVOER"
  exit 1
fi
printf "  team %s\n" "$TEAM_ID"

toon_staat() {
  curl -sf "$API/api/ensemble/teams/$TEAM_ID" 2>/dev/null | python3 -c "
import json, sys
d = json.load(sys.stdin); t = d.get('team', {})
for a in t.get('agents', []):
    print(f\"    {a['name']}: status={a.get('status')} aflevering={a.get('delivery','?')}\")
msgs = [m for m in d.get('messages', []) if m.get('from') != 'ensemble']
print(f\"    berichten van agents: {len(msgs)}\")
for m in msgs[:3]:
    print(f\"      {m['from']}: {m.get('content','')[:90].replace(chr(10),' ')}\")
" 2>/dev/null || echo "    (teamstatus onleesbaar)"
}

# Wachten tot de agent zelf iets zegt, of tot de grens.
SPREEK_MS=""
for _ in $(seq 1 "$WACHT"); do
  GESPROKEN=$(curl -sf "$API/api/ensemble/teams/$TEAM_ID" 2>/dev/null | python3 -c "
import json, sys
d = json.load(sys.stdin); t = d.get('team', {})
namen = {a['name'] for a in t.get('agents', []) if a.get('status') != 'replaced'}
print('JA' if {m['from'] for m in d.get('messages', [])} & namen else 'NEE')
" 2>/dev/null || echo "NEE")
  if [ "$GESPROKEN" = "JA" ]; then SPREEK_MS=$(( $(nu_ms) - BEGIN )); break; fi
  sleep 1
done

if [ -n "$SPREEK_MS" ]; then
  printf "  %s✓%s eigen bericht na %ss\n" "$GRN" "$R" "$(python3 -c "print(f'{$SPREEK_MS/1000:.1f}')")"
else
  printf "  %s✗%s geen eigen bericht binnen %ss\n" "$RED" "$R" "$WACHT"
fi
toon_staat

# Het scherm is het bewijs. Altijd printen bij stilte, en bij een exit != 0.
if [ -z "$SPREEK_MS" ] || [ "$EXIT" != "0" ]; then
  RD="$(collab_runtime_dir "$TEAM_ID")"
  printf "  %slaunchermeldingen:%s\n" "$D" "$R"
  sed 's/^/    /' "$UITVOER" | grep -vE '^\s*$' | tail -12
  if [ -f "$RD/sessions" ]; then
    while IFS= read -r S; do
      [ -n "$S" ] || continue
      printf "  %spane %s:%s\n" "$YEL" "$S" "$R"
      tmux capture-pane -p -t "$S" 2>/dev/null | grep -vE '^\s*$' | tail -40 | sed 's/^/    | /'
    done < "$RD/sessions"
  else
    printf "  %sgeen sessieregister: geen enkele agent is gespawnd%s\n" "$RED" "$R"
  fi
fi

if [ "${STARTPROEF_KEEP:-0}" != "1" ]; then
  curl -sf -X POST "$API/api/ensemble/teams/$TEAM_ID/disband" >/dev/null 2>&1 \
    && printf "  %s✓%s team opgeheven\n" "$GRN" "$R" \
    || printf "  %s!%s disband mislukte\n" "$YEL" "$R"
  rm -rf "$WERKMAP" "$UITVOER"
else
  printf "  %steam blijft staan; uitvoer %s, werkmap %s%s\n" "$D" "$UITVOER" "$WERKMAP" "$R"
fi

[ -n "$SPREEK_MS" ] && [ "$EXIT" = "0" ]
