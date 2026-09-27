import fs from 'fs'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const SRC = fs.readFileSync(path.resolve(process.cwd(), 'lib/agent-config.ts'), 'utf8')

describe('env-forwarding', () => {
  it('escapet de waarde', () => {
    expect(SRC).not.toMatch(/export \$\{key\}="\$\{value\}"/)
    expect(SRC).toMatch(/export \$\{key\}=\$\{shellEscape\(value/)
  })
})

import { spawnLocalAgent } from '../lib/agent-spawner'

let root: string | undefined
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  if (root) fs.rmSync(root, { recursive: true, force: true })
})

it('delivers configured values to each agent even with a stale tmux server environment', async () => {
  root = fs.mkdtempSync(path.resolve('tmp/spawner-env-'))
  const output = path.join(root, 'received.json')
  const probe = path.join(root, 'probe.cjs')
  const config = path.join(root, 'config.json')
  const agents = path.join(root, 'agents.json')
  const tricky = "spaces ' quotes \" double $HOME $(false) `false`; literal"
  fs.writeFileSync(config, JSON.stringify({ agentEnv: { MY_TOOL_NESTED: tricky, OPENAI_ENV_TEST: 'configured', EMPTY: '' } }))
  fs.writeFileSync(agents, JSON.stringify({ probe: { name: 'Probe', command: process.execPath, flags: [probe] } }))
  fs.writeFileSync(probe, `require('fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({ nested: process.env.MY_TOOL_NESTED, override: process.env.OPENAI_ENV_TEST, empty: process.env.EMPTY }))`)
  // Only the sent pane command reaches this shell. The server environment is stale.
  fs.writeFileSync(path.join(root, 'tmux'), `#!/bin/bash
if [ "$1" = new-session ]; then exit 0; fi
if [ "$1" = send-keys ] && [ "$4" = -l ]; then
  exec /usr/bin/env -i PATH=/usr/bin:/bin MY_TOOL_NESTED=stale OPENAI_ENV_TEST=stale EMPTY=stale /bin/bash -c 'nocorrect() { "$@"; }; eval "$1"' fake-pane "$5"
fi
exit 1
`, { mode: 0o755 })
  vi.stubEnv('PATH', `${root}:${process.env.PATH}`)
  vi.stubEnv('ENSEMBLE_CONFIG', config)
  vi.stubEnv('ENSEMBLE_AGENTS_CONFIG', agents)
  vi.stubEnv('OPENAI_ENV_TEST', 'parent')
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  for (const name of ['env-agent-1', 'env-agent-2']) {
    await spawnLocalAgent({ name, program: 'probe', workingDirectory: root, hostId: 'local' })
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toEqual({ nested: tricky, override: 'configured', empty: '' })
    fs.unlinkSync(output)
  }
  expect(JSON.stringify(log.mock.calls)).not.toContain(tricky)
})
