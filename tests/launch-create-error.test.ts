/**
 * Weigert de service het team, dan hoort de gebruiker te lezen waarom.
 *
 * Gemeten 04-11-2026: `/collab` met de typefout `grk` gaf exit 22 na 1,8s en
 * geen woord uitleg. De service antwoordde wel netjes met
 * `400 {"error": "Unknown agent(s): \"grk\". Available: codex, claude, ..."}`,
 * maar de launcher haalde dat antwoord op met `curl -sf`, en -f gooit bij een
 * HTTP-fout het antwoord weg en geeft exit 22. Onder `set -e` stapte het script
 * daar meteen uit, met de exitcode van curl als eindoordeel: een code die in
 * geen enkele tabel staat en een leeg scherm.
 *
 * Deze test draait de echte launcher met een nep-curl die zich als curl
 * gedraagt: -f slikt het antwoord, -o/-w geven het door.
 */
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { afterAll, describe, expect, it } from 'vitest'

const root = fs.mkdtempSync(path.resolve('tmp/launch-create-'))
const scripts = path.join(root, 'scripts')
fs.mkdirSync(scripts)
for (const name of ['collab-launch.sh', 'collab-paths.sh']) {
  fs.copyFileSync(path.resolve('scripts', name), path.join(scripts, name))
}
const stub = (name: string, body: string) =>
  fs.writeFileSync(path.join(scripts, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 })
stub('collab-preflight.sh', 'exit 0')
stub('ensemble-bridge.sh', 'exit 0')
stub('collab-poller.sh', 'exit 0')
stub('collab-postcheck.sh', 'exit 0')

const FOUT = 'Unknown agent(s): "grk". Available: codex, claude, grok, agy, gemini, glm, opencode, mimo'

// Nep-curl met de twee eigenschappen die hier tellen: -f slikt het antwoord bij
// een 4xx en geeft 22, en -o/-w schrijven het antwoord weg en melden de code.
fs.writeFileSync(path.join(root, 'curl'), `#!/bin/bash
URL=""; OUT=""; WRITEOUT=""; FAALSTIL=0
PREV=""
for arg in "$@"; do
  case "$PREV" in -o) OUT="$arg" ;; -w) WRITEOUT="$arg" ;; esac
  case "$arg" in
    http*) URL="$arg" ;;
    -sf|-fs|-f) FAALSTIL=1 ;;
  esac
  PREV="$arg"
done
BODY='{}'; CODE=200
case "$URL" in
  */api/v1/health) BODY='{"ok":true}' ;;
  */api/ensemble/teams) BODY='${JSON.stringify({ error: FOUT }).replace(/'/g, "'\\''")}'; CODE=400 ;;
esac
if [ "$CODE" -ge 400 ] && [ "$FAALSTIL" = 1 ]; then exit 22; fi
if [ -n "$OUT" ]; then printf '%s' "$BODY" > "$OUT"; else printf '%s' "$BODY"; fi
[ -n "$WRITEOUT" ] && printf '%s' "$CODE"
exit 0
`, { mode: 0o755 })

afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

function launch() {
  const result = spawnSync('/bin/bash', [path.join(scripts, 'collab-launch.sh'), root, 'Een kleine taak', 'grk'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      TMPDIR: root,
      COLLAB_RUNTIME_ROOT: root,
      COLLAB_TEAM_ID_FILE: path.join(root, 'team-id.txt'),
      COLLAB_MONITOR: 'none',
      COLLAB_SKIP_POSTCHECK: '1',
      ENSEMBLE_URL: 'http://launcher.test',
    },
  })
  return { ...result, out: `${result.stdout}${result.stderr}` }
}

describe('collab-launch en een weigering van de service', () => {
  it('laat de reden van de service zien in plaats van een kale exitcode', () => {
    const run = launch()
    expect(run.out).toContain('Unknown agent(s)')
    expect(run.out).toContain('grk')
    // De bestaande namen staan in het antwoord van de service; die horen mee.
    expect(run.out).toContain('codex')
    // Exit 22 is de exitcode van curl, geen oordeel van de launcher.
    expect(run.status).not.toBe(22)
    expect(run.status).toBe(5)
  }, 30_000)
})
