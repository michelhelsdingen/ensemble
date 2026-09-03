/**
 * Ensemble Service — Standalone
 * No dependency on ai-maestro's agent-registry or agents-core-service.
 * Uses agent-spawner.ts for local/remote agent lifecycle.
 */

import { v4 as uuidv4 } from 'uuid'
import type { EnsembleTeam, EnsembleMessage, CreateTeamRequest, CollabTemplatesFile } from '../types/ensemble'
import {
  createTeam, getTeam, updateTeam, loadTeams,
  appendMessage, getMessages,
} from '../lib/ensemble-registry'
import {
  spawnLocalAgent, killLocalAgent,
  spawnRemoteAgent as spawnRemote, killRemoteAgent,
  postRemoteSessionCommand, isRemoteSessionReady,
  getAgentTokenUsage,
} from '../lib/agent-spawner'
import { isSelf, getHostById, getSelfHostId } from '../lib/hosts-config'
import { getRuntime } from '../lib/agent-runtime'
import { resolveAgentProgram, resolveAgentProgramDetailed, availableAgentKeys } from '../lib/agent-config'
import { exportObservation, checkMemoryEndpoint } from '../lib/memory-export'
import { AgentWatchdog } from '../lib/agent-watchdog'
import {
  collabPromptFile, collabDeliveryFile, collabSummaryFile, collabMessagesFile,
  collabRuntimeDir, collabFinishedMarker, collabBridgePosted, collabPollerPid,
  collabBridgeResult, ensureCollabDirs,
} from '../lib/collab-paths'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { createWorktree, mergeWorktree, destroyWorktree, type WorktreeInfo } from '../lib/worktree-manager'
import { runStagedWorkflow } from '../lib/staged-workflow'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

interface ServiceResult<T> {
  data?: T
  error?: string
  status: number
}

const IDLE_CHECK_INTERVAL_MS = 15_000
const COMPLETION_SIGNAL_WINDOW_MS = 180_000
// How long a team must be silent before completion WORDING may end it.
//
// These were 120s and 60s, and that killed a four-agent research team after
// 4,5 minutes on 2026-08-15. Two agents had written "eerste lezing klaar; nu
// tests" and "systematische vergelijking klaar" about sub-steps, after which
// everyone went quiet to actually read code. Sixty seconds of silence is not an
// idle team, it is an agent reading a file. Research runs routinely go minutes
// without posting, so the wording path needs a margin that only a genuinely
// finished team reaches. The exact sentinel remains the fast path and is
// unaffected: a team that is really done still ends within seconds.
const SINGLE_SIGNAL_IDLE_THRESHOLD_MS = 480_000
const TWO_SIGNAL_IDLE_THRESHOLD_MS = 300_000
const MIN_MESSAGES_BEFORE_AUTO_DISBAND = 10
// Explicit sentinel: when every active agent sends this exact marker as a full
// message, the team auto-disbands immediately — no idle wait, no minimum
// message count. Agents are instructed to use it in buildPromptPreview.
const EXPLICIT_DONE_SENTINEL = '<<COLLAB_DONE>>'
const COMPLETION_PATTERNS = [
  /(?:^|[^\p{L}\p{N}_])afgerond(?:[^\p{L}\p{N}_]|$)/iu,
  /(?:^|[^\p{L}\p{N}_])\bdone\b(?![.\w])/iu,
  // "completed" but not ".completed" (method/property access) or "completion"
  /(?<!\.)(?:^|[^\p{L}\p{N}_])completed(?:[^\p{L}\p{N}_]|$)/iu,
  // "klaar" but not "klaar sta", "klaar ben", "klaar om", "klaar voor"
  /(?:^|[^\p{L}\p{N}_])klaar(?!\s+(?:sta|ben|om|voor|zodra))(?:[^\p{L}\p{N}_]|$)/iu,
  /(?:^|\s)tot de volgende(?:\s|$)/i,
]

// Phrases that mean "this part is done, I am carrying on". A message carrying one
// of these is a progress report, not a closing statement, however much finished
// wording it contains.
const CONTINUATION_PATTERNS = [
  /\bnu\s+(?:ga|pak|lees|start|check|onderzoek|kijk|volgt|de\b)/i,
  /\b(?:ik|we)\s+(?:ga|gaan)\s+(?:nu\s+)?(?:verder|door|kijken|lezen|onderzoeken)/i,
  /\bvervolgens\b|\bdaarna\b|\bhierna\b/i,
  /\beerste\s+(?:lezing|ronde|indruk|scan|bevinding)/i,
  /\bdeel(?:taak|resultaat|bevinding)\b|\btussenstand\b|\bprogress\b/i,
  /\bwacht\s+(?:op|nog)\b|\bmeer\s+volgt\b|\bkom\s+ik\s+op\s+terug\b/i,
  // Explicitly claiming a slice of the work is the opposite of finishing it
  /\bik\s+pak\b|\bik\s+claim\b|\bmijn\s+(?:hoek|kavel|deel)\b/i,
  // "<werkproduct> klaar" reports a deliverable, "ik ben klaar" reports a person.
  // Only the second one ends a session. This is the distinction that "systematische
  // vergelijking klaar" fell foul of: a finished comparison is not a finished agent.
  /\b(?:vergelijking|analyse|lezing|ronde|scan|check|onderzoek|inventarisatie|review|bevindingen|tabel|overzicht)\s+(?:is\s+)?(?:klaar|done|afgerond)\b/i,
]

