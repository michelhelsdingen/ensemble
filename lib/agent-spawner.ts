/**
 * Agent Spawner — Standalone agent lifecycle management for Ensemble
 * Replaces ai-maestro's agent-registry + agents-core-service with a minimal implementation.
 * Handles: tmux session creation, program launching, and session cleanup.
 */

import { v4 as uuidv4 } from 'uuid'
import { getRuntime } from './agent-runtime'
import { getSelfHostId } from './hosts-config'
import { buildAgentStartupCommand } from './agent-config'

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

/** Compute tmux session name from agent name */
function computeSessionName(agentName: string): string {
  return agentName.replace(/[^a-zA-Z0-9\-_.]/g, '')
}

/** Hoe lang we hoogstens op een verse sessie wachten, en hoe vaak we kijken. */
const SESSION_WAIT_MS = 1_000
const SESSION_POLL_MS = 25

/**
 * Wacht tot een net aangemaakte sessie zichtbaar is.
 *
 * Kan de runtime het niet zeggen (geen sessionExists, of een fout), dan gaan we
 * na de bovengrens gewoon door: het startcommando sturen en falen is beter dan
 * hier blijven staan, en de readiness-controle in de service vangt het verder.
 */
async function waitForSession(runtime: { sessionExists?: (name: string) => Promise<boolean> }, sessionName: string): Promise<void> {
  if (!runtime.sessionExists) return
  const deadline = Date.now() + SESSION_WAIT_MS
  while (Date.now() < deadline) {
    try {
      if (await runtime.sessionExists(sessionName)) return
    } catch {
      await new Promise(r => setTimeout(r, SESSION_WAIT_MS))
      return
    }
    await new Promise(r => setTimeout(r, SESSION_POLL_MS))
  }
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

  // Wachten tot de sessie er echt is, niet een vaste 300ms. Gemeten 03-11-2026:
  // de sessie bestaat op deze machine binnen 20ms, dus die 300ms was per agent
  // puur wachttijd in de start van elk team.
  await waitForSession(runtime, sessionName)

  // Start the AI program
  // Use 'nocorrect' to prevent zsh auto-correct prompt, and add leading space to avoid tmux swallowing first char
  await runtime.sendKeys(sessionName, buildAgentStartupCommand(options.program, cwd), { literal: true, enter: true })

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
export async function isRemoteSessionReady(hostUrl: string, sessionName: string): Promise<boolean | undefined> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 5000)
  try {
    const response = await fetch(`${hostUrl}/api/sessions/${encodeURIComponent(sessionName)}/command`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: ctrl.signal,
    })
    if (response.status === 404) return false
    if (!response.ok) return undefined
    const body = await response.json().catch(() => null)
    return typeof body?.exists === 'boolean' ? body.exists : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}
