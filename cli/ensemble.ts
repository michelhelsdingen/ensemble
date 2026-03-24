#!/usr/bin/env tsx
/**
 * ensemble — CLI entrypoint
 *
 * Usage:
 *   ensemble run "task" [--agents x,y]      Run headless (no Claude Code needed)
 *   ensemble monitor [--latest | team-id]   Watch team collaboration live
 *   ensemble teams                          List all teams
 *   ensemble steer <team-id> <message>      Send a message to a team
 *   ensemble status                         Server health + active teams
 */

import http from 'http'
import fs from 'fs'
import { execFileSync, spawn } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'

const API_BASE = process.env.ENSEMBLE_URL || 'http://localhost:23000'

// Resolve package root (works both in dev and when installed via npm)
const __cli_filename = fileURLToPath(import.meta.url)
const ENSEMBLE_ROOT = process.env.ENSEMBLE_ROOT || path.resolve(path.dirname(__cli_filename), '..')

function findTsx(): string {
  // Check local node_modules first (npm installed package)
  const local = path.join(ENSEMBLE_ROOT, 'node_modules', '.bin', 'tsx')
  if (fs.existsSync(local)) return local
  // Fall back to global tsx
  return 'tsx'
}

// ANSI
const c = {
  r: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', gray: '\x1b[90m',
  bWhite: '\x1b[97m', bGreen: '\x1b[92m', bBlue: '\x1b[94m', bYellow: '\x1b[93m',
  bgBlue: '\x1b[44m', bgGreen: '\x1b[42m',
}

function apiGet<T>(urlPath: string): Promise<T> {
  return new Promise((resolve, reject) => {
    http.get(`${API_BASE}${urlPath}`, { timeout: 3000 }, res => {
      let d = ''
      res.on('data', chunk => d += chunk)
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch(e) { reject(e) } })
    }).on('error', reject)
  })
}

