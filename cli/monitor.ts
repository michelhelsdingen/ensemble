#!/usr/bin/env tsx
/**
 * Ensemble Monitor — Beautiful TUI for watching team collaboration
 * Zero dependencies beyond Node.js built-ins.
 *
 * Usage:
 *   ensemble monitor [team-id]        # Watch a specific team
 *   ensemble monitor --latest          # Watch the most recent active team
 *   ensemble monitor                   # Interactive team picker
 */

import http from 'http'
import readline from 'readline'
import { resolveAgentProgram } from '../lib/agent-config'

// ─────────────────────────── ANSI ESCAPE CODES ───────────────────────────

const ESC = '\x1b'
const CSI = `${ESC}[`

const color = {
  reset: `${CSI}0m`,
  bold: `${CSI}1m`,
  dim: `${CSI}2m`,
  italic: `${CSI}3m`,
  underline: `${CSI}4m`,

  // Foreground
  black: `${CSI}30m`,
  red: `${CSI}31m`,
  green: `${CSI}32m`,
  yellow: `${CSI}33m`,
  blue: `${CSI}34m`,
  magenta: `${CSI}35m`,
  cyan: `${CSI}36m`,
  white: `${CSI}37m`,
  gray: `${CSI}90m`,

  // Bright foreground
  brightRed: `${CSI}91m`,
  brightGreen: `${CSI}92m`,
  brightYellow: `${CSI}93m`,
  brightBlue: `${CSI}94m`,
  brightMagenta: `${CSI}95m`,
  brightCyan: `${CSI}96m`,
  brightWhite: `${CSI}97m`,

  // Background
  bgBlack: `${CSI}40m`,
  bgRed: `${CSI}41m`,
  bgGreen: `${CSI}42m`,
  bgYellow: `${CSI}43m`,
  bgBlue: `${CSI}44m`,
  bgMagenta: `${CSI}45m`,
  bgCyan: `${CSI}46m`,
  bgWhite: `${CSI}47m`,
  bgGray: `${CSI}100m`,
  bgBrightBlue: `${CSI}104m`,
}

const cursor = {
  hide: `${CSI}?25l`,
  show: `${CSI}?25h`,
  home: `${CSI}H`,
  moveTo: (row: number, col: number) => `${CSI}${row};${col}H`,
  clearScreen: `${CSI}2J`,
  clearLine: `${CSI}2K`,
  saveCursor: `${ESC}7`,
  restoreCursor: `${ESC}8`,
}

// ─────────────────────────── AGENT COLORS ────────────────────────────────

interface AgentStyle {
  badge: string
  text: string
  icon: string
}

const agentStyles: Record<string, AgentStyle> = {
  orchestra: { badge: `${color.bgGray}${color.brightWhite}`, text: color.gray, icon: '⚙' },
  user: { badge: `${color.bgCyan}${color.black}`, text: color.brightCyan, icon: '▸' },
}

const programColorStyles: Record<string, Omit<AgentStyle, 'icon'>> = {
  blue: { badge: `${color.bgBlue}${color.brightWhite}`, text: color.brightBlue },
  green: { badge: `${color.bgGreen}${color.brightWhite}`, text: color.brightGreen },
  magenta: { badge: `${color.bgMagenta}${color.brightWhite}`, text: color.brightMagenta },
  yellow: { badge: `${color.bgYellow}${color.black}`, text: color.brightYellow },
  white: { badge: `${color.bgWhite}${color.black}`, text: color.white },
}

function getAgentStyle(name: string): AgentStyle {
  if (name === 'orchestra' || name === 'user') return agentStyles[name]

  const program = resolveAgentProgram(name)
  const style = programColorStyles[program.color] || programColorStyles.white
  return { ...style, icon: program.icon }
}

// ─────────────────────────── API CLIENT ──────────────────────────────────

const API_BASE = process.env.ENSEMBLE_URL || 'http://localhost:23000'

