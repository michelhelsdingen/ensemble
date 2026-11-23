#!/usr/bin/env bash
# Shared runtime paths for collab infrastructure.

collab_runtime_root() {
  local root="${COLLAB_RUNTIME_ROOT:-/tmp/ensemble}"
  root="${root#"${root%%[![:space:]]*}"}"
  root="${root%"${root##*[![:space:]]}"}"
  printf '%s' "${root:-/tmp/ensemble}"
}

collab_runtime_dir() {
  local team_id="${1:?team id required}"
  printf '%s/%s\n' "$(collab_runtime_root)" "$team_id"
}

collab_ensure_runtime_dir() {
  local team_id="${1:?team id required}"
  local dir
  dir="$(collab_runtime_dir "$team_id")"
  mkdir -p -m 700 "$dir"
  chmod 700 "$dir"
  printf '%s\n' "$dir"
}

collab_messages_file() {
  local team_id="${1:?team id required}"
  printf '%s/messages.jsonl\n' "$(collab_runtime_dir "$team_id")"
}

collab_summary_file() {
  local team_id="${1:?team id required}"
  printf '%s/summary.txt\n' "$(collab_runtime_dir "$team_id")"
}

collab_bridge_pid() {
  local team_id="${1:?team id required}"
  printf '%s/bridge.pid\n' "$(collab_runtime_dir "$team_id")"
}

collab_bridge_log() {
  local team_id="${1:?team id required}"
  printf '%s/bridge.log\n' "$(collab_runtime_dir "$team_id")"
}

collab_poller_pid() {
  local team_id="${1:?team id required}"
  printf '%s/poller.pid\n' "$(collab_runtime_dir "$team_id")"
}

collab_feed_file() {
  local team_id="${1:?team id required}"
  printf '%s/feed.txt\n' "$(collab_runtime_dir "$team_id")"
}

collab_prompt_file() {
  local team_id="${1:?team id required}"
  local agent_name="${2:?agent name required}"
  printf '%s/prompts/%s.txt\n' "$(collab_runtime_dir "$team_id")" "$agent_name"
}

collab_delivery_file() {
  local team_id="${1:?team id required}"
  local session_name="${2:?session name required}"
  printf '%s/delivery/%s.txt\n' "$(collab_runtime_dir "$team_id")" "$session_name"
}

collab_bridge_posted_file() {
  local team_id="${1:?team id required}"
  printf '%s/bridge-posted\n' "$(collab_runtime_dir "$team_id")"
}

collab_bridge_result_file() {
  local team_id="${1:?team id required}"
  printf '%s/bridge-result\n' "$(collab_runtime_dir "$team_id")"
}

collab_team_id_file() {
  local team_id="${1:?team id required}"
  printf '%s/team-id\n' "$(collab_runtime_dir "$team_id")"
}

collab_finished_marker() {
  local team_id="${1:?team id required}"
  printf '%s/.finished\n' "$(collab_runtime_dir "$team_id")"
}

# Bewijs dat een team echt leeft: minstens één regel in messages.jsonl.
# Zonder deze functie meldde launch "Team is live!" terwijl hij net zelf had
# vastgesteld dat er nul berichten waren.
team_has_evidence() {
  local rd="$1"
  [ -s "$rd/messages.jsonl" ]
}

# Stop de achtergrondprocessen van een team. Cleanup gooide alleen de map weg,
# waarna de bridge doorliep zonder map: dagenlang, in een lus die nooit
# eindigt (want die lus reageerde tot voor kort ook niet op een gewoon
# SIGTERM). Stuurt eerst TERM, wacht tot 2 seconden, escaleert dan naar KILL
# voor de processen die dat negeren.
#
# Een pid-bestand kan dagen oud zijn en het besturingssysteem hergebruikt
# pids: voor het schieten wordt de commandoregel van het proces gecontroleerd
# op de scriptnaam die bij bridge/poller hoort. Komt die niet overeen, dan is
# de pid vermoedelijk hergebruikt door iets anders; het pid-bestand wordt dan
# opgeruimd zonder dat proces aan te raken.
#
# Zonder (geldig) pid-bestand wordt alsnog gezocht op de commandoregel: de
# oude trap deed "rm -f $PID_FILE" op elk signaal zonder ooit te exit'en, dus
# een kill van vóór de signaal-fix ruimde het pid-bestand op en liet het
# proces gewoon leven. Zulke wezen zijn voor geen enkel pid-bestand-mechanisme
# nog vindbaar. Het team-id staat letterlijk in de aanroep (ensemble-bridge.sh
# <team-id> <url>), dus scriptnaam + team-id als los argument identificeren
# het proces net zo streng als de pid-route hierboven.
stop_team_processes() {
  local rd="$1" team_id naam pid wacht verwacht cmd kandidaat_pid kandidaat_cmd
  team_id="$(basename "$rd")"

  for naam in bridge poller; do
    case "$naam" in
      bridge) verwacht="ensemble-bridge.sh" ;;
      poller) verwacht="collab-poller.sh" ;;
    esac

    pid=""
    if [ -f "$rd/$naam.pid" ]; then
      pid=$(cat "$rd/$naam.pid" 2>/dev/null)
      case "$pid" in ''|*[!0-9]*) rm -f "$rd/$naam.pid"; pid="" ;; esac
    fi

    if [ -n "$pid" ]; then
      cmd=$(ps -p "$pid" -o command= 2>/dev/null)
      case "$cmd" in
        *"$verwacht"*) ;;
        *) rm -f "$rd/$naam.pid"; pid="" ;;
      esac
    fi

    if [ -z "$pid" ]; then
      while read -r kandidaat_pid kandidaat_cmd; do
        [ -n "$kandidaat_pid" ] || continue
        case " $kandidaat_cmd " in
          *"$verwacht"*" $team_id "*) pid="$kandidaat_pid" ;;
        esac
        [ -n "$pid" ] && break
      done < <(ps -eo pid=,command= 2>/dev/null)
    fi

    [ -z "$pid" ] && continue

    kill "$pid" 2>/dev/null || true
    wacht=0
    while [ "$wacht" -lt 20 ] && kill -0 "$pid" 2>/dev/null; do
      sleep 0.1
      wacht=$((wacht + 1))
    done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    rm -f "$rd/$naam.pid"
  done
  "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/collab-webfeed-stop.sh" "$rd"
}