function apiPost(urlPath: string, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = http.request(`${API_BASE}${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) },
      timeout: 5000,
    }, res => {
      let d = ''
      res.on('data', chunk => d += chunk)
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch(e) { reject(e) } })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

// ─── Commands ───

async function cmdStatus() {
  try {
    const health = await apiGet<{ status: string; version: string }>('/api/v1/health')
    const teams = await apiGet<{ teams: Array<{ status: string }> }>('/api/ensemble/teams')
    const active = teams.teams.filter(t => t.status === 'active')

    console.log()
    console.log(`  ${c.bold}${c.bWhite}◈ ensemble${c.r} ${c.dim}v${health.version}${c.r}`)
    console.log(`  ${c.bGreen}●${c.r} Server healthy at ${c.dim}${API_BASE}${c.r}`)
    console.log()
    console.log(`  ${c.bold}Teams:${c.r} ${teams.teams.length} total, ${c.bGreen}${active.length} active${c.r}`)
    console.log()
  } catch {
    console.log(`\n  ${c.red}●${c.r} Cannot connect to ${API_BASE}`)
    console.log(`  ${c.dim}Run: ensemble start${c.r}\n`)
  }
}

interface TeamListItem {
  id: string
  name: string
  description: string
  status: string
  createdAt: string
  agents: Array<{ name: string; program: string }>
}

async function cmdTeams() {
  try {
    const data = await apiGet<{ teams: TeamListItem[] }>('/api/ensemble/teams')

    if (data.teams.length === 0) {
      console.log(`\n  ${c.yellow}No teams found.${c.r}\n`)
      return
    }

    console.log()
    console.log(`  ${c.bold}${c.bWhite}◈ ensemble teams${c.r}`)
    console.log()

    for (const t of data.teams) {
      const statusIcon = t.status === 'active' ? `${c.bGreen}●`
        : t.status === 'disbanded' ? `${c.red}○`
        : `${c.yellow}◌`

      const agents = t.agents.map(a => {
        const col = a.program.toLowerCase().includes('codex') ? c.bBlue : c.bGreen
        return `${col}${a.name}${c.r}`
      }).join(' + ')

      const time = new Date(t.createdAt).toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', hour12: false,
      })

      console.log(
        `  ${statusIcon}${c.r} ${c.bold}${t.name}${c.r}` +
        `  ${agents}` +
        `  ${c.dim}${time}${c.r}` +
        `  ${c.gray}${t.id.slice(0, 8)}${c.r}`
      )
      console.log(`    ${c.dim}${t.description.slice(0, 80)}${c.r}`)
      console.log()
    }
  } catch {
    console.log(`\n  ${c.red}Cannot connect to ensemble server.${c.r}\n`)
  }
}

async function cmdSteer(teamId: string, message: string) {
  try {
    await apiPost(`/api/ensemble/teams/${teamId}`, {
      from: 'user',
      to: 'team',
      content: message,
    })
    console.log(`${c.bGreen}✓${c.r} Message sent to team`)
  } catch {
    console.log(`${c.red}✗${c.r} Failed to send message`)
  }
}

async function cmdRun(task: string, agentFlags: string | undefined, timeoutSec: number) {
  const cwd = process.cwd()

  // 1. Ensure server is running
  let serverProc: ReturnType<typeof spawn> | null = null
  try {
    await apiGet('/api/v1/health')
  } catch {
    process.stderr.write(`  ${c.dim}Starting server...${c.r}\n`)
    serverProc = spawn(findTsx(), [path.join(ENSEMBLE_ROOT, 'server.ts')], {
      cwd: ENSEMBLE_ROOT, stdio: 'ignore', detached: true,
    })
    serverProc.unref()
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 1000))
      try { await apiGet('/api/v1/health'); break } catch { /* waiting */ }
    }
    try { await apiGet('/api/v1/health') } catch {
      console.error(`  ${c.red}Server failed to start${c.r}`)
      process.exit(1)
    }
  }

  // 2. Parse agents (default: codex + claude)
  const agentNames = agentFlags
    ? agentFlags.split(',').map(s => s.trim())
    : ['codex', 'claude code']
  const agents = agentNames.map((name, i) => ({
    program: name,
    role: i === 0 ? 'lead' : 'worker',
    hostId: 'local',
  }))

  // 3. Create team
  const teamName = `run-${Date.now()}`
  const result = await apiPost('/api/ensemble/teams', {
    name: teamName,
    description: task,
    agents,
    feedMode: 'live',
    workingDirectory: cwd,
  }) as { team: { id: string } }

  const teamId = result.team.id
  const messagesFile = `/tmp/ensemble/${teamId}/messages.jsonl`

  console.log(`\n  ${c.bold}${c.bWhite}◈ ensemble run${c.r}`)
  console.log(`  ${c.dim}${task.slice(0, 100)}${c.r}`)
  console.log(`  ${c.bGreen}●${c.r} Team ${c.dim}${teamId.slice(0, 8)}${c.r} created with ${agentNames.join(' + ')}`)
  console.log(`  ${c.dim}Timeout: ${timeoutSec}s${c.r}\n`)

  // 4. Tail messages until completion or timeout
  const deadline = Date.now() + timeoutSec * 1000
  let lastLine = 0
  const donePatterns = [/\bdone\b/i, /\bcomplete(?:d)?\b/i, /\bfinished\b/i, /\bafgerond\b/i]

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000))

    if (!fs.existsSync(messagesFile)) continue
    const lines = fs.readFileSync(messagesFile, 'utf-8').trim().split('\n').filter(Boolean)
    if (lines.length <= lastLine) continue

    for (let i = lastLine; i < lines.length; i++) {
      try {
        const msg = JSON.parse(lines[i])
        const from = msg.from || '?'
        const content = (msg.content || '').slice(0, 200)
        console.log(`  ${c.cyan}${from}${c.r}: ${content}`)
      } catch { /* skip */ }
    }
    lastLine = lines.length

    // Check team status
    try {
      const team = await apiGet<{ team: { status: string } }>(`/api/ensemble/teams/${teamId}`)
      if (team.team.status === 'disbanded') {
        console.log(`\n  ${c.bGreen}✓${c.r} Team finished (disbanded)`)
        process.exit(0)
      }
    } catch { /* ignore */ }

    // Check last few messages for done signals
    const recentContent = lines.slice(-3).map(l => {
      try { return JSON.parse(l).content || '' } catch { return '' }
    }).join(' ')
    if (donePatterns.some(p => p.test(recentContent))) {
      console.log(`\n  ${c.bGreen}✓${c.r} Task appears complete`)
      process.exit(0)
    }
  }

  console.log(`\n  ${c.yellow}⏱${c.r} Timeout reached (${timeoutSec}s)`)
  process.exit(124)
}

// ─── Main ───

const [cmd, ...args] = process.argv.slice(2)

switch (cmd) {
  case 'monitor':
  case 'watch':
  case 'mon': {
    const monitorPath = path.join(ENSEMBLE_ROOT, 'cli', 'monitor.ts')
    const monitorArgs = args.length ? args : ['--latest']
    try {
      execFileSync(findTsx(), [monitorPath, ...monitorArgs], { stdio: 'inherit', cwd: ENSEMBLE_ROOT })
    } catch { /* exit handled by monitor */ }
    break
  }
  case 'teams':
  case 'ls':
    await cmdTeams()
    break
  case 'status':
  case 'health':
    await cmdStatus()
    break
  case 'run': {
    const runArgs = [...args]
    let agentList: string | undefined
    let timeout = 600
    // Parse --agents and --timeout flags
    for (let i = 0; i < runArgs.length; i++) {
      if (runArgs[i] === '--agents' && runArgs[i + 1]) {
        agentList = runArgs.splice(i, 2)[1]; i--
      } else if (runArgs[i] === '--timeout' && runArgs[i + 1]) {
        timeout = parseInt(runArgs.splice(i, 2)[1], 10); i--
      }
    }
    const taskDesc = runArgs.join(' ')
    if (!taskDesc) {
      console.log(`Usage: ensemble run "task description" [--agents codex,claude] [--timeout 600]`)
      process.exit(1)
    }
    await cmdRun(taskDesc, agentList, timeout)
    break
  }
  case 'steer':
  case 'send':
    if (args.length < 2) {
      console.log(`Usage: ensemble steer <team-id> <message>`)
      process.exit(1)
    }
    await cmdSteer(args[0], args.slice(1).join(' '))
    break
  case 'start':
  case 'server': {
    try {
      await apiGet('/api/v1/health')
      console.log(`  ${c.bGreen}●${c.r} Server already running at ${c.dim}${API_BASE}${c.r}`)
    } catch {
      console.log(`  ${c.dim}Starting ensemble server...${c.r}`)
      const srv = spawn(findTsx(), [path.join(ENSEMBLE_ROOT, 'server.ts')], {
        cwd: ENSEMBLE_ROOT, stdio: 'inherit',
      })
      srv.on('exit', code => process.exit(code || 0))
      // Keep alive
      await new Promise(() => {})
    }
    break
  }
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    console.log(`
  ${c.bold}${c.bWhite}◈ ensemble${c.r} — multi-agent collaboration engine

  ${c.bold}Commands:${c.r}
    ${c.bWhite}start${c.r}                      Start the ensemble server
    ${c.bWhite}run${c.r} "task" [--agents ..]   Run headless (auto-starts server)
    ${c.bWhite}monitor${c.r} [--latest | id]   Watch team collaboration live
    ${c.bWhite}teams${c.r}                      List all teams
    ${c.bWhite}steer${c.r} <id> <message>       Send steering message to team
    ${c.bWhite}status${c.r}                     Server health & overview

  ${c.bold}Monitor keybindings:${c.r}
    ${c.bWhite}s${c.r}       Steer entire team
    ${c.bWhite}1-4${c.r}     Steer specific agent
    ${c.bWhite}j/k${c.r}     Scroll up/down
    ${c.bWhite}d${c.r}       Disband team
    ${c.bWhite}q${c.r}       Quit

  ${c.bold}Examples:${c.r}
    ${c.dim}ensemble run "refactor auth module" --agents gemini,claude${c.r}
    ${c.dim}ensemble run "fix all lint errors" --timeout 300${c.r}
    ${c.dim}ensemble monitor --latest${c.r}
    ${c.dim}ensemble steer abc123 "focus on security review"${c.r}
    ${c.dim}ensemble teams${c.r}
`)
    break
  default:
    console.log(`Unknown command: ${cmd}. Try: ensemble help`)
    process.exit(1)
}
