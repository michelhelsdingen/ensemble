import fs from 'fs'
import path from 'path'
import { execFileSync, spawnSync } from 'child_process'
import { afterEach, beforeEach, expect, it } from 'vitest'

let root: string
let script: string
let bin: string
function stub(name: string, body: string) {
  fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 })
}
beforeEach(() => {
  root = fs.mkdtempSync(path.resolve('tmp/preflight-review-'))
  bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  fs.mkdirSync(path.join(root, 'scripts'))
  fs.mkdirSync(path.join(root, 'node_modules/tsx/dist'), { recursive: true })
  fs.writeFileSync(path.join(root, 'node_modules/tsx/dist/loader.mjs'), '')
  script = path.join(root, 'scripts/collab-preflight.sh')
  fs.writeFileSync(script, fs.readFileSync('scripts/collab-preflight.sh', 'utf8').replaceAll('/tmp/', `${root}/`))
  for (const tool of ['dirname', 'tr', 'grep', 'head', 'tail', 'cat', 'rm', 'seq']) {
    const executable = execFileSync('/bin/bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim()
    fs.symlinkSync(executable, path.join(bin, tool))
  }
  stub('node', 'printf "%s" "${NODE_NO_WARNINGS:-}" > "$TEST_ROOT/node-warnings"; printf "%s\\n" "$HEALTH_SELECTION"')
  stub('curl', 'echo \'{"credentialStore":"readable","uptimeSeconds":1}\'')
  const python = execFileSync('/bin/bash', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim()
  stub('python3', `case "$*" in *credentialStore*) echo readable ;; *uptimeSeconds*) echo 1 ;; *) if [ "$1" != - ]; then exec '${python}' "$@"; fi ;; esac`)
  stub('timeout', 'shift; exec "$@"')
  stub('sleep', 'exit 0')
  stub('codex', 'if [ "$1" = login ]; then echo "Logged in"; else echo "$CODEX_PROBE"; fi')
  stub('claude', 'exit 0')
  stub('tmux', `if [ "$1" = send-keys ] && [ "$4" = -l ]; then
  target="\${5#*> }"; target="\${target%% *}"
  case "$5" in
    *TMUXDNS_OK*) printf 'TMUXDNS_OK PROBEDONE_%s\\n' "$PPID" > "$target" ;;
    *'claude auth'*) printf '%s\\nDONE_%s\\n' "$CLAUDE_PROBE" "$PPID" > "$target" ;;
  esac
fi`)
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
function run(overrides: Record<string, string> = {}, explicit = '') {
  const result = spawnSync('/bin/bash', [script, explicit], { encoding: 'utf8', timeout: 30000, env: {
    ...process.env, PATH: bin, HOME: root, TMPDIR: root, TEST_ROOT: root,
    ENSEMBLE_URL: 'http://unused.invalid', ENSEMBLE_CONFIG: path.join(root, 'config.json'),
    ENSEMBLE_HEALTH_CMD: 'test-hook', COLLAB_AGENTS: '', COLLAB_OVERRIDE_FILE: path.join(root, 'override'),
    HEALTH_SELECTION: 'codex,claude', CODEX_PROBE: '7392', CLAUDE_PROBE: '{"loggedIn": true}', ...overrides,
  } })
  return { ...result, output: result.stdout + result.stderr }
}
it('keeps Claude alone when the hook accepts Codex but its quota probe fails', () => {
  const result = run({ CODEX_PROBE: 'usage limit' })
  expect(result.status, result.output).toBe(0)
  expect(fs.readFileSync(path.join(root, 'override'), 'utf8').trim()).toBe('claude')
})
it('keeps Codex alone when the hook accepts Claude but its auth probe is inconclusive', () => {
  const result = run({ CLAUDE_PROBE: 'inconclusive' })
  expect(result.status, result.output).toBe(0)
  expect(fs.readFileSync(path.join(root, 'override'), 'utf8').trim()).toBe('codex')
})
it('reports exit 4 for an explicitly selected Codex with a failed quota probe', () => {
  const result = run({ CODEX_PROBE: 'usage limit' }, 'codex,claude')
  expect(result.status, result.output).toBe(4)
  expect(result.output).toContain('codex')
})
it('does not restore a hook-excluded agent when a selected fallback passes but Claude fails', () => {
  const result = run({ HEALTH_SELECTION: 'glm,claude', CLAUDE_PROBE: 'inconclusive' })
  expect(result.status, result.output).toBe(0)
  expect(fs.readFileSync(path.join(root, 'override'), 'utf8').trim()).toBe('glm')
})
it('sets NODE_NO_WARNINGS for the configured health helper', () => {
  const result = run()
  expect(result.status, result.output).toBe(0)
  expect(fs.readFileSync(path.join(root, 'node-warnings'), 'utf8')).toBe('1')
})
it.each([undefined, '', '   ', null])('does not start Node without a usable configured healthCommand: %j', command => {
  if (command !== undefined) fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ healthCommand: command }))
  const result = run({ ENSEMBLE_HEALTH_CMD: '  ' })
  expect(result.status, result.output).toBe(0)
  expect(fs.existsSync(path.join(root, 'node-warnings'))).toBe(false)
})

it('warns clearly when a config exists but python3 is unavailable', () => {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ healthCommand: 'probe' }))
  fs.rmSync(path.join(bin, 'python3'), { force: true })
  const result = run({ ENSEMBLE_HEALTH_CMD: ' ' })
  expect(result.output.match(/python3.*config|config.*python3/gi)).toHaveLength(1)
})
it('warns and continues with the normal probes when Node exists but tsx is missing', () => {
  fs.rmSync(path.join(root, 'node_modules'), { recursive: true })
  const result = run()
  expect(result.status, result.output).toBe(0)
  expect(result.output).toContain('tsx is unavailable')
  expect(result.output).toContain('Codex works')
  expect(fs.existsSync(path.join(root, 'node-warnings'))).toBe(false)
})
