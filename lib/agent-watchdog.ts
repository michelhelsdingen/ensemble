import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import type { AgentRuntime } from './agent-runtime'
import type { EnsembleMessage, EnsembleTeam } from '../types/ensemble'

const DEFAULT_POLL_INTERVAL_MS = 30_000
const DEFAULT_NUDGE_MS = 90_000
const DEFAULT_STALL_MS = 180_000
const WATCHDOG_NUDGE_TEXT = 'Are you still working? Share your progress with team-say.'

/**
 * How many consecutive failed nudges before we conclude the agent is gone.
 *
 * A nudge fails when its tmux session no longer exists ("Command failed: tmux
 * send-keys"). Before this limit existed the failure path never recorded
 * `nudgedAt`, so every poll saw a never-nudged agent and tried again, forever.
 * Measured on 2026-08-14: 45.088 failed nudges across 7 teams, 48% of the entire
 * message archive, one team at 21.934. None of those 7 teams ever produced a
 * summary, so the user never saw the outcome of that work.
 */
const DEFAULT_MAX_FAILED_NUDGES = 3

/**
 * How many nudges an agent may receive in total before we leave it alone.
 *
 * The failed-nudge limit above only covers agents whose session is gone. An
 * agent that is still there answers the nudge, which resets `lastMessageAt`, so
 * the next silence looks like the first one and it gets nudged again. Measured
 * on 2026-09-01: 1.434 nudges in August alone, 792 of them to a single session
 * over one night. Every nudge is a full turn carrying the whole conversation.
 */
const DEFAULT_MAX_NUDGES = 5

interface AgentWatchdogState {
  lastMessageAt: string
  nudgedAt?: string
  stalledAt?: string
  /** Consecutive failed nudge attempts; reset on success. */
  failedNudges?: number
  /** Nudges delivered to this agent; survives incoming messages on purpose. */
  nudgeCount?: number
  /** Set once the nudge budget ran out, so we say it once and then stay quiet. */
  nudgeBudgetSpentAt?: string
  /** Set once we gave up on this agent, so we stop retrying and stop logging. */
  unreachableAt?: string
}

interface AgentWatchdogDeps {
  loadTeams: () => EnsembleTeam[]
  getMessages: (teamId: string) => EnsembleMessage[]
  appendMessage: (teamId: string, message: EnsembleMessage) => void
  getRuntime: () => Pick<AgentRuntime, 'sendKeys' | 'pasteFromFile'>
  resolveAgentProgram: (program: string) => { inputMethod: 'pasteFromFile' | 'sendKeys' }
  isSelf: (hostId?: string) => boolean
  getHostById: (hostId: string) => { url: string } | undefined
  postRemoteSessionCommand: (url: string, sessionName: string, text: string) => Promise<void>
  collabDeliveryFile: (teamId: string, sessionName: string) => string
  /**
   * Called when every active agent of a team has become unreachable. Lets the
   * service end the team properly instead of leaving it 'active' forever with a
   * bridge that keeps polling a dead session.
   */
  onTeamUnreachable?: (teamId: string, reason: string) => void | Promise<void>
  now?: () => number
  nudgeAfterMs?: number
  stallAfterMs?: number
  pollIntervalMs?: number
  maxFailedNudges?: number
  maxNudges?: number
}

