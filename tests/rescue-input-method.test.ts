import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const RESCUE = path.resolve('scripts/collab-rescue.sh')
let root: string

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'rescue-input-')) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

function run(method: 'sendKeys' | 'pasteFromFile'): string {
  const team = `team-${method}`
  const runtime = path.join(root, 'runtime', team)
  const bin = path.join(root, 'bin')
  const log = path.join(root, 'tmux.log')
  const config = path.join(root, 'agents.json')
  fs.mkdirSync(path.join(runtime, 'prompts'), { recursive: true })
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(runtime, 'sessions'), `${team}-test-1\n`)
  fs.writeFileSync(path.join(runtime, 'prompts', 'test-1.txt'), 'regel met $ en ;')
  fs.writeFileSync(config, JSON.stringify({ test: {
    name: 'test', command: 'test', flags: [], readyMarker: '❯',
    inputMethod: method, color: 'white', icon: '*',
  } }))
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_TMUX_LOG"
case "$1" in
  capture-pane)
    if grep -Eq 'paste-buffer|send-keys .* -l ' "$TEST_TMUX_LOG"; then
      printf '❯ prompt ontvangen\\n'
    else
      printf '❯ leeg invoerveld\\n'
    fi
    ;;
  has-session) exit 0 ;;
esac
exit 0
`, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

  execFileSync(RESCUE, [team], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TEST_TMUX_LOG: log,
      COLLAB_RUNTIME_ROOT: path.join(root, 'runtime'),
      ENSEMBLE_AGENTS_CONFIG: config,
      ENSEMBLE_AGENTS_EXTRA: path.join(root, 'geen-extra.json'),
    },
    encoding: 'utf8',
  })
  return fs.readFileSync(log, 'utf8')
}

describe('rescue gebruikt de afleverwijze uit de agentconfiguratie', () => {
  it('stuurt een sendKeys-agent letterlijk zonder tmux-buffer', () => {
    const log = run('sendKeys')
    expect(log).toContain('send-keys -t team-sendKeys-test-1 -l')
    expect(log).toContain('regel met $ en ;')
    expect(log).not.toContain('paste-buffer')
    expect(log).not.toContain('load-buffer')
  }, 30_000)

  it('plakt voor een pasteFromFile-agent via een tmux-buffer', () => {
    const log = run('pasteFromFile')
    expect(log).toContain('paste-buffer')
    expect(log).toContain('load-buffer')
    expect(log).not.toContain(' -l regel met')
  }, 30_000)
})

describe('rescue bij een agent die de configuratie niet kent', () => {
  it('valt terug op plakken in plaats van te weigeren', () => {
    // Rescue is de noodroute. Weigeren omdat agents.json de naam niet kent
    // laat de gebruiker met niets achter, terwijl plakken bij elke CLI werkt.
    const team = 'team-onbekend'
    const runtime = path.join(root, 'runtime', team)
    const bin = path.join(root, 'bin')
    const log = path.join(root, 'tmux.log')
    const config = path.join(root, 'agents.json')
    fs.mkdirSync(path.join(runtime, 'prompts'), { recursive: true })
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(runtime, 'sessions'), `${team}-vreemd-1\n`)
    fs.writeFileSync(path.join(runtime, 'prompts', 'vreemd-1.txt'), 'doe iets')
    fs.writeFileSync(config, JSON.stringify({ test: {
      name: 'test', command: 'test', flags: [], readyMarker: '❯',
      inputMethod: 'sendKeys', color: 'white', icon: '*',
    } }))
    fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_TMUX_LOG"
case "$1" in
  capture-pane)
    if grep -q 'paste-buffer' "$TEST_TMUX_LOG"; then printf '❯ prompt ontvangen\\n'
    else printf '❯ leeg invoerveld\\n'; fi
    ;;
  has-session) exit 0 ;;
esac
exit 0
`, { mode: 0o755 })
    fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const uit = execFileSync(RESCUE, [team], {
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_TMUX_LOG: log,
        COLLAB_RUNTIME_ROOT: path.join(root, 'runtime'),
        ENSEMBLE_AGENTS_CONFIG: config,
        ENSEMBLE_AGENTS_EXTRA: path.join(root, 'geen-extra.json'),
      },
      encoding: 'utf8',
    })
    expect(fs.readFileSync(log, 'utf8')).toContain('paste-buffer')
    expect(uit).toMatch(/afleverwijze onbekend|niet in agents.json/i)
  }, 30_000)
})
