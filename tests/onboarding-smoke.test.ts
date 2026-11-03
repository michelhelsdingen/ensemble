import fs from 'fs'
import os from 'os'
import path from 'path'
import net from 'net'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const execFileAsync = promisify(execFile)

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to reserve a test port'))
        return
      }

      const { port } = address
      srv.close(err => {
        if (err) reject(err)
        else resolve(port)
      })
    })
    srv.on('error', reject)
  })
}

async function waitForHealthy(baseUrl: string): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < 5000) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/health`)
      if (response.ok) return
    } catch {
      // Server may still be starting.
    }

    await new Promise(resolve => setTimeout(resolve, 100))
  }

  throw new Error(`Server did not become healthy at ${baseUrl}`)
}

describe('onboarding smoke test', () => {
  const originalEnv = { ...process.env }
  const runtime = {
    capturePane: vi.fn(async () => '>'),
    sendKeys: vi.fn(async () => {}),
    pasteFromFile: vi.fn(async () => {}),
    createSession: vi.fn(async () => {}),
    killSession: vi.fn(async () => {}),
  }

  let tempRoot: string
  let port: number
  let baseUrl: string
  beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-onboarding-'))
    port = await getFreePort()
    baseUrl = `http://127.0.0.1:${port}`

    process.env.ENSEMBLE_DATA_DIR = tempRoot
    process.env.ENSEMBLE_PORT = String(port)
    process.env.ENSEMBLE_URL = baseUrl

    vi.resetModules()
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
    vi.doMock('../lib/hosts-config', () => ({
      isSelf: vi.fn(() => true),
      getHostById: vi.fn(() => ({ id: 'local', url: baseUrl })),
      getSelfHostId: vi.fn(() => 'local'),
    }))

    await import('../server')
    await waitForHealthy(baseUrl)
  })

  afterAll(async () => {
    process.env = originalEnv
    fs.rmSync(tempRoot, { recursive: true, force: true })
    vi.resetModules()
    vi.restoreAllMocks()
  })

  // 20s: een echte teamstart wacht tot de gereedheid van elke agent 2s aanhoudt.
  it('supports the documented quick start through health, CLI, and first team creation', async () => {
    const cliPath = path.resolve(process.cwd(), 'cli/ensemble.ts')
    const tsxPath = path.resolve(process.cwd(), 'node_modules/.bin/tsx')
    const cliEnv = {
      ...process.env,
      ENSEMBLE_URL: baseUrl,
      ENSEMBLE_PORT: String(port),
      ENSEMBLE_DATA_DIR: tempRoot,
    }

    const healthResponse = await fetch(`${baseUrl}/api/v1/health`)
    expect(healthResponse.status).toBe(200)
    await expect(healthResponse.json()).resolves.toMatchObject({
      status: 'healthy',
      version: '1.0.0',
    })

    const statusOutput = (await execFileAsync(tsxPath, [cliPath, 'status'], {
      cwd: process.cwd(),
      env: cliEnv,
      encoding: 'utf8',
    })).stdout
    expect(statusOutput).toContain('Server healthy')
    expect(statusOutput).toContain('0 total,')

    const teamsBeforeOutput = (await execFileAsync(tsxPath, [cliPath, 'teams'], {
      cwd: process.cwd(),
      env: cliEnv,
      encoding: 'utf8',
    })).stdout
    expect(teamsBeforeOutput).toContain('No teams found')

    const createResponse = await fetch(`${baseUrl}/api/ensemble/teams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'my-first-team',
        description: 'Review the README and suggest improvements',
        agents: [
          { program: 'codex', role: 'lead' },
          { program: 'claude', role: 'worker' },
        ],
        workingDirectory: process.cwd(),
      }),
    })

    expect(createResponse.status).toBe(201)
    const createPayload = await createResponse.json()
    expect(createPayload.team).toMatchObject({
      name: 'my-first-team',
      status: expect.stringMatching(/forming|active/),
    })
    expect(createPayload.team.agents).toHaveLength(2)

    const teamsAfterOutput = (await execFileAsync(tsxPath, [cliPath, 'teams'], {
      cwd: process.cwd(),
      env: cliEnv,
      encoding: 'utf8',
    })).stdout
    expect(teamsAfterOutput).toContain('my-first-team')
    expect(teamsAfterOutput).toContain('codex-1')
    expect(teamsAfterOutput).toContain('claude-2')
  }, 20_000)
})
