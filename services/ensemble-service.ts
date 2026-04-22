/**
 * Ensemble Service — Standalone
 * No dependency on ai-maestro's agent-registry or agents-core-service.
 * Uses agent-spawner.ts for local/remote agent lifecycle.
 */

import { v4 as uuidv4 } from 'uuid'
import type { EnsembleTeam, EnsembleMessage, CreateTeamRequest, CollabTemplatesFile } from '../types/ensemble'
import {
  createTeam, getTeam, updateTeam, loadTeams, ActiveTeamExistsError,
  appendMessage, getMessages, getActiveTeamsByWorkingDir,
} from '../lib/ensemble-registry'
import {
  spawnLocalAgent, killLocalAgent,
  spawnRemoteAgent as spawnRemote, killRemoteAgent,
  postRemoteSessionCommand, postRemoteSessionCommandVerified, isRemoteSessionReady,
  getAgentTokenUsage,
} from '../lib/agent-spawner'
import { isSelf, getHostById, getSelfHostId } from '../lib/hosts-config'
import { getRuntime } from '../lib/agent-runtime'
import { resolveAgentProgram } from '../lib/agent-config'
import { AgentWatchdog } from '../lib/agent-watchdog'
import {
  collabPromptFile, collabDeliveryFile, collabSummaryFile,
  collabRuntimeDir, collabFinishedMarker, collabBridgePosted,
  collabBridgeResult, ensureCollabDirs,
} from '../lib/collab-paths'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawn, execSync } from 'child_process'
import { createWorktree, mergeWorktree, destroyWorktree, type WorktreeInfo } from '../lib/worktree-manager'
import { runStagedWorkflow } from '../lib/staged-workflow'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

interface ServiceResult<T> {
  data?: T
  error?: string
  status: number
}

const IDLE_CHECK_INTERVAL_MS = 15_000
const COMPLETION_SIGNAL_WINDOW_MS = 60_000
const SINGLE_SIGNAL_IDLE_THRESHOLD_MS = 120_000
const LOW_CONFIDENCE_IDLE_THRESHOLD_MS = 300_000

// Fix 10 + FM16: completion is now HIGH-confidence-only. Low-confidence
// prose heuristics ("done", "klaar", "not done") caused false positives
// and missed Slovenian-locale completions. Staged/freeform runs should
// rely on explicit enum markers.
const HIGH_CONFIDENCE_COMPLETION = [
  /\[DONE\]/i,
  /\[COMPLETE\]/i,
  /\[FINISHED\]/i,
  /\[VERIFY_DONE\]/i,
  /\[EXEC_DONE\]/i,
]

// Retained for auto-disband grace period but now requires a terminal-ish
// phrase, not a bare word. Slovenian added to match CEO locale.
const LOW_CONFIDENCE_COMPLETION = [
  /\bcollab\s+(?:closed|concluded|finished|end(?:ed)?)\b/i,
  /\b(?:all|work)\s+(?:done|complete)\b/i,
  /\bmy\s+side\s+is\s+complete\b/i,
  /\bno\s+further\s+edits\b/i,
  // Slovenian
  /\bzaključeno\s+z\s+moje\s+strani\b/i,
  /\bkončano\b/i,
  /\b(?:deliverable|naloga)\s+(?:je\s+)?(?:končana|dostavljena|pripravljena)\b/i,
  // Dutch
  /\bcollab\s+afgerond\b/i,
  /\btot de volgende\b/i,
]

interface CompletionSignal {
  agentName: string
  timestamp: number
  confidence: 'high' | 'low'
}
// Telegram notifications: set both env vars to enable, omit to disable
const TELEGRAM_BOT_TOKEN = process.env.ENSEMBLE_TELEGRAM_BOT_TOKEN || ''
const TELEGRAM_CHAT_ID = process.env.ENSEMBLE_TELEGRAM_CHAT_ID || ''

class EnsembleService {
  private readonly disbandingTeams = new Set<string>()
  private readonly idleCheckTimer: NodeJS.Timeout
  private readonly watchdog: AgentWatchdog

  constructor() {
    this.idleCheckTimer = setInterval(() => {
      void this.checkIdleTeams()
    }, IDLE_CHECK_INTERVAL_MS)
    this.idleCheckTimer.unref()
    this.watchdog = new AgentWatchdog({
      loadTeams,
      getMessages: (teamId: string) => getMessages(teamId),
      appendMessage,
      disbandTeam: async (teamId: string, _reason: string) => {
        if (this.disbandingTeams.has(teamId)) return
        this.disbandingTeams.add(teamId)
        try {
          await disbandTeam(teamId)
        } finally {
          this.disbandingTeams.delete(teamId)
        }
      },
      getRuntime,
      resolveAgentProgram,
      isSelf: (hostId?: string) => isSelf(hostId || ''),
      getHostById,
      postRemoteSessionCommand,
      collabDeliveryFile,
    })

    for (const signal of ['SIGINT', 'SIGTERM', 'beforeExit', 'exit'] as const) {
      process.once(signal, () => this.stop())
    }
  }

  async checkIdleTeams(): Promise<void> {
    const teams = loadTeams().filter(team => team.status === 'active')

    for (const team of teams) {
      if (this.disbandingTeams.has(team.id)) continue
      if (!this.shouldAutoDisband(team)) continue

      this.disbandingTeams.add(team.id)

      try {
        appendMessage(team.id, {
          id: uuidv4(),
          teamId: team.id,
          from: 'ensemble',
          to: 'team',
          content: 'Auto-disband triggered after 60s idle and completion-like agent messages',
          type: 'chat',
          timestamp: new Date().toISOString(),
        })

        await disbandTeam(team.id)
      } catch (err) {
        console.error(`[Ensemble] Auto-disband failed for ${team.id}:`, err)
      } finally {
        this.disbandingTeams.delete(team.id)
      }
    }
  }

