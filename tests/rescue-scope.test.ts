import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const RESCUE = path.resolve(process.cwd(), 'scripts/collab-rescue.sh')

let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-rescue-')) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

function run(args: string[], extraEnv: Record<string, string> = {}): { out: string; code: number } {
  try {
    const out = execFileSync(RESCUE, args, {
      env: { ...process.env, COLLAB_RUNTIME_ROOT: root, ...extraEnv },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { out, code: 0 }
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; status?: number }
    return { out: `${error.stdout ?? ''}${error.stderr ?? ''}`, code: error.status ?? 1 }
  }
}

function makeTeam(id: string, sessions: string[], prompts: Record<string, string>): void {
  const dir = path.join(root, id)
  fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'sessions'), sessions.map(s => `${s}\n`).join(''))
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), '')
  for (const [agentName, content] of Object.entries(prompts)) {
    fs.writeFileSync(path.join(dir, 'prompts', `${agentName}.txt`), content)
  }
}

describe('rescue scope', () => {
  it('gebruikt het sessieregister, niet een tmux-scan op de vorm van de sessienaam', () => {
    const src = fs.readFileSync(RESCUE, 'utf8')
    expect(src).toMatch(/\$RD\/sessions/)
    expect(src).not.toMatch(/tmux ls .*grep -oE 'collab-/)
    expect(src).not.toMatch(/-codex-1/)
  })

  it('weigert met een kloppende melding als het sessieregister ontbreekt', () => {
    // team-dir bestaat wel (anders triggert een eerdere, andere check), maar
    // heeft geen sessions-bestand: precies het geval van een team dat niet
    // via deze launcher is gestart (of van vóór taak 2).
    fs.mkdirSync(path.join(root, 'team-zonder-register', 'prompts'), { recursive: true })
    const { out, code } = run(['team-zonder-register'])
    expect(out).toMatch(/geen sessieregister voor team-zonder-register; dit team is niet door deze launcher gestart/)
    expect(code).not.toBe(0)
  })

  // Dit is precies meting #90: een claude-only team, zonder codex-sessie. De
  // oude code zocht altijd naar "<x>-codex-1" en vond dat team dus nooit. De
  // teamnaam bevat hier bovendien cijfers en koppeltekens (zoals een echte
  // "collab-<epoch>-<random>"-naam), om te bewijzen dat de matching niet op
  // de vorm van de teamnaam leunt.
  it('vindt een claude-only team en koppelt de juiste sessie aan het juiste promptbestand', () => {
    makeTeam('team-claude-only', ['collab-9-9-claude-1'], { 'claude-1': 'hoi' })
    const { out } = run(['team-claude-only'])
    expect(out).not.toMatch(/geen actieve tmux collab-sessie gevonden/i)
    // AGENT_NAME moet de volledige agentnaam zijn ("claude-1"), niet alleen het
    // stukje na de laatste streep ("1"): anders schakelt dit ook de
    // claude-detectie in deliver_to_session (regel 98) stilletjes uit.
    expect(out).toMatch(/claude-1: tmux sessie 'collab-9-9-claude-1' bestaat niet/)
  })

  it('slaat een sessie zonder promptbestand netjes over, zonder verkeerd te matchen', () => {
    makeTeam('team-mismatch', ['collab-1-1-codex-1'], { 'claude-1': 'hoi' })
    // Geen enkele sessie kan hier matchen, dus de lus doet niets, geen
    // deliver_to_session breekt de set -e vroegtijdig af, en het script loopt
    // door tot de eind-verificatie met zijn ingebouwde "sleep 10".
    const { out } = run(['team-mismatch'])
    expect(out).toMatch(/collab-1-1-codex-1: geen promptbestand voor deze sessie gevonden, overgeslagen/)
    expect(out).not.toMatch(/tmux sessie 'collab-1-1-codex-1' bestaat niet/)
  }, 15000)

  it('meldt geen succes als tmux de prompt accepteert maar de agent niet reageert', () => {
    makeTeam('team-stil', ['team-stil-codex-1', 'team-stil-agy-2'], {
      'codex-1': 'prompt', 'agy-2': 'prompt',
    })
    fs.writeFileSync(path.join(root, 'team-stil', 'messages.jsonl'), '{"from":"agy-2","content":"working"}\n')
    const bin = path.join(root, 'bin')
    fs.mkdirSync(bin)
    const tmux = path.join(bin, 'tmux')
    fs.writeFileSync(tmux, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_TMUX_LOG"\n')
    fs.chmodSync(tmux, 0o755)
    const sleep = path.join(bin, 'sleep')
    fs.writeFileSync(sleep, '#!/bin/sh\nexit 0\n')
    fs.chmodSync(sleep, 0o755)
    const log = path.join(root, 'tmux.log')

    const { out, code } = run(['team-stil', 'codex-1'], {
      PATH: `${bin}:${process.env.PATH}`, TEST_TMUX_LOG: log,
    })

    expect(code).not.toBe(0)
    // De melding heette "NIET bevestigd na maximaal 3 pogingen" toen rescue de
    // prompt drie keer herplakte. Nu stopt hij bij de eerste pane die niets
    // aanneemt; de strekking (geen succes, en de andere agent blijft ongemoeid)
    // is dezelfde.
    expect(out).toMatch(/codex-1: prompt NIET afgeleverd|codex-1: NIET bevestigd/)
    expect(out).not.toContain('prompt afgeleverd\n')
    expect(fs.readFileSync(log, 'utf8')).not.toContain('team-stil-agy-2')
  })
})

/**
 * De herstelroute zelf, gevonden door het reviewteam van 03-11-2026 (team
 * 40d536c0) en nagemeten: `collab-rescue.sh <team-id>` zonder agentnamen is de
 * gedocumenteerde standaardvorm en precies wat de launcher en de postcheck
 * aanraden, en die vorm crashte op `REQUESTED_AGENTS[@]: unbound variable`
 * (bash 3.2.57 is /bin/bash op deze machine). De bestaande tests riepen rescue
 * wel zonder namen aan maar keken niet naar de exitcode, dus de crash bleef
 * jaren groen.
 */
describe('rescue in zijn standaardvorm', () => {
  /**
   * Nep-tmux dat zich gedraagt als een echte pane: het beeld verandert zodra er
   * een paste is geweest (tenzij reageertOpPaste uit staat, voor een pane die
   * de invoer nergens laat landen). Een stub die het beeld op het AANTAL
   * aanroepen baseert, meet niets: pane-ready.ts doet zelf ook een capture, dus
   * dan lijkt de pane al veranderd voordat er geplakt is.
   */
  function nepTmux(bin: string, log: string, reageertOpPaste = true): void {
    fs.mkdirSync(bin, { recursive: true })
    const marker = '\u276f'
    fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$1" in
  capture-pane)
    if ${reageertOpPaste ? 'true' : 'false'} && grep -q paste-buffer "${log}" 2>/dev/null; then
      printf '%s\\n' "${marker} de prompt is binnen, aan het werk"
    else
      printf '%s\\n' "${marker} leeg invoerveld"
    fi
    ;;
  has-session) exit 0 ;;
esac
exit 0
`, { mode: 0o755 })
    fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  }

  it('loopt zonder agentnamen netjes af in plaats van te crashen', () => {
    makeTeam('team-standaard', ['team-standaard-glm-1'], { 'glm-1': 'prompt' })
    const bin = path.join(root, 'bin')
    const log = path.join(root, 'tmux.log')
    nepTmux(bin, log)
    const { out } = run(['team-standaard'], { PATH: `${bin}:${process.env.PATH}`, TEST_TMUX_LOG: log })
    expect(out).not.toMatch(/unbound variable/)
  }, 30_000)

  it('plakt niet opnieuw als de pane de prompt heeft aangenomen', () => {
    makeTeam('team-aangenomen', ['team-aangenomen-grok-1'], { 'grok-1': 'prompt' })
    const bin = path.join(root, 'bin')
    const log = path.join(root, 'tmux.log')
    nepTmux(bin, log)
    const { out, code } = run(['team-aangenomen'], { PATH: `${bin}:${process.env.PATH}`, TEST_TMUX_LOG: log })
    const pastes = fs.readFileSync(log, 'utf8').split('\n').filter(regel => regel.startsWith('paste-buffer'))
    expect(pastes.length).toBe(1)
    expect(out).toMatch(/aangenomen|aangekomen/i)
    expect(out).not.toMatch(/NIET afgeleverd/)
    expect(code).toBe(0)
  }, 30_000)

  it('meldt het wel als een gereede pane niets aanneemt', () => {
    makeTeam('team-dood', ['team-dood-glm-1'], { 'glm-1': 'prompt' })
    const bin = path.join(root, 'bin')
    const log = path.join(root, 'tmux.log')
    nepTmux(bin, log, false)
    const { out, code } = run(['team-dood'], { PATH: `${bin}:${process.env.PATH}`, TEST_TMUX_LOG: log })
    expect(out).toMatch(/niets aangenomen/i)
    expect(code).not.toBe(0)
  }, 30_000)
})
