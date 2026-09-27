import fs from 'fs'
import path from 'path'
import { execFileSync, spawnSync } from 'child_process'
import { afterAll, expect, it } from 'vitest'

const root = fs.mkdtempSync(path.resolve('tmp/preflight-hook-'))
const preflight = path.resolve('scripts/collab-preflight.sh')
const node = process.execPath
for (const tool of ['bash', 'dirname', 'tr', 'mkdir']) {
  fs.symlinkSync(execFileSync('/bin/bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim(), path.join(root, tool))
}
fs.symlinkSync(node, path.join(root, 'node'))
fs.writeFileSync(path.join(root, 'curl'), '#!/bin/bash\nexit 1\n', { mode: 0o755 })
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
function run(explicit: string, health: unknown, overrides: NodeJS.ProcessEnv = {}) {
  const file = path.join(root, 'health.cjs')
  fs.writeFileSync(file, `console.log(${JSON.stringify(JSON.stringify(health))})`)
  return spawnSync('/bin/bash', [preflight, explicit], { encoding: 'utf8', env: {
    ...process.env, PATH: root, HOME: root, TMPDIR: root,
    ENSEMBLE_CONFIG: path.join(root, 'absent'), ENSEMBLE_URL: 'http://unused.invalid',
    ENSEMBLE_HEALTH_CMD: `${JSON.stringify(node)} ${JSON.stringify(file)}`,
    COLLAB_AGENTS: '', COLLAB_OVERRIDE_FILE: path.join(root, 'override'), ...overrides,
  } })
}
it('returns exit 7 for an explicitly unavailable agent before other probes', () => {
  const result = run('gemini', { gemini: { status: 'down' }, glm: { status: 'ok' } })
  expect(result.status).toBe(7)
  expect(result.stderr).toContain('Healthy agents: glm')
})
it('reports default substitution before checking the service', () => {
  const result = run('', { codex: { status: 'limit' }, claude: { status: 'ok' }, glm: { status: 'ok' } })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Auto-fallback: codex -> glm')
})
it('treats plan agents as automatic for the health hook', () => {
  const result = run('codex,mimo', { codex: { status: 'down' }, mimo: { status: 'ok' }, glm: { status: 'ok' } }, {
    COLLAB_AGENTS_SOURCE: 'plan',
  })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Auto-fallback: codex -> glm')
  expect(result.stderr).not.toContain('Requested agents unavailable: codex')
})
it('warns without blocking unknown status', () => {
  const result = run('opencode', {})
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('opencode: unknown')
})
it('persists the full healthy default selection after successful preflight', () => {
  const python = execFileSync('/bin/bash', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim()
  fs.writeFileSync(path.join(root, 'python3'), `#!/bin/bash\nif [ "$1" = "-" ]; then exit 0; fi\nexec '${python}' "$@"\n`, { mode: 0o755 })
  for (const tool of ['seq', 'grep', 'cat']) fs.symlinkSync(execFileSync('/bin/bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim(), path.join(root, tool))
  for (const tool of ['tmux', 'sleep', 'rm']) fs.writeFileSync(path.join(root, tool), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
  fs.writeFileSync(path.join(root, 'curl'), '#!/bin/bash\necho \'{"credentialStore":"readable","uptimeSeconds":1}\'\n', { mode: 0o755 })
  const result = run('', { codex: { status: 'down' }, claude: { status: 'limit' }, glm: { status: 'ok' }, grok: { status: 'down' }, gemini: { status: 'ok' } })
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(fs.readFileSync(path.join(root, 'override'), 'utf8').trim()).toBe('glm,gemini')
  const plannedResult = run('codex,mimo', { codex: { status: 'down' }, mimo: { status: 'ok' }, glm: { status: 'ok' } }, {
    COLLAB_AGENTS_SOURCE: 'plan',
  })
  expect(plannedResult.status, plannedResult.stdout + plannedResult.stderr).toBe(0)
  expect(fs.readFileSync(path.join(root, 'override'), 'utf8').trim()).toBe('glm,mimo')
  const runtime = path.join(root, 'custom-runtime')
  const defaultResult = run('', { codex: { status: 'down' }, claude: { status: 'limit' }, glm: { status: 'ok' }, grok: { status: 'down' }, gemini: { status: 'ok' } }, {
    COLLAB_RUNTIME_ROOT: runtime, COLLAB_OVERRIDE_FILE: '',
  })
  expect(defaultResult.status, defaultResult.stdout + defaultResult.stderr).toBe(0)
  expect(fs.readFileSync(path.join(runtime, 'collab-agents-override.txt'), 'utf8').trim()).toBe('glm,gemini')
})

it('treats COLLAB_AGENTS as a default set with fallback, not as an explicit choice', () => {
  const file = path.join(root, 'health-default.cjs')
  fs.writeFileSync(file, `console.log(${JSON.stringify(JSON.stringify({ codex: { status: 'down' }, claude: { status: 'ok' }, grok: { status: 'ok' }, glm: { status: 'ok' } }))})`)
  const result = spawnSync('/bin/bash', [preflight], { encoding: 'utf8', env: {
    ...process.env, PATH: root, HOME: root, TMPDIR: root,
    ENSEMBLE_CONFIG: path.join(root, 'absent'), ENSEMBLE_URL: 'http://unused.invalid',
    ENSEMBLE_HEALTH_CMD: `${JSON.stringify(node)} ${JSON.stringify(file)}`,
    COLLAB_AGENTS: 'codex,claude,grok', COLLAB_OVERRIDE_FILE: path.join(root, 'override-default'),
  } })
  expect(result.status).not.toBe(7)
  expect(result.stderr).toContain('Auto-fallback: codex -> glm')
})
