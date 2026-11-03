import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'

const execFileAsync = promisify(execFile)
const preflight = path.resolve(process.cwd(), 'scripts/collab-preflight.sh')
let root: string
let server: http.Server | undefined

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-runtime-preflight-'))
  const python = execFileSync('/bin/bash', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim()
  fs.writeFileSync(path.join(root, 'python3'), `#!/bin/bash\nif [ "$1" = '-' ]; then exit 0; fi\nexec '${python}' "$@"\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(root, 'tmux'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
  fs.writeFileSync(path.join(root, 'launchctl'), `#!/bin/bash\nif [ "$1" = kickstart ]; then touch '${root}/restarted'; fi\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(root, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
})

afterEach(() => {
  server?.close()
  server = undefined
  fs.rmSync(root, { recursive: true, force: true })
})

async function runPreflight(health: () => object, teams: object): Promise<{ code: number; output: string }> {
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/v1/health') return res.end(JSON.stringify(health()))
    if (req.url === '/api/ensemble/teams') return res.end(JSON.stringify(teams))
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test port')
  try {
    const result = await execFileAsync(preflight, ['none'], {
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        ENSEMBLE_URL: `http://127.0.0.1:${address.port}`,
        COLLAB_OVERRIDE_FILE: path.join(root, 'override'),
      },
      timeout: 10000,
    })
    return { code: 0, output: result.stdout + result.stderr }
  } catch (error: unknown) {
    const result = error as { code?: number; stdout?: string; stderr?: string }
    return { code: result.code ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
  }
}

describe('preflight runtime health', () => {
  it('keeps an active team and blocks spawning on stale runtime', async () => {
    const result = await runPreflight(
      () => ({ status: 'healthy', credentialStore: 'readable', uptimeSeconds: 1, executable: 'missing', repoRead: 'unreachable', spawnReady: false, detail: 'EPERM' }),
      { teams: [{ id: 'team-1', status: 'active' }] },
    )
    expect(result.code).toBe(8)
    expect(result.output).toMatch(/team.*ontbinden/i)
    expect(result.output).toContain('EPERM')
    expect(fs.existsSync(path.join(root, 'restarted'))).toBe(false)
  })

  it('restarts the service without active teams and waits for spawn readiness', async () => {
    const result = await runPreflight(
      () => ({ status: 'healthy', credentialStore: 'readable', uptimeSeconds: 1, executable: fs.existsSync(path.join(root, 'restarted')) ? 'present' : 'missing', repoRead: 'readable', spawnReady: fs.existsSync(path.join(root, 'restarted')) }),
      { teams: [{ id: 'old-team', status: 'disbanded' }] },
    )
    expect(fs.existsSync(path.join(root, 'restarted'))).toBe(true)
    expect(result.output).toMatch(/service.*herstart/i)
    expect(result.code).not.toBe(8)
  })

  // 03-11-2026: elke fix in de servicecode stond in git en in de tests, maar de
  // service draaide al elf uur en kende er niets van. De eerste rookproef
  // mislukte daarop: oude gereedheidslogica, een stille vervanger, en geen van
  // de nieuwe velden. Preflight hoort dat te zien.
  it('herstart een service die ouder is dan de servicecode', async () => {
    const result = await runPreflight(
      () => ({
        status: 'healthy', credentialStore: 'readable',
        uptimeSeconds: fs.existsSync(path.join(root, 'restarted')) ? 2 : 90_000,
        executable: 'present', repoRead: 'readable', spawnReady: true,
      }),
      { teams: [{ id: 'old-team', status: 'disbanded' }] },
    )
    expect(fs.existsSync(path.join(root, 'restarted'))).toBe(true)
    expect(result.output).toMatch(/ouder dan de servicecode|verouderde code/i)
    expect(result.code).not.toBe(8)
  })

  it('laat een oude service met een actief team met rust en waarschuwt alleen', async () => {
    const result = await runPreflight(
      () => ({
        status: 'healthy', credentialStore: 'readable', uptimeSeconds: 90_000,
        executable: 'present', repoRead: 'readable', spawnReady: true,
      }),
      { teams: [{ id: 'team-1', status: 'active' }] },
    )
    expect(fs.existsSync(path.join(root, 'restarted'))).toBe(false)
    expect(result.output).toMatch(/ouder dan de servicecode|verouderde code/i)
  })

  it('zegt niets over de leeftijd als de service jonger is dan de code', async () => {
    const result = await runPreflight(
      () => ({
        status: 'healthy', credentialStore: 'readable', uptimeSeconds: 30,
        executable: 'present', repoRead: 'readable', spawnReady: true,
      }),
      { teams: [{ id: 'old-team', status: 'disbanded' }] },
    )
    expect(result.output).not.toMatch(/ouder dan de servicecode/i)
    expect(fs.existsSync(path.join(root, 'restarted'))).toBe(false)
  })

  it('warns and continues when an old service has no runtime fields', async () => {
    const result = await runPreflight(
      () => ({ status: 'healthy', credentialStore: 'readable', uptimeSeconds: 1 }),
      { teams: [{ id: 'team-1', status: 'active' }] },
    )
    expect(result.output).toMatch(/oude health.*herstart/i)
    expect(result.code).not.toBe(8)
    expect(fs.existsSync(path.join(root, 'restarted'))).toBe(false)
  })
})
