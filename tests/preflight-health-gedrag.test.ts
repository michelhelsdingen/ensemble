/** Draai de echte preflight met een health-server en geisoleerde CLI-tools. */
import fs from 'fs'
import os from 'os'
import http from 'http'
import path from 'path'
import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const PREFLIGHT = path.resolve(process.cwd(), 'scripts/collab-preflight.sh')
const python = execFileSync('/bin/bash', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim()
let server: http.Server | undefined
let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-preflight-'))
  // Alleen deze tools staan in PATH: geen echte agents of launchctl/tmux.
  for (const tool of ['bash', 'curl', 'tr', 'id', 'seq', 'rm', 'grep', 'cat', 'pgrep', 'head', 'ps', 'xargs', 'date']) {
    const executable = execFileSync('/bin/bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim()
    fs.symlinkSync(executable, path.join(root, tool))
  }
  // Een verse checkout is nieuwer dan de fictieve service met 7200s uptime.
  // Houd de aparte controle op verouderde servicecode buiten deze health-test.
  stub('python3', `if [ "$1" = "-" ]; then exit 0; fi\nif [ "$1" = "-c" ] && [[ "$2" == *"wortel = sys.argv[1]"* ]]; then echo 0; exit 0; fi\nexec '${python}' "$@"`)
  stub('tmux', 'exit 0')
  stub('sleep', 'exit 0')
})
afterEach(() => {
  server?.close()
  server = undefined
  fs.rmSync(root, { recursive: true, force: true })
})

function stub(name: string, body: string): void {
  fs.rmSync(path.join(root, name), { force: true })
  fs.writeFileSync(path.join(root, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 })
}

async function nepServer(body: unknown): Promise<string> {
  server = http.createServer((req, res) => {
    if (req.url === '/api/v1/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const adres = server!.address()
  if (typeof adres === 'string' || !adres) throw new Error('geen poort gekregen')
  return `http://127.0.0.1:${adres.port}`
}

async function draaiPreflight(url: string): Promise<{ out: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(PREFLIGHT, ['codex'], {
      env: {
        ...process.env,
        HOME: root,
        PATH: root,
        ENSEMBLE_URL: url,
        ENSEMBLE_LAUNCHD_LABEL: 'dev.ensemble.test-bestaat-niet',
        COLLAB_OVERRIDE_FILE: path.join(root, 'override'),
      },
      encoding: 'utf8',
      timeout: 10000,
    })
    return { out: `${stdout}${stderr}`, code: 0 }
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; code?: number }
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.code ?? 1 }
  }
}

describe('preflight gebruikt de health-uitvraag', () => {
  it('meldt de service gezond als de opslag leesbaar is, zonder over leeftijd te beginnen', async () => {
    const url = await nepServer({ status: 'healthy', credentialStore: 'readable', uptimeSeconds: 7200 })
    const { out } = await draaiPreflight(url)
    expect(out).toMatch(/komt bij de credential-opslag/i)
    expect(out).not.toMatch(/val terug op de leeftijdscheck/i)
  })

  it('valt terug op de leeftijdscheck als het veld ontbreekt', async () => {
    stub('pgrep', 'exit 1')
    const url = await nepServer({ status: 'healthy', version: '1.0.0' })
    const { out } = await draaiPreflight(url)
    expect(out).toMatch(/val terug op de leeftijdscheck/i)
  })

  it('waarschuwt zonder launchd-target en laat de ontbrekende CLI de exitcode bepalen', async () => {
    const url = await nepServer({ status: 'healthy', credentialStore: 'unreachable' })
    const { out, code } = await draaiPreflight(url)
    expect(out).toMatch(/geen launchd-target/i)
    expect(out).not.toMatch(/val terug op de leeftijdscheck/i)
    expect(out).toContain('codex binary not in PATH')
    expect(code).toBe(4)
  })

  it('herstart via launchd als het target bestaat en gaat daarna door naar de CLI-controle', async () => {
    stub('launchctl', `echo "$*" >> '${root}/launchctl.log'\nexit 0`)
    const url = await nepServer({ status: 'healthy', credentialStore: 'unreachable' })
    const { out, code } = await draaiPreflight(url)
    expect(fs.readFileSync(path.join(root, 'launchctl.log'), 'utf8')).toContain('kickstart -k gui/')
    expect(out).toContain('Ensemble service restarted')
    expect(out).toContain('codex binary not in PATH')
    expect(code).toBe(4)
  })
})
