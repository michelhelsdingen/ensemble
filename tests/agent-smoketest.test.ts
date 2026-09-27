import { execFileSync, spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const hasTmux = (() => {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true } catch { return false }
})()

describe.skipIf(!hasTmux)('agent smoketest with isolated tmux sockets', () => {
  let base: string
  let configPath: string
  let bin: string

  beforeAll(() => {
    base = fs.mkdtempSync('/tmp/ens-test-')
    bin = path.join(base, 'bin')
    fs.mkdirSync(bin)
    configPath = path.join(base, 'agents.json')
    const scripts: Record<string, string> = {
      ready: '#!/bin/sh\nif [ "$1" = --version ]; then echo "ready-cli 1.2"; exit 0; fi\n[ "$1" = --alpha ] && [ "$2" = value ] && [ "$TEST_VALUE" = forwarded ] && [ -z "$OPENAI_BLOCKED" ] || exit 9\necho READY_MARKER\nwhile :; do sleep 1; done\n',
      waiting: '#!/bin/sh\nif [ "$1" = --version ]; then exit 2; fi\nfor n in 1 2 3 4 5 6; do echo "screen line $n"; done\nwhile :; do sleep 1; done\n',
      broken: '#!/bin/sh\nif [ "$1" = --version ]; then exit 2; fi\necho launch failed\nexit 7\n',
    }
    for (const [name, body] of Object.entries(scripts)) fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 })
    const agent = (command: string, marker: string, flags: string[] = [], unsetEnv?: string[]) => ({
      name: command, command, flags, readyMarker: marker, inputMethod: 'sendKeys', color: 'white', icon: '*', ...(unsetEnv && { unsetEnv }),
    })
    fs.writeFileSync(configPath, JSON.stringify({
      ready: agent('ready', 'READY_MARKER', ['--alpha', 'value'], ['OPENAI_BLOCKED']),
      waiting: agent('waiting', 'EXPECTED_MARKER'),
      broken: agent('broken', 'EXPECTED_MARKER'),
      absent: agent('absent-test-command', 'EXPECTED_MARKER'),
    }))
    fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({ agentEnv: { TEST_VALUE: 'forwarded', OPENAI_BLOCKED: 'restored' } }))
  })

  afterAll(() => { if (base) fs.rmSync(base, { recursive: true, force: true }) })

  const run = (keys: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(path.join(process.cwd(), 'node_modules/.bin/tsx'), ['scripts/agent-smoketest.ts', ...keys, '--timeout', '1'], {
      cwd: process.cwd(), env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ENSEMBLE_AGENTS_CONFIG: configPath, ENSEMBLE_CONFIG: path.join(base, 'config.json'), OPENAI_BLOCKED: 'inherited', SHELL: '/bin/bash' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
  })

  it('reports ready, missing, timeout and crash without a real AI CLI', async () => {
    const { code, stdout, stderr } = await run(['ready', 'waiting', 'broken', 'absent'])
    expect(code).toBe(1)
    const results = JSON.parse(stdout)
    expect(results.ready.status).toBe('ok')
    expect(results.ready.version).toBe('ready-cli 1.2')
    expect(results.waiting.status).toBe('no-ready-marker')
    expect(results.waiting.detail).toContain('screen line 6')
    expect(results.waiting.detail).not.toContain('screen line 1')
    expect(results.broken.status).toBe('crashed')
    expect(results.absent.status).toBe('missing')
    expect(stderr).toContain('ready=ok')
  }, 15000)

  it('exits successfully when selected agents are ready or missing', async () => {
    const { code, stdout } = await run(['ready', 'absent'])
    expect(code).toBe(0)
    expect(Object.keys(JSON.parse(stdout))).toEqual(['ready', 'absent'])
  }, 15000)
})
