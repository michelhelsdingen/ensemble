import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Een teamstart wacht sinds 03-11-2026 op stabiele gereedheid en bevestigt de
// aflevering, dus deze twee echte starts hebben meer dan 5s nodig.
vi.setConfig({ testTimeout: 30_000 })
import type { EnsembleTeam } from '../types/ensemble'

// De service spawnt de tmux-sessies EN levert de prompts af binnen één
// blokkerende call (services/ensemble-service.ts::createEnsembleTeam). Het
// sessieregister moet dus in de service zelf ontstaan, niet in
// scripts/collab-launch.sh: dat script krijgt pas antwoord nadat alles al is
// gebeurd, dus daar bestaat geen moment "vóór de aflevering". Deze tests
// draaien createEnsembleTeam met gemockte agent-spawn/injectie-lagen, zoals
// tests/ensemble.test.ts dat ook al doet voor de staged-workflow-tests.

function makeTeam(overrides: Partial<EnsembleTeam> = {}): EnsembleTeam {
  return {
    id: overrides.id ?? 'team-sessions-1',
    name: overrides.name ?? 'team-sessions-1',
    description: overrides.description ?? 'test',
    status: overrides.status ?? 'forming',
    agents: overrides.agents ?? [
      { agentId: '', name: 'codex-1', program: 'codex', role: 'lead', hostId: '', status: 'spawning' },
      { agentId: '', name: 'gemini-2', program: 'gemini', role: 'member', hostId: '', status: 'spawning' },
    ],
    createdBy: overrides.createdBy ?? 'test',
    createdAt: overrides.createdAt ?? '2026-09-20T10:00:00.000Z',
    feedMode: overrides.feedMode ?? 'live',
  }
}

describe('sessieregister (service)', () => {
  let tempRoot: string

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-sessions-'))
    vi.resetModules()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  async function setupService(team: EnsembleTeam, order: string[]) {
    const sessionsFile = path.join(tempRoot, `${team.id}.sessions`)
    const runtime = {
      capturePane: vi.fn(async () => '>'),
      sendKeys: vi.fn(async (sessionName: string) => { order.push(`inject:${sessionName}`) }),
      pasteFromFile: vi.fn(async (sessionName: string) => { order.push(`inject:${sessionName}`) }),
    }

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
      spawnLocalAgent: vi.fn(async ({ name }: { name: string }) => ({ id: `${name}-id` })),
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
      availableAgentKeys: vi.fn(() => ['codex', 'gemini']),
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
      collabSessionsFile: vi.fn(() => sessionsFile),
    }))
    vi.doMock('../lib/worktree-manager', () => ({
      createWorktree: vi.fn(),
      mergeWorktree: vi.fn(async () => ({ success: true })),
      destroyWorktree: vi.fn(async () => {}),
    }))

    const mod = await import('../services/ensemble-service')
    return { mod, sessionsFile, runtime }
  }

  it('schrijft één regel per gespawnde sessie, met dezelfde naam als de spawn', async () => {
    const team = makeTeam({ id: 'team-sessions-write', name: 'team-sessions-write' })
    const order: string[] = []
    const { mod, sessionsFile } = await setupService(team, order)

    await mod.createEnsembleTeam({
      name: team.name,
      description: team.description,
      agents: [{ program: 'codex' }, { program: 'gemini' }],
      workingDirectory: '/repo',
    })

    const written = fs.readFileSync(sessionsFile, 'utf8').trim().split('\n')
    expect(written).toEqual(['team-sessions-write-codex-1', 'team-sessions-write-gemini-2'])
  })

  it('schrijft het register voordat de prompts worden afgeleverd', async () => {
    const team = makeTeam({ id: 'team-sessions-order', name: 'team-sessions-order' })
    const order: string[] = []
    const { mod, sessionsFile } = await setupService(team, order)

    const originalWrite = fs.writeFileSync.bind(fs)
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, opts?: fs.WriteFileOptions | BufferEncoding) => {
      if (String(file) === sessionsFile) order.push('register-written')
      return originalWrite(file, data, opts)
    }) as typeof fs.writeFileSync)

    await mod.createEnsembleTeam({
      name: team.name,
      description: team.description,
      agents: [{ program: 'codex' }, { program: 'gemini' }],
      workingDirectory: '/repo',
    })

    writeSpy.mockRestore()

    expect(order).toContain('register-written')
    expect(order).toContain('inject:team-sessions-order-codex-1')
    expect(order.indexOf('register-written')).toBeLessThan(
      order.findIndex(entry => entry.startsWith('inject:')),
    )
  })
})

describe('geen tweede plek bouwt de sessienaam opnieuw op', () => {
  it('collab-launch.sh construeert het register niet meer zelf uit team.name + agent.name', () => {
    const launch = fs.readFileSync(path.resolve(process.cwd(), 'scripts/collab-launch.sh'), 'utf8')
    expect(launch).not.toMatch(/>\s*"\$RUNTIME_DIR\/sessions"/)
    expect(launch).not.toMatch(/team\['name'\]/)
  })
})
