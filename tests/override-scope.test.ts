import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

const PRE = fs.readFileSync(path.resolve(process.cwd(), 'scripts/collab-preflight.sh'), 'utf8')
const LAUNCH = fs.readFileSync(path.resolve(process.cwd(), 'scripts/collab-launch.sh'), 'utf8')

// The default override lives in the configurable runtime root. Callers can set
// COLLAB_OVERRIDE_FILE when a separate location is needed. A direct preflight run
// keeps the shared default; the launcher gives preflight its own file per launch.
describe('override', () => {
  it('collab-preflight.sh gebruikt overal de OVERRIDE_FILE-variabele, niet los het vaste pad', () => {
    const literal = PRE.match(/\/tmp\/collab-agents-override\.txt/g) || []
    expect(literal.length).toBe(0)
    expect(PRE).toMatch(/OVERRIDE_FILE="\$\{COLLAB_OVERRIDE_FILE:-\$\(collab_runtime_root\)\/collab-agents-override\.txt\}"/)
  })

  it('collab-launch.sh gebruikt een eigen overridebestand per launch en geeft het expliciet aan preflight', () => {
    // Het gedeelde pad liet twee gelijktijdige launches elkaars agentkeuze wissen.
    const literal = LAUNCH.match(/\/tmp\/collab-agents-override\.txt/g) || []
    expect(literal.length).toBe(0)
    expect(LAUNCH).not.toMatch(/\$\(collab_runtime_root\)\/collab-agents-override\.txt/)
    expect(LAUNCH).toMatch(/OVERRIDE_FILE="\$\(collab_runtime_root\)\/collab-agents-override\.\$\$\.txt"/)
    expect(LAUNCH).toMatch(/COLLAB_OVERRIDE_FILE="\$OVERRIDE_FILE" COLLAB_AGENTS_SOURCE=/)
  })
})
