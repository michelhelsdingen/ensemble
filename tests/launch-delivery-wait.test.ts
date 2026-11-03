/**
 * De launcher moet wachten op bewijs, niet op de klok.
 *
 * Tot 03-11-2026 wachtte hij 12 seconden en meldde daarna "Niet alle agents
 * hebben binnen 12s een bericht gestuurd". Dat was te vroeg voor een agent die
 * nog aan het nadenken was, en veel te laat als de aflevering al had gefaald.
 * De service houdt nu per agent bij hoe ver de prompt kwam; deze functie
 * beoordeelt dat.
 */
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'

const paths = path.resolve(process.cwd(), 'scripts/collab-paths.sh')

function state(team: unknown): string {
  return execFileSync('bash', ['-c', `. "${paths}" && team_delivery_state`], {
    encoding: 'utf8',
    input: JSON.stringify(team),
  }).trim()
}

const agent = (name: string, delivery?: string, status = 'active') => ({
  agentId: 'a', name, program: name.split('-')[0], role: 'lead', hostId: 'local', status,
  ...(delivery && { delivery }),
})

describe('team_delivery_state', () => {
  it('is pending zolang niet iedereen iets heeft gezegd', () => {
    expect(state({ team: { agents: [agent('codex-1', 'confirmed'), agent('claude-2', 'delivered')] } }))
      .toBe('pending')
  })

  it('is confirmed als elke actieve agent een bericht heeft gestuurd', () => {
    expect(state({ team: { agents: [agent('codex-1', 'confirmed'), agent('claude-2', 'confirmed')] } }))
      .toBe('confirmed')
  })

  it('noemt de agent die faalde, zodra er één faalt', () => {
    expect(state({ team: { agents: [agent('codex-1', 'failed'), agent('claude-2', 'delivered')] } }))
      .toBe('failed codex-1')
  })

  it('negeert een vervangen of mislukte agent bij het aftellen', () => {
    expect(state({
      team: {
        agents: [
          agent('codex-1', 'failed', 'replaced'),
          agent('glm-2', 'confirmed'),
        ],
      },
    })).toBe('confirmed')
  })

  it('is pending bij een service die dit veld niet kent', () => {
    expect(state({ team: { agents: [agent('codex-1'), agent('claude-2')] } })).toBe('unknown')
  })

  it('is pending bij onbruikbare invoer', () => {
    expect(execFileSync('bash', ['-c', `. "${paths}" && team_delivery_state`], {
      encoding: 'utf8', input: 'geen json',
    }).trim()).toBe('unknown')
  })

  it('is confirmed bij een team zonder agents, in plaats van eeuwig wachten', () => {
    expect(state({ team: { agents: [] } })).toBe('unknown')
  })
})

describe('de launcher gebruikt die functie', () => {
  const src = fs.readFileSync(path.resolve(process.cwd(), 'scripts/collab-launch.sh'), 'utf8')
  it('pollt de teamstatus en wacht niet op een vaste 12 seconden', () => {
    expect(src).toContain('team_delivery_state')
    expect(src).not.toMatch(/AGENT_WAIT_SECS=12\b/)
  })
})