# Beoordeel hoe ver de prompts van een team zijn, uit het team-JSON op stdin.
#
# Echoot één van:
#   confirmed        elke meetellende agent heeft een bericht gestuurd
#   failed <namen>   minstens één AFLEVERING is mislukt (de pane nam niets aan)
#   pending          nog onderweg, een stille agent inbegrepen
#   unknown          geen bruikbaar antwoord, of een service zonder dit veld
#
# Een bericht in de feed telt zwaarder dan de staat: op 03-11-2026 had glm meer
# dan 60s nodig voor zijn eerste bericht, dus de bevestigingslus gaf op terwijl
# de prompt gewoon was aangekomen. Dat is geen mislukte aflevering, en de
# melding mag dat ook niet zeggen.
#
# Tot 03-11-2026 wachtte de launcher 12 seconden en keek dan naar
# messages.jsonl. Dat is te vroeg voor een agent die nog opstart en veel te
# laat als de aflevering al was mislukt. Agents met status replaced, failed of
# done tellen niet mee: die gaan niets meer sturen.
team_delivery_state() {
  python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    print('unknown'); sys.exit(0)
team = data.get('team', data) if isinstance(data, dict) else {}
agents = team.get('agents') if isinstance(team, dict) else None
if not isinstance(agents, list):
    print('unknown'); sys.exit(0)
telt = [a for a in agents if isinstance(a, dict) and a.get('status') not in ('replaced', 'done')]
if not telt or not any(a.get('delivery') for a in telt):
    # Niemand heeft een delivery-veld: of de service is ouder dan dit veld, of
    # geen enkele agent is gespawnd. Dat tweede is wel te zien: een agent die
    # draait heeft status 'active'.
    if telt and all(a.get('status') != 'active' and not a.get('delivery') for a in telt):
        print('failed ' + ' '.join(a.get('name', '?') for a in telt)); sys.exit(0)
    print('unknown'); sys.exit(0)
sprekers = {m.get('from') for m in (data.get('messages') or []) if isinstance(m, dict)}
# Een agent zonder delivery-veld die niet draait, is nooit gespawnd. Die hield de
# staat eeuwig op 'pending', waardoor de launcher 120 seconden wachtte op
# informatie die de service al had (reviewteam 03-11-2026).
mislukt = [a.get('name', '?') for a in telt
           if (a.get('delivery') == 'failed'
               or (not a.get('delivery') and a.get('status') != 'active'))
           and a.get('name') not in sprekers]
if mislukt:
    print('failed ' + ' '.join(mislukt)); sys.exit(0)
if all(a.get('delivery') == 'confirmed' or a.get('name') in sprekers for a in telt):
    print('confirmed'); sys.exit(0)
# Aangekomen is gestart. 'delivered' en 'silent' betekenen beide dat de pane de
# prompt heeft aangenomen; de agent heeft alleen nog niets gezegd. Tot 03-11-2026
# gaf dit 'pending', waardoor de launcher 120 seconden wachtte en daarna meldde
# dat het team niet was gestart, over een team dat gewoon aan het werk was.
aangekomen = ('delivered', 'silent', 'confirmed')
if all(a.get('delivery') in aangekomen or a.get('name') in sprekers for a in telt):
    # 'confirmed' is zelf al bewijs van een bericht, ook als deze respons geen
    # berichtenlijst meestuurt.
    stil = [a.get('name', '?') for a in telt
            if a.get('delivery') != 'confirmed' and a.get('name') not in sprekers]
    print('delivered ' + ' '.join(stil)); sys.exit(0)
print('pending')
" 2>/dev/null || printf 'unknown\n'
}
