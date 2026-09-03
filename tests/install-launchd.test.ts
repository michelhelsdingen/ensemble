/**
 * scripts/install-launchd.sh writes a launchd agent that keeps the service up.
 *
 * Without it the service is a loose `tsx server.ts` that disappears on every
 * reboot and has to be restarted by hand after each code change.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO = process.cwd()
const INSTALL = path.join(REPO, 'scripts/install-launchd.sh')
const LABEL = 'dev.ensemble.server'

describe('install-launchd.sh', () => {
  let home: string
  let plist: string

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-launchd-'))
    plist = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`)
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  function run(...args: string[]): string {
    return execFileSync(INSTALL, args, { env: { ...process.env, HOME: home }, encoding: 'utf8' })
  }

  it('writes a valid plist that runs the server from the repo and keeps it alive', () => {
    run('--no-load')
    expect(fs.existsSync(plist)).toBe(true)
    execFileSync('plutil', ['-lint', plist])

    const xml = fs.readFileSync(plist, 'utf8')
    expect(xml).toContain(`<string>${LABEL}</string>`)
    expect(xml).toContain(`<string>${path.join(REPO, 'node_modules/.bin/tsx')}</string>`)
    expect(xml).toContain('<string>server.ts</string>')
    expect(xml).toContain(`<key>WorkingDirectory</key><string>${REPO}</string>`)
    expect(xml).toContain('<key>KeepAlive</key><true/>')
    expect(xml).toContain('<key>RunAtLoad</key><true/>')
    expect(xml).toContain('/tmp/ensemble-server.log')
  })

  it('carries the PATH of the installing shell so agent CLIs can be found', () => {
    run('--no-load')
    const xml = fs.readFileSync(plist, 'utf8')
    expect(xml).toContain('<key>PATH</key>')
    expect(xml).toContain(path.dirname(execFileSync('sh', ['-c', 'command -v node'], { encoding: 'utf8' }).trim()))
  })

  it('--uninstall removes the plist', () => {
    run('--no-load')
    run('--uninstall', '--no-load')
    expect(fs.existsSync(plist)).toBe(false)
  })
})
