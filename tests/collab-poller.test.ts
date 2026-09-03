/**
 * Regression test for the feed poller that never stopped.
 *
 * collab-launch.sh starts one background loop per team that copies new lines
 * from messages.jsonl into feed.txt. Until 2026-09 that loop was an inline
 * `while true` with no exit condition, and nothing killed it on disband. On
 * 2026-09-01 sixteen of them were still running, the oldest eleven days old,
 * for teams the service no longer knew about.
 *
 * The poller now lives in scripts/collab-poller.sh and stops on its own when
 * its team is finished or gone, and disbandTeam() kills it outright.
 */
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { spawn, type ChildProcess } from 'child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnsembleTeam } from '../types/ensemble'

const REPO = process.cwd()
const POLLER = path.join(REPO, 'scripts/collab-poller.sh')
const LAUNCH = path.join(REPO, 'scripts/collab-launch.sh')
const RUNTIME_ROOT = '/tmp/ensemble'

function newTeamId(): string {
  return `test-poller-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
}

function runtimeDir(teamId: string): string {
  return path.join(RUNTIME_ROOT, teamId)
}

async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A stand-in for the ensemble service: the test decides what /teams/:id answers. */
function fakeService(handler: (res: http.ServerResponse) => void): Promise<{ url: string; close: () => void }> {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/v1/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"status":"healthy"}')
        return
      }
      handler(res)
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() })
    })
  })
}

describe('collab-poller.sh', () => {
  let teamId: string
  let child: ChildProcess | undefined
  let exited = false
  let exitCode: number | null = null
  let closeService: (() => void) | undefined

  beforeEach(() => {
    teamId = newTeamId()
    fs.mkdirSync(runtimeDir(teamId), { recursive: true })
    fs.writeFileSync(path.join(runtimeDir(teamId), 'messages.jsonl'), '')
    exited = false
    exitCode = null
  })

  afterEach(() => {
    if (child) {
      // Stop reporting for this child, or its SIGKILL exit lands in the next test's variables.
      child.removeAllListeners('exit')
      if (child.pid && isAlive(child.pid)) child.kill('SIGKILL')
    }
    child = undefined
    closeService?.()
    closeService = undefined
    fs.rmSync(runtimeDir(teamId), { recursive: true, force: true })
  })

  function start(apiUrl: string, extraEnv: Record<string, string> = {}): ChildProcess {
    child = spawn('bash', [POLLER, teamId, apiUrl], {
      stdio: 'ignore',
      env: {
        ...process.env,
        COLLAB_POLL_SECS: '0.2',
        COLLAB_POLLER_CHECK_EVERY: '1',
        COLLAB_POLLER_MAX_API_FAILURES: '50',
        ...extraEnv,
      },
    })
    child.on('exit', code => { exited = true; exitCode = code })
    return child
  }

  it('copies new messages into feed.txt', async () => {
    const svc = await fakeService(res => { res.writeHead(200); res.end('{"team":{"status":"active"}}') })
    closeService = svc.close
    start(svc.url)
    const messages = path.join(runtimeDir(teamId), 'messages.jsonl')
    const feed = path.join(runtimeDir(teamId), 'feed.txt')

    fs.appendFileSync(messages, '{"from":"codex","content":"hoi"}\n')
    await waitFor(() => fs.existsSync(feed) && fs.readFileSync(feed, 'utf8').includes('hoi'), 3000, 'first line in feed')
    fs.appendFileSync(messages, '{"from":"claude","content":"dag"}\n')
    await waitFor(() => fs.readFileSync(feed, 'utf8').includes('dag'), 3000, 'second line in feed')

    expect(fs.readFileSync(feed, 'utf8')).toBe(
      '{"from":"codex","content":"hoi"}\n{"from":"claude","content":"dag"}\n',
    )
    expect(exited).toBe(false)
  })

  it('writes its own pid file and removes it on exit', async () => {
    const svc = await fakeService(res => { res.writeHead(200); res.end('{"team":{"status":"active"}}') })
    closeService = svc.close
    const proc = start(svc.url)
    const pidFile = path.join(runtimeDir(teamId), 'poller.pid')

    await waitFor(() => fs.existsSync(pidFile), 3000, 'poller.pid written')
    expect(Number(fs.readFileSync(pidFile, 'utf8').trim())).toBe(proc.pid)

    fs.writeFileSync(path.join(runtimeDir(teamId), '.finished'), new Date().toISOString())
    await waitFor(() => exited, 3000, 'poller exit after .finished')
    expect(exitCode).toBe(0)
    expect(fs.existsSync(pidFile)).toBe(false)
  })

  it('stops once the team is disbanded (.finished marker), after a last flush', async () => {
    const svc = await fakeService(res => { res.writeHead(200); res.end('{"team":{"status":"active"}}') })
    closeService = svc.close
    start(svc.url)
    const feed = path.join(runtimeDir(teamId), 'feed.txt')
    await waitFor(() => fs.existsSync(path.join(runtimeDir(teamId), 'poller.pid')), 3000, 'poller up')

    // Disband writes the last "X has left" messages and the marker right after each other.
    fs.appendFileSync(path.join(runtimeDir(teamId), 'messages.jsonl'), '{"from":"ensemble","content":"codex has left"}\n')
    fs.writeFileSync(path.join(runtimeDir(teamId), '.finished'), new Date().toISOString())

    await waitFor(() => exited, 3000, 'poller exit after .finished')
    expect(fs.readFileSync(feed, 'utf8')).toContain('codex has left')
  })

  it('stops when the runtime directory is gone', async () => {
    const svc = await fakeService(res => { res.writeHead(200); res.end('{"team":{"status":"active"}}') })
    closeService = svc.close
    start(svc.url)
    await waitFor(() => fs.existsSync(path.join(runtimeDir(teamId), 'poller.pid')), 3000, 'poller up')

    fs.rmSync(runtimeDir(teamId), { recursive: true, force: true })
    await waitFor(() => exited, 3000, 'poller exit after rm -rf')
    expect(exitCode).toBe(0)
  })

  it('stops when the service no longer knows the team', async () => {
    const svc = await fakeService(res => { res.writeHead(404); res.end('{"error":"Team not found"}') })
    closeService = svc.close
    start(svc.url)
    await waitFor(() => exited, 3000, 'poller exit on 404')
    expect(exitCode).toBe(0)
  })

  it('stops when the service reports the team as disbanded', async () => {
    const svc = await fakeService(res => { res.writeHead(200); res.end('{"team":{"status":"disbanded"}}') })
    closeService = svc.close
    start(svc.url)
    await waitFor(() => exited, 3000, 'poller exit on disbanded')
    expect(exitCode).toBe(0)
  })

  it('survives a service that is briefly unreachable', async () => {
    // Port with nothing listening: connection refused on every check.
    start('http://127.0.0.1:1', { COLLAB_POLLER_MAX_API_FAILURES: '50' })
    await new Promise(r => setTimeout(r, 1000))
    expect(exited).toBe(false)
  })

  it('stops when the service stays unreachable', async () => {
    start('http://127.0.0.1:1', { COLLAB_POLLER_MAX_API_FAILURES: '2' })
    await waitFor(() => exited, 4000, 'poller exit after repeated failures')
    expect(exitCode).toBe(0)
  })
})

describe('collab-launch.sh wiring', () => {
  it('starts the poller script instead of an inline loop', () => {
    const src = fs.readFileSync(LAUNCH, 'utf8')
    expect(src).toContain('collab-poller.sh')
    expect(src).not.toMatch(/while true; do\s*\n\s*M=\$\(wc -l/)
  })
})

describe('disbandTeam() kills the poller', () => {
  const originalDataDir = process.env.ENSEMBLE_DATA_DIR
  let tempRoot: string
  let teamId: string
  let sleeper: ChildProcess | undefined

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-poller-'))
    process.env.ENSEMBLE_DATA_DIR = tempRoot
    teamId = newTeamId()
    fs.mkdirSync(runtimeDir(teamId), { recursive: true })
  })

  afterEach(() => {
    if (sleeper && sleeper.pid && isAlive(sleeper.pid)) sleeper.kill('SIGKILL')
    sleeper = undefined
    vi.restoreAllMocks()
    vi.resetModules()
    vi.doUnmock('../lib/ensemble-registry')
    vi.doUnmock('../lib/agent-spawner')
    vi.doUnmock('../lib/hosts-config')
    vi.doUnmock('../lib/agent-runtime')
    vi.doUnmock('../lib/agent-config')
    vi.doUnmock('../lib/memory-export')
    if (originalDataDir === undefined) {
      delete process.env.ENSEMBLE_DATA_DIR
    } else {
      process.env.ENSEMBLE_DATA_DIR = originalDataDir
    }
    fs.rmSync(runtimeDir(teamId), { recursive: true, force: true })
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  it('the process in poller.pid is gone after disband', async () => {
    // Stand-in for the poller: any long-lived process whose pid is in poller.pid.
    sleeper = spawn('sleep', ['300'], { stdio: 'ignore' })
    const pid = sleeper.pid!
    fs.writeFileSync(path.join(runtimeDir(teamId), 'poller.pid'), `${pid}\n`)

    const team: EnsembleTeam = {
      id: teamId,
      name: 'poller-team',
      description: 'test',
      status: 'active',
      agents: [],
      createdBy: 'test',
      createdAt: '2026-09-03T08:00:00.000Z',
      feedMode: 'live',
    }

    vi.doMock('../lib/ensemble-registry', () => ({
      getMessages: vi.fn(() => []),
      loadTeams: vi.fn(() => [team]),
      appendMessage: vi.fn(),
      updateTeam: vi.fn((_id: string, updates: Partial<EnsembleTeam>) => ({ ...team, ...updates })),
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
      getRuntime: vi.fn(() => ({ capturePane: vi.fn(), sendKeys: vi.fn(), pasteFromFile: vi.fn() })),
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
    vi.doMock('../lib/memory-export', () => ({
      checkMemoryEndpoint: vi.fn(async () => ({ ok: true, endpoint: 'mock' })),
      exportObservation: vi.fn(async () => ({ ok: true, endpoint: 'mock' })),
      pendingExportFile: vi.fn((dir: string) => path.join(dir, 'pending-export.json')),
      resolveMemoryEndpoint: vi.fn(() => 'mock'),
    }))

    const mod = await import('../services/ensemble-service')
    expect(isAlive(pid)).toBe(true)
    await mod.disbandTeam(teamId)

    await waitFor(() => !isAlive(pid), 3000, 'poller process killed by disband')
  })
})
