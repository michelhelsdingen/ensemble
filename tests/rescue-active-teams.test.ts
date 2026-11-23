/**
 * Rescue zonder team-id pakt niet langer stil het globale team-id.
 *
 * /tmp/collab-team-id.txt wordt door elke launch overschreven. Met twee actieve
 * teams koos rescue zonder argument dus willekeurig het laatst gestarte team en
 * zette daar prompts in de panes. Nu stopt het dan met een melding en de lijst.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const RESCUE = path.resolve(process.cwd(), 'scripts/collab-rescue.sh')
let root: string
let bin: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-ra-'))
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-ra-bin-'))
  // Een sessie leeft als haar naam in $TEST_ALIVE staat.
  fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/bash\n[ "$1" = has-session ] && case " $TEST_ALIVE " in *" $3 "*) exit 0;; esac\nexit 1\n', { mode: 0o755 })
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(bin, { recursive: true, force: true })
})

const team = (id: string, session: string, finished = false) => {
  fs.mkdirSync(path.join(root, id), { recursive: true })
  fs.writeFileSync(path.join(root, id, 'sessions'), `${session}\n`)
  if (finished) fs.writeFileSync(path.join(root, id, '.finished'), '')
}
const run = (args: string[], alive: string[], globalId = '') => {
  const globalFile = path.join(root, 'global-id.txt')
  if (globalId) fs.writeFileSync(globalFile, `${globalId}\n`)
  const result = spawnSync('bash', [RESCUE, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, COLLAB_RUNTIME_ROOT: root, COLLAB_TEAM_ID_FILE: globalFile, TEST_ALIVE: alive.join(' ') },
  })
  return { status: result.status, out: `${result.stdout}${result.stderr}` }
}

describe('collab-rescue.sh zonder team-id', () => {
  it('stopt met de lijst als er meer dan één team actief is, ook met een globaal id', () => {
    team('team-a', 'collab-a-codex-1')
    team('team-b', 'collab-b-codex-1')
    const result = run([], ['collab-a-codex-1', 'collab-b-codex-1'], 'team-b')
    expect(result.status).toBe(1)
    expect(result.out).toContain('2 actieve teams')
    expect(result.out).toContain('team-a')
    expect(result.out).toContain('team-b')
    expect(result.out).not.toContain('team-id: team-b')
  })

  it('neemt het enige actieve team, niet een verouderd globaal id', () => {
    team('team-a', 'collab-a-codex-1')
    team('team-oud', 'collab-oud-codex-1', true)
    const result = run([], ['collab-a-codex-1'], 'team-oud')
    // team-a heeft geen prompts/: het script komt dus tot die melding, en niet
    // tot "team-dir bestaat niet" of een melding over team-oud.
    expect(result.out).toContain('prompts/ ontbreekt')
    expect(result.out).not.toContain('team-oud')
  })

  it('valt zonder actief team terug op het globale bestand', () => {
    const result = run([], [], 'team-weg')
    expect(result.out).toContain('team-dir bestaat niet')
    expect(result.out).toContain('team-weg')
  })

  it('stopt niet stil bij een dood, onafgerond team dat als laatste sorteert', () => {
    team('team-a', 'collab-a-codex-1')
    team('team-z-dood', 'collab-z-codex-1')
    const result = run([], ['collab-a-codex-1'], 'team-weg')
    expect(result.out).toContain('prompts/ ontbreekt')
  })

  it('valt bij alleen een dood, onafgerond team terug op het globale bestand', () => {
    team('team-z-dood', 'collab-z-codex-1')
    const result = run([], [], 'team-weg')
    expect(result.out).toContain('team-dir bestaat niet')
    expect(result.out).toContain('team-weg')
  })

  it('met een expliciet team-id verandert er niets', () => {
    team('team-a', 'collab-a-codex-1')
    team('team-b', 'collab-b-codex-1')
    const result = run(['team-a'], ['collab-a-codex-1', 'collab-b-codex-1'])
    expect(result.out).not.toContain('actieve teams')
    expect(result.out).toContain('prompts/ ontbreekt')
  })
})
