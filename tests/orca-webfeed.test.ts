import fs from 'fs'
import path from 'path'
import http from 'http'
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { afterEach, describe, expect, it } from 'vitest'

const repo = process.cwd()
const mode = path.join(repo, 'scripts/collab-monitor-mode.sh')
const opener = path.join(repo, 'scripts/open-orca-webfeed.sh')
const orphans = path.join(repo, 'scripts/collab-orphans.sh')
const server = path.join(repo, 'scripts/orca-webfeed-server.py')
const roots: string[] = []
const children: ChildProcess[] = []

function fixture() {
  const root = fs.mkdtempSync(path.join(repo, '.webfeed-test-'))
  roots.push(root)
  const runtime = path.join(root, 'runtime')
  const team = path.join(runtime, 'team-1')
  fs.mkdirSync(team, { recursive: true })
  fs.writeFileSync(path.join(team, 'messages.jsonl'), JSON.stringify({ from: 'codex-1', to: 'claude-2', timestamp: '2026-11-23T20:00:00Z', content: 'Hallo' }) + '\n')
  return { root, runtime, team }
}

async function waitFor(check: () => boolean, timeout = 4000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('timeout')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

function get(port: number, route: string): Promise<{ status: number; body: string; host: string }> {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: route }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode || 0, body, host: response.socket.localAddress || '' }))
    }).on('error', reject)
  })
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGTERM')
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('monitor mode', () => {
  it('keeps existing routes and selects a bot chat only without a terminal pane', () => {
    const { root } = fixture()
    const bot = path.join(root, '.orca/bots/example')
    fs.mkdirSync(bot, { recursive: true })
    const bin = path.join(root, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'orca'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    fs.writeFileSync(path.join(bin, 'herdr'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const run = (vars: Record<string, string>, cwd = bot) => {
      const result = spawnSync('bash', [mode, cwd], {
        encoding: 'utf8', env: { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}`, COLLAB_MONITOR: 'auto', HERDR_ENV: '', ORCA_AGENT_PANE: '', TMUX: '', TERM_PROGRAM: '', ORCA_STRUCTURED_SESSION: '', ...vars },
      })
      expect(result.status, result.stderr).toBe(0)
      return result.stdout.trim()
    }
    expect(run({})).toBe('orca-webfeed')
    expect(run({ ORCA_AGENT_PANE: 'tab:leaf' })).toBe('orca')
    expect(run({ HERDR_ENV: '1' })).toBe('herdr')
    expect(run({ TMUX: '/tmp/tmux' })).toBe('split')
    expect(run({ TERM_PROGRAM: 'iTerm.app' })).toBe(process.platform === 'darwin' ? 'iterm' : 'session')
    expect(run({ TERM_PROGRAM: 'iTerm.app' }, root)).toBe(process.platform === 'darwin' ? 'iterm' : 'session')
    expect(run({}, root)).toBe('session')
    expect(run({ ORCA_STRUCTURED_SESSION: '1' }, root)).toBe('orca-webfeed')
  })
})

describe('one-team webfeed server', () => {
  it('binds locally, serves only the page and one log, and exits after finish', async () => {
    const { runtime, team, root } = fixture()
    const outside = path.join(root, 'secret')
    fs.writeFileSync(outside, 'private')
    const child = spawn('python3', [server, 'team-1'], {
      env: { ...process.env, COLLAB_RUNTIME_ROOT: runtime, COLLAB_WEBFEED_GRACE_SECONDS: '0.5', COLLAB_WEBFEED_MAX_SECONDS: '5' }, stdio: 'ignore',
    })
    children.push(child)
    await waitFor(() => fs.existsSync(path.join(team, 'webfeed.port')))
    const port = Number(fs.readFileSync(path.join(team, 'webfeed.port'), 'utf8'))
    expect(port).toBeGreaterThan(0)
    expect((await get(port, '/')).body).toContain('Collab livefeed')
    const log = await get(port, '/messages.jsonl')
    expect(log.host).toBe('127.0.0.1')
    expect(JSON.parse(log.body).to).toBe('claude-2')
    expect((await get(port, '/../../secret')).status).toBe(404)
    expect((await get(port, '/summary.txt')).status).toBe(404)
    fs.renameSync(path.join(team, 'messages.jsonl'), path.join(team, 'messages.backup'))
    fs.symlinkSync(outside, path.join(team, 'messages.jsonl'))
    expect((await get(port, '/messages.jsonl')).body).not.toContain('private')
    fs.unlinkSync(path.join(team, 'messages.jsonl'))
    fs.renameSync(path.join(team, 'messages.backup'), path.join(team, 'messages.jsonl'))
    fs.writeFileSync(path.join(team, 'summary.txt'), 'Klaar')
    fs.writeFileSync(path.join(team, '.finished'), 'done')
    expect((await get(port, '/messages.jsonl')).body).toContain('Klaar')
    await waitFor(() => child.exitCode !== null, 4000)
    expect(fs.existsSync(path.join(team, 'webfeed.port'))).toBe(false)
  })

  it('rekent de grace vanaf het moment dat de pagina het eindbericht kreeg', async () => {
    const { runtime, team } = fixture()
    const child = spawn('python3', [server, 'team-1'], {
      env: { ...process.env, COLLAB_RUNTIME_ROOT: runtime, COLLAB_WEBFEED_GRACE_SECONDS: '0.4', COLLAB_WEBFEED_UNSERVED_SECONDS: '30', COLLAB_WEBFEED_MAX_SECONDS: '30' }, stdio: 'ignore',
    })
    children.push(child)
    await waitFor(() => fs.existsSync(path.join(team, 'webfeed.port')))
    const port = Number(fs.readFileSync(path.join(team, 'webfeed.port'), 'utf8'))
    fs.writeFileSync(path.join(team, 'summary.txt'), 'Klaar')
    fs.writeFileSync(path.join(team, '.finished'), 'done')
    // Een trage pagina (verborgen tabblad) komt pas na de grace langs: de server
    // moet er dan nog zijn en het eindbericht geven.
    await new Promise(resolve => setTimeout(resolve, 1200))
    expect(child.exitCode).toBeNull()
    expect((await get(port, '/messages.jsonl')).body).toContain('Klaar')
    await waitFor(() => child.exitCode !== null, 4000)
  })

  it('stopt ook als niemand het eindbericht ophaalt, na het plafond voor onopgehaalde feeds', async () => {
    const { runtime, team } = fixture()
    const child = spawn('python3', [server, 'team-1'], {
      env: { ...process.env, COLLAB_RUNTIME_ROOT: runtime, COLLAB_WEBFEED_GRACE_SECONDS: '0.2', COLLAB_WEBFEED_UNSERVED_SECONDS: '0.6', COLLAB_WEBFEED_MAX_SECONDS: '30' }, stdio: 'ignore',
    })
    children.push(child)
    await waitFor(() => fs.existsSync(path.join(team, 'webfeed.port')))
    fs.writeFileSync(path.join(team, '.finished'), 'done')
    await waitFor(() => child.exitCode !== null, 4000)
  })

  it('rejects unsafe team ids', () => {
    const { runtime } = fixture()
    const result = spawnSync('python3', [server, '..'], { env: { ...process.env, COLLAB_RUNTIME_ROOT: runtime }, encoding: 'utf8' })
    expect(result.status).not.toBe(0)
  })

  it('stops at the hard time limit without a finish marker', async () => {
    const { runtime, team } = fixture()
    const child = spawn('python3', [server, 'team-1'], {
      env: { ...process.env, COLLAB_RUNTIME_ROOT: runtime, COLLAB_WEBFEED_MAX_SECONDS: '0.5' }, stdio: 'ignore',
    })
    children.push(child)
    await waitFor(() => fs.existsSync(path.join(team, 'webfeed.port')))
    await waitFor(() => child.exitCode !== null)
  })
})

describe('Orca opener', () => {
  it('opens a right browser tab through a stub and records its page id', async () => {
    const { runtime, team, root } = fixture()
    const bin = path.join(root, 'bin')
    fs.mkdirSync(bin)
    const calls = path.join(root, 'calls')
    fs.writeFileSync(path.join(bin, 'orca'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$ORCA_CALLS"\nprintf \'{"ok":true,"result":{"browserPageId":"page-test"}}\\n\'\n', { mode: 0o755 })
    const result = spawnSync('bash', [opener, 'team-1'], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ORCA_CLI_COMMAND: path.join(bin, 'orca'), ORCA_CALLS: calls, COLLAB_RUNTIME_ROOT: runtime, COLLAB_WEBFEED_MAX_SECONDS: '5' }, encoding: 'utf8', timeout: 8000,
    })
    expect(result.status, result.stderr).toBe(0)
    expect(fs.readFileSync(calls, 'utf8')).toMatch(/tab create --url http:\/\/127\.0\.0\.1:\d+\/ --split right --json/)
    expect(fs.readFileSync(path.join(team, 'webfeed-page-id'), 'utf8').trim()).toBe('page-test')
    fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\nprintf \'{"teams":[]}\\n\'\n', { mode: 0o755 })
    fs.writeFileSync(path.join(team, '.finished'), 'done')
    const cleanup = spawnSync('bash', [orphans, '--force', '--min-age-minutes', '0'], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ORCA_CLI_COMMAND: path.join(bin, 'orca'), ORCA_CALLS: calls, COLLAB_RUNTIME_ROOT: runtime }, encoding: 'utf8', timeout: 8000,
    })
    expect(cleanup.status, cleanup.stderr).toBe(0)
    expect(fs.readFileSync(calls, 'utf8')).toContain('tab close --page page-test --json')
    expect(fs.existsSync(path.join(team, 'webfeed-page-id'))).toBe(false)
  })
})
