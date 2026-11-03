/**
 * Het oordeel van de launcher over een verse start, van begin tot eind.
 *
 * Gemeten 03-11-2026, team ee1b35b0: grok-2 praatte binnen 20 seconden, glm-1
 * had zijn prompt aangenomen en was aan het werk. De launcher wachtte 120
 * seconden, meldde "Niet alle agents hebben binnen 120s een bericht gestuurd",
 * gaf exit 3 en adviseerde collab-rescue. Het team werkte gewoon en maakte zijn
 * taak af. Precies dat soort valse storing moet weg: aangekomen is gestart.
 *
 * Deze test draait de echte collab-launch.sh met neppe curl, bridge, poller en
 * preflight, dus hij pint het hele pad: de wachtlus, het oordeel en de exitcode.
 */
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { afterAll, describe, expect, it } from 'vitest'

const root = fs.mkdtempSync(path.resolve('tmp/launch-verdict-'))
const scripts = path.join(root, 'scripts')
fs.mkdirSync(scripts)
for (const name of ['collab-launch.sh', 'collab-paths.sh']) {
  fs.copyFileSync(path.resolve('scripts', name), path.join(scripts, name))
}
const stub = (name: string, body: string) =>
  fs.writeFileSync(path.join(scripts, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 })

stub('collab-preflight.sh', 'exit 0')
// Bridge en poller moeten blijven leven: de launcher controleert hun pid.
stub('ensemble-bridge.sh', 'echo $$ > "$TEST_ROOT/$1/bridge.pid"; exec sleep 20')
stub('collab-poller.sh', 'echo $$ > "$TEST_ROOT/$1/poller.pid"; exec sleep 20')
stub('collab-postcheck.sh', 'exit 0')

const TEAM = '11111111-2222-3333-4444-555555555555'
// Neppe curl: health, team aanmaken en de teamstatus. TEST_DELIVERY bepaalt wat
// team_delivery_state straks uit die status leest.
fs.writeFileSync(path.join(root, 'curl'), `#!/bin/bash
URL=""
for arg in "$@"; do case "$arg" in http*) URL="$arg";; esac; done
case "$URL" in
  */api/v1/health) echo '{"ok":true}'; exit 0 ;;
  */api/ensemble/teams) echo '{"team":{"id":"${TEAM}","name":"collab-test","agents":[{"name":"codex-1"},{"name":"glm-2"}]}}'; exit 0 ;;
  */api/ensemble/teams/*) cat "$TEST_DELIVERY"; exit 0 ;;
esac
echo '{}'
`, { mode: 0o755 })

afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

function team(delivery: Array<[string, string]>, sprekers: string[]) {
  return JSON.stringify({
    team: {
      id: TEAM, name: 'collab-test',
      agents: delivery.map(([name, state]) => ({ name, status: 'active', delivery: state })),
    },
    messages: sprekers.map(from => ({ from, to: 'team', content: 'hoi', type: 'chat' })),
  })
}

function launch(teamJson: string) {
  const deliveryFile = path.join(root, 'delivery.json')
  fs.writeFileSync(deliveryFile, teamJson)
  fs.mkdirSync(path.join(root, TEAM), { recursive: true })
  // Het sessieregister is normaal door de service geschreven.
  fs.writeFileSync(path.join(root, TEAM, 'sessions'), 'collab-test-codex-1\ncollab-test-glm-2\n')
  const begin = Date.now()
  const result = spawnSync('/bin/bash', [path.join(scripts, 'collab-launch.sh'), root, 'Een kleine taak', 'codex,glm'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      TMPDIR: root,
      COLLAB_RUNTIME_ROOT: root,
      COLLAB_TEAM_ID_FILE: path.join(root, 'team-id.txt'),
      COLLAB_MONITOR: 'none',
      COLLAB_SKIP_POSTCHECK: '1',
      COLLAB_AGENT_WAIT_SECS: '8',
      ENSEMBLE_URL: 'http://launcher.test',
      TEST_ROOT: root,
      TEST_DELIVERY: deliveryFile,
    },
  })
  return { ...result, seconds: (Date.now() - begin) / 1000, out: `${result.stdout}${result.stderr}` }
}

describe('collab-launch oordeelt over een verse start', () => {
  it('noemt een team live zodra de prompt bij iedereen aankwam', () => {
    const run = launch(team([['codex-1', 'confirmed'], ['glm-2', 'silent']], ['codex-1']))
    expect(run.out).toContain('Prompt aangekomen bij alle agents')
    expect(run.out).toContain('nog geen bericht van: glm-2')
    expect(run.out).toContain('Team is live!')
    expect(run.out).not.toContain('collab-rescue.sh')
    expect(run.status).toBe(0)
  }, 30_000)

  it('wacht daar niet de volle tijd op, maar breekt zodra het bewijs er is', () => {
    const run = launch(team([['codex-1', 'delivered'], ['glm-2', 'delivered']], []))
    expect(run.status).toBe(0)
    expect(run.seconds).toBeLessThan(6)
  }, 30_000)

  it('meldt wel een echte afleverfout, met het herstelpad erbij', () => {
    const run = launch(team([['codex-1', 'confirmed'], ['glm-2', 'failed']], ['codex-1']))
    expect(run.out).toContain('Prompt niet aangekomen bij: glm-2')
    expect(run.out).toContain('collab-rescue.sh')
    expect(run.status).toBe(3)
  }, 30_000)

  it('blijft wachten zolang een agent de prompt nog niet aannam', () => {
    const run = launch(team([['codex-1', 'confirmed'], ['glm-2', 'pending']], ['codex-1']))
    expect(run.status).toBe(3)
    expect(run.seconds).toBeGreaterThan(7)
  }, 30_000)
})
