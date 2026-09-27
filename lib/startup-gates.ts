/**
 * Startup dialogs that an agent CLI shows before it accepts input, and the
 * keys that get past them.
 *
 * Two lessons from the September 2026 startup fixes are built in:
 * - Claude Code's trust dialog puts the cursor on "No, exit". A bare Enter
 *   closed Claude and left an empty shell. The selected option decides the keys.
 * - The capture includes scrollback. A dialog that was already answered stayed
 *   visible there, so Enter kept being sent for almost a minute. Only a dialog
 *   in the last lines of the pane counts as live.
 */

export type GateKeys = 'enter' | 'down-enter'

export interface LiveGate {
  name: string
  keys: GateKeys
}

const GATES: Array<{ name: string; pattern: RegExp; defaultKeys: GateKeys }> = [
  {
    name: 'trust prompt',
    pattern: /Do you trust the contents of this directory\?|Quick safety check:|Yes, I trust this folder/i,
    defaultKeys: 'enter',
  },
  {
    name: 'bypass permissions warning',
    pattern: /WARNING: Claude Code running in Bypass Permissions mode/i,
    defaultKeys: 'down-enter',
  },
  {
    name: 'skip permissions warning',
    pattern: /Yes, I accept the risks and want to skip permissions/i,
    defaultKeys: 'down-enter',
  },
]

/** How many non-empty lines at the bottom of the pane a live dialog occupies. */
const LIVE_TAIL_LINES = 15

/** A selected menu line, e.g. " ❯ No, exit" or "● No, exit". */
const SELECTED_NO = /^[\s│]*[❯›>●]\s*(\d+\.\s*)?No\b/

export function detectLiveGate(paneOutput: string): LiveGate | null {
  const tail = paneOutput
    .split('\n')
    .filter(line => line.trim() !== '')
    .slice(-LIVE_TAIL_LINES)
  const tailText = tail.join('\n')

  const gate = GATES.find(candidate => candidate.pattern.test(tailText))
  if (!gate) return null

  const selectedNo = tail.some(line => SELECTED_NO.test(line))
  return { name: gate.name, keys: selectedNo ? 'down-enter' : gate.defaultKeys }
}

/** Send the same confirmation keys in a team session or a startup probe. */
export async function confirmLiveGate(
  gate: LiveGate,
  sendKeys: (keys: string, options?: { enter?: boolean }) => Promise<void>,
): Promise<void> {
  // A dialog can be drawn before its menu accepts keys; let it settle first.
  await new Promise(resolve => setTimeout(resolve, 800))
  if (gate.keys === 'down-enter') {
    // A TUI can still be handling Down when Enter arrives in the same write,
    // which confirms the old selection ("No, exit"). Give it a moment.
    await sendKeys('Down')
    await new Promise(resolve => setTimeout(resolve, 400))
    await sendKeys('Enter')
  } else await sendKeys('Enter')
}

const SHELL_NAMES = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'csh'])

/** True when a pane's foreground command is an interactive shell, not an agent CLI. */
export function isShellCommand(command: string): boolean {
  const base = command.trim().replace(/^-/, '').split('/').pop() ?? ''
  return SHELL_NAMES.has(base.toLowerCase())
}
