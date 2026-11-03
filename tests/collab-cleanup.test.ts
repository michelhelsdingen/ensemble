/**
 * collab-cleanup.sh must also clear abandoned runtime directories.
 *
 * Until 2026-09 it only looked at directories with a .finished marker. A team
 * that never got going (the service wrote prompts, the launch then failed) or
 * a stray lock directory left no marker and stayed forever: on 2026-09-03 the
 * runtime root held 22 such directories next to 10 finished ones.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync, spawn, type ChildProcess } from 'child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const CLEANUP = path.resolve(process.cwd(), 'scripts/collab-cleanup.sh')
const PATHS = path.resolve(process.cwd(), 'scripts/collab-paths.sh')
// Process termination includes escalation polling and child exit delivery.
const PROCESS_STOP_TIMEOUT_MS = 15_000
const TWO_DAYS_AGO = new Date(Date.now() - 2 * 24 * 3600 * 1000)

function run(root: string, ...args: string[]): string {
  return execFileSync(CLEANUP, args, {
    env: { ...process.env, COLLAB_RUNTIME_ROOT: root, PATH: `${mockBin}:${process.env.PATH}`, CURL_CALLS: path.join(root, 'curl-calls') },
    encoding: 'utf8',
  })
}

let mockBin: string

// stop_team_processes rechtstreeks aanroepen, los van cleanup.sh, zodat de
// escalatie- en pid-hergebruiktests niet ook nog aan de leeftijds- en
// eligibility-regels van cleanup hoeven te voldoen.
function stopTeamProcesses(dir: string): void {
  execFileSync('bash', ['-c', `. "${PATHS}" && stop_team_processes "$1"`, '_', dir], { encoding: 'utf8' })
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

// Wacht op het echte exit-event van het kindproces in plaats van meteen met
// kill(pid, 0) te checken. Een net gekild proces is heel even nog een zombie
// in de procestabel (pas weg zodra Node hem reapt via de event loop), dus een
// controle direct na een synchrone execFileSync-aanroep zag hem soms nog als
// "levend" terwijl hij al dood was. Dit wacht op het signaal dat Node zelf
// gebruikt om te weten dat een kind echt weg is.
function waitDead(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(true); return }
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once('exit', () => { clearTimeout(timer); resolve(true) })
  })
}

// Een geloofwaardig nepproces met de verwachte scriptnaam in zijn commandoregel,
// zodat stop_team_processes' identiteitscheck (ps -o command=) hem herkent
// zoals hij een echte ensemble-bridge.sh/collab-poller.sh zou herkennen.
function spawnFakeProcess(dir: string, scriptName: string, body: string) {
  const scriptPath = path.join(dir, scriptName)
  fs.writeFileSync(scriptPath, `#!/bin/sh\n${body}\n`)
  fs.chmodSync(scriptPath, 0o755)
  return spawn(scriptPath, [], { detached: true, stdio: 'ignore' })
}

function makeDir(root: string, name: string, files: Record<string, string>, old: boolean): string {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), content)
  }
  if (old) ageEverything(dir)
  return dir
}

/** Set an old mtime on a directory and everything below it, subdirectories included. */
function ageEverything(entry: string): void {
  if (fs.statSync(entry).isDirectory()) {
    for (const child of fs.readdirSync(entry)) ageEverything(path.join(entry, child))
  }
  fs.utimesSync(entry, TWO_DAYS_AGO, TWO_DAYS_AGO)
}

