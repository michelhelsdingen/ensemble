/**
 * Preflight moet een startdialoog zien die een team stil stuk laat starten.
 *
 * 03-11-2026 gemeten: codex 0.164.0 stond modaal in "Hooks need review" en
 * nam niets aan, maar deze preflight toetst codex met `codex exec`, en dat pad
 * ziet geen interactieve dialoog. Preflight was dus groen, de launcher startte
 * het team, de prompt verdween in de dialoog en niemand zei iets.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const preflight = path.resolve(process.cwd(), 'scripts/collab-preflight.sh')
let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-startprobe-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

async function run(probeJson: string, agents = 'codex,claude'): Promise<{ code: number; output: string }> {
  const stub = path.join(root, 'startprobe')
  fs.writeFileSync(stub, `#!/bin/bash\ncat <<'JSON'\n${probeJson}\nJSON\n`, { mode: 0o755 })
  try {
    const { stdout, stderr } = await execFileAsync(preflight, [agents], {
      env: {
        ...process.env,
        COLLAB_STARTPROBE_CMD: stub,
      },
      encoding: 'utf8',
      timeout: 60_000,
    })
    return { code: 0, output: stdout + stderr }
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string }
    return { code: e.code ?? -1, output: (e.stdout ?? '') + (e.stderr ?? '') }
  }
}

describe('preflight startprobe', () => {
  // De probe loopt sinds 03-11-2026 op de achtergrond en wordt in sectie 5b
  // beoordeeld, dus na de auth-checks. In deze testomgeving staat HOME in
  // tmp/home (zie vitest.config.ts), waardoor codex daar niet kan inloggen en
  // preflight met code 4 stopt vóór sectie 5b. Daarom toetsen we hier wat er
  // dan hoort te gebeuren: de dialoog verdwijnt niet achter die andere fout.
  it('meldt de dialoog, ook als een andere check eerder faalt', async () => {
    const { output } = await run(JSON.stringify({
      codex: { status: 'blocked', seconds: 1.74, gates: [], detail: 'Hooks need review\n> 1. Review hooks' },
      claude: { status: 'ok', seconds: 2.8, gates: ['trust prompt'] },
    }))
    expect(output).toContain('Hooks need review')
    expect(output).toContain('codex')
    expect(output).toContain('dialoog die alleen jij mag beantwoorden')
  }, 90_000)

  it('stopt met code 9 als de dialoog het enige probleem is', async () => {
    // Zonder codex in de ploeg komt preflight wel tot sectie 5b.
    const { code, output } = await run(JSON.stringify({
      grok: { status: 'blocked', seconds: 1.5, gates: [], detail: 'Trust this folder?' },
    }), 'grok')
    expect(code).toBe(9)
    expect(output).toContain('Trust this folder?')
  }, 90_000)

  it('laat preflight doorgaan als geen enkele agent op een dialoog wacht', async () => {
    const { code, output } = await run(JSON.stringify({
      grok: { status: 'ok', seconds: 1.2, gates: [] },
    }), 'grok')
    expect(code).not.toBe(9)
    expect(output).toContain('Geen startdialoog in de weg')
  }, 90_000)

  it('laat een trage of ontbrekende agent niet als blokkade gelden', async () => {
    const { code, output } = await run(JSON.stringify({
      grok: { status: 'no-ready-marker', seconds: 25, gates: [] },
      glm: { status: 'missing', seconds: 0, gates: [] },
    }), 'grok,glm')
    expect(code).not.toBe(9)
    expect(output).toContain('Geen startdialoog in de weg')
  }, 90_000)
})

describe('preflight startprobe argumenten', () => {
  it('voert een agentnaam niet uit als shell-commando', async () => {
    // De agentlijst komt van de aanroeper. Een naam met een puntkomma mag geen
    // commando worden; hij hoort te worden overgeslagen met een melding.
    const bewijs = path.join(root, 'uitgevoerd')
    const stub = path.join(root, 'startprobe')
    fs.writeFileSync(stub, '#!/bin/bash\nprintf "%s" "$*" > "$1.args" 2>/dev/null || true\necho "{}"\n', { mode: 0o755 })
    try {
      await execFileAsync(preflight, [`codex; touch ${bewijs}`], {
        env: { ...process.env, COLLAB_STARTPROBE_CMD: stub },
        encoding: 'utf8',
        timeout: 60_000,
      })
    } catch { /* de dure checks verderop mogen falen */ }
    expect(fs.existsSync(bewijs)).toBe(false)
  }, 90_000)
})

