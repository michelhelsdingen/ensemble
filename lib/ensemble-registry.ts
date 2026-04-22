import fs from 'fs'
import path from 'path'
import os from 'os'
import { v4 as uuidv4 } from 'uuid'
import type { EnsembleTeam, EnsembleMessage, CreateTeamRequest, TeamPhase } from '../types/ensemble'
import { getEnsembleRegistryDir } from './ensemble-paths'
import { collabMessagesFile } from './collab-paths'

// A2: FSM transition table. Legal next phases for each current phase.
// * => failed is always allowed (panic exit). Terminal phases are disbanded/failed.
const LEGAL_PHASE_TRANSITIONS: Record<TeamPhase, TeamPhase[]> = {
  forming:      ['spawning', 'ready_wait', 'executing', 'failed'],
  spawning:     ['ready_wait', 'failed'],
  ready_wait:   ['planning', 'executing', 'failed'],
  planning:     ['executing', 'failed'],
  executing:    ['reviewing', 'done_pending', 'disbanding', 'failed'],
  reviewing:    ['done_pending', 'disbanding', 'failed'],
  done_pending: ['disbanding', 'failed'],
  disbanding:   ['disbanded', 'failed'],
  disbanded:    [], // terminal
  failed:       ['disbanding', 'disbanded'], // allow cleanup
}

export function canTransitionPhase(current: TeamPhase | undefined, next: TeamPhase): boolean {
  if (!current) return true // unset → any is fine (first transition)
  if (current === next) return true // idempotent
  const legal = LEGAL_PHASE_TRANSITIONS[current]
  return legal ? legal.includes(next) : false
}

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

// B2: schema migration — backfill fields for teams written by earlier versions.
const SCHEMA_VERSION = 2

function migrateTeam(raw: EnsembleTeam): EnsembleTeam {
  if ((raw as unknown as { schemaVersion?: number }).schemaVersion === SCHEMA_VERSION) return raw
  const statusToPhase: Record<string, TeamPhase> = {
    forming: 'forming',
    active: 'executing',
    paused: 'executing',
    completed: 'disbanded',
    disbanded: 'disbanded',
    failed: 'failed',
  }
  return {
    ...raw,
    phase: raw.phase ?? statusToPhase[raw.status] ?? 'forming',
    // @ts-expect-error — write schemaVersion so future migrations can skip migrated records
    schemaVersion: SCHEMA_VERSION,
  }
}

function readTeamsFile(): EnsembleTeam[] {
  ensureDir(ENSEMBLE_DIR)
  if (!fs.existsSync(TEAMS_FILE)) return []
  const raw = JSON.parse(fs.readFileSync(TEAMS_FILE, 'utf-8')) as EnsembleTeam[]
  return raw.map(migrateTeam)
}

function writeTeamsFile(teams: EnsembleTeam[]): void {
  ensureDir(ENSEMBLE_DIR)
  // Atomic write: temp file + rename. A plain writeFileSync can leave a
  // truncated/corrupt teams.json on crash or disk-full, bricking every
  // subsequent load. rename(2) is atomic on POSIX.
  const tmp = `${TEAMS_FILE}.tmp.${process.pid}.${Date.now()}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(teams, null, 2))
    fs.renameSync(tmp, TEAMS_FILE)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* already gone */ }
    throw err
  }
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

// Fix 2: sentinel error for CAS conflict — caller can catch and return 409
export class ActiveTeamExistsError extends Error {
  constructor(public readonly existingTeam: EnsembleTeam) {
    super(`Active team already exists for cwd: ${existingTeam.workingDirectory} (team: ${existingTeam.id})`)
    this.name = 'ActiveTeamExistsError'
  }
}

export function createTeam(request: CreateTeamRequest): EnsembleTeam {
  return withTeamsLock(() => {
    const teams = readTeamsFile()
    // Fix 2: compare-and-swap — reject if another active team exists on same cwd
    // unless caller explicitly opts in via allowConcurrent (e.g., worktree mode).
    if (request.workingDirectory && !request.allowConcurrent) {
      const existing = teams.find(t =>
        (t.status === 'forming' || t.status === 'active') &&
        t.workingDirectory === request.workingDirectory
      )
      if (existing) throw new ActiveTeamExistsError(existing)
    }
    const team: EnsembleTeam = {
      id: uuidv4(),
      name: request.name,
      description: request.description,
      status: 'forming',
      phase: 'forming',
      agents: request.agents.map((a, i) => ({
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
      workingDirectory: request.workingDirectory,
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
    // A2: guard phase transitions. Illegal transitions are logged and stripped.
    if (updates.phase && !canTransitionPhase(teams[idx].phase, updates.phase)) {
      console.warn(`[Registry] Illegal phase transition rejected: ${teams[idx].phase} → ${updates.phase} for team ${id}`)
      const { phase: _stripped, ...rest } = updates
      teams[idx] = { ...teams[idx], ...rest }
    } else {
      teams[idx] = { ...teams[idx], ...updates }
    }
    writeTeamsFile(teams)
    return teams[idx]
  })
}

// A2: explicit phase setter with legal-transition guard
export function setTeamPhase(id: string, phase: TeamPhase): EnsembleTeam | undefined {
  return updateTeam(id, { phase })
}

export function getActiveTeamsByWorkingDir(cwd: string): EnsembleTeam[] {
  return loadTeams().filter(t => t.status === 'active' && t.workingDirectory === cwd)
}

// Fix 7: lock timeout now THROWS. The previous implementation returned a
// no-op release after LOCK_TIMEOUT_MS, silently degrading to unlocked appends
// — the exact scenario where serialization matters most. Callers of
// appendMessage now receive a visible error instead of corrupted ordering.
function acquireMessageLock(file: string): () => void {
  const lockDir = `${file}.lock`
  const startedAt = Date.now()
  for (;;) {
    try {
      fs.mkdirSync(lockDir)
      return () => { try { fs.rmSync(lockDir, { recursive: true, force: true }) } catch { /* */ } }
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code !== 'EEXIST') throw error
      try {
        const stat = fs.statSync(lockDir)
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockDir, { recursive: true, force: true })
          continue
        }
      } catch { /* lock changed while checking; retry */ }
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out acquiring message lock at ${lockDir} after ${LOCK_TIMEOUT_MS}ms`)
      }
      sleepSync(50)
    }
  }
}

