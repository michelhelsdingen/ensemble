import { beforeEach, describe, expect, it, vi } from 'vitest'

// pasteFromFile praat rechtstreeks met child_process.execFile (via promisify) en
// heeft geen eigen naad om een exec-functie in te spuiten. child_process wordt
// hier dus als module gemockt, zodat tmux-commando's onderschept kunnen worden
// zonder dat er een echte tmux-server nodig is. vi.hoisted is nodig omdat
// vi.mock naar de top van het bestand wordt gehesen, voor deze declaraties.
const { execFileMock, callLog, customHandler } = vi.hoisted(() => {
  const callLog: string[] = []
  const customHandler = { fn: null as ((cmd: string, args: unknown[]) => Error | null) | null }
  const execFileMock = vi.fn((...args: unknown[]) => {
    const file = args[0] as string
    const argv = Array.isArray(args[1]) ? (args[1] as string[]) : []
    const cmd = [file, ...argv].join(' ')
    const callback = args[args.length - 1] as (err: Error | null, stdout?: string, stderr?: string) => void
    callLog.push(cmd)

    if (customHandler.fn) {
      const err = customHandler.fn(cmd, args)
      if (err) {
        callback(err)
        return
      }
    } else {
      const sendKeysSoFar = callLog.filter(c => c.includes('send-keys')).length
      // Alleen de TWEEDE Enter faalt, precies het scenario uit meting #90: de
      // paste zelf en de eerste Enter lukken.
      if (cmd.includes('send-keys') && sendKeysSoFar === 2) {
        callback(new Error('tmux busy'))
        return
      }
    }
    callback(null, '', '')
  })
  return { execFileMock, callLog, customHandler }
})

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execFile: execFileMock,
  execFileSync: vi.fn(),
}))

import { TmuxRuntime } from '../lib/agent-runtime'

describe('pasteFromFile', () => {
  beforeEach(() => {
    callLog.length = 0
    customHandler.fn = null
    execFileMock.mockClear()
    vi.restoreAllMocks()
  })

  it('plakt niet opnieuw als alleen de tweede Enter faalt', async () => {
    const runtime = new TmuxRuntime()
    await runtime.pasteFromFile('sess', '/tmp/x.txt')
    const pasteCalls = callLog.filter(c => c.includes('paste-buffer'))
    expect(pasteCalls.length).toBe(1)
  })

  it('faalt en verstuurt geen Enters als load/paste blijft falen', async () => {
    customHandler.fn = cmd => (cmd.includes('load-buffer') ? new Error('file not found') : null)
    const runtime = new TmuxRuntime()
    await expect(runtime.pasteFromFile('sess', '/tmp/x.txt')).rejects.toThrow('file not found')
    const pasteCalls = callLog.filter(c => c.includes('paste-buffer'))
    expect(pasteCalls.length).toBe(3)
    const sendKeysCalls = callLog.filter(c => c.includes('send-keys'))
    expect(sendKeysCalls.length).toBe(0)
  })

  it('slaagt en plakt eenmaal als delete-buffer faalt in finally', async () => {
    customHandler.fn = cmd => (cmd.includes('delete-buffer') ? new Error('no such buffer') : null)
    const runtime = new TmuxRuntime()
    await runtime.pasteFromFile('sess', '/tmp/x.txt')
    const pasteCalls = callLog.filter(c => c.includes('paste-buffer'))
    expect(pasteCalls.length).toBe(1)
    const sendKeysCalls = callLog.filter(c => c.includes('send-keys'))
    expect(sendKeysCalls.length).toBe(2)
  })

  /**
   * De wachttijd voor de Enter was een klok: 1 seconde, en voor codex 5. Die 5
   * kwam uit de aanname "sommige TUI's
   * hebben meer tijd nodig", niet uit een meting, en kostte elke teamstart met
   * codex erin ruim vijf seconden. Het is nu een conditie met diezelfde tijd
   * als bovengrens: zodra de pane de paste toont, mag de Enter.
   */
  it('stuurt Enter zodra de pane de paste toont', async () => {
    vi.useFakeTimers()
    try {
      customHandler.fn = () => null
      const runtime = new TmuxRuntime()
      let beeld = '> leeg invoerveld'
      vi.spyOn(runtime, 'capturePane').mockImplementation(async () => beeld)
      const delivery = runtime.pasteFromFile('sess', '/tmp/x.txt', 5000)
      await vi.advanceTimersByTimeAsync(200)
      expect(callLog.filter(c => c.includes('send-keys'))).toHaveLength(0)
      beeld = '> de geplakte opdracht staat in het invoerveld'
      await vi.advanceTimersByTimeAsync(400)
      expect(callLog.filter(c => c.includes('send-keys')).length).toBeGreaterThan(0)
      await vi.advanceTimersByTimeAsync(400)
      await delivery
      expect(callLog.filter(c => c.includes('send-keys'))).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('wacht nooit langer dan de opgegeven tijd, ook als de pane niets laat zien', async () => {
    vi.useFakeTimers()
    try {
      customHandler.fn = () => null
      const runtime = new TmuxRuntime()
      vi.spyOn(runtime, 'capturePane').mockImplementation(async () => '> leeg invoerveld')
      const delivery = runtime.pasteFromFile('sess', '/tmp/x.txt', 2000)
      await vi.advanceTimersByTimeAsync(1900)
      expect(callLog.filter(c => c.includes('send-keys'))).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(500)
      await delivery
      expect(callLog.filter(c => c.includes('send-keys'))).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stuurt de Enter ook als de pane niet te lezen is', async () => {
    vi.useFakeTimers()
    try {
      customHandler.fn = () => null
      const runtime = new TmuxRuntime()
      vi.spyOn(runtime, 'capturePane').mockRejectedValue(new Error('geen pane'))
      const delivery = runtime.pasteFromFile('sess', '/tmp/x.txt', 1000)
      await vi.advanceTimersByTimeAsync(1500)
      await delivery
      expect(callLog.filter(c => c.includes('send-keys'))).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
