/**
 * Ensemble Service — Standalone
 * No dependency on ai-maestro's agent-registry or agents-core-service.
 * Uses agent-spawner.ts for local/remote agent lifecycle.
 */

import { EXPLICIT_DONE_SENTINEL, isExplicitDone } from '../lib/explicit-done'
import { v4 as uuidv4 } from 'uuid'
import type { EnsembleTeam, EnsembleMessage, CreateTeamRequest, CollabTemplatesFile } from '../types/ensemble'
import {
  createTeam, getTeam, updateTeam, loadTeams,
  appendMessage, getMessages, markAgentFailed,
} from '../lib/ensemble-registry'
import {
  spawnLocalAgent, killLocalAgent,
  spawnRemoteAgent as spawnRemote, killRemoteAgent,
  postRemoteSessionCommand, isRemoteSessionReady,
  getAgentTokenUsage,
} from '../lib/agent-spawner'
import { isSelf, getHostById, getSelfHostId } from '../lib/hosts-config'
import { getRuntime } from '../lib/agent-runtime'
import { confirmLiveGate, detectLiveGate, isShellCommand } from '../lib/startup-gates'
import { createReadyHold, READY_STABLE_MS, readyScreenState } from '../lib/ready-screen'
import { resolveAgentProgram, resolveAgentProgramDetailed, availableAgentKeys } from '../lib/agent-config'
import { exportObservation, checkMemoryEndpoint, type MemoryExportResult } from '../lib/memory-export'
import { AgentWatchdog } from '../lib/agent-watchdog'
import {
  collabPromptFile, collabDeliveryFile, collabSummaryFile, collabMessagesFile,
  collabRuntimeDir, collabFinishedMarker, collabBridgePosted, collabPollerPid,
  collabBridgeResult, collabSessionsFile, ensureCollabDirs,
} from '../lib/collab-paths'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawn, execFileSync } from 'child_process'
import { createTeamWorktree, createWorktree, mergeWorktree, destroyWorktree, type WorktreeInfo } from '../lib/worktree-manager'
import { runStagedWorkflow } from '../lib/staged-workflow'
import { readEnsembleConfig } from '../lib/ensemble-config'
import { emitEvent, runPlan, type BrainEvent } from '../lib/brain-hooks'
import { replaceTeamAgent, stopTeamReplacements } from '../lib/agent-replacement'
import { confirmPromptStart } from '../lib/prompt-start'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const COLLAB_TEMPLATES_PATH = path.join(__dirname, '..', 'collab-templates.json')

interface ServiceResult<T> {
  data?: T
  error?: string
  status: number
}