  private shouldAutoDisband(team: EnsembleTeam): boolean {
    const messages = getMessages(team.id)
    const nonEnsembleMessages = messages.filter(message => message.from !== 'ensemble')
    const lastMessage = nonEnsembleMessages[nonEnsembleMessages.length - 1]
    if (!lastMessage) return false

    const lastTimestamp = lastMessage.timestamp
      ? new Date(lastMessage.timestamp).getTime()
      : NaN
    if (Number.isNaN(lastTimestamp)) return false

    const activeAgents = team.agents.filter(agent => agent.status === 'active')
    if (activeAgents.length === 0) return false

    const idleForMs = Date.now() - lastTimestamp
    const activeAgentNames = new Set(activeAgents.map(agent => agent.name))
    const completionSignals = messages
      .filter(message => activeAgentNames.has(message.from) && this.getCompletionConfidence(message.content) !== null)
      .map(message => ({
        agentName: message.from,
        timestamp: message.timestamp ? new Date(message.timestamp).getTime() : NaN,
        confidence: this.getCompletionConfidence(message.content)!,
      }))
      .filter((signal): signal is CompletionSignal => !Number.isNaN(signal.timestamp))
      .sort((a, b) => a.timestamp - b.timestamp)

    const highConfSignals = completionSignals.filter(s => s.confidence === 'high')
    if (this.hasTwoRecentCompletionSignals(highConfSignals)) return true
    if (highConfSignals.length >= 1 && idleForMs > SINGLE_SIGNAL_IDLE_THRESHOLD_MS) return true

    if (idleForMs <= LOW_CONFIDENCE_IDLE_THRESHOLD_MS) return false
    if (completionSignals.length >= 1) return true

    // D3: orchestrator-driven termination — if agents haven't produced file changes
    // in N minutes and all [DONE] tags seen, force-close. Even without [DONE],
    // 10 min of idle + no git diff changes = stagnated.
    const NO_CHANGE_TERMINATE_MS = 600_000 // 10 min
    if (idleForMs > NO_CHANGE_TERMINATE_MS && team.workingDirectory) {
      try {
        const diffOut = execSync(
          `cd "${team.workingDirectory}" && git diff --stat HEAD 2>/dev/null | wc -l`,
          { timeout: 5000, encoding: 'utf-8' }
        ).trim()
        const changedFiles = parseInt(diffOut) || 0
        // Compare to a stashed count if we ever get there
        // For now: 10 min idle + messages but no new file changes = terminate
        console.log(`[Ensemble] D3 check: team ${team.id} idle ${Math.round(idleForMs / 1000)}s, git diff files=${changedFiles}`)
      } catch { /* git not available or dir gone */ }
    }

    return false
  }

  private getCompletionConfidence(content: string): 'high' | 'low' | null {
    if (HIGH_CONFIDENCE_COMPLETION.some(p => p.test(content))) return 'high'
    if (LOW_CONFIDENCE_COMPLETION.some(p => p.test(content))) return 'low'
    return null
  }

  private hasTwoRecentCompletionSignals(signals: CompletionSignal[]): boolean {
    for (let i = 0; i < signals.length; i++) {
      for (let j = i + 1; j < signals.length; j++) {
        if (signals[j].timestamp - signals[i].timestamp > COMPLETION_SIGNAL_WINDOW_MS) break
        if (signals[i].agentName !== signals[j].agentName) return true
      }
    }
    return false
  }

  private stop(): void {
    clearInterval(this.idleCheckTimer)
    this.watchdog.stop()
  }
}

const ensembleService = new EnsembleService()

function formatDuration(durationMs: number): string {
  const durationMin = Math.max(0, Math.round(durationMs / 60000))
  return durationMin >= 60
    ? `${Math.floor(durationMin / 60)}h ${durationMin % 60}m`
    : `${durationMin}m`
}

