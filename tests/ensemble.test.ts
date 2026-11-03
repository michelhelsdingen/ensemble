import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnsembleMessage, EnsembleTeam, StagedWorkflowConfig } from '../types/ensemble'
import type { AgentRuntime } from '../lib/agent-runtime'
import { __testing } from '../services/ensemble-service'

const TEAM_SAY_BIN = path.resolve(process.cwd(), 'scripts/team-say.sh')
const TMP_ENSEMBLE_DIR = path.resolve(process.cwd(), 'tmp/test-runtime')
const SCRIPT_ENV = { ...process.env, COLLAB_RUNTIME_ROOT: TMP_ENSEMBLE_DIR }

function makeMessage(overrides: Partial<EnsembleMessage> = {}): EnsembleMessage {
  return {
    id: overrides.id ?? `msg-${Math.random().toString(36).slice(2, 8)}`,
    teamId: overrides.teamId ?? 'team-1',
    from: overrides.from ?? 'agent-1',
    to: overrides.to ?? 'team',
    content: overrides.content ?? 'hello',
    type: overrides.type ?? 'chat',
    timestamp: overrides.timestamp ?? '2026-03-18T10:00:00.000Z',
  }
}

function makeTeam(overrides: Partial<EnsembleTeam> = {}): EnsembleTeam {
  return {
    id: overrides.id ?? 'team-1',
    name: overrides.name ?? 'test-team',
    description: overrides.description ?? 'test',
    status: overrides.status ?? 'active',
    agents: overrides.agents ?? [
      {
        agentId: 'agent-id-1',
        name: 'codex-1',
        program: 'codex',
        role: 'lead',
        hostId: 'local',
        status: 'active',
      },
      {
        agentId: 'agent-id-2',
        name: 'claude-2',
        program: 'claude',
        role: 'member',
        hostId: 'local',
        status: 'active',
      },
    ],
    createdBy: overrides.createdBy ?? 'test',
    createdAt: overrides.createdAt ?? '2026-03-18T10:00:00.000Z',
    completedAt: overrides.completedAt,
    feedMode: overrides.feedMode ?? 'live',
    result: overrides.result,
  }
}

/**
 * Chatter that carries no completion signal, used to clear
 * MIN_MESSAGES_BEFORE_AUTO_DISBAND so a test can exercise the idle/completion
 * logic itself. Timestamps land well before the messages a test cares about, so
 * the "last message" the idle check reads is still the test's own.
 */
function fillerMessages(count: number, teamId = 'team-1'): EnsembleMessage[] {
  return Array.from({ length: count }, (_, i) =>
    makeMessage({
      teamId,
      from: i % 2 === 0 ? 'codex-1' : 'claude-2',
      content: `analysis step ${i}`,
      timestamp: `2026-03-18T12:00:${String(i).padStart(2, '0')}.000Z`,
    }),
  )
}

/** A three-agent team, for checks that must not assume a pair. */
function makeTrioTeam(): EnsembleTeam {
  return makeTeam({
    agents: [
      { agentId: 'agent-id-1', name: 'codex-1', program: 'codex', role: 'lead', hostId: 'local', status: 'active' },
      { agentId: 'agent-id-2', name: 'claude-2', program: 'claude', role: 'member', hostId: 'local', status: 'active' },
      { agentId: 'agent-id-3', name: 'grok-3', program: 'grok', role: 'member', hostId: 'local', status: 'active' },
    ],
  })
}

function writeJsonl(filePath: string, messages: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, messages.map(m => JSON.stringify(m)).join('\n') + '\n')
}

