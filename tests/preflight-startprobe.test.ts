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

async function run(probeJson: string): Promise<{ code: number; output: string }> {
  const stub = path.join(root, 'startprobe')
  fs.writeFileSync(stub, `#!/bin/bash\ncat <<'JSON'\n${probeJson}\nJSON\n`, { mode: 0o755 })
  try {
    const { stdout, stderr } = await execFileAsync(preflight, ['codex,claude'], {
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
  it('stopt met code 9 en noemt de dialoog als een agent erop wacht', async () => {
    const { code, output } = await run(JSON.stringify({
      codex: { status: 'blocked', seconds: 1.74, gates: [], detail: 'Hooks need review\n> 1. Review hooks' },
      claude: { status: 'ok', seconds: 2.8, gates: ['trust prompt'] },
    }))
    expect(code).toBe(9)
    expect(output).toContain('Hooks need review')
    expect(output).toContain('codex')
  }, 90_000)

  // Deze twee lopen door naar de dure auth-checks, die in een testomgeving met
  // een eigen HOME niet kunnen slagen. Wat hier telt is dat de startprobe zelf
  // niets tegenhoudt en zijn vinkje geeft.
  it('laat preflight doorgaan als geen enkele agent op een dialoog wacht', async () => {
    const { code, output } = await run(JSON.stringify({
      codex: { status: 'ok', seconds: 1.2, gates: [] },
      claude: { status: 'ok', seconds: 2.8, gates: ['trust prompt'] },
    }))
    expect(code).not.toBe(9)
    expect(output).toContain('Geen startdialoog in de weg')
  }, 90_000)

  it('laat een trage of ontbrekende agent niet als blokkade gelden', async () => {
    const { code, output } = await run(JSON.stringify({
      codex: { status: 'no-ready-marker', seconds: 25, gates: [] },
      claude: { status: 'missing', seconds: 0, gates: [] },
    }))
    expect(code).not.toBe(9)
    expect(output).toContain('Geen startdialoog in de weg')
  }, 90_000)
})
