import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrainEvent } from '../lib/brain-hooks'
import type { AgentWatchdog } from '../lib/agent-watchdog'

let root: string
let registry: typeof import('../lib/ensemble-registry')
let replace: typeof import('../lib/agent-replacement')['replaceTeamAgent']
let watchdog: AgentWatchdog | undefined
let now: number
const roster = vi.fn()
const health = vi.fn()
const emit = vi.fn(async (_event: BrainEvent) => {})
const spawn = vi.fn(async (_options: { name: string; program: string; workingDirectory: string }) => ({ id: 'replacement-id' }))
const kill = vi.fn(async (_name: string) => {})
const paste = vi.fn(async (_session: string, _file: string) => {})
const ready = vi.fn(async () => true)
let teamId: string
beforeEach(async () => {
  vi.resetModules()
  root = fs.mkdtempSync(path.resolve('tmp/replacement-'))
  vi.stubEnv('ENSEMBLE_DATA_DIR', path.join(root, 'data'))
  vi.stubEnv('ENSEMBLE_CONFIG', path.join(root, 'config.json'))
  vi.stubEnv('COLLAB_RUNTIME_ROOT', path.join(root, 'runtime'))
  vi.stubEnv('ENSEMBLE_AGENTS_CONFIG', path.resolve('agents.json'))
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ replaceStalledAgents: true, maxReplacementsPerTeam: 2, fallbackOrder: ['invalid', 'codex', 'glm', 'mimo', 'gemini'] }))
  roster.mockReset().mockResolvedValue({ glm: { status: 'limit' }, mimo: { status: 'ok' }, gemini: { status: 'ok' } })
  health.mockReset().mockResolvedValue({ warnings: [] })
  emit.mockClear(); spawn.mockClear(); kill.mockClear(); paste.mockClear(); ready.mockReset().mockResolvedValue(true)
  vi.doMock('../lib/brain-hooks', () => ({ runRoster: roster, emitEvent: emit }))
  vi.doMock('../lib/agent-health', () => ({ checkAgentHealth: health }))
  vi.doMock('../lib/agent-spawner', () => ({ spawnLocalAgent: spawn, killLocalAgent: kill, spawnRemoteAgent: vi.fn(), killRemoteAgent: vi.fn(), postRemoteSessionCommand: vi.fn() }))
  vi.doMock('../lib/agent-runtime', () => ({ getRuntime: () => ({ pasteFromFile: paste, sendKeys: vi.fn(async () => {}) }) }))
  vi.doMock('../lib/hosts-config', () => ({ isSelf: () => true, getHostById: vi.fn() }))
  registry = await import('../lib/ensemble-registry')
  replace = (await import('../lib/agent-replacement')).replaceTeamAgent
  const team = registry.createTeam({ name: 'replacement', description: 'Original task', agents: [{ program: 'codex', role: 'reviewer' }], workingDirectory: root, worktree: 'team' })
  teamId = team.id
  team.agents[0].status = 'active'
  team.agents[0].hostId = 'local'
  registry.updateTeam(teamId, { status: 'active', agents: team.agents, worktreePath: path.join(root, 'shared'), worktreeBranch: 'ensemble/example' })
  now = Date.now()
})
afterEach(() => {
  watchdog?.stop(); watchdog = undefined
  vi.unstubAllEnvs(); vi.restoreAllMocks()
  for (const module of ['brain-hooks', 'agent-health', 'agent-spawner', 'agent-runtime', 'hosts-config']) vi.doUnmock(`../lib/${module}`)
  fs.rmSync(root, { recursive: true, force: true })
})
async function watch(exists: boolean) {
  const { AgentWatchdog } = await import('../lib/agent-watchdog')
  watchdog = new AgentWatchdog({
    loadTeams: registry.loadTeams, getMessages: registry.getMessages, appendMessage: registry.appendMessage,
    markAgentFailed: registry.markAgentFailed, replacementEnabled: () => true, sessionExists: async () => exists,
    replaceAgent: (team, agent, detail) => replace(team.id, agent.name, detail, ready),
    onAgentStalled: (team, agent, detail) => { void emit({ event: 'agent_stalled', teamId: team.id, team: team.name, agent: agent.name, detail, ts: new Date(now).toISOString() }) },
    getRuntime: () => ({ pasteFromFile: paste, sendKeys: vi.fn(async () => {}) }),
    resolveAgentProgram: () => ({ inputMethod: 'pasteFromFile' }), isSelf: () => true,
    getHostById: () => undefined, postRemoteSessionCommand: vi.fn(),
    collabDeliveryFile: () => path.join(root, 'nudge'), now: () => now, nudgeAfterMs: 100, stallAfterMs: 100,
  })
  return watchdog
}
it('replaces a vanished session on its first poll, keeps role and cwd, and emits events', async () => {
  await (await watch(false)).poll()
  const team = registry.getTeam(teamId)!
  expect(team.agents.map(a => [a.program, a.status, a.role])).toEqual([['codex', 'replaced', 'reviewer'], ['mimo', 'active', 'reviewer']])
  expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ program: 'mimo', workingDirectory: path.join(root, 'shared') }))
  expect(kill).toHaveBeenCalledWith('replacement-codex-1')
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ event: 'agent_stalled', agent: 'codex-1' }))
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ event: 'agent_replaced', agent: 'codex-1', replacement: 'mimo-2' }))
  expect(registry.getMessages(teamId).some(m => m.content.includes('Replaced codex-1'))).toBe(true)
})
it('replaces after a successful nudge followed by a stall', async () => {
  const w = await watch(true)
  now += 200
  await w.poll()
  expect(spawn).not.toHaveBeenCalled()
  now += 200
  await w.poll()
  expect(spawn).toHaveBeenCalledOnce()
})
it('includes the original task and bounded recent messages', async () => {
  for (let i = 0; i < 25; i++) registry.appendMessage(teamId, { id: `m-${i}`, teamId, from: 'codex-1', to: 'team', type: 'chat', timestamp: new Date(now + i).toISOString(), content: `marker-${i} ${'x'.repeat(1000)}` })
  expect(await replace(teamId, 'codex-1', 'gone', ready)).toBe(true)
  const prompt = fs.readFileSync(paste.mock.calls[0][1], 'utf8')
  expect(prompt).toContain('Original task')
  expect(prompt).toContain('marker-24')
  expect(prompt).not.toContain('marker-0 ')
  expect(Buffer.byteLength(prompt)).toBeLessThan(10_000)
})
it('vervangt niemand als de agents bij naam zijn gevraagd', async () => {
  // 03-11-2026: er werd gestart met "codex,claude" en er draaiden vier agents.
  // De launcher deed het goed; de service spawnde er vier minuten later agy en
  // glm bij, en glm meldde zich als "vervangt claude-2". Wie zijn ploeg zelf
  // samenstelt, krijgt een ander model er niet stil bij.
  registry.updateTeam(teamId, { agentsExplicit: true })
  await (await watch(false)).poll()
  expect(spawn).not.toHaveBeenCalled()
  const team = registry.getTeam(teamId)!
  expect(team.agents).toHaveLength(1)
  expect(team.agents[0].status).toBe('failed')
  expect(registry.getMessages(teamId).some(m => /you named the agents yourself/i.test(m.content))).toBe(true)
})
it('marks failed when the replacement budget is exhausted', async () => {
  registry.updateTeam(teamId, { replacementCount: 2 })
  await (await watch(false)).poll()
  expect(spawn).not.toHaveBeenCalled()
  expect(registry.getTeam(teamId)!.agents[0].status).toBe('failed')
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ event: 'agent_failed' }))
})
it('falls back to health only when roster is unavailable, and then to no check', async () => {
  roster.mockResolvedValue(undefined)
  health.mockResolvedValue({ healthy: ['gemini'], warnings: [] })
  expect(await replace(teamId, 'codex-1', 'gone', ready)).toBe(true)
  expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ program: 'gemini' }))
  health.mockResolvedValue({ warnings: ['hook unavailable'] })
  expect(await replace(teamId, 'gemini-2', 'gone again', ready)).toBe(true)
  expect(spawn).toHaveBeenLastCalledWith(expect.objectContaining({ program: 'glm' }))
})
it('does not bypass a valid roster with no healthy candidate', async () => {
  roster.mockResolvedValue({ mimo: { status: 'unknown' }, glm: { status: 'slow' } })
  expect(await replace(teamId, 'codex-1', 'gone', ready)).toBe(false)
  expect(health).not.toHaveBeenCalled()
  expect(spawn).not.toHaveBeenCalled()
})
it('cleans up a replacement that cannot become ready', async () => {
  ready.mockResolvedValue(false)
  await (await watch(false)).poll()
  expect(kill).toHaveBeenCalledWith('replacement-mimo-2')
  expect(registry.getTeam(teamId)!.agents[0].status).toBe('failed')
})
it('does not leave a new session behind when disband begins during readiness', async () => {
  const { stopTeamReplacements } = await import('../lib/agent-replacement')
  ready.mockImplementation(async () => { stopTeamReplacements(teamId); return true })
  expect(await replace(teamId, 'codex-1', 'gone', ready)).toBe(false)
  expect(kill).toHaveBeenCalledWith('replacement-mimo-2')
  expect(registry.getTeam(teamId)!.agents).toHaveLength(1)
})
