/**
 * De monitoropeners: één commando voor allemaal, en een tijdgrens op Orca.
 *
 * Alleen de tmux-split gaf de ENSEMBLE_*-omgeving van de aanroeper door; herdr,
 * Orca en iTerm startten de monitor met de standaardinstellingen. En een hangende
 * Orca-CLI hield de launcher onbegrensd vast. Hier staan neppe herdr- en
 * orca-programma's: er wordt geen echt paneel geopend.
 */
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { afterAll, describe, expect, it } from 'vitest'

const repo = process.cwd()
const root = fs.mkdtempSync(path.join(repo, 'tmp/openers-'))
const bin = path.join(root, 'bin')
fs.mkdirSync(bin)
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const tool = (name: string, body: string) =>
  fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 })
const baseEnv = {
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  COLLAB_RUNTIME_ROOT: path.join(root, 'runtime'),
  COLLAB_HERDR_LOG: path.join(root, 'herdr.log'),
  COLLAB_ORCA_LOG: path.join(root, 'orca.log'),
  ENSEMBLE_URL: 'http://monitor.test',
  ENSEMBLE_PORT: '23999',
}
const TEAM = 'team-1'
fs.mkdirSync(path.join(root, 'runtime', TEAM), { recursive: true })

describe('collab_monitor_command', () => {
  const command = (repoDir: string, extra = '', env: Record<string, string> = {}) =>
    spawnSync('bash', ['-c', `. scripts/collab-paths.sh; collab_monitor_command "$1" team-9 ${extra}`, '_', repoDir], {
      encoding: 'utf8', cwd: repo,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ENSEMBLE_'))), ...env },
    }).stdout

  it('bouwt het commando met de ENSEMBLE_*-omgeving van de aanroeper', () => {
    expect(command('/opt/ensemble', '', { ENSEMBLE_URL: 'http://x.test' }))
      .toBe('cd /opt/ensemble && ENSEMBLE_URL=http://x.test ./node_modules/.bin/tsx cli/monitor.ts team-9')
  })

  it('zet exec voor de runner als daarom gevraagd wordt en quote een pad met spaties', () => {
    expect(command('/opt/mijn repo', 'exec')).toBe('cd /opt/mijn\\ repo && exec ./node_modules/.bin/tsx cli/monitor.ts team-9')
  })
})

