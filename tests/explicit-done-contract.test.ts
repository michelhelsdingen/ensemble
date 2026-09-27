import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrainEvent } from '../lib/brain-hooks'

let root: string
let service: typeof import('../services/ensemble-service')
let registry: typeof import('../lib/ensemble-registry')
const events = vi.fn(async (_event: BrainEvent) => {})
const mocked = ['agent-runtime', 'agent-spawner', 'agent-watchdog', 'hosts-config', 'memory-export', 'brain-hooks']
beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'done-contract-'))
  vi.stubEnv('ENSEMBLE_DATA_DIR', root)
  vi.stubEnv('COLLAB_RUNTIME_ROOT', path.join(root, 'runtime'))
  vi.stubEnv('ENSEMBLE_CONFIG', path.join(root, 'missing'))
  vi.stubEnv('ENSEMBLE_MAX_TEAM_MINUTES', '')
  vi.stubEnv('ENSEMBLE_CREATED_BY', 'test')
  events.mockClear()
  vi.doMock('../lib/brain-hooks', () => ({ emitEvent: events, runPlan: vi.fn(), runRoster: vi.fn() }))
  vi.doMock('../lib/agent-watchdog', () => ({ AgentWatchdog: class { stop() {} } }))
  vi.doMock('../lib/agent-runtime', () => ({ getRuntime: () => ({ sessionExists: async () => false }) }))
  vi.doMock('../lib/agent-spawner', () => ({ spawnLocalAgent: vi.fn(), spawnRemoteAgent: vi.fn(), postRemoteSessionCommand: vi.fn(), isRemoteSessionReady: vi.fn(), killLocalAgent: vi.fn(), killRemoteAgent: vi.fn(), getAgentTokenUsage: async () => 'unknown' }))
  vi.doMock('../lib/hosts-config', () => ({ isSelf: () => true, getSelfHostId: () => 'local', getHostById: () => undefined }))
  vi.doMock('../lib/memory-export', () => ({ checkMemoryEndpoint: async () => ({ ok: true }), exportObservation: async () => ({ ok: true }) }))
  service = await import('../services/ensemble-service')
  registry = await import('../lib/ensemble-registry')
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  for (const name of mocked) vi.doUnmock(`../lib/${name}`)
  fs.rmSync(root, { recursive: true, force: true })
})
function team() {
  const created = registry.createTeam({ name: 'completion', description: 'Completion contract', agents: [{ program: 'codex' }, { program: 'mimo' }, { program: 'codex' }, { program: 'mimo' }] })
  registry.updateTeam(created.id, { status: 'active', agents: created.agents.map((a, i) => ({ ...a, status: i === 2 ? 'failed' : i === 3 ? 'replaced' : 'active' })) })
  return created
}
function say(teamId: string, from: string, content: string) {
  registry.appendMessage(teamId, { id: String(registry.getMessages(teamId).length), teamId, from, to: 'team', content, type: 'chat', timestamp: new Date().toISOString() })
}
function doneEvents() { return events.mock.calls.filter(([event]) => event.event === 'agent_done') }
it.each(['<<COLLAB_DONE>>', 'Tests complete. <<COLLAB_DONE>>', 'Conclusion\n<<COLLAB_DONE>>\n \t'])('recognizes terminal completion: %j', async content => {
  const t = team()
  say(t.id, t.agents[0].name, content)
  await service.checkIdleTeams()
  expect(doneEvents()).toHaveLength(1)
})
it.each(['Continue <<COLLAB_DONE>> working', '"send <<COLLAB_DONE>> when finished"', '`<<COLLAB_DONE>>`'])('ignores embedded and quoted markers: %j', async content => {
  const t = team()
  say(t.id, t.agents[0].name, content)
  await service.checkIdleTeams()
  expect(doneEvents()).toHaveLength(0)
})
it('deduplicates repeated markers and reopens even between polls', async () => {
  const t = team()
  say(t.id, t.agents[0].name, '<<COLLAB_DONE>>')
  await service.checkIdleTeams()
  for (let i = 0; i < 7; i++) {
    say(t.id, t.agents[0].name, '<<COLLAB_DONE>>')
    await service.checkIdleTeams()
  }
  expect(doneEvents()).toHaveLength(1)
  say(t.id, t.agents[0].name, 'Additional work')
  say(t.id, t.agents[0].name, '<<COLLAB_DONE>>')
  await service.checkIdleTeams()
  await service.checkIdleTeams()
  expect(doneEvents()).toHaveLength(2)
})
it('disbands immediately when every active agent last sent completion', async () => {
  const t = team()
  say(t.id, t.agents[0].name, 'Tests complete. <<COLLAB_DONE>>')
  say(t.id, t.agents[1].name, 'Review complete')
  say(t.id, t.agents[1].name, 'Conclusion\n<<COLLAB_DONE>>')
  await service.checkIdleTeams()
  expect(registry.getTeam(t.id)?.status).toBe('disbanded')
  expect(doneEvents()).toHaveLength(2)
  expect(events).toHaveBeenCalledWith(expect.objectContaining({ event: 'team_finished', status: 'ok' }))
})
it('keeps a team active when an agent resumes after its marker', async () => {
  const t = team()
  say(t.id, t.agents[0].name, '<<COLLAB_DONE>>')
  say(t.id, t.agents[0].name, 'I am investigating another case')
  say(t.id, t.agents[1].name, '<<COLLAB_DONE>>')
  await service.checkIdleTeams()
  expect(registry.getTeam(t.id)?.status).toBe('active')
})