// Unmistakable closing statements. These outrank the continuation filter: an
// agent that says it has nothing left to add is finished, even if the same
// sentence mentions a deliverable that is "afgerond".
const CLOSING_PATTERNS = [
  /\bniets?\s+(?:meer\s+)?(?:toe\s+te\s+voegen|te\s+melden|op(?:en)?staand)/i,
  /\bgeen\s+(?:openstaande|resterende)\s+punten\b/i,
  /\b(?:ik\s+ben|we\s+zijn)\s+klaar\b/i,
  /\bik\s+sluit\s+(?:af|hierbij)\b|\bakkoord\s+met\s+(?:sluiten|closure)\b/i,
]

// Interactive gates that block agent startup and need an automated response.
// Debounced: same gate is not re-sent within 3 seconds to avoid key-repeat storms.
const AUTO_CONFIRM_GATES = [
  {
    name: 'trust prompt',
    pattern: /Do you trust the contents of this directory\?|Quick safety check:|Yes, I trust this folder/i,
    action: 'enter' as const,
  },
  {
    name: 'bypass permissions warning',
    pattern: /WARNING: Claude Code running in Bypass Permissions mode/i,
    action: 'accept-bypass' as const,
  },
]

interface CompletionSignal {
  agentName: string
  timestamp: number
}

/**
 * Does this message mean the agent is done, or only that a step is done?
 *
 * Order matters. An explicit closing statement wins outright. Otherwise a
 * message that reports progress or a delivered work product is not an ending,
 * however much finishing vocabulary it contains. Only what is left counts.
 */
function isCompletionStatement(content: string): boolean {
  if (CLOSING_PATTERNS.some(pattern => pattern.test(content))) return true
  if (!COMPLETION_PATTERNS.some(pattern => pattern.test(content))) return false
  return !CONTINUATION_PATTERNS.some(pattern => pattern.test(content))
}
// Telegram notifications: set both env vars to enable, omit to disable
const TELEGRAM_BOT_TOKEN = process.env.ENSEMBLE_TELEGRAM_BOT_TOKEN || ''
const TELEGRAM_CHAT_ID = process.env.ENSEMBLE_TELEGRAM_CHAT_ID || ''

// Optional: helsdingen-alerts hub (2026-04-21: ensemble collab summaries
// gaan hier doorheen voor centrale dedup + D1-logging). Fallback op de
// oude directe Telegram curl als ALERT_HUB_SECRET niet gezet is.
const ALERT_HUB_URL = process.env.ALERT_HUB_URL || 'https://alerts.camviewer.app/ingest/alert'
const ALERT_HUB_SECRET = process.env.ALERT_HUB_SECRET || ''

class EnsembleService {
  private readonly disbandingTeams = new Set<string>()
  private readonly idleCheckTimer: NodeJS.Timeout
  private readonly watchdog: AgentWatchdog

  constructor() {
    this.cleanupStaleTeams()
    this.idleCheckTimer = setInterval(() => {
      void this.checkIdleTeams()
    }, IDLE_CHECK_INTERVAL_MS)
    this.idleCheckTimer.unref()
    this.watchdog = new AgentWatchdog({
      loadTeams,
      getMessages: (teamId: string) => getMessages(teamId),
      appendMessage,
      getRuntime,
      resolveAgentProgram,
      isSelf: (hostId?: string) => isSelf(hostId || ''),
      getHostById,
      postRemoteSessionCommand,
      collabDeliveryFile,
      onTeamUnreachable: (teamId, reason) => this.endUnreachableTeam(teamId, reason),
    })

    // Say at startup whether collab outcomes can reach claude-mem. Without this
    // a wrong port stays invisible: every export fails and nothing reports it,
    // which is how 29 teams in a row wrote nothing without anyone noticing.
    void checkMemoryEndpoint().then(result => {
      if (result.ok) {
        console.log(`[Ensemble] Memory export ready at ${result.endpoint}`)
      } else {
        console.warn(
          `[Ensemble] Memory export UNAVAILABLE at ${result.endpoint}`
          + ` (${result.error || `HTTP ${result.status}`}).`
          + ` Collab outcomes will not be stored. Override with ENSEMBLE_MEMORY_URL.`,
        )
      }
    })

    for (const signal of ['SIGINT', 'SIGTERM', 'beforeExit', 'exit'] as const) {
      process.once(signal, () => this.stop())
    }
  }

