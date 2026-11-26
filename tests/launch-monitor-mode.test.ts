/**
 * Wat de launcher over de monitor en het plan in zijn uitvoer zet.
 *
 * Doorlichting 23-11-2026: een team dat vanuit een Orca-botchat in een andere
 * repo werkte kreeg de losse tmux-sessie, omdat de modus op de werkmap van het
 * team werd bepaald in plaats van op de map waarvandaan gestart is. De skill
 * moest daarom zelf vooraf een modus- en plancheck draaien. Nu staan `Plan:`,
 * `MONITOR_MODE=` en `TEAM_ID=` altijd in de uitvoer, en elke manier om de
 * monitor te openen krijgt hetzelfde commando met dezelfde ENSEMBLE_*-omgeving.
 *
 * Draait de echte collab-launch.sh met neppe curl, tmux, orca, bridge, poller en
 * openers. Er wordt dus geen team gestart en geen paneel geopend.
 */
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

const root = fs.mkdtempSync(path.resolve('tmp/launch-monitor-'))
const scripts = path.join(root, 'scripts')
const bin = path.join(root, 'bin')
fs.mkdirSync(scripts)
fs.mkdirSync(bin)
for (const name of ['collab-launch.sh', 'collab-paths.sh', 'collab-monitor-mode.sh']) {
  fs.copyFileSync(path.resolve('scripts', name), path.join(scripts, name))
}
const stub = (name: string, body: string) =>
  fs.writeFileSync(path.join(scripts, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 })
const tool = (name: string, body: string) =>
  fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 })

const TEAM = '22222222-3333-4444-5555-666666666666'
const TMUX_LOG = path.join(root, 'tmux.log')
stub('collab-preflight.sh', 'printf "%s" "${COLLAB_OVERRIDE_FILE:-}" > "$TEST_ROOT/seen-override"; exit 0')
stub('ensemble-bridge.sh', 'echo $$ > "$TEST_ROOT/$1/bridge.pid"; exec sleep 20')
stub('collab-poller.sh', 'echo $$ > "$TEST_ROOT/$1/poller.pid"; exec sleep 20')
stub('collab-postcheck.sh', 'exit 0')
stub('open-orca-webfeed.sh', 'echo new_pane_id=page-1')
tool('tmux', 'printf "%s\\n" "$*" >> "$TEST_ROOT/tmux.log"; exit 0')
tool('orca', 'exit 0')
tool('curl', `
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
  */api/ensemble/teams/*) BODY='{"team":{"id":"${TEAM}","agents":[{"name":"codex-1","status":"active","delivery":"confirmed"},{"name":"glm-2","status":"active","delivery":"confirmed"}]},"messages":[]}' ;;
esac
if [ -n "$OUT" ]; then printf '%s' "$BODY" > "$OUT"; else printf '%s' "$BODY"; fi
[ -n "$WRITEOUT" ] && printf '%s' 201
exit 0
`)

afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
beforeEach(() => fs.rmSync(TMUX_LOG, { force: true }))

const botDir = path.join(root, '.orca/bots/chat')
const otherRepo = path.join(root, 'other-repo')
fs.mkdirSync(botDir, { recursive: true })
fs.mkdirSync(otherRepo)

function launch(options: { from?: string; env?: Record<string, string>; args?: string[]; bridgeStuk?: boolean } = {}) {
  fs.mkdirSync(path.join(root, TEAM, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(root, TEAM, 'sessions'), 'collab-test-codex-1\ncollab-test-glm-2\n')
  fs.rmSync(path.join(root, TEAM, 'bridge.pid'), { force: true })
  fs.rmSync(path.join(root, TEAM, 'poller.pid'), { force: true })
  if (options.bridgeStuk) stub('ensemble-bridge.sh', 'exit 1')
  else stub('ensemble-bridge.sh', 'echo $$ > "$TEST_ROOT/$1/bridge.pid"; exec sleep 20')
  const result = spawnSync('/bin/bash', [path.join(scripts, 'collab-launch.sh'), otherRepo, 'Een kleine taak', ...(options.args ?? ['codex,glm'])], {
    encoding: 'utf8',
    cwd: options.from ?? root,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: root, TMPDIR: root,
      COLLAB_RUNTIME_ROOT: root,
      COLLAB_TEAM_ID_FILE: path.join(root, 'team-id.txt'),
      COLLAB_MONITOR: 'auto', HERDR_ENV: '', ORCA_AGENT_PANE: '', TMUX: '', TERM_PROGRAM: '',
      ORCA_STRUCTURED_SESSION: '',
      COLLAB_SKIP_POSTCHECK: '1', COLLAB_AGENT_WAIT_SECS: '8',
      ENSEMBLE_URL: 'http://launcher.test',
      TEST_ROOT: root,
      ...options.env,
    },
  })
  return { ...result, out: `${result.stdout}${result.stderr}`, lines: result.stdout.split('\n') }
}

