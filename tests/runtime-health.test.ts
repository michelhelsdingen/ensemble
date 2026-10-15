import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { checkRuntimeHealth } from '../lib/runtime-health'

describe('checkRuntimeHealth', () => {
  const paths = { execPath: '/node', templatesPath: '/repo/collab-templates.json' }

  it('rejects a missing executable even when the repository is readable', () => {
    expect(checkRuntimeHealth({ ...paths, exists: () => false, readFile: () => {} })).toEqual({
      executable: 'missing', repoRead: 'readable', spawnReady: false,
    })
  })

  it('reports the error code when the repository read fails', () => {
    const error = Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    const result = checkRuntimeHealth({ ...paths, exists: () => true, readFile: () => { throw error } })
    expect(result.executable).toBe('present')
    expect(result.repoRead).toBe('unreachable')
    expect(result.spawnReady).toBe(false)
    expect(result.detail).toContain('EPERM')
  })

  it('accepts an existing executable and readable repository', () => {
    expect(checkRuntimeHealth({ ...paths, exists: () => true, readFile: () => {} })).toEqual({
      executable: 'present', repoRead: 'readable', spawnReady: true,
    })
  })
})

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('No test port'))
      server.close(error => error ? reject(error) : resolve(address.port))
    })
    server.on('error', reject)
  })
}

describe('service health payload', () => {
  const originalEnv = { ...process.env }
  let tempRoot: string
  let baseUrl: string

  beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-runtime-health-'))
    baseUrl = `http://127.0.0.1:${await freePort()}`
    process.env.ENSEMBLE_DATA_DIR = tempRoot
    process.env.ENSEMBLE_PORT = new URL(baseUrl).port
    vi.resetModules()
    await import('../server')
  })

  afterAll(() => {
    process.env = originalEnv
    fs.rmSync(tempRoot, { recursive: true, force: true })
    vi.resetModules()
  })

  it('keeps the existing health fields and adds runtime readiness', async () => {
    let response: Response | undefined
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        response = await fetch(`${baseUrl}/api/v1/health`)
        break
      } catch {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    expect(response?.ok).toBe(true)
    const body = await response!.json()
    expect(body.status).toBe('healthy')
    expect(['readable', 'unreachable']).toContain(body.credentialStore)
    expect(body.executable).toBe('present')
    expect(body.repoRead).toBe('readable')
    expect(body.spawnReady).toBe(true)
  })
})
