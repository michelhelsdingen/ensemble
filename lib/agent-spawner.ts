/**
 * Agent Spawner — Standalone agent lifecycle management for Ensemble
 * Replaces ai-maestro's agent-registry + agents-core-service with a minimal implementation.
 * Handles: tmux session creation, program launching, and session cleanup.
 */

import { v4 as uuidv4 } from 'uuid'
import { getRuntime } from './agent-runtime'
import { getSelfHostId } from './hosts-config'
import { buildAgentCommandParts } from './agent-config'
import path from 'path'
import { fileURLToPath } from 'url'

export interface SpawnedAgent {
  id: string
  name: string
  program: string
  sessionName: string
  workingDirectory: string
  hostId: string
}

interface SpawnAgentOptions {
  name: string
  program: string
  workingDirectory: string
  hostId?: string
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

/** Compute tmux session name from agent name */
function computeSessionName(agentName: string): string {
  return agentName.replace(/[^a-zA-Z0-9\-_.]/g, '')
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Resolve program name to CLI command using agents.json config */
function resolveStartCommand(program: string, cwd: string): string {
  const parts = buildAgentCommandParts(program)
  const normalized = program.toLowerCase()

  if (
    normalized.includes('codex')
    && !parts.some(part => part === '-C' || part === '--cd' || part.startsWith('--cd='))
  ) {
    parts.push('--cd', cwd)
  }

  if (
    normalized.includes('claude')
    && cwd !== REPO_ROOT
    && !parts.some(part => part === '--add-dir' || part.startsWith('--add-dir='))
  ) {
    parts.push('--add-dir', REPO_ROOT)
  }

  return parts.map(shellEscape).join(' ')
}

/**
 * Spawn a local agent: create tmux session + start the AI program
 */
export async function spawnLocalAgent(options: SpawnAgentOptions): Promise<SpawnedAgent> {
  const runtime = getRuntime()
  const agentId = uuidv4()
  const sessionName = computeSessionName(options.name)
  const cwd = options.workingDirectory || process.cwd()
  const hostId = options.hostId || getSelfHostId()

  // Create tmux session
  await runtime.createSession(sessionName, cwd)

  // Small delay for session init
  await new Promise(r => setTimeout(r, 300))

  // Start the AI program
  const startCommand = resolveStartCommand(options.program, cwd)

  // Forward ENSEMBLE_* and agent-specific env vars to tmux session
  const envForward = Object.entries(process.env)
    .filter(([k]) => k.startsWith('ENSEMBLE_') || k.startsWith('NVIDIA_') || k.startsWith('OPENAI_') || k.startsWith('ANTHROPIC_'))
    .filter(([, v]) => v)
    .map(([k, v]) => `export ${k}="${v}"`)
    .join('; ')
  const envPrefix = envForward ? `${envForward}; ` : ''

  await runtime.sendKeys(sessionName, `unset CLAUDECODE; ${envPrefix}exec ${startCommand}`, { literal: true, enter: true })

  console.log(`[Spawner] Agent ${options.name} started in tmux session ${sessionName}`)

  return {
    id: agentId,
    name: options.name,
    program: options.program,
    sessionName,
    workingDirectory: cwd,
    hostId,
  }
}

/**
 * Kill a local agent's tmux session
 */
export async function killLocalAgent(sessionName: string): Promise<void> {
  const runtime = getRuntime()
  try {
    // Try graceful exit first
    await runtime.sendKeys(sessionName, 'C-c', { enter: false })
    await new Promise(r => setTimeout(r, 500))
    await runtime.sendKeys(sessionName, '"exit"', { enter: true })
    await new Promise(r => setTimeout(r, 500))
    await runtime.killSession(sessionName)
  } catch {
    // Session may already be gone
    try { await runtime.killSession(sessionName) } catch { /* ok */ }
  }
}

/**
 * Spawn a remote agent via Maestro API on another machine
 */
export async function spawnRemoteAgent(
  hostUrl: string,
  agentName: string,
  program: string,
  cwd: string,
  taskDescription?: string,
  teamName?: string,
): Promise<{ id: string }> {
  // Create agent on remote host (15s timeout)
  const createCtrl = new AbortController()
  const createTimer = setTimeout(() => createCtrl.abort(), 15000)
  let createRes: Response
  try {
    createRes = await fetch(`${hostUrl}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: agentName,
        program,
        workingDirectory: cwd,
        taskDescription,
        team: teamName,
      }),
      signal: createCtrl.signal,
    })
  } finally {
    clearTimeout(createTimer)
  }

  if (!createRes.ok) {
    const body = await createRes.text()
    throw new Error(`Remote agent create failed: ${createRes.status} ${body}`)
  }

  const { agent } = await createRes.json()

  // Wake agent on remote host (15s timeout)
  const wakeCtrl = new AbortController()
  const wakeTimer = setTimeout(() => wakeCtrl.abort(), 15000)
  try {
    const wakeRes = await fetch(`${hostUrl}/api/agents/${agent.id}/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startProgram: true, sessionIndex: 0 }),
      signal: wakeCtrl.signal,
    })
    if (!wakeRes.ok) {
      const body = await wakeRes.text()
      throw new Error(`Remote agent wake failed: ${wakeRes.status} ${body}`)
    }
  } finally {
    clearTimeout(wakeTimer)
  }

  return { id: agent.id }
}

/**
 * Kill a remote agent via Maestro API
 */
export async function killRemoteAgent(hostUrl: string, agentId: string): Promise<void> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10000)
  try {
    await fetch(`${hostUrl}/api/agents/${agentId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ killSession: true }),
      signal: ctrl.signal,
    })
  } catch { /* non-fatal */ }
  finally { clearTimeout(timer) }
}

/**
 * Send command to a remote agent's session
 */
export async function postRemoteSessionCommand(
  hostUrl: string,
  sessionName: string,
  command: string,
): Promise<void> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10000)
  try {
    const response = await fetch(`${hostUrl}/api/sessions/${encodeURIComponent(sessionName)}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, requireIdle: false, addNewline: true }),
      signal: ctrl.signal,
    })
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Remote session command failed: ${response.status} ${body}`)
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Scrape token usage from an agent's tmux pane output.
 * Best-effort: returns 'unknown' if parsing fails.
 *
 * Claude Code patterns: "NNk tokens", "NN,NNN tokens", "NNN tokens"
 * Codex patterns: "NN% left", "NNk tokens"
 */
export async function getAgentTokenUsage(sessionName: string): Promise<string> {
  try {
    const runtime = getRuntime()
    const output = await runtime.capturePane(sessionName, 100)

    // Claude Code: "123k tokens" or "12,345 tokens" or "1.2k tokens"
    const claudeKMatch = output.match(/(\d+(?:\.\d+)?k)\s*tokens/i)
    if (claudeKMatch) return `~${claudeKMatch[1]} tokens`

    const claudeFullMatch = output.match(/([\d,]+)\s*tokens/i)
    if (claudeFullMatch) return `~${claudeFullMatch[1]} tokens`

    // Codex: "NN% left"
    const codexPctMatch = output.match(/(\d+)%\s*left/i)
    if (codexPctMatch) return `${codexPctMatch[1]}% budget left`

    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Check if a remote session exists and is ready
 */
export async function isRemoteSessionReady(hostUrl: string, sessionName: string): Promise<boolean> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 5000)
  try {
    const response = await fetch(`${hostUrl}/api/sessions/${encodeURIComponent(sessionName)}/command`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: ctrl.signal,
    })
    if (!response.ok) return false
    const body = await response.json().catch(() => null)
    return Boolean(body?.exists)
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
