/**
 * De postcheck mag alleen de sessies van zijn eigen team killen.
 *
 * Tot 20-09-2026 haalde hij met `tmux ls` elke sessie op die op een collab-naam
 * leek, en kilde bij een gevonden fout die hele lijst. Draaiden er twee teams
 * en zat er in het ene een uitgelogde agent, dan ging het andere team mee.
 *
 * Deze test zet een nep-tmux vooraan in PATH die zijn aanroepen logt. Daarmee
 * is te controleren wat er werkelijk gekild wordt, in plaats van te toetsen
 * hoe het script geschreven is. Een eerdere versie voerde postcheck uit tegen
 * sessienamen die nergens bestonden: die test slaagde ook op de kapotte code,
 * want een sessie die er niet is komt hoe dan ook niet in de uitvoer voor.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const POSTCHECK = path.resolve(process.cwd(), 'scripts/collab-postcheck.sh')

let root: string
let bin: string
let log: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-pc-'))
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-bin-'))
  log = path.join(bin, 'tmux-aanroepen.log')

  // Nep-tmux: meldt twee teams in `ls`, geeft een uitgelogde pane terug zodat de
  // postcheck tot killen overgaat, en schrijft elke aanroep naar het logbestand.
  fs.writeFileSync(
    path.join(bin, 'tmux'),
    `#!/bin/bash
echo "$@" >> "${log}"
case "$1" in
  ls)
    echo "collab-1758-4412-claude-1: 1 windows"
    echo "collab-9931-7720-codex-1: 1 windows"
    ;;
  capture-pane) echo "\${TEST_CAPTURE:-Not logged in}" ;;
esac
exit 0
`,
    { mode: 0o755 },
  )

  // Nep-curl: geeft de teamstatus terug die de test voorschrijft. Zonder
  // TEST_TEAM_JSON faalt hij, net als een onbereikbare service.
  fs.writeFileSync(
    path.join(bin, 'curl'),
    `#!/bin/bash
if [ -z "\${TEST_TEAM_JSON:-}" ]; then exit 7; fi
printf '%s' "\$TEST_TEAM_JSON"
`,
    { mode: 0o755 },
  )
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(bin, { recursive: true, force: true })
})

function draaiPostcheck(teamId: string, capture = '', teamJson = ''): string {
  try {
    return execFileSync(POSTCHECK, [teamId, '0'], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, COLLAB_RUNTIME_ROOT: root, TEST_CAPTURE: capture,
        TEST_TEAM_JSON: teamJson },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string }
    return `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
}

function gekildeSessies(): string[] {
  if (!fs.existsSync(log)) return []
  return fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter(regel => regel.startsWith('kill-session'))
    .map(regel => regel.replace(/^kill-session -t /, '').trim())
}

describe('postcheck scope', () => {
  it('kilt alleen de sessies uit het eigen register, niet die van een ander team', () => {
    const dir = path.join(root, 'mijn-team')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'sessions'), 'collab-1758-4412-claude-1\n')
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), '')

    draaiPostcheck('mijn-team')

    expect(gekildeSessies()).toEqual(['collab-1758-4412-claude-1'])
    expect(gekildeSessies()).not.toContain('collab-9931-7720-codex-1')
  })

  it('kilt niets als er geen register is, en valt niet terug op een tmux-scan', () => {
    const dir = path.join(root, 'oud-team')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), '')

    const uit = draaiPostcheck('oud-team')

    expect(uit).toMatch(/geen sessieregister/i)
    expect(gekildeSessies()).toEqual([])
  })

  it('waarschuwt voor de stille agent als een andere agent wel berichten stuurde', () => {
    const dir = path.join(root, 'asymmetrisch-team')
    fs.mkdirSync(dir, { recursive: true })
    fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'prompts', 'codex-1.txt'), 'prompt')
    fs.writeFileSync(path.join(dir, 'prompts', 'agy-2.txt'), 'prompt')
    fs.writeFileSync(path.join(dir, 'sessions'), 'asymmetrisch-team-codex-1\nasymmetrisch-team-agy-2\n')
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), [
      JSON.stringify({ from: 'codex-1', content: 'started' }),
      JSON.stringify({ from: 'ensemble', content: 'system notice' }),
    ].join('\n') + '\n')

    const uit = draaiPostcheck('asymmetrisch-team', 'ready')

    expect(uit).toMatch(/agy-2/)
    expect(uit).toMatch(/stil|geen bericht/i)
    expect(uit).toContain('collab-rescue.sh asymmetrisch-team agy-2')
    expect(uit).not.toContain('agents healthy')
  })
})

/**
 * Een agent die zijn prompt heeft aangenomen en nog denkt, is geen storing.
 *
 * Gemeten 03-11-2026 (team ee1b35b0): 30 seconden na de start riep de postcheck
 * "Geen bericht ontvangen van deze agent(s)" over glm-1, die gewoon aan het werk
 * was en twee minuten later zijn conclusie stuurde. De postcheck moet daarom
 * dezelfde afleverstaat gebruiken als de launcher, en alleen klagen als de
 * prompt echt niet is aangekomen.
 */
describe('postcheck en de afleverstaat van de service', () => {
  function teamMet(agents: Array<[string, string]>, sprekers: string[]): string {
    return JSON.stringify({
      team: {
        id: 'statusteam', name: 'statusteam',
        agents: agents.map(([name, delivery]) => ({ name, status: 'active', delivery })),
      },
      messages: sprekers.map(from => ({ from, content: 'hoi' })),
    })
  }

  function zetTeamKlaar(naam: string): void {
    const dir = path.join(root, naam)
    fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'prompts', 'codex-1.txt'), 'prompt')
    fs.writeFileSync(path.join(dir, 'prompts', 'glm-2.txt'), 'prompt')
    fs.writeFileSync(path.join(dir, 'sessions'), `${naam}-codex-1\n${naam}-glm-2\n`)
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), JSON.stringify({ from: 'codex-1', content: 'hoi' }) + '\n')
  }

  it('klaagt niet over een agent die de prompt aannam en nog denkt', () => {
    zetTeamKlaar('statusteam')
    const uit = draaiPostcheck('statusteam', 'ready', teamMet([['codex-1', 'confirmed'], ['glm-2', 'silent']], ['codex-1']))
    expect(uit).not.toMatch(/Geen bericht ontvangen/i)
    expect(uit).not.toContain('collab-rescue.sh')
    expect(uit).toMatch(/glm-2/)
    expect(uit).toMatch(/aangekomen/i)
  })

  it('klaagt wel als de prompt echt niet is aangekomen', () => {
    zetTeamKlaar('faalteam')
    const uit = draaiPostcheck('faalteam', 'ready', teamMet([['codex-1', 'confirmed'], ['glm-2', 'failed']], ['codex-1']))
    expect(uit).toMatch(/glm-2/)
    expect(uit).toContain('collab-rescue.sh faalteam glm-2')
  })
})