const IDLE_CHECK_INTERVAL_MS = 15_000
// How long a freshly typed start command may leave the shell in the foreground
// before the agent counts as not started (a wrapper script execs quickly).
const AGENT_START_GRACE_MS = 5_000
const READY_POLL_MS = 500
const COMPLETION_GRACE_MS = 60_000
const COMPLETION_SIGNAL_WINDOW_MS = 180_000
// How long a team must be silent before completion WORDING may end it.
//
// These were 120s and 60s, and that killed a four-agent research team after
// 4,5 minutes on 2026-08-15. Two agents had written "eerste lezing klaar; nu
// tests" and "systematische vergelijking klaar" about sub-steps, after which
// everyone went quiet to actually read code. Sixty seconds of silence is not an
// idle team, it is an agent reading a file. Research runs routinely go minutes
// without posting, so the wording path needs a margin that only a genuinely
// finished team reaches. Exact sentinels use immediate closure when no newer
// teammate content needs an answer, or a short grace period otherwise.
const SINGLE_SIGNAL_IDLE_THRESHOLD_MS = 480_000
const TWO_SIGNAL_IDLE_THRESHOLD_MS = 300_000
const MIN_MESSAGES_BEFORE_AUTO_DISBAND = 10
// A terminal sentinel from every active agent bypasses the long idle fallback
// and minimum message count. Prompts prefer a separate marker message.
const COMPLETION_PATTERNS = [
  /(?:^|[^\p{L}\p{N}_])afgerond(?:[^\p{L}\p{N}_]|$)/iu,
  /(?:^|[^\p{L}\p{N}_])\bdone\b(?![.\w])/iu,
  // "completed" but not ".completed" (method/property access) or "completion"
  // De punt hoort in de boundary-groep zelf, anders kijkt de lookbehind naar het
  // teken vóór de punt en doet de uitzondering niets.
  /(?:^|[^\p{L}\p{N}_.])completed(?:[^\p{L}\p{N}_]|$)/iu,
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

// Optional alert hub, enabled by an explicit URL and secret.
const ALERT_HUB_SECRET = process.env.ALERT_HUB_SECRET || ''

class EnsembleService {
  private readonly disbandingTeams = new Set<string>()
  private readonly doneEvents = new Map<string, string>()
  private readonly deadlineWarnings = new Map<string, number>()
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
      markAgentFailed: (teamId, agentName) => markAgentFailed(teamId, agentName),
      replacementEnabled: () => !!readEnsembleConfig().replaceStalledAgents,
      sessionExists: async (name, hostId) => {
        if (hostId && !isSelf(hostId)) {
          const host = getHostById(hostId)
          return host ? isRemoteSessionReady(host.url, name) : undefined
        }
        return getRuntime().sessionExists(name)
      },
      replaceAgent: (team, agent, detail) => replaceTeamAgent(team.id, agent.name, detail, waitForReady),
      onAgentStalled: (team, agent, detail) => teamEvent(team, 'agent_stalled', { agent: agent.name, detail }),
      pollIntervalMs: readEnsembleConfig().replaceStalledAgents ? 20_000 : undefined,
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

    // Warn early about connectivity, but generic CORS OPTIONS responses cannot
    // establish write support. Each export must receive a storage acknowledgement.
    void checkMemoryEndpoint().then(result => {
      if (result.ok) {
        console.log(`[Ensemble] Memory endpoint reachable at ${result.endpoint}; storage is verified on export`)
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
      await disbandTeam(teamId, reason)
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
        // Een team dat op disbanded gaat zonder dat zijn processen stoppen, wordt
        // daarna door de watchdog en checkIdleTeams overgeslagen omdat die op
        // status 'active' filteren. De tmux-sessies en de poller blijven dan voor
        // altijd draaien.
        this.stopTeamProcesses(team.id)
        updateTeam(team.id, { ...team, status: 'disbanded' })
        count++
      }
    }
    if (count > 0) {
      console.log(`[Ensemble] Startup cleanup: disbanded ${count} stale active team(s)`)
    }
  }

  // Killt de tmux-sessies uit het sessieregister en stopt bridge/poller via de
  // gedeelde bash-functie stop_team_processes (scripts/collab-paths.sh). Puur
  // best-effort: een ontbrekend register of een proces dat al weg is, is geen
  // fout, dat gebeurt precies bij de oudere teams die dit moet opruimen.
  private stopTeamProcesses(teamId: string): void {
    try {
      const sessions = fs.readFileSync(collabSessionsFile(teamId), 'utf8')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
      for (const session of sessions) {
        try {
          execFileSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' })
        } catch { /* sessie bestond al niet meer */ }
      }
    } catch { /* geen sessieregister, bijvoorbeeld een ouder team */ }

    try {
      const pathsScript = path.join(__dirname, '../scripts/collab-paths.sh')
      execFileSync(
        'bash',
        ['-c', '. "$1" && stop_team_processes "$2"', '_', pathsScript, collabRuntimeDir(teamId)],
        { stdio: 'ignore' },
      )
    } catch { /* geen bridge/poller meer te stoppen */ }
  }

  async checkIdleTeams(): Promise<void> {
    const teams = loadTeams().filter(team => team.status === 'active')

    const activeIds = new Set(teams.map(team => team.id))
    for (const id of this.deadlineWarnings.keys()) {
      if (!activeIds.has(id)) this.deadlineWarnings.delete(id)
    }
    const activeAgentKeys = new Set(teams.flatMap(team =>
      team.agents.filter(agent => agent.status === 'active').map(agent => `${team.id}:${agent.name}`),
    ))
    for (const key of this.doneEvents.keys()) {
      if (!activeAgentKeys.has(key)) this.doneEvents.delete(key)
    }
    const config = readEnsembleConfig()
    for (const team of teams) {
      if (this.disbandingTeams.has(team.id)) continue
      try {
        const messages = getMessages(team.id)
        for (const agent of team.agents.filter(a => a.status === 'active')) {
          const key = `${team.id}:${agent.name}`
          // The first marker after ordinary content identifies a completion run.
          // Repeated markers retain that identity, even across multiple polls.
          let completionId: string | undefined
          for (const message of messages) {
            if (message.from !== agent.name) continue
            completionId = isExplicitDone(message.content)
              ? completionId ?? message.id
              : undefined
          }
          if (completionId === undefined) {
            this.doneEvents.delete(key)
          } else if (this.doneEvents.get(key) !== completionId) {
            this.doneEvents.set(key, completionId)
            teamEvent(team, 'agent_done', { agent: agent.name })
          }
        }
        if (config.maxTeamMinutes !== undefined) {
          const ageMs = Date.now() - new Date(team.createdAt).getTime()
          const deadlineMs = config.maxTeamMinutes * 60_000
          const graceMs = config.graceMinutes * 60_000
          if (ageMs >= deadlineMs) {
            let warningAt = this.deadlineWarnings.get(team.id)
            if (warningAt === undefined) {
              const persistedWarning = getMessages(team.id).find(message =>
                message.from === 'ensemble' && message.content.startsWith('Time is up:') &&
                Number.isFinite(Date.parse(message.timestamp)),
              )
              if (persistedWarning) {
                warningAt = Date.parse(persistedWarning.timestamp)
                this.deadlineWarnings.set(team.id, warningAt)
              }
            }
            if (warningAt === undefined) {
              warningAt = Date.now()
              this.deadlineWarnings.set(team.id, warningAt)
              await sendTeamMessage(team.id, 'team',
                `Time is up: send your final conclusion and then an exact <<COLLAB_DONE>> message within ${config.graceMinutes} minutes.`,
                'ensemble')
            }
            if (Date.now() >= warningAt + graceMs) {
              this.disbandingTeams.add(team.id)
              try {
                const reason = `team stopped on time limit after ${formatDuration(ageMs)}`
                appendMessage(team.id, {
                  id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
                  content: `Team ended after maximum runtime (${config.maxTeamMinutes} minutes) and grace period`,
                  type: 'chat', timestamp: new Date().toISOString(),
                })
                await disbandTeam(team.id, reason)
              } catch (error) {
                console.error(`[Ensemble] Time-limit disband failed for ${team.id}:`, error)
              } finally {
                this.disbandingTeams.delete(team.id)
                this.deadlineWarnings.delete(team.id)
              }
              continue
            }
          }
        }
        if (!this.shouldAutoDisband(team)) continue

        this.disbandingTeams.add(team.id)

        try {
          appendMessage(team.id, {
            id: uuidv4(),
            teamId: team.id,
            from: 'ensemble',
            to: 'team',
            content: 'Auto-disband triggered by agent completion or idle fallback',
            type: 'chat',
            timestamp: new Date().toISOString(),
          })

          await writeDisbandSummary(team.id)
          await disbandTeam(team.id, undefined, 'ok')
        } catch (err) {
          console.error(`[Ensemble] Auto-disband failed for ${team.id}:`, err)
        } finally {
          this.disbandingTeams.delete(team.id)
          this.deadlineWarnings.delete(team.id)
        }
      } catch (err) {
        console.error(`[Ensemble] Idle check failed for ${team.id}:`, err)
      }
    }
  }

  private shouldAutoDisband(team: EnsembleTeam): boolean {
    const messages = getMessages(team.id)
    const activeNames = new Set(team.agents.filter(a => a.status === 'active').map(a => a.name))
    const knownNames = new Set(team.agents.map(a => a.name))
    const nonEnsembleMessages = messages.filter(message =>
      message.from !== 'ensemble' && (!knownNames.has(message.from) || activeNames.has(message.from)),
    )
    const lastMessage = nonEnsembleMessages[nonEnsembleMessages.length - 1]
    if (!lastMessage) return false

    // Text before a terminal marker is content for the other agents.
    // Only active agents can add content that delays immediate closure.
    if (activeNames.size > 0 && [...activeNames].every(name => {
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (message.from === name) return isExplicitDone(message.content)
        if (!activeNames.has(message.from)) continue
        const content = isExplicitDone(message.content)
          ? message.content.trimEnd().slice(0, -EXPLICIT_DONE_SENTINEL.length)
          : message.content
        if (content.trim()) return false
      }
      return false
    })) return true

    // All agents may have finished while one of them has not yet answered
    // content posted after their marker. Give that agent time to respond.
    const activeMessages = messages.filter(message => activeNames.has(message.from))
    const lastAgentMessage = activeMessages.at(-1)
    if (lastAgentMessage && [...activeNames].every(name => {
      const ownLastMessage = activeMessages.filter(message => message.from === name).at(-1)
      return ownLastMessage !== undefined && isExplicitDone(ownLastMessage.content)
    })) {
      const lastAgentAt = lastAgentMessage.timestamp
        ? new Date(lastAgentMessage.timestamp).getTime()
        : NaN
      if (Number.isFinite(lastAgentAt) && Date.now() - lastAgentAt >= COMPLETION_GRACE_MS) return true
    }

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
    // sub-step, and even a tentative closure proposal ("I think
    // we're done because X") is itself a match. Killing on that costs a trio its
    // third agent mid-task. The terminal sentinel above is the fast path; these
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

/**
 * Wacht een export af en voert de afhandeling uit. Een fout in die afhandeling
 * (bijvoorbeeld appendMessage die op een schijffout stuit) blijft hierbinnen:
 * zonder deze wrapper was `void promise.then(handler)` zonder `.catch()` een
 * unhandled rejection, en die haalt met de standaardinstelling van Node het
 * hele proces neer.
 */
async function afhandelenExport<T>(exportPromise: Promise<T>, onResult: (result: T) => void): Promise<void> {
  try {
    const result = await exportPromise
    onResult(result)
  } catch (err) {
    console.error('[Ensemble] Afhandeling van de memory-export mislukte:', err)
  }
}

/** A failed export remains visible in logs and the saved team timeline. */
function memoryExportFailureMessage(result: MemoryExportResult): string {
  const permanent = result.failureKind === 'permanent'
  const why = result.error || `HTTP ${result.status}`
  const recovery = result.pendingFile
    ? `Payload bewaard in ${result.pendingFile}; er is geen automatische nieuwe poging.`
    : `Payload niet bewaard${result.parkingError ? `: ${result.parkingError}` : ''}.`
  const action = permanent
    ? ' Controleer de worker-API en ENSEMBLE_MEMORY_URL; volgende exports kunnen ook mislukken.'
    : ' Controleer de bereikbaarheid van de worker.'
  const content = `${permanent ? '❌' : '⚠️'} Kon deze collab niet naar claude-mem schrijven (${result.endpoint}): ${why}. ${recovery}${action}`
  if (permanent) console.error(`[Ensemble] Memory export FAILED: ${content}`)
  else console.warn(`[Ensemble] Memory export failed: ${content}`)
  return content
}

/** Escape special chars for Telegram MarkdownV2 */
function escMd(s: string): string {
  return s.replace(/([_[\]()~`>#+\-=|{}.!*\\])/g, '\\$1')
}

/** Escape HTML voor alert-hub body. */
function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Post naar de alert-hub. Het geheim ging eerder als `?key=` mee in de argv van
 * een curl-subproces en was daarmee leesbaar in `ps` voor elke andere gebruiker
 * op de machine. De ingebouwde fetch stuurt het als header, die niet in argv
 * terechtkomt. Fire-and-forget zoals de oude spawn ook was: alleen een netwerkfout
 * wordt gelogd, verder wacht niemand hierop.
 */
function postToAlertHub(url: string, secret: string, payload: string): void {
  // Het geheim gaat in de query, want de hub leest het daar en nergens anders
  // (url.searchParams.get("key"), anders 403).
  // Een header lijkt netter maar zou de alerts stil laten wegvallen.
  //
  // Het lek zat dan ook niet in de query zelf maar in het curl-subproces dat
  // deze URL als argv meekreeg, en argv is voor elke andere gebruiker op de
  // machine leesbaar via ps. Met fetch is er geen subproces en dus geen argv.
  const doel = new URL(url)
  doel.searchParams.set('key', secret)

  void fetch(doel, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    signal: AbortSignal.timeout(5000),
  })
    .then(res => {
      // De oude spawn keek nergens naar, dus een afgewezen sleutel was stil.
      if (!res.ok) {
        console.error(`[Ensemble] Alert-hub weigerde de melding: HTTP ${res.status}`)
      }
    })
    .catch(err => {
      console.error('[Ensemble] Failed to post to alert-hub:', err)
    })
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

  const alertHubUrl = readEnsembleConfig().alertHubUrl
  if (alertHubUrl && ALERT_HUB_SECRET) {
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

    postToAlertHub(alertHubUrl, ALERT_HUB_SECRET, hubPayload)
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
    const raw = fs.readFileSync(COLLAB_TEMPLATES_PATH, 'utf-8')
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
  const taskPreamble = readEnsembleConfig().taskPreamble
  const template = loadCollabTemplate(params.templateName)
  const scriptsDir = path.join(__dirname, '..', 'scripts')
  // Everyone reads the same feed regardless of the `to` field, so with more than
  // one teammate address the team — naming a single one reads as a private aside.
  const sayTarget = params.teammateNames.length === 1 ? params.teammateNames[0] : 'team'
  const teamSayCmd = `${scriptsDir}/team-say.sh ${params.teamId} ${params.agentName} ${sayTarget || 'team'}`
  const teamReadCmd = `${scriptsDir}/team-read.sh ${params.teamId}`

  if (params.teammateNames.length === 0) {
    return [
      `You are ${params.agentName}, the only agent in team "${params.teamName}".`,
      ...(taskPreamble ? [`Task preamble: ${taskPreamble}`] : []),
      `Task: ${params.description}`,
      `You own the entire task: planning, implementation or analysis, verification, and reporting.`,
      `COMMUNICATION RULES:`,
      `Send your plan, progress, findings, and blockers via: ${teamSayCmd} "your message"`,
      `After EVERY analysis or implementation step, run team-say to record what you found or changed.`,
      `Read the feed for user instructions: ${teamReadCmd}`,
      `DONE PROTOCOL:`,
      `Complete and verify the task, then report your results, conclusions, and any remaining limitations via team-say.`,
      `Only after that, send a FINAL team-say whose message is EXACTLY <<COLLAB_DONE>> (nothing else). A terminal sentinel is accepted, but a separate message is preferred. This ends the team and preserves the summary.`,
      `Start NOW: share your plan with team-say, then carry out the task independently.`,
    ].join(' ')
  }

  // Scale teammate wording to the number of agents in the team.
  const mateCount = params.teammateNames.length
  const solo = mateCount === 1
  const mateWord = solo ? 'teammate' : 'teammates'
  const mateList = solo
    ? params.teammateNames[0]
    : params.teammateNames.slice(0, -1).join(', ') + ' and ' + params.teammateNames[mateCount - 1]

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
    ...(taskPreamble ? [`Task preamble: ${taskPreamble}`] : []),
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
    `7. When your work is complete and there is no unanswered teammate content or question after your last message, report the conclusion and send a FINAL team-say whose message is EXACTLY the sentinel <<COLLAB_DONE>> (nothing else, no quotes, no prose). Do not send status messages without new information, do not wait for an approval that may never come, and do not leave open questions addressed to you unresolved.`,
    `8. The team auto-disbands immediately once every active agent has sent <<COLLAB_DONE>> after the latest content from every other active agent. If everyone's latest message is a sentinel but someone posted content after yours, you have about one minute from the last agent message to respond before the team closes. A separate sentinel message is preferred. Content before a sentinel also counts for teammates. Do not send a sentinel while awaiting a reply to a question. If new teammate content arrives after your sentinel, respond substantively and send the sentinel again once your work is complete and all questions addressed to you are resolved.`,
    `9. Before sending <<COLLAB_DONE>>, make sure the important conclusions (recommendation, rationale, build list, layout, decisions) are actually present as long team-say messages in the transcript — that is what the summary will preserve. Do not keep insights only in your head.`,
    `Start NOW: greet your teammate with team-say, then begin.`,
  ].join(' ')
}

/** Why an agent is not ready, when the reason is worth telling the user. */
export interface ReadyOutcome {
  ready: boolean
  /** Heading of a dialog the agent cannot answer for itself. */
  blocked?: string
  /** The screen under that dialog, for the message in the feed. */
  tail?: string
}

/**
 * Wait until a pane is really ready to receive a prompt.
 *
 * Three things changed on 03-11-2026, all measured on this machine:
 * - Readiness now comes from readyScreenState, which ignores the scrollback.
 *   The old test ("is the marker anywhere in the capture") was true half a
 *   second after launch for every agent whose marker is the zsh prompt.
 * - Readiness must hold for READY_STABLE_MS. codex is genuinely ready at 1,0s
 *   and modal at 1,6s, so a single reading is not evidence.
 * - An unknown dialog stops the wait instead of running it down. The user
 *   decides on a trust dialog; we never answer one on their behalf, and we
 *   never paste a prompt into one.
 */
async function probeReady(
  sessionName: string, program: string, hostId?: string, maxWait = 60000,
): Promise<ReadyOutcome> {
  const runtime = getRuntime()
  const start = Date.now()
  const agentConfig = resolveAgentProgram(program)
  const readyMarker = agentConfig.readyMarker
  let lastGateName = ''
  let lastGateHandledAt = 0
  const held = createReadyHold(READY_STABLE_MS)
  while (Date.now() - start < maxWait) {
    try {
      if (hostId && !isSelf(hostId)) {
        const host = getHostById(hostId)
        if (host && await isRemoteSessionReady(host.url, sessionName)) {
          console.log(`[Ensemble] ${sessionName} is remotely reachable (${Math.round((Date.now() - start) / 1000)}s)`)
          return { ready: true }
        }
      } else {
        // A shell in the foreground means the agent CLI is not (or no
        // longer) running. Its prompt may even contain the ready marker
        // (❯), so never treat it as ready and never send keys into it.
        const foreground = runtime.getForegroundCommand
          ? await runtime.getForegroundCommand(sessionName)
          : ''
        if (isShellCommand(foreground)) {
          if (Date.now() - start >= AGENT_START_GRACE_MS) {
            console.error(`[Ensemble] ${sessionName}: agent CLI is not running (${foreground} in foreground)`)
            return { ready: false }
          }
          held(false)
          await new Promise(r => setTimeout(r, READY_POLL_MS))
          continue
        }
        const output = await runtime.capturePane(sessionName, 50)
        const screen = readyScreenState(output, readyMarker)
        if (screen.state === 'blocked') {
          console.error(`[Ensemble] ${sessionName} is waiting on a dialog nobody may answer for the user: ${screen.dialog}`)
          return { ready: false, blocked: screen.dialog, tail: screen.tail }
        }
        if (screen.state === 'gate') {
          held(false)
          const now = Date.now()
          if (screen.gate.name !== lastGateName || now - lastGateHandledAt >= 3000) {
            await confirmLiveGate(screen.gate, (keys, options) => runtime.sendKeys(sessionName, keys, options))
            lastGateName = screen.gate.name
            lastGateHandledAt = now
            console.log(`[Ensemble] Auto-confirmed ${screen.gate.name} in ${sessionName}`)
          }
          await new Promise(r => setTimeout(r, READY_POLL_MS))
          continue
        }
        if (held(screen.state === 'ready')) {
          console.log(`[Ensemble] ${sessionName} is ready (${Math.round((Date.now() - start) / 1000)}s)`)
          return { ready: true }
        }
      }
    } catch { held(false) }
    await new Promise(r => setTimeout(r, READY_POLL_MS))
  }
  console.error(`[Ensemble] ${sessionName} did not become ready within ${maxWait / 1000}s`)
  return { ready: false }
}

/** Boolean form, for callers that only need to know whether to continue. */
async function waitForReady(
  sessionName: string, program: string, hostId?: string, maxWait = 60000,
): Promise<boolean> {
  return (await probeReady(sessionName, program, hostId, maxWait)).ready
}


function teamEvent(team: EnsembleTeam, event: BrainEvent['event'], fields: Partial<BrainEvent> = {}): void {
  void emitEvent({ event, teamId: team.id, team: team.name, ts: new Date().toISOString(), ...fields })
}

export async function createEnsembleTeam(
  request: CreateTeamRequest
): Promise<ServiceResult<{ team: EnsembleTeam }>> {
  let plan
  if (!request.agents?.length) {
    plan = await runPlan(request.description)
    if (plan && !plan.agents.every(key => availableAgentKeys().includes(key))) plan = undefined
    request = { ...request, agents: (plan?.agents ?? ['codex', 'claude code']).map((program, i) => ({ program, role: i === 0 ? 'lead' : 'worker' })), templateName: request.templateName || plan?.template }
  }
  const specs = request.agents!
  // Reject unknown agents before creating anything. The caller named these
  // explicitly, so silently substituting claude would hand back a team that
  // looks right and is not: two identical models where two different ones were
  // asked for. Cheaper to fail here than to discover it halfway a review.
  const unknown = specs
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

  if (plan) appendMessage(team.id, {
    id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team', type: 'chat', timestamp: new Date().toISOString(),
    content: `Brain plan: ${plan.agents.join(', ')}; template: ${request.templateName || 'default'}; reason: ${plan.reason || 'not provided'}`,
  })
  if (request.worktree === 'team') {
    try {
      const shared = await createTeamWorktree(team.id, cwd)
      team.worktreePath = shared.path
      team.worktreeBranch = shared.branch
      updateTeam(team.id, { worktreePath: shared.path, worktreeBranch: shared.branch })
    } catch (error) {
      updateTeam(team.id, { status: 'failed' })
      return { status: 400, error: error instanceof Error ? error.message : String(error) }
    }
  }

  // Phase 0: Create worktrees for local agents if requested
  if (request.useWorktrees && request.worktree !== 'team') {
    for (let i = 0; i < team.agents.length; i++) {
      const agentSpec = team.agents[i]
      const hostId = specs[i].hostId
        ? (getHostById(specs[i].hostId!) ? specs[i].hostId! : getSelfHostId())
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

  // Sessies die dit team echt heeft. Postcheck, rescue en cleanup bepaalden dit
  // eerder met een tmux-scan op de vorm van de sessienaam, waardoor het ene
  // team de sessies van het andere meepakte. agentName hieronder is de ENE
  // plek waar de sessienaam ontstaat; het register bewaart die letterlijk in
  // plaats van 'm elders opnieuw samen te stellen uit team.name + agent.name.
  const spawnedSessions: string[] = []
  ensureCollabDirs(team.id)

  // Phase 1: Spawn all agents
  for (let i = 0; i < team.agents.length; i++) {
    const agentSpec = team.agents[i]
    const hostId = await routeToHost(agentSpec.program, specs[i].hostId)
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
        const agentCwd = team.worktreePath || worktreeMap.get(agentSpec.name)?.path || cwd
        if (team.worktreePath) {
          agentSpec.worktreePath = team.worktreePath
          agentSpec.worktreeBranch = team.worktreeBranch
        }
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
      spawnedSessions.push(agentName)
      // Meteen wegschrijven, niet pas na de lus: valt de service om terwijl de
      // volgende agent opstart, dan staan de sessies die al draaien er toch in.
      fs.appendFileSync(collabSessionsFile(team.id), `${agentName}\n`)

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
      teamEvent(team, 'agent_failed', { agent: agentSpec.name, detail: message })
      appendMessage(team.id, {
        id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `Failed to spawn ${agentName}: ${message}`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
    }
  }

  // Register schrijven vóórdat Phase 2 begint met afleveren. Loopt de service
  // hierna vast (bijvoorbeeld tijdens het wachten op ready), dan bestaat het
  // register alsnog en kan rescue de prompts later opnieuw afleveren in plaats
  // van te weigeren met "geen sessieregister" — precies het scenario waarvoor
  // rescue bedoeld is.

  team.status = 'active'
  updateTeam(team.id, { ...team, status: 'active' })
  teamEvent(team, 'team_started', { agents: team.agents.map(a => a.program), cwd: team.worktreePath || cwd, branch: team.worktreeBranch })

  // Phase 2: Wait for ALL agents to be ready, then inject prompts
  const activeAgents = team.agents.filter(a => a.status === 'active')
  if (activeAgents.length > 0) {
    const runtime = getRuntime()

    console.log(`[Ensemble] Waiting for all ${activeAgents.length} agents to be ready...`)
    const readyResults = await Promise.all(
      activeAgents.map(agent => {
        const sessionName = `${team.name}-${agent.name}`
        return probeReady(sessionName, agent.program, agent.hostId)
          .then(outcome => ({ agent, sessionName, ...outcome }))
      })
    )

    const ready = readyResults.filter(r => r.ready)
    for (const { agent } of ready) teamEvent(team, 'agent_ready', { agent: agent.name })
    // An agent stuck on a dialog only the user may answer is not a candidate
    // for best-effort injection: the dialog swallows the paste without a trace,
    // which is exactly how a team used to start with nobody saying anything.
    const blocked = readyResults.filter(r => !r.ready && r.blocked)
    const notReady = readyResults.filter(r => !r.ready && !r.blocked)

    for (const b of blocked) {
      console.error(`[Ensemble] ${b.sessionName} blocked by dialog: ${b.blocked}`)
      b.agent.status = 'failed'
      markAgentFailed(team.id, b.agent.name)
      teamEvent(team, 'agent_failed', { agent: b.agent.name, detail: `blocked by dialog: ${b.blocked}` })
      appendMessage(team.id, {
        id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `❌ ${b.agent.name} is waiting on a dialog that only you may answer: "${b.blocked}". No prompt was delivered. Start ${b.agent.program} once in a terminal, answer it, then launch again.`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
    }

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

    // Only agents whose pane can actually take a paste. Abort when none can.
    const injectTargets = readyResults.filter(r => !r.blocked)
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
    // Staged coordination requires multiple agents; a solo agent uses normal delivery.
    if (request.staged && activeAgents.length >= 2) {
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
      const deliveryResults = await Promise.all(
        injectTargets.map(async ({ agent, sessionName }) => {
          const promptFile = collabPromptFile(team.id, agent.name)
          const local = !agent.hostId || isSelf(agent.hostId)
          const marker = resolveAgentProgram(agent.program).readyMarker
          /**
           * Check the pane right before writing to it, and confirm afterwards
           * that it did something with the input.
           *
           * Until 03-11-2026 the retry pasted the same prompt three times
           * without looking, and then waited a full minute for an answer. The
           * pane was modal on a dialog from the first attempt, so all three
           * vanished and the failure surfaced sixty seconds too late.
           */
          const deliverChecked = async () => {
            if (!local) return deliver()
            const before = await runtime.capturePane(sessionName, 50)
            const screen = readyScreenState(before, marker)
            if (screen.state !== 'ready') {
              const reden = screen.state === 'blocked' ? `dialog "${screen.dialog}"` : `pane not ready (${screen.state})`
              throw new Error(`${agent.name} did not take the prompt: ${reden}`)
            }
            await deliver()
            // A pane that took the paste changes: text appears, a spinner
            // starts, the input line empties. A modal dialog stands still.
            for (const wait of [300, 700, 1500, 2500]) {
              await new Promise(resolve => setTimeout(resolve, wait))
              if (getMessages(team.id).some(message => message.from === agent.name)) return
              if (await runtime.capturePane(sessionName, 50) !== before) return
            }
            throw new Error(`${agent.name} did not take the prompt: the pane did not change`)
          }
          const deliver = async () => {
            if (agent.hostId && !isSelf(agent.hostId)) {
              const host = getHostById(agent.hostId)
              if (!host) throw new Error(`Unknown host: ${agent.hostId}`)
              const prompt = fs.readFileSync(promptFile, 'utf-8')
              await postRemoteSessionCommand(host.url, sessionName, prompt)
            } else {
              const agentCfg = resolveAgentProgram(agent.program)
              if (agentCfg.inputMethod === 'pasteFromFile') {
                if (agent.program.toLowerCase().includes('codex')) {
                  await runtime.pasteFromFile(sessionName, promptFile, 5000)
                } else {
                  await runtime.pasteFromFile(sessionName, promptFile)
                }
              } else {
                const prompt = fs.readFileSync(promptFile, 'utf-8')
                await runtime.sendKeys(sessionName, prompt, { literal: true, enter: true, agentInput: true })
              }
              if (agent.program.toLowerCase().includes('claude')) {
                for (const delayMs of [1500, 3000, 6000]) {
                  await new Promise(resolve => setTimeout(resolve, delayMs))
                  const pane = await runtime.capturePane(sessionName, 80)
                  if (!/\[Pasted text/i.test(pane)) break
                  await runtime.sendKeys(sessionName, 'Enter')
                }
              }
            }
          }
          try {
            await deliverChecked()
            console.log(`[Ensemble] Prompt submitted to ${sessionName}; awaiting agent message`)
            return { agent, sessionName, deliver: deliverChecked }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            if (err instanceof Error && err.name === 'AgentNotRunningError') {
              agent.status = 'failed'
              markAgentFailed(team.id, agent.name)
            }
            appendMessage(team.id, {
              id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
              content: `❌ Delivery to ${agent.name} failed: ${message}`,
              type: 'chat', timestamp: new Date().toISOString(),
            })
            console.error(`[Ensemble] ✗ Failed to inject prompt into ${sessionName}:`, err)
            return null
          }
        })
      )

      appendMessage(team.id, {
        id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `🚀 Prompt submission attempted for ${deliveryResults.filter(Boolean).length}/${injectTargets.length} agents; awaiting confirmation from each agent`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
      for (const result of deliveryResults) {
        if (!result) continue
        const { agent, sessionName, deliver } = result
        void confirmPromptStart({
          hasStarted: () => getMessages(team.id).some(message => message.from === agent.name),
          retry: async () => {
            console.warn(`[Ensemble] No message from ${agent.name}; retrying prompt submission to ${sessionName}`)
            await deliver()
          },
        }).then(confirmed => {
          if (confirmed) {
            console.log(`[Ensemble] Prompt confirmed by message from ${agent.name}`)
          } else {
            console.error(`[Ensemble] Prompt unconfirmed after 3 attempts: ${agent.name} (${sessionName})`)
            appendMessage(team.id, {
              id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
              content: `❌ ${agent.name} did not respond after 3 prompt attempts; inspect the agent pane`,
              type: 'chat', timestamp: new Date().toISOString(),
            })
          }
        }).catch(err => {
          const reason = err instanceof Error ? err.message : String(err)
          console.error(`[Ensemble] Prompt verification failed for ${agent.name}:`, reason)
          appendMessage(team.id, {
            id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
            content: `❌ ${agent.name} prompt verification failed: ${reason}`,
            type: 'chat', timestamp: new Date().toISOString(),
          })
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
      if (err instanceof Error && err.name === 'AgentNotRunningError') {
        targetAgent.status = 'failed'
        markAgentFailed(team.id, targetAgent.name)
      }
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

  const stoppedOnTimeLimit = failureReason?.startsWith('team stopped on time limit') ?? false
  const roster = team.agents.map(a => `${a.name} (${a.program}, ${a.status})`).join(', ') || 'none'
  const lines = [
    `Task: ${team.description || 'unknown'}`,
    `Duration: ${duration}`,
    `Messages: 0`,
    ...(team.worktreePath ? [`Worktree: ${team.worktreePath}`, `Branch: ${team.worktreeBranch}`] : []),
    `Full transcript: ${collabMessagesFile(team.id)}`,
    '',
    stoppedOnTimeLimit ? `RUN STOPPED: ${failureReason}` : 'RUN FAILED: no agent ever posted a message.',
    failureReason ? `Reason: ${failureReason}` : '',
    `Agents: ${roster}`,
    '',
    errors.length
      ? `Last ensemble-side errors:\n${errors.join('\n')}`
      : stoppedOnTimeLimit ? 'No agent messages were recorded before the time limit.'
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
    `Task: ${team.description || 'unknown'}\nDuration: ${duration}\nMessages: ${agentMsgs.length}\nFull transcript: ${transcriptPointer}`
      + (team.worktreePath ? `\nWorktree: ${team.worktreePath}\nBranch: ${team.worktreeBranch}` : '')
      + (options.failureReason ? `\nReason: ${options.failureReason}` : '')
      + `\n\n${summaryText}`,
  )
  console.log(`[Ensemble] Summary written to ${summaryFile}`)
}

export async function disbandTeam(teamId: string, failureReason?: string, finishStatus?: 'ok' | 'failed' | 'stopped'): Promise<ServiceResult<{ team: EnsembleTeam }>> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }

  if (team.status === 'disbanded') return { data: { team }, status: 200 }
  stopTeamReplacements(teamId)

  // Write summary before killing sessions so the Claude Code session can present it
  await writeDisbandSummary(teamId, failureReason ? { failureReason } : {})

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

  // Sweep by session-name prefix, not by the register.
  //
  // 03-11-2026: a cleanup read the session register as it stood at that
  // moment, the service spawned two more agents four minutes later, and those
  // were still running hours afterwards. The loop above also only kills agents
  // with status 'active', so an agent marked failed (a pane stuck on a dialog,
  // for one) kept its session for good. team.name carries a millisecond
  // timestamp plus four random digits, so the prefix belongs to this team
  // alone. The monitor's own session ('ensemble-<id>') does not match it.
  try {
    const runtime = getRuntime()
    const sessions = runtime.listSessions ? await runtime.listSessions() : []
    const prefix = `${team.name}-`
    for (const session of sessions) {
      if (!session.name.startsWith(prefix)) continue
      try { await killLocalAgent(session.name) } catch { /* already gone */ }
    }
  } catch { /* tmux unavailable: nothing to sweep */ }

  const agentsWithWorktrees = team.agents.filter(
    a => a.status !== 'replaced' && a.worktreePath && a.worktreeBranch && (!a.hostId || isSelf(a.hostId))
  )
  if (team.worktree !== 'team' && agentsWithWorktrees.length > 0) {
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

  const finishedMessages = getMessages(teamId)
  const remaining = team.agents.filter(a => a.status === 'active')
  const allDone = remaining.length > 0 && remaining.every(a => {
    const last = [...finishedMessages].reverse().find(m => m.from === a.name)
    return last !== undefined && isExplicitDone(last.content)
  })
  teamEvent(team, 'team_finished', { status: finishStatus ?? (failureReason ? (failureReason.startsWith('team stopped on time limit') ? 'stopped' : 'failed') : allDone ? 'ok' : 'stopped'), durationS: Math.max(0, (Date.now() - Date.parse(team.createdAt)) / 1000), branch: team.worktreeBranch, cwd: team.worktreePath || team.workingDirectory, detail: failureReason })

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

      void afhandelenExport(
        exportObservation(
          {
            title: `Collab: ${team.description.slice(0, 80)}`,
            subtitle: `${agents.join(' + ')} — ${duration}, ${agentMessages.length} messages`,
            type: 'discovery',
            narrative: `Team "${team.name}" (${duration}):\nTask: ${team.description.slice(0, 200)}\n\n${summaryParts.join('\n\n')}`,
            project,
          },
          collabRuntimeDir(teamId),
        ),
        result => {
          if (result.ok) return
          const content = memoryExportFailureMessage(result)
          appendMessage(teamId, {
            id: uuidv4(), teamId, from: 'ensemble', to: 'team',
            content,
            type: 'chat', timestamp: new Date().toISOString(),
          })
        },
      )
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
  afhandelenExport,
  memoryExportFailureMessage,
  postToAlertHub,
}
