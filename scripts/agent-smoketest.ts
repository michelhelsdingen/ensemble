import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { buildAgentStartupCommand, loadAgentsConfig } from '../lib/agent-config'
import type { AgentProgram } from '../types/agent-program'

const execFileAsync = promisify(execFile)
const pollMs = 100

type Status = 'ok' | 'missing' | 'no-ready-marker' | 'crashed'
interface Result { status: Status; seconds: number; version?: string; detail?: string }

async function tmux(socket: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('tmux', ['-S', socket, ...args], { encoding: 'utf8', timeout: 3000 })
  return stdout
}

function onPath(command: string): boolean {
  const candidates = command.includes('/')
    ? [path.resolve(command)]
    : (process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir || '.', command))
  return candidates.some(candidate => {
    try {
      if (!fs.statSync(candidate).isFile()) return false
      fs.accessSync(candidate, fs.constants.X_OK)
      return true
    }
    catch { return false }
  })
}

async function version(command: string): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(command, ['--version'], { encoding: 'utf8', timeout: 2000 })
    return (stdout || stderr).split(/\r?\n/, 1)[0].trim() || undefined
  } catch { return undefined }
}

function lastLines(screen: string): string {
  return screen.split(/\r?\n/).map(line => line.trimEnd()).filter(line => line.trim()).slice(-5).join('\n')
}

async function probe(key: string, agent: AgentProgram, timeoutSeconds: number): Promise<Result> {
  const started = Date.now()
  if (!onPath(agent.command)) return { status: 'missing', seconds: 0 }
  const cliVersion = await version(agent.command)
  const base = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'ens-smoke-'))
  const socket = path.join(base, 's')
  const cwd = path.join(base, 'work')
  const session = 'probe'
  const token = path.basename(base)
  const begin = `BEGIN_${token}`
  const end = `END_${token}`
  const elapsed = () => Math.round((Date.now() - started) / 10) / 100
  let screen = ''
  try {
    fs.mkdirSync(cwd)
    await tmux(socket, 'new-session', '-d', '-s', session, '-c', cwd, '-x', '160', '-y', '40')
    const launch = `printf '\\n${begin}\\n'; ${buildAgentStartupCommand(key, cwd)}; printf '\\n${end}:%s\\n' "$?"`
    await tmux(socket, 'send-keys', '-t', session, '-l', launch)
    await tmux(socket, 'send-keys', '-t', session, 'Enter')

    const deadline = Date.now() + timeoutSeconds * 1000
    while (Date.now() < deadline) {
      screen = await tmux(socket, 'capture-pane', '-p', '-t', session, '-S', '-200')
      const lines = screen.split(/\r?\n/)
      const beginIndex = lines.findIndex(line => line.trim() === begin)
      const afterBegin = beginIndex < 0 ? '' : lines.slice(beginIndex + 1).join('\n')
      if (afterBegin.includes(agent.readyMarker)) return { status: 'ok', seconds: elapsed(), ...(cliVersion && { version: cliVersion }) }
      if (new RegExp(`(?:^|\\n)${end}:\\d+`, 'm').test(afterBegin)) {
        return { status: 'crashed', seconds: elapsed(), ...(cliVersion && { version: cliVersion }), detail: lastLines(afterBegin) }
      }
      await new Promise(resolve => setTimeout(resolve, pollMs))
    }
    return { status: 'no-ready-marker', seconds: elapsed(), ...(cliVersion && { version: cliVersion }), detail: lastLines(screen) }
  } catch (error) {
    return { status: 'crashed', seconds: elapsed(), ...(cliVersion && { version: cliVersion }), detail: error instanceof Error ? error.message : String(error) }
  } finally {
    try { await tmux(socket, 'kill-server') } catch { /* server may already be gone */ }
    fs.rmSync(base, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const config = loadAgentsConfig()
  const args = process.argv.slice(2)
  let timeoutSeconds = 60
  const keys: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--timeout') {
      timeoutSeconds = Number(args[++i])
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error('--timeout requires a positive number of seconds')
    } else keys.push(args[i])
  }
  const selected = keys.length ? [...new Set(keys)] : Object.keys(config)
  for (const key of selected) if (!config[key]) throw new Error(`Unknown agent key: ${key}`)

  const results: Record<string, Result> = {}
  let next = 0
  await Promise.all(Array.from({ length: Math.min(3, selected.length) }, async () => {
    while (next < selected.length) {
      const key = selected[next++]
      results[key] = await probe(key, config[key], timeoutSeconds)
    }
  }))
  const ordered = Object.fromEntries(selected.map(key => [key, results[key]]))
  process.stdout.write(`${JSON.stringify(ordered)}\n`)
  process.stderr.write(`Agent smoketest: ${selected.map(key => `${key}=${results[key].status}`).join(', ')}\n`)
  if (selected.some(key => !['ok', 'missing'].includes(results[key].status))) process.exitCode = 1
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
