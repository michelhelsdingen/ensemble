import fs from 'fs'
import path from 'path'
import os from 'os'
import { v4 as uuidv4 } from 'uuid'
import type { OrchestraTeam, OrchestraMessage, CreateTeamRequest } from '../types/orchestra'
import { getOrchestraDataDir } from './ensemble-paths'
import { collabMessagesFile } from './collab-paths'

const ORCHESTRA_DIR = getOrchestraDataDir()
const TEAMS_FILE = path.join(ORCHESTRA_DIR, 'teams.json')
const MESSAGES_DIR = path.join(ORCHESTRA_DIR, 'messages')
const TEAMS_LOCK_DIR = `${TEAMS_FILE}.lock`
const LOCK_STALE_MS = 10_000
const LOCK_TIMEOUT_MS = 5_000

function getCreatedBy(): string {
  return process.env.ENSEMBLE_CREATED_BY?.trim()
    || process.env.USER
    || process.env.LOGNAME
    || os.hostname()
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function readTeamsFile(): OrchestraTeam[] {
  ensureDir(ORCHESTRA_DIR)
  if (!fs.existsSync(TEAMS_FILE)) return []
  return JSON.parse(fs.readFileSync(TEAMS_FILE, 'utf-8'))
}

function writeTeamsFile(teams: OrchestraTeam[]): void {
  ensureDir(ORCHESTRA_DIR)
  fs.writeFileSync(TEAMS_FILE, JSON.stringify(teams, null, 2))
}

function acquireTeamsLock(): () => void {
  ensureDir(ORCHESTRA_DIR)
  const startedAt = Date.now()

  while (true) {
    try {
      fs.mkdirSync(TEAMS_LOCK_DIR)
      return () => {
        try {
          fs.rmSync(TEAMS_LOCK_DIR, { recursive: true, force: true })
        } catch { /* best effort */ }
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code !== 'EEXIST') throw error

      try {
        const stat = fs.statSync(TEAMS_LOCK_DIR)
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(TEAMS_LOCK_DIR, { recursive: true, force: true })
          continue
        }
      } catch { /* lock changed while checking; retry */ }

      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out acquiring teams.json lock after ${LOCK_TIMEOUT_MS}ms`)
      }

      sleepSync(50)
    }
  }
}

function withTeamsLock<T>(fn: () => T): T {
  const release = acquireTeamsLock()
  try {
    return fn()
  } finally {
    release()
  }
}

export function loadTeams(): OrchestraTeam[] {
  return withTeamsLock(() => readTeamsFile())
}

export function saveTeams(teams: OrchestraTeam[]): void {
  withTeamsLock(() => {
    writeTeamsFile(teams)
  })
}

export function getTeam(id: string): OrchestraTeam | undefined {
  return loadTeams().find(t => t.id === id)
}

export function createTeam(request: CreateTeamRequest): OrchestraTeam {
  return withTeamsLock(() => {
    const teams = readTeamsFile()
    const team: OrchestraTeam = {
      id: uuidv4(),
      name: request.name,
      description: request.description,
      status: 'forming',
      agents: request.agents.map((a, i) => ({
        agentId: '',
        name: `${a.program.toLowerCase().includes('codex') ? 'codex' : 'claude'}-${i + 1}`,
        program: a.program,
        role: a.role || (i === 0 ? 'lead' : 'member'),
        hostId: a.hostId || '',
        status: 'spawning' as const,
      })),
      createdBy: getCreatedBy(),
      createdAt: new Date().toISOString(),
      feedMode: request.feedMode || 'live',
    }
    teams.push(team)
    writeTeamsFile(teams)
    return team
  })
}

export function updateTeam(id: string, updates: Partial<OrchestraTeam>): OrchestraTeam | undefined {
  return withTeamsLock(() => {
    const teams = readTeamsFile()
    const idx = teams.findIndex(t => t.id === id)
    if (idx === -1) return undefined
    teams[idx] = { ...teams[idx], ...updates }
    writeTeamsFile(teams)
    return teams[idx]
  })
}

export function appendMessage(teamId: string, message: OrchestraMessage): void {
  const dir = path.join(MESSAGES_DIR, teamId)
  ensureDir(dir)
  const file = path.join(dir, 'feed.jsonl')
  fs.appendFileSync(file, JSON.stringify(message) + '\n')
}

export function getMessages(teamId: string, since?: string): OrchestraMessage[] {
  const sources = [
    path.join(MESSAGES_DIR, teamId, 'feed.jsonl'),
    collabMessagesFile(teamId),
  ]

  const seenIds = new Set<string>()
  let messages: OrchestraMessage[] = []

  for (const file of sources) {
    if (!fs.existsSync(file)) continue
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean)
    for (const line of lines) {
      const msg = JSON.parse(line) as OrchestraMessage
      const dedupeKey = msg.id || `${msg.from}:${msg.timestamp}:${msg.content?.slice(0, 50)}`
      if (!seenIds.has(dedupeKey)) {
        seenIds.add(dedupeKey)
        messages.push(msg)
      }
    }
  }

  // Sort by timestamp (messages without timestamp go to the end)
  messages.sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : Infinity
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : Infinity
    return ta - tb
  })

  if (since) {
    messages = messages.filter(m => m.timestamp && m.timestamp > since)
  }
  return messages
}
