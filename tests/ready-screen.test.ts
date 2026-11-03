import { describe, expect, it } from 'vitest'
import { readyScreenState } from '../lib/ready-screen'

// Echte panes, gemeten op 03-11-2026 op deze machine met codex-cli 0.164.0 en
// Claude Code 2.1.317. Dit zijn de twee schermen waarop de service "ready"
// riep terwijl de CLI geen invoer aannam.

// codex 0.164.0 in een verse map: een modale hooks-dialoog. De selectiepijl is
// '›', precies het teken dat agents.json als readyMarker voor codex opgeeft.
const CODEX_HOOKS_DIALOOG = [
  '',
  '  Hooks need review',
  '  6 hooks are new or changed.',
  '  Hooks can run outside the sandbox after you trust them.',
  '',
  '',
  '› 1. Review hooks',
  '  2. Trust all and continue',
  "  3. Continue without trusting (hooks won't run)",
  '',
  '  enter confirm · esc skip',
].join('\n')

// Claude Code, een halve seconde na de start: de pane bevat nog alleen de
// shell. De zsh-prompt is '❯', precies de readyMarker voor claude.
const CLAUDE_SHELL_ECHO = [
  ' nocorrect unset CLAUDECODE; export ANTHROPIC_DEFAULT_MODEL=claude-example; claude --dangerously-skip-permissions',
  '    /tmp/ens-meet-Q7WaC7/work ░·······································░ at 12:00:00',
  '❯  nocorrect unset CLAUDECODE; export ANTHROPIC_DEFAULT_MODEL=claude-example; claude --dangerously-skip-permissions',
].join('\n')

// Dezelfde sessie, met de trustvraag eronder. Een bekende dialoog.
const CLAUDE_TRUST_NA_ECHO = [
  CLAUDE_SHELL_ECHO,
  '',
  '────────────────────────────────────────────────────────────────────────────',
  ' Accessing workspace:',
  ' /private/tmp/ens-meet-Q7WaC7/work',
  ' Quick safety check: Is this a project you created or one you trust?',
  " Claude Code'll be able to read, edit, and execute files here.",
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  ' Enter to confirm · Esc to cancel',
].join('\n')

