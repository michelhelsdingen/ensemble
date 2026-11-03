/**
 * Claude toont een grote paste als "[Pasted text ...]" en wil dan een extra
 * Enter. De lus die dat afhandelde sliep eerst en keek daarna: 1,5 seconde,
 * dan 3, dan 6. Elke start met een claude-agent betaalde dus altijd minstens
 * anderhalve seconde, ook als de prompt bij de eerste Enter al verzonden was.
 *
 * Gevonden door het reviewteam van 03-11-2026 (codex-1 en claude-2, team
 * 40d536c0) als de grootste vaste post in het hele startpad: hij zit binnen de
 * awaited aflevering, dus vóór de launcher "Team is live" kan zeggen.
 */
import { describe, expect, it, vi } from 'vitest'
import { submitPastedPrompt } from '../lib/paste-followup'

const VOOR = '> leeg invoerveld'

describe('submitPastedPrompt', () => {
  it('stopt zodra de pane de prompt heeft aangenomen, zonder te wachten', async () => {
    vi.useFakeTimers()
    try {
      let beeld = VOOR
      const sendEnter = vi.fn(async () => {})
      const bezig = submitPastedPrompt({
        before: VOOR, capture: async () => beeld, sendEnter,
      })
      await vi.advanceTimersByTimeAsync(200)
      beeld = '> de prompt is verzonden\n⏺ aan het nadenken'
      await vi.advanceTimersByTimeAsync(300)
      await bezig
      expect(sendEnter).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stuurt Enter zodra de pastemelding verschijnt', async () => {
    vi.useFakeTimers()
    try {
      let beeld = VOOR
      const sendEnter = vi.fn(async () => { beeld = '> verzonden na de extra enter' })
      const bezig = submitPastedPrompt({
        before: VOOR, capture: async () => beeld, sendEnter,
      })
      await vi.advanceTimersByTimeAsync(200)
      beeld = '> [Pasted text #1 +412 lines]'
      await vi.advanceTimersByTimeAsync(400)
      await bezig
      expect(sendEnter).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('blijft Enter sturen zolang de pastemelding blijft staan, maar niet eindeloos', async () => {
    vi.useFakeTimers()
    try {
      const sendEnter = vi.fn(async () => {})
      const bezig = submitPastedPrompt({
        before: VOOR, capture: async () => '> [Pasted text #1 +412 lines]', sendEnter,
      })
      await vi.advanceTimersByTimeAsync(11_000)
      await bezig
      expect(sendEnter).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('wacht per ronde nooit langer dan de oude vaste tijden', async () => {
    vi.useFakeTimers()
    try {
      const sendEnter = vi.fn(async () => {})
      const bezig = submitPastedPrompt({
        before: VOOR, capture: async () => VOOR, sendEnter,
      })
      // De pane verandert nooit: dan hoort de eerste ronde na 1500ms op te
      // geven, zoals de oude lus deed, en niet door te gaan.
      await vi.advanceTimersByTimeAsync(1400)
      expect(sendEnter).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(200)
      await bezig
      expect(sendEnter).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('geeft op zonder te blijven hangen als de pane niet te lezen is', async () => {
    vi.useFakeTimers()
    try {
      const sendEnter = vi.fn(async () => {})
      const bezig = submitPastedPrompt({
        before: VOOR, capture: async () => { throw new Error('geen pane') }, sendEnter,
      })
      await vi.advanceTimersByTimeAsync(2000)
      await bezig
      expect(sendEnter).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