// ─────────────────────────────────────────────────────
// 1. getMessages() — merge of dual message stores
// ─────────────────────────────────────────────────────
describe('getMessages() — dual store merge', () => {
  const originalDataDir = process.env.ENSEMBLE_DATA_DIR
  let tempRoot: string
  let teamId: string

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-registry-'))
    teamId = `team-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    process.env.ENSEMBLE_DATA_DIR = tempRoot
    vi.resetModules()
  })

  afterEach(() => {
    vi.resetModules()
    if (originalDataDir === undefined) {
      delete process.env.ENSEMBLE_DATA_DIR
    } else {
      process.env.ENSEMBLE_DATA_DIR = originalDataDir
    }
    fs.rmSync(tempRoot, { recursive: true, force: true })
    // Clean up any runtime files we created
    const tmpDir = path.join(TMP_ENSEMBLE_DIR, teamId)
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reads messages from feed.jsonl only', async () => {
    const feedDir = path.join(tempRoot, 'ensemble', 'messages', teamId)
    const msg = makeMessage({ id: 'feed-only', teamId, content: 'from feed' })
    writeJsonl(path.join(feedDir, 'feed.jsonl'), [msg])

    const { getMessages } = await import('../lib/ensemble-registry')
    const result = getMessages(teamId)

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('feed-only')
    expect(result[0].content).toBe('from feed')
  })

  it('reads messages from /tmp/ensemble/<teamId>/messages.jsonl only', async () => {
    const tmpFile = path.join(TMP_ENSEMBLE_DIR, teamId, 'messages.jsonl')
    const msg = makeMessage({ id: 'tmp-only', teamId, content: 'from tmp' })
    writeJsonl(tmpFile, [msg])

    const { getMessages } = await import('../lib/ensemble-registry')
    const result = getMessages(teamId)

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('tmp-only')
  })

  it('merges messages from both sources', async () => {
    const feedDir = path.join(tempRoot, 'ensemble', 'messages', teamId)
    writeJsonl(path.join(feedDir, 'feed.jsonl'), [
      makeMessage({ id: 'feed-msg', teamId, timestamp: '2026-01-01T10:00:00.000Z' }),
    ])
    writeJsonl(path.join(TMP_ENSEMBLE_DIR, teamId, 'messages.jsonl'), [
      makeMessage({ id: 'tmp-msg', teamId, timestamp: '2026-01-01T10:00:01.000Z' }),
    ])

    const { getMessages } = await import('../lib/ensemble-registry')
    const result = getMessages(teamId)

    expect(result).toHaveLength(2)
    expect(result.map(m => m.id)).toEqual(['feed-msg', 'tmp-msg'])
  })

  it('deduplicates messages with same id (feed.jsonl wins)', async () => {
    const sharedId = 'shared-id'
    const feedDir = path.join(tempRoot, 'ensemble', 'messages', teamId)
    writeJsonl(path.join(feedDir, 'feed.jsonl'), [
      makeMessage({ id: sharedId, teamId, content: 'from feed', timestamp: '2026-01-01T10:00:00.000Z' }),
    ])
    writeJsonl(path.join(TMP_ENSEMBLE_DIR, teamId, 'messages.jsonl'), [
      makeMessage({ id: sharedId, teamId, content: 'from tmp', timestamp: '2026-01-01T10:00:00.000Z' }),
    ])

    const { getMessages } = await import('../lib/ensemble-registry')
    const result = getMessages(teamId)

    const matching = result.filter(m => m.id === sharedId)
    expect(matching).toHaveLength(1)
    expect(matching[0].content).toBe('from feed')
  })

  it('sorts messages by timestamp ascending, missing timestamps last', async () => {
    const feedDir = path.join(tempRoot, 'ensemble', 'messages', teamId)
    writeJsonl(path.join(feedDir, 'feed.jsonl'), [
      makeMessage({ id: 'late', teamId, timestamp: '2026-01-01T12:00:00.000Z' }),
      makeMessage({ id: 'early', teamId, timestamp: '2026-01-01T10:00:00.000Z' }),
      makeMessage({ id: 'no-ts', teamId, timestamp: undefined as unknown as string }),
    ])

    const { getMessages } = await import('../lib/ensemble-registry')
    const result = getMessages(teamId)

    expect(result.map(m => m.id)).toEqual(['early', 'late', 'no-ts'])
  })

  it('filters by since parameter', async () => {
    const feedDir = path.join(tempRoot, 'ensemble', 'messages', teamId)
    writeJsonl(path.join(feedDir, 'feed.jsonl'), [
      makeMessage({ id: 'old', teamId, timestamp: '2026-01-01T10:00:00.000Z' }),
      makeMessage({ id: 'new', teamId, timestamp: '2026-01-01T12:00:00.000Z' }),
    ])

    const { getMessages } = await import('../lib/ensemble-registry')
    const result = getMessages(teamId, '2026-01-01T11:00:00.000Z')

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('new')
  })

  it('returns empty array when no files exist', async () => {
    const { getMessages } = await import('../lib/ensemble-registry')
    const result = getMessages('nonexistent-team-xyz')
    expect(result).toEqual([])
  })

  it('deduplicates by fallback key when id is missing', async () => {
    const feedDir = path.join(tempRoot, 'ensemble', 'messages', teamId)
    const ts = '2026-01-01T10:00:00.000Z'
    // Two messages with no id but same from+timestamp+content prefix → should dedupe
    const msg = { teamId, from: 'codex-1', to: 'team', content: 'same content here', type: 'chat', timestamp: ts }
    writeJsonl(path.join(feedDir, 'feed.jsonl'), [msg])
    writeJsonl(path.join(TMP_ENSEMBLE_DIR, teamId, 'messages.jsonl'), [msg])

    const { getMessages } = await import('../lib/ensemble-registry')
    const result = getMessages(teamId)

    // Should be deduplicated to 1 message
    const matching = result.filter(m => m.content === 'same content here')
    expect(matching).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────
// 2. shouldAutoDisband() — completion detection & idle
// ─────────────────────────────────────────────────────
describe('shouldAutoDisband() — tested via checkIdleTeams()', () => {
  const originalDataDir = process.env.ENSEMBLE_DATA_DIR
  let tempRoot: string

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-disband-'))
    process.env.ENSEMBLE_DATA_DIR = tempRoot
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-18T12:05:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.resetModules()
    vi.doUnmock('../lib/ensemble-registry')
    vi.doUnmock('../lib/agent-spawner')
    vi.doUnmock('../lib/hosts-config')
    vi.doUnmock('../lib/agent-runtime')
    vi.doUnmock('../lib/agent-config')
    if (originalDataDir === undefined) {
      delete process.env.ENSEMBLE_DATA_DIR
    } else {
      process.env.ENSEMBLE_DATA_DIR = originalDataDir
    }
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  async function setupServiceWithMocks(team: EnsembleTeam, messages: EnsembleMessage[]) {
    vi.resetModules()
    const appendedMessages: EnsembleMessage[] = []
    vi.doMock('../lib/ensemble-registry', () => ({
      getMessages: vi.fn(() => messages),
      loadTeams: vi.fn(() => [team]),
      appendMessage: vi.fn((_id: string, msg: EnsembleMessage) => appendedMessages.push(msg)),
      updateTeam: vi.fn((_id: string, updates: Partial<EnsembleTeam>) => ({ ...team, ...updates })),
      markAgentFailed: vi.fn((_id: string, agentName: string) => {
        const agent = team.agents.find(candidate => candidate.name === agentName)
        if (agent) agent.status = 'failed'
        return team
      }),
      setAgentDelivery: vi.fn(),
      createTeam: vi.fn(),
      getTeam: vi.fn(() => team),
      saveTeams: vi.fn(),
    }))
    vi.doMock('../lib/agent-spawner', () => ({
      spawnLocalAgent: vi.fn(),
      killLocalAgent: vi.fn(),
      spawnRemoteAgent: vi.fn(),
      killRemoteAgent: vi.fn(),
      postRemoteSessionCommand: vi.fn(),
      isRemoteSessionReady: vi.fn(),
      getAgentTokenUsage: vi.fn(async () => 'unknown'),
    }))
    vi.doMock('../lib/hosts-config', () => ({
      isSelf: vi.fn(() => true),
      getHostById: vi.fn(),
      getSelfHostId: vi.fn(() => 'local'),
    }))
    vi.doMock('../lib/agent-runtime', () => ({
      getRuntime: vi.fn(() => ({
        capturePane: vi.fn(),
        sendKeys: vi.fn(),
        pasteFromFile: vi.fn(),
      })),
    }))
    vi.doMock('../lib/agent-config', () => ({
      resolveAgentProgram: vi.fn(() => ({ readyMarker: '>', inputMethod: 'sendKeys' })),
      resolveAgentProgramDetailed: vi.fn((program: string) => ({
        agent: { command: program, readyMarker: '>', inputMethod: 'sendKeys' },
        how: 'exact',
        requested: program,
      })),
      availableAgentKeys: vi.fn(() => ['claude', 'codex']),
    }))

    const mod = await import('../services/ensemble-service')
    return { mod, appendedMessages }
  }

  it('continues idle checks after one team message store throws', async () => {
    const team = makeTeam({ createdAt: new Date().toISOString() })
    const messages = team.agents.map(agent => makeMessage({ from: agent.name, content: '<<COLLAB_DONE>>' }))
    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    const registry = await import('../lib/ensemble-registry')
    vi.mocked(registry.loadTeams).mockReturnValue([makeTeam({ id: 'broken-team' }), team])
    vi.mocked(registry.getMessages).mockImplementation(id => {
      if (id === 'broken-team') throw new Error('Unreadable message store')
      return messages
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await mod.checkIdleTeams()
    expect(appendedMessages.some(message => message.teamId === team.id && message.content.includes('Auto-disband'))).toBe(true)
    expect(registry.updateTeam).toHaveBeenCalledWith(team.id, expect.objectContaining({ status: 'disbanded' }))
  })

  it('does NOT auto-disband on completion wording while the agents are still talking', async () => {
    // Regression, 2026-08-11: a live trio was killed mid-task because two agents
    // used the word "klaar" — one about a sub-step, one in the closure proposal
    // the prompt itself asks for. Wording alone must never end a live session.
    const team = makeTrioTeam()
    const messages: EnsembleMessage[] = [
      ...fillerMessages(8),
      makeMessage({ from: 'claude-2', teamId: 'team-1', content: 'stap 4 (vergelijken) klaar, door naar stap 5', timestamp: '2026-03-18T12:04:40.000Z' }),
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: 'Ik denk dat we klaar zijn omdat alles overeenkomt — mee eens?', timestamp: '2026-03-18T12:04:55.000Z' }),
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    // grok-3 has not reported yet; the conversation is 5s old.
    expect(appendedMessages.some(m => m.content.includes('Auto-disband'))).toBe(false)
  })

  it('auto-disbands when two different agents send completion signals and the team went quiet', async () => {
    const team = makeTeam()
    const messages: EnsembleMessage[] = [
      ...fillerMessages(8),
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: 'Task is done', timestamp: '2026-03-18T11:59:00.000Z' }),
      makeMessage({ from: 'claude-2', teamId: 'team-1', content: 'Alles afgerond', timestamp: '2026-03-18T11:59:30.000Z' }),
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    expect(appendedMessages.some(m => m.content.includes('Auto-disband'))).toBe(true)
  })

  it('does NOT auto-disband when only one completion signal exists and the team just spoke', async () => {
    const team = makeTeam()
    const messages: EnsembleMessage[] = [
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: 'Task is done', timestamp: '2026-03-18T12:03:40.000Z' }),
      makeMessage({ from: 'claude-2', teamId: 'team-1', content: 'Still working', timestamp: '2026-03-18T12:03:50.000Z' }),
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    expect(appendedMessages.some(m => m.content.includes('Auto-disband'))).toBe(false)
  })

  it('auto-disbands when one completion signal exists and the team is idle beyond the single-signal threshold', async () => {
    const team = makeTeam()
    const messages: EnsembleMessage[] = [
      ...fillerMessages(8),
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: 'Task is done', timestamp: '2026-03-18T11:56:30.000Z' }),
      makeMessage({ from: 'claude-2', teamId: 'team-1', content: 'Still investigating', timestamp: '2026-03-18T11:56:40.000Z' }),
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    expect(appendedMessages.some(m => m.content.includes('Auto-disband'))).toBe(true)
  })

  it('does NOT auto-disband when agents have no completion signal', async () => {
    const team = makeTeam()
    const messages: EnsembleMessage[] = [
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: 'Still working on it', timestamp: '2026-03-18T12:03:40.000Z' }),
      makeMessage({ from: 'claude-2', teamId: 'team-1', content: 'Analyzing code', timestamp: '2026-03-18T12:03:50.000Z' }),
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    expect(appendedMessages.some(m => m.content.includes('Auto-disband'))).toBe(false)
  })

  it('does NOT auto-disband when last message has no timestamp', async () => {
    const team = makeTeam()
    const msgWithoutTs = makeMessage({ from: 'claude-2', teamId: 'team-1', content: 'Klaar' })
    // Explicitly delete timestamp to simulate missing field (can't use ?? with undefined)
    delete (msgWithoutTs as unknown as Record<string, unknown>).timestamp
    const messages: EnsembleMessage[] = [
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: 'Done', timestamp: '2026-03-18T12:03:40.000Z' }),
      msgWithoutTs,
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    // Messages without timestamp get sorted last, and NaN timestamp → return false
    expect(appendedMessages.some(m => m.content.includes('Auto-disband'))).toBe(false)
  })

  it('does NOT auto-disband when team has no active agents', async () => {
    const team = makeTeam({
      agents: [
        { agentId: 'a1', name: 'codex-1', program: 'codex', role: 'lead', hostId: 'local', status: 'idle' },
        { agentId: 'a2', name: 'claude-2', program: 'claude', role: 'member', hostId: 'local', status: 'idle' },
      ],
    })
    const messages: EnsembleMessage[] = [
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: 'Done', timestamp: '2026-03-18T12:03:40.000Z' }),
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    expect(appendedMessages.some(m => m.content.includes('Auto-disband'))).toBe(false)
  })

  it('does NOT auto-disband when signals come from the same agent only', async () => {
    const team = makeTeam()
    const messages: EnsembleMessage[] = [
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: 'Task is done', timestamp: '2026-03-18T12:04:00.000Z' }),
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: 'Alles afgerond', timestamp: '2026-03-18T12:04:30.000Z' }),
      makeMessage({ from: 'claude-2', teamId: 'team-1', content: 'Still working...', timestamp: '2026-03-18T12:04:45.000Z' }),
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    expect(appendedMessages.some(m => m.content.includes('Auto-disband'))).toBe(false)
  })

  it('does NOT auto-disband a trio when only two of three agents sent the sentinel', async () => {
    const team = makeTrioTeam()
    const messages: EnsembleMessage[] = [
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: '<<COLLAB_DONE>>', timestamp: '2026-03-18T12:04:40.000Z' }),
      makeMessage({ from: 'claude-2', teamId: 'team-1', content: '<<COLLAB_DONE>>', timestamp: '2026-03-18T12:04:50.000Z' }),
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    // grok-3 is still working — killing the team here loses its work.
    expect(appendedMessages.some(m => m.content.includes('Auto-disband'))).toBe(false)
  })

  it('auto-disbands a trio once all three agents sent the sentinel', async () => {
    const team = makeTrioTeam()
    const messages: EnsembleMessage[] = [
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: '<<COLLAB_DONE>>', timestamp: '2026-03-18T12:04:40.000Z' }),
      makeMessage({ from: 'claude-2', teamId: 'team-1', content: '<<COLLAB_DONE>>', timestamp: '2026-03-18T12:04:50.000Z' }),
      makeMessage({ from: 'grok-3', teamId: 'team-1', content: '<<COLLAB_DONE>>', timestamp: '2026-03-18T12:04:55.000Z' }),
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    expect(appendedMessages.some(m => m.content.includes('Auto-disband'))).toBe(true)
  })

  it('auto-disbands a solo agent on its exact sentinel without waiting or filler messages', async () => {
    const team = makeTeam()
    team.agents = [team.agents[1]]
    const { mod, appendedMessages } = await setupServiceWithMocks(team, [
      makeMessage({ from: 'claude-2', content: '<<COLLAB_DONE>>', timestamp: '2026-03-18T12:04:59.000Z' }),
    ])

    await mod.checkIdleTeams()

    expect(appendedMessages.some(m => m.content.includes('Auto-disband'))).toBe(true)
  })

  it('still auto-disbands a pair on the sentinel path', async () => {
    const team = makeTeam()
    const messages: EnsembleMessage[] = [
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: '<<COLLAB_DONE>>', timestamp: '2026-03-18T12:04:40.000Z' }),
      makeMessage({ from: 'claude-2', teamId: 'team-1', content: '<<COLLAB_DONE>>', timestamp: '2026-03-18T12:04:50.000Z' }),
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    expect(appendedMessages.some(m => m.content.includes('Auto-disband'))).toBe(true)
  })

  it('ignores ensemble messages when determining idle time', async () => {
    const team = makeTeam()
    const messages: EnsembleMessage[] = [
      ...fillerMessages(8),
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: 'Done', timestamp: '2026-03-18T11:56:30.000Z' }),
      makeMessage({ from: 'claude-2', teamId: 'team-1', content: 'Still working', timestamp: '2026-03-18T11:56:35.000Z' }),
      // Het ensemble-bericht is veel recenter: als dat als activiteit zou tellen,
      // lijkt het team net gesproken te hebben en disbandt het niet.
      makeMessage({ from: 'ensemble', teamId: 'team-1', content: 'Agent joined', timestamp: '2026-03-18T12:04:55.000Z' }),
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    expect(appendedMessages.some(m => m.content.includes('Auto-disband'))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────
// 3. Completion pattern matching (unit tests)
// ─────────────────────────────────────────────────────
describe('completion signal patterns', () => {
  const COMPLETION_PATTERNS = [
    /(?:^|[^\p{L}\p{N}_])afgerond(?:[^\p{L}\p{N}_]|$)/iu,
    /(?:^|[^\p{L}\p{N}_])done(?:[^\p{L}\p{N}_]|$)/iu,
    /(?:^|[^\p{L}\p{N}_])complete(?:d)?(?:[^\p{L}\p{N}_]|$)/iu,
    /(?:^|[^\p{L}\p{N}_])klaar(?:[^\p{L}\p{N}_]|$)/iu,
    /(?:^|\s)tot de volgende(?:\s|$)/i,
  ]

  function hasCompletionSignal(content: string): boolean {
    return COMPLETION_PATTERNS.some(p => p.test(content))
  }

  it.each([
    ['The task is done.', true],
    ['Work completed successfully', true],
    ['Task is complete', true],
    ['De taak is afgerond', true],
    ['Ik ben klaar met de analyse', true],
    ['Tot de volgende keer!', true],
    ['DONE', true],
    ['Klaar', true],
    ['Still working on the task', false],
    ['Analyzing the codebase now', false],
    ['abandoned', false],
    ['completion marker only', false],
    ['undone but still working', false],
    ['', false],
  ])('"%s" → %s', (content: string, expected: boolean) => {
    expect(hasCompletionSignal(content)).toBe(expected)
  })
})

// ─────────────────────────────────────────────────────
// 4. team-say — output format validation
// ─────────────────────────────────────────────────────
describe('team-say — output format', () => {
  let testTeamId: string
  let outputFile: string

  beforeEach(() => {
    testTeamId = `team-say-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    outputFile = path.join(TMP_ENSEMBLE_DIR, testTeamId, 'messages.jsonl')
    fs.mkdirSync(path.dirname(outputFile), { recursive: true })
  })

  afterEach(() => {
    // Remove the whole directory: team-say.sh also leaves a lock file, and a
    // directory with only that lock stayed behind in /tmp/ensemble per test run.
    fs.rmSync(path.dirname(outputFile), { recursive: true, force: true })
  })

  it('prints "Sent to <recipient>" on stdout', () => {
    const stdout = execFileSync(
      TEAM_SAY_BIN,
      [testTeamId, 'codex-1', 'claude-2', 'test message'],
      { encoding: 'utf-8' },
    ).trim()
    expect(stdout).toBe('Sent to claude-2')
  })

  it('writes valid JSONL to /tmp/ensemble/<teamId>/messages.jsonl', () => {
    execFileSync(TEAM_SAY_BIN, [testTeamId, 'codex-1', 'claude-2', 'hello'], { env: SCRIPT_ENV })
    expect(fs.existsSync(outputFile)).toBe(true)

    const line = fs.readFileSync(outputFile, 'utf-8').trim()
    expect(() => JSON.parse(line)).not.toThrow()
  })

  it('message contains all required EnsembleMessage fields', () => {
    execFileSync(TEAM_SAY_BIN, [testTeamId, 'codex-1', 'claude-2', 'field check'], { env: SCRIPT_ENV })
    const msg = JSON.parse(fs.readFileSync(outputFile, 'utf-8').trim())

    expect(msg).toMatchObject({
      teamId: testTeamId,
      from: 'codex-1',
      to: 'claude-2',
      content: 'field check',
      type: 'chat',
    })
    expect(msg.id).toEqual(expect.any(String))
    expect(msg.timestamp).toEqual(expect.any(String))
  })

  it('id is a valid UUID v4', () => {
    execFileSync(TEAM_SAY_BIN, [testTeamId, 'codex-1', 'claude-2', 'uuid test'], { env: SCRIPT_ENV })
    const msg = JSON.parse(fs.readFileSync(outputFile, 'utf-8').trim())
    const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    expect(msg.id).toMatch(uuidV4Regex)
  })

  it('timestamp is a valid, recent ISO 8601 string', () => {
    execFileSync(TEAM_SAY_BIN, [testTeamId, 'codex-1', 'claude-2', 'ts test'], { env: SCRIPT_ENV })
    const msg = JSON.parse(fs.readFileSync(outputFile, 'utf-8').trim())
    const parsed = new Date(msg.timestamp)
    expect(Number.isNaN(parsed.getTime())).toBe(false)
    expect(Date.now() - parsed.getTime()).toBeLessThan(10_000)
  })

  it('preserves multi-word content', () => {
    execFileSync(TEAM_SAY_BIN, [testTeamId, 'codex-1', 'claude-2', 'bericht met spaties'], { env: SCRIPT_ENV })
    const msg = JSON.parse(fs.readFileSync(outputFile, 'utf-8').trim())
    expect(msg.content).toBe('bericht met spaties')
  })

  it('handles special characters in message', () => {
    execFileSync(TEAM_SAY_BIN, [testTeamId, 'codex-1', 'claude-2', 'Hello "world" & <test>'], { env: SCRIPT_ENV })
    const msg = JSON.parse(fs.readFileSync(outputFile, 'utf-8').trim())
    expect(msg.content).toContain('"world"')
    expect(msg.content).toContain('&')
    expect(msg.content).toContain('<test>')
  })

  it('appends multiple messages with unique ids', () => {
    execFileSync(TEAM_SAY_BIN, [testTeamId, 'codex-1', 'claude-2', 'First'], { env: SCRIPT_ENV })
    execFileSync(TEAM_SAY_BIN, [testTeamId, 'codex-1', 'claude-2', 'Second'], { env: SCRIPT_ENV })

    const lines = fs.readFileSync(outputFile, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(2)

    const msg1 = JSON.parse(lines[0])
    const msg2 = JSON.parse(lines[1])
    expect(msg1.content).toBe('First')
    expect(msg2.content).toBe('Second')
    expect(msg1.id).not.toBe(msg2.id)
  })
})