describe('MONITOR_MODE en de startmap', () => {
  it('kiest de browserfeed als een botchat in een andere repo werkt', () => {
    const run = launch({ from: botDir })
    expect(run.status, run.out).toBe(0)
    expect(run.out).toContain('MONITOR_MODE=orca-webfeed')
    expect(fs.existsSync(TMUX_LOG), 'er mag geen tmux-sessie zijn geopend').toBe(false)
  }, 30_000)

  it('kiest de browserfeed in een gewone Orca-chat buiten de botmap', () => {
    const run = launch({ from: otherRepo, env: { ORCA_STRUCTURED_SESSION: '1' } })
    expect(run.status, run.out).toBe(0)
    expect(run.out).toContain('MONITOR_MODE=orca-webfeed')
    expect(fs.existsSync(TMUX_LOG), 'er mag geen tmux-sessie zijn geopend').toBe(false)
  }, 30_000)

  it('zet MONITOR_MODE vlak voor TEAM_ID, ook zonder monitor', () => {
    const run = launch({ env: { COLLAB_MONITOR: 'none' } })
    const tail = run.lines.filter(Boolean).slice(-2)
    expect(tail).toEqual(['MONITOR_MODE=none', `TEAM_ID=${TEAM}`])
  }, 30_000)

  it('drukt ook op het foutpad van een dode bridge MONITOR_MODE vlak voor TEAM_ID', () => {
    const run = launch({ bridgeStuk: true })
    expect(run.status).toBe(4)
    const tail = run.lines.filter(Boolean).slice(-2)
    expect(tail).toEqual(['MONITOR_MODE=none', `TEAM_ID=${TEAM}`])
  }, 30_000)

  it('meldt de modus die werkelijk is gebruikt: split binnen tmux', () => {
    const run = launch({ env: { TMUX: '/tmp/tmux-test' } })
    expect(run.out).toContain('MONITOR_MODE=split')
  }, 30_000)
})

describe('één monitorcommando', () => {
  it('geeft de tmux-split de ENSEMBLE_*-omgeving van de aanroeper', () => {
    const run = launch({ env: { TMUX: '/tmp/tmux-test', ENSEMBLE_PORT: '23999' } })
    expect(run.status, run.out).toBe(0)
    const split = fs.readFileSync(TMUX_LOG, 'utf8').split('\n').find(l => l.startsWith('split-window'))
    expect(split).toContain('ENSEMBLE_URL=http://launcher.test')
    expect(split).toContain('ENSEMBLE_PORT=23999')
    expect(split).toContain(`./node_modules/.bin/tsx cli/monitor.ts ${TEAM}`)
  }, 30_000)

  it.each([
    ['herdr', 'open-herdr-monitor.sh'],
    ['orca', 'open-orca-monitor.sh'],
    ['orca-webfeed', 'open-orca-webfeed.sh'],
    ['iterm', 'open-iterm-monitor.sh'],
  ])('geeft de terugvalsessie na een mislukte %s-opener dezelfde omgeving en runner', (monitor, opener) => {
    stub(opener, 'echo "kapot" >&2; exit 5')
    const run = launch({ env: { COLLAB_MONITOR: monitor, ENSEMBLE_PORT: '23999' } })
    stub('open-orca-webfeed.sh', 'echo new_pane_id=page-1')
    expect(run.status, run.out).toBe(0)
    expect(run.out).toContain('MONITOR_MODE=session')
    const sessie = fs.readFileSync(TMUX_LOG, 'utf8').split('\n').find(l => l.startsWith('new-session'))
    expect(sessie).toContain('ENSEMBLE_URL=http://launcher.test')
    expect(sessie).toContain('ENSEMBLE_PORT=23999')
    expect(sessie).toContain(`./node_modules/.bin/tsx cli/monitor.ts ${TEAM}`)
    expect(sessie).not.toContain('node --import tsx')
  }, 30_000)
})

describe('Plan-regel', () => {
  it('staat er bij een met de hand opgegeven ploeg', () => {
    const run = launch({ env: { COLLAB_MONITOR: 'none' }, args: ['codex,glm'] })
    expect(run.out).toContain('Plan: agents=codex,glm, template=none')
  }, 30_000)

  it('staat er ook zonder ploeg, met de standaardploeg', () => {
    const run = launch({ env: { COLLAB_MONITOR: 'none' }, args: [] })
    expect(run.out).toContain('Plan: agents=codex,claude code, template=none')
  }, 30_000)
})

describe('override per launch', () => {
  it('geeft preflight een eigen overridebestand, niet het gedeelde pad, en ruimt het op', () => {
    fs.rmSync(path.join(root, 'seen-override'), { force: true })
    launch({ env: { COLLAB_MONITOR: 'none' } })
    const seen = fs.readFileSync(path.join(root, 'seen-override'), 'utf8')
    expect(seen).not.toBe('')
    expect(seen).not.toBe(path.join(root, 'collab-agents-override.txt'))
    expect(seen).toMatch(/collab-override\.[A-Za-z0-9]+\/agents\.txt$/)
    expect(fs.existsSync(seen)).toBe(false)
    expect(fs.existsSync(path.dirname(seen))).toBe(false)
  }, 30_000)

  it('laat een door de aanroeper opgegeven overridebestand van de aanroeper', () => {
    const eigen = path.join(root, 'eigen-override.txt')
    launch({ env: { COLLAB_MONITOR: 'none', COLLAB_OVERRIDE_FILE: eigen } })
    expect(fs.readFileSync(path.join(root, 'seen-override'), 'utf8')).toBe(eigen)
  }, 30_000)
})
