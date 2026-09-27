import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { escapeTmuxArg, parseKeyTokens, TmuxRuntime } from '../lib/agent-runtime'

const HAS_TMUX = (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe('escapeTmuxArg and parseKeyTokens unit tests', () => {
  it('escapes trailing semicolon for tmux argument parser', () => {
    expect(escapeTmuxArg(';')).toBe('\\;')
    expect(escapeTmuxArg('abc;')).toBe('abc\\;')
    expect(escapeTmuxArg('a;;')).toBe('a;\\;')
    expect(escapeTmuxArg('\\;')).toBe('\\\\;')
    expect(escapeTmuxArg('hello')).toBe('hello')
    expect(escapeTmuxArg('a; b')).toBe('a; b')
  })

  it('tokenizes non-literal key sequences and strips double quotes', () => {
    expect(parseKeyTokens('C-c')).toEqual(['C-c'])
    expect(parseKeyTokens('"exit"')).toEqual(['exit'])
    expect(parseKeyTokens('exit Enter')).toEqual(['exit', 'Enter'])
    expect(parseKeyTokens('a "b c" d')).toEqual(['a', 'b c', 'd'])
  })

  it('rejects unsafe non-literal key sequences and unbalanced quotes', () => {
    expect(() => parseKeyTokens('exit; rm -rf /')).toThrow('Unsafe tmux key sequence')
    expect(() => parseKeyTokens('$(touch /tmp/x)')).toThrow('Unsafe tmux key sequence')
    expect(() => parseKeyTokens('`id`')).toThrow('Unsafe tmux key sequence')
    expect(() => parseKeyTokens('"unbalanced')).toThrow('Unbalanced quotes')
  })
})

describe.skipIf(!HAS_TMUX)('TmuxRuntime injection safety (echte tmux op private socket)', () => {
  const socketDir = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'ens-inj-'))
  const socket = path.join(socketDir, 'tmux.sock')
  const markerFile = path.join(socketDir, 'should-never-exist')
  const oldTmux = process.env.TMUX
  let runtime: TmuxRuntime
  let n = 0

  const tmux = (...args: string[]) => execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8' })

  beforeAll(() => {
    const binDir = path.join(socketDir, 'bin')
    fs.mkdirSync(binDir)
    const real = execFileSync('/bin/sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim()
    fs.writeFileSync(binDir + '/tmux', `#!/bin/sh\nexec "${real}" -S "${socket}" "$@"\n`, { mode: 0o755 })
    process.env.PATH = `${binDir}:${process.env.PATH}`
    delete process.env.TMUX
    runtime = new TmuxRuntime()
  })

  afterEach(() => {
    try {
      tmux('kill-server')
    } catch {
      // Server already stopped
    }
    if (fs.existsSync(markerFile)) {
      fs.unlinkSync(markerFile)
    }
  })

  afterAll(() => {
    process.env.PATH = (process.env.PATH ?? '').split(':').slice(1).join(':')
    if (oldTmux !== undefined) process.env.TMUX = oldTmux
    fs.rmSync(socketDir, { recursive: true, force: true })
  })

  const newCatSession = (outPath: string): string => {
    const name = `test-inj-${process.pid}-${n++}`
    tmux('new-session', '-d', '-s', name, '-x', '200', '-y', '50', `exec cat > '${outPath}'`)
    return name
  }

  const waitFor = async (pred: () => boolean, ms = 3000) => {
    const start = Date.now()
    while (Date.now() - start < ms) {
      if (pred()) return
      await new Promise(r => setTimeout(r, 50))
    }
  }

  it('geeft gevaarlijke shell-metatekens letterlijk door en voert niets uit via sendKeys', async () => {
    const out = path.join(socketDir, `out-keys-${n}.txt`)
    const name = newCatSession(out)
    await waitFor(() => tmux('display-message', '-p', '-t', name, '#{pane_current_command}').trim() === 'cat')

    const dangerousText = `$(touch '${markerFile}') && \`touch '${markerFile}'\` ; touch '${markerFile}' ; ' " \${HOME}`
    await runtime.sendKeys(name, dangerousText, { literal: true, enter: true, agentInput: false })

    await waitFor(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').includes('${HOME}'))

    expect(fs.existsSync(markerFile)).toBe(false)
    const delivered = fs.readFileSync(out, 'utf8')
    expect(delivered).toContain(dangerousText)
    expect(delivered.trim()).toBe(dangerousText)
  })

  it('geeft lastige tmux-karakters (; abc; \\; -n) letterlijk door via sendKeys', async () => {
    const out = path.join(socketDir, `out-semicolons-${n}.txt`)
    const name = newCatSession(out)
    await waitFor(() => tmux('display-message', '-p', '-t', name, '#{pane_current_command}').trim() === 'cat')

    const samples = [';', 'abc;', '\\;', '\\\\;', 'a;;', '-n', 'a; b']
    for (const sample of samples) {
      await runtime.sendKeys(name, sample, { literal: true, enter: true, agentInput: false })
    }

    await waitFor(() => {
      if (!fs.existsSync(out)) return false
      const content = fs.readFileSync(out, 'utf8')
      return samples.every(s => content.includes(s))
    })

    const delivered = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean)
    for (const sample of samples) {
      expect(delivered).toContain(sample)
    }
  })

  it('geeft gevaarlijke bestandsinhoud via pasteFromFile met gevaarlijke bestandsnaam letterlijk door', async () => {
    const out = path.join(socketDir, `out-paste-${n}.txt`)
    const name = newCatSession(out)
    await waitFor(() => tmux('display-message', '-p', '-t', name, '#{pane_current_command}').trim() === 'cat')

    const dangerousPrompt = `$(touch '${markerFile}')\n\`touch '${markerFile}'\`\n; touch '${markerFile}'\n' "" && ||`
    const promptFile = path.join(socketDir, 'danger "quote" path;')
    fs.writeFileSync(promptFile, dangerousPrompt)

    await runtime.pasteFromFile(name, promptFile)

    await waitFor(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').includes('&& ||'))

    expect(fs.existsSync(markerFile)).toBe(false)
    const delivered = fs.readFileSync(out, 'utf8')
    expect(delivered).toContain(dangerousPrompt)
  })

  it('stelt omgevingsvariabelen met shell-metatekens en puntkomma veilig in', async () => {
    const out = path.join(socketDir, `out-env-${n}.txt`)
    const name = newCatSession(out)
    await waitFor(() => tmux('display-message', '-p', '-t', name, '#{pane_current_command}').trim() === 'cat')

    const val1 = `$(touch '${markerFile}'); "hello"; 'world'`
    const val2 = 'trailing;'
    await runtime.setEnvironment(name, 'TEST_VAR1', val1)
    await runtime.setEnvironment(name, 'TEST_VAR2', val2)

    expect(fs.existsSync(markerFile)).toBe(false)

    const check1 = tmux('show-environment', '-t', name, 'TEST_VAR1').trim()
    expect(check1).toBe(`TEST_VAR1=${val1}`)

    const check2 = tmux('show-environment', '-t', name, 'TEST_VAR2').trim()
    expect(check2).toBe(`TEST_VAR2=${val2}`)

    await runtime.unsetEnvironment(name, 'TEST_VAR1')
    const checkUnset = tmux('show-environment', '-t', name)
    expect(checkUnset).not.toContain('TEST_VAR1=')
  })

  it('capturePane leest output veilig uit pane met metatekens', async () => {
    const out = path.join(socketDir, `out-cap-${n}.txt`)
    const name = newCatSession(out)
    await waitFor(() => tmux('display-message', '-p', '-t', name, '#{pane_current_command}').trim() === 'cat')

    await runtime.sendKeys(name, 'line-with-metachars: $() ``;', { literal: true, enter: true })
    await waitFor(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').includes('line-with-metachars'))

    const captured = await runtime.capturePane(name, 50)
    expect(captured).toContain('line-with-metachars: $() ``;')
  })

  it('rawName met gevaarlijke shell-metatekens via createSession, sessionExists, getWorkingDirectory, renameSession, sendKeys en killSession', async () => {
    const rawName = `inj-$(touch '${markerFile}');\`touch '${markerFile}'\`;'"`
    const expectedSanitized = rawName.replace(/[^a-zA-Z0-9\-_.]/g, '')

    // createSession with rawName
    await runtime.createSession(rawName, socketDir)
    expect(fs.existsSync(markerFile)).toBe(false)
    expect(await runtime.sessionExists(rawName)).toBe(true)
    expect(await runtime.sessionExists(expectedSanitized)).toBe(true)

    // Check exact name in listSessions (not prefix matched)
    const initialSessions = await runtime.listSessions()
    const initialNames = initialSessions.map(s => s.name)
    expect(initialNames).toContain(expectedSanitized)

    // getWorkingDirectory with rawName
    const cwd = await runtime.getWorkingDirectory(rawName)
    expect(cwd).toBeTruthy()
    expect(fs.existsSync(markerFile)).toBe(false)

    // sendKeys with rawName
    await runtime.sendKeys(rawName, 'echo test', { literal: true, enter: true })
    expect(fs.existsSync(markerFile)).toBe(false)

    // renameSession from rawName to another raw name with backticks, semicolons, quotes
    const rawRenameTarget = `renamed-$(touch '${markerFile}');\`touch '${markerFile}'\`;'"`
    const expectedRenameSanitized = rawRenameTarget.replace(/[^a-zA-Z0-9\-_.]/g, '')
    await runtime.renameSession(rawName, rawRenameTarget)
    expect(fs.existsSync(markerFile)).toBe(false)
    expect(await runtime.sessionExists(rawName)).toBe(false)
    expect(await runtime.sessionExists(rawRenameTarget)).toBe(true)

    const renamedSessions = await runtime.listSessions()
    const renamedNames = renamedSessions.map(s => s.name)
    expect(renamedNames).not.toContain(expectedSanitized)
    expect(renamedNames).toContain(expectedRenameSanitized)

    // killSession with raw target name
    await runtime.killSession(rawRenameTarget)
    expect(await runtime.sessionExists(rawRenameTarget)).toBe(false)
    expect(await runtime.sessionExists(expectedRenameSanitized)).toBe(false)

    const finalSessions = await runtime.listSessions()
    const finalNames = finalSessions.map(s => s.name)
    expect(finalNames).not.toContain(expectedRenameSanitized)
    expect(fs.existsSync(markerFile)).toBe(false)
  })
})
