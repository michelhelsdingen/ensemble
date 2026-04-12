/**
 * Agent Runtime Abstraction
 *
 * Consolidates ALL tmux operations behind a single TmuxRuntime class
 * implementing the AgentRuntime interface. Future runtimes (Docker, API-only,
 * direct-process) can be plugged in without touching business logic.
 *
 * Phase 4 of the service-layer refactoring.
 */

import { exec, execFile, execFileSync as nodeExecFileSync } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

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
  sendKeys(name: string, keys: string, opts?: { literal?: boolean; enter?: boolean }): Promise<void>
  pasteFromFile(name: string, filePath: string): Promise<void>
  capturePane(name: string, lines?: number): Promise<string>

  // Environment
  setEnvironment(name: string, key: string, value: string): Promise<void>
  unsetEnvironment(name: string, key: string): Promise<void>

  // PTY (returns spawn args for node-pty -- runtime doesn't own the PTY)
  getAttachCommand(name: string, socketPath?: string): { command: string; args: string[] }
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
      const { stdout } = await execAsync('tmux list-sessions 2>/dev/null || echo ""')
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
          const { stdout: cwdOutput } = await execAsync(
            `tmux display-message -t "${sName}" -p "#{pane_current_path}" 2>/dev/null || echo ""`
          )
          workingDirectory = cwdOutput.trim()
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
      await execAsync(`tmux has-session -t "${sName}" 2>/dev/null`)
      return true
    } catch {
      return false
    }
  }

  async getWorkingDirectory(name: string): Promise<string> {
    try {
      const sName = this.sanitizeName(name)
      const { stdout } = await execAsync(
        `tmux display-message -t "${sName}" -p "#{pane_current_path}" 2>/dev/null || echo ""`
      )
      return stdout.trim()
    } catch {
      return ''
    }
  }

  async isInCopyMode(name: string): Promise<boolean> {
    try {
      const sName = this.sanitizeName(name)
      const { stdout } = await execAsync(
        `tmux display-message -t "${sName}" -p "#{pane_in_mode}"`
      )
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
        await execAsync(`tmux send-keys -t "${sName}" q`)
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    } catch {
      // Ignore
    }
  }

  // -- Lifecycle -----------------------------------------------------------

  async createSession(name: string, cwd: string): Promise<void> {
    const sName = this.sanitizeName(name)
    await execFileAsync('tmux', ['new-session', '-d', '-s', sName, '-c', cwd])
  }

  async killSession(name: string): Promise<void> {
    const sName = this.sanitizeName(name)
    await execAsync(`tmux kill-session -t "${sName}"`)
  }

  async renameSession(oldName: string, newName: string): Promise<void> {
    const sOld = this.sanitizeName(oldName)
    const sNew = this.sanitizeName(newName)
    await execAsync(`tmux rename-session -t "${sOld}" "${sNew}"`)
  }

  // -- I/O -----------------------------------------------------------------

  async sendKeys(
    name: string,
    keys: string,
    opts: { literal?: boolean; enter?: boolean } = {}
  ): Promise<void> {
    const sName = this.sanitizeName(name)
    const { literal = false, enter = false } = opts

    if (literal) {
      const escaped = keys.replace(/'/g, "'\\''")
      if (enter) {
        await execAsync(
          `tmux send-keys -t "${sName}" -l '${escaped}' \\; send-keys -t "${sName}" C-m`
        )
      } else {
        await execAsync(`tmux send-keys -t "${sName}" -l '${escaped}'`)
      }
    } else {
      // Non-literal: keys is a raw key sequence (e.g. "C-c", "exit Enter")
      // Validate that keys only contain safe tmux key names (alphanumeric, hyphens, spaces)
      if (!/^[a-zA-Z0-9\-_ "]+$/.test(keys)) {
        throw new Error(`Unsafe tmux key sequence rejected: ${keys.slice(0, 50)}`)
      }
      if (enter) {
        await execAsync(`tmux send-keys -t "${sName}" ${keys} C-m`)
      } else {
        await execAsync(`tmux send-keys -t "${sName}" ${keys}`)
      }
    }
  }

  /**
   * Paste text from a file into the pane via tmux load-buffer + paste-buffer.
   * More reliable than send-keys -l for TUI apps (e.g., Codex) that don't
   * handle literal key injection well. Sends Enter after pasting.
   */
  async pasteFromFile(name: string, filePath: string): Promise<void> {
    const sName = this.sanitizeName(name)
    const bufName = `orch-${sName}`
    const sPath = filePath.replace(/[^a-zA-Z0-9\-_./~ ]/g, '')
    await execAsync(`tmux load-buffer -b "${bufName}" "${sPath}"`)
    await execAsync(`tmux paste-buffer -b "${bufName}" -t "${sName}"`)
    // Delay to let the TUI process the paste, then send Enter twice
    // (some TUIs like Gemini CLI need an extra Enter after paste)
    await new Promise(r => setTimeout(r, 1000))
    await execAsync(`tmux send-keys -t "${sName}" Enter`)
    await new Promise(r => setTimeout(r, 300))
    await execAsync(`tmux send-keys -t "${sName}" Enter`)
    // Clean up buffer
    await execAsync(`tmux delete-buffer -b "${bufName}" 2>/dev/null || true`)
  }

  async capturePane(name: string, lines: number = 2000): Promise<string> {
    try {
      const sName = this.sanitizeName(name)
      const sLines = Math.max(1, Math.min(10000, Math.floor(lines)))
      const { stdout } = await execAsync(
        `tmux capture-pane -t "${sName}" -p -S -${sLines} 2>/dev/null || tmux capture-pane -t "${sName}" -p`,
        { encoding: 'utf8', timeout: 3000, shell: '/bin/bash' }
      )
      return stdout
    } catch {
      return ''
    }
  }

  // -- Environment ---------------------------------------------------------

  async setEnvironment(name: string, key: string, value: string): Promise<void> {
    const sName = this.sanitizeName(name)
    const sKey = key.replace(/[^a-zA-Z0-9_]/g, '')
    const sValue = value.replace(/'/g, "'\\''")
    await execAsync(`tmux set-environment -t "${sName}" ${sKey} '${sValue}'`)
  }

  async unsetEnvironment(name: string, key: string): Promise<void> {
    const sName = this.sanitizeName(name)
    const sKey = key.replace(/[^a-zA-Z0-9_]/g, '')
    await execAsync(`tmux set-environment -t "${sName}" -r ${sKey} 2>/dev/null || true`)
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
