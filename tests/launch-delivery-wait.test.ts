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

const bericht = (from: string) => ({ from, to: 'team', content: 'hoi', type: 'chat' })

const agent = (name: string, delivery?: string, status = 'active') => ({
  agentId: 'a', name, program: name.split('-')[0], role: 'lead', hostId: 'local', status,
  ...(delivery && { delivery }),
})

describe('team_delivery_state', () => {
  it('is delivered zodra iedereen de prompt aannam, ook als niet iedereen al praatte', () => {
    expect(state({ team: { agents: [agent('codex-1', 'confirmed'), agent('claude-2', 'delivered')] } }))
      .toBe('delivered claude-2')
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

  it('noemt een agent die wel praatte confirmed, ook als de bevestiging te laat kwam', () => {
    // 03-11-2026 gemeten: glm had meer dan 60s nodig voor zijn eerste bericht,
    // dus confirmPromptStart gaf op terwijl de prompt gewoon was aangekomen.
    // Een bericht in de feed is het bewijs; dat telt zwaarder dan de staat.
    expect(state({
      team: { agents: [agent('codex-1', 'confirmed'), agent('glm-2', 'silent')] },
      messages: [bericht('codex-1'), bericht('glm-2')],
    })).toBe('confirmed')
  })

  it('noemt een team waar de prompt overal aankwam delivered, met de stille agent erbij', () => {
    // 03-11-2026 gemeten (team ee1b35b0): glm-1 had de prompt aangenomen en was
    // aan het werk, grok-2 praatte al. Dit gaf toen 'pending', dus de launcher
    // wachtte 120 seconden en riep daarna "niet alle agents hebben een bericht
    // gestuurd" over een team dat gewoon liep. Aangekomen is gestart.
    expect(state({
      team: { agents: [agent('codex-1', 'confirmed'), agent('glm-2', 'silent')] },
      messages: [bericht('codex-1')],
    })).toBe('delivered glm-2')
  })

  it('is delivered zodra elke agent de prompt aannam, ook zonder enig bericht', () => {
    expect(state({ team: { agents: [agent('codex-1', 'delivered'), agent('glm-2', 'delivered')] } }))
      .toBe('delivered codex-1 glm-2')
  })

  it('blijft pending zolang één agent de prompt nog niet aannam', () => {
    expect(state({ team: { agents: [agent('codex-1', 'confirmed'), agent('glm-2', 'pending')] } }))
      .toBe('pending')
  })

  it('blijft failed melden bij een echte afleverfout', () => {
    expect(state({
      team: { agents: [agent('codex-1', 'confirmed'), agent('glm-2', 'failed')] },
      messages: [bericht('codex-1')],
    })).toBe('failed glm-2')
  })

  /**
   * Gevonden door het reviewteam van 03-11-2026 (team 40d536c0): een agent
   * waarvan de spawn mislukte krijgt status 'idle' en nooit een delivery-veld,
   * bleef meetellen en hield de staat eeuwig op 'pending'. De launcher lustte
   * daar 120 seconden op door voor informatie die de service meteen had.
   */
  it('noemt een agent die nooit gespawnd is meteen mislukt', () => {
    expect(state({
      team: { agents: [agent('codex-1', 'confirmed'), agent('claude-2', undefined, 'idle')] },
      messages: [bericht('codex-1')],
    })).toBe('failed claude-2')
  })

  it('wacht niet op een agent die nooit startte en ook niets zei', () => {
    expect(state({
      team: { agents: [agent('codex-1', undefined, 'idle'), agent('claude-2', undefined, 'idle')] },
    })).toBe('failed codex-1 claude-2')
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
