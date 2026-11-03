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
echo "$@" >> "$TEST_ROOT/curl-aanroepen.log"
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

function launch(teamJson: string, bridgeStuk = false, orphanSession = '', pollerStuk = false) {
  fs.rmSync(path.join(root, 'curl-aanroepen.log'), { force: true })
  // Geen oude pid-bestanden laten staan: de launcher kijkt of ze er zijn en of
  // dat proces nog leeft, en een pid uit een vorige test maakt de uitslag van
  // deze test onzin.
  fs.rmSync(path.join(root, TEAM, 'bridge.pid'), { force: true })
  fs.rmSync(path.join(root, TEAM, 'poller.pid'), { force: true })
  stub('ensemble-bridge.sh', bridgeStuk
    ? 'exit 1'
    : 'echo $$ > "$TEST_ROOT/$1/bridge.pid"; exec sleep 20')
  stub('collab-poller.sh', pollerStuk
    ? 'exit 0'
    : 'echo $$ > "$TEST_ROOT/$1/poller.pid"; exec sleep 20')
  const deliveryFile = path.join(root, 'delivery.json')
  fs.writeFileSync(deliveryFile, teamJson)
  fs.mkdirSync(path.join(root, TEAM), { recursive: true })
  // Het sessieregister is normaal door de service geschreven.
  fs.mkdirSync(path.join(root, TEAM, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(root, TEAM, 'prompts', 'codex-1.txt'), 'prompt')
  fs.writeFileSync(path.join(root, TEAM, 'prompts', 'glm-2.txt'), 'prompt')
  fs.writeFileSync(path.join(root, TEAM, 'sessions'), `collab-test-codex-1\ncollab-test-glm-2\n${orphanSession}\n`)
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
    const run = launch(team([['codex-1', 'confirmed'], ['glm-2', 'silent']], ['codex-1']), false, 'collab-test-orphan')
    expect(run.out).toContain('Prompt aangekomen bij alle agents')
    expect(run.out).toContain('nog geen bericht van: glm-2')
    expect(run.out).toContain('Team is live!')
    expect(run.out).toContain('sessie zonder promptbestand: collab-test-orphan')
    expect(run.out).not.toContain('collab-rescue.sh ' + TEAM + ' collab-test-orphan')
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

/**
 * Exit 4 (de bridge of de poller stopt direct) liet het al aangemaakte team
 * volledig achter: actief in het register, met draaiende tmux-sessies. Gevonden
 * door het reviewteam van 03-11-2026 (team 40d536c0).
 */
describe('collab-launch ruimt op als hij halverwege stopt', () => {
  it('heft het team op als de bridge meteen stopt', () => {
    const run = launch(team([['codex-1', 'delivered'], ['glm-2', 'delivered']], []), true)
    expect(run.status).toBe(4)
    const aanroepen = fs.existsSync(path.join(root, 'curl-aanroepen.log'))
      ? fs.readFileSync(path.join(root, 'curl-aanroepen.log'), 'utf8')
      : ''
    expect(aanroepen).toMatch(new RegExp(`teams/${TEAM}/disband`))
    expect(run.out).toMatch(/opgeheven|opgeruimd/i)
  }, 30_000)
})

/**
 * Een poller die niet opkomt is geen reden om een werkend team weg te gooien.
 *
 * Gemeten 03-11-2026 in de rookproef: 1 van de 10 runs gaf "Poller stopte
 * direct" en daarmee exit 4, terwijl de agents gewoon draaiden en het team
 * daarna netjes werd opgeheven. De poller kopieert alleen berichten naar het
 * feedbestand voor de monitor; het team werkt zonder hem. De bridge is een
 * ander verhaal: zonder die komt er geen enkel bericht bij de API, dus die
 * blijft een harde fout.
 */
describe('collab-launch weegt bridge en poller verschillend', () => {
  it('gaat door als de poller niet opkomt, met een waarschuwing', () => {
    const run = launch(
      team([['codex-1', 'confirmed'], ['glm-2', 'confirmed']], ['codex-1', 'glm-2']),
      false, '', true,
    )
    expect(run.out).toMatch(/poller/i)
    expect(run.out).toContain('Team is live!')
    expect(run.status).toBe(0)
    const aanroepen = fs.existsSync(path.join(root, 'curl-aanroepen.log'))
      ? fs.readFileSync(path.join(root, 'curl-aanroepen.log'), 'utf8')
      : ''
    expect(aanroepen).not.toMatch(new RegExp(`teams/${TEAM}/disband`))
  }, 30_000)
})
