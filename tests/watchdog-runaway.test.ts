/**
 * Regression test for the watchdog runaway.
 *
 * Before the fix, a nudge that threw never recorded `nudgedAt`, so the next poll
 * saw a never-nudged agent and tried again. Forever. Measured 2026-08-14 on the
 * real message archive: 45.088 failed nudges across 7 teams, 48% of all stored
 * messages, and not one of those teams ever produced a summary.
 *
 * Run: npx tsx tests/watchdog-runaway.test.ts
 */
import { describe, it } from 'vitest'
import assert from 'node:assert'
import { AgentWatchdog } from '../lib/agent-watchdog'
import type { EnsembleMessage, EnsembleTeam } from '../types/ensemble'

const TEAM_ID = 'team-runaway'

function makeTeam(agentNames: string[]): EnsembleTeam {
  return {
    id: TEAM_ID,
    name: 'collab-test',
    description: 'runaway regression',
    status: 'active',
    createdAt: new Date(0).toISOString(),
    createdBy: 'test',
    feedMode: 'chat',
    agents: agentNames.map((name, i) => ({
      id: `a${i}`,
      name,
      program: 'claude',
      role: i === 0 ? 'lead' : 'worker',
      status: 'active',
    })),
  } as unknown as EnsembleTeam
}

/** Builds a watchdog whose nudges always fail, like a vanished tmux session. */
function harness(agentNames: string[]) {
  const team = makeTeam(agentNames)
  const messages: EnsembleMessage[] = []
  const unreachable: string[] = []
  let nudgeAttempts = 0
  let now = 1_000_000

  const watchdog = new AgentWatchdog({
    loadTeams: () => [team],
    getMessages: () => messages,
    appendMessage: (_teamId, message) => { messages.push(message) },
    getRuntime: () => ({
      sendKeys: async () => { throw new Error('unused') },
      pasteFromFile: async () => {
        nudgeAttempts++
        throw new Error('Command failed: tmux send-keys')
      },
    }),
    resolveAgentProgram: () => ({ inputMethod: 'pasteFromFile' as const }),
    isSelf: () => true,
    getHostById: () => undefined,
    postRemoteSessionCommand: async () => {},
    collabDeliveryFile: (_teamId, sessionName) => `/tmp/ensemble-test/${sessionName}.txt`,
    onTeamUnreachable: (teamId, reason) => { unreachable.push(`${teamId}: ${reason}`) },
    now: () => now,
    nudgeAfterMs: 1,
    stallAfterMs: 1,
    pollIntervalMs: 1_000_000,
  })

  return {
    watchdog,
    messages,
    unreachable,
    attempts: () => nudgeAttempts,
    async pollTimes(n: number) {
      for (let i = 0; i < n; i++) {
        now += 10_000
        await watchdog.poll()
      }
    },
  }
}


/**
 * Builds a watchdog whose nudges SUCCEED and whose agent answers every one of
 * them without making progress. That is the second runaway: the state resets on
 * every incoming message, so the next silence looks like the first one.
 */
function answeringHarness(agentNames: string[], maxNudges?: number) {
  const team = makeTeam(agentNames)
  const messages: EnsembleMessage[] = []
  let nudgesDelivered = 0
  let now = 1_000_000

  const watchdog = new AgentWatchdog({
    loadTeams: () => [team],
    getMessages: () => messages,
    appendMessage: (_teamId, message) => { messages.push(message) },
    getRuntime: () => ({
      sendKeys: async () => { nudgesDelivered++ },
      pasteFromFile: async () => { nudgesDelivered++ },
    }),
    resolveAgentProgram: () => ({ inputMethod: 'pasteFromFile' as const }),
    isSelf: () => true,
    getHostById: () => undefined,
    postRemoteSessionCommand: async () => {},
    collabDeliveryFile: (_teamId, sessionName) => `/tmp/ensemble-test/${sessionName}.txt`,
    now: () => now,
    nudgeAfterMs: 90_000,
    stallAfterMs: 180_000,
    pollIntervalMs: 1_000_000,
    ...(maxNudges === undefined ? {} : { maxNudges }),
  })

  return {
    watchdog,
    messages,
    delivered: () => nudgesDelivered,
    /** One round = go quiet past the nudge threshold, get nudged, answer it. */
    async roundTrips(rounds: number, agentName = agentNames[0]) {
      for (let i = 0; i < rounds; i++) {
        now += 100_000
        await watchdog.poll()
        now += 1_000
        messages.push({
          id: `reply-${i}`,
          teamId: TEAM_ID,
          from: agentName,
          to: 'team',
          content: 'still working on it',
          type: 'chat',
          timestamp: new Date(now).toISOString(),
        } as EnsembleMessage)
        await watchdog.poll()
      }
    },
  }
}


