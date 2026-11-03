import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { buildAgentStartupCommand, loadAgentsConfig } from '../lib/agent-config'
import { confirmLiveGate, isShellCommand } from '../lib/startup-gates'
import { createReadyHold, READY_STABLE_MS, readyScreenState } from '../lib/ready-screen'
import type { AgentProgram } from '../types/agent-program'

const execFileAsync = promisify(execFile)
const pollMs = 100

type Status = 'ok' | 'missing' | 'no-ready-marker' | 'crashed' | 'blocked'
interface Result { status: Status; seconds: number; gates: string[]; version?: string; detail?: string }

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
  if (!onPath(agent.command)) return { status: 'missing', seconds: 0, gates: [] }
  const cliVersion = await version(agent.command)
  const base = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'ens-smoke-'))
  const socket = path.join(base, 's')
  const cwd = path.join(base, 'work')
  const session = 'probe'
  const token = path.basename(base)
  const end = `END_${token}`
  const elapsed = () => Math.round((Date.now() - started) / 10) / 100
  const gates: string[] = []
  const result = (status: Status, detail?: string): Result => ({
    status, seconds: elapsed(), gates, ...(cliVersion && { version: cliVersion }), ...(detail && { detail }),
  })
  let screen = ''
  let lastGateName = ''
  let lastGateHandledAt = 0
  // Dezelfde stabiliteitseis als de service, want een probe die eerder
  // toeslaat dan de echte start mist precies de dialoog die daarna komt. Nooit
  // meer dan de helft van het tijdsbudget, zodat een korte --timeout bruikbaar
  // blijft.
  const held = createReadyHold(Math.min(READY_STABLE_MS, (timeoutSeconds * 1000) / 2))
  try {
    fs.mkdirSync(cwd)
    await tmux(socket, 'new-session', '-d', '-s', session, '-c', cwd, '-x', '160', '-y', '40')
    const launch = `${buildAgentStartupCommand(key, cwd)}; printf '\\n${end}:%s\\n' "$?"`
    await tmux(socket, 'send-keys', '-t', session, '-l', launch)
    await tmux(socket, 'send-keys', '-t', session, 'Enter')

    const deadline = started + timeoutSeconds * 1000
    while (Date.now() < deadline) {
      screen = await tmux(socket, 'capture-pane', '-p', '-t', session)
      if (new RegExp(`(?:^|\\n)${end}:\\d+(?:\\r?\\n|$)`).test(screen)) return result('crashed', lastLines(screen))
      const foreground = (await tmux(socket, 'display-message', '-p', '-t', session, '#{pane_current_command}')).trim()
      if (isShellCommand(foreground)) {
        if (Date.now() - started >= 5000) return result('crashed', lastLines(screen))
        await new Promise(resolve => setTimeout(resolve, pollMs))
        continue
      }
      // Eén gedeelde gereedheidstoets met de service, zodat preflight niet
      // groen kan zijn terwijl een team stil stuk start. Tot 03-11-2026 vroeg
      // deze probe "staat de marker ergens op het scherm", en dat was waar
      // terwijl codex modaal in zijn hooks-dialoog stond.
      const state = readyScreenState(screen, agent.readyMarker)
      if (state.state === 'blocked') return result('blocked', `${state.dialog}\n${lastLines(state.tail)}`)
      if (held(state.state === 'ready')) return result('ok')
      if (state.state === 'gate') {
        const now = Date.now()
        if (state.gate.name !== lastGateName || now - lastGateHandledAt >= 3000) {
          await confirmLiveGate(state.gate, async (keys, options) => {
            if (options?.enter) await tmux(socket, 'send-keys', '-t', session, keys, 'Enter')
            else await tmux(socket, 'send-keys', '-t', session, keys)
          })
          gates.push(state.gate.name)
          lastGateName = state.gate.name
          lastGateHandledAt = now
        }
      }
      await new Promise(resolve => setTimeout(resolve, pollMs))
    }
    return result('no-ready-marker', lastLines(screen))
  } catch (error) {
    return result('crashed', error instanceof Error ? error.message : String(error))
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
  const requested = keys.length ? [...new Set(keys)] : Object.keys(config)
  const selected = requested.filter(key => config[key])
  const unknown = requested.filter(key => !config[key])

  const results: Record<string, Result> = {}
  // An unknown key (requested by the caller but absent from agents.json) used to throw and
  // abort the whole smoketest with empty stdout, which crashed the caller's JSON parse. Report
  // it as a per-agent finding instead so every other agent still gets tested.
  for (const key of unknown) results[key] = { status: 'missing', seconds: 0, gates: [], detail: 'unknown agent key' }
  let next = 0
  await Promise.all(Array.from({ length: Math.min(3, selected.length) }, async () => {
    while (next < selected.length) {
      const key = selected[next++]
      results[key] = await probe(key, config[key], timeoutSeconds)
    }
  }))
  const ordered = Object.fromEntries(requested.map(key => [key, results[key]]))
  process.stdout.write(`${JSON.stringify(ordered)}\n`)
  process.stderr.write(`Agent smoketest: ${requested.map(key => `${key}=${results[key].status}`).join(', ')}\n`)
  if (requested.some(key => !['ok', 'missing'].includes(results[key].status))) process.exitCode = 1
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