// ─────────────────────────────────────────────────────
// 5. Collab templates — loading & prompt generation
// ─────────────────────────────────────────────────────
describe('collab templates', () => {
  const templatesPath = path.resolve(process.cwd(), 'collab-templates.json')

  it('collab-templates.json exists and is valid JSON', () => {
    expect(fs.existsSync(templatesPath)).toBe(true)
    const data = JSON.parse(fs.readFileSync(templatesPath, 'utf-8'))
    expect(data.templates).toBeDefined()
  })

  it('contains all 4 required templates', () => {
    const data = JSON.parse(fs.readFileSync(templatesPath, 'utf-8'))
    expect(Object.keys(data.templates)).toEqual(
      expect.arrayContaining(['review', 'implement', 'research', 'debug'])
    )
  })

  it.each(['review', 'implement', 'research', 'debug'])(
    'template "%s" has required fields',
    (templateName) => {
      const data = JSON.parse(fs.readFileSync(templatesPath, 'utf-8'))
      const template = data.templates[templateName]
      expect(template.name).toEqual(expect.any(String))
      expect(template.description).toEqual(expect.any(String))
      expect(template.suggestedTaskPrefix).toEqual(expect.any(String))
      expect(template.roles).toHaveLength(2)
      for (const role of template.roles) {
        expect(role.role).toEqual(expect.any(String))
        expect(role.focus).toEqual(expect.any(String))
      }
    }
  )

  it('each template has unique role names per template', () => {
    const data = JSON.parse(fs.readFileSync(templatesPath, 'utf-8'))
    for (const [, template] of Object.entries(data.templates) as [string, { roles: { role: string }[] }][]) {
      const roleNames = template.roles.map((r: { role: string }) => r.role)
      expect(new Set(roleNames).size).toBe(roleNames.length)
    }
  })
})

