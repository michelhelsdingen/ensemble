/**
 * Shell-aanroepers moeten dezelfde gereedheidstoets kunnen stellen als de
 * service, zodat collab-rescue.sh niet blind in een dialoog plakt.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync, spawnSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const hasTmux = (() => {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true } catch { return false }
})()

let root: string
let socket: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-paneready-'))
  socket = path.join(root, 's')
})
afterEach(() => {
  try { execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' }) } catch { /* al weg */ }
  fs.rmSync(root, { recursive: true, force: true })
})

/** Een pane met vaste inhoud, via een eigen tmux-socket die in PATH voorgaat. */
function paneMet(inhoud: string) {
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'tmux'), [
    '#!/bin/bash',
    'if [ "$1" = capture-pane ]; then',
    `  cat <<'PANE'`,
    inhoud,
    'PANE',
    '  exit 0',
    'fi',
    'exit 1',
  ].join('\n'), { mode: 0o755 })
  return spawnSync(path.join(process.cwd(), 'node_modules/.bin/tsx'), [
    'scripts/pane-ready.ts', 'wat-dan-ook', process.argv[0] ? 'codex-1' : 'codex-1',
  ], {
    encoding: 'utf8',
    cwd: process.cwd(),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  })
}

describe.skipIf(!hasTmux)('pane-ready.ts', () => {
  it('meldt code 10 en de naam van een onbekende dialoog', () => {
    const result = paneMet([
      '  Hooks need review',
      '  6 hooks are new or changed.',
      '',
      '\u203a 1. Review hooks',
      '  2. Trust all and continue',
      '',
      '  enter confirm',
    ].join('\n'))
    expect(result.status).toBe(10)
    expect(result.stdout).toContain('Hooks need review')
  })

  it('meldt code 0 voor een pane die invoer aanneemt', () => {
    const result = paneMet(['  Codex v0.164.0', '', '\u203a '].join('\n'))
    expect(result.status).toBe(0)
  })

  it('meldt code 11 voor een pane die nog niets bruikbaars toont', () => {
    const result = paneMet('  bezig met opstarten')
    expect(result.status).toBe(11)
  })

  it('meldt code 12 als de pane niet te lezen is', () => {
    const bin = path.join(root, 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/bash\nexit 1\n', { mode: 0o755 })
    const result = spawnSync(path.join(process.cwd(), 'node_modules/.bin/tsx'), [
      'scripts/pane-ready.ts', 'weg', 'codex-1',
    ], { encoding: 'utf8', cwd: process.cwd(), env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
    expect(result.status).toBe(12)
  })
})

describe('collab-rescue.sh', () => {
  it('kijkt naar de pane voordat hij plakt', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'scripts/collab-rescue.sh'), 'utf8')
    const toets = src.indexOf('pane-ready.ts')
    const plak = src.indexOf('tmux paste-buffer')
    expect(toets).toBeGreaterThan(-1)
    expect(plak).toBeGreaterThan(-1)
    expect(toets).toBeLessThan(plak)
  })
})
