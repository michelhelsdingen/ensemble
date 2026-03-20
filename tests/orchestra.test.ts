import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrchestraMessage, OrchestraTeam, StagedWorkflowConfig } from '../types/orchestra'

const TEAM_SAY_BIN = path.resolve(process.cwd(), 'scripts/team-say.sh')
const TMP_ORCHESTRA_DIR = '/tmp/orchestra'

function makeMessage(overrides: Partial<OrchestraMessage> = {}): OrchestraMessage {
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

function makeTeam(overrides: Partial<OrchestraTeam> = {}): OrchestraTeam {
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
    const tmpDir = path.join(TMP_ORCHESTRA_DIR, teamId)
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reads messages from feed.jsonl only', async () => {
    const feedDir = path.join(tempRoot, 'orchestra', 'messages', teamId)
    const msg = makeMessage({ id: 'feed-only', teamId, content: 'from feed' })
    writeJsonl(path.join(feedDir, 'feed.jsonl'), [msg])

    const { getMessages } = await import('../lib/orchestra-registry')
    const result = getMessages(teamId)

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('feed-only')
    expect(result[0].content).toBe('from feed')
  })

  it('reads messages from /tmp/orchestra/<teamId>/messages.jsonl only', async () => {
    const tmpFile = path.join(TMP_ORCHESTRA_DIR, teamId, 'messages.jsonl')
    const msg = makeMessage({ id: 'tmp-only', teamId, content: 'from tmp' })
    writeJsonl(tmpFile, [msg])

    const { getMessages } = await import('../lib/orchestra-registry')
    const result = getMessages(teamId)

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('tmp-only')
  })

  it('merges messages from both sources', async () => {
    const feedDir = path.join(tempRoot, 'orchestra', 'messages', teamId)
    writeJsonl(path.join(feedDir, 'feed.jsonl'), [
      makeMessage({ id: 'feed-msg', teamId, timestamp: '2026-01-01T10:00:00.000Z' }),
    ])
    writeJsonl(path.join(TMP_ORCHESTRA_DIR, teamId, 'messages.jsonl'), [
      makeMessage({ id: 'tmp-msg', teamId, timestamp: '2026-01-01T10:00:01.000Z' }),
    ])

    const { getMessages } = await import('../lib/orchestra-registry')
    const result = getMessages(teamId)

    expect(result).toHaveLength(2)
    expect(result.map(m => m.id)).toEqual(['feed-msg', 'tmp-msg'])
  })

  it('deduplicates messages with same id (feed.jsonl wins)', async () => {
    const sharedId = 'shared-id'
    const feedDir = path.join(tempRoot, 'orchestra', 'messages', teamId)
    writeJsonl(path.join(feedDir, 'feed.jsonl'), [
      makeMessage({ id: sharedId, teamId, content: 'from feed', timestamp: '2026-01-01T10:00:00.000Z' }),
    ])
    writeJsonl(path.join(TMP_ORCHESTRA_DIR, teamId, 'messages.jsonl'), [
      makeMessage({ id: sharedId, teamId, content: 'from tmp', timestamp: '2026-01-01T10:00:00.000Z' }),
    ])

    const { getMessages } = await import('../lib/orchestra-registry')
    const result = getMessages(teamId)

    const matching = result.filter(m => m.id === sharedId)
    expect(matching).toHaveLength(1)
    expect(matching[0].content).toBe('from feed')
  })

  it('sorts messages by timestamp ascending, missing timestamps last', async () => {
    const feedDir = path.join(tempRoot, 'orchestra', 'messages', teamId)
    writeJsonl(path.join(feedDir, 'feed.jsonl'), [
      makeMessage({ id: 'late', teamId, timestamp: '2026-01-01T12:00:00.000Z' }),
      makeMessage({ id: 'early', teamId, timestamp: '2026-01-01T10:00:00.000Z' }),
      makeMessage({ id: 'no-ts', teamId, timestamp: undefined as unknown as string }),
    ])

    const { getMessages } = await import('../lib/orchestra-registry')
    const result = getMessages(teamId)

    expect(result.map(m => m.id)).toEqual(['early', 'late', 'no-ts'])
  })

  it('filters by since parameter', async () => {
    const feedDir = path.join(tempRoot, 'orchestra', 'messages', teamId)
    writeJsonl(path.join(feedDir, 'feed.jsonl'), [
      makeMessage({ id: 'old', teamId, timestamp: '2026-01-01T10:00:00.000Z' }),
      makeMessage({ id: 'new', teamId, timestamp: '2026-01-01T12:00:00.000Z' }),
    ])

    const { getMessages } = await import('../lib/orchestra-registry')
    const result = getMessages(teamId, '2026-01-01T11:00:00.000Z')

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('new')
  })

  it('returns empty array when no files exist', async () => {
    const { getMessages } = await import('../lib/orchestra-registry')
    const result = getMessages('nonexistent-team-xyz')
    expect(result).toEqual([])
  })

  it('deduplicates by fallback key when id is missing', async () => {
    const feedDir = path.join(tempRoot, 'orchestra', 'messages', teamId)
    const ts = '2026-01-01T10:00:00.000Z'
    // Two messages with no id but same from+timestamp+content prefix → should dedupe
    const msg = { teamId, from: 'codex-1', to: 'team', content: 'same content here', type: 'chat', timestamp: ts }
    writeJsonl(path.join(feedDir, 'feed.jsonl'), [msg])
    writeJsonl(path.join(TMP_ORCHESTRA_DIR, teamId, 'messages.jsonl'), [msg])

    const { getMessages } = await import('../lib/orchestra-registry')
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
    vi.doUnmock('../lib/orchestra-registry')
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

  async function setupServiceWithMocks(team: OrchestraTeam, messages: OrchestraMessage[]) {
    const appendedMessages: OrchestraMessage[] = []
    vi.doMock('../lib/orchestra-registry', () => ({
      getMessages: vi.fn(() => messages),
      loadTeams: vi.fn(() => [team]),
      appendMessage: vi.fn((_id: string, msg: OrchestraMessage) => appendedMessages.push(msg)),
      updateTeam: vi.fn((_id: string, updates: Partial<OrchestraTeam>) => ({ ...team, ...updates })),
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
    }))

    const mod = await import('../services/orchestra-service')
    return { mod, appendedMessages }
  }

  it('auto-disbands when two different agents send completion signals within 60s', async () => {
    const team = makeTeam()
    const messages: OrchestraMessage[] = [
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: 'Task is done', timestamp: '2026-03-18T12:04:20.000Z' }),
      makeMessage({ from: 'claude-2', teamId: 'team-1', content: 'Alles afgerond', timestamp: '2026-03-18T12:04:50.000Z' }),
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    expect(appendedMessages.some(m => m.content.includes('Auto-disband'))).toBe(true)
  })

  it('does NOT auto-disband when only one completion signal exists and idle is <= 120s', async () => {
    const team = makeTeam()
    const messages: OrchestraMessage[] = [
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: 'Task is done', timestamp: '2026-03-18T12:03:40.000Z' }),
      makeMessage({ from: 'claude-2', teamId: 'team-1', content: 'Still working', timestamp: '2026-03-18T12:03:50.000Z' }),
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    expect(appendedMessages.some(m => m.content.includes('Auto-disband'))).toBe(false)
  })

  it('auto-disbands when one completion signal exists and team is idle for more than 120s', async () => {
    const team = makeTeam()
    const messages: OrchestraMessage[] = [
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: 'Task is done', timestamp: '2026-03-18T12:02:30.000Z' }),
      makeMessage({ from: 'claude-2', teamId: 'team-1', content: 'Still investigating', timestamp: '2026-03-18T12:02:40.000Z' }),
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    expect(appendedMessages.some(m => m.content.includes('Auto-disband'))).toBe(true)
  })

  it('does NOT auto-disband when agents have no completion signal', async () => {
    const team = makeTeam()
    const messages: OrchestraMessage[] = [
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
    const messages: OrchestraMessage[] = [
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
    const messages: OrchestraMessage[] = [
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: 'Done', timestamp: '2026-03-18T12:03:40.000Z' }),
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    expect(appendedMessages.some(m => m.content.includes('Auto-disband'))).toBe(false)
  })

  it('does NOT auto-disband when signals come from the same agent only', async () => {
    const team = makeTeam()
    const messages: OrchestraMessage[] = [
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: 'Task is done', timestamp: '2026-03-18T12:04:00.000Z' }),
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: 'Alles afgerond', timestamp: '2026-03-18T12:04:30.000Z' }),
      makeMessage({ from: 'claude-2', teamId: 'team-1', content: 'Still working...', timestamp: '2026-03-18T12:04:45.000Z' }),
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    expect(appendedMessages.some(m => m.content.includes('Auto-disband'))).toBe(false)
  })

  it('ignores orchestra messages when determining idle time', async () => {
    const team = makeTeam()
    const messages: OrchestraMessage[] = [
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: 'Done', timestamp: '2026-03-18T12:02:30.000Z' }),
      makeMessage({ from: 'claude-2', teamId: 'team-1', content: 'Still working', timestamp: '2026-03-18T12:02:35.000Z' }),
      makeMessage({ from: 'orchestra', teamId: 'team-1', content: 'Agent joined', timestamp: '2026-03-18T12:04:55.000Z' }),
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
    outputFile = path.join(TMP_ORCHESTRA_DIR, testTeamId, 'messages.jsonl')
    fs.mkdirSync(path.dirname(outputFile), { recursive: true })
  })

  afterEach(() => {
    if (fs.existsSync(outputFile)) fs.rmSync(outputFile, { force: true })
  })

  it('prints "Sent to <recipient>" on stdout', () => {
    const stdout = execFileSync(
      TEAM_SAY_BIN,
      [testTeamId, 'codex-1', 'claude-2', 'test message'],
      { encoding: 'utf-8' },
    ).trim()
    expect(stdout).toBe('Sent to claude-2')
  })

  it('writes valid JSONL to /tmp/orchestra/<teamId>/messages.jsonl', () => {
    execFileSync(TEAM_SAY_BIN, [testTeamId, 'codex-1', 'claude-2', 'hello'])
    expect(fs.existsSync(outputFile)).toBe(true)

    const line = fs.readFileSync(outputFile, 'utf-8').trim()
    expect(() => JSON.parse(line)).not.toThrow()
  })

  it('message contains all required OrchestraMessage fields', () => {
    execFileSync(TEAM_SAY_BIN, [testTeamId, 'codex-1', 'claude-2', 'field check'])
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
    execFileSync(TEAM_SAY_BIN, [testTeamId, 'codex-1', 'claude-2', 'uuid test'])
    const msg = JSON.parse(fs.readFileSync(outputFile, 'utf-8').trim())
    const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    expect(msg.id).toMatch(uuidV4Regex)
  })

  it('timestamp is a valid, recent ISO 8601 string', () => {
    execFileSync(TEAM_SAY_BIN, [testTeamId, 'codex-1', 'claude-2', 'ts test'])
    const msg = JSON.parse(fs.readFileSync(outputFile, 'utf-8').trim())
    const parsed = new Date(msg.timestamp)
    expect(Number.isNaN(parsed.getTime())).toBe(false)
    expect(Date.now() - parsed.getTime()).toBeLessThan(10_000)
  })

  it('preserves multi-word content', () => {
    execFileSync(TEAM_SAY_BIN, [testTeamId, 'codex-1', 'claude-2', 'bericht met spaties'])
    const msg = JSON.parse(fs.readFileSync(outputFile, 'utf-8').trim())
    expect(msg.content).toBe('bericht met spaties')
  })

  it('handles special characters in message', () => {
    execFileSync(TEAM_SAY_BIN, [testTeamId, 'codex-1', 'claude-2', 'Hello "world" & <test>'])
    const msg = JSON.parse(fs.readFileSync(outputFile, 'utf-8').trim())
    expect(msg.content).toContain('"world"')
    expect(msg.content).toContain('&')
    expect(msg.content).toContain('<test>')
  })

  it('appends multiple messages with unique ids', () => {
    execFileSync(TEAM_SAY_BIN, [testTeamId, 'codex-1', 'claude-2', 'First'])
    execFileSync(TEAM_SAY_BIN, [testTeamId, 'codex-1', 'claude-2', 'Second'])

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

  async function setupWorktreeService(team: OrchestraTeam) {
    const appendedMessages: OrchestraMessage[] = []
    const createTeam = vi.fn(() => team)
    const getTeam = vi.fn(() => team)
    const updateTeam = vi.fn((_id: string, updates: Partial<OrchestraTeam>) => ({ ...team, ...updates }))
    const appendMessage = vi.fn((_id: string, message: OrchestraMessage) => appendedMessages.push(message))
    const spawnLocalAgent = vi.fn(async ({ name, program, workingDirectory, hostId }) => ({
      id: `${name}-id`,
      name,
      program,
      sessionName: name,
      workingDirectory,
      hostId,
    }))
    const spawnRemoteAgent = vi.fn(async () => ({ id: 'remote-agent-id' }))
    const killLocalAgent = vi.fn(async () => {})
    const killRemoteAgent = vi.fn(async () => {})
    const createWorktree = vi.fn(async (teamId: string, agentName: string, basePath: string) => ({
      path: path.join(basePath, '.worktrees', `${teamId}-${agentName}`),
      branch: `collab/${teamId}/${agentName}`,
      agentName,
    }))
    const mergeWorktree = vi.fn(async () => ({ success: true }))
    const destroyWorktree = vi.fn(async () => {})

    vi.doMock('../lib/orchestra-registry', () => ({
      createTeam,
      getTeam,
      updateTeam,
      loadTeams: vi.fn(() => []),
      appendMessage,
      getMessages: vi.fn(() => []),
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
    vi.doMock('../lib/agent-runtime', () => ({
      getRuntime: vi.fn(() => ({
        capturePane: vi.fn(async () => '>'),
        sendKeys: vi.fn(async () => {}),
        pasteFromFile: vi.fn(async () => {}),
      })),
    }))
    vi.doMock('../lib/agent-config', () => ({
      resolveAgentProgram: vi.fn(() => ({ readyMarker: '>', inputMethod: 'sendKeys' })),
    }))
    vi.doMock('../lib/collab-paths', () => ({
      ensureCollabDirs: vi.fn(),
      collabPromptFile: vi.fn((teamId: string, agentName: string) => path.join(tempRoot, `${teamId}-${agentName}.prompt.txt`)),
      collabDeliveryFile: vi.fn((teamId: string, sessionName: string) => path.join(tempRoot, `${teamId}-${sessionName}.delivery.txt`)),
      collabSummaryFile: vi.fn((teamId: string) => path.join(tempRoot, `${teamId}.summary.txt`)),
      collabRuntimeDir: vi.fn((teamId: string) => path.join(tempRoot, teamId)),
      collabFinishedMarker: vi.fn((teamId: string) => path.join(tempRoot, `${teamId}.finished`)),
      collabBridgePosted: vi.fn((teamId: string) => path.join(tempRoot, `${teamId}.posted`)),
      collabBridgeResult: vi.fn((teamId: string) => path.join(tempRoot, `${teamId}.result`)),
    }))

    const mod = await import('../services/orchestra-service')
    return {
      mod,
      team,
      appendedMessages,
      mocks: {
        createTeam,
        getTeam,
        updateTeam,
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

    await mod.createOrchestraTeam({
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
  })

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

    await mod.createOrchestraTeam({
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
  })

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

  async function setupStagedService(team: OrchestraTeam) {
    const runtime = {
      capturePane: vi.fn(async () => '>'),
      sendKeys: vi.fn(async () => {}),
      pasteFromFile: vi.fn(async () => {}),
    }
    const runStagedWorkflow = vi.fn(async () => {})

    vi.doMock('../lib/orchestra-registry', () => ({
      createTeam: vi.fn(() => team),
      getTeam: vi.fn(() => team),
      updateTeam: vi.fn((_id: string, updates: Partial<OrchestraTeam>) => ({ ...team, ...updates })),
      loadTeams: vi.fn(() => []),
      appendMessage: vi.fn(),
      getMessages: vi.fn(() => []),
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
    }))
    vi.doMock('../lib/collab-paths', () => ({
      ensureCollabDirs: vi.fn(),
      collabPromptFile: vi.fn((teamId: string, agentName: string) => path.join(tempRoot, `${teamId}-${agentName}.prompt.txt`)),
      collabDeliveryFile: vi.fn((teamId: string, sessionName: string) => path.join(tempRoot, `${teamId}-${sessionName}.delivery.txt`)),
      collabSummaryFile: vi.fn((teamId: string) => path.join(tempRoot, `${teamId}.summary.txt`)),
      collabRuntimeDir: vi.fn((teamId: string) => path.join(tempRoot, teamId)),
      collabFinishedMarker: vi.fn((teamId: string) => path.join(tempRoot, `${teamId}.finished`)),
      collabBridgePosted: vi.fn((teamId: string) => path.join(tempRoot, `${teamId}.posted`)),
      collabBridgeResult: vi.fn((teamId: string) => path.join(tempRoot, `${teamId}.result`)),
    }))
    vi.doMock('../lib/worktree-manager', () => ({
      createWorktree: vi.fn(),
      mergeWorktree: vi.fn(async () => ({ success: true })),
      destroyWorktree: vi.fn(async () => {}),
    }))
    vi.doMock('../lib/staged-workflow', () => ({
      runStagedWorkflow,
    }))

    const mod = await import('../services/orchestra-service')
    return { mod, runtime, runStagedWorkflow }
  }

  it('uses staged workflow instead of normal prompt injection when staged=true', async () => {
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

    await mod.createOrchestraTeam({
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
    expect(runtime.sendKeys).not.toHaveBeenCalled()
  })

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

    await mod.createOrchestraTeam({
      name: team.name,
      description: team.description,
      agents: [{ program: 'codex' }, { program: 'claude' }],
      workingDirectory: '/repo',
      staged: false,
    })

    expect(runStagedWorkflow).not.toHaveBeenCalled()
    expect(runtime.sendKeys).toHaveBeenCalledTimes(2)
  })
})

// ─────────────────────────────────────────────────────
// 8. CreateTeamRequest — staged field in types
// ─────────────────────────────────────────────────────
describe('CreateTeamRequest staged types', () => {
  it('staged field is optional and defaults behavior', () => {
    const request: import('../types/orchestra').CreateTeamRequest = {
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
    const request: import('../types/orchestra').CreateTeamRequest = {
      name: 'test',
      description: 'test',
      agents: [{ program: 'codex' }],
    }
    expect(request.staged).toBeUndefined()
  })
})
