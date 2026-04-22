// Fix 3: explicit FSM phase persisted on the team record. Previously phase
// was only inferred from prose in messages, which made completion detection
// fragile. Now the orchestrator owns the transitions.
export type TeamPhase =
  | 'forming'
  | 'spawning'
  | 'ready_wait'
  | 'planning'
  | 'executing'
  | 'reviewing'
  | 'done_pending'
  | 'disbanding'
  | 'disbanded'
  | 'failed'

export interface EnsembleTeam {
  id: string
  name: string
  description: string
  status: 'forming' | 'active' | 'paused' | 'completed' | 'disbanded' | 'failed'
  phase?: TeamPhase
  agents: EnsembleTeamAgent[]
  createdBy: string
  createdAt: string
  completedAt?: string
  feedMode: 'silent' | 'summary' | 'live'
  workingDirectory?: string
  result?: EnsembleTeamResult
}

export interface EnsembleTeamAgent {
  agentId: string
  name: string
  program: string
  role: string
  hostId: string
  status: 'spawning' | 'active' | 'idle' | 'done' | 'failed'
  worktreePath?: string
  worktreeBranch?: string
}

export interface EnsembleTeamResult {
  summary: string
  decisions: string[]
  discoveries: string[]
  filesChanged: string[]
  duration: number
}

// Fix 4/6: message class tag (parsed from [PLAN], [FINDING], etc. prefix)
export type MessageClass = 'PLAN' | 'FINDING' | 'BLOCKER' | 'REVIEW' | 'PROGRESS' | 'DONE' | 'UNTAGGED'

export interface EnsembleMessage {
  id: string
  teamId: string
  from: string
  to: string
  content: string
  type: 'chat' | 'decision' | 'question' | 'result'
  timestamp: string
  options?: string[]
  // Fix 4: delivery tracking for paste acks and semantic filtering
  deliveryId?: string
  checksum?: string
  messageClass?: MessageClass
}

export interface CreateTeamRequest {
  name: string
  description: string
  agents: Array<{
    program: string
    role?: string
    hostId?: string
  }>
  feedMode?: 'silent' | 'summary' | 'live'
  workingDirectory?: string
  templateName?: string
  useWorktrees?: boolean
  staged?: boolean
  stagedConfig?: StagedWorkflowConfig
  // Fix 2: CAS — set to true to bypass one-active-team-per-cwd check (e.g. worktree mode)
  allowConcurrent?: boolean
}

export type StagedPhase = 'plan' | 'exec' | 'verify'

export interface StagedWorkflowConfig {
  planTimeoutMs?: number   // Max time for PLAN phase before auto-advancing (default: 120000 = 2min)
  execTimeoutMs?: number   // Max time for EXEC phase before auto-advancing (default: 300000 = 5min)
  verifyTimeoutMs?: number // Max time for VERIFY phase before completing (default: 120000 = 2min)
  pollIntervalMs?: number  // How often to check for phase completion (default: 5000 = 5s)
}

export interface CollabTemplateRole {
  role: string
  focus: string
  expert?: string  // slug from context-profiles/index.json (e.g. "howard-marks", "philip-tetlock")
}

export interface CollabTemplate {
  name: string
  description: string
  suggestedTaskPrefix: string
  roles: CollabTemplateRole[]
}

export interface CollabTemplatesFile {
  templates: Record<string, CollabTemplate>
}