// ─────────────────────────────────────────────────────
// 6. Worktree isolation lifecycle
// ─────────────────────────────────────────────────────
describe('worktree isolation lifecycle', () => {
  let tempRoot: string

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-worktree-'))
    vi.resetModules()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  async function setupWorktreeService(team: EnsembleTeam) {
    const appendedMessages: EnsembleMessage[] = []
    const createTeam = vi.fn(() => team)
    const getTeam = vi.fn(() => team)
    const updateTeam = vi.fn((_id: string, updates: Partial<EnsembleTeam>) => {
      Object.assign(team, updates)
      return team
    })
    const markAgentFailed = vi.fn((_id: string, agentName: string) => {
      const agent = team.agents.find(candidate => candidate.name === agentName)
      if (agent) agent.status = 'failed'
      return team
    })
    const appendMessage = vi.fn((_id: string, message: EnsembleMessage) => appendedMessages.push(message))
    const spawnLocalAgent = vi.fn(async ({ name, program, workingDirectory, hostId }) => ({
      id: `${name}-id`,
      name,
      program,
      sessionName: name,
      workingDirectory,
      hostId,
    }))
    const spawnRemoteAgent = vi.fn(async () => ({ id: 'remote-agent-id' }))
    const killLocalAgent = vi.fn(async (_sessionName: string) => {})
    const killRemoteAgent = vi.fn(async () => {})
    const createWorktree = vi.fn(async (teamId: string, agentName: string, basePath: string) => ({
      path: path.join(basePath, '.worktrees', `${teamId}-${agentName}`),
      branch: `collab/${teamId}/${agentName}`,
      agentName,
    }))
    const mergeWorktree = vi.fn(async () => ({ success: true }))
    const destroyWorktree = vi.fn(async () => {})

    vi.doMock('../lib/ensemble-registry', () => ({
      createTeam,
      getTeam,
      updateTeam,
      loadTeams: vi.fn(() => []),
      appendMessage,
      getMessages: vi.fn(() => []),
      markAgentFailed,
      setAgentDelivery: vi.fn(),
    }))
    vi.doMock('../lib/agent-spawner', () => ({
      spawnLocalAgent,
      killLocalAgent,
      spawnRemoteAgent,
      killRemoteAgent,
      postRemoteSessionCommand: vi.fn(),
      isRemoteSessionReady: vi.fn(async () => true),
      getAgentTokenUsage: vi.fn(async () => 'unknown'),
    }))
    vi.doMock('../lib/worktree-manager', () => ({
      createWorktree,
      mergeWorktree,
      destroyWorktree,
      listTeamWorktrees: vi.fn(async () => []),
    }))
    vi.doMock('../lib/hosts-config', () => ({
      isSelf: vi.fn((hostId: string) => hostId === 'local'),
      getHostById: vi.fn((hostId: string) => {
        if (hostId === 'local') return { id: 'local', url: 'http://local.test' }
        if (hostId === 'remote-1') return { id: 'remote-1', url: 'http://remote.test' }
        return undefined
      }),
      getSelfHostId: vi.fn(() => 'local'),
    }))
    const runtime = {
      capturePane: vi.fn(async () => '>'),
      sendKeys: vi.fn<AgentRuntime['sendKeys']>(async () => {}),
      pasteFromFile: vi.fn(async (_session: string, _file: string) => {}),
      sessionExists: vi.fn(async () => true),
      listSessions: vi.fn<() => Promise<Array<{ name: string }>>>(async () => []),
    }
    vi.doMock('../lib/agent-runtime', () => ({ getRuntime: vi.fn(() => runtime) }))
    vi.doMock('../lib/agent-config', () => ({
      resolveAgentProgram: vi.fn(() => ({ readyMarker: '>', inputMethod: 'sendKeys' })),
      resolveAgentProgramDetailed: vi.fn((program: string) => ({
        agent: { command: program, readyMarker: '>', inputMethod: 'sendKeys' },
        how: 'exact',
        requested: program,
      })),
      availableAgentKeys: vi.fn(() => ['claude', 'codex']),
    }))
    vi.doMock('../lib/collab-paths', () => ({
      ensureCollabDirs: vi.fn(),
      collabPromptFile: vi.fn((teamId: string, agentName: string) => path.join(tempRoot, `${teamId}-${agentName}.prompt.txt`)),
      collabDeliveryFile: vi.fn((teamId: string, sessionName: string) => path.join(tempRoot, `${teamId}-${sessionName}.delivery.txt`)),
      collabSummaryFile: vi.fn((teamId: string) => path.join(tempRoot, `${teamId}.summary.txt`)),
      collabMessagesFile: vi.fn((teamId: string) => path.join(tempRoot, `${teamId}.messages.jsonl`)),
      collabRuntimeDir: vi.fn((teamId: string) => path.join(tempRoot, teamId)),
      collabFinishedMarker: vi.fn((teamId: string) => path.join(tempRoot, `${teamId}.finished`)),
      collabBridgePosted: vi.fn((teamId: string) => path.join(tempRoot, `${teamId}.posted`)),
      collabBridgeResult: vi.fn((teamId: string) => path.join(tempRoot, `${teamId}.result`)),
      collabSessionsFile: vi.fn((teamId: string) => path.join(tempRoot, `${teamId}.sessions`)),
    }))

    const mod = await import('../services/ensemble-service')
    return {
      mod,
      team,
      appendedMessages,
      mocks: {
        runtime,
        createTeam,
        getTeam,
        updateTeam,
        markAgentFailed,
        appendMessage,
        spawnLocalAgent,
        spawnRemoteAgent,
        killLocalAgent,
        killRemoteAgent,
        createWorktree,
        mergeWorktree,
        destroyWorktree,
      },
    }
  }

  it.each([false, true])('delivers a solo Claude prompt after readiness (staged=%s)', async (staged) => {
    vi.useFakeTimers()
    try {
      const team = makeTeam({ agents: [makeTeam().agents[1]] })
      const { mod, mocks } = await setupWorktreeService(team)
      const config = await import('../lib/agent-config')
      vi.mocked(config.resolveAgentProgram).mockReturnValue({ readyMarker: '>', inputMethod: 'pasteFromFile' } as ReturnType<typeof config.resolveAgentProgram>)
      mocks.runtime.capturePane.mockResolvedValueOnce('starting').mockResolvedValue('>')
      const creation = mod.createEnsembleTeam({
        name: team.name, description: team.description, agents: [{ program: 'claude' }], staged,
      })
      await vi.advanceTimersByTimeAsync(500)
      expect(mocks.runtime.pasteFromFile).not.toHaveBeenCalled()
      // Gereedheid moet READY_STABLE_MS aanhouden voor er geplakt wordt.
      await vi.advanceTimersByTimeAsync(12_000)
      expect((await creation).status).toBe(201)
      expect(mocks.runtime.capturePane).toHaveBeenCalledWith('test-team-claude-2', 50)
      expect(mocks.runtime.pasteFromFile).toHaveBeenCalledExactlyOnceWith(
        'test-team-claude-2', path.join(tempRoot, 'team-1-claude-2.prompt.txt'),
      )
      const prompt = fs.readFileSync(path.join(tempRoot, 'team-1-claude-2.prompt.txt'), 'utf-8')
      expect(prompt).toContain('Task: test')
      expect(prompt).toContain('Start NOW')
      expect(prompt).toContain('team-say.sh team-1 claude-2 team')
      expect(prompt).not.toMatch(/teammate|undefined|confirmed agreement|wait for|delegat/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never treats a bare shell as ready and sends no keys into it', async () => {
    // 26-09-2026: Claude closed on its trust dialog, the zsh prompt showed a
    // ❯ that matched the ready marker, and the prompt was typed as a command.
    vi.useFakeTimers()
    try {
      const team = makeTeam({ agents: [makeTeam().agents[1]] })
      const { mod, mocks, appendedMessages } = await setupWorktreeService(team)
      const runtime = mocks.runtime as typeof mocks.runtime & { getForegroundCommand: (s: string) => Promise<string> }
      runtime.getForegroundCommand = vi.fn(async () => 'zsh')
      mocks.runtime.capturePane.mockResolvedValue('Quick safety check:\n❯ No, exit\n  Yes, I trust this folder\n>')
      const creation = mod.createEnsembleTeam({
        name: team.name, description: team.description, agents: [{ program: 'claude' }],
      })
      await vi.advanceTimersByTimeAsync(20_000)
      expect((await creation).status).toBe(201)
      const gateKeys = mocks.runtime.sendKeys.mock.calls.filter(call => call[1] === 'Enter' || call[1] === 'Down')
      expect(gateKeys).toEqual([])
      expect(appendedMessages.some(m => /did not signal ready/.test(m.content))).toBe(true)
      for (const call of mocks.runtime.sendKeys.mock.calls) {
        if ((call[2] as { literal?: boolean } | undefined)?.literal) {
          expect(call[2]).toMatchObject({ agentInput: true })
        }
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports solo prompt delivery failures in the feed', async () => {
    vi.useFakeTimers()
    try {
      const team = makeTeam({ agents: [makeTeam().agents[0]] })
      const { mod, mocks, appendedMessages } = await setupWorktreeService(team)
      const error = new Error('pane unavailable')
      error.name = 'AgentNotRunningError'
      mocks.runtime.sendKeys.mockRejectedValue(error)
      const creation = mod.createEnsembleTeam({
        name: team.name, description: team.description, agents: [{ program: 'codex' }],
      })
      await vi.advanceTimersByTimeAsync(12_000)
      await creation
      expect(appendedMessages.some(m => m.content.includes('Delivery to codex-1 failed: pane unavailable'))).toBe(true)
      expect(team.agents[0].status).toBe('failed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('meldt een pane die niets aanneemt als afleverfout, niet als stille agent', async () => {
    // Een pane die na het afleveren stil blijft staan heeft de prompt niet
    // verwerkt. Die krijgt hem één keer opnieuw, en neemt hij hem dan nog niet
    // aan, dan is dat een echte afleverfout: de launcher mag daarover klagen.
    // Verschil met de test hieronder: daar verandert de pane wel, en dan is
    // zwijgen gewoon denktijd.
    vi.useFakeTimers()
    try {
      const team = makeTeam({ agents: [makeTeam().agents[0]] })
      const { mod, mocks, appendedMessages } = await setupWorktreeService(team)
      let afgeleverd = false
      mocks.runtime.sendKeys.mockImplementation(async () => { afgeleverd = true })
      mocks.runtime.capturePane.mockImplementation(async () => afgeleverd ? '> na' : '> voor')
      const creation = mod.createEnsembleTeam({
        name: team.name, description: team.description, agents: [{ program: 'codex' }],
      })
      await vi.advanceTimersByTimeAsync(90_000)
      await creation
      expect(mocks.runtime.sendKeys).toHaveBeenCalledTimes(2)
      expect(appendedMessages.some(message =>
        /codex-1 prompt verification failed/.test(message.content)
        && /the pane did not change/.test(message.content),
      )).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  }, 30_000)

  it('stuurt een werkende agent zijn prompt niet opnieuw', async () => {
    // Gemeten 03-11-2026 (team ee1b35b0): glm-1 had de prompt aangenomen en was
    // aan het werk, maar had na 20s nog niets gezegd, dus kreeg hij hem er nog
    // twee keer bovenop. Zijn eerste bericht kwam pas na 2m40s. Een pane die
    // verandert, is bezig; die laten we met rust.
    vi.useFakeTimers()
    try {
      const team = makeTeam({ agents: [makeTeam().agents[0]] })
      const { mod, mocks, appendedMessages } = await setupWorktreeService(team)
      let beeld = 0
      mocks.runtime.capturePane.mockImplementation(async () => `> regel ${beeld++}`)
      const creation = mod.createEnsembleTeam({
        name: team.name, description: team.description, agents: [{ program: 'codex' }],
      })
      await vi.advanceTimersByTimeAsync(200_000)
      await creation
      expect(mocks.runtime.sendKeys).toHaveBeenCalledTimes(1)
      expect(appendedMessages.some(message =>
        /codex-1 took the prompt but has not sent a message yet/.test(message.content),
      )).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  }, 30_000)

  it('zet een team op failed als geen enkele agent gespawnd kon worden', async () => {
    // Gevonden door het reviewteam van 03-11-2026 (team 40d536c0): als alle
    // spawns faalden zette de service het team toch op 'active' en gaf 201
    // terug, waarna Phase 2 en 3 werden overgeslagen. De launcher moest dan tot
    // zijn bovengrens wachten om te zien dat er niets draaide.
    const team = makeTeam({ agents: [makeTeam().agents[0]] })
    const { mod, mocks, appendedMessages } = await setupWorktreeService(team)
    mocks.spawnLocalAgent.mockRejectedValue(new Error('tmux weg'))
    await mod.createEnsembleTeam({
      name: team.name, description: team.description, agents: [{ program: 'codex' }],
    })
    expect(team.status).toBe('failed')
    expect(appendedMessages.some(message => /no agent could be started/i.test(message.content))).toBe(true)
  })

  it('marks an agent failed when normal team message delivery finds no agent', async () => {
    const team = makeTeam({ agents: [makeTeam().agents[0]] })
    const { mod, mocks } = await setupWorktreeService(team)
    const error = new Error('pane unavailable')
    error.name = 'AgentNotRunningError'
    mocks.runtime.pasteFromFile.mockRejectedValue(error)

    await mod.sendTeamMessage(team.id, 'team', 'continue')

    expect(team.agents[0].status).toBe('failed')
    expect(mocks.markAgentFailed).toHaveBeenCalledWith(team.id, 'codex-1')
  })

  it.each([undefined, 'implement'])('builds an independent solo prompt (template=%s)', async (templateName) => {
    const { buildPromptPreview } = await import('../services/ensemble-service')
    const prompt = buildPromptPreview({
      teamId: 'solo', teamName: 'solo', description: 'Fix the bug',
      agentName: 'claude-1', teammateNames: [], agentIndex: 0, templateName,
    })
    expect(prompt).toContain('Task: Fix the bug')
    expect(prompt).toContain('Start NOW')
    expect(prompt).toContain('team-say.sh solo claude-1 team')
    expect(prompt).toContain('<<COLLAB_DONE>>')
    expect(prompt).not.toMatch(/teammate|undefined|confirmed agreement|wait for|delegat/i)
  })

  // 20s: een echte teamstart wacht op stabiele gereedheid en bevestigt de
  // aflevering voordat hij klaar is.
  it('spawns local agents inside their worktree when useWorktrees=true', async () => {
    const team = makeTeam({
      id: 'team-worktree-create',
      name: 'team-worktree-create',
      agents: [
        {
          agentId: '',
          name: 'codex-1',
          program: 'codex',
          role: 'lead',
          hostId: '',
          status: 'spawning',
        },
      ],
    })
    const { mod, mocks } = await setupWorktreeService(team)

    await mod.createEnsembleTeam({
      name: team.name,
      description: team.description,
      agents: [{ program: 'codex' }],
      workingDirectory: '/repo',
      useWorktrees: true,
    })

    expect(mocks.createWorktree).toHaveBeenCalledWith(team.id, 'codex-1', '/repo')
    expect(mocks.spawnLocalAgent).toHaveBeenCalledWith(expect.objectContaining({
      workingDirectory: '/repo/.worktrees/team-worktree-create-codex-1',
    }))
  }, 20_000)

  // 20s: een echte teamstart wacht op stabiele gereedheid en bevestigt de
  // aflevering voordat hij klaar is.
  it('does not create worktrees when useWorktrees=false', async () => {
    const team = makeTeam({
      id: 'team-worktree-disabled',
      name: 'team-worktree-disabled',
      agents: [
        {
          agentId: '',
          name: 'codex-1',
          program: 'codex',
          role: 'lead',
          hostId: '',
          status: 'spawning',
        },
      ],
    })
    const { mod, mocks } = await setupWorktreeService(team)

    await mod.createEnsembleTeam({
      name: team.name,
      description: team.description,
      agents: [{ program: 'codex' }],
      workingDirectory: '/repo',
      useWorktrees: false,
    })

    expect(mocks.createWorktree).not.toHaveBeenCalled()
    expect(mocks.spawnLocalAgent).toHaveBeenCalledWith(expect.objectContaining({
      workingDirectory: '/repo',
    }))
  }, 20_000)

  it('kills the local session before merging and destroying its worktree', async () => {
    const team = makeTeam({
      id: 'team-worktree-disband',
      name: 'team-worktree-disband',
      agents: [
        {
          agentId: 'agent-1',
          name: 'codex-1',
          program: 'codex',
          role: 'lead',
          hostId: 'local',
          status: 'active',
          worktreePath: '/repo/.worktrees/team-worktree-disband-codex-1',
          worktreeBranch: 'collab/team-worktree-disband/codex-1',
        },
      ],
    })
    const { mod, mocks } = await setupWorktreeService(team)

    await mod.disbandTeam(team.id)

    expect(mocks.mergeWorktree).toHaveBeenCalledWith({
      path: '/repo/.worktrees/team-worktree-disband-codex-1',
      branch: 'collab/team-worktree-disband/codex-1',
      agentName: 'codex-1',
    }, '/repo')
    expect(mocks.destroyWorktree).toHaveBeenCalledWith({
      path: '/repo/.worktrees/team-worktree-disband-codex-1',
      branch: 'collab/team-worktree-disband/codex-1',
      agentName: 'codex-1',
    }, '/repo')
    expect(mocks.killLocalAgent.mock.invocationCallOrder[0]).toBeLessThan(mocks.mergeWorktree.mock.invocationCallOrder[0])
    expect(mocks.mergeWorktree.mock.invocationCallOrder[0]).toBeLessThan(mocks.destroyWorktree.mock.invocationCallOrder[0])
  })

  it('ruimt bij disband elke sessie van dit team op, ook die niet actief heet', async () => {
    // 03-11-2026: de opruiming las het sessieregister zoals het er op dat
    // moment stond. De service spawnde er daarna nog twee bij, en die draaiden
    // uren later nog. Een agent die als failed in het register staat werd ook
    // nooit gekilld, want disband keek alleen naar status 'active'.
    const team = makeTeam({ id: 'team-prefix-sweep', name: 'team-prefix-sweep' })
    team.agents[0].status = 'failed'
    const { mod, mocks } = await setupWorktreeService(team)
    mocks.runtime.listSessions.mockResolvedValue([
      { name: 'team-prefix-sweep-codex-1' },
      { name: 'team-prefix-sweep-claude-2' },
      { name: 'team-prefix-sweep-glm-4' },
      { name: 'een-ander-team-codex-1' },
      { name: 'ensemble-team-prefix-sweep' },
    ])

    await mod.disbandTeam(team.id)

    const gedood = mocks.killLocalAgent.mock.calls.map(call => call[0])
    expect(gedood).toContain('team-prefix-sweep-codex-1')
    expect(gedood).toContain('team-prefix-sweep-claude-2')
    expect(gedood).toContain('team-prefix-sweep-glm-4')
    expect(gedood).not.toContain('een-ander-team-codex-1')
    expect(gedood).not.toContain('ensemble-team-prefix-sweep')
  })

  it('skips worktree merge for remote agents even if worktree metadata exists', async () => {
    const team = makeTeam({
      id: 'team-worktree-remote',
      name: 'team-worktree-remote',
      agents: [
        {
          agentId: 'agent-1',
          name: 'claude-1',
          program: 'claude',
          role: 'member',
          hostId: 'remote-1',
          status: 'active',
          worktreePath: '/repo/.worktrees/team-worktree-remote-claude-1',
          worktreeBranch: 'collab/team-worktree-remote/claude-1',
        },
      ],
    })
    const { mod, mocks } = await setupWorktreeService(team)

    await mod.disbandTeam(team.id)

    expect(mocks.mergeWorktree).not.toHaveBeenCalled()
    expect(mocks.destroyWorktree).not.toHaveBeenCalled()
    expect(mocks.killRemoteAgent).toHaveBeenCalledWith('http://remote.test', 'agent-1')
  })

  // 03-11-2026 gemeten: codex 0.164.0 is na 1,0s echt klaar en legt er op 1,6s
  // een modale "Hooks need review"-dialoog over. De selectiepijl van die
  // dialoog is de readyMarker, dus de oude toets ("staat de marker ergens in
  // de capture") bleef ja zeggen en de prompt werd drie keer in de dialoog
  // geplakt. Geen van beide mag nog gebeuren.
  const ONBEKENDE_DIALOOG = [
    '  Hooks need review',
    '  6 hooks are new or changed.',
    '',
    '> 1. Review hooks',
    '  2. Trust all and continue',
    '',
    '  enter confirm · esc skip',
  ].join('\n')

  it('plakt geen prompt in een onbekende dialoog en noemt die dialoog', async () => {
    vi.useFakeTimers()
    try {
      const team = makeTeam({ agents: [makeTeam().agents[0]] })
      const { mod, mocks, appendedMessages } = await setupWorktreeService(team)
      const config = await import('../lib/agent-config')
      vi.mocked(config.resolveAgentProgram).mockReturnValue({ readyMarker: '>', inputMethod: 'pasteFromFile' } as ReturnType<typeof config.resolveAgentProgram>)
      mocks.runtime.capturePane.mockResolvedValue(ONBEKENDE_DIALOOG)
      const creation = mod.createEnsembleTeam({
        name: team.name, description: team.description, agents: [{ program: 'codex' }],
      })
      await vi.advanceTimersByTimeAsync(90_000)
      expect((await creation).status).toBe(201)
      expect(mocks.runtime.pasteFromFile).not.toHaveBeenCalled()
      expect(appendedMessages.some(m => m.content.includes('Hooks need review'))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('plakt niet nog twee keer in een pane die de eerste keer niets deed', async () => {
    // Tot 03-11-2026 plakte de service drie keer blind dezelfde prompt en
    // wachtte er 60s op een antwoord. Codex stond toen al in een dialoog, dus
    // alle drie verdwenen in het niets en de melding kwam een minuut te laat.
    vi.useFakeTimers()
    try {
      const team = makeTeam({ agents: [makeTeam().agents[0]] })
      const { mod, mocks, appendedMessages } = await setupWorktreeService(team)
      const config = await import('../lib/agent-config')
      vi.mocked(config.resolveAgentProgram).mockReturnValue({ readyMarker: '>', inputMethod: 'pasteFromFile' } as ReturnType<typeof config.resolveAgentProgram>)
      // Een stilstaand, gereed scherm: de paste verandert er niets aan.
      mocks.runtime.capturePane.mockResolvedValue('  Codex v0.164.0\n> ')
      const creation = mod.createEnsembleTeam({
        name: team.name, description: team.description, agents: [{ program: 'codex' }],
      })
      await vi.advanceTimersByTimeAsync(120_000)
      await creation
      expect(mocks.runtime.pasteFromFile).toHaveBeenCalledOnce()
      expect(appendedMessages.some(m => /did not take the prompt|nam de prompt niet/i.test(m.content))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ziet een dialoog die vlak na de eerste gereedheid verschijnt', async () => {
    vi.useFakeTimers()
    try {
      const team = makeTeam({ agents: [makeTeam().agents[0]] })
      const { mod, mocks } = await setupWorktreeService(team)
      const config = await import('../lib/agent-config')
      vi.mocked(config.resolveAgentProgram).mockReturnValue({ readyMarker: '>', inputMethod: 'pasteFromFile' } as ReturnType<typeof config.resolveAgentProgram>)
      mocks.runtime.capturePane
        .mockResolvedValueOnce('  Codex v0.164.0\n> ')
        .mockResolvedValue(ONBEKENDE_DIALOOG)
      const creation = mod.createEnsembleTeam({
        name: team.name, description: team.description, agents: [{ program: 'codex' }],
      })
      await vi.advanceTimersByTimeAsync(90_000)
      await creation
      expect(mocks.runtime.pasteFromFile).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('staged workflow integration', () => {
  let tempRoot: string

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-staged-'))
    vi.resetModules()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  async function setupStagedService(team: EnsembleTeam) {
    const runtime = {
      capturePane: vi.fn(async () => '>'),
      sendKeys: vi.fn<AgentRuntime['sendKeys']>(async () => {}),
      pasteFromFile: vi.fn(async () => {}),
    }
    const runStagedWorkflow = vi.fn(async () => {})

    vi.doMock('../lib/ensemble-registry', () => ({
      createTeam: vi.fn(() => team),
      getTeam: vi.fn(() => team),
      updateTeam: vi.fn((_id: string, updates: Partial<EnsembleTeam>) => ({ ...team, ...updates })),
      loadTeams: vi.fn(() => []),
      appendMessage: vi.fn(),
      getMessages: vi.fn(() => []),
      markAgentFailed: vi.fn(),
      setAgentDelivery: vi.fn(),
    }))
    vi.doMock('../lib/agent-spawner', () => ({
      spawnLocalAgent: vi.fn(async ({ name, program, workingDirectory, hostId }) => ({
        id: `${name}-id`,
        name,
        program,
        sessionName: name,
        workingDirectory,
        hostId,
      })),
      killLocalAgent: vi.fn(async () => {}),
      spawnRemoteAgent: vi.fn(async () => ({ id: 'remote-agent-id' })),
      killRemoteAgent: vi.fn(async () => {}),
      postRemoteSessionCommand: vi.fn(async () => {}),
      isRemoteSessionReady: vi.fn(async () => true),
      getAgentTokenUsage: vi.fn(async () => 'unknown'),
    }))
    vi.doMock('../lib/hosts-config', () => ({
      isSelf: vi.fn(() => true),
      getHostById: vi.fn(() => ({ id: 'local', url: 'http://local.test' })),
      getSelfHostId: vi.fn(() => 'local'),
    }))
    vi.doMock('../lib/agent-runtime', () => ({
      getRuntime: vi.fn(() => runtime),
    }))
    vi.doMock('../lib/agent-config', () => ({
      resolveAgentProgram: vi.fn(() => ({ readyMarker: '>', inputMethod: 'sendKeys' })),
      resolveAgentProgramDetailed: vi.fn((program: string) => ({
        agent: { command: program, readyMarker: '>', inputMethod: 'sendKeys' },
        how: 'exact',
        requested: program,
      })),
      availableAgentKeys: vi.fn(() => ['claude', 'codex']),
    }))
    vi.doMock('../lib/collab-paths', () => ({
      ensureCollabDirs: vi.fn(),
      collabPromptFile: vi.fn((teamId: string, agentName: string) => path.join(tempRoot, `${teamId}-${agentName}.prompt.txt`)),
      collabDeliveryFile: vi.fn((teamId: string, sessionName: string) => path.join(tempRoot, `${teamId}-${sessionName}.delivery.txt`)),
      collabSummaryFile: vi.fn((teamId: string) => path.join(tempRoot, `${teamId}.summary.txt`)),
      collabMessagesFile: vi.fn((teamId: string) => path.join(tempRoot, `${teamId}.messages.jsonl`)),
      collabRuntimeDir: vi.fn((teamId: string) => path.join(tempRoot, teamId)),
      collabFinishedMarker: vi.fn((teamId: string) => path.join(tempRoot, `${teamId}.finished`)),
      collabBridgePosted: vi.fn((teamId: string) => path.join(tempRoot, `${teamId}.posted`)),
      collabBridgeResult: vi.fn((teamId: string) => path.join(tempRoot, `${teamId}.result`)),
      collabSessionsFile: vi.fn((teamId: string) => path.join(tempRoot, `${teamId}.sessions`)),
    }))
    vi.doMock('../lib/worktree-manager', () => ({
      createWorktree: vi.fn(),
      mergeWorktree: vi.fn(async () => ({ success: true })),
      destroyWorktree: vi.fn(async () => {}),
    }))
    vi.doMock('../lib/staged-workflow', () => ({
      runStagedWorkflow,
    }))

    const mod = await import('../services/ensemble-service')
    return { mod, runtime, runStagedWorkflow }
  }

  it('uses staged workflow instead of normal prompt injection when staged=true', async () => {
    vi.stubEnv('ENSEMBLE_TASK_PREAMBLE', 'Use project conventions.')
    const team = makeTeam({
      id: 'team-staged',
      name: 'team-staged',
      status: 'forming',
      agents: [
        { agentId: '', name: 'codex-1', program: 'codex', role: 'lead', hostId: '', status: 'spawning' },
        { agentId: '', name: 'claude-2', program: 'claude', role: 'member', hostId: '', status: 'spawning' },
      ],
    })
    const { mod, runtime, runStagedWorkflow } = await setupStagedService(team)
    const stagedConfig: StagedWorkflowConfig = { planTimeoutMs: 1500 }

    await mod.createEnsembleTeam({
      name: team.name,
      description: team.description,
      agents: [{ program: 'codex' }, { program: 'claude' }],
      workingDirectory: '/repo',
      staged: true,
      stagedConfig,
    })

    expect(runStagedWorkflow).toHaveBeenCalledTimes(1)
    expect(runStagedWorkflow).toHaveBeenCalledWith(
      team,
      stagedConfig,
      expect.objectContaining({
        buildPlanPrompt: expect.any(Function),
        buildExecPrompt: expect.any(Function),
        buildVerifyPrompt: expect.any(Function),
      }),
    )
    const workflow = await import('../lib/staged-workflow')
    const builders = vi.mocked(workflow.runStagedWorkflow).mock.calls[0][2]!
    const prompt = builders.buildPlanPrompt!({ agent: team.agents[0], teammates: ['claude-2'], index: 0 })
    expect(prompt).toContain('Use project conventions.')
    expect(prompt.indexOf('Use project conventions.')).toBeLessThan(prompt.indexOf('Task:'))
    expect(runtime.sendKeys).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })

  // 15s in plaats van de standaard 5s: een echte teamstart wacht sinds
  // 03-11-2026 tot de gereedheid 2s aanhoudt, per agent.
  it('keeps normal prompt injection when staged=false', async () => {
    const team = makeTeam({
      id: 'team-non-staged',
      name: 'team-non-staged',
      status: 'forming',
      agents: [
        { agentId: '', name: 'codex-1', program: 'codex', role: 'lead', hostId: '', status: 'spawning' },
        { agentId: '', name: 'claude-2', program: 'claude', role: 'member', hostId: '', status: 'spawning' },
      ],
    })
    const { mod, runtime, runStagedWorkflow } = await setupStagedService(team)

    await mod.createEnsembleTeam({
      name: team.name,
      description: team.description,
      agents: [{ program: 'codex' }, { program: 'claude' }],
      workingDirectory: '/repo',
      staged: false,
    })

    expect(runStagedWorkflow).not.toHaveBeenCalled()
    expect(runtime.sendKeys).toHaveBeenCalledTimes(2)
  }, 15_000)
})

// ─────────────────────────────────────────────────────
// 8. CreateTeamRequest — staged field in types
// ─────────────────────────────────────────────────────
describe('CreateTeamRequest staged types', () => {
  it('staged field is optional and defaults behavior', () => {
    const request: import('../types/ensemble').CreateTeamRequest = {
      name: 'test',
      description: 'test',
      agents: [{ program: 'codex' }],
      staged: true,
      stagedConfig: {
        planTimeoutMs: 60_000,
        execTimeoutMs: 180_000,
      },
    }
    expect(request.staged).toBe(true)
    expect(request.stagedConfig?.planTimeoutMs).toBe(60_000)
  })

  it('staged field defaults to undefined (opt-in)', () => {
    const request: import('../types/ensemble').CreateTeamRequest = {
      name: 'test',
      description: 'test',
      agents: [{ program: 'codex' }],
    }
    expect(request.staged).toBeUndefined()
  })
})

describe('alert-hub geheim', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('het hub-geheim staat niet in de URL', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'services/ensemble-service.ts'), 'utf8')
    expect(src).not.toMatch(/\?key=\$\{encodeURIComponent\(ALERT_HUB_SECRET\)\}/)
  })

  it('post naar de alert-hub zonder subproces, zodat het geheim niet in de argv staat', () => {
    // Het lek was niet de query-parameter maar het curl-subproces dat de hele
    // URL als argv meekreeg: argv is voor elke andere gebruiker op de machine
    // leesbaar via ps. De hub zelf leest de sleutel uitsluitend uit de query
    // dus die hoort daar te staan; een
    // header zou een 403 opleveren en de meldingen stil laten wegvallen.
    //
    // vi.fn().mockRejectedValue() houdt zelf een handler op de promise vast
    // (voor de call-tracking), dus die kan een ontbrekende .catch() niet
    // blootleggen. Dat dekt de test hieronder, met een echte fetch.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))

    __testing.postToAlertHub('https://alerts.example/ingest', 'topsecret', '{"a":1}')

    // Geen spy op spawn: in ESM is een module-export niet te herdefinieren.
    // De broncode van de functie is hier de betrouwbaarder toets.
    const bron = String(__testing.postToAlertHub)
    expect(bron, 'geen subproces, anders staat het geheim weer in de argv').not.toMatch(/spawn|exec/)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [calledUrl] = fetchSpy.mock.calls[0]
    expect(String(calledUrl)).toContain('key=topsecret')
  })

  it('een mislukte post naar de alert-hub blijft binnen de afhandeling', async () => {
    let unhandled: unknown
    const onUnhandled = (err: unknown) => { unhandled = err }
    process.once('unhandledRejection', onUnhandled)

    // Poort 1 luistert nooit, dus dit is een gegarandeerde, echte connection
    // failure (geen mock) die een echte unhandled rejection oplevert als de
    // .catch() ontbreekt.
    __testing.postToAlertHub('http://127.0.0.1:1/ingest/alert', 'topsecret', '{"a":1}')

    await new Promise(resolve => setTimeout(resolve, 300))
    process.removeListener('unhandledRejection', onUnhandled)
    expect(unhandled).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────
// cleanupStaleTeams() — stopt processen, niet alleen de status
// ─────────────────────────────────────────────────────
describe('cleanupStaleTeams stopt achtergebleven processen', () => {
  let tempRoot: string

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-stale-'))
    vi.resetModules()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  it('kilt de tmux-sessies uit het register en stopt bridge/poller van een stale team', async () => {
    // Een team ouder dan 2 uur, nog 'active': cleanupStaleTeams() zet dit op
    // disbanded. Daarna filteren de watchdog en checkIdleTeams op status
    // 'active' en slaan het voorgoed over, dus als de processen hier niet
    // stoppen, blijven ze voor altijd draaien.
    const team = makeTeam({
      id: 'team-stale-1',
      status: 'active',
      createdAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
    })
    const runtimeDir = path.join(tempRoot, team.id)
    fs.mkdirSync(runtimeDir, { recursive: true })
    fs.writeFileSync(path.join(runtimeDir, 'sessions'), 'collab-1-1-claude-1\ncollab-1-1-codex-2\n')

    const updateTeamMock = vi.fn()
    const execCalls: string[][] = []

    vi.doMock('../lib/ensemble-registry', () => ({
      createTeam: vi.fn(),
      getTeam: vi.fn(() => team),
      updateTeam: updateTeamMock,
      loadTeams: vi.fn(() => [team]),
      appendMessage: vi.fn(),
      getMessages: vi.fn(() => []),
      markAgentFailed: vi.fn(),
      setAgentDelivery: vi.fn(),
    }))
    vi.doMock('../lib/agent-spawner', () => ({
      spawnLocalAgent: vi.fn(),
      killLocalAgent: vi.fn(async () => {}),
      spawnRemoteAgent: vi.fn(),
      killRemoteAgent: vi.fn(async () => {}),
      postRemoteSessionCommand: vi.fn(async () => {}),
      isRemoteSessionReady: vi.fn(async () => true),
      getAgentTokenUsage: vi.fn(async () => 'unknown'),
    }))
    vi.doMock('../lib/hosts-config', () => ({
      isSelf: vi.fn(() => true),
      getHostById: vi.fn(),
      getSelfHostId: vi.fn(() => 'local'),
    }))
    vi.doMock('../lib/agent-runtime', () => ({
      getRuntime: vi.fn(),
    }))
    vi.doMock('../lib/agent-config', () => ({
      resolveAgentProgram: vi.fn(),
      resolveAgentProgramDetailed: vi.fn(),
      availableAgentKeys: vi.fn(() => []),
    }))
    vi.doMock('../lib/collab-paths', () => ({
      ensureCollabDirs: vi.fn(),
      collabPromptFile: vi.fn(),
      collabDeliveryFile: vi.fn(),
      // writeDisbandSummary schrijft hierheen als een stale team geen berichten
      // had; zonder een echt pad daarvoor gooit fs.mkdirSync op "undefined".
      collabSummaryFile: vi.fn((teamId: string) => path.join(tempRoot, `${teamId}.summary.txt`)),
      collabMessagesFile: vi.fn((teamId: string) => path.join(tempRoot, `${teamId}.messages.jsonl`)),
      collabRuntimeDir: vi.fn((teamId: string) => path.join(tempRoot, teamId)),
      collabFinishedMarker: vi.fn(),
      collabBridgePosted: vi.fn(),
      collabPollerPid: vi.fn(),
      collabBridgeResult: vi.fn(),
      collabSessionsFile: vi.fn((teamId: string) => path.join(tempRoot, teamId, 'sessions')),
    }))
    vi.doMock('../lib/worktree-manager', () => ({
      createWorktree: vi.fn(),
      mergeWorktree: vi.fn(),
      destroyWorktree: vi.fn(),
    }))
    vi.doMock('../lib/staged-workflow', () => ({
      runStagedWorkflow: vi.fn(),
    }))
    vi.doMock('child_process', () => ({
      spawn: vi.fn(),
      execFileSync: vi.fn((cmd: string, args: string[]) => {
        execCalls.push([cmd, ...args])
        return ''
      }),
    }))

    await import('../services/ensemble-service')

    const gekildeSessies = execCalls
      .filter(c => c[0] === 'tmux' && c[1] === 'kill-session')
      .map(c => c[3])
    expect(gekildeSessies).toEqual(['collab-1-1-claude-1', 'collab-1-1-codex-2'])

    const bashAanroep = execCalls.find(c => c[0] === 'bash')
    expect(bashAanroep, 'stop_team_processes moet via bash aangeroepen worden').toBeDefined()
    expect(bashAanroep).toContain(runtimeDir)

    expect(updateTeamMock).toHaveBeenCalledWith(team.id, expect.objectContaining({ status: 'disbanded' }))
  })
})
