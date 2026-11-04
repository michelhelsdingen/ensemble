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
// Nep-curl die ook -o en -w kent: de launcher haalt het aanmaak-antwoord sinds
// 04-11-2026 op met `-o <bestand> -w '%{http_code}'` in plaats van met `-sf`,
// omdat -f bij een HTTP-fout het antwoord weggooit en exit 22 geeft.
fs.writeFileSync(path.join(root, 'curl'), `#!/bin/bash
echo "$@" >> "$TEST_ROOT/curl-aanroepen.log"
URL=""; OUT=""; WRITEOUT=""; PREV=""
for arg in "$@"; do
  case "$PREV" in -o) OUT="$arg" ;; -w) WRITEOUT="$arg" ;; esac
  case "$arg" in http*) URL="$arg";; esac
  PREV="$arg"
done
BODY='{}'
case "$URL" in
  */api/v1/health) BODY='{"ok":true}' ;;
  */api/ensemble/teams) BODY='{"team":{"id":"${TEAM}","name":"collab-test","agents":[{"name":"codex-1"},{"name":"glm-2"}]}}' ;;
  */api/ensemble/teams/*) BODY=$(cat "$TEST_DELIVERY") ;;
esac
if [ -n "$OUT" ]; then printf '%s' "$BODY" > "$OUT"; else printf '%s' "$BODY"; fi
[ -n "$WRITEOUT" ] && printf '%s' 201
exit 0
`, { mode: 0o755 })

afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

function team(delivery: Array<[string, string]>, sprekers: string[], ensembleRegels: string[] = []) {
  return JSON.stringify({
    team: {
      id: TEAM, name: 'collab-test',
      agents: delivery.map(([name, state]) => ({ name, status: 'active', delivery: state })),
    },
    messages: [
      ...sprekers.map(from => ({ from, to: 'team', content: 'hoi', type: 'chat' })),
      ...ensembleRegels.map(content => ({ from: 'ensemble', to: 'team', content, type: 'chat' })),
    ],
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

  /**
   * Bij een echte afleverfout hoort de reden van de service erbij.
   *
   * Gemeten 04-11-2026 met een agent waarvan de readyMarker nooit op het scherm
   * komt (wat er gebeurt als een CLI na een update iets anders print): de start
   * duurde 90 seconden, gaf exit 3 met "Prompt niet aangekomen" en adviseerde
   * collab-rescue, en dat herstelpad kan niet werken want rescue toetst dezelfde
   * marker. De service had de echte reden al in de feed geschreven
   * ("did not signal ready in time", "pane not ready"), maar die regel haalde
   * het scherm niet. Hetzelfde patroon als de 400 die de launcher weggooide.
   */
  it('drukt de uitleg van de service af bij een afleverfout', () => {
    const run = launch(team(
      [['codex-1', 'confirmed'], ['glm-2', 'failed']],
      ['codex-1'],
      [
        '⚠ glm-2 did not signal ready in time — injecting prompt anyway (best-effort)',
        '❌ Delivery to glm-2 failed: glm-2 did not take the prompt: pane not ready (not-ready)',
      ],
    ))
    expect(run.status).toBe(3)
    expect(run.out).toContain('pane not ready')
    expect(run.out).toContain('did not signal ready in time')
    // En de pane zelf is waar je moet kijken.
    expect(run.out).toMatch(/tmux attach/)
  }, 30_000)

  it('blijft wachten zolang een agent de prompt nog niet aannam', () => {
    const run = launch(team([['codex-1', 'confirmed'], ['glm-2', 'pending']], ['codex-1']))
    expect(run.status).toBe(3)
    expect(run.seconds).toBeGreaterThan(7)
  }, 30_000)
})

/**
 * Stopt de bridge direct, dan staat er een team dat werkt maar waarvan geen
 * bericht bij de API aankomt. Op 03-11-2026 liet ik de launcher dat team zelf
 * opheffen; een uur later gooide diezelfde opruiming een werkend team weg omdat
 * de poller even niet opkwam. Sinds 04-11-2026 geldt: de launcher meldt het,
 * noemt de twee opdrachten (bridge opnieuw starten, of opheffen) en raakt het
 * team niet aan. Alleen de gebruiker heft een team op.
 */
describe('collab-launch raakt het team niet aan als hij halverwege stopt', () => {
  it('meldt een gestopte bridge, maar laat het team staan', () => {
    const run = launch(team([['codex-1', 'delivered'], ['glm-2', 'delivered']], []), true)
    expect(run.status).toBe(4)
    const aanroepen = fs.existsSync(path.join(root, 'curl-aanroepen.log'))
      ? fs.readFileSync(path.join(root, 'curl-aanroepen.log'), 'utf8')
      : ''
    expect(aanroepen).not.toMatch(new RegExp(`teams/${TEAM}/disband`))
    // De tmux-sessies van het team blijven ook staan.
    expect(run.out).not.toMatch(/opgeheven|opgeruimd/i)
    // En de uitvoer vertelt wat je kunt doen, met de team-id erin.
    expect(run.out).toContain(TEAM)
    expect(run.out).toMatch(/ensemble-bridge\.sh/)
    expect(run.out).toMatch(/disband/)
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