describe('collab-cleanup.sh abandoned directories', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-cleanup-'))
    mockBin = path.join(root, 'bin')
    fs.mkdirSync(mockBin)
    fs.writeFileSync(path.join(mockBin, 'curl'), [
      '#!/bin/sh',
      'if [ -n "${CURL_CALLS:-}" ]; then printf \'%s\\n\' "$*" >> "$CURL_CALLS"; fi',
      'if [ -n "${CURL_REPLY:-}" ]; then printf \'%s\\n\' "$CURL_REPLY"; else printf \'%s\\n\' \'{"team":{"status":"disbanded"}}\'; fi',
      'printf \'\\n%s\' "${CURL_HTTP_CODE:-200}"',
    ].join('\n'), { mode: 0o755 })
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('removes an old directory that never produced messages', () => {
    const dir = makeDir(root, 'never-started', { 'prompts/codex-1.txt': 'x' }, true)
    run(root, '--force')
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('removes an old directory holding only a lock file', () => {
    const dir = makeDir(root, 'team-say-lock', { 'messages.jsonl.lock': '' }, true)
    run(root, '--force')
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('keeps a fresh directory without messages, the team may still be starting', () => {
    const dir = makeDir(root, 'starting', { 'prompts/codex-1.txt': 'x' }, false)
    run(root, '--force')
    expect(fs.existsSync(dir)).toBe(true)
  })

  it.each(['forming', 'active'])('behoudt een oud team als de service status %s meldt', status => {
    const dir = makeDir(root, 'team-active', { 'messages.jsonl': '{}\n' }, true)
    const calls = path.join(root, 'curl-calls')
    const output = execFileSync(CLEANUP, ['--force'], {
      env: {
        ...process.env,
        COLLAB_RUNTIME_ROOT: root,
        PATH: `${mockBin}:${process.env.PATH}`,
        CURL_CALLS: calls,
        CURL_REPLY: `{"team":{"id":"team-active","status":"${status}"}}`,
      },
      encoding: 'utf8',
    })
    expect(fs.existsSync(dir)).toBe(true)
    expect(output).toContain(`team heeft status ${status}`)
    expect(fs.readFileSync(calls, 'utf8')).toContain('http://localhost:23000/api/ensemble/teams/team-active')
  })

  it('behoudt een onaf team als de service niet bereikbaar is', () => {
    const dir = makeDir(root, 'team-offline', { 'messages.jsonl': '{}\n' }, true)
    const calls = path.join(root, 'curl-calls')
    fs.writeFileSync(path.join(mockBin, 'curl'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$CURL_CALLS"\nexit 7\n', { mode: 0o755 })
    execFileSync(CLEANUP, ['--force'], {
      env: { ...process.env, COLLAB_RUNTIME_ROOT: root, PATH: `${mockBin}:${process.env.PATH}`, CURL_CALLS: calls },
      encoding: 'utf8',
    })
    expect(fs.existsSync(dir)).toBe(true)
  })

  it('verwijdert een onaf team dat de bereikbare service niet meer kent', () => {
    const dir = makeDir(root, 'team-gone', { 'messages.jsonl': '{}\n' }, true)
    execFileSync(CLEANUP, ['--force'], {
      env: {
        ...process.env,
        COLLAB_RUNTIME_ROOT: root,
        PATH: `${mockBin}:${process.env.PATH}`,
        CURL_CALLS: path.join(root, 'curl-calls'),
        CURL_HTTP_CODE: '404',
      },
      encoding: 'utf8',
    })
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('removes an old unfinished directory with messages once its processes are dead', () => {
    // Dit was eerder het gedrag "keeps an old unfinished directory that has
    // messages": precies de reden dat 28 van de 47 runtime-mappen bleven
    // staan. Zonder .finished en zonder een levend bridge/poller-proces is
    // zo'n map niet meer "misschien nog bezig", maar gewoon verlaten.
    const dir = makeDir(root, 'long-runner', { 'messages.jsonl': '{"from":"codex-1"}\n' }, true)
    run(root, '--force')
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('stopt het bridge- en poller-proces voordat de map verdwijnt', async () => {
    const dir = makeDir(root, 'team-live', { 'messages.jsonl': '{}\n' }, true)
    const bridge = spawnFakeProcess(dir, 'ensemble-bridge.sh', 'sleep 30')
    const poller = spawnFakeProcess(dir, 'collab-poller.sh', 'sleep 30')
    fs.writeFileSync(path.join(dir, 'bridge.pid'), String(bridge.pid))
    fs.writeFileSync(path.join(dir, 'poller.pid'), String(poller.pid))
    // De scripts en pid-bestanden zijn zojuist geschreven en hebben dus een
    // verse mtime. newest_mtime() telt die mee, waardoor de map anders als
    // "net gestart" oogt in plaats van als de 2 dagen oude map die de test
    // simuleert. Opnieuw veroudering toepassen zodat de leeftijdsdrempel van
    // cleanup deze map ook echt als eligible ziet.
    ageEverything(dir)
    run(root, '--force')
    expect(await waitDead(bridge, 3000), 'bridge moet gestopt zijn').toBe(true)
    expect(await waitDead(poller, 3000), 'poller moet gestopt zijn').toBe(true)
  }, PROCESS_STOP_TIMEOUT_MS)

  it('escaleert naar KILL als het proces SIGTERM negeert', async () => {
    const dir = path.join(root, 'team-stubborn')
    fs.mkdirSync(dir, { recursive: true })
    const bridge = spawnFakeProcess(dir, 'ensemble-bridge.sh', 'trap "" TERM\nwhile true; do sleep 1; done')
    fs.writeFileSync(path.join(dir, 'bridge.pid'), String(bridge.pid))
    stopTeamProcesses(dir)
    expect(await waitDead(bridge, 3000), 'een proces dat TERM negeert moet alsnog gekilld worden').toBe(true)
  }, PROCESS_STOP_TIMEOUT_MS)

  it('killt geen proces waarvan de pid inmiddels iets anders is', () => {
    // Een pid-bestand van dagen oud kan naar een heel ander proces wijzen: het
    // besturingssysteem hergebruikt pids. stop_team_processes controleert de
    // commandoregel voor het schiet, dus dit proces overleeft.
    const dir = path.join(root, 'team-reused-pid')
    fs.mkdirSync(dir, { recursive: true })
    const unrelated = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    fs.writeFileSync(path.join(dir, 'bridge.pid'), String(unrelated.pid))
    try {
      stopTeamProcesses(dir)
      expect(isAlive(unrelated.pid!), 'een niet-bridge-proces mag niet gekilld worden').toBe(true)
      expect(fs.existsSync(path.join(dir, 'bridge.pid'))).toBe(false)
    } finally {
      unrelated.kill('SIGKILL')
    }
  })

  it('stopt een bridge zonder pid-bestand via zijn commandoregel', async () => {
    // Simuleert de wees die op de machine draaide: de oude trap deed
    // `rm -f "$PID_FILE"` op elk signaal zonder ooit te exit'en, dus een kill
    // van vóór taak 10 ruimde het pid-bestand op en liet het proces leven.
    // Zonder pid-bestand moet stop_team_processes het toch vinden, via de
    // commandoregel: ensemble-bridge.sh <team-id> <url>, zoals het script
    // echt wordt aangeroepen.
    const dir = path.join(root, 'team-orphan')
    fs.mkdirSync(dir, { recursive: true })
    const scriptPath = path.join(dir, 'ensemble-bridge.sh')
    fs.writeFileSync(scriptPath, '#!/bin/sh\nsleep 30\n')
    fs.chmodSync(scriptPath, 0o755)
    const bridge = spawn(scriptPath, ['team-orphan', 'http://localhost:23000'], { detached: true, stdio: 'ignore' })
    try {
      stopTeamProcesses(dir)
      expect(await waitDead(bridge, 3000), 'bridge zonder pid-bestand moet toch gestopt worden').toBe(true)
    } finally {
      bridge.kill('SIGKILL')
    }
  }, PROCESS_STOP_TIMEOUT_MS)

  it('laat een proces van een ander team met rust, ook zonder pid-bestand', async () => {
    const dir = path.join(root, 'team-orphan-2')
    fs.mkdirSync(dir, { recursive: true })
    const scriptPath = path.join(dir, 'ensemble-bridge.sh')
    fs.writeFileSync(scriptPath, '#!/bin/sh\nsleep 30\n')
    fs.chmodSync(scriptPath, 0o755)
    // Zelfde scriptnaam, maar een ander team-id in de commandoregel: dit
    // proces hoort niet bij "team-orphan-2" en mag niet worden aangeraakt.
    const ander = spawn(scriptPath, ['een-ander-team', 'http://localhost:23000'], { detached: true, stdio: 'ignore' })
    try {
      stopTeamProcesses(dir)
      expect(await waitDead(ander, 500), 'een proces van een ander team mag niet gestopt worden').toBe(false)
    } finally {
      ander.kill('SIGKILL')
    }
  })

  it('finishes with stats when there is nothing abandoned (empty array, bash 3.2)', () => {
    makeDir(root, 'done', { 'messages.jsonl': '{}\n', '.finished': 't' }, true)
    const out = run(root, '--force')
    expect(out).toContain('Stats')
  })

  it('finishes with stats when there is nothing finished', () => {
    makeDir(root, 'never-started', { 'prompts/codex-1.txt': 'x' }, true)
    const out = run(root, '--force')
    expect(out).toContain('Stats')
  })

  it('only reports in dry-run mode', () => {
    const dir = makeDir(root, 'never-started', { 'prompts/codex-1.txt': 'x' }, true)
    const out = run(root)
    expect(fs.existsSync(dir)).toBe(true)
    expect(out).toContain('never-started')
  })
})
