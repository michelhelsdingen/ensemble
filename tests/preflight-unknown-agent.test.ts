/**
 * Een naam die geen agent is, moet meteen een fout zijn, met de namen die wel
 * bestaan erbij.
 *
 * Gemeten 04-11-2026 op een eigen service: `/collab` met de typefout `grk`
 * gaf eerst "All preflight checks passed" (met een onopvallende Warning erboven
 * en zelfs een vinkje "Geen startdialoog in de weg (grk)"), en daarna exit 22
 * na 1,8 seconde zonder één woord uitleg. De service weigerde het team wel
 * netjes met "Unknown agent(s): "grk". Available: ...", maar dat antwoord haalde
 * het scherm niet (zie launch-create-error.test.ts).
 *
 * Alleen een naam die niet in agents.json staat is hier fout. Een agent die
 * bestaat maar plat ligt houdt zijn eigen pad (health hook, exit 3/4/6/7), en
 * een eigen agent uit ~/.config/ensemble/agents.json blijft gewoon werken.
 */
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const preflight = path.resolve(process.cwd(), 'scripts/collab-preflight.sh')

async function run(agents: string): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(preflight, [agents], {
      encoding: 'utf8', timeout: 60_000,
    })
    return { code: 0, output: stdout + stderr }
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string }
    return { code: e.code ?? -1, output: (e.stdout ?? '') + (e.stderr ?? '') }
  }
}

describe('preflight en een naam die geen agent is', () => {
  it('stopt bij een typefout, noemt de naam en de bestaande agents', async () => {
    const { code, output } = await run('grk')
    expect(output).toContain('grk')
    expect(output).toMatch(/kent deze agent niet|geen agent|unknown agent/i)
    // De lijst met namen die wel bestaan hoort erbij, anders moet je gaan zoeken.
    expect(output).toMatch(/codex/)
    expect(output).toMatch(/claude/)
    expect(output).not.toContain('All preflight checks passed')
    expect(code).toBe(7)
  }, 70_000)

  it('laat een bestaande agent door naar de gewone controles', async () => {
    const { output } = await run('glm')
    // glm bestaat, dus deze check mag er niets over zeggen.
    expect(output).not.toMatch(/kent deze agent niet/i)
  }, 70_000)
})
