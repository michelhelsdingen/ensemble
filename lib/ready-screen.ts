/**
 * One shared readiness test for an agent pane.
 *
 * Until 03-11-2026 both the service and the smoke test asked the same question:
 * does the captured pane contain the agent's readyMarker anywhere? Measured on
 * this machine that day, that question answers yes while the CLI accepts
 * nothing:
 *
 * - codex 0.164.0 opens a modal "Hooks need review" dialog whose selection
 *   arrow is '›', the very marker agents.json lists as codex's readyMarker.
 *   The service called codex ready after 1.6s, pasted the prompt into the
 *   dialog three times, and the team never started.
 * - claude's readyMarker is '❯', which is also the zsh prompt. A capture half a
 *   second after launch holds nothing but the shell, and matches.
 *
 * So readiness needs a positive signal, and an unknown dialog must be a hard
 * failure rather than a wait: a dialog the agent cannot answer for itself is a
 * decision for the user, and silently
 * pasting past it loses the prompt.
 */

import { detectLiveGate, type LiveGate } from './startup-gates'

export type ReadyScreenState =
  /** The marker sits on the live part of the screen and no dialog is open. */
  | { state: 'ready' }
  /** Nothing usable on screen yet; keep polling. */
  | { state: 'waiting' }
  /** A dialog we know how to answer. */
  | { state: 'gate'; gate: LiveGate }
  /** A dialog we must not answer on the user's behalf. */
  | { state: 'blocked'; dialog: string; tail: string }

/**
 * The shell echo of the launch command, from buildAgentStartupCommand. Every
 * line up to and including its last occurrence is shell output, never CLI
 * output, so a marker there says nothing about the CLI.
 */
export const LAUNCH_ECHO = 'nocorrect unset CLAUDECODE'

/** How many non-empty lines at the bottom count as the live screen. */
const LIVE_TAIL_LINES = 15

/** A menu line of an open dialog, e.g. '› 1. Review hooks' or '❯ No, exit'. */
const MENU_LINE = /^[\s│]*[❯›>●○]\s*(\d+[.)]\s*\S|(Yes|No|Review|Trust|Continue|Accept|Cancel|Quit|Exit)\b)/

/** The footer a dialog prints to say it is waiting for a key. */
const CONFIRM_FOOTER = /\b(enter (to )?confirm|press enter to continue|esc (to )?(skip|cancel)|enter to select)\b/i

/** The first line of the dialog: its heading, for the error message. */
function dialogHeading(tail: string[]): string {
  const firstMenu = tail.findIndex(line => MENU_LINE.test(line))
  const above = (firstMenu === -1 ? tail : tail.slice(0, firstMenu))
    .map(line => line.trim())
    .filter(line => line && !/^[─━=_.·]+$/.test(line))
  return above[0] ?? tail.map(line => line.trim()).find(Boolean) ?? 'unknown dialog'
}

/**
 * Decide what a captured pane says about the agent behind it.
 *
 * @param pane        output of tmux capture-pane, scrollback included
 * @param readyMarker the agent's readyMarker from agents.json
 */
export function readyScreenState(pane: string, readyMarker: string): ReadyScreenState {
  const lines = pane.split(/\r?\n/)

  // Drop everything up to the last echo of the launch command: that part is the
  // shell, and the shell's own prompt can be the agent's readyMarker.
  let lastEcho = -1
  lines.forEach((line, index) => { if (line.includes(LAUNCH_ECHO)) lastEcho = index })
  const live = lines.slice(lastEcho + 1).filter(line => line.trim() !== '')
  if (live.length === 0) return { state: 'waiting' }

  const tail = live.slice(-LIVE_TAIL_LINES)
  const tailText = tail.join('\n')

  // An answered dialog stays in the pane. The marker strictly below its last
  // menu line means the CLI moved on; a marker inside the menu (codex draws
  // '› 1. Review hooks') does not count, which is the whole point.
  let lastMenuLine = -1
  tail.forEach((line, index) => { if (MENU_LINE.test(line)) lastMenuLine = index })
  if (lastMenuLine >= 0 && tail.slice(lastMenuLine + 1).join('\n').includes(readyMarker)) {
    return { state: 'ready' }
  }

  // A dialog we already know beats everything: its menu arrow may be the marker.
  const gate = detectLiveGate(tailText)
  if (gate) return { state: 'gate', gate }

  // An unknown dialog, recognised by its menu or by the key it waits for.
  if (lastMenuLine >= 0 || CONFIRM_FOOTER.test(tailText)) {
    return { state: 'blocked', dialog: dialogHeading(tail), tail: tailText }
  }

  return tailText.includes(readyMarker) ? { state: 'ready' } : { state: 'waiting' }
}

/**
 * How long readiness must hold before anything is delivered to the pane.
 *
 * Measured 03-11-2026: codex 0.164.0 draws its input line at 1,0s and lays a
 * modal "Hooks need review" over it at 1,6s. A single reading of "ready" is
 * therefore not evidence, and both the service and the smoke test need the
 * same hold or preflight stays green while a team starts broken.
 */
export const READY_STABLE_MS = 2_000

/**
 * Hold back a 'ready' verdict until it has lasted stableMs.
 * Returns a function: feed it each poll's verdict, it answers whether the
 * agent may be written to.
 */
export function createReadyHold(stableMs: number = READY_STABLE_MS): (ready: boolean, now?: number) => boolean {
  let since = 0
  return (ready, now = Date.now()) => {
    if (!ready) { since = 0; return false }
    if (!since) since = now
    return now - since >= stableMs
  }
}
