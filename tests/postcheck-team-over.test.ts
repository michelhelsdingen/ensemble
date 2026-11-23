/**
 * Een afgerond of opgeheven team heeft geen postcheck meer nodig.
 *
 * De postcheck liep ook na het einde van een team nog door en adviseerde een
 * rescue voor agents die allang klaar waren. Nu stopt hij zodra .finished er
 * staat of de service het team als opgeheven kent, voor en na zijn wachttijd.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const POSTCHECK = path.resolve(process.cwd(), 'scripts/collab-postcheck.sh')
let root: string
let bin: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-pco-'))
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-pco-bin-'))
  const dir = path.join(root, 'team-x')
  fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'sessions'), 'collab-1-1-codex-1\n')
  fs.writeFileSync(path.join(dir, 'prompts', 'codex-1.txt'), 'prompt')
  // Een uitgelogde pane: zonder de nieuwe controle meldt de postcheck hier een fout.
  fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/bash\n[ "$1" = capture-pane ] && echo "Not logged in"\nexit 0\n', { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/bash\n[ -n "${TEST_TEAM_JSON:-}" ] || exit 7\nprintf "%s" "$TEST_TEAM_JSON"\n', { mode: 0o755 })
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(bin, { recursive: true, force: true })
})

function run(teamJson = '') {
  const result = spawnSync(POSTCHECK, ['team-x', '0'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, COLLAB_RUNTIME_ROOT: root, TEST_TEAM_JSON: teamJson },
  })
  return { status: result.status, out: `${result.stdout}${result.stderr}` }
}

describe('postcheck bij een team dat al over is', () => {
  it('stopt met exit 0 als het team .finished heeft, zonder rescue te adviseren', () => {
    fs.writeFileSync(path.join(root, 'team-x', '.finished'), '')
    const result = run()
    expect(result.status).toBe(0)
    expect(result.out).toContain('al afgerond of opgeheven')
    expect(result.out).not.toContain('collab-rescue.sh')
    expect(result.out).not.toContain('NOT LOGGED IN')
  })

  it('stopt ook als de service het team als opgeheven kent', () => {
    const result = run(JSON.stringify({ team: { id: 'team-x', status: 'disbanded', agents: [] } }))
    expect(result.status).toBe(0)
    expect(result.out).toContain('al afgerond of opgeheven')
    expect(result.out).not.toContain('collab-rescue.sh')
  })

  it('blijft een team dat nog leeft gewoon controleren', () => {
    const result = run(JSON.stringify({ team: { id: 'team-x', status: 'active', agents: [] } }))
    expect(result.status).toBe(2)
    expect(result.out).toContain('NOT LOGGED IN')
  })
})
