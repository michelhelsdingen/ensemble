/**
 * Opruimen en afronden van de browserfeed.
 *
 * - De harde bovengrens van de feedserver is 6 uur (was 24).
 * - collab-orphans.sh ruimt ook een feed op van een team zonder .finished dat
 *   niet meer leeft; een levend team en een jonge feed blijven staan.
 * - Het paneel sluit niet vanzelf. De pagina blijft na afloop zelf werken: de
 *   laatste stand en de samenvatting blijven staan en de status zegt
 *   "Team afgerond, feed gestopt" in plaats van "Verbinding verbroken".
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import vm from 'vm'
import { spawnSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const repo = process.cwd()
const orphans = path.join(repo, 'scripts/collab-orphans.sh')

describe('feedserver', () => {
  it('heeft een harde bovengrens van 6 uur', () => {
    const bron = fs.readFileSync(path.join(repo, 'scripts/orca-webfeed-server.py'), 'utf8')
    expect(bron).toContain('"COLLAB_WEBFEED_MAX_SECONDS", "21600"')
    expect(bron).not.toContain('86400')
  })
})

describe('collab-orphans.sh en een feed zonder .finished', () => {
  let root: string
  let bin: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-wf-'))
    bin = path.join(root, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/bash\nexit 1\n', { mode: 0o755 })
    fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/bash\nprintf "%s" "$TEST_TEAMS"\n', { mode: 0o755 })
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const feed = (id: string, ageHours: number) => {
    const dir = path.join(root, 'runtime', id)
    fs.mkdirSync(dir, { recursive: true })
    const pid = path.join(dir, 'webfeed.pid')
    fs.writeFileSync(pid, '999999\n')
    const then = new Date(Date.now() - ageHours * 3600_000)
    fs.utimesSync(pid, then, then)
    return pid
  }
  const run = (teams: unknown[], args: string[] = ['--force']) => spawnSync('bash', [orphans, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, COLLAB_RUNTIME_ROOT: path.join(root, 'runtime'),
      ORCA_CLI_COMMAND: path.join(root, 'bestaat-niet'), TEST_TEAMS: JSON.stringify({ teams }),
    },
  })

  it('ruimt een oude feed zonder .finished op als het team niet meer leeft', () => {
    const pid = feed('team-dood', 3)
    const result = run([])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('webfeed gestopt: team-dood')
    expect(fs.existsSync(pid)).toBe(false)
  })

  it('laat de feed van een levend team staan', () => {
    const pid = feed('team-levend', 3)
    const result = run([{ id: 'team-levend', name: 'collab-1', status: 'active' }])
    expect(result.stdout).not.toContain('webfeed gestopt')
    expect(fs.existsSync(pid)).toBe(true)
  })

  it('laat een jonge feed staan, want dat team start misschien nu', () => {
    const pid = feed('team-jong', 0.1)
    const result = run([])
    expect(result.stdout).not.toContain('webfeed gestopt')
    expect(fs.existsSync(pid)).toBe(true)
  })

  it('doet zonder --force niets, behalve melden', () => {
    const pid = feed('team-dood', 3)
    const result = run([], [])
    expect(result.stdout).toContain('webfeed wees: team-dood')
    expect(fs.existsSync(pid)).toBe(true)
  })
})

describe('feedpagina na afloop', () => {
  type Node = {
    tag: string; id?: string; textContent: string; className: string; children: Node[]
    style: { setProperty: () => void }; append: (...n: Node[]) => void; replaceChildren: () => void
    querySelectorAll: (selector: string) => Node[]
  }
  const element = (tag: string, id?: string): Node => {
    const node: Node = {
      tag, id, textContent: '', className: '', children: [], style: { setProperty() {} },
      append(...n) { node.children.push(...n) },
      replaceChildren() { node.children = [] },
      querySelectorAll: selector => node.children.filter(c => c.tag === selector),
    }
    return node
  }

  /** Draait het script van de pagina met een nep-DOM en de opgegeven fetch-antwoorden. */
  async function runPage(answers: Array<string | Error>) {
    const html = fs.readFileSync(path.join(repo, 'scripts/orca-webfeed.html'), 'utf8')
    const script = html.match(/<script>([\s\S]*)<\/script>/)![1]
    const ids = new Map(['feed', 'count', 'status'].map(id => [id, element('div', id)]))
    const timers: Array<() => void> = []
    let calls = 0
    const context = {
      document: { body: { scrollHeight: 0 }, getElementById: (id: string) => ids.get(id), createElement: (tag: string) => element(tag) },
      window: { scrollTo() {} },
      fetch: async () => {
        const answer = answers[Math.min(calls++, answers.length - 1)]
        if (answer instanceof Error) throw answer
        return { ok: true, text: async () => answer }
      },
      setTimeout: (callback: () => void) => { timers.push(callback); return 0 },
      Date, Map, String, Error,
    }
    vm.runInNewContext(script, context)
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => setImmediate(resolve))
      const next = timers.shift()
      if (!next) break
      next()
    }
    await new Promise(resolve => setImmediate(resolve))
    return { feed: ids.get('feed')!, status: ids.get('status')!, pending: timers.length, calls }
  }

  const bericht = JSON.stringify({ from: 'codex-1', to: 'claude-2', timestamp: '2026-11-23T20:00:00Z', content: 'Hallo' })
  const einde = JSON.stringify({ type: 'webfeed-finished', summary: 'Alles klaar' })

  it('zegt "Team afgerond, feed gestopt", laat de samenvatting staan en vraagt niets meer op', async () => {
    const page = await runPage([`${bericht}\n${einde}\n`])
    expect(page.status.textContent).toBe('Team afgerond, feed gestopt')
    expect(page.feed.children.map(c => c.tag)).toEqual(['article', 'section'])
    expect(page.feed.children[1].textContent).toContain('Alles klaar')
    expect(page.calls).toBe(1)
    expect(page.pending).toBe(0)
  })

  it('blijft de laatste stand tonen als de feed wegvalt nadat er berichten waren', async () => {
    const page = await runPage([`${bericht}\n`, new Error('weg')])
    expect(page.status.textContent).toBe('Feed gestopt, laatste stand blijft staan')
    expect(page.feed.children.map(c => c.tag)).toEqual(['article'])
    expect(page.pending).toBe(0)
  })

  it('meldt een echte verbindingsfout zolang er nooit iets is binnengekomen', async () => {
    const page = await runPage([new Error('weg')])
    expect(page.status.textContent).toBe('Verbinding verbroken')
    expect(page.calls).toBeGreaterThan(3)
  })
})
