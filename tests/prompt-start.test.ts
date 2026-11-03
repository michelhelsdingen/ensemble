import { describe, expect, it, vi } from 'vitest'
import { confirmPromptStart } from '../lib/prompt-start'

describe('confirmPromptStart', () => {
  it('retries a silent agent and confirms only after its own message', async () => {
    vi.useFakeTimers()
    try {
      let codexStarted = false
      const retry = vi.fn(async () => { codexStarted = true })
      const pending = confirmPromptStart({
        hasStarted: () => codexStarted,
        retry,
        waitMs: 2000,
        pollMs: 100,
      })
      await vi.advanceTimersByTimeAsync(2100)
      expect(await pending).toBe(true)
      expect(retry).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports failure after bounded retries when only a teammate speaks', async () => {
    vi.useFakeTimers()
    try {
      const retry = vi.fn(async () => {})
      const pending = confirmPromptStart({
        hasStarted: () => false, retry,
        waitMs: 1000, pollMs: 100,
      })
      await vi.advanceTimersByTimeAsync(3100)
      expect(await pending).toBe(false)
      expect(retry).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * Gemeten 03-11-2026, team ee1b35b0: glm-1 kreeg de prompt binnen, ging aan
   * het werk, en kreeg hem na 20s en na 40s nog twee keer in de pane geplakt
   * omdat hij nog niets had gezegd. Zijn eerste bericht kwam pas na 2m40s, en
   * de launcher noemde de start toen mislukt. Een agent die zichtbaar bezig is,
   * krijgt zijn prompt dus niet opnieuw.
   */
  it('plakt niets opnieuw zolang de pane verandert', async () => {
    vi.useFakeTimers()
    try {
      const retry = vi.fn(async () => {})
      const busy = vi.fn(async () => true)
      const pending = confirmPromptStart({
        hasStarted: () => false, retry, busy,
        waitMs: 1000, pollMs: 100, maxTotalMs: 5000,
      })
      await vi.advanceTimersByTimeAsync(6000)
      expect(await pending).toBe(false)
      expect(retry).not.toHaveBeenCalled()
      expect(busy).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('plakt wel opnieuw als de pane stil blijft staan', async () => {
    vi.useFakeTimers()
    try {
      const retry = vi.fn(async () => {})
      const pending = confirmPromptStart({
        hasStarted: () => false, retry, busy: async () => false,
        waitMs: 1000, pollMs: 100,
      })
      await vi.advanceTimersByTimeAsync(3100)
      expect(await pending).toBe(false)
      expect(retry).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stopt met wachten zodra de agent wel praat, ook als hij bezig leek', async () => {
    vi.useFakeTimers()
    try {
      let gesproken = false
      const pending = confirmPromptStart({
        hasStarted: () => gesproken, retry: async () => {}, busy: async () => true,
        waitMs: 1000, pollMs: 100, maxTotalMs: 10_000,
      })
      await vi.advanceTimersByTimeAsync(2500)
      gesproken = true
      await vi.advanceTimersByTimeAsync(300)
      expect(await pending).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
