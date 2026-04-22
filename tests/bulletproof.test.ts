// B1: Targeted tests for the bulletproof batch (Fix 1-10 + A1-A5 invariants).
// @ts-ignore — bun:test resolved at runtime by bun
import { test, expect, describe } from 'bun:test'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  canTransitionPhase,
  ActiveTeamExistsError,
} from '../lib/ensemble-registry'
import {
  parseMessageClass,
  isSemanticIdle,
  hasProgress,
} from '../lib/agent-watchdog'
import type { EnsembleMessage } from '../types/ensemble'

function makeMsg(from: string, content: string): EnsembleMessage {
  return {
    id: `${Math.random()}`,
    teamId: 't',
    from,
    to: 'team',
    content,
    type: 'chat',
    timestamp: new Date().toISOString(),
  }
}

describe('A2: FSM transition guards', () => {
  test('allows legal forming → spawning', () => {
    expect(canTransitionPhase('forming', 'spawning')).toBe(true)
  })
  test('rejects illegal disbanded → executing', () => {
    expect(canTransitionPhase('disbanded', 'executing')).toBe(false)
  })
  test('allows any → failed (panic exit)', () => {
    expect(canTransitionPhase('executing', 'failed')).toBe(true)
  })
  test('idempotent same-phase transition', () => {
    expect(canTransitionPhase('executing', 'executing')).toBe(true)
  })
  test('allows unset → anything (first transition)', () => {
    expect(canTransitionPhase(undefined, 'forming')).toBe(true)
  })
})

describe('Fix 6: parseMessageClass', () => {
  test('detects [PLAN] prefix', () => {
    expect(parseMessageClass('[PLAN] ownership split...')).toBe('PLAN')
  })
  test('detects [DONE] case-insensitive', () => {
    expect(parseMessageClass('[done] artifact...')).toBe('DONE')
  })
  test('returns undefined for untagged', () => {
    expect(parseMessageClass('just some prose')).toBeUndefined()
  })
  test('tolerates leading whitespace', () => {
    expect(parseMessageClass('   [FINDING] file:line')).toBe('FINDING')
  })
})

describe('Fix 5: isSemanticIdle', () => {
  test('detects 3 identical messages as idle', () => {
    const recent = [
      makeMsg('a', 'Idle.'),
      makeMsg('a', 'Idle.'),
      makeMsg('a', 'Idle.'),
    ]
    expect(isSemanticIdle(recent, 3)).toBe(true)
  })
  test('ignores class tag when comparing', () => {
    const recent = [
      makeMsg('a', '[ACK] Idle.'),
      makeMsg('a', 'Idle.'),
      makeMsg('a', '[STATUS] Idle.'),
    ]
    expect(isSemanticIdle(recent, 3)).toBe(true)
  })
  test('not idle if messages differ', () => {
    const recent = [
      makeMsg('a', 'Working on fix 1'),
      makeMsg('a', 'Working on fix 2'),
      makeMsg('a', 'Working on fix 3'),
    ]
    expect(isSemanticIdle(recent, 3)).toBe(false)
  })
  test('not idle if fewer than minRepeats', () => {
    const recent = [makeMsg('a', 'Idle.'), makeMsg('a', 'Idle.')]
    expect(isSemanticIdle(recent, 3)).toBe(false)
  })
})

describe('FM17: hasProgress Slovenian patterns', () => {
  test('recognizes napisal', () => {
    expect(hasProgress(makeMsg('a', 'Napisal sem datoteko foo.ts'))).toBe(true)
  })
  test('recognizes implementiral', () => {
    expect(hasProgress(makeMsg('a', 'Implementiral sem fix 4'))).toBe(true)
  })
  test('recognizes popravil', () => {
    expect(hasProgress(makeMsg('a', 'Popravil sem bug v watchdog'))).toBe(true)
  })
  test('recognizes file path', () => {
    expect(hasProgress(makeMsg('a', 'touched /Users/x/foo.ts'))).toBe(true)
  })
  test('recognizes [PROGRESS] tag', () => {
    expect(hasProgress(makeMsg('a', '[PROGRESS] did stuff'))).toBe(true)
  })
  test('rejects pure filler', () => {
    expect(hasProgress(makeMsg('a', 'Idle.'))).toBe(false)
    expect(hasProgress(makeMsg('a', 'Acknowledged.'))).toBe(false)
    expect(hasProgress(makeMsg('a', 'Zaključeno.'))).toBe(false)
  })
  test('rejects explicit [ACK] tag', () => {
    expect(hasProgress(makeMsg('a', '[ACK] got it'))).toBe(false)
  })
})

describe('ActiveTeamExistsError', () => {
  test('carries existingTeam reference', () => {
    const fake = { id: '123', workingDirectory: '/tmp/foo' }
    const ErrCtor = ActiveTeamExistsError as unknown as new (t: unknown) => { name: string; existingTeam: unknown }
    const err = new ErrCtor(fake)
    expect(err.name).toBe('ActiveTeamExistsError')
    expect(err.existingTeam).toBe(fake)
  })
})

describe('Fix 8: collabDeliveryFile uniqueness', () => {
  test('two calls produce different paths', async () => {
    const { collabDeliveryFile } = await import('../lib/collab-paths')
    const a = collabDeliveryFile('team-x', 'agent-1')
    const b = collabDeliveryFile('team-x', 'agent-1')
    expect(a).not.toBe(b)
  })
})