describe('watchdog runaway', () => {
  
  it('stops nudging after the limit instead of retrying forever', async () => {
    const h = harness(['claude-1'])
    await h.pollTimes(25)
    assert.strictEqual(h.attempts(), 3, `expected 3 attempts, got ${h.attempts()}`)
    h.watchdog.stop()
  })

  it('does not flood the feed: one first-failure line, one give-up line', async () => {
    const h = harness(['claude-1'])
    await h.pollTimes(25)
    const failureLines = h.messages.filter(m => m.content.includes('❌'))
    assert.strictEqual(failureLines.length, 2, `expected 2 lines, got ${failureLines.length}`)
    assert.ok(failureLines[1].content.includes('gave up'), 'last line should say it gave up')
    h.watchdog.stop()
  })

  it('reports the team as unreachable exactly once', async () => {
    const h = harness(['claude-1'])
    await h.pollTimes(25)
    assert.strictEqual(h.unreachable.length, 1, `expected 1 report, got ${h.unreachable.length}`)
    assert.ok(h.unreachable[0].startsWith(TEAM_ID), 'report should name the team')
    h.watchdog.stop()
  })

  it('waits for ALL agents to be gone before ending the team', async () => {
    const h = harness(['claude-1', 'codex-2'])
    await h.pollTimes(25)
    // 2 agents x 3 attempts, and only one team-level report once both are gone.
    assert.strictEqual(h.attempts(), 6, `expected 6 attempts, got ${h.attempts()}`)
    assert.strictEqual(h.unreachable.length, 1, `expected 1 report, got ${h.unreachable.length}`)
    h.watchdog.stop()
  })
})

describe('watchdog runaway on answered nudges', () => {

  it('stops nudging an agent that answers every nudge without progress', async () => {
    const h = answeringHarness(['claude-1'])
    await h.roundTrips(25)
    assert.ok(
      h.delivered() <= 5,
      `expected at most 5 nudges for an answering agent, got ${h.delivered()}`,
    )
    h.watchdog.stop()
  })

  it('says once in the feed that it stopped nudging', async () => {
    const h = answeringHarness(['claude-1'])
    await h.roundTrips(25)
    const stopped = h.messages.filter(m => m.content.includes('stopped nudging'))
    assert.strictEqual(stopped.length, 1, `expected 1 line, got ${stopped.length}`)
    h.watchdog.stop()
  })

  it('counts the budget per agent, not per team', async () => {
    const h = answeringHarness(['claude-1', 'codex-2'])
    // Only claude-1 answers; codex-2 stays silent and follows the stall path.
    await h.roundTrips(25, 'claude-1')
    const stopped = h.messages.filter(m => m.content.includes('stopped nudging'))
    assert.strictEqual(stopped.length, 1, `expected 1 line, got ${stopped.length}`)
    assert.ok(
      stopped[0].content.includes('claude-1'),
      'only the answering agent should run out of budget',
    )
    h.watchdog.stop()
  })

  it('honours a configured budget', async () => {
    const h = answeringHarness(['claude-1'], 2)
    await h.roundTrips(25)
    assert.strictEqual(h.delivered(), 2, `expected 2 nudges, got ${h.delivered()}`)
    h.watchdog.stop()
  })
})
