/**
 * Agent Runtime Abstraction
 *
 * Consolidates ALL tmux operations behind a single TmuxRuntime class
 * implementing the AgentRuntime interface. Future runtimes (Docker, API-only,
 * direct-process) can be plugged in without touching business logic.
 *
 * Phase 4 of the service-layer refactoring.
 */

import { execFile, execFileSync as nodeExecFileSync } from 'child_process'
import { randomUUID } from 'crypto'
import { promisify } from 'util'

import { isShellCommand } from './startup-gates'

const execFileAsync = promisify(execFile)

/**
 * Escape an argument for tmux's own command parser.
 * When tmux parses commands from argv, a trailing semicolon in an argument is
 * treated as a command separator unless escaped as '\;'.
 */
export function escapeTmuxArg(arg: string): string {
  return arg.endsWith(';') ? arg.slice(0, -1) + '\\;' : arg
}

/**
 * Tokenize a non-literal key sequence for tmux send-keys.
 * Supports alphanumeric key names, hyphens, spaces, and double-quoted strings
 * (e.g. '"exit"' -> 'exit', 'exit Enter' -> ['exit', 'Enter']).
 * Rejects unsafe characters and unbalanced quotes.
 */
export function parseKeyTokens(keys: string): string[] {
  if (!/^[a-zA-Z0-9\-_ "]+$/.test(keys)) {
    throw new Error(`Unsafe tmux key sequence rejected: ${keys.slice(0, 50)}`)
  }
  const tokens: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < keys.length; i++) {
    const ch = keys[i]
    if (ch === '"') {
      inQuotes = !inQuotes
    } else if (ch === ' ' && !inQuotes) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }
  if (inQuotes) {
    throw new Error(`Unbalanced quotes in tmux key sequence: ${keys.slice(0, 50)}`)
  }
  if (current.length > 0) {
    tokens.push(current)
  }
  return tokens
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface DiscoveredSession {
  name: string
  windows: number
  createdAt: string
  workingDirectory: string
}

export interface AgentRuntime {
  readonly type: 'tmux' | 'happy' | 'docker' | 'api' | 'direct'

  // Discovery
  listSessions(): Promise<DiscoveredSession[]>

  // Existence / status
  sessionExists(name: string): Promise<boolean>
  getWorkingDirectory(name: string): Promise<string>
  isInCopyMode(name: string): Promise<boolean>
  cancelCopyMode(name: string): Promise<void>

  // Lifecycle
  createSession(name: string, cwd: string): Promise<void>
  killSession(name: string): Promise<void>
  renameSession(oldName: string, newName: string): Promise<void>

  // I/O
  sendKeys(name: string, keys: string, opts?: { literal?: boolean; enter?: boolean; agentInput?: boolean }): Promise<void>
  pasteFromFile(name: string, filePath: string, submitDelayMs?: number): Promise<void>
  capturePane(name: string, lines?: number): Promise<string>
  /** Name of the process in the pane's foreground ('' when unknown). */
  getForegroundCommand?(name: string): Promise<string>

  // Environment
  setEnvironment(name: string, key: string, value: string): Promise<void>
  unsetEnvironment(name: string, key: string): Promise<void>

  // PTY (returns spawn args for node-pty -- runtime doesn't own the PTY)
  getAttachCommand(name: string, socketPath?: string): { command: string; args: string[] }
}

// ---------------------------------------------------------------------------
// Shell guard
// ---------------------------------------------------------------------------

export { isShellCommand }

/**
 * Agent input (prompts, team messages, nudges) landed in a bare shell when the
 * agent CLI had exited: the shell then parsed it as a command, and one
 * apostrophe left the pane stuck on `quote>`. Such input is refused instead.
 */
export class AgentNotRunningError extends Error {
  constructor(sessionName: string, command: string) {
    super(`${sessionName}: no agent running (shell '${command}' in foreground), input not delivered`)
    this.name = 'AgentNotRunningError'
  }
}

// ---------------------------------------------------------------------------
// TmuxRuntime
// ---------------------------------------------------------------------------

export class TmuxRuntime implements AgentRuntime {
  readonly type: AgentRuntime['type'] = 'tmux'

  /** Sanitize a tmux session/buffer name to prevent command injection */
  private sanitizeName(name: string): string {
    // Only allow alphanumeric, hyphens, underscores, dots
    const sanitized = name.replace(/[^a-zA-Z0-9\-_.]/g, '')
    if (!sanitized) throw new Error(`Invalid tmux name after sanitization: "${name}"`)
    return sanitized
  }

  // -- Discovery -----------------------------------------------------------

  async listSessions(): Promise<DiscoveredSession[]> {
    try {
      let stdout = ''
      try {
        const res = await execFileAsync('tmux', ['list-sessions'])
        stdout = res.stdout
      } catch {
        return []
      }
      if (!stdout.trim()) return []

      const lines = stdout.trim().split('\n')
      const results: DiscoveredSession[] = []

      for (const line of lines) {
        const match = line.match(/^([^:]+):\s+(\d+)\s+windows?\s+\(created\s+(.+?)\)/)
        if (!match) continue

        const [, name, windows, createdStr] = match
        const normalizedDate = createdStr.trim().replace(/\s+/g, ' ')

        let createdAt: string
        try {
          const parsedDate = new Date(normalizedDate)
          createdAt = isNaN(parsedDate.getTime()) ? new Date().toISOString() : parsedDate.toISOString()
        } catch {
          createdAt = new Date().toISOString()
        }

        let workingDirectory = ''
        try {
          const sName = this.sanitizeName(name)
          const cwdOutput = await execFileAsync('tmux', [
            'display-message', '-t', sName, '-p', '#{pane_current_path}',
          ])
          workingDirectory = cwdOutput.stdout.trim()
        } catch {
          workingDirectory = ''
        }

        results.push({
          name,
          windows: parseInt(windows, 10),
          createdAt,
          workingDirectory,
        })
      }

      return results
    } catch {
      return []
    }
  }

  // -- Existence / status --------------------------------------------------

  async sessionExists(name: string): Promise<boolean> {
    try {
      const sName = this.sanitizeName(name)
      await execFileAsync('tmux', ['has-session', '-t', sName])
      return true
    } catch {
      return false
    }
  }

  async getWorkingDirectory(name: string): Promise<string> {
    try {
      const sName = this.sanitizeName(name)
      const { stdout } = await execFileAsync('tmux', [
        'display-message', '-t', sName, '-p', '#{pane_current_path}',
      ])
      return stdout.trim()
    } catch {
      return ''
    }
  }

  async isInCopyMode(name: string): Promise<boolean> {
    try {
      const sName = this.sanitizeName(name)
      const { stdout } = await execFileAsync('tmux', [
        'display-message', '-t', sName, '-p', '#{pane_in_mode}',
      ])
      return stdout.trim() === '1'
    } catch {
      return false
    }
  }

  async cancelCopyMode(name: string): Promise<void> {
    try {
      const inCopyMode = await this.isInCopyMode(name)
      if (inCopyMode) {
        const sName = this.sanitizeName(name)
        await execFileAsync('tmux', ['send-keys', '-t', sName, 'q'])
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    } catch {
      // Ignore
    }
  }

  // -- Lifecycle -----------------------------------------------------------

  async createSession(name: string, cwd: string): Promise<void> {
    const sName = this.sanitizeName(name)
    await execFileAsync('tmux', ['new-session', '-d', '-s', sName, '-c', escapeTmuxArg(cwd)])
  }

  async killSession(name: string): Promise<void> {
    const sName = this.sanitizeName(name)
    await execFileAsync('tmux', ['kill-session', '-t', sName])
  }

  async renameSession(oldName: string, newName: string): Promise<void> {
    const sOld = this.sanitizeName(oldName)
    const sNew = this.sanitizeName(newName)
    await execFileAsync('tmux', ['rename-session', '-t', sOld, sNew])
  }

  // -- I/O -----------------------------------------------------------------

  async sendKeys(
    name: string,
    keys: string,
    opts: { literal?: boolean; enter?: boolean; agentInput?: boolean } = {}
  ): Promise<void> {
    const sName = this.sanitizeName(name)
    const { literal = false, enter = false, agentInput = false } = opts
    if (agentInput) await this.assertAgentInForeground(name)

    if (literal) {
      const safeArg = escapeTmuxArg(keys)
      const sendArgs = ['send-keys', '-t', sName, '-l']
      if (keys.startsWith('-')) {
        sendArgs.push('--')
      }
      sendArgs.push(safeArg)
      if (enter) {
        await execFileAsync('tmux', [
          ...sendArgs,
          ';',
          'send-keys', '-t', sName, 'C-m',
        ])
      } else {
        await execFileAsync('tmux', sendArgs)
      }
    } else {
      const tokens = parseKeyTokens(keys)
      const args = ['send-keys', '-t', sName, ...tokens]
      if (enter) {
        args.push('C-m')
      }
      if (tokens.length > 0 || enter) {
        await execFileAsync('tmux', args)
      }
    }
  }

  /**
   * Paste text from a file into the pane via tmux load-buffer + paste-buffer.
   * More reliable than send-keys -l for TUI apps (e.g., Codex) that don't
   * handle literal key injection well. Sends Enter after pasting.
   *
   * Robust against tmux buffer races: load + paste are chained in
   * ONE tmux command list so the buffer cannot be eaten by another
   * tmux client between calls.
   *
   * Retries up to 3x with exponential backoff (200ms, 400ms) before giving
   * up -- covers transient tmux server load and buffer-stack flushes.
   * Callers may increase submitDelayMs when a TUI needs more time to finish a paste.
   */
  async pasteFromFile(name: string, filePath: string, submitDelayMs = 1000): Promise<void> {
    const sName = this.sanitizeName(name)
    // Pasting is only ever used for agent input, never for shell commands.
    await this.assertAgentInForeground(name)
    const safePath = escapeTmuxArg(filePath)
    const callId = randomUUID()

    let lastErr: unknown
    const attempts = 3
    let geplakt = false
    for (let attempt = 1; attempt <= attempts && !geplakt; attempt++) {
      const bufName = `orch-${sName}-${callId}-${attempt}`
      try {
        await execFileAsync('tmux', [
          'load-buffer', '-b', bufName, '--', safePath,
          ';',
          'paste-buffer', '-b', bufName, '-t', sName,
        ])
        geplakt = true
      } catch (err) {
        lastErr = err
        if (attempt < attempts) {
          // Exponential backoff: 200ms, 400ms.
          await new Promise(r => setTimeout(r, 200 * 2 ** (attempt - 1)))
        }
      } finally {
        try {
          await execFileAsync('tmux', ['delete-buffer', '-b', bufName])
        } catch {
          // Best-effort cleanup so we don't leak buffers between retry attempts
        }
      }
    }
    if (!geplakt) {
      throw lastErr instanceof Error
        ? lastErr
        : new Error(`pasteFromFile failed after ${attempts} attempts`)
    }

    // De Enters apart van de retry-lus hierboven: die lus omvatte ze eerder
    // ook, waardoor een mislukte Enter de hele prompt opnieuw liet plakken in
    // dezelfde pane. Give TUI time to process the paste, then send Enter twice
    // (some TUIs like Gemini CLI need an extra Enter after paste); een
    // mislukte Enter wordt gelogd maar triggert geen nieuwe paste.
    await new Promise(r => setTimeout(r, submitDelayMs))
    for (const wacht of [0, 300]) {
      if (wacht) await new Promise(r => setTimeout(r, wacht))
      try {
        await execFileAsync('tmux', ['send-keys', '-t', sName, 'Enter'])
      } catch (err) {
        console.error(`[runtime] Enter naar ${sName} mislukte:`, err)
      }
    }
  }

  async getForegroundCommand(name: string): Promise<string> {
    try {
      const sName = this.sanitizeName(name)
      const { stdout } = await execFileAsync('tmux', [
        'display-message', '-t', sName, '-p', '#{pane_current_command}',
      ])
      return stdout.trim()
    } catch {
      return ''
    }
  }

  private async assertAgentInForeground(name: string): Promise<void> {
    const command = await this.getForegroundCommand(name)
    if (isShellCommand(command)) throw new AgentNotRunningError(name, command)
  }

  async capturePane(name: string, lines: number = 2000): Promise<string> {
    try {
      const sName = this.sanitizeName(name)
      const sLines = Math.max(1, Math.min(10000, Math.floor(lines)))
      const startTime = Date.now()
      try {
        const { stdout } = await execFileAsync(
          'tmux',
          ['capture-pane', '-t', sName, '-p', '-S', `-${sLines}`],
          { encoding: 'utf8', timeout: 3000 }
        )
        return stdout
      } catch {
        const remainingTimeout = 3000 - (Date.now() - startTime)
        if (remainingTimeout <= 0) return ''
        const { stdout } = await execFileAsync(
          'tmux',
          ['capture-pane', '-t', sName, '-p'],
          { encoding: 'utf8', timeout: remainingTimeout }
        )
        return stdout
      }
    } catch {
      return ''
    }
  }

  // -- Environment ---------------------------------------------------------

  async setEnvironment(name: string, key: string, value: string): Promise<void> {
    const sName = this.sanitizeName(name)
    const sKey = key.replace(/[^a-zA-Z0-9_]/g, '')
    const sValue = escapeTmuxArg(value)
    await execFileAsync('tmux', ['set-environment', '-t', sName, '--', sKey, sValue])
  }

  async unsetEnvironment(name: string, key: string): Promise<void> {
    const sName = this.sanitizeName(name)
    const sKey = key.replace(/[^a-zA-Z0-9_]/g, '')
    try {
      await execFileAsync('tmux', ['set-environment', '-t', sName, '-r', '--', sKey])
    } catch {
      // Best-effort if variable was not set or session does not exist
    }
  }

  // -- PTY -----------------------------------------------------------------

  getAttachCommand(name: string, socketPath?: string): { command: string; args: string[] } {
    if (socketPath) {
      return { command: 'tmux', args: ['-S', socketPath, 'attach-session', '-t', name] }
    }
    return { command: 'tmux', args: ['attach-session', '-t', name] }
  }
}

// ---------------------------------------------------------------------------
// Singleton + factory
// ---------------------------------------------------------------------------

let defaultRuntime: AgentRuntime = new TmuxRuntime()

export function getRuntime(): AgentRuntime {
  return defaultRuntime
}

export function setRuntime(r: AgentRuntime): void {
  defaultRuntime = r
}

// ---------------------------------------------------------------------------
// Sync helpers for lib/agent-registry.ts (uses execSync, can't be async)
// ---------------------------------------------------------------------------

function sanitizeNameSync(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9\-_.]/g, '')
  if (!sanitized) throw new Error(`Invalid tmux name after sanitization: "${name}"`)
  return sanitized
}

export function sessionExistsSync(name: string, socketPath?: string): boolean {
  try {
    const sName = sanitizeNameSync(name)
    const args = socketPath
      ? ['-S', socketPath, 'has-session', '-t', sName]
      : ['has-session', '-t', sName]
    nodeExecFileSync('tmux', args, { timeout: 2000, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function killSessionSync(name: string): void {
  try {
    const sName = sanitizeNameSync(name)
    nodeExecFileSync('tmux', ['kill-session', '-t', sName], { encoding: 'utf-8', stdio: 'ignore' })
  } catch {
    // Session may not exist
  }
}

export function renameSessionSync(oldName: string, newName: string): void {
  const sOld = sanitizeNameSync(oldName)
  const sNew = sanitizeNameSync(newName)
  nodeExecFileSync('tmux', ['rename-session', '-t', sOld, sNew], { encoding: 'utf-8' })
}
