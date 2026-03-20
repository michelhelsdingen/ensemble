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
import { resolveAgentProgram } from '../lib/agent-config'
import { AgentWatchdog } from '../lib/agent-watchdog'
import {
  collabPromptFile, collabDeliveryFile, collabSummaryFile,
  collabRuntimeDir, collabFinishedMarker, collabBridgePosted,
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
const COMPLETION_SIGNAL_WINDOW_MS = 60_000
const SINGLE_SIGNAL_IDLE_THRESHOLD_MS = 120_000
const COMPLETION_PATTERNS = [
  /(?:^|[^\p{L}\p{N}_])afgerond(?:[^\p{L}\p{N}_]|$)/iu,
  /(?:^|[^\p{L}\p{N}_])done(?:[^\p{L}\p{N}_]|$)/iu,
  /(?:^|[^\p{L}\p{N}_])complete(?:d)?(?:[^\p{L}\p{N}_]|$)/iu,
  /(?:^|[^\p{L}\p{N}_])klaar(?:[^\p{L}\p{N}_]|$)/iu,
  /(?:^|\s)tot de volgende(?:\s|$)/i,
]

interface CompletionSignal {
  agentName: string
  timestamp: number
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

    if (this.hasTwoRecentCompletionSignals(completionSignals)) return true
    if (idleForMs <= SINGLE_SIGNAL_IDLE_THRESHOLD_MS) return false
    return completionSignals.length >= 1
  }

  private hasCompletionSignal(content: string): boolean {
    return COMPLETION_PATTERNS.some(pattern => pattern.test(content))
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
  return s.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1')
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
          `Your first action after greeting is to share a concrete implementation plan with the worker before any implementation starts.`,
          `Keep the worker focused by delegating clear implementation steps, reviewing progress, and calling out risks or design corrections early.`,
        ]
      : [
          `ROLE: ${roleName}.`,
          `You own implementation, writing code, running tests, and reporting concrete execution progress.`,
          `After greeting, wait for the lead's plan before starting implementation work.`,
          `Once the lead shares a plan, execute it pragmatically, report what you changed, and surface blockers or test failures quickly.`,
        ]
  }

  return [
    `You are ${params.agentName} in team "${params.teamName}" with teammate ${params.teammateNames.join(', ')}.`,
    `Task: ${params.description}`,
    ...roleInstructions,
    `COMMUNICATION RULES:`,
    `1. Send findings: ${teamSayCmd} "your message"`,
    `2. Read teammate messages: ${teamReadCmd}`,
    `3. After EVERY analysis step, run team-say to share what you found`,
    `4. After EVERY team-say, run team-read to check for responses`,
    `5. If teammate shared findings, RESPOND to them`,
    `6. Keep alternating: analyze, share, read, respond, analyze`,
    `Start NOW: greet your teammate with team-say, then begin.`,
  ].join(' ')
}

export async function createEnsembleTeam(
  request: CreateTeamRequest
): Promise<ServiceResult<{ team: EnsembleTeam }>> {
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

      appendMessage(team.id, {
        id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `${agentSpec.name} (${agentSpec.program} @ ${hostId}) has joined #${team.name}`,
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
      return { data: { team }, status: 201 }
    }

    await new Promise(r => setTimeout(r, 2000))

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
      console.log(`[Ensemble] All ${ready.length} agents ready — injecting prompts simultaneously`)
      await Promise.all(
        ready.map(async ({ agent, sessionName }) => {
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
        content: `🚀 All ${ready.length} agents received their task — collaboration started`,
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
      // Wrap message with sender context + response nudge
      const deliveryText = [
        `[Team message from ${sender}]: ${content}`,
        `→ Respond with team-say. Then run team-read to check for more messages.`,
      ].join('\n')

      if (targetAgent.hostId && !isSelf(targetAgent.hostId)) {
        const host = getHostById(targetAgent.hostId)
        if (host) await postRemoteSessionCommand(host.url, sessionName, deliveryText)
      } else {
        const agentCfg = resolveAgentProgram(targetAgent.program)
        if (agentCfg.inputMethod === 'pasteFromFile') {
          const tmpFile = collabDeliveryFile(teamId, sessionName)
          fs.mkdirSync(path.dirname(tmpFile), { recursive: true })
          fs.writeFileSync(tmpFile, deliveryText)
          await runtime.pasteFromFile(sessionName, tmpFile)
        } else {
          await runtime.sendKeys(sessionName, deliveryText, { literal: true, enter: true })
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
