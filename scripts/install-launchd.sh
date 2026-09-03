#!/usr/bin/env bash
# install-launchd.sh — Keep the ensemble service running as a macOS launchd agent.
# Usage: install-launchd.sh [--uninstall] [--no-load]
#
# Writes ~/Library/LaunchAgents/<label>.plist that runs `tsx server.ts` from this
# repo, starts it at login and restarts it whenever it exits. After a code change:
#   launchctl kickstart -k gui/$(id -u)/<label>
# collab-preflight.sh does that by itself when the service is older than 24h.
#
# The agent inherits the PATH of the shell that installs it, so the agent CLIs
# (claude, codex, grok) and tmux resolve the same way they do in your terminal.
# Label override: ENSEMBLE_LAUNCHD_LABEL (default dev.ensemble.server).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LABEL="${ENSEMBLE_LAUNCHD_LABEL:-dev.ensemble.server}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_FILE="/tmp/ensemble-server.log"
DOMAIN="gui/$(id -u)"

UNINSTALL=0
LOAD=1
for arg in "$@"; do
  case "$arg" in
    --uninstall) UNINSTALL=1 ;;
    --no-load) LOAD=0 ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

if [ "$UNINSTALL" = 1 ]; then
  if [ "$LOAD" = 1 ]; then
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  fi
  rm -f "$PLIST"
  echo "Removed $PLIST"
  exit 0
fi

if [ "$(uname)" != "Darwin" ]; then
  echo "launchd only exists on macOS; use a systemd unit or your init system instead." >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "node not found on PATH" >&2
  exit 1
fi
TSX_BIN="$REPO_DIR/node_modules/.bin/tsx"
if [ ! -x "$TSX_BIN" ]; then
  echo "$TSX_BIN missing; run npm install in $REPO_DIR first" >&2
  exit 1
fi

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

mkdir -p "$(dirname "$PLIST")"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NODE_BIN")</string>
    <string>$(xml_escape "$TSX_BIN")</string>
    <string>server.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml_escape "$REPO_DIR")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml_escape "$PATH")</string>
    <key>HOME</key><string>$(xml_escape "$HOME")</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$LOG_FILE</string>
  <key>StandardErrorPath</key><string>$LOG_FILE</string>
</dict></plist>
EOF
echo "Wrote $PLIST"

if [ "$LOAD" = 1 ]; then
  # A loose `tsx server.ts` from a terminal would hold the port; hand over to launchd.
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  pkill -f 'tsx server.ts' 2>/dev/null || true
  sleep 1
  launchctl bootstrap "$DOMAIN" "$PLIST"
  for _ in $(seq 1 10); do
    sleep 1
    if curl -sf "http://localhost:${ENSEMBLE_PORT:-23000}/api/v1/health" > /dev/null 2>&1; then
      echo "Service is up under launchd ($LABEL); log: $LOG_FILE"
      exit 0
    fi
  done
  echo "Service did not answer within 10s; check $LOG_FILE" >&2
  exit 1
fi
