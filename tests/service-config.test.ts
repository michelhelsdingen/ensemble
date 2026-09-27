import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { EnsembleMessage, EnsembleTeam } from '../types/ensemble'

let root: string
let current: EnsembleTeam | undefined
let messages: EnsembleMessage[]
let service: typeof import('../services/ensemble-service')
const paste = vi.fn(async () => {})
const kill = vi.fn(async () => {})
const start = Date.parse('2026-01-01T12:00:00Z')
beforeEach(async () => {
  root = fs.mkdtempSync(path.resolve('tmp/service-config-'))
  vi.stubEnv('COLLAB_RUNTIME_ROOT', root)
  vi.stubEnv('ENSEMBLE_CONFIG', path.join(root, 'config.json'))
  vi.stubEnv('ENSEMBLE_DATA_DIR', path.join(root, 'data'))
  vi.stubEnv('ENSEMBLE_MAX_TEAM_MINUTES', '10')
  vi.stubEnv('ENSEMBLE_GRACE_MINUTES', '3')
  vi.stubEnv('ALERT_HUB_SECRET', 'test-secret')
  vi.stubEnv('ENSEMBLE_ALERT_HUB_URL', '')
  vi.stubEnv('ENSEMBLE_TELEGRAM_BOT_TOKEN', '')
  vi.stubEnv('ENSEMBLE_TELEGRAM_CHAT_ID', '')
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }))
  vi.useFakeTimers()
  vi.setSystemTime(start)
  vi.resetModules()
  current = undefined
  messages = []
  paste.mockClear(); kill.mockClear()
  vi.doMock('../lib/ensemble-registry', () => ({
    loadTeams: () => current ? [current] : [], getTeam: () => current,
    getMessages: () => messages,
    appendMessage: (_id: string, message: EnsembleMessage) => messages.push(message),
    updateTeam: (_id: string, updates: Partial<EnsembleTeam>) => Object.assign(current!, updates),
    createTeam: vi.fn(), saveTeams: vi.fn(),
  }))
  vi.doMock('../lib/agent-spawner', () => ({
    spawnLocalAgent: vi.fn(), spawnRemoteAgent: vi.fn(), killLocalAgent: kill,
    killRemoteAgent: kill, getAgentTokenUsage: async () => 'unknown',
    postRemoteSessionCommand: vi.fn(), isRemoteSessionReady: vi.fn(),
  }))
  vi.doMock('../lib/agent-runtime', () => ({ getRuntime: () => ({ sessionExists: async () => true, pasteFromFile: paste }) }))
  vi.doMock('../lib/hosts-config', () => ({ isSelf: () => true, getSelfHostId: () => 'local', getHostById: vi.fn() }))
  vi.doMock('../lib/agent-watchdog', () => ({ AgentWatchdog: class { stop() {} } }))
  vi.doMock('../lib/memory-export', () => ({
    checkMemoryEndpoint: async () => ({ ok: true, endpoint: 'disabled-in-test' }),
    exportObservation: async () => ({ ok: true }),
  }))
  service = await import('../services/ensemble-service')
  current = {
    id: 'deadline-team', name: 'deadline-team', description: 'Inspect code', status: 'active',
    agents: ['alpha', 'beta'].map((name, i) => ({ agentId: name, name, program: 'codex', role: i ? 'member' : 'lead', status: 'active', hostId: 'local' })),
    createdBy: 'test', createdAt: new Date(start).toISOString(), feedMode: 'live',
  }
  messages.push({ id: 'first', teamId: current.id, from: 'alpha', to: 'team', content: 'Analysis in progress', type: 'chat', timestamp: new Date(start).toISOString() })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.resetModules()
  for (const name of ['ensemble-registry', 'agent-spawner', 'agent-runtime', 'hosts-config', 'agent-watchdog', 'memory-export']) vi.doUnmock(`../lib/${name}`)
  fs.rmSync(root, { recursive: true, force: true })
})
it('leaves teams unlimited by default', async () => {
  vi.stubEnv('ENSEMBLE_MAX_TEAM_MINUTES', '')
  vi.setSystemTime(start + 24 * 60 * 60_000)
  await service.checkIdleTeams()
  expect(messages).toHaveLength(1)
  expect(current!.status).toBe('active')
})
it('delivers one deadline warning to all active agents despite recent activity', async () => {
  vi.setSystemTime(start + 9 * 60_000)
  await service.checkIdleTeams()
  expect(messages).toHaveLength(1)
  vi.setSystemTime(start + 10 * 60_000)
  messages[0].timestamp = new Date().toISOString()
  await service.checkIdleTeams()
  await service.checkIdleTeams()
  expect(messages.filter(m => m.content.includes('<<COLLAB_DONE>>'))).toHaveLength(1)
  expect(paste.mock.calls).toHaveLength(2)
  expect(current!.status).toBe('active')
})
it('allows a full grace period after a late warning then writes the time-limit summary', async () => {
  vi.setSystemTime(start + 20 * 60_000)
  await service.checkIdleTeams()
  expect(current!.status).toBe('active')
  vi.setSystemTime(start + 23 * 60_000 - 1)
  await service.checkIdleTeams()
  expect(current!.status).toBe('active')
  vi.setSystemTime(start + 23 * 60_000)
  await service.checkIdleTeams()
  expect(current!.status).toBe('disbanded')
  expect(kill).toHaveBeenCalledTimes(2)
  expect(fs.readFileSync(path.join(root, current!.id, 'summary.txt'), 'utf8')).toContain('Reason: team stopped on time limit')
  expect(fs.existsSync(path.join(root, current!.id, '.finished'))).toBe(true)
})
it('supports zero grace and teams with no agent messages', async () => {
  vi.stubEnv('ENSEMBLE_GRACE_MINUTES', '0')
  messages = []
  vi.setSystemTime(start + 10 * 60_000)
  await service.checkIdleTeams()
  expect(current!.status).toBe('disbanded')
  expect(fs.readFileSync(path.join(root, current!.id, 'summary.txt'), 'utf8')).toContain('Reason: team stopped on time limit')
})
it.each([[[]], [['beta']], [['beta', 'gamma']]])('puts the preamble before the task for teammates %j', teammates => {
  vi.stubEnv('ENSEMBLE_TASK_PREAMBLE', 'Use project conventions.')
  const prompt = service.buildPromptPreview({ teamId: 'sample', teamName: 'sample', description: 'Inspect code', agentName: 'alpha', teammateNames: teammates, agentIndex: 0 })
  expect(prompt.indexOf('Use project conventions.')).toBeGreaterThan(-1)
  expect(prompt.indexOf('Use project conventions.')).toBeLessThan(prompt.indexOf('Task: Inspect code'))
})
it('requires new information and no outstanding questions, without an approval loop', () => {
  const prompt = service.buildPromptPreview({ teamId: 'sample', teamName: 'sample', description: 'Inspect code', agentName: 'alpha', teammateNames: ['beta'], agentIndex: 0 })
  expect(prompt).toContain('do not leave open questions addressed to you unresolved')
  expect(prompt).toContain('Do not send status messages without new information')
  expect(prompt).toContain('do not wait for an approval')
  expect(prompt).toContain('EXACTLY the sentinel <<COLLAB_DONE>>')
  expect(prompt).not.toContain('confirmed agreement')
})
it('preserves completion when another agent posts content before finishing', async () => {
  const post = (from: string, content: string, seconds: number) => messages.push({
    id: `review-${messages.length}`, teamId: current!.id, from, to: 'team', content,
    type: 'chat', timestamp: new Date(start + seconds * 1000).toISOString(),
  })
  post('alpha', 'Implementation and verification complete', 1)
  post('alpha', '<<COLLAB_DONE>>', 2)
  post('beta', 'The fallback still loses the selected agent. Please fix it.', 3)
  post('beta', '<<COLLAB_DONE>>', 4)
  vi.setSystemTime(start + 5_000)
  await service.checkIdleTeams()
  expect(current!.status).toBe('active')
  vi.setSystemTime(start + 64_000)
  await service.checkIdleTeams()
  expect(current!.status).toBe('disbanded')
})
it('accepts completion from all agents even at equal timestamps', async () => {
  messages.push(...[
    { from: 'alpha', content: '<<COLLAB_DONE>>' },
    { from: 'beta', content: 'Check the fallback result' },
    { from: 'beta', content: '<<COLLAB_DONE>>' },
  ].map((m, i) => ({ ...m, id: `same-${i}`, teamId: current!.id, to: 'team', type: 'chat' as const, timestamp: new Date(start + 1000).toISOString() })))
  vi.setSystemTime(start + 2000)
  await service.checkIdleTeams()
  expect(current!.status).toBe('active')
  vi.setSystemTime(start + 61_000)
  await service.checkIdleTeams()
  expect(current!.status).toBe('disbanded')
})
it('instructs agents to answer new content after a sentinel and send it again', () => {
  const prompt = service.buildPromptPreview({ teamId: 'sample', teamName: 'sample', description: 'Inspect code', agentName: 'alpha', teammateNames: ['beta'], agentIndex: 0 })
  expect(prompt).toContain('no unanswered teammate content or question after your last message')
  expect(prompt).toContain('about one minute from the last agent message to respond before the team closes')
  expect(prompt).toContain('If new teammate content arrives after your sentinel, respond substantively and send the sentinel again')
})
it('states the configured grace period in the deadline warning', async () => {
  vi.setSystemTime(start + 10 * 60_000)
  await service.checkIdleTeams()
  expect(messages.find(m => m.content.startsWith('Time is up:'))?.content).toContain('within 3 minutes')
})
it('restores the deadline warning and its grace start from the feed after restart', async () => {
  vi.setSystemTime(start + 10 * 60_000)
  await service.checkIdleTeams()
  vi.resetModules()
  service = await import('../services/ensemble-service')
  vi.setSystemTime(start + 12 * 60_000)
  await service.checkIdleTeams()
  expect(messages.filter(m => m.content.startsWith('Time is up:'))).toHaveLength(1)
  expect(paste).toHaveBeenCalledTimes(2)
  expect(current!.status).toBe('active')
  vi.setSystemTime(start + 13 * 60_000)
  await service.checkIdleTeams()
  expect(current!.status).toBe('disbanded')
})
it('makes the time limit the primary summary reason even when agents never posted', async () => {
  vi.stubEnv('ENSEMBLE_GRACE_MINUTES', '0')
  messages = []
  vi.setSystemTime(start + 10 * 60_000)
  await service.checkIdleTeams()
  const summary = fs.readFileSync(path.join(root, current!.id, 'summary.txt'), 'utf8')
  expect(summary).toContain('RUN STOPPED: team stopped on time limit')
  expect(summary).not.toContain('RUN FAILED: no agent ever posted a message')
  expect(summary).not.toContain('points at prompt delivery')
  expect(summary).toContain('Messages: 0')
})
it('ends an all-sentinel team after grace despite later system chatter', async () => {
  const post = (from: string, content: string, seconds: number) => messages.push({
    id: `idle-${messages.length}`, teamId: current!.id, from, to: 'team', content,
    type: 'chat', timestamp: new Date(start + seconds * 1000).toISOString(),
  })
  post('alpha', '<<COLLAB_DONE>>', 1)
  post('beta', 'Finished checking; waiting for alpha', 2)
  post('beta', '<<COLLAB_DONE>>', 3)
  post('ensemble', 'Watchdog status update', 4)
  vi.setSystemTime(start + 4_000)
  await service.checkIdleTeams()
  expect(current!.status).toBe('active')
  vi.setSystemTime(start + 63_000)
  await service.checkIdleTeams()
  expect(current!.status).toBe('disbanded')
})
it('closes immediately when only system messages follow all agent sentinels', async () => {
  const post = (from: string, content: string, seconds: number) => messages.push({
    id: `system-${messages.length}`, teamId: current!.id, from, to: 'team', content,
    type: 'chat', timestamp: new Date(start + seconds * 1000).toISOString(),
  })
  post('beta', 'Finished checking', 1)
  post('alpha', '<<COLLAB_DONE>>', 2)
  post('beta', '<<COLLAB_DONE>>', 3)
  post('ensemble', 'Watchdog status update', 4)
  post('system', 'System status update', 5)
  vi.setSystemTime(start + 5_000)
  await service.checkIdleTeams()
  expect(current!.status).toBe('disbanded')
})
it('stays open for an answer within grace and closes after a renewed sentinel', async () => {
  const post = (from: string, content: string, seconds: number) => messages.push({
    id: `answer-${messages.length}`, teamId: current!.id, from, to: 'team', content,
    type: 'chat', timestamp: new Date(start + seconds * 1000).toISOString(),
  })
  post('alpha', '<<COLLAB_DONE>>', 1)
  post('beta', 'Can you confirm the result?', 2)
  post('beta', '<<COLLAB_DONE>>', 3)
  vi.setSystemTime(start + 30_000)
  post('alpha', 'Yes, I confirmed the result.', 30)
  await service.checkIdleTeams()
  expect(current!.status).toBe('active')
  vi.setSystemTime(start + 63_000)
  await service.checkIdleTeams()
  expect(current!.status).toBe('active')
  post('alpha', '<<COLLAB_DONE>>', 64)
  vi.setSystemTime(start + 64_000)
  await service.checkIdleTeams()
  // Beta's marker predates alpha's answer, so beta gets the grace period to react.
  expect(current!.status).toBe('active')
  vi.setSystemTime(start + 124_000)
  await service.checkIdleTeams()
  expect(current!.status).toBe('disbanded')
})
it('does not use the idle sentinel fallback if an agent posts new content after its sentinel', async () => {
  messages.push(...[
    { from: 'alpha', content: '<<COLLAB_DONE>>' },
    { from: 'beta', content: 'Please check the result' },
    { from: 'beta', content: '<<COLLAB_DONE>>' },
    { from: 'alpha', content: 'Investigating a new issue' },
  ].map((m, i) => ({ ...m, id: `reopen-${i}`, teamId: current!.id, to: 'team', type: 'chat' as const, timestamp: new Date(start + (i + 1) * 1000).toISOString() })))
  vi.setSystemTime(start + 305_000)
  await service.checkIdleTeams()
  expect(current!.status).toBe('active')
})

it('sends no hub alert when its URL is unconfigured even with a secret', async () => {
  await service.disbandTeam(current!.id)
  expect(globalThis.fetch).not.toHaveBeenCalled()
})
it.each(['file', 'environment'])('uses the alert hub URL from %s when disbanding', async source => {
  if (source === 'file') {
    delete process.env.ENSEMBLE_ALERT_HUB_URL
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ alertHubUrl: 'https://alerts.example.test/ingest' }))
  } else {
    vi.stubEnv('ENSEMBLE_ALERT_HUB_URL', 'https://alerts.example.test/ingest')
  }
  await service.disbandTeam(current!.id)
  expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  const [url, options] = vi.mocked(globalThis.fetch).mock.calls[0]
  expect(String(url)).toBe('https://alerts.example.test/ingest?key=test-secret')
  expect(options?.method).toBe('POST')
  expect(JSON.parse(String(options?.body))).toMatchObject({ app: 'ensemble', dedup_key: 'collab-deadline-team' })
})