// Claude Code die echt klaar is: de invoerregel staat onder het startcommando.
const CLAUDE_ECHT_GEREED = [
  CLAUDE_SHELL_ECHO,
  '',
  '❯ Try "fix typecheck errors"',
  '────────────────────────────────────────────────────────────────────────────',
  '  [Opus] │ work',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// codex die echt klaar is.
const CODEX_ECHT_GEREED = [
  ' nocorrect unset CLAUDECODE; codex --dangerously-bypass-approvals-and-sandbox --cd /tmp/w',
  '  >_ OpenAI Codex (v0.164.0)',
  '  model: gpt-6-astra',
  '',
  '› ',
  '  send q to quit',
].join('\n')

describe('readyScreenState', () => {
  it('noemt de codex hooks-dialoog geen gereedheid, ook al staat de readyMarker erin', () => {
    expect(CODEX_HOOKS_DIALOOG.includes('›')).toBe(true)
    const staat = readyScreenState(CODEX_HOOKS_DIALOOG, '›')
    expect(staat.state).toBe('blocked')
  })

  it('noemt de onbekende dialoog bij naam zodat de melding bruikbaar is', () => {
    const staat = readyScreenState(CODEX_HOOKS_DIALOOG, '›')
    if (staat.state !== 'blocked') throw new Error('verwachtte blocked')
    expect(staat.dialog).toContain('Hooks need review')
    expect(staat.tail).toContain('1. Review hooks')
  })

  it('ziet de zsh-prompt in de scrollback niet als gereedheid', () => {
    expect(CLAUDE_SHELL_ECHO.includes('❯')).toBe(true)
    expect(readyScreenState(CLAUDE_SHELL_ECHO, '❯').state).toBe('waiting')
  })

  it('geeft een bekende dialoog terug als gate, niet als blokkade', () => {
    const staat = readyScreenState(CLAUDE_TRUST_NA_ECHO, '❯')
    if (staat.state !== 'gate') throw new Error(`verwachtte gate, kreeg ${staat.state}`)
    expect(staat.gate).toEqual({ name: 'trust prompt', keys: 'down-enter' })
  })

  it('erkent claude als gereed zodra de invoerregel onder het startcommando staat', () => {
    expect(readyScreenState(CLAUDE_ECHT_GEREED, '❯').state).toBe('ready')
  })

  it('erkent codex als gereed bij een lege invoerregel zonder menu', () => {
    expect(readyScreenState(CODEX_ECHT_GEREED, '›').state).toBe('ready')
  })

  it('erkent gereedheid zodra de marker onder een afgehandelde dialoog staat', () => {
    // Een bevestigde dialoog blijft in de pane staan. Staat de marker eronder,
    // dan is de CLI verder; staat hij er alleen IN de menuregel, dan niet.
    const pane = [
      '◆',
      '● No, exit (recommended)',
      '○ Yes, I accept the risks and want to skip permissions',
      '^[[B',
      '❯ ',
    ].join('\n')
    expect(readyScreenState(pane, '❯').state).toBe('ready')
  })

  it('bevestigt geen bekende dialoog die boven een levend onbekend menu staat', () => {
    // Zonder deze regel pakt detectLiveGate de trust-tekst uit de scrollback,
    // antwoordt met Enter in het hooks-menu dat eronder leeft, en omzeilt zo
    // precies het besluit dat de gebruiker zelf moet nemen.
    const pane = [
      ' nocorrect unset CLAUDECODE; codex --cd /tmp/w',
      ' Do you trust the contents of this directory?',
      ' › 1. Yes, continue',
      '   2. No, quit',
      '',
      '  Hooks need review',
      '  6 hooks are new or changed.',
      '',
      '› 1. Review hooks',
      '  2. Trust all and continue',
      '',
      '  enter confirm · esc skip',
    ].join('\n')
    const staat = readyScreenState(pane, '›')
    if (staat.state !== 'blocked') throw new Error(`verwachtte blocked, kreeg ${staat.state}`)
    expect(staat.dialog).toContain('Hooks need review')
  })

  it('blijft gereed afwijzen zolang een dialoog nog op een toets wacht', () => {
    // De marker staat hier onder de laatste menuregel, maar de voetregel zegt
    // dat de dialoog nog leeft. Dat is geen afgehandelde dialoog.
    const pane = [
      ' nocorrect unset CLAUDECODE; codex --cd /tmp/w',
      '  Nieuwe voorwaarden',
      '> 1. Akkoord',
      '  2. Niet akkoord',
      '  > ',
      '  enter confirm · esc skip',
    ].join('\n')
    expect(readyScreenState(pane, '>').state).toBe('blocked')
  })

  it('wacht nog bij een lege pane', () => {
    expect(readyScreenState('', '❯').state).toBe('waiting')
    expect(readyScreenState('\n\n  \n', '❯').state).toBe('waiting')
  })

  it('erkent een voetregel-marker zoals agy en mimo die gebruiken', () => {
    const pane = [
      ' nocorrect unset CLAUDECODE; agy --dangerously-skip-permissions',
      '  agy klaar',
      '',
      '  ? for shortcuts',
    ].join('\n')
    expect(readyScreenState(pane, '? for shortcuts').state).toBe('ready')
  })

  it('blokkeert een onbekende dialoog ook zonder menupijl, op de bevestigingsvoetregel', () => {
    const pane = [
      ' nocorrect unset CLAUDECODE; codex --cd /tmp/w',
      '  Nieuwe voorwaarden',
      '  Er is iets gewijzigd dat je moet bekijken.',
      '  press enter to continue',
      '› ',
    ].join('\n')
    expect(readyScreenState(pane, '›').state).toBe('blocked')
  })
})
