/**
 * Collab Path Resolver — Shared path contract for multi-collab isolation.
 * All runtime files live under /tmp/ensemble/<teamId>/.
 * Shell equivalent: scripts/collab-paths.sh (must stay in sync).
 */

import path from 'path'
import fs from 'fs'

const RUNTIME_ROOT = '/tmp/ensemble'

/** Base runtime directory for a team */
export function collabRuntimeDir(teamId: string): string {
  return path.join(RUNTIME_ROOT, teamId)
}

/** JSONL message log */
export function collabMessagesFile(teamId: string): string {
  return path.join(RUNTIME_ROOT, teamId, 'messages.jsonl')
}

/** Summary text written on disband */
export function collabSummaryFile(teamId: string): string {
  return path.join(RUNTIME_ROOT, teamId, 'summary.txt')
}

/** Bridge process PID file */
export function collabBridgePid(teamId: string): string {
  return path.join(RUNTIME_ROOT, teamId, 'bridge.pid')
}

/** Bridge log file */
export function collabBridgeLog(teamId: string): string {
  return path.join(RUNTIME_ROOT, teamId, 'bridge.log')
}

/** Poller process PID file */
export function collabPollerPid(teamId: string): string {
  return path.join(RUNTIME_ROOT, teamId, 'poller.pid')
}

/** Live feed output file */
export function collabFeedFile(teamId: string): string {
  return path.join(RUNTIME_ROOT, teamId, 'feed.txt')
}

/** Per-agent prompt file */
export function collabPromptFile(teamId: string, agentName: string): string {
  return path.join(RUNTIME_ROOT, teamId, 'prompts', `${agentName}.txt`)
}

// Fix 8: per-delivery file name is strictly monotonic + random.
// The previous bare Math.random() could in rare cases collide (e.g. two
// near-simultaneous watchdog nudges + staged deliveries to same session).
// Monotonic counter + process-nanosecond timestamp + random tail guarantees
// uniqueness and makes filenames sortable for debugging.
let _deliverySeq = 0
export function collabDeliveryFile(teamId: string, sessionName: string): string {
  const seq = (++_deliverySeq).toString(36).padStart(4, '0')
  const ts = process.hrtime.bigint().toString(36).slice(-10)
  const rand = Math.random().toString(36).slice(2, 6)
  return path.join(RUNTIME_ROOT, teamId, 'delivery', `${sessionName}-${ts}-${seq}-${rand}.txt`)
}

/** Bridge result file (raw bridge output) */
export function collabBridgeResult(teamId: string): string {
  return path.join(RUNTIME_ROOT, teamId, 'bridge-result')
}

/** Bridge posted marker */
export function collabBridgePosted(teamId: string): string {
  return path.join(RUNTIME_ROOT, teamId, 'bridge-posted')
}

/** Team ID marker file */
export function collabTeamIdFile(teamId: string): string {
  return path.join(RUNTIME_ROOT, teamId, 'team-id')
}

/** Finished marker (written on disband, signals cleanup) */
export function collabFinishedMarker(teamId: string): string {
  return path.join(RUNTIME_ROOT, teamId, '.finished')
}

/** Ensure the runtime directory (and subdirs) exist */
export function ensureCollabDirs(teamId: string): void {
  const base = collabRuntimeDir(teamId)
  fs.mkdirSync(path.join(base, 'prompts'), { recursive: true })
  fs.mkdirSync(path.join(base, 'delivery'), { recursive: true })
}