  /**
   * A team whose agents are all gone can never finish on its own. End it the
   * normal way so it still produces a summary, rather than leaving it 'active'
   * with a watchdog and a bridge working on a session that no longer exists.
   */
  private async endUnreachableTeam(teamId: string, reason: string): Promise<void> {
    if (this.disbandingTeams.has(teamId)) return
    const team = getTeam(teamId)
    if (!team || team.status !== 'active') return

    this.disbandingTeams.add(teamId)
    try {
      console.warn(`[Ensemble] Team ${teamId} unreachable: ${reason}`)
      appendMessage(teamId, {
        id: uuidv4(),
        teamId,
        from: 'ensemble',
        to: 'team',
        content: `🛑 Team ended by watchdog: ${reason}`,
        type: 'chat',
        timestamp: new Date().toISOString(),
      })
      await writeDisbandSummary(teamId, { failureReason: reason })
      await disbandTeam(teamId)
    } catch (err) {
      console.error(`[Ensemble] Failed to end unreachable team ${teamId}:`, err)
    } finally {
      this.disbandingTeams.delete(teamId)
    }
  }

  private cleanupStaleTeams(): void {
    const teams = loadTeams()
    const staleThresholdMs = 2 * 60 * 60 * 1000 // 2 hours
    const now = Date.now()
    let count = 0
    for (const team of teams) {
      if (team.status !== 'active') continue
      const age = now - new Date(team.createdAt).getTime()
      if (age > staleThresholdMs) {
        // Write a summary first: these teams did real work whose outcome would
        // otherwise be lost, which is exactly what happened to 7 teams before.
        const reason = `stale on service start, still active after ${formatDuration(age)}`
        void writeDisbandSummary(team.id, { failureReason: reason }).catch(err =>
          console.error(`[Ensemble] Stale summary failed for ${team.id}:`, err),
        )
        updateTeam(team.id, { ...team, status: 'disbanded' })
        count++
      }
    }
    if (count > 0) {
      console.log(`[Ensemble] Startup cleanup: disbanded ${count} stale active team(s)`)
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

        await writeDisbandSummary(team.id)
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

    // Explicit sentinel path: once EVERY active agent has sent the exact done
    // sentinel, disband immediately. This bypasses the min-message count and
    // the idle wait — the agents have explicitly agreed the task is done.
    // The bar is every agent, not two: in a trio, disbanding on the second
    // sentinel kills the third agent mid-task.
    const activeNames = new Set(team.agents.filter(a => a.status === 'active').map(a => a.name))
    const sentinelSenders = new Set(
      messages
        .filter(m => activeNames.has(m.from) && m.content.trim() === EXPLICIT_DONE_SENTINEL)
        .map(m => m.from),
    )
    if (activeNames.size >= 2 && sentinelSenders.size >= activeNames.size) return true

    // Don't auto-disband until agents have exchanged enough messages
    if (nonEnsembleMessages.length < MIN_MESSAGES_BEFORE_AUTO_DISBAND) return false

    // Robust timestamp handling: skip idle check if no timestamp available
    const lastTimestamp = lastMessage.timestamp
      ? new Date(lastMessage.timestamp).getTime()
      : NaN
    if (Number.isNaN(lastTimestamp)) return false

    const activeAgents = team.agents.filter(agent => agent.status === 'active')
    if (activeAgents.length === 0) return false

    const idleForMs = Date.now() - lastTimestamp
    const activeAgentNames = new Set(activeAgents.map(agent => agent.name))
    const completionSignals = messages
      .filter(message => activeAgentNames.has(message.from) && this.hasCompletionSignal(message.content))
      .map(message => ({
        agentName: message.from,
        timestamp: message.timestamp ? new Date(message.timestamp).getTime() : NaN,
      }))
      .filter((signal): signal is CompletionSignal => !Number.isNaN(signal.timestamp))
      .sort((a, b) => a.timestamp - b.timestamp)

    // Wording alone never ends a live session. Agents say "klaar" about a
    // sub-step, and the closure proposal the prompt asks for in rule 7 ("I think
    // we're done because X") is itself a match. Killing on that costs a trio its
    // third agent mid-task. The exact sentinel above is the fast path; these
    // patterns are only a safety net for teams that go quiet without sending it.
    if (idleForMs <= TWO_SIGNAL_IDLE_THRESHOLD_MS) return false
    if (this.hasTwoRecentCompletionSignals(completionSignals)) return true
    if (idleForMs <= SINGLE_SIGNAL_IDLE_THRESHOLD_MS) return false
    return completionSignals.length >= 1
  }

  private hasCompletionSignal(content: string): boolean {
    return isCompletionStatement(content)
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

/** Escape HTML voor alert-hub body. */
function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function sendTelegramSummary(params: {
  task: string
  duration: string
  messageCount: number
  agentSummaries: { name: string; msgs: number; tokens: string }[]
  teamId?: string
}): void {
  // Stabiele dedup-key. teamId indien aangeleverd door caller, anders
  // task-slice + now zodat retries niet dubbel posten.
  const teamKey = params.teamId || `${params.task.slice(0, 40).replace(/\\s+/g, '-')}-${Date.now()}`

  // Voorkeur: helsdingen-alerts hub als ALERT_HUB_SECRET gezet is.
  if (ALERT_HUB_SECRET) {
    const agents = params.agentSummaries
    const agentLine = agents.map(a => `${escHtml(a.name)} (${a.msgs}, ${escHtml(a.tokens)})`).join(' + ')
    const hubBody = [
      `<i>${escHtml(params.task.slice(0, 150))}</i>`,
      agentLine,
    ].join('\n')

    const hubPayload = JSON.stringify({
      app: 'ensemble',
      severity: 'low',
      dedup_key: `collab-${teamKey}`,
      title: `\u2728 <b>Collab klaar</b> \u2014 ${escHtml(params.duration)}, ${params.messageCount} msgs`,
      body: hubBody,
    })

    const hubCurl = spawn(
      'curl',
      [
        '-sS', '-X', 'POST',
        `${ALERT_HUB_URL}?key=${encodeURIComponent(ALERT_HUB_SECRET)}`,
        '-H', 'Content-Type: application/json',
        '-d', hubPayload,
      ],
      { detached: true, stdio: 'ignore' },
    )
    hubCurl.on('error', err => {
      console.error('[Ensemble] Failed to post to alert-hub:', err)
    })
    hubCurl.unref()
    return
  }

  // Fallback: directe Telegram als hub-secret niet gezet.
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
  // Everyone reads the same feed regardless of the `to` field, so with more than
  // one teammate address the team — naming a single one reads as a private aside.
  const sayTarget = params.teammateNames.length === 1 ? params.teammateNames[0] : 'team'
  const teamSayCmd = `${scriptsDir}/team-say.sh ${params.teamId} ${params.agentName} ${sayTarget || 'team'}`
  const teamReadCmd = `${scriptsDir}/team-read.sh ${params.teamId}`

  // Wording has to scale past a pair: a trio told "both teammates" will close
  // the team as soon as one other agent agrees.
  const mateCount = params.teammateNames.length
  const solo = mateCount === 1
  const mateWord = solo ? 'teammate' : 'teammates'
  const mateList = solo
    ? params.teammateNames[0]
    : params.teammateNames.slice(0, -1).join(', ') + ' and ' + params.teammateNames[mateCount - 1]
  const agentTotal = mateCount + 1

  let roleInstructions: string[]

  if (template && params.agentIndex < template.roles.length) {
    const templateRole = template.roles[params.agentIndex]
    roleInstructions = [
      `ROLE: ${templateRole.role}.`,
      templateRole.focus,
    ]
  } else {
    const isLead = params.agentIndex === 0
    const roleName = isLead ? 'LEAD' : 'WORKER'
    roleInstructions = isLead
      ? [
          `ROLE: ${roleName}.`,
          `You own architecture, planning, high-level design, task breakdown, and code review.`,
          `Your first action after greeting is to share a concrete implementation plan with the ${solo ? 'worker' : 'workers'} before any implementation starts.`,
          solo
            ? `Keep the worker focused by delegating clear implementation steps, reviewing progress, and calling out risks or design corrections early.`
            : `Keep the workers focused by giving each of them a clearly separated piece of the work, reviewing progress, and calling out risks, overlap, or design corrections early.`,
        ]
      : [
          `ROLE: ${roleName}.`,
          `You own implementation, writing code, running tests, and reporting concrete execution progress.`,
          `After greeting, wait for the lead's plan before starting implementation work.`,
          ...(solo ? [] : [`You are not the only worker: before you start on a piece, check the feed for what the others already claimed, and say what you are taking so nobody duplicates it.`]),
          `Once the lead shares a plan, execute it pragmatically, report what you changed, and surface blockers or test failures quickly.`,
        ]
  }

  return [
    `You are ${params.agentName} in team "${params.teamName}" with ${mateWord} ${mateList}.`,
    `Task: ${params.description}`,
    ...roleInstructions,
    `COMMUNICATION RULES:`,
    `1. Send findings: ${teamSayCmd} "your message"`,
    `2. Read teammate messages: ${teamReadCmd}`,
    `3. After EVERY analysis step, run team-say to share what you found`,
    `4. After EVERY team-say, run team-read to check for responses`,
    `5. If teammate shared findings, RESPOND to them`,
    `6. Keep alternating: analyze, share, read, respond, analyze`,
    `DONE PROTOCOL (important):`,
    `7. When you believe the task is fully converged and there is nothing substantive left to say, explicitly propose closure to your ${mateWord} in a normal team-say message ("I think we're done because X — agree?").`,
    `8. Only once ${solo ? 'your teammate has' : `ALL ${mateCount} of your teammates have`} confirmed agreement, send a FINAL team-say whose message is EXACTLY the sentinel <<COLLAB_DONE>> (nothing else, no quotes, no prose). The team auto-disbands only after all ${agentTotal} agents have sent <<COLLAB_DONE>>, so do not send it prematurely${solo ? '' : ', and do not treat one teammate agreeing as the whole team agreeing'}.`,
    `9. Before sending <<COLLAB_DONE>>, make sure the important conclusions (recommendation, rationale, build list, layout, decisions) are actually present as long team-say messages in the transcript — that is what the summary will preserve. Do not keep insights only in your head.`,
    `Start NOW: greet your teammate with team-say, then begin.`,
  ].join(' ')
}

export async function createEnsembleTeam(
  request: CreateTeamRequest
): Promise<ServiceResult<{ team: EnsembleTeam }>> {
  // Reject unknown agents before creating anything. The caller named these
  // explicitly, so silently substituting claude would hand back a team that
  // looks right and is not: two identical models where two different ones were
  // asked for. Cheaper to fail here than to discover it halfway a review.
  const unknown = request.agents
    .map(spec => resolveAgentProgramDetailed(spec.program))
    .filter(resolution => resolution.how === 'fallback')
  if (unknown.length > 0) {
    const names = unknown.map(u => `"${u.requested}"`).join(', ')
    return {
      error: `Unknown agent(s): ${names}. Available: ${availableAgentKeys().join(', ')}`,
      status: 400,
    }
  }

  const team = createTeam(request)
  const cwd = request.workingDirectory || process.cwd()
  const worktreeMap = new Map<string, WorktreeInfo>()

  // Phase 0: Create worktrees for local agents if requested
  if (request.useWorktrees) {
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

      // Record what was actually launched, not just what was asked for. The
      // requested name and the resolved command can differ, and when they do you
      // want it in the archive rather than having to dig through tmux panes
      // afterwards to find out which model really answered.
      const resolution = resolveAgentProgramDetailed(agentSpec.program)
      const via = resolution.how === 'exact'
        ? resolution.agent.command
        : `${resolution.agent.command} (matched via ${resolution.how})`
      appendMessage(team.id, {
        id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `${agentSpec.name} (${agentSpec.program} → ${via} @ ${hostId}) has joined #${team.name}`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[Ensemble] Failed to spawn ${agentName}:`, message)
      team.agents[i].status = 'idle'
      appendMessage(team.id, {
        id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `Failed to spawn ${agentName}: ${message}`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
    }
  }

  updateTeam(team.id, { ...team, status: 'active' })

  // Phase 2: Wait for ALL agents to be ready, then inject prompts
  const activeAgents = team.agents.filter(a => a.status === 'active')
  if (activeAgents.length >= 2) {
    const runtime = getRuntime()

    const waitForReady = async (
      sessionName: string, program: string, hostId?: string, maxWait = 60000,
    ): Promise<boolean> => {
      const start = Date.now()
      const agentConfig = resolveAgentProgram(program)
      const readyMarker = agentConfig.readyMarker
      let lastGateName = ''
      let lastGateHandledAt = 0
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
            const gate = AUTO_CONFIRM_GATES.find(candidate => candidate.pattern.test(output))
            if (gate) {
              const now = Date.now()
              if (gate.name !== lastGateName || now - lastGateHandledAt >= 3000) {
                if (gate.action === 'accept-bypass') {
                  await runtime.sendKeys(sessionName, 'Down', { enter: true })
                } else {
                  await runtime.sendKeys(sessionName, 'Enter')
                }
                lastGateName = gate.name
                lastGateHandledAt = now
                console.log(`[Ensemble] Auto-confirmed ${gate.name} in ${sessionName}`)
              }
              await new Promise(r => setTimeout(r, 1000))
              continue
            }
            if (output.includes(readyMarker)) {
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

    // Best-effort readiness — Codex CLI in particular often misses the readyMarker
    // while being functionally ready. Don't abort; warn and proceed with prompt
    // injection for ALL agents whose tmux session exists. Their CLI will buffer
    // the paste and process it when they reach the input prompt.
    for (const nr of notReady) {
      console.warn(`[Ensemble] ${nr.sessionName} did not signal ready in time — attempting prompt injection anyway`)
      appendMessage(team.id, {
        id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `⚠ ${nr.agent.name} did not signal ready in time — injecting prompt anyway (best-effort)`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
    }

    // Use all agents for injection. Only abort if literally zero agents have a session.
    const injectTargets = readyResults
    if (injectTargets.length === 0) {
      appendMessage(team.id, {
        id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `❌ Team start aborted: no agents available for prompt injection`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
      return { data: { team }, status: 201 }
    }
    if (notReady.length > 0) {
      // Give the non-ready agents a small extra grace window before pasting,
      // so any in-progress trust prompts or async init can complete.
      await new Promise(r => setTimeout(r, 3000))
    }

    await new Promise(r => setTimeout(r, 2000))

    // Phase 3: Inject prompts (skip if staged — staged workflow handles its own prompts)
    if (request.staged) {
      // Staged mode: skip normal prompt injection, run plan→exec→verify workflow
      appendMessage(team.id, {
        id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `🚀 ${injectTargets.length}/${activeAgents.length} agents — starting staged workflow (plan → exec → verify)`,
        type: 'chat', timestamp: new Date().toISOString(),
      })

      const buildStagedPlanPrompt = (agentName: string, otherNames: string[], agentIndex: number): string => [
        buildPrompt(agentName, otherNames, agentIndex),
        `STAGED WORKFLOW MODE.`,
        `PHASE 1 PLAN: ONLY create and share a plan via team-say.`,
        `Do NOT write code, edit files, or run mutating commands yet.`,
        `Both agents must share their plan before implementation begins.`,
        `After sharing your plan, run team-read and align on the execution approach.`,
      ].join(' ')

      const buildStagedExecPrompt = (otherNames: string[]): string => [
        `PHASE 2 EXEC: Planning is complete.`,
        `You may now execute the agreed plan and make code changes.`,
        `Share concrete progress via team-say and explicitly report when your implementation is done.`,
        `Keep coordinating with ${otherNames.join(', ')} as you work.`,
      ].join(' ')

      const buildStagedVerifyPrompt = (teammateToReview?: string): string => [
        `PHASE 3 VERIFY: Review ${teammateToReview || 'your teammate'}'s work.`,
        `Inspect what they changed, compare it against the plan, and report findings via team-say.`,
        `Focus on bugs, regressions, missing tests, and mismatches with the agreed approach.`,
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
      })
    } else {
      // Normal mode: inject prompts simultaneously
      console.log(`[Ensemble] Injecting prompts into ${injectTargets.length} agents (${ready.length} ready, ${notReady.length} best-effort)`)
      await Promise.all(
        injectTargets.map(async ({ agent, sessionName }) => {
          const promptFile = collabPromptFile(team.id, agent.name)
          try {
            if (agent.hostId && !isSelf(agent.hostId)) {
              const host = getHostById(agent.hostId)
              if (host) {
                const prompt = fs.readFileSync(promptFile, 'utf-8')
                await postRemoteSessionCommand(host.url, sessionName, prompt)
              }
            } else {
              const agentCfg = resolveAgentProgram(agent.program)
              if (agentCfg.inputMethod === 'pasteFromFile') {
                await runtime.pasteFromFile(sessionName, promptFile)
              } else {
                const prompt = fs.readFileSync(promptFile, 'utf-8')
                await runtime.sendKeys(sessionName, prompt, { literal: true, enter: true })
              }
              // Claude sometimes shows "[Pasted text" and needs an extra Enter to submit
              if (agent.program.toLowerCase().includes('claude')) {
                for (const delayMs of [1500, 3000, 6000]) {
                  await new Promise(resolve => setTimeout(resolve, delayMs))
                  const pane = await runtime.capturePane(sessionName, 80)
                  if (!/\[Pasted text/i.test(pane)) break
                  await runtime.sendKeys(sessionName, 'Enter')
                }
              }
            }
            console.log(`[Ensemble] ✓ Prompt injected into ${sessionName}`)
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            appendMessage(team.id, {
              id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
              content: `❌ Delivery to ${agent.name} failed: ${message}`,
              type: 'chat', timestamp: new Date().toISOString(),
            })
            console.error(`[Ensemble] ✗ Failed to inject prompt into ${sessionName}:`, err)
          }
        })
      )

      appendMessage(team.id, {
        id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `🚀 ${injectTargets.length} agents received their task — collaboration started${notReady.length ? ` (${notReady.length} via best-effort fallback)` : ''}`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
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

export async function checkIdleTeams(): Promise<void> {
  await ensembleService.checkIdleTeams()
}

export function getTeamFeed(teamId: string, since?: string): ServiceResult<{ messages: EnsembleMessage[] }> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }
  return { data: { messages: getMessages(teamId, since) }, status: 200 }
}

export async function sendTeamMessage(
  teamId: string, to: string, content: string, from?: string,
  existingId?: string, existingTimestamp?: string,
): Promise<ServiceResult<{ message: EnsembleMessage }>> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }

  const message: EnsembleMessage = {
    id: existingId || uuidv4(), teamId, from: from || 'user', to, content,
    type: 'chat', timestamp: existingTimestamp || new Date().toISOString(),
  }
  appendMessage(teamId, message)

  // Determine which agents should receive this message in their tmux pane
  const sender = from || 'user'
  const recipients = to === 'team'
    ? team.agents.filter(a => a.status === 'active' && a.name !== sender)
    : team.agents.filter(a => a.status === 'active' && a.name === to)

  const runtime = getRuntime()

  for (const targetAgent of recipients) {
    try {
      const sessionName = `${team.name}-${targetAgent.name}`

      // Skip delivery if the agent's tmux pane no longer exists (agent finished and exited)
      const paneAlive = await runtime.sessionExists(sessionName)
      if (!paneAlive) continue

      // Wrap message with sender context + response nudge
      const deliveryText = [
        `[Team message from ${sender}]: ${content}`,
        `→ Respond with team-say. Then run team-read to check for more messages.`,
      ].join('\n')

      if (targetAgent.hostId && !isSelf(targetAgent.hostId)) {
        const host = getHostById(targetAgent.hostId)
        if (host) await postRemoteSessionCommand(host.url, sessionName, deliveryText)
      } else {
        // Always use pasteFromFile for message delivery to avoid shell escaping issues
        // (sendKeys breaks on ?, !, \ and other special chars in zsh)
        const tmpFile = collabDeliveryFile(teamId, sessionName)
        fs.mkdirSync(path.dirname(tmpFile), { recursive: true })
        fs.writeFileSync(tmpFile, deliveryText)
        await runtime.pasteFromFile(sessionName, tmpFile)
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
/**
 * Summary for a run that produced no agent messages at all.
 *
 * Written so a failed run is distinguishable from one that is still going. It
 * reports what the team was asked to do, who was supposed to do it, and the best
 * diagnosis available, including the ensemble-side errors that are usually the
 * actual cause (a failed prompt injection or a session that never came up).
 */
async function writeFailureSummary(
  team: EnsembleTeam,
  messages: EnsembleMessage[],
  failureReason?: string,
): Promise<void> {
  const duration = formatDuration(Date.now() - new Date(team.createdAt).getTime())
  const errors = messages
    .filter(m => m.from === 'ensemble' && /❌|⚠️|🛑|failed|error/i.test(m.content))
    .slice(-5)
    .map(m => `  ${m.timestamp?.slice(11, 19) || '--:--:--'}  ${m.content.replace(/\s+/g, ' ').slice(0, 160)}`)

  const roster = team.agents.map(a => `${a.name} (${a.program}, ${a.status})`).join(', ') || 'none'
  const lines = [
    `Task: ${team.description || 'unknown'}`,
    `Duration: ${duration}`,
    `Messages: 0`,
    `Full transcript: ${collabMessagesFile(team.id)}`,
    '',
    'RUN FAILED: no agent ever posted a message.',
    failureReason ? `Reason: ${failureReason}` : '',
    `Agents: ${roster}`,
    '',
    errors.length
      ? `Last ensemble-side errors:\n${errors.join('\n')}`
      : 'No ensemble-side errors were recorded, which points at prompt delivery:\n' +
        `  the agents started but never received their prompt. Retry with:\n` +
        `  scripts/collab-rescue.sh ${team.id}`,
  ].filter(Boolean)

  const summaryFile = collabSummaryFile(team.id)
  fs.mkdirSync(path.dirname(summaryFile), { recursive: true })
  fs.writeFileSync(summaryFile, lines.join('\n') + '\n')
  console.log(`[Ensemble] Failure summary written to ${summaryFile}`)
}

export async function writeDisbandSummary(
  teamId: string,
  options: { failureReason?: string } = {},
): Promise<void> {
  const team = getTeam(teamId)
  if (!team) return

  const messages = getMessages(teamId)
  const agentMsgs = messages.filter(m => m.from !== 'ensemble' && m.from !== 'user')

  // A run without agent messages used to return here and write nothing at all,
  // so the caller was left with an empty runtime dir and no explanation. That is
  // the worst possible outcome: silence that looks identical to "still working".
  // Write a short failure summary instead, with whatever diagnosis we have.
  if (agentMsgs.length === 0) {
    await writeFailureSummary(team, messages, options.failureReason)
    return
  }

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

  const cleanContent = (s: string) => s.replace(/\/tmp\/ensemble[-\w]*/g, '').trim()

  const summaryText = agents.map(agent => {
    const msgs = agentMsgs
      .filter(m => m.from === agent)
      .map(m => ({ ...m, content: cleanContent(m.content) }))
      .filter(m => m.content && m.content !== EXPLICIT_DONE_SENTINEL)
    const tokens = tokenUsageMap[agent] || 'unknown'
    // Pick the top 3 longest substantive messages — these almost always
    // contain the recommendation, rationale, build list, or concrete
    // conclusions that matter. Fall back to first/last if <3 total.
    const ranked = [...msgs].sort((a, b) => b.content.length - a.content.length).slice(0, 3)
    const keyMsgs = ranked.length
      ? ranked
          .map((m, i) => `  [${i + 1}] (${m.content.length} chars)\n    ${m.content.slice(0, 1200).replace(/\n/g, '\n    ')}`)
          .join('\n')
      : '  (no substantive messages)'
    return `${agent} (${msgs.length} msgs, tokens: ${tokens})\nKey messages:\n${keyMsgs}`
  }).join('\n\n')

  const summaryFile = collabSummaryFile(teamId)
  const transcriptPointer = collabMessagesFile(teamId)
  fs.mkdirSync(path.dirname(summaryFile), { recursive: true })
  fs.writeFileSync(
    summaryFile,
    `Task: ${team.description || 'unknown'}\nDuration: ${duration}\nMessages: ${agentMsgs.length}\nFull transcript: ${transcriptPointer}\n\n${summaryText}`,
  )
  console.log(`[Ensemble] Summary written to ${summaryFile}`)
}

export async function disbandTeam(teamId: string): Promise<ServiceResult<{ team: EnsembleTeam }>> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }

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

    for (const agent of agentsWithWorktrees) {
      const worktreeInfo: WorktreeInfo = {
        path: agent.worktreePath!,
        branch: agent.worktreeBranch!,
        agentName: agent.name,
      }
      const result = await mergeWorktree(worktreeInfo, basePath)

      appendMessage(teamId, {
        id: uuidv4(), teamId, from: 'ensemble', to: 'team',
        content: result.success
          ? `🌳 Merged ${agent.name}'s worktree (${agent.worktreeBranch})`
          : `⚠️ Merge conflict for ${agent.name}: ${result.conflicts?.join(', ')}`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
    }

    for (const agent of agentsWithWorktrees) {
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
    completedAt: new Date().toISOString(),
  })

  // Soft cleanup: remove ephemeral files, keep messages/summary/log, write .finished marker
  try {
    // The feed poller started by collab-launch.sh also stops on the .finished
    // marker, but only on its next tick; kill it here so a disband never leaves
    // a loop behind (on 2026-09-01 sixteen of them had outlived their teams).
    const pollerPidFile = collabPollerPid(teamId)
    if (fs.existsSync(pollerPidFile)) {
      const pollerPid = parseInt(fs.readFileSync(pollerPidFile, 'utf8').trim(), 10)
      if (pollerPid > 0) {
        try { process.kill(pollerPid, 'SIGTERM') } catch { /* already gone */ }
      }
      fs.unlinkSync(pollerPidFile)
    }
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
        teamId: team.id,
      })

      // Detect the working directory as project hint
      const cwdMatch = team.description.match(/workingDirectory[:\s]*([^\s,}]+)/)
      const project = process.env.ENSEMBLE_PROJECT
        || (cwdMatch ? cwdMatch[1].split('/').pop() : undefined)
        || 'ensemble'

      void exportObservation(
        {
          title: `Collab: ${team.description.slice(0, 80)}`,
          subtitle: `${agents.join(' + ')} — ${duration}, ${agentMessages.length} messages`,
          type: 'discovery',
          narrative: `Team "${team.name}" (${duration}):\nTask: ${team.description.slice(0, 200)}\n\n${summaryParts.join('\n\n')}`,
          project,
        },
        collabRuntimeDir(teamId),
      ).then(result => {
        if (result.ok) return
        // Say it out loud, in both places the user actually looks. A silent
        // failure here is how this feature stayed dead for weeks.
        const why = result.error || `HTTP ${result.status}`
        console.warn(`[Ensemble] Memory export failed (${result.endpoint}): ${why}`)
        appendMessage(teamId, {
          id: uuidv4(), teamId, from: 'ensemble', to: 'team',
          content: `⚠️ Kon deze collab niet naar claude-mem schrijven (${result.endpoint}): ${why}. `
            + `Payload bewaard als pending-observation.json in de runtime-map.`,
          type: 'chat', timestamp: new Date().toISOString(),
        })
      })
    }
  } catch { /* non-fatal */ }

  return { data: { team: updated! }, status: 200 }
}

/**
 * Internals exposed for tests only. The completion check is pure, so it can be
 * verified against the actual messages that once ended a team too early.
 */
export const __testing = {
  hasCompletionSignal: isCompletionStatement,
  TWO_SIGNAL_IDLE_THRESHOLD_MS,
  SINGLE_SIGNAL_IDLE_THRESHOLD_MS,
  COMPLETION_PATTERNS,
  CONTINUATION_PATTERNS,
}
