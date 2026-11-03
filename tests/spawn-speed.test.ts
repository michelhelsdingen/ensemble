/**
 * Opstarten mag geen vaste wachttijden bevatten.
 *
 * Gemeten 03-11-2026: een team met twee agents had 18 seconden nodig voor de
 * eerste regel "Team is live". Een deel daarvan waren blinde sleeps, niet werk:
 * spawnLocalAgent wachtte na het aanmaken van de tmux-sessie altijd 300ms voor
 * het startcommando, ook als die sessie na 20ms al bestond.
 */
import { afterEach, expect, it, vi } from 'vitest'
import { getRuntime, setRuntime, type AgentRuntime } from '../lib/agent-runtime'
import { spawnLocalAgent } from '../lib/agent-spawner'

const echt = getRuntime()
afterEach(() => {
  setRuntime(echt)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function nepRuntime(bestaatNa: number): { runtime: AgentRuntime; keys: string[]; checks: () => number } {
  let pogingen = 0
  const keys: string[] = []
  const runtime = {
    type: 'tmux',
    createSession: async () => {},
    sessionExists: async () => ++pogingen > bestaatNa,
    sendKeys: async (_name: string, value: string) => { keys.push(value) },
  } as unknown as AgentRuntime
  return { runtime, keys, checks: () => pogingen }
}

it('stuurt het startcommando zodra de sessie bestaat, niet na een vaste wachttijd', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const { runtime, keys } = nepRuntime(0)
  setRuntime(runtime)
  vi.useFakeTimers()
  const bezig = spawnLocalAgent({ name: 'snel-1', program: 'glm', workingDirectory: '/tmp', hostId: 'local' })
  await vi.advanceTimersByTimeAsync(60)
  expect(keys.length).toBe(1)
  await bezig
})

it('blijft wachten tot de sessie er echt is', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const { runtime, keys } = nepRuntime(4)
  setRuntime(runtime)
  vi.useFakeTimers()
  const bezig = spawnLocalAgent({ name: 'traag-1', program: 'glm', workingDirectory: '/tmp', hostId: 'local' })
  await vi.advanceTimersByTimeAsync(20)
  expect(keys.length).toBe(0)
  await vi.advanceTimersByTimeAsync(500)
  expect(keys.length).toBe(1)
  await bezig
})

it('stuurt het startcommando ook als de sessiecheck niets zinnigs zegt', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const keys: string[] = []
  setRuntime({
    type: 'tmux',
    createSession: async () => {},
    sessionExists: async () => { throw new Error('tmux weg') },
    sendKeys: async (_name: string, value: string) => { keys.push(value) },
  } as unknown as AgentRuntime)
  vi.useFakeTimers()
  const bezig = spawnLocalAgent({ name: 'stuk-1', program: 'glm', workingDirectory: '/tmp', hostId: 'local' })
  await vi.advanceTimersByTimeAsync(1500)
  expect(keys.length).toBe(1)
  await bezig
})
