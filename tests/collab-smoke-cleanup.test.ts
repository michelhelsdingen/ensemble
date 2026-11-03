import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SMOKE = path.resolve(process.cwd(), 'scripts/collab-smoke.sh')

let root: string
let bin: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-smoke-'))
  bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/bash\necho "smoketeam-agent: 1 windows"\n', { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/bash
printf 'worktree /tmp/smoke-team-agent\\nbranch refs/heads/collab/smoke-team/agent-1\\n'
`, { mode: 0o755 })
})

afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

describe('collab-smoke opruimcontrole', () => {
  it('faalt als bridge of poller nog leeft of een team-worktree overblijft', () => {
    const runtimeDir = path.join(root, 'runtime', 'smoke-team')
    fs.mkdirSync(runtimeDir, { recursive: true })
    fs.writeFileSync(path.join(runtimeDir, 'bridge.pid'), String(process.pid))
    fs.writeFileSync(path.join(runtimeDir, 'poller.pid'), String(process.pid))
    const bron = fs.readFileSync(SMOKE, 'utf8')
    const functie = bron.match(/^(team_cleanup_residuals\(\) \{[\s\S]*?^\})/m)?.[1] ?? ''
    const runner = path.join(root, 'controleer-opruiming.sh')
    fs.writeFileSync(runner, `#!/bin/bash
${functie}
team_cleanup_residuals smoketeam smoke-team "${path.join(root, 'runtime', 'smoke-team')}" "${root}"
`, { mode: 0o755 })
    let uitvoer = ''
    let exitCode = 0
    try {
      uitvoer = execFileSync(runner, [], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error: unknown) {
      const err = error as { stdout?: string; stderr?: string; status?: number }
      uitvoer = `${err.stdout ?? ''}${err.stderr ?? ''}`
      exitCode = err.status ?? 1
    }

    expect(exitCode).toBe(1)
    expect(uitvoer).toMatch(/bridge.*draait|bridge.*over/i)
    expect(uitvoer).toMatch(/poller.*draait|poller.*over/i)
    expect(uitvoer).toMatch(/worktree/i)
  })
})
