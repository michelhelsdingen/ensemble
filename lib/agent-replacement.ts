import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { v4 as uuidv4 } from 'uuid'
import { availableAgentKeys, resolveAgentProgram, shellEscape } from './agent-config'
import { checkAgentHealth } from './agent-health'
import { emitEvent, runRoster } from './brain-hooks'
import { readEnsembleConfig } from './ensemble-config'
import { getTeam, getMessages, updateTeam, appendMessage } from './ensemble-registry'
import { spawnLocalAgent, killLocalAgent, spawnRemoteAgent, killRemoteAgent, postRemoteSessionCommand } from './agent-spawner'
import { getRuntime } from './agent-runtime'
import { isSelf, getHostById } from './hosts-config'
import { collabPromptFile, collabSessionsFile, ensureCollabDirs } from './collab-paths'
import type { EnsembleTeamAgent } from '../types/ensemble'

const replacing = new Set<string>()
const stopping = new Set<string>()

export function stopTeamReplacements(teamId: string): void {
  stopping.add(teamId)
}

export async function replaceTeamAgent(
  teamId: string, agentName: string, detail: string,
  waitForReady: (session: string, program: string, hostId?: string, timeout?: number) => Promise<boolean>,
): Promise<boolean> {
  if (replacing.has(teamId) || stopping.has(teamId)) return false
  replacing.add(teamId)
  let session: string | undefined
  let cleanup: (() => Promise<void>) | undefined
  try {
    const config = readEnsembleConfig()
    const team = getTeam(teamId)
    const old = team?.agents.find(a => a.name === agentName)
    if (!config.replaceStalledAgents || !team || team.status !== 'active' || !old || old.status !== 'active') return false
    // A roster the caller spelled out is not ours to change. On 03-11-2026 a
    // run started as "codex,claude" and four agents were running: the service
    // had quietly added agy and glm as replacements, one of which announced
    // itself as "replaces claude-2" four minutes after the launcher had already
    // reported the start as failed.
    if (team.agentsExplicit) {
      appendMessage(teamId, {
        id: uuidv4(), teamId, from: 'ensemble', to: 'team', type: 'chat', timestamp: new Date().toISOString(),
        content: `${agentName} stalled (${detail}) and was not replaced: you named the agents yourself. Fix that agent, or launch again with a different line-up.`,
      })
      return false
    }
    if ((team.replacementCount ?? 0) >= (config.maxReplacementsPerTeam ?? 2)) return false
    const candidates = config.fallbackOrder.filter(key => availableAgentKeys().includes(key) && !team.agents.some(a => resolveAgentProgram(a.program) === resolveAgentProgram(key)))
    const roster = await runRoster(config)
    const health = roster === undefined ? await checkAgentHealth(candidates, true, config, 5000) : undefined
    const program = candidates.find(key => roster ? roster[key]?.status === 'ok' : health?.healthy ? health.healthy.includes(key) : true)
    if (!program || stopping.has(teamId) || getTeam(teamId)?.status !== 'active') return false
    // Reserve the budget before spawning, including unsuccessful attempts.
    updateTeam(teamId, { replacementCount: (team.replacementCount ?? 0) + 1 })
    const replacement: EnsembleTeamAgent = {
      ...old, agentId: '', name: `${program}-${team.agents.length + 1}`, program, status: 'spawning',
    }
    session = `${team.name}-${replacement.name}`
    const local = !old.hostId || isSelf(old.hostId)
    const host = local ? undefined : getHostById(old.hostId)
    if (!local && !host) return false
    const cwd = old.worktreePath || (local ? team.worktreePath : undefined) || team.workingDirectory || process.cwd()
    const recent = getMessages(teamId).slice(-20).map(m => `${m.from}: ${m.content}`).join('\n')
    const context = Buffer.from(recent).subarray(-8000).toString('utf8')
    const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts')
    const prompt = [
      config.taskPreamble || '',
      `You replace failed teammate ${old.name}. Your name is ${replacement.name}, role: ${old.role}.`,
      `Team ID: ${teamId}. Original task: ${team.description}`,
      `Use ${shellEscape(path.join(scripts, "team-say.sh"))} ${teamId} ${replacement.name} team "message" to share progress and ${shellEscape(path.join(scripts, "team-read.sh"))} ${teamId} ${replacement.name} to read the feed.`,
      'You share the working directory with teammates. Preserve their changes and coordinate ownership.',
      'When finished, send <<COLLAB_DONE>> via team-say. Respond to new questions before sending it again.',
      `Recent team messages (context from the previous run):\n${context}`,
    ].join('\n')
    ensureCollabDirs(teamId)
    const promptFile = collabPromptFile(teamId, replacement.name)
    fs.writeFileSync(promptFile, prompt)
    if (host) await killRemoteAgent(host.url, old.agentId)
    else await killLocalAgent(`${team.name}-${old.name}`)
    if (!host) cleanup = () => killLocalAgent(session!)
    const spawned = host
      ? await spawnRemoteAgent(host.url, session, program, cwd, team.description, team.name)
      : await spawnLocalAgent({ name: session, program, workingDirectory: cwd, hostId: old.hostId })
    if (host) cleanup = () => killRemoteAgent(host.url, spawned.id)
    fs.appendFileSync(collabSessionsFile(teamId), `${session}\n`)
    if (!await waitForReady(session, program, old.hostId, 45_000)) throw new Error('Replacement did not become ready')
    if (stopping.has(teamId) || getTeam(teamId)?.status !== 'active') throw new Error('Team stopped during replacement')
    const runtime = getRuntime()
    if (host) await postRemoteSessionCommand(host.url, session, prompt)
    else if (resolveAgentProgram(program).inputMethod === 'pasteFromFile') await runtime.pasteFromFile(session, promptFile)
    else await runtime.sendKeys(session, prompt, { literal: true, enter: true, agentInput: true })
    const current = getTeam(teamId)
    if (stopping.has(teamId) || !current || current.status !== 'active') throw new Error('Team stopped during replacement')
    replacement.agentId = spawned.id
    replacement.status = 'active'
    replacement.startedAt = new Date().toISOString()
    current.agents = current.agents.map(a => a.name === old.name ? { ...a, status: 'replaced' as const } : a)
    current.agents.push(replacement)
    updateTeam(teamId, { agents: current.agents })
    const ts = new Date().toISOString()
    appendMessage(teamId, { id: uuidv4(), teamId, from: 'ensemble', to: 'team', type: 'chat', timestamp: ts, content: `Replaced ${old.name} with ${replacement.name} (${old.role}): ${detail}` })
    void emitEvent({ event: 'agent_replaced', teamId, team: team.name, ts, agent: old.name, replacement: replacement.name, detail })
    void emitEvent({ event: 'agent_ready', teamId, team: team.name, ts, agent: replacement.name })
    cleanup = undefined
    return true
  } catch (error) {
    console.warn(`[Ensemble] Replacement failed for ${agentName}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  } finally {
    try { await cleanup?.() } catch { /* Session may already be gone. */ }
    replacing.delete(teamId)
  }
}