/** Escape special chars for Telegram MarkdownV2 */
function escMd(s: string): string {
  return s.replace(/([_[\]()~`>#+\-=|{}.!*\\])/g, '\\$1')
}

function sendTelegramSummary(params: {
  task: string
  duration: string
  messageCount: number
  agentSummaries: { name: string; msgs: number; tokens: string }[]
}): void {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return

  const agents = params.agentSummaries
  const agentLine = agents.map(a => `${escMd(a.name)} \\(${a.msgs}, ${escMd(a.tokens)}\\)`).join(' \\+ ')

  const text = [
    `\u2728 *Collab klaar* \u2014 ${escMd(params.duration)}, ${params.messageCount} msgs`,
    escMd(params.task.slice(0, 100)),
    agentLine,
  ].join('\n')

  const curl = spawn(
    'curl',
    [
      '-sS',
      '-X', 'POST',
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      '-d', `chat_id=${TELEGRAM_CHAT_ID}`,
      '-d', `parse_mode=MarkdownV2`,
      '--data-urlencode', `text=${text}`,
    ],
    {
      detached: true,
      stdio: 'ignore',
    },
  )

  curl.on('error', err => {
    console.error('[Ensemble] Failed to start Telegram notification:', err)
  })
  curl.unref()
}

async function routeToHost(_program: string, preferredHostId?: string): Promise<string> {
  if (preferredHostId) {
    const host = getHostById(preferredHostId)
    if (host) return preferredHostId
    console.warn(`[Ensemble] Unknown host ${preferredHostId}, falling back to self`)
  }
  return getSelfHostId()
}

function loadExpertProfile(expertSlug: string): string | null {
  try {
    const indexPath = path.join(os.homedir(), '.openclaw', 'context-profiles', 'index.json')
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
    const resolved = typeof index[expertSlug] === 'string' ? index[expertSlug] : expertSlug
    const entry = index[resolved]
    if (!entry || !entry.file) return null
    const profilePath = path.join(path.dirname(indexPath), entry.file)
    const content = fs.readFileSync(profilePath, 'utf-8')
    return `---\n${content}\n---`
  } catch {
    return null
  }
}

// Stop words for tokenization
const STOP_WORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with','by',
  'from','is','are','was','were','be','been','being','have','has','had','do',
  'does','did','will','would','could','should','may','might','must','not','no',
  'this','that','these','those','it','its','what','when','where','who','how',
  'if','than','then','as','up','out','about','into','all','any','can','just',
  'also','so','we','our','your','they','their','each','some','such','only',
])

function tokenizeQuery(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w))
}

interface SearchEntry { slug: string; name: string; domain: string; keywords: string[] }
let _searchIndex: SearchEntry[] | null = null
let _searchIndexMtime = 0

function getSearchIndex(): SearchEntry[] {
  const p = path.join(os.homedir(), '.openclaw', 'context-profiles', 'search-index.json')
  try {
    const mtime = fs.statSync(p).mtimeMs
    if (_searchIndex && mtime === _searchIndexMtime) return _searchIndex
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'))
    if (!Array.isArray(parsed)) throw new Error('search-index.json is not an array')
    _searchIndex = parsed.filter((e): e is SearchEntry =>
      e && typeof e.slug === 'string' && Array.isArray(e.keywords))
    _searchIndexMtime = mtime
    return _searchIndex
  } catch {
    return _searchIndex ?? []
  }
}

function autoSelectExpert(taskDescription: string, roleName: string, roleFocus: string): string | null {
  const index = getSearchIndex()
  if (!index.length) return null

  const query = tokenizeQuery(`${taskDescription} ${roleName} ${roleFocus}`)
  if (!query.length) return null
  const querySet = new Set(query)

  let best: { slug: string; score: number } | null = null

  for (const expert of index) {
    const kwSet = new Set(expert.keywords)
    // Count exact hits + partial hits (query word starts with or is contained in keyword)
    let score = 0
    for (const qw of querySet) {
      if (kwSet.has(qw)) {
        score += 2  // exact match
      } else {
        for (const kw of kwSet) {
          if (kw.includes(qw) || qw.includes(kw)) { score += 1; break }
        }
      }
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { slug: expert.slug, score }
    }
  }

  // Require at least 3 keyword hits to avoid noise
  if (!best || best.score < 3) return null
  return best.slug
}

export function loadCollabTemplate(templateName?: string): CollabTemplatesFile['templates'][string] | undefined {
  if (!templateName) return undefined
  try {
    const templatesPath = path.join(__dirname, '..', 'collab-templates.json')
    const raw = fs.readFileSync(templatesPath, 'utf-8')
    const data: CollabTemplatesFile = JSON.parse(raw)
    const template = data.templates[templateName]
    if (!template) {
      console.warn(`[Ensemble] Unknown template "${templateName}", falling back to default roles`)
      return undefined
    }
    console.log(`[Ensemble] Loaded template "${templateName}" (${template.name})`)
    return template
  } catch (err) {
    console.warn(`[Ensemble] Failed to load templates:`, err)
    return undefined
  }
}

export function buildPromptPreview(params: {
  teamId: string
  teamName: string
  description: string
  agentName: string
  teammateNames: string[]
  agentIndex: number
  templateName?: string
}): string {
  const template = loadCollabTemplate(params.templateName)
  const scriptsDir = path.join(__dirname, '..', 'scripts')
  const teamSayCmd = `${scriptsDir}/team-say.sh ${params.teamId} ${params.agentName} ${params.teammateNames[0] || 'team'}`
  const teamReadCmd = `${scriptsDir}/team-read.sh ${params.teamId}`

  let roleInstructions: string[]

  if (template && params.agentIndex < template.roles.length) {
    const templateRole = template.roles[params.agentIndex]
    const expertSlug = templateRole.expert
      ?? autoSelectExpert(params.description, templateRole.role, templateRole.focus)
    const expertContext = expertSlug ? loadExpertProfile(expertSlug) : null
    if (expertSlug && expertContext) console.log(`[Ensemble] Expert injected for ${templateRole.role}: ${expertSlug}`)
    roleInstructions = [
      ...(expertContext ? [`EXPERT MENTAL MODEL:\n${expertContext}\nApply this expert's lens throughout your work.\n`] : []),
      `ROLE: ${templateRole.role}.`,
      templateRole.focus,
    ]
  } else {
    const isLead = params.agentIndex === 0
    const roleName = isLead ? 'LEAD' : 'WORKER'
    roleInstructions = isLead
      ? [
          `ROLE: ${roleName}.`,
          `You co-implement AND coordinate. Splitting work is fine, but you MUST ship code yourself — not just review.`,
          `First action: send a [PLAN] message with ownership split (file paths + who writes what). You MUST claim at least one specific file YOU will write.`,
          `When the worker ships their part, IMMEDIATELY start coding your claimed items — do not loop on "standing by" or "holding for review".`,
          `If no new information exists, stay silent and keep working. Do NOT send acknowledgement-only messages.`,
          `If the worker is parked, continue your own implementation locally. Do not instruct them to remain idle more than once.`,
          `DONE contract: your own claimed items are implemented, worker-delivered items are reviewed or accepted, and the deliverable file exists on disk.`,
          `NEVER leave items as PENDING while the collab ends. Implement them or explicitly hand them back to the worker BEFORE closing.`,
        ]
      : [
          `ROLE: ${roleName}.`,
          `You co-implement alongside the lead. After the lead sends [PLAN], claim or accept your items and ship code.`,
          `Execute pragmatically, report what you changed (files + line counts), surface blockers or test failures quickly.`,
          `If the lead delegates everything to you without claiming anything themselves, push back: ask them which items they own.`,
          `When your assigned work is complete, send ONE [DONE] packet, then stay silent unless the lead asks a new question.`,
          `Do NOT send "Idle.", "Acknowledged.", "Standing by.", "Zaključeno.", or equivalent filler. The watchdog force-closes acknowledgement loops.`,
        ]
  }

  // C1: prompt injection sanitize — strip class tags from user task description
  // so "[DONE]" in the task itself doesn't auto-complete the team on first check.
  const safeDescription = params.description.replace(/\[(PLAN|FINDING|BLOCKER|REVIEW|PROGRESS|DONE|COMPLETE|FINISHED)\]/gi, '(tag-redacted)')

  return [
    `You are ${params.agentName} in team "${params.teamName}" with teammate ${params.teammateNames.join(', ')}.`,
    `Task: ${safeDescription}`,
    ...roleInstructions,
    `COMMUNICATION RULES:`,
    `1. Send findings: ${teamSayCmd} "your message"`,
    `2. Read teammate messages: ${teamReadCmd}`,
    `3. Every message MUST start with a class tag: [PLAN], [FINDING], [BLOCKER], [REVIEW], [PROGRESS], or [DONE]. Do not send untagged messages.`,
    `   - [PLAN]: ownership split, file paths, next action`,
    `   - [FINDING]: new evidence with file/line or trace id`,
    `   - [BLOCKER]: hard stop that needs teammate or user input`,
    `   - [REVIEW]: comment on teammate output`,
    `   - [PROGRESS]: concrete work done since last message (files + diff stat)`,
    `   - [DONE]: final packet with absolute artifact path + verify command. Emit only once.`,
    `4. Send a message only when you have a materially new finding, decision, or artifact. Do NOT emit "Idle.", "Acknowledged.", "Standing by.", or equivalent filler.`,
    `5. After sending, check ${teamReadCmd} once, then resume work.`,
    `6. When your task is complete, emit exactly one [DONE] with artifacts: and verify:, then stop messaging. The watchdog force-closes acknowledgement loops.`,
    `Start NOW: send a [PLAN] (if lead) or brief [FINDING] intro (if worker), then begin.`,
  ].join(' ')
}

export async function createEnsembleTeam(
  request: CreateTeamRequest
): Promise<ServiceResult<{ team: EnsembleTeam; existing?: boolean }>> {
  // Fix 2: CAS — if useWorktrees is true, allow concurrent teams on same cwd.
  const requestWithCAS = { ...request, allowConcurrent: request.useWorktrees === true }
  let team: EnsembleTeam
  try {
    team = createTeam(requestWithCAS)
  } catch (err) {
    if (err instanceof ActiveTeamExistsError) {
      return {
        data: { team: err.existingTeam, existing: true },
        status: 409,
      }
    }
    throw err
  }
  const cwd = request.workingDirectory || process.cwd()
  const worktreeMap = new Map<string, WorktreeInfo>()

  // Auto-enable worktrees when another collab is active on the same working directory
  const concurrentTeams = getActiveTeamsByWorkingDir(cwd).filter(t => t.id !== team.id)
  const useWorktrees = request.useWorktrees || concurrentTeams.length > 0
  if (concurrentTeams.length > 0 && !request.useWorktrees) {
    appendMessage(team.id, {
      id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
      content: `⚠️ Concurrent collab detected (${concurrentTeams.length} active on same dir) — using git worktrees for isolation`,
      type: 'chat', timestamp: new Date().toISOString(),
    })
  }

  if (useWorktrees) {
    for (let i = 0; i < team.agents.length; i++) {
      const agentSpec = team.agents[i]
      const hostId = request.agents[i].hostId
        ? (getHostById(request.agents[i].hostId!) ? request.agents[i].hostId! : getSelfHostId())
        : getSelfHostId()

      // Only create worktrees for local agents
      if (isSelf(hostId)) {
        try {
          const worktreeInfo = await createWorktree(team.id, agentSpec.name, cwd)
          worktreeMap.set(agentSpec.name, worktreeInfo)
          team.agents[i].worktreePath = worktreeInfo.path
          team.agents[i].worktreeBranch = worktreeInfo.branch
          appendMessage(team.id, {
            id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
            content: `🌳 Worktree created for ${agentSpec.name}: ${worktreeInfo.branch}`,
            type: 'chat', timestamp: new Date().toISOString(),
          })
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          console.error(`[Ensemble] Failed to create worktree for ${agentSpec.name}:`, message)
          appendMessage(team.id, {
            id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
            content: `⚠️ Worktree creation failed for ${agentSpec.name}: ${message}. Using shared directory.`,
            type: 'chat', timestamp: new Date().toISOString(),
          })
        }
      }
    }
  }

  const buildPrompt = (agentName: string, otherNames: string[], agentIndex: number) => {
    return buildPromptPreview({
      teamId: team.id,
      teamName: team.name,
      description: team.description,
      agentName,
      teammateNames: otherNames,
      agentIndex,
      templateName: request.templateName,
    })
  }

  // Phase 1: Spawn all agents
  for (let i = 0; i < team.agents.length; i++) {
    const agentSpec = team.agents[i]
    const hostId = await routeToHost(agentSpec.program, request.agents[i].hostId)
    const agentName = `${team.name}-${agentSpec.name}`
    const prompt = buildPrompt(agentSpec.name, team.agents.filter((_, j) => j !== i).map(a => a.name), i)

    ensureCollabDirs(team.id)
    const promptFile = collabPromptFile(team.id, agentSpec.name)
    fs.writeFileSync(promptFile, prompt)
    console.log(`[Ensemble] Prompt for ${agentSpec.name}: ${prompt}`)

    try {
      let agentId: string
      console.log(`[Ensemble] Spawning ${agentName} (${agentSpec.program}) on ${hostId} (self=${isSelf(hostId)})`)

      if (isSelf(hostId)) {
        const agentCwd = worktreeMap.get(agentSpec.name)?.path || cwd
        const spawned = await spawnLocalAgent({
          name: agentName,
          program: agentSpec.program,
          workingDirectory: agentCwd,
          hostId,
        })
        agentId = spawned.id
      } else {
        const host = getHostById(hostId)
        if (!host) throw new Error(`Unknown host: ${hostId}`)
        const remote = await spawnRemote(host.url, agentName, agentSpec.program, cwd, team.description, team.name)
        agentId = remote.id
      }

      team.agents[i].agentId = agentId
      team.agents[i].hostId = hostId
      team.agents[i].status = 'active'

      appendMessage(team.id, {
        id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `${agentSpec.name} (${agentSpec.program} @ ${hostId}) has joined #${team.name}`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[Ensemble] Failed to spawn ${agentName}:`, message)
      team.agents[i].status = 'failed'
      appendMessage(team.id, {
        id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `Failed to spawn ${agentName}: ${message}`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
    }
  }

  const activeAgents = team.agents.filter(a => a.status === 'active')
  // Fix 3: persist explicit FSM phase alongside status.
  updateTeam(team.id, {
    ...team,
    status: activeAgents.length >= 2 ? 'active' : 'failed',
    phase: activeAgents.length >= 2 ? 'ready_wait' : 'failed',
  })

  // Phase 2: Wait for ALL agents to be ready, then inject prompts
  if (activeAgents.length >= 2) {
    const runtime = getRuntime()

    const waitForReady = async (
      sessionName: string, program: string, hostId?: string, maxWait = 480000,
    ): Promise<boolean> => {
      const start = Date.now()
      const agentConfig = resolveAgentProgram(program)
      const readyMarker = agentConfig.readyMarker
      while (Date.now() - start < maxWait) {
        try {
          if (hostId && !isSelf(hostId)) {
            const host = getHostById(hostId)
            if (host && await isRemoteSessionReady(host.url, sessionName)) {
              console.log(`[Ensemble] ${sessionName} is remotely reachable (${Math.round((Date.now() - start) / 1000)}s)`)
              return true
            }
          } else {
            const output = await runtime.capturePane(sessionName, 50)
            // Check last 15 lines — readyMarker may be above footer elements
            const lastLines = output.split('\n').slice(-15).join('\n')
            if (lastLines.includes(readyMarker)) {
              console.log(`[Ensemble] ${sessionName} is ready (${Math.round((Date.now() - start) / 1000)}s)`)
              return true
            }
          }
        } catch { /* not ready yet */ }
        await new Promise(r => setTimeout(r, 1000))
      }
      console.error(`[Ensemble] ${sessionName} did not become ready within ${maxWait / 1000}s`)
      return false
    }

    console.log(`[Ensemble] Waiting for all ${activeAgents.length} agents to be ready...`)
    const readyResults = await Promise.all(
      activeAgents.map(agent => {
        const sessionName = `${team.name}-${agent.name}`
        return waitForReady(sessionName, agent.program, agent.hostId).then(ready => ({ agent, sessionName, ready }))
      })
    )

    const ready = readyResults.filter(r => r.ready)
    const notReady = readyResults.filter(r => !r.ready)

    for (const nr of notReady) {
      appendMessage(team.id, {
        id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `❌ ${nr.agent.name} failed to start — timed out`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
    }

    if (ready.length < 2) {
      appendMessage(team.id, {
        id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `❌ Team start aborted: only ${ready.length}/${activeAgents.length} agents ready`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
      // Kill any spawned tmux sessions — both ready and notReady paths leave
      // live sessions behind (ready saw the marker, notReady may have panes
      // still warming up). Otherwise they outlive the team record.
      for (const r of [...ready, ...notReady]) {
        try {
          if (r.agent.hostId && !isSelf(r.agent.hostId)) {
            const host = getHostById(r.agent.hostId)
            if (host && r.agent.agentId) await killRemoteAgent(host.url, r.agent.agentId)
          } else {
            await killLocalAgent(r.sessionName)
          }
        } catch { /* best effort */ }
      }
      updateTeam(team.id, { status: 'failed' })
      return { data: { team: { ...team, status: 'failed' } }, status: 201 }
    }

    const postReadyDelay = Math.max(
      ...ready.map(({ agent }) => resolveAgentProgram(agent.program).postReadyDelayMs ?? 2000)
    )
    await new Promise(r => setTimeout(r, postReadyDelay))

    // Phase 3: Inject prompts (skip if staged — staged workflow handles its own prompts)
    if (request.staged) {
      // Staged mode: skip normal prompt injection, run plan→exec→verify workflow
      appendMessage(team.id, {
        id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `🚀 All ${ready.length} agents ready — starting staged workflow (plan → exec → verify)`,
        type: 'chat', timestamp: new Date().toISOString(),
      })

      const buildStagedPlanPrompt = (agentName: string, otherNames: string[], agentIndex: number): string => [
        buildPrompt(agentName, otherNames, agentIndex),
        `STAGED WORKFLOW MODE.`,
        `PHASE 1 PLAN: ONLY create and share a plan via team-say.`,
        `Do NOT write code, edit files, or run mutating commands yet.`,
        `Both agents must share their plan before implementation begins.`,
        `After sharing your plan, run team-read and align on the execution approach.`,
        `Include [PLAN_READY] in your team-say message when your plan is finalized.`,
      ].join(' ')

      const buildStagedExecPrompt = (otherNames: string[]): string => [
        `PHASE 2 EXEC: Planning is complete.`,
        `You may now execute the agreed plan and make code changes.`,
        `Share concrete progress via team-say. Include [EXEC_DONE] in your message when your implementation is done.`,
        `Keep coordinating with ${otherNames.join(', ')} as you work.`,
      ].join(' ')

      const buildStagedVerifyPrompt = (teammateToReview?: string): string => [
        `PHASE 3 VERIFY: Review ${teammateToReview || 'your teammate'}'s work.`,
        `Inspect what they changed, compare it against the plan, and report findings via team-say.`,
        `Focus on bugs, regressions, missing tests, and mismatches with the agreed approach.`,
        `Include [VERIFY_DONE] in your message when review is complete.`,
      ].join(' ')

      // Run in background so createEnsembleTeam returns immediately
      runStagedWorkflow(team, request.stagedConfig, {
        buildPlanPrompt: ({ agent, teammates, index }) => buildStagedPlanPrompt(agent.name, teammates, index),
        buildExecPrompt: ({ teammates }) => buildStagedExecPrompt(teammates),
        buildVerifyPrompt: ({ teammateToReview }) => buildStagedVerifyPrompt(teammateToReview),
      }).catch(err => {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[Ensemble] Staged workflow failed for ${team.id}:`, message)
        appendMessage(team.id, {
          id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
          content: `❌ Staged workflow failed: ${message}`,
          type: 'chat', timestamp: new Date().toISOString(),
        })
        updateTeam(team.id, { status: 'failed', phase: 'failed' })
      })
    } else {
      // Normal mode: inject prompts simultaneously
      updateTeam(team.id, { phase: 'executing' })
      console.log(`[Ensemble] All ${ready.length} agents ready — injecting prompts simultaneously`)
      // A1/A4/A5: track delivery outcomes, log audit events, rollback on any failure
      type DeliveryResult = { agent: string; session: string; verified: boolean; error?: string }
      const deliveryResults: DeliveryResult[] = await Promise.all(
        ready.map(async ({ agent, sessionName }): Promise<DeliveryResult> => {
          const promptFile = collabPromptFile(team.id, agent.name)
          try {
            let verified = true
            if (agent.hostId && !isSelf(agent.hostId)) {
              const host = getHostById(agent.hostId)
              if (host) {
                const prompt = fs.readFileSync(promptFile, 'utf-8')
                // C3: remote delivery with verification — extract long tokens as signatures
                const longTokens = [...prompt.matchAll(/[A-Za-z0-9_-]{9,}/g)]
                  .map(m => m[0])
                  .filter(t => !/^(Progress|Standing|Received|Instructions|Implementation)$/i.test(t))
                  .slice(0, 2)
                verified = await postRemoteSessionCommandVerified(host.url, sessionName, prompt, longTokens)
              }
            } else {
              const agentCfg = resolveAgentProgram(agent.program)
              if (agentCfg.inputMethod === 'pasteFromFile') {
                verified = await runtime.pasteFromFile(sessionName, promptFile)
              } else {
                const prompt = fs.readFileSync(promptFile, 'utf-8')
                await runtime.sendKeys(sessionName, prompt, { literal: true, enter: true })
              }
            }
            // A5: audit event in messages.jsonl, not just console
            appendMessage(team.id, {
              id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
              content: verified
                ? `📨 Delivery verified for ${agent.name}`
                : `⚠️ Delivery unverified for ${agent.name} (paste signatures not detected in pane)`,
              type: 'chat', timestamp: new Date().toISOString(),
            })
            if (verified) console.log(`[Ensemble] ✓ Prompt injected into ${sessionName}`)
            else console.warn(`[Ensemble] ⚠️ Prompt delivery UNVERIFIED for ${sessionName}`)
            return { agent: agent.name, session: sessionName, verified }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            appendMessage(team.id, {
              id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
              content: `❌ Delivery to ${agent.name} failed: ${message}`,
              type: 'chat', timestamp: new Date().toISOString(),
            })
            console.error(`[Ensemble] ✗ Failed to inject prompt into ${sessionName}:`, err)
            return { agent: agent.name, session: sessionName, verified: false, error: message }
          }
        })
      )

      // A4 revised: only abort on HARD errors (exceptions during delivery), not
      // on unverified paste. Codex reformats/wraps pasted text so verification
      // signatures break across lines — an unverified paste is often successful.
      // Hard errors = transport failures, tmux session not found, etc.
      const hardFailures = deliveryResults.filter(r => r.error)
      const unverified = deliveryResults.filter(r => !r.verified && !r.error)
      if (unverified.length > 0) {
        appendMessage(team.id, {
          id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
          content: `⚠️ Paste unverified for ${unverified.map(f => f.agent).join(', ')} — prompt may have landed but signature not detected in pane (line-wrap?). Proceeding.`,
          type: 'chat', timestamp: new Date().toISOString(),
        })
      }
      if (hardFailures.length > 0) {
        appendMessage(team.id, {
          id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
          content: `🛑 Aborting collab: ${hardFailures.length}/${deliveryResults.length} deliveries had hard errors (${hardFailures.map(f => f.agent + ': ' + f.error).join('; ')})`,
          type: 'chat', timestamp: new Date().toISOString(),
        })
        updateTeam(team.id, { status: 'failed', phase: 'failed' })
        // Best-effort tmux cleanup
        for (const f of deliveryResults) {
          try { await runtime.killSession(f.session) } catch { /* best effort */ }
        }
      } else {
        appendMessage(team.id, {
          id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
          content: `🚀 All ${ready.length} agents received their task — collaboration started`,
          type: 'chat', timestamp: new Date().toISOString(),
        })
      }
    }
  }

  return { data: { team }, status: 201 }
}

export function getEnsembleTeam(teamId: string): ServiceResult<{ team: EnsembleTeam; messages: EnsembleMessage[] }> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }
  return { data: { team, messages: getMessages(teamId) }, status: 200 }
}

export function listEnsembleTeams(): ServiceResult<{ teams: EnsembleTeam[] }> {
  return { data: { teams: loadTeams() }, status: 200 }
}

// B3: team health snapshot (phase, session liveness, delivery status, idle age)
export function getTeamHealth(teamId: string): ServiceResult<Record<string, unknown>> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }
  const messages = getMessages(teamId)
  const agentMessages = messages.filter(m => m.from !== 'ensemble' && m.from !== 'user')
  const lastMsg = agentMessages[agentMessages.length - 1]
  const lastMsgAgeMs = lastMsg
    ? Date.now() - new Date(lastMsg.timestamp).getTime()
    : null
  const deliveryEvents = messages.filter(m => /^(📨 Delivery|⚠️ Delivery|❌ Delivery)/.test(m.content))

  // Check tmux session liveness for local agents
  const sessions = team.agents.map(a => {
    const sessionName = `${team.name}-${a.name}`
    let alive = false
    try {
      execSync(`tmux has-session -t "${sessionName}" 2>/dev/null`)
      alive = true
    } catch { alive = false }
    return { agent: a.name, session: sessionName, alive, status: a.status }
  })

  return {
    data: {
      teamId: team.id,
      status: team.status,
      phase: team.phase ?? null,
      createdAt: team.createdAt,
      messageCount: messages.length,
      agentMessageCount: agentMessages.length,
      lastMessageAgeMs: lastMsgAgeMs,
      lastMessageFrom: lastMsg?.from ?? null,
      lastMessageClass: lastMsg?.messageClass ?? null,
      deliveryEvents: deliveryEvents.length,
      sessions,
      allSessionsAlive: sessions.every(s => s.alive || s.status === 'done' || s.status === 'failed'),
    },
    status: 200,
  }
}

// C2: aggregate metrics across all known teams
export function getEnsembleMetrics(): ServiceResult<Record<string, unknown>> {
  const teams = loadTeams()
  const byStatus: Record<string, number> = {}
  const byPhase: Record<string, number> = {}
  let totalDurationMs = 0
  let completedCount = 0
  for (const t of teams) {
    byStatus[t.status] = (byStatus[t.status] ?? 0) + 1
    if (t.phase) byPhase[t.phase] = (byPhase[t.phase] ?? 0) + 1
    if (t.completedAt && t.createdAt) {
      totalDurationMs += new Date(t.completedAt).getTime() - new Date(t.createdAt).getTime()
      completedCount++
    }
  }
  const avgDurationMs = completedCount > 0 ? Math.round(totalDurationMs / completedCount) : null
  return {
    data: {
      teams_total: teams.length,
      teams_by_status: byStatus,
      teams_by_phase: byPhase,
      teams_completed: byStatus.disbanded ?? 0,
      teams_failed: byStatus.failed ?? 0,
      avg_duration_ms: avgDurationMs,
      avg_duration_s: avgDurationMs ? Math.round(avgDurationMs / 1000) : null,
    },
    status: 200,
  }
}

export async function checkIdleTeams(): Promise<void> {
  await ensembleService.checkIdleTeams()
}

export function getTeamFeed(teamId: string, since?: string): ServiceResult<{ messages: EnsembleMessage[] }> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }
  return { data: { messages: getMessages(teamId, since) }, status: 200 }
}

// C4: per-agent rate limit — sliding 60s window, max 30 messages.
// Protects against pathological agent spam thrashing the message lock.
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_MSGS = 30
const _rateLimitWindows = new Map<string, number[]>()

function checkRateLimit(teamId: string, from: string): { ok: boolean; count: number } {
  const key = `${teamId}:${from}`
  const now = Date.now()
  const cutoff = now - RATE_LIMIT_WINDOW_MS
  const arr = (_rateLimitWindows.get(key) ?? []).filter(ts => ts > cutoff)
  arr.push(now)
  _rateLimitWindows.set(key, arr)
  return { ok: arr.length <= RATE_LIMIT_MAX_MSGS, count: arr.length }
}

export async function sendTeamMessage(
  teamId: string, to: string, content: string, from?: string,
  existingId?: string, existingTimestamp?: string,
): Promise<ServiceResult<{ message: EnsembleMessage }>> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }

  // C4: rate-limit non-ensemble senders
  const sender = from || 'user'
  if (sender !== 'ensemble' && sender !== 'user') {
    const rl = checkRateLimit(teamId, sender)
    if (!rl.ok) {
      // Record a single warning event per breach cycle; drop the offending message.
      const lastWarn = (_rateLimitWindows.get(`${teamId}:${sender}:warned`) ?? [])[0] ?? 0
      if (Date.now() - lastWarn > RATE_LIMIT_WINDOW_MS) {
        _rateLimitWindows.set(`${teamId}:${sender}:warned`, [Date.now()])
        appendMessage(teamId, {
          id: uuidv4(), teamId, from: 'ensemble', to: 'team',
          content: `⚠️ Rate limit hit: ${sender} exceeded ${RATE_LIMIT_MAX_MSGS} messages in ${RATE_LIMIT_WINDOW_MS / 1000}s (current: ${rl.count}). Dropping excess.`,
          type: 'chat', timestamp: new Date().toISOString(),
        })
      }
      return { error: `Rate limit: ${sender} exceeded ${RATE_LIMIT_MAX_MSGS} msgs/min`, status: 429 }
    }
  }

  const message: EnsembleMessage = {
    id: existingId || uuidv4(), teamId, from: sender, to, content,
    type: 'chat', timestamp: existingTimestamp || new Date().toISOString(),
  }
  appendMessage(teamId, message)

  // Determine which agents should receive this message in their tmux pane
  const recipients = to === 'team'
    ? team.agents.filter(a => a.status === 'active' && a.name !== sender)
    : team.agents.filter(a => a.status === 'active' && a.name === to)

  const runtime = getRuntime()

  for (const targetAgent of recipients) {
    try {
      const sessionName = `${team.name}-${targetAgent.name}`

      const deliveryText = [
        `[Team message from ${sender}]: ${content}`,
        `→ Respond with team-say. Then run team-read to check for more messages.`,
      ].join('\n')

      if (targetAgent.hostId && !isSelf(targetAgent.hostId)) {
        const host = getHostById(targetAgent.hostId)
        if (host) await postRemoteSessionCommand(host.url, sessionName, deliveryText)
      } else {
        const paneAlive = await runtime.sessionExists(sessionName)
        if (!paneAlive) continue
        const tmpFile = collabDeliveryFile(teamId, sessionName)
        fs.mkdirSync(path.dirname(tmpFile), { recursive: true })
        fs.writeFileSync(tmpFile, deliveryText)
        await runtime.cancelCopyMode(sessionName)
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await runtime.pasteFromFile(sessionName, tmpFile)
            try { fs.unlinkSync(tmpFile) } catch { /* */ }
            break
          } catch (e) {
            if (attempt === 0) {
              console.warn(`[Ensemble] Delivery attempt 1 failed for ${sessionName}, retrying in 2s`)
              await new Promise(r => setTimeout(r, 2000))
              await runtime.cancelCopyMode(sessionName)
            } else {
              try { fs.unlinkSync(tmpFile) } catch { /* */ }
              throw e
            }
          }
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      appendMessage(teamId, {
        id: uuidv4(), teamId, from: 'ensemble', to: 'team',
        content: `❌ Delivery to ${targetAgent.name} failed: ${reason}`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
    }
  }

  return { data: { message }, status: 200 }
}

/**
 * Write a summary file for a disbanded team — used by auto-disband and can be
 * picked up by the background watcher in the Claude Code session.
 * Mirrors the format from cli/monitor.ts disbandTeam().
 */
export async function writeDisbandSummary(teamId: string): Promise<void> {
  const team = getTeam(teamId)
  if (!team) return

  const messages = getMessages(teamId)
  const agentMsgs = messages.filter(m => m.from !== 'ensemble' && m.from !== 'user')
  if (agentMsgs.length === 0) return

  const now = new Date()
  const createdAt = new Date(team.createdAt)
  const durationMs = now.getTime() - createdAt.getTime()
  const duration = formatDuration(durationMs)

  const agents = [...new Set(agentMsgs.map(m => m.from))]

  // Scrape token usage from each agent's tmux pane (best-effort)
  const tokenUsageMap: Record<string, string> = {}
  await Promise.all(
    team.agents
      .filter(a => a.status === 'active')
      .map(async (agent) => {
        const sessionName = `${team.name}-${agent.name}`
        tokenUsageMap[agent.name] = await getAgentTokenUsage(sessionName)
      })
  )

  const summaryText = agents.map(agent => {
    const msgs = agentMsgs.filter(m => m.from === agent)
    const first = msgs[0]?.content.replace(/\/tmp\/ensemble[-\w]*/g, '').trim() || ''
    const last = msgs[msgs.length - 1]?.content.replace(/\/tmp\/ensemble[-\w]*/g, '').trim() || ''
    const tokens = tokenUsageMap[agent] || 'unknown'
    return `${agent} (${msgs.length} msgs, tokens: ${tokens}):\n  Start: ${first.slice(0, 300)}\n  Eind: ${last.slice(0, 500)}`
  }).join('\n\n')

  const summaryFile = collabSummaryFile(teamId)
  fs.mkdirSync(path.dirname(summaryFile), { recursive: true })
  fs.writeFileSync(
    summaryFile,
    `Task: ${team.description || 'unknown'}\nDuration: ${duration}\nMessages: ${agentMsgs.length}\n\n${summaryText}`,
  )
  console.log(`[Ensemble] Summary written to ${summaryFile}`)
}

export async function disbandTeam(teamId: string): Promise<ServiceResult<{ team: EnsembleTeam }>> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }

  // Mark phase transition before cleanup so external observers see
  // executing → disbanding → disbanded, not a sudden status flip with stale
  // phase. `disbanding` is reachable from executing/reviewing/done_pending.
  if (team.phase && team.phase !== 'disbanded' && team.phase !== 'disbanding') {
    updateTeam(teamId, { phase: 'disbanding' })
  }

  // Write summary before killing sessions so the Claude Code session can present it
  await writeDisbandSummary(teamId)

  // Scrape token usage BEFORE killing sessions (tmux panes disappear on kill)
  const tokenUsageMap: Record<string, string> = {}
  await Promise.all(
    team.agents
      .filter(a => a.status === 'active')
      .map(async (agent) => {
        const sessionName = `${team.name}-${agent.name}`
        tokenUsageMap[agent.name] = await getAgentTokenUsage(sessionName)
      })
  )

  for (const agent of team.agents) {
    if (agent.status === 'active') {
      appendMessage(teamId, {
        id: uuidv4(), teamId, from: 'ensemble', to: 'team',
        content: `${agent.name} has left #${team.name}`,
        type: 'chat', timestamp: new Date().toISOString(),
      })

      try {
        if (agent.hostId && !isSelf(agent.hostId)) {
          const host = getHostById(agent.hostId)
          if (host && agent.agentId) await killRemoteAgent(host.url, agent.agentId)
        } else {
          await killLocalAgent(`${team.name}-${agent.name}`)
        }
      } catch { /* session may already be gone */ }
    }
  }

  const agentsWithWorktrees = team.agents.filter(
    a => a.worktreePath && a.worktreeBranch && (!a.hostId || isSelf(a.hostId))
  )
  if (agentsWithWorktrees.length > 0) {
    await new Promise(resolve => setTimeout(resolve, 2000))

    const firstWorktree = agentsWithWorktrees[0].worktreePath!
    const worktreesDir = path.dirname(firstWorktree)
    const basePath = path.dirname(worktreesDir)

    const conflictedAgents = new Set<string>()
    for (const agent of agentsWithWorktrees) {
      const worktreeInfo: WorktreeInfo = {
        path: agent.worktreePath!,
        branch: agent.worktreeBranch!,
        agentName: agent.name,
      }
      const result = await mergeWorktree(worktreeInfo, basePath)

      if (!result.success) conflictedAgents.add(agent.name)
      appendMessage(teamId, {
        id: uuidv4(), teamId, from: 'ensemble', to: 'team',
        content: result.success
          ? `🌳 Merged ${agent.name}'s worktree (${agent.worktreeBranch})`
          : `⚠️ Merge conflict for ${agent.name}: ${result.conflicts?.join(', ')}. Branch ${agent.worktreeBranch} preserved.`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
    }

    for (const agent of agentsWithWorktrees) {
      if (conflictedAgents.has(agent.name)) {
        console.warn(`[Ensemble] Skipping worktree destroy for ${agent.name} — merge had conflicts, branch preserved`)
        continue
      }
      const worktreeInfo: WorktreeInfo = {
        path: agent.worktreePath!,
        branch: agent.worktreeBranch!,
        agentName: agent.name,
      }
      await destroyWorktree(worktreeInfo, basePath)
    }
  }

  const updated = updateTeam(teamId, {
    status: 'disbanded',
    phase: 'disbanded',
    completedAt: new Date().toISOString(),
  })

  // Soft cleanup: remove ephemeral files, keep messages/summary/log, write .finished marker
  try {
    const deliveryDir = path.join(collabRuntimeDir(teamId), 'delivery')
    if (fs.existsSync(deliveryDir)) fs.rmSync(deliveryDir, { recursive: true, force: true })
    for (const f of [collabBridgeResult(teamId), collabBridgePosted(teamId)]) {
      if (fs.existsSync(f)) fs.unlinkSync(f)
    }
    fs.writeFileSync(collabFinishedMarker(teamId), new Date().toISOString())
  } catch { /* non-fatal cleanup */ }

  // Optional: save session summary to claude-mem
  try {
    const messages = getMessages(teamId)
    const agentMessages = messages.filter(m => m.from !== 'ensemble' && m.from !== 'user')
    if (agentMessages.length > 0) {
      const durationMs = updated!.completedAt && team.createdAt
        ? new Date(updated!.completedAt).getTime() - new Date(team.createdAt).getTime()
        : 0
      const duration = formatDuration(durationMs)

      // Build a concise summary with token usage
      const agents = [...new Set(agentMessages.map(m => m.from))]
      const summaryParts = agents.map(agent => {
        const msgs = agentMessages.filter(m => m.from === agent)
        const first = msgs[0]?.content.slice(0, 300) || ''
        const last = msgs[msgs.length - 1]?.content.slice(0, 500) || ''
        const tokens = tokenUsageMap[agent] || 'unknown'
        return `${agent} (${msgs.length} msgs, tokens: ${tokens}):\n  Start: ${first}\n  Eind: ${last}`
      })

      sendTelegramSummary({
        task: team.description || 'unknown',
        duration,
        messageCount: agentMessages.length,
        agentSummaries: agents.map(agent => ({
          name: agent,
          msgs: agentMessages.filter(m => m.from === agent).length,
          tokens: tokenUsageMap[agent] || '?',
        })),
      })

      // Detect the working directory as project hint
      const cwdMatch = team.description.match(/workingDirectory[:\s]*([^\s,}]+)/)
      const project = process.env.ENSEMBLE_PROJECT
        || (cwdMatch ? cwdMatch[1].split('/').pop() : undefined)
        || 'ensemble'

      fetch('http://localhost:37777/api/observations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `Collab: ${team.description.slice(0, 80)}`,
          subtitle: `${agents.join(' + ')} — ${duration}, ${agentMessages.length} messages`,
          type: 'discovery',
          narrative: `Team "${team.name}" (${duration}):\nTask: ${team.description.slice(0, 200)}\n\n${summaryParts.join('\n\n')}`,
          project,
        }),
      }).catch(() => {})
    }
  } catch { /* non-fatal */ }

  return { data: { team: updated! }, status: 200 }
}
