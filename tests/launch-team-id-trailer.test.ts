/**
 * Elke uitgang van collab-launch.sh moet het team-id afdrukken.
 *
 * De collab-skill en scripts/cleanroom-test.sh lezen het id van de laatste
 * TEAM_ID=-regel uit de stdout van de launcher. Toen de launcher bij een team
 * zonder bewijs vroegtijdig ging afsluiten, verdween die regel uit precies het
 * pad waarin je hem het hardst nodig hebt: zonder id kan niemand
 * collab-rescue.sh draaien, wat de foutmelding zelf aanraadt.
 */
import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

const PAD = path.resolve(process.cwd(), 'scripts/collab-launch.sh')
const REGELS = fs.readFileSync(PAD, 'utf8').split('\n')

describe('team-id trailer', () => {
  it('elke uitgang na het aanmaken van het team drukt het team-id af', () => {
    // Exits vóór de POST tellen niet: daar bestaat het team nog niet. Het anker
    // is de eerste regel ná de controle of er wel een team-id in het antwoord
    // stond: de twee exits van die controle horen er juist niet bij, want dan
    // is er geen team om een trailer over te schrijven.
    const teamOntstaat = REGELS.findIndex(r => /^RUNTIME_DIR="\$\(collab_runtime_dir/.test(r))
    expect(teamOntstaat, 'regel waar TEAM_ID ontstaat niet gevonden').toBeGreaterThan(-1)

    const zonderTrailer: string[] = []
    REGELS.forEach((regel, i) => {
      if (i < teamOntstaat) return
      if (!/^\s*exit [1-9]\d*\s*$/.test(regel)) return
      // De regels erboven mogen commentaar of lege regels zijn.
      const eerder = REGELS.slice(Math.max(0, i - 4), i)
        .map(r => r.trim())
        .filter(r => r && !r.startsWith('#'))
      if (!eerder.some(r => r.includes('print_team_id_trailer'))) {
        zonderTrailer.push(`regel ${i + 1}: ${regel.trim()}`)
      }
    })
    expect(
      zonderTrailer,
      `deze uitgangen drukken geen TEAM_ID= af, waardoor de aanroeper het team niet kan redden:\n${zonderTrailer.join('\n')}`,
    ).toEqual([])
  })

  it('de helper drukt de regel af die de aanroepers verwachten', () => {
    const bron = REGELS.join('\n')
    expect(bron).toMatch(/print_team_id_trailer\(\)\s*\{[^}]*echo "TEAM_ID=\$TEAM_ID"/)
  })
})
