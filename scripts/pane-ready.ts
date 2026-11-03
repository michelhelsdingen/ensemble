/**
 * Ask one question about one tmux pane: may we write a prompt into it?
 *
 * Shell callers (collab-rescue.sh) used to paste without looking. On
 * 03-11-2026 that meant three rescue attempts in a row pasting into codex's
 * modal "Hooks need review" dialog, none of which could ever land. This gives
 * them the same verdict the service uses.
 *
 * Usage: pane-ready.ts <tmux-session> <agent-name-or-key>
 * Exit 0 ready, 10 blocked by a dialog (named on stdout), 11 not ready yet,
 * 12 the pane could not be read.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { loadAgentsConfig, resolveAgentProgram } from '../lib/agent-config'
import { readyScreenState } from '../lib/ready-screen'

const execFileAsync = promisify(execFile)

/** 'codex-1' is agent codex; a bare key stays itself. */
function agentKey(name: string): string {
  const config = loadAgentsConfig()
  if (config[name]) return name
  const stripped = name.replace(/-\d+$/, '')
  if (config[stripped]) return stripped
  return name
}

async function main(): Promise<void> {
  const [session, agent] = process.argv.slice(2)
  if (!session || !agent) {
    console.error('Usage: pane-ready.ts <tmux-session> <agent-name-or-key>')
    process.exitCode = 12
    return
  }
  let pane = ''
  try {
    const { stdout } = await execFileAsync(
      'tmux', ['capture-pane', '-t', session, '-p', '-S', '-50'],
      { encoding: 'utf8', timeout: 5000 },
    )
    pane = stdout
  } catch {
    console.error(`${session}: pane niet te lezen`)
    process.exitCode = 12
    return
  }
  const marker = resolveAgentProgram(agentKey(agent)).readyMarker
  const state = readyScreenState(pane, marker)
  if (state.state === 'ready') return
  if (state.state === 'blocked') {
    console.log(state.dialog)
    console.error(state.tail)
    process.exitCode = 10
    return
  }
  console.error(`${session}: nog niet gereed (${state.state})`)
  process.exitCode = 11
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 12
})
