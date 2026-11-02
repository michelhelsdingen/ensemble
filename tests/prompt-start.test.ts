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
})
