import fs from 'fs'
import path from 'path'
import os from 'os'
import { v4 as uuidv4 } from 'uuid'
import type { EnsembleTeam, EnsembleMessage, CreateTeamRequest } from '../types/ensemble'
import { getEnsembleRegistryDir } from './ensemble-paths'
import { emitEvent } from './brain-hooks'
import { collabMessagesFile } from './collab-paths'

const ENSEMBLE_DIR = getEnsembleRegistryDir()
const TEAMS_FILE = path.join(ENSEMBLE_DIR, 'teams.json')
const MESSAGES_DIR = path.join(ENSEMBLE_DIR, 'messages')
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

function parseTeamsFile(file: string): EnsembleTeam[] {
  const teams = JSON.parse(fs.readFileSync(file, 'utf-8'))
  if (!Array.isArray(teams)) throw new Error('Expected a team array')
  return teams
}

function readTeamsFile(): EnsembleTeam[] {
  ensureDir(ENSEMBLE_DIR)
  if (!fs.existsSync(TEAMS_FILE)) return []
  try {
    return parseTeamsFile(TEAMS_FILE)
  } catch (error) {
    console.error('[Ensemble] Cannot read teams.json; trying the last good backup:', error)
    try {
      return parseTeamsFile(`${TEAMS_FILE}.bak`)
    } catch (backupError) {
      console.error('[Ensemble] No readable team backup; returning an empty list:', backupError)
      return []
    }
  }
}

function atomicWrite(file: string, content: string): void {
  const temporary = `${file}.${uuidv4()}.tmp`
  try {
    fs.writeFileSync(temporary, content)
    fs.renameSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

function writeTeamsFile(teams: EnsembleTeam[]): void {
  ensureDir(ENSEMBLE_DIR)
  const content = JSON.stringify(teams, null, 2)
  atomicWrite(TEAMS_FILE, content)
  atomicWrite(`${TEAMS_FILE}.bak`, content)
}

function acquireTeamsLock(): () => void {
  ensureDir(ENSEMBLE_DIR)
  const startedAt = Date.now()

  for (;;) {
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

export function loadTeams(): EnsembleTeam[] {
  return withTeamsLock(() => readTeamsFile())
}

export function saveTeams(teams: EnsembleTeam[]): void {
  withTeamsLock(() => {
    writeTeamsFile(teams)
  })
}

export function getTeam(id: string): EnsembleTeam | undefined {
  return loadTeams().find(t => t.id === id)
}

export function createTeam(request: CreateTeamRequest): EnsembleTeam {
  return withTeamsLock(() => {
    const teams = readTeamsFile()
    const team: EnsembleTeam = {
      id: uuidv4(),
      name: request.name,
      description: request.description,
      status: 'forming',
      workingDirectory: request.workingDirectory || process.cwd(),
      worktree: request.worktree,
      agents: (request.agents ?? []).map((a, i) => ({
        agentId: '',
        name: `${a.program.toLowerCase().replace(/\s+/g, '-').split('-')[0]}-${i + 1}`,
        program: a.program,
        role: a.role || (i === 0 ? 'lead' : 'member'),
        hostId: a.hostId || '',
        status: 'spawning' as const,
      })),
      createdBy: getCreatedBy(),
      createdAt: new Date().toISOString(),
      feedMode: request.feedMode || 'live',
      ...(request.agentsExplicit && { agentsExplicit: true }),
    }
    teams.push(team)
    writeTeamsFile(teams)
    return team
  })
}

export function updateTeam(id: string, updates: Partial<EnsembleTeam>): EnsembleTeam | undefined {
  return withTeamsLock(() => {
    const teams = readTeamsFile()
    const idx = teams.findIndex(t => t.id === id)
    if (idx === -1) return undefined
    teams[idx] = { ...teams[idx], ...updates }
    writeTeamsFile(teams)
    return teams[idx]
  })
}

export function markAgentFailed(teamId: string, agentName: string): void {
  withTeamsLock(() => {
    const teams = readTeamsFile()
    const team = teams.find(team => team.id === teamId)
    const agent = team?.agents.find(candidate => candidate.name === agentName)
    if (!agent || agent.status === 'failed' || agent.status === 'replaced') return
    agent.status = 'failed'
    writeTeamsFile(teams)
    void emitEvent({ event: 'agent_failed', teamId, team: team!.name, agent: agentName, ts: new Date().toISOString(), detail: 'Agent failed' })
  })
}

export function appendMessage(teamId: string, message: EnsembleMessage): void {
  const dir = path.join(MESSAGES_DIR, teamId)
  ensureDir(dir)
  const file = path.join(dir, 'feed.jsonl')
  fs.appendFileSync(file, JSON.stringify(message) + '\n')
}

const warnedMessageFiles = new Set<string>()

export function getMessages(teamId: string, since?: string): EnsembleMessage[] {
  const sources = [
    path.join(MESSAGES_DIR, teamId, 'feed.jsonl'),
    collabMessagesFile(teamId),
  ]

  const seenIds = new Set<string>()
  let messages: EnsembleMessage[] = []

  for (const file of sources) {
    if (!fs.existsSync(file)) continue
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean)
    for (const line of lines) {
      let msg: EnsembleMessage
      try {
        msg = JSON.parse(line) as EnsembleMessage
        if (!msg || typeof msg.content !== 'string') throw new Error('Invalid message record')
      } catch {
        if (!warnedMessageFiles.has(file)) {
          console.warn(`[Ensemble] Skipping corrupt JSONL records in ${file}`)
          warnedMessageFiles.add(file)
        }
        continue
      }
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