describe('open-herdr-monitor.sh', () => {
  it('geeft het monitorcommando de ENSEMBLE_*-omgeving mee', () => {
    const log = path.join(root, 'herdr-aanroepen.log')
    tool('herdr', `printf '%s\\n' "$*" >> "${log}"
if [ "$1 $2" = "pane split" ]; then echo '{"result":{"pane":{"pane_id":"w1:p2"}}}'; fi
exit 0`)
    const result = spawnSync('bash', [path.join(repo, 'scripts/open-herdr-monitor.sh'), '/opt/ensemble', TEAM, 'split'], {
      encoding: 'utf8', env: { ...baseEnv, HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' },
    })
    expect(result.status, result.stderr).toBe(0)
    const run = fs.readFileSync(log, 'utf8').split('\n').find(l => l.startsWith('pane run'))
    expect(run).toContain('ENSEMBLE_URL=http://monitor.test')
    expect(run).toContain('ENSEMBLE_PORT=23999')
    expect(run).toContain('exec ./node_modules/.bin/tsx cli/monitor.ts team-1')
  })
})

describe('open-iterm-monitor.sh', () => {
  it.skipIf(process.platform !== 'darwin')('geeft het monitorcommando de ENSEMBLE_*-omgeving mee', () => {
    const log = path.join(root, 'osascript-aanroepen.log')
    tool('osascript', `if [ "$1" = "-e" ]; then echo true; exit 0; fi
printf '%s\\n' "$*" >> "${log}"
echo "windows=1 window_id=1 tabs_in_window=1 new_session_id=S1"`)
    const result = spawnSync('bash', [path.join(repo, 'scripts/open-iterm-monitor.sh'), '/opt/ensemble', TEAM, 'split'], {
      encoding: 'utf8', env: { ...baseEnv, COLLAB_ITERM_LOG: path.join(root, 'iterm.log') },
    })
    expect(result.status, result.stderr).toBe(0)
    const call = fs.readFileSync(log, 'utf8')
    expect(call).toContain('ENSEMBLE_URL=http://monitor.test')
    expect(call).toContain('ENSEMBLE_PORT=23999')
    expect(call).toContain('./node_modules/.bin/tsx cli/monitor.ts team-1')
  })
})

describe('open-orca-monitor.sh', () => {
  const LIST = '{"ok":true,"result":{"terminals":[{"handle":"term_src","tabId":"tab1","leafId":"leaf1"}]}}'
  const SPLIT = '{"ok":true,"result":{"split":{"handle":"term_new"}}}'
  const run = (env: Record<string, string> = {}) => {
    const begin = Date.now()
    const result = spawnSync('bash', [path.join(repo, 'scripts/open-orca-monitor.sh'), '/opt/ensemble', TEAM, 'split'], {
      encoding: 'utf8', env: { ...baseEnv, ORCA_AGENT_PANE: 'tab1:leaf1', ...env },
    })
    return { ...result, seconds: (Date.now() - begin) / 1000 }
  }

  it('geeft het monitorcommando de ENSEMBLE_*-omgeving mee en bewaart het terminal-id onder de runtime-root', () => {
    const log = path.join(root, 'orca-aanroepen.log')
    tool('orca', `printf '%s\\n' "$*" >> "${log}"
case "$1 $2" in
  "terminal list") echo '${LIST}' ;;
  "terminal split") echo '${SPLIT}' ;;
esac
exit 0`)
    const result = run()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('new_pane_id=term_new')
    const split = fs.readFileSync(log, 'utf8').split('\n').find(l => l.startsWith('terminal split'))
    expect(split).toContain('ENSEMBLE_URL=http://monitor.test')
    expect(split).toContain('exec ./node_modules/.bin/tsx cli/monitor.ts team-1')
    expect(fs.readFileSync(path.join(root, 'runtime', TEAM, 'orca-terminal-id'), 'utf8').trim()).toBe('term_new')
  })

  it('geeft op bij een hangende terminal list, binnen de tijdgrens', () => {
    tool('orca', 'sleep 30')
    const result = run({ COLLAB_ORCA_TIMEOUT: '1' })
    expect(result.status).toBe(5)
    expect(result.seconds).toBeLessThan(6)
    expect(fs.readFileSync(path.join(root, 'orca.log'), 'utf8')).toContain('tijdslimiet')
  })

  it('geeft op bij een hangende terminal split, binnen de tijdgrens', () => {
    tool('orca', `if [ "$1 $2" = "terminal list" ]; then echo '${LIST}'; else sleep 30; fi`)
    const result = run({ COLLAB_ORCA_TIMEOUT: '1' })
    expect(result.status).toBe(5)
    expect(result.seconds).toBeLessThan(6)
    expect(result.stderr).toContain('Orca split failed')
  })
})

describe('open-orca-webfeed.sh', () => {
  it('geeft op bij een hangende tab create, binnen de tijdgrens, en stopt zijn server', () => {
    const cli = path.join(bin, 'orca-hangt')
    fs.writeFileSync(cli, '#!/bin/bash\nsleep 30\n', { mode: 0o755 })
    const begin = Date.now()
    const result = spawnSync('bash', [path.join(repo, 'scripts/open-orca-webfeed.sh'), TEAM], {
      encoding: 'utf8', env: { ...baseEnv, ORCA_CLI_COMMAND: cli, COLLAB_ORCA_TIMEOUT: '1' },
    })
    expect(result.status).toBe(5)
    expect((Date.now() - begin) / 1000).toBeLessThan(8)
    expect(result.stderr).toContain('Orca tab creation failed')
  })

  it('heeft een standaard tijdgrens van 10 s', () => {
    expect(fs.readFileSync(path.join(repo, 'scripts/open-orca-webfeed.sh'), 'utf8')).toContain('COLLAB_ORCA_TIMEOUT:-10')
    expect(fs.readFileSync(path.join(repo, 'scripts/open-orca-monitor.sh'), 'utf8')).toContain('COLLAB_ORCA_TIMEOUT:-10')
  })
})
