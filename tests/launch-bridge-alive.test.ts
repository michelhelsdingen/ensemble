import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

const SRC = fs.readFileSync(path.resolve(process.cwd(), 'scripts/collab-launch.sh'), 'utf8')

describe('bridge-start', () => {
  it('controleert met kill -0 of het proces nog leeft voor het vinkje', () => {
    // Anker op de regel die de bridge echt start, niet op de eerste vermelding
    // van de scriptnaam: die staat sinds 04-11-2026 ook in de hulptekst bij een
    // gestopte bridge, en dan sneed deze test het verkeerde stuk uit.
    const start = SRC.indexOf('nohup "$SCRIPT_DIR/ensemble-bridge.sh"')
    expect(start).toBeGreaterThan(-1)
    const blok = SRC.slice(start, start + 700)
    expect(blok).toMatch(/kill -0/)
  })
})