/**
 * Snelheid: de probe start twee CLI's en kost op deze machine ongeveer zes
 * seconden (gemeten 03-11-2026). Serieel vóór de rest van de preflight was dat
 * ruim 70% van de wachttijd van elke teamstart, terwijl hij niets nodig heeft
 * van die andere checks en zij niets van hem. Hij hoort dus naast ze te lopen.
 */
describe('preflight startprobe loopt naast de andere checks', () => {
  const src = fs.readFileSync(preflight, 'utf8')

  it('start de probe voordat de servicecheck begint en beoordeelt hem later', () => {
    const gestart = src.indexOf('STARTPROBE_PID=$!')
    const service = src.indexOf('─── 1. Ensemble service ───')
    const oordeel = src.indexOf('─── 5b. Uitslag van de startdialoog-probe')
    const keuze = src.indexOf('─── Decide which agents to spawn ───')
    expect(gestart).toBeGreaterThan(0)
    expect(gestart).toBeLessThan(service)
    expect(oordeel).toBeGreaterThan(service)
    expect(oordeel).toBeLessThan(keuze)
  })

  it('wacht niet eerst de probe uit voordat de rest mag draaien', async () => {
    const stub = path.join(root, 'startprobe')
    fs.writeFileSync(stub, '#!/bin/bash\nsleep 4\necho "{}"\n', { mode: 0o755 })
    const begin = Date.now()
    try {
      await execFileAsync(preflight, ['grok'], {
        env: { ...process.env, COLLAB_STARTPROBE_CMD: stub },
        encoding: 'utf8', timeout: 60_000,
      })
    } catch { /* de checks zelf mogen hier falen */ }
    const seconden = (Date.now() - begin) / 1000
    // Serieel zou dit de 4 seconden probe plus ruim een seconde checks zijn.
    expect(seconden).toBeLessThan(5)
  }, 90_000)
})

/**
 * Gemeten 03-11-2026, nadat de probe zelf was gebouwd: `collab-preflight.sh grok`
 * meldde "geen bruikbare agentnamen" en probede dus niemand, en bij `glm,grok`
 * ging alleen glm door de probe. Oorzaak: de lus over de agentlijst las met
 * `read` uit een printf zonder regeleinde, en bash slaat de laatste regel dan
 * over. Een probe die de helft van de ploeg niet bekijkt, is geen probe.
 */
describe('preflight startprobe bekijkt elke gevraagde agent', () => {
  async function args(agents: string): Promise<string> {
    const uit = path.join(root, 'args')
    const stub = path.join(root, 'startprobe')
    fs.writeFileSync(stub, `#!/bin/bash\nprintf '%s\\n' "$@" > ${uit}\necho '{}'\n`, { mode: 0o755 })
    try {
      await execFileAsync(preflight, [agents], {
        env: { ...process.env, COLLAB_STARTPROBE_CMD: stub },
        encoding: 'utf8', timeout: 60_000,
      })
    } catch { /* de checks verderop mogen falen */ }
    return fs.existsSync(uit) ? fs.readFileSync(uit, 'utf8') : ''
  }

  it('geeft ook de laatste agent uit de lijst mee', async () => {
    const gezien = await args('glm,grok')
    expect(gezien).toContain('glm')
    expect(gezien).toContain('grok')
  }, 90_000)

  it('probet ook een ploeg van één agent', async () => {
    expect(await args('grok')).toContain('grok')
  }, 90_000)
})
