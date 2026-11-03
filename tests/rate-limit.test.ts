import fs from 'fs'
import os from 'os'
import path from 'path'
import net from 'net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// De teamstart in beforeAll wacht sinds 03-11-2026 op stabiele gereedheid en
// bevestigt de aflevering, dus de standaard hook-timeout van 10s is te kort.
vi.setConfig({ hookTimeout: 40_000 })

// server.ts had `path.startsWith('/api/ensemble/')` as its rate-limit
// exemption, which matches every route this server has: the limit of 100
// per minuut was volledig dode code. De vervangende uitzondering moet alleen
// de routes vrijstellen die pollers echt raken. Dat bleek breder te zijn dan
// alleen de feed-route: cli/monitor.ts poll elke 2s zowel de feed als het
// kale team-detail-endpoint (GET /api/ensemble/teams/:id), en met meer dan
// één open monitor (heel normaal bij meerdere gelijktijdige teams) loopt dat
// samen ruim over de 100/min heen, allemaal vanaf hetzelfde lokale IP.
// collab-poller.sh raakt de feed-route zelf niet: die leest messages.jsonl
// rechtstreeks van schijf en pingt maar één keer per minuut het team-detail-
// endpoint. team-read.sh raakt wel de feed-route, op het tempo van de agent.

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
      srv.close(err => (err ? reject(err) : resolve(port)))
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

describe('rate limiting', () => {
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
  let teamId: string

  beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-ratelimit-'))
    port = await getFreePort()
    baseUrl = `http://127.0.0.1:${port}`

    process.env.ENSEMBLE_DATA_DIR = tempRoot
    process.env.ENSEMBLE_PORT = String(port)
    process.env.ENSEMBLE_URL = baseUrl

    vi.resetModules()
    vi.doMock('../lib/agent-spawner', () => ({
      spawnLocalAgent: vi.fn(async ({ name, program, workingDirectory, hostId }) => ({
        id: `${name}-id`, name, program, sessionName: name, workingDirectory, hostId,
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

    const createRes = await fetch(`${baseUrl}/api/ensemble/teams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'rate-limit-team',
        description: 'test',
        agents: [{ program: 'codex', role: 'lead' }, { program: 'claude', role: 'worker' }],
        workingDirectory: process.cwd(),
      }),
    })
    const created = await createRes.json()
    teamId = created.team.id
  })

  afterAll(async () => {
    process.env = originalEnv
    fs.rmSync(tempRoot, { recursive: true, force: true })
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it('feed en team-detail blijven vrij, de lijst-route niet', async () => {
    // Ruim over de 100/min: precies wat twee open monitors + een agent die
    // team-read.sh draait, samen op hetzelfde lokale IP produceren.
    let pollersRateLimited = false
    for (let i = 0; i < 110; i++) {
      const [feedRes, teamRes] = await Promise.all([
        fetch(`${baseUrl}/api/ensemble/teams/${teamId}/feed`),
        fetch(`${baseUrl}/api/ensemble/teams/${teamId}`),
      ])
      if (feedRes.status === 429 || teamRes.status === 429) pollersRateLimited = true
    }
    expect(pollersRateLimited, 'feed en team-detail zijn poll-doelen en moeten vrij blijven').toBe(false)

    // De lijst-route is geen poll-doel (alleen `ensemble team list` en de
    // team-picker raken hem, eenmalig) en moet dus wél gelimiteerd blijven.
    let listRateLimited = false
    for (let i = 0; i < 105; i++) {
      const res = await fetch(`${baseUrl}/api/ensemble/teams`)
      if (res.status === 429) { listRateLimited = true; break }
    }
    expect(listRateLimited, 'de lijst-route moet na 100 GETs alsnog een 429 geven').toBe(true)
  })
})