function parseDuration(rawValue: string | undefined, fallback: number): number {
  const parsed = Number(rawValue)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function getWatchdogNudgeMs(): number {
  return parseDuration(process.env.ENSEMBLE_WATCHDOG_NUDGE_MS, DEFAULT_NUDGE_MS)
}

export function getWatchdogStallMs(): number {
  return parseDuration(process.env.ENSEMBLE_WATCHDOG_STALL_MS, DEFAULT_STALL_MS)
}

export function getWatchdogMaxNudges(): number {
  return parseDuration(process.env.ENSEMBLE_WATCHDOG_MAX_NUDGES, DEFAULT_MAX_NUDGES)
}

export class AgentWatchdog {
  private readonly state = new Map<string, AgentWatchdogState>()
  private readonly timer: NodeJS.Timeout
  private readonly now: () => number
  private readonly nudgeAfterMs: number
  private readonly stallAfterMs: number
  private readonly maxFailedNudges: number
  private readonly maxNudges: number

  constructor(private readonly deps: AgentWatchdogDeps) {
    this.now = deps.now ?? Date.now
    this.nudgeAfterMs = deps.nudgeAfterMs ?? getWatchdogNudgeMs()
    this.stallAfterMs = deps.stallAfterMs ?? getWatchdogStallMs()
    this.maxFailedNudges = deps.maxFailedNudges ?? DEFAULT_MAX_FAILED_NUDGES
    this.maxNudges = deps.maxNudges ?? getWatchdogMaxNudges()

    this.timer = setInterval(() => {
      void this.poll()
    }, deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
    this.timer.unref()
  }

  async poll(): Promise<void> {
    const activeTeams = this.deps.loadTeams().filter(team => team.status === 'active')
    const activeTeamIds = new Set(activeTeams.map(team => team.id))

    for (const key of this.state.keys()) {
      const teamId = key.split(':', 1)[0]
      if (!activeTeamIds.has(teamId)) this.state.delete(key)
    }

    for (const team of activeTeams) {
      await this.pollTeam(team)
    }
  }

  stop(): void {
    clearInterval(this.timer)
    this.state.clear()
  }

  private async pollTeam(team: EnsembleTeam): Promise<void> {
    const messages = this.deps.getMessages(team.id)
    const activeAgents = team.agents.filter(candidate => candidate.status === 'active')
    const activeAgentNames = new Set(activeAgents.map(agent => agent.name))

    for (const key of this.state.keys()) {
      if (!key.startsWith(`${team.id}:`)) continue
      const agentName = key.slice(team.id.length + 1)
      if (!activeAgentNames.has(agentName)) this.state.delete(key)
    }

    for (const agent of activeAgents) {
      const stateKey = `${team.id}:${agent.name}`
      const lastAgentMessage = [...messages].reverse().find(message => message.from === agent.name)
      const lastMessageAt = lastAgentMessage?.timestamp || team.createdAt
      const previousState = this.state.get(stateKey)

      if (!previousState) {
        this.state.set(stateKey, { lastMessageAt })
      } else if (previousState.lastMessageAt !== lastMessageAt) {
        // Progress clears the stall tracking, but NOT the nudge budget: an agent
        // that only ever answers the nudge itself would otherwise reset it too.
        this.state.set(stateKey, {
          lastMessageAt,
          nudgeCount: previousState.nudgeCount,
          nudgeBudgetSpentAt: previousState.nudgeBudgetSpentAt,
        })
        continue
      }

      const lastMessageMs = new Date(lastMessageAt).getTime()
      if (Number.isNaN(lastMessageMs)) continue

      const nowMs = this.now()
      const idleMs = nowMs - lastMessageMs
      const currentState = this.state.get(stateKey) ?? { lastMessageAt }

      // Already given up on this agent: never nudge or log again.
      if (currentState.unreachableAt) continue

      if (!currentState.nudgedAt && idleMs >= this.nudgeAfterMs) {
        const nudgeCount = currentState.nudgeCount ?? 0

        if (nudgeCount >= this.maxNudges) {
          if (!currentState.nudgeBudgetSpentAt) {
            this.state.set(stateKey, {
              ...currentState,
              nudgeBudgetSpentAt: new Date(nowMs).toISOString(),
            })
            this.deps.appendMessage(team.id, {
              id: uuidv4(),
              teamId: team.id,
              from: 'ensemble',
              to: 'team',
              content: `🔕 Watchdog stopped nudging ${agent.name} after ${nudgeCount} nudges without progress`,
              type: 'chat',
              timestamp: new Date(nowMs).toISOString(),
            })
          }
          continue
        }

        try {
          await this.nudgeAgent(team, agent.name, agent.program, agent.hostId)
          this.state.set(stateKey, {
            lastMessageAt,
            nudgedAt: new Date(nowMs).toISOString(),
            nudgeCount: nudgeCount + 1,
          })
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          const failedNudges = (currentState.failedNudges ?? 0) + 1
          const givingUp = failedNudges >= this.maxFailedNudges

          this.state.set(stateKey, {
            ...currentState,
            failedNudges,
            // Marking it stalled too keeps the existing stall reporting coherent.
            ...(givingUp
              ? {
                  unreachableAt: new Date(nowMs).toISOString(),
                  stalledAt: new Date(nowMs).toISOString(),
                }
              : {}),
          })

          // Only speak up on the first failure and on the final one. In between we
          // stay quiet, because it is the same failure and the feed is the archive.
          if (failedNudges === 1 || givingUp) {
            this.deps.appendMessage(team.id, {
              id: uuidv4(),
              teamId: team.id,
              from: 'ensemble',
              to: 'team',
              content: givingUp
                ? `❌ Watchdog gave up on ${agent.name} after ${failedNudges} failed nudges: ${reason}`
                : `❌ Watchdog failed to nudge ${agent.name}: ${reason}`,
              type: 'chat',
              timestamp: new Date(nowMs).toISOString(),
            })
          }

          if (givingUp) await this.reportIfTeamUnreachable(team)
        }
        continue
      }

      if (!currentState.nudgedAt || currentState.stalledAt) continue

      const nudgedMs = new Date(currentState.nudgedAt).getTime()
      if (Number.isNaN(nudgedMs) || nowMs - nudgedMs < this.stallAfterMs) continue

      console.warn(`[Watchdog] Agent ${agent.name} in team ${team.id} stalled after watchdog nudge`)
      this.deps.appendMessage(team.id, {
        id: uuidv4(),
        teamId: team.id,
        from: 'ensemble',
        to: 'team',
        content: `⚠️ Watchdog marked ${agent.name} as stalled after ${Math.round((nowMs - nudgedMs) / 1000)}s without progress after nudge`,
        type: 'chat',
        timestamp: new Date(nowMs).toISOString(),
      })
      this.state.set(stateKey, {
        ...currentState,
        stalledAt: new Date(nowMs).toISOString(),
      })
    }
  }

  /**
   * Once no active agent is reachable anymore the team cannot produce anything.
   * Hand it to the service so it can write a summary and disband, instead of
   * leaving it 'active' with a bridge polling a session that no longer exists.
   */
  private async reportIfTeamUnreachable(team: EnsembleTeam): Promise<void> {
    if (!this.deps.onTeamUnreachable) return
    const activeAgents = team.agents.filter(candidate => candidate.status === 'active')
    const allGone = activeAgents.every(agent => this.state.get(`${team.id}:${agent.name}`)?.unreachableAt)
    if (!allGone) return

    try {
      await this.deps.onTeamUnreachable(
        team.id,
        `all ${activeAgents.length} agent session(s) unreachable after ${this.maxFailedNudges} failed nudges`,
      )
    } catch (err) {
      console.error(`[Watchdog] onTeamUnreachable failed for ${team.id}:`, err)
    }
  }

  private async nudgeAgent(team: EnsembleTeam, agentName: string, _program: string, hostId?: string): Promise<void> {
    const timestamp = new Date(this.now()).toISOString()
    this.deps.appendMessage(team.id, {
      id: uuidv4(),
      teamId: team.id,
      from: 'ensemble',
      to: 'team',
      content: `👀 Watchdog nudged ${agentName}: ${WATCHDOG_NUDGE_TEXT}`,
      type: 'chat',
      timestamp,
    })

    const sessionName = `${team.name}-${agentName}`
    if (hostId && !this.deps.isSelf(hostId)) {
      const host = this.deps.getHostById(hostId)
      if (host) {
        await this.deps.postRemoteSessionCommand(host.url, sessionName, WATCHDOG_NUDGE_TEXT)
      }
      return
    }

    // Always use pasteFromFile to avoid shell escaping issues with sendKeys
    const runtime = this.deps.getRuntime()
    const filePath = this.deps.collabDeliveryFile(team.id, sessionName)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, WATCHDOG_NUDGE_TEXT)
    await runtime.pasteFromFile(sessionName, filePath)
  }
}

export {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_NUDGE_MS,
  DEFAULT_STALL_MS,
  DEFAULT_MAX_FAILED_NUDGES,
  DEFAULT_MAX_NUDGES,
  WATCHDOG_NUDGE_TEXT,
}