function apiGet<T>(path: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_BASE)
    http.get(url.toString(), { timeout: 5000 }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

function apiPost<T>(path: string, body: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_BASE)
    const payload = JSON.stringify(body)
    const req = http.request(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 5000,
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

// ─────────────────────────── TYPES ───────────────────────────────────────

interface Team {
  id: string
  name: string
  description: string
  status: string
  agents: Array<{ name: string; program: string; role: string; status: string }>
  createdAt: string
}

interface Message {
  id: string
  from: string
  to: string
  content: string
  timestamp: string
  type: string
}

// ─────────────────────────── TUI RENDERER ────────────────────────────────

class Monitor {
  private team: Team | null = null
  private messages: Message[] = []
  private lastMessageCount = 0
  private readonly MAX_MESSAGES = 1000
  private lastSeenTimestamp: string | null = null
  private scrollOffset = 0
  private inputMode = false
  private inputBuffer = ''
  private inputTarget = 'team'
  private pollInterval: ReturnType<typeof setInterval> | null = null
  private cols = process.stdout.columns || 120
  private rows = process.stdout.rows || 40
  private startTime = Date.now()
  private completionMenuActive = false
  private completionMenuSelection = 0
  private showInlineSummary = false
  private idleSuppressedUntil = 0
  private readonly IDLE_THRESHOLD_MS = 60_000

  private readonly completionMenuOptions = [
    { label: 'Samenvatting tonen', icon: '📋' },
    { label: 'Team door laten werken', icon: '▶' },
    { label: 'Bijsturen met nieuw doel', icon: '✎' },
    { label: 'Disband team', icon: '✕' },
  ]

  constructor(private teamId: string) {}

  async start() {
    // Setup terminal
    process.stdout.write(cursor.hide)
    process.stdout.write(cursor.clearScreen)
    process.stdin.setRawMode?.(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')

    // Handle resize
    process.stdout.on('resize', () => {
      this.cols = process.stdout.columns || 120
      this.rows = process.stdout.rows || 40
      this.render()
    })

    // Handle input
    process.stdin.on('data', (key: string) => this.handleInput(key))

    // Initial fetch
    await this.fetchTeam()
    await this.fetchMessages()
    this.render()

    // Poll every 2 seconds
    this.pollInterval = setInterval(async () => {
      try {
        await this.fetchTeam()
        await this.fetchMessages()
        if (this.messages.length !== this.lastMessageCount) {
          this.lastMessageCount = this.messages.length
          this.scrollOffset = 0 // auto-scroll to bottom
          // Dismiss completion menu when new activity arrives
          if (this.completionMenuActive) {
            this.completionMenuActive = false
            this.completionMenuSelection = 0
          }
          this.render()
        } else if (
          !this.completionMenuActive &&
          !this.inputMode &&
          !this.showInlineSummary &&
          this.messages.length > 0
        ) {
          // Check idle based on last agent message timestamp
          const lastAgentMsg = this.getLastAgentMessageTime()
          const now = Date.now()
          if (lastAgentMsg > 0 && now - lastAgentMsg >= this.IDLE_THRESHOLD_MS && now > this.idleSuppressedUntil) {
            this.completionMenuActive = true
            this.completionMenuSelection = 0
            this.render()
          }
        }
      } catch { /* connection lost, will retry */ }
    }, 2000)
  }

  private async fetchTeam() {
    const data = await apiGet<{ team: Team }>(`/api/orchestra/teams/${this.teamId}`)
    this.team = data.team
  }

  private async fetchMessages() {
    const sinceParam = this.lastSeenTimestamp ? `?since=${encodeURIComponent(this.lastSeenTimestamp)}` : ''
    const data = await apiGet<{ messages: Message[] }>(`/api/orchestra/teams/${this.teamId}/feed${sinceParam}`)
    const newMessages = data.messages || []

    if (this.lastSeenTimestamp && newMessages.length > 0) {
      // Incremental: append only new messages
      this.messages.push(...newMessages)
    } else if (!this.lastSeenTimestamp) {
      // Initial fetch: take all
      this.messages = newMessages
    }

    // Update cursor to latest timestamp
    if (this.messages.length > 0) {
      this.lastSeenTimestamp = this.messages[this.messages.length - 1].timestamp
    }

    // Cap buffer to prevent unbounded growth
    if (this.messages.length > this.MAX_MESSAGES) {
      this.messages = this.messages.slice(-this.MAX_MESSAGES)
    }
  }

  private handleInput(key: string) {
    // Ctrl+C — exit
    if (key === '\x03') {
      this.cleanup()
      process.exit(0)
    }

    // Completion menu navigation
    if (this.completionMenuActive) {
      if (key === '\x1b[A') { // Up arrow
        this.completionMenuSelection = Math.max(0, this.completionMenuSelection - 1)
        this.render()
      } else if (key === '\x1b[B') { // Down arrow
        this.completionMenuSelection = Math.min(this.completionMenuOptions.length - 1, this.completionMenuSelection + 1)
        this.render()
      } else if (key === '\r' || key === '\n') { // Enter — select
        this.handleCompletionChoice(this.completionMenuSelection)
      } else if (key === '\x1b') { // Escape — dismiss menu
        this.completionMenuActive = false
        this.completionMenuSelection = 0
        this.render()
      }
      return
    }

    // Inline summary dismiss
    if (this.showInlineSummary) {
      if (key === '\x1b' || key === 'q' || key === 'Q') {
        this.showInlineSummary = false
        this.render()
      }
      return
    }

    if (this.inputMode) {
      if (key === '\x1b') {
        // Escape — cancel input
        this.inputMode = false
        this.inputBuffer = ''
        this.render()
      } else if (key === '\r' || key === '\n') {
        // Enter — send message
        if (this.inputBuffer.trim()) {
          this.sendMessage(this.inputBuffer.trim())
        }
        this.inputMode = false
        this.inputBuffer = ''
        this.render()
      } else if (key === '\x7f') {
        // Backspace
        this.inputBuffer = this.inputBuffer.slice(0, -1)
        this.render()
      } else if (key.charCodeAt(0) >= 32) {
        this.inputBuffer += key
        this.render()
      }
      return
    }

    switch (key) {
      case 's': case 'S':
        // Start input mode — send to team
        this.inputMode = true
        this.inputTarget = 'team'
        this.inputBuffer = ''
        this.render()
        break
      case '1': case '2': case '3': case '4':
        // Send to specific agent
        if (this.team?.agents) {
          const idx = parseInt(key) - 1
          if (idx < this.team.agents.length) {
            this.inputMode = true
            this.inputTarget = this.team.agents[idx].name
            this.inputBuffer = ''
            this.render()
          }
        }
        break
      case 'k': case '\x1b[A': // Up
        this.scrollOffset = Math.min(this.scrollOffset + 3, Math.max(0, this.messages.length - 5))
        this.render()
        break
      case 'j': case '\x1b[B': // Down
        this.scrollOffset = Math.max(0, this.scrollOffset - 3)
        this.render()
        break
      case 'q': case 'Q':
        this.cleanup()
        process.exit(0)
        break // eslint: no-fallthrough (process.exit above, but lint can't detect)
      case 'd': case 'D':
        // Disband team
        this.disbandTeam()
        break
    }
  }

  private async sendMessage(content: string) {
    try {
      await apiPost(`/api/orchestra/teams/${this.teamId}`, {
        from: 'user',
        to: this.inputTarget,
        content,
      })
      // Immediately fetch new messages
      await this.fetchMessages()
      this.render()
    } catch (err) {
      // Will show in next render
    }
  }

  private async disbandTeam() {
    try {
      // Fetch final messages BEFORE disbanding
      await this.fetchMessages()
      await apiPost(`/api/orchestra/teams/${this.teamId}/disband`, {})

      // Save summary to file — the main Claude session will present it
      const agentMsgs = this.messages.filter(m => m.from !== 'orchestra' && m.from !== 'user')
      const agents = [...new Set(agentMsgs.map(m => m.from))]
      const duration = this.formatDuration(Date.now() - this.startTime)

      const summaryFile = `/tmp/collab-summary-${this.teamId}.txt`
      const summaryText = agents.map(agent => {
        const msgs = agentMsgs.filter(m => m.from === agent)
        const first = msgs[0]?.content.replace(/\/tmp\/orchestra[-\w]*/g, '').trim() || ''
        const last = msgs[msgs.length - 1]?.content.replace(/\/tmp\/orchestra[-\w]*/g, '').trim() || ''
        return `${agent} (${msgs.length} msgs):\n  Start: ${first.slice(0, 300)}\n  Eind: ${last.slice(0, 500)}`
      }).join('\n\n')

      const fs = await import('fs')
      fs.writeFileSync(summaryFile, `Task: ${this.team?.description || 'unknown'}\nDuration: ${duration}\nMessages: ${agentMsgs.length}\n\n${summaryText}`)

      // Exit cleanly — summary will appear in main session
      this.cleanup()
      process.exit(0)
    } catch { /* ignore */ }
  }

  private getLastAgentMessageTime(): number {
    const agentMsgs = this.messages.filter(m => m.from !== 'orchestra' && m.from !== 'user')
    if (agentMsgs.length === 0) return 0
    const last = agentMsgs[agentMsgs.length - 1]
    return new Date(last.timestamp).getTime()
  }

  private handleCompletionChoice(choice: number) {
    this.completionMenuActive = false
    this.completionMenuSelection = 0

    switch (choice) {
      case 0: // Samenvatting tonen
        this.showInlineSummary = true
        this.render()
        break
      case 1: // Team door laten werken — suppress menu for another 60s
        this.idleSuppressedUntil = Date.now() + this.IDLE_THRESHOLD_MS
        this.render()
        break
      case 2: // Bijsturen met nieuw doel
        this.inputMode = true
        this.inputTarget = 'team'
        this.inputBuffer = ''
        this.render()
        break
      case 3: // Disband team
        this.disbandTeam()
        break
    }
  }

  private cleanup() {
    if (this.pollInterval) clearInterval(this.pollInterval)
    process.stdout.write(cursor.show)
    process.stdout.write(cursor.clearScreen)
    process.stdout.write(cursor.home)
    process.stdin.setRawMode?.(false)
  }

  // ─── RENDERING ──────────────────────────────────────────────────────

  private render() {
    const out: string[] = []
    out.push(cursor.home)
    out.push(cursor.clearScreen)

    const w = this.cols
    const h = this.rows

    // ── Header ──
    out.push(this.renderHeader(w))

    // ── Agent Status Bar ──
    out.push(this.renderAgentBar(w))

    // ── Separator ──
    out.push(`${color.gray}${'─'.repeat(w)}${color.reset}`)

    // ── Inline Summary (replaces messages area when active) ──
    const headerHeight = 4
    const completionMenuHeight = this.completionMenuActive ? 8 : 0
    const footerHeight = this.inputMode ? 4 : 3
    const messageAreaHeight = h - headerHeight - footerHeight - completionMenuHeight

    if (this.showInlineSummary) {
      out.push(this.renderInlineSummary(w, messageAreaHeight))
    } else {
      out.push(this.renderMessages(w, messageAreaHeight))
    }

    // ── Completion Menu ──
    if (this.completionMenuActive) {
      out.push(this.renderCompletionMenu(w))
    }

    // ── Footer ──
    out.push(this.renderFooter(w))

    process.stdout.write(out.join(''))
  }

  private renderHeader(w: number): string {
    const lines: string[] = []

    // Title bar
    const title = this.team ? ` ◈ ensemble — ${this.team.name} ` : ' ◈ ensemble monitor '
    const status = this.team?.status || 'connecting...'
    const statusColor = status === 'active' ? color.brightGreen
      : status === 'disbanded' ? color.red
      : color.yellow

    const elapsed = this.formatDuration(Date.now() - this.startTime)
    const msgCount = `${this.messages.filter(m => m.from !== 'orchestra').length} msgs`
    const rightInfo = ` ${elapsed} │ ${msgCount} `

    const titleLen = this.stripAnsi(title).length
    const rightLen = rightInfo.length
    const statusText = ` ${status.toUpperCase()} `
    const statusLen = statusText.length
    const padding = Math.max(0, w - titleLen - statusLen - rightLen)

    lines.push(
      `${color.bold}${color.bgBlack}${color.brightWhite}${title}` +
      `${statusColor}${color.bold}${statusText}${color.reset}` +
      `${color.bgBlack}${' '.repeat(padding)}` +
      `${color.gray}${rightInfo}${color.reset}`
    )

    // Description
    if (this.team?.description) {
      const desc = this.team.description.length > w - 4
        ? this.team.description.slice(0, w - 7) + '...'
        : this.team.description
      lines.push(`${color.dim}  ${desc}${color.reset}`)
    }

    return lines.map(l => l + '\n').join('')
  }

  private renderAgentBar(_w: number): string {
    if (!this.team?.agents) return ''

    const parts: string[] = []
    for (let i = 0; i < this.team.agents.length; i++) {
      const agent = this.team.agents[i]
      const style = getAgentStyle(agent.program)
      const statusDot = agent.status === 'active' ? `${color.brightGreen}●`
        : agent.status === 'spawning' ? `${color.yellow}◌`
        : `${color.red}○`

      parts.push(
        `  ${statusDot} ${style.badge} ${agent.name} ${color.reset}` +
        `${color.dim} (${agent.program})${color.reset}` +
        `${color.gray} [${i + 1}]${color.reset}`
      )
    }

    return parts.join('    ') + '\n'
  }

  private renderMessages(w: number, maxLines: number): string {
    const lines: string[] = []
    const agentMessages = this.messages.filter(m => m.from !== 'orchestra' || m.content.includes('❌'))

    // Calculate visible range
    const totalRendered: string[] = []
    for (const msg of agentMessages) {
      totalRendered.push(...this.renderMessage(msg, w))
    }

    const start = Math.max(0, totalRendered.length - maxLines - this.scrollOffset)
    const visible = totalRendered.slice(start, start + maxLines)

    // Fill remaining space
    while (visible.length < maxLines) {
      visible.push('')
    }

    for (const line of visible) {
      lines.push(`${cursor.clearLine}${line}\n`)
    }

    return lines.join('')
  }

  private renderMessage(msg: Message, w: number): string[] {
    const lines: string[] = []
    const style = getAgentStyle(msg.from)
    const time = new Date(msg.timestamp).toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    })

    // Agent badge
    const badge = `${style.badge}${color.bold} ${msg.from} ${color.reset}`
    const timeStr = `${color.gray}${time}${color.reset}`
    const header = `  ${style.text}${style.icon}${color.reset} ${badge} ${timeStr}`

    lines.push(header)

    // Clean and structure content for terminal display
    const contentWidth = w - 8
    const raw = msg.content
      .replace(/\s*\/tmp\/orchestra[-\w]*\s*/g, '')  // strip leaked path
      .trim()

    // Parse into structured blocks
    const rendered = this.renderMarkdown(raw, style, contentWidth)
    for (const rLine of rendered) {
      lines.push(`    ${color.dim}│${color.reset} ${rLine}`)
    }

    lines.push('') // spacing between messages

    return lines
  }

  private renderFooter(w: number): string {
    const lines: string[] = []

    // Separator
    lines.push(`${color.gray}${'─'.repeat(w)}${color.reset}\n`)

    if (this.inputMode) {
      const targetStyle = getAgentStyle(this.inputTarget)
      lines.push(
        `${color.bgBlack}${color.brightWhite} ▸ To: ` +
        `${targetStyle.badge} ${this.inputTarget} ${color.reset}` +
        `${color.bgBlack} │ ESC cancel │ ENTER send ${color.reset}\n`
      )
      lines.push(
        `${color.brightWhite}  › ${color.reset}${this.inputBuffer}${color.brightWhite}█${color.reset}\n`
      )
    } else {
      const scrollInfo = this.scrollOffset > 0
        ? `${color.yellow} ↑${this.scrollOffset}${color.reset} │ `
        : ''

      lines.push(
        `${color.gray} [s]${color.reset} steer team  ` +
        `${color.gray}[1-${this.team?.agents.length || 2}]${color.reset} steer agent  ` +
        `${color.gray}[j/k]${color.reset} scroll  ` +
        `${scrollInfo}` +
        `${color.gray}[d]${color.reset} disband  ` +
        `${color.gray}[q]${color.reset} quit\n`
      )
    }

    return lines.join('')
  }

  private renderCompletionMenu(w: number): string {
    const lines: string[] = []
    const boxW = Math.min(52, w - 4)
    const innerW = boxW - 4 // account for "│ " and " │"

    // Top border
    lines.push(`${color.dim}  ┌${'─'.repeat(boxW - 2)}┐${color.reset}\n`)

    // Title
    const title = '⏳ Agents idle — what next?'
    const titlePad = Math.max(0, innerW - title.length)
    lines.push(
      `${color.dim}  │${color.reset} ${color.bold}${color.brightYellow}${title}${color.reset}` +
      `${' '.repeat(titlePad)}${color.dim} │${color.reset}\n`
    )

    // Separator
    lines.push(`${color.dim}  ├${'─'.repeat(boxW - 2)}┤${color.reset}\n`)

    // Options
    for (let i = 0; i < this.completionMenuOptions.length; i++) {
      const opt = this.completionMenuOptions[i]
      const isSelected = i === this.completionMenuSelection
      const marker = isSelected ? `${color.brightWhite}${color.bold}▸` : `${color.dim} `
      const label = isSelected
        ? `${color.brightWhite}${color.bold}${opt.icon}  ${opt.label}`
        : `${color.gray}${opt.icon}  ${opt.label}`
      const labelLen = opt.icon.length + 2 + opt.label.length + (isSelected ? 1 : 1)
      const pad = Math.max(0, innerW - labelLen)
      lines.push(
        `${color.dim}  │${color.reset} ${marker} ${label}${color.reset}` +
        `${' '.repeat(pad)}${color.dim}│${color.reset}\n`
      )
    }

    // Bottom border with hints
    lines.push(`${color.dim}  ├${'─'.repeat(boxW - 2)}┤${color.reset}\n`)
    const hints = '↑↓ navigate  ⏎ select  ESC dismiss'
    const hintsPad = Math.max(0, innerW - hints.length)
    lines.push(
      `${color.dim}  │ ${hints}${' '.repeat(hintsPad)} │${color.reset}\n`
    )
    lines.push(`${color.dim}  └${'─'.repeat(boxW - 2)}┘${color.reset}\n`)

    return lines.join('')
  }

  private renderInlineSummary(w: number, maxLines: number): string {
    const lines: string[] = []

    lines.push(`\n`)
    lines.push(
      `  ${color.bold}${color.brightWhite}◈ Session Summary${color.reset}` +
      `${color.dim}  (press ESC or q to return)${color.reset}\n`
    )
    lines.push(`${color.gray}${'─'.repeat(w)}${color.reset}\n`)

    const agentMsgs = this.messages.filter(m => m.from !== 'orchestra' && m.from !== 'user')
    const agents = [...new Set(agentMsgs.map(m => m.from))]
    const duration = this.formatDuration(Date.now() - this.startTime)

    lines.push(
      `  ${color.dim}${duration} · ${agentMsgs.length} messages · ${agents.length} agents${color.reset}\n`
    )

    if (this.team?.description) {
      const desc = this.team.description.length > w - 10
        ? this.team.description.slice(0, w - 13) + '...'
        : this.team.description
      lines.push(`  ${color.dim}Task:${color.reset} ${desc}\n`)
    }

    lines.push(`\n`)

    for (const agent of agents) {
      const msgs = agentMsgs.filter(m => m.from === agent)
      const style = getAgentStyle(agent)
      lines.push(
        `  ${style.badge}${color.bold} ${agent} ${color.reset}` +
        ` ${color.dim}(${msgs.length} messages)${color.reset}\n`
      )

      if (msgs.length > 0) {
        const first = msgs[0].content.replace(/\/tmp\/orchestra[-\w]*/g, '').trim()
        const firstTrunc = first.slice(0, w - 14) + (first.length > w - 14 ? '...' : '')
        lines.push(`  ${color.dim}Start:${color.reset} ${style.text}${firstTrunc}${color.reset}\n`)
      }
      if (msgs.length > 1) {
        const last = msgs[msgs.length - 1].content.replace(/\/tmp\/orchestra[-\w]*/g, '').trim()
        const lastTrunc = last.slice(0, w - 14) + (last.length > w - 14 ? '...' : '')
        lines.push(`  ${color.dim}Eind:${color.reset}  ${style.text}${lastTrunc}${color.reset}\n`)
      }
      lines.push(`\n`)
    }

    // Pad remaining lines
    while (lines.length < maxLines) {
      lines.push(`\n`)
    }

    return lines.slice(0, maxLines).join('')
  }

  // ─── HELPERS ────────────────────────────────────────────────────────

  private renderMarkdown(raw: string, style: AgentStyle, width: number): string[] {
    const lines: string[] = []
    const txt = style.text
    const rst = color.reset

    // First: split content into logical segments
    // Detect patterns like "**1." or numbered items or "---" as block separators
    const content = raw
      // Normalize: turn "**N." patterns into newlines for list items
      .replace(/\*\*(\d+)\.\s*/g, '\n\n$1. ')
      // Turn "---" separators into blank lines
      .replace(/\s*---\s*/g, '\n\n')
      // Turn "Pro:" / "Con:" / "Tagline:" etc into new lines
      .replace(/\s+(Pro:|Con:|Tagline:|Why |How |USP|PHASE|OPTIE|SAMENVATTING)/g, '\n  $1')
      // Turn "```" code blocks into indented blocks
      .replace(/```(\w*)\n?/g, '\n')

    // Split into paragraphs on double newlines
    const paragraphs = content.split(/\n{2,}/)

    for (const para of paragraphs) {
      const trimmed = para.trim()
      if (!trimmed) {
        lines.push('')
        continue
      }

      // Split on single newlines within paragraph
      const sublines = trimmed.split('\n')

      for (const sub of sublines) {
        let line = sub.trim()
        if (!line) continue

        // Apply inline formatting
        // **bold** → terminal bold
        line = line.replace(/\*\*([^*]+)\*\*/g, `${color.bold}${color.brightWhite}$1${rst}${txt}`)
        // `code` → dim
        line = line.replace(/`([^`]+)`/g, `${color.dim}$1${rst}${txt}`)
        // Emoji cleanup (keep as-is, they render fine)

        // Detect line type for prefix styling
        const isListItem = /^\d+\.\s/.test(line)
        const isSubPoint = /^(Pro:|Con:|Tagline:|→|>|-)/.test(line)

        if (isListItem) {
          lines.push('') // space before list items
          const numMatch = line.match(/^(\d+)\.\s(.*)/)
          if (numMatch) {
            const num = numMatch[1]
            const rest = numMatch[2]
            const prefix = `${color.bold}${color.brightWhite}${num}.${rst} `
            const wrapped = this.wrapPlain(rest, width - 4)
            lines.push(`${prefix}${txt}${wrapped[0]}${rst}`)
            for (let i = 1; i < wrapped.length; i++) {
              lines.push(`   ${txt}${wrapped[i]}${rst}`)
            }
          }
        } else if (isSubPoint) {
          const wrapped = this.wrapPlain(line, width - 4)
          for (const w of wrapped) {
            lines.push(`   ${color.dim}${w}${rst}`)
          }
        } else {
          const wrapped = this.wrapPlain(line, width)
          for (const w of wrapped) {
            lines.push(`${txt}${w}${rst}`)
          }
        }
      }
    }

    return lines
  }

  private wrapPlain(text: string, width: number): string[] {
    // Strip any existing ANSI codes for clean wrapping
    // eslint-disable-next-line no-control-regex
    const clean = text.replace(/\x1b\[[0-9;]*m/g, '')
    if (clean.length <= width) return [clean]

    const lines: string[] = []
    let remaining = clean

    while (remaining.length > 0) {
      if (remaining.length <= width) {
        lines.push(remaining)
        break
      }
      let breakAt = remaining.lastIndexOf(' ', width)
      if (breakAt <= 0) breakAt = width
      lines.push(remaining.slice(0, breakAt))
      remaining = remaining.slice(breakAt).trimStart()
    }

    return lines
  }

  private formatDuration(ms: number): string {
    const s = Math.floor(ms / 1000)
    const m = Math.floor(s / 60)
    const h = Math.floor(m / 60)
    if (h > 0) return `${h}h${m % 60}m`
    if (m > 0) return `${m}m${s % 60}s`
    return `${s}s`
  }

  private stripAnsi(str: string): string {
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1b\[[0-9;]*m/g, '')
  }
}

// ─────────────────────────── TEAM PICKER ─────────────────────────────────

async function pickTeam(): Promise<string> {
  try {
    const data = await apiGet<{ teams: Team[] }>('/api/orchestra/teams')
    const teams = data.teams.filter(t => t.status === 'active' || t.status === 'forming')

    if (teams.length === 0) {
      console.log(`\n${color.yellow}  No active teams found.${color.reset}`)
      console.log(`${color.gray}  Start one with: ensemble team create${color.reset}\n`)
      process.exit(1)
    }

    if (teams.length === 1) {
      return teams[0].id
    }

    // Interactive picker
    console.log(`\n${color.bold}${color.brightWhite}  ◈ ensemble — select team${color.reset}\n`)

    for (let i = 0; i < teams.length; i++) {
      const t = teams[i]
      const statusColor = t.status === 'active' ? color.brightGreen : color.yellow
      const agents = t.agents.map(a => {
        const s = getAgentStyle(a.program)
        return `${s.text}${s.icon} ${a.name}${color.reset}`
      }).join(' + ')

      console.log(
        `  ${color.brightWhite}${i + 1})${color.reset} ` +
        `${statusColor}●${color.reset} ${color.bold}${t.name}${color.reset}` +
        `  ${agents}` +
        `  ${color.dim}${t.description.slice(0, 60)}${color.reset}`
      )
    }

    console.log()

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    return new Promise((resolve) => {
      rl.question(`${color.gray}  Select [1-${teams.length}]: ${color.reset}`, (answer) => {
        rl.close()
        const idx = parseInt(answer) - 1
        if (idx >= 0 && idx < teams.length) {
          resolve(teams[idx].id)
        } else {
          resolve(teams[0].id)
        }
      })
    })
  } catch (err) {
    console.error(`\n${color.red}  Cannot connect to ensemble server at ${API_BASE}${color.reset}`)
    console.error(`${color.gray}  Start it with: cd ~/Documents/ensemble && npm run dev${color.reset}\n`)
    process.exit(1)
  }
}

// ─────────────────────────── MAIN ────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)

  let teamId: string

  if (args[0] === '--latest' || args[0] === '-l') {
    const data = await apiGet<{ teams: Team[] }>('/api/orchestra/teams')
    const active = data.teams.filter(t => t.status === 'active' || t.status === 'forming')
    if (active.length === 0) {
      console.log(`${color.yellow}No active teams.${color.reset}`)
      process.exit(1)
    }
    teamId = active[active.length - 1].id
  } else if (args[0] && !args[0].startsWith('-')) {
    teamId = args[0]
  } else {
    teamId = await pickTeam()
  }

  const monitor = new Monitor(teamId)
  await monitor.start()
}

main().catch((err) => {
  process.stdout.write(cursor.show)
  console.error(`${color.red}Error: ${err.message}${color.reset}`)
  process.exit(1)
})
