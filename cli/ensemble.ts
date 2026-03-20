#!/usr/bin/env tsx
/**
 * ensemble — CLI entrypoint
 *
 * Usage:
 *   ensemble monitor [--latest | team-id]   Watch team collaboration live
 *   ensemble teams                          List all teams
 *   ensemble steer <team-id> <message>      Send a message to a team
 *   ensemble status                         Server health + active teams
 */

import http from 'http'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'

const API_BASE = process.env.ENSEMBLE_URL || 'http://localhost:23000'

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
    console.log(`  ${c.dim}Run: npm run dev (from the ensemble directory)${c.r}\n`)
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

// ─── Main ───

const [cmd, ...args] = process.argv.slice(2)

switch (cmd) {
  case 'monitor':
  case 'watch':
  case 'mon': {
    const __filename = fileURLToPath(import.meta.url)
    const monitorPath = path.join(path.dirname(__filename), 'monitor.ts')
    const monitorArgs = args.length ? args : ['--latest']
    try {
      execFileSync('tsx', [monitorPath, ...monitorArgs], { stdio: 'inherit' })
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
  case 'steer':
  case 'send':
    if (args.length < 2) {
      console.log(`Usage: ensemble steer <team-id> <message>`)
      process.exit(1)
    }
    await cmdSteer(args[0], args.slice(1).join(' '))
    break
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    console.log(`
  ${c.bold}${c.bWhite}◈ ensemble${c.r} — multi-agent collaboration engine

  ${c.bold}Commands:${c.r}
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
    ${c.dim}ensemble monitor --latest${c.r}
    ${c.dim}ensemble steer abc123 "focus on security review"${c.r}
    ${c.dim}ensemble teams${c.r}
`)
    break
  default:
    console.log(`Unknown command: ${cmd}. Try: ensemble help`)
    process.exit(1)
}