// Fix 1: single-writer to /tmp/ensemble/<id>/messages.jsonl (canonical),
// so team-say.sh and service writes land in the same file. Parses class tag
// on the way in (Fix 6) for downstream consumers.
export function appendMessage(teamId: string, message: EnsembleMessage): void {
  const file = collabMessagesFile(teamId)
  ensureDir(path.dirname(file))
  const release = acquireMessageLock(file)
  try {
    const ts = message.timestamp || new Date().toISOString()
    // Auto-tag message class if not already set (Fix 6)
    const classMatch = !message.messageClass
      ? message.content.match(/^\s*\[(PLAN|FINDING|BLOCKER|REVIEW|PROGRESS|DONE)\]/i)
      : null
    const msg: EnsembleMessage = {
      ...message,
      timestamp: ts,
      messageClass: message.messageClass
        ?? (classMatch ? (classMatch[1].toUpperCase() as EnsembleMessage['messageClass']) : 'UNTAGGED'),
    }
    fs.appendFileSync(file, JSON.stringify(msg) + '\n')
  } finally {
    release()
  }
}

// Fix 1: single-writer event log. Canonical source is /tmp/ensemble/<id>/messages.jsonl
// (written by team-say.sh AND by appendMessage). The previous dual-store merge
// between ENSEMBLE_DIR/messages and /tmp/ensemble silently dropped malformed
// lines and left ambiguity about which store was authoritative. Legacy
// ENSEMBLE_DIR/messages still read as a fallback for migrations, but new
// writes go exclusively to collabMessagesFile().
export function getMessages(teamId: string, since?: string): EnsembleMessage[] {
  const sources = [
    collabMessagesFile(teamId),                           // canonical
    path.join(MESSAGES_DIR, teamId, 'feed.jsonl'),        // legacy fallback
  ]

  const seenIds = new Set<string>()
  let messages: EnsembleMessage[] = []
  let malformedCount = 0

  for (const file of sources) {
    if (!fs.existsSync(file)) continue
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean)
    for (const line of lines) {
      let msg: EnsembleMessage
      try { msg = JSON.parse(line) as EnsembleMessage } catch {
        malformedCount++
        continue
      }
      const dedupeKey = msg.id || `${msg.from}:${msg.timestamp}:${msg.content?.slice(0, 50)}`
      if (!seenIds.has(dedupeKey)) {
        seenIds.add(dedupeKey)
        messages.push(msg)
      }
    }
  }

  if (malformedCount > 0) {
    console.warn(`[Registry] Dropped ${malformedCount} malformed JSONL line(s) while reading messages for ${teamId}`)
  }

  messages.sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : Infinity
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : Infinity
    return ta - tb
  })

  if (since) {
    messages = messages.filter(m => m.timestamp && m.timestamp >= since)
  }
  return messages
}
