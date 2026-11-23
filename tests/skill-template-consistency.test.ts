/**
 * De skilltekst spreekt zichzelf niet meer tegen.
 *
 * Doorlichting 23-11-2026 noemde: wat postcheck doet (hij heft een team niet op),
 * wat een onbekende agentnaam doet (preflight exit 7, geen stille terugval op
 * claude) en welke exitcodes de launcher echt teruggeeft tegenover preflight
 * (alleen 7 en 9 komen ongewijzigd door). Deze test legt de tekst vast tegen de
 * scripts waar ze over gaat.
 */
import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

const skill = fs.readFileSync(path.resolve('skill/SKILL.md'), 'utf8')
const launch = fs.readFileSync(path.resolve('scripts/collab-launch.sh'), 'utf8')

describe('skill/SKILL.md', () => {
  it('zegt niet dat postcheck een team doodt of opheft', () => {
    expect(skill).not.toMatch(/kills the team/i)
    expect(skill).toMatch(/never ends a team/)
  })

  it('zegt niet dat een onbekende agentnaam stil terugvalt op claude', () => {
    expect(skill).not.toMatch(/falls back to `claude`/)
    expect(skill).not.toMatch(/silently spawns a second claude/)
    expect(skill).toMatch(/not an agent is an error: preflight stops with exit `7`/)
  })

  it('noemt als enige preflight-exits die de launcher ongewijzigd teruggeeft 7 en 9', () => {
    // De launcher geeft precies deze twee codes door; alle andere worden 1.
    expect(launch).toMatch(/7\|9\) exit "\$PREFLIGHT_EXIT"/)
    const rijen = [...skill.matchAll(/^\s*\| `(\d)` \|[^\n]*\| `(\d)` \|$/gm)].map(m => [m[1], m[2]])
    expect(rijen.length).toBe(9)
    for (const [preflight, launcher] of rijen) {
      expect(launcher, `preflight ${preflight}`).toBe(['7', '9'].includes(preflight) ? preflight : '1')
    }
  })

  it('heeft elke exitcode van de launcher in zijn tabel', () => {
    const exits = new Set([...launch.matchAll(/^\s*exit ([1-9])\s*$/gm)].map(m => m[1]))
    for (const code of exits) {
      expect(skill, `launcher exit ${code}`).toMatch(new RegExp(`^\\| \`${code}\` \\|`, 'm'))
    }
  })

  it('laat de AI direct starten en MONITOR_MODE, Plan en TEAM_ID uit de uitvoer lezen', () => {
    expect(skill).toContain('Start directly, do not pre-check')
    expect(skill).not.toContain('collab-monitor-mode.sh" "$(pwd)"')
    for (const needle of ["s/^MONITOR_MODE=//p", "s/^TEAM_ID=//p", "s/^Plan: //p"]) expect(skill).toContain(needle)
  })

  it('wacht met collab-wait.sh en start die opnieuw bij COLLAB_WAIT_TIMEOUT', () => {
    expect(skill).toContain('"$ES/collab-wait.sh" "$TEAM_ID"')
    expect(skill).toContain('COLLAB_WAIT_TIMEOUT')
    expect(skill).toMatch(/start the same command again/)
    expect(skill).not.toContain('sleep 8')
    expect(skill).not.toContain('timeout: 600000')
  })
})
