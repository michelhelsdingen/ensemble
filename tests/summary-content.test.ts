/**
 * De teamsamenvatting verliest geen eindconclusie meer.
 *
 * Doorlichting 23-11-2026: per agent koos de samenvatting de drie langste
 * berichten en kapte elk af op 1200 tekens; in 5 van 6 gemeten runs waren alle
 * gekozen berichten van de niet-lead afgekapt. Nu staat de laatste inhoudelijke
 * bijdrage van elke agent volledig in de samenvatting (niet de
 * <<COLLAB_DONE>>-sentinel) en noemt elk afgekapt bericht het pad naar
 * messages.jsonl.
 */
import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { EnsembleMessage, EnsembleTeam } from '../types/ensemble'

let root: string
let current: EnsembleTeam | undefined
let messages: EnsembleMessage[]
let service: typeof import('../services/ensemble-service')

beforeEach(async () => {
  root = fs.mkdtempSync(path.resolve('tmp/summary-content-'))
  vi.stubEnv('COLLAB_RUNTIME_ROOT', root)
  vi.stubEnv('ENSEMBLE_CONFIG', path.join(root, 'config.json'))
  vi.stubEnv('ENSEMBLE_DATA_DIR', path.join(root, 'data'))
  vi.resetModules()
  messages = []
  vi.doMock('../lib/ensemble-registry', () => ({
    loadTeams: () => current ? [current] : [], getTeam: () => current, getMessages: () => messages,
    appendMessage: vi.fn(), updateTeam: vi.fn(), createTeam: vi.fn(), saveTeams: vi.fn(),
  }))
  vi.doMock('../lib/agent-spawner', () => ({
    spawnLocalAgent: vi.fn(), spawnRemoteAgent: vi.fn(), killLocalAgent: vi.fn(),
    killRemoteAgent: vi.fn(), getAgentTokenUsage: async () => 'unknown',
    postRemoteSessionCommand: vi.fn(), isRemoteSessionReady: vi.fn(),
  }))
  vi.doMock('../lib/agent-runtime', () => ({ getRuntime: () => ({ sessionExists: async () => true }) }))
  vi.doMock('../lib/hosts-config', () => ({ isSelf: () => true, getSelfHostId: () => 'local', getHostById: vi.fn() }))
  vi.doMock('../lib/agent-watchdog', () => ({ AgentWatchdog: class { stop() {} } }))
  vi.doMock('../lib/memory-export', () => ({
    checkMemoryEndpoint: async () => ({ ok: true, endpoint: 'disabled-in-test' }),
    exportObservation: async () => ({ ok: true }),
  }))
  service = await import('../services/ensemble-service')
  current = {
    id: 'summary-team', name: 'summary-team', description: 'Inspect code', status: 'active',
    agents: ['alpha', 'beta'].map((name, i) => ({ agentId: name, name, program: 'codex', role: i ? 'member' : 'lead', status: 'active', hostId: 'local' })),
    createdBy: 'test', createdAt: new Date(Date.now() - 60_000).toISOString(), feedMode: 'live',
  }
})
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules()
  for (const name of ['ensemble-registry', 'agent-spawner', 'agent-runtime', 'hosts-config', 'agent-watchdog', 'memory-export']) vi.doUnmock(`../lib/${name}`)
  fs.rmSync(root, { recursive: true, force: true })
})

const say = (from: string, content: string) =>
  messages.push({ id: `${messages.length}`, teamId: 'summary-team', from, to: 'team', content, type: 'chat', timestamp: new Date().toISOString() })
const read = () => fs.readFileSync(path.join(root, 'summary-team', 'summary.txt'), 'utf8')

it('neemt de laatste inhoudelijke bijdrage volledig op, zonder de sentinel', async () => {
  const transcript = path.join(root, 'summary-team', 'messages.jsonl')
  say('alpha', 'A'.repeat(3000))
  say('alpha', 'B'.repeat(2500))
  say('alpha', 'C'.repeat(2200))
  const conclusie = `Conclusie: ${'Z'.repeat(1800)}`
  say('alpha', conclusie)
  say('alpha', '<<COLLAB_DONE>>')
  say('beta', 'kort bericht')
  await service.writeDisbandSummary('summary-team')
  const summary = read()
  expect(summary).toContain(conclusie)
  expect(summary).toContain('Last contribution (full):')
  expect(summary).not.toMatch(/Last contribution \(full\):\n {4}<<COLLAB_DONE>>/)
  // Een afgekapt bericht zegt dat, met het pad naar het volledige bericht.
  expect(summary).toContain(`[afgekapt, volledig in ${transcript}]`)
})

it('markeert een bericht dat niet is afgekapt ook niet als afgekapt', async () => {
  say('alpha', 'Een korte conclusie.')
  say('beta', 'Nog een korte conclusie.')
  await service.writeDisbandSummary('summary-team')
  expect(read()).not.toContain('afgekapt')
})

it('valt terug op het laatste bericht als geen enkel bericht lang genoeg is', async () => {
  say('alpha', 'eerste')
  say('alpha', 'laatste woord')
  await service.writeDisbandSummary('summary-team')
  expect(read()).toMatch(/Last contribution \(full\):\n {4}laatste woord/)
})
