/**
 * Verweesde tmux-sessies van oude teams moeten opgeruimd kunnen worden.
 *
 * 03-11-2026 gemeten op deze machine: collab-1793370919814-7089-mimo-5 draaide
 * sinds 30 oktober en collab-1793655026254-9985-agy-3 sinds 2 november, terwijl
 * die teams lang klaar waren. collab-cleanup.sh ruimt alleen runtime-mappen op
 * en raakt tmux niet aan, dus er was niets dat deze sessies ooit zou stoppen.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = path.resolve(process.cwd(), 'scripts/collab-orphans.sh')
let root: string
let bin: string

const NU = Math.floor(Date.now() / 1000)
const UUR = 3600

/** Sessies zoals tmux ze met -F teruggeeft: naam en starttijd in epoch. */
const SESSIES = [
  ['collab-1793370919814-7089-mimo-5', NU - 96 * UUR],
  ['collab-1793655026254-9985-agy-3', NU - 16 * UUR],
  ['collab-1793713220568-7983-agy-3', NU - 1],
  ['collab-1793713220568-7983-glm-4', NU - 1],
  ['ensemble-e2eef7f7-2af6-47a9-8292-c805499cc42a', NU - 1],
  ['mijn-eigen-werk', NU - 500 * UUR],
] as const

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-orphans-'))
  bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'tmux'), [
    '#!/bin/bash',
    'if [ "$1" = list-sessions ]; then',
    ...SESSIES.map(([naam, start]) => `  printf '%s\\t%s\\n' '${naam}' '${start}'`),
    '  exit 0',
    'fi',
    'if [ "$1" = kill-session ]; then printf "%s\\n" "$3" >> "$TEST_KILLED"; exit 0; fi',
    'exit 0',
  ].join('\n'), { mode: 0o755 })
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

function run(args: string[] = [], teams?: unknown) {
  const killed = path.join(root, 'killed')
  fs.rmSync(killed, { force: true })
  const body = teams === undefined
    ? JSON.stringify({
      teams: [{
        id: 'e2eef7f7-2af6-47a9-8292-c805499cc42a',
        name: 'collab-1793713220568-7983',
        status: 'active',
      }, {
        id: 'oud-1', name: 'collab-1793370919814-7089', status: 'disbanded',
      }],
    })
    : JSON.stringify(teams)
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/bash\n${teams === null ? 'exit 7' : `cat <<'JSON'\n${body}\nJSON`}\n`, { mode: 0o755 })
  const result = spawnSync('/bin/bash', [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_KILLED: killed },
    timeout: 30_000,
  })
  return {
    ...result,
    output: result.stdout + result.stderr,
    killed: fs.existsSync(killed) ? fs.readFileSync(killed, 'utf8').trim().split('\n') : [],
  }
}

describe('collab-orphans.sh', () => {
  it('noemt de wezen en doodt zonder --force niets', () => {
    const { status, output, killed } = run()
    expect(status, output).toBe(0)
    expect(output).toContain('collab-1793370919814-7089-mimo-5')
    expect(output).toContain('collab-1793655026254-9985-agy-3')
    expect(killed).toEqual([])
  })

  it('laat de sessies van een levend team staan', () => {
    const { output } = run()
    expect(output).not.toMatch(/\bwees\b.*collab-1793713220568-7983-agy-3/)
    expect(output).not.toMatch(/\bwees\b.*collab-1793713220568-7983-glm-4/)
    expect(output).not.toMatch(/\bwees\b.*ensemble-e2eef7f7/)
  })

  it('raakt een sessie buiten collab nooit aan', () => {
    const { output, killed } = run(['--force'])
    expect(output).not.toContain('mijn-eigen-werk')
    expect(killed).not.toContain('mijn-eigen-werk')
  })

  it('doodt met --force alleen de wezen', () => {
    const { status, killed, output } = run(['--force'])
    expect(status, output).toBe(0)
    expect(killed.sort()).toEqual([
      'collab-1793370919814-7089-mimo-5',
      'collab-1793655026254-9985-agy-3',
    ])
  })

  it('spaart een sessie die net gestart is, ook zonder team in het register', () => {
    const { killed } = run(['--force'], { teams: [] })
    expect(killed).not.toContain('collab-1793713220568-7983-agy-3')
    expect(killed).toContain('collab-1793655026254-9985-agy-3')
  })

  it('ruimt niets op als het register onbereikbaar is', () => {
    const { status, output, killed } = run(['--force'], null)
    expect(killed).toEqual([])
    expect(output).toMatch(/register|onbereikbaar/i)
    expect(status).not.toBe(0)
  })
})
