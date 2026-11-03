export interface EnsembleTeam {
  id: string
  name: string
  description: string
  status: 'forming' | 'active' | 'paused' | 'completed' | 'disbanded' | 'failed'
  agents: EnsembleTeamAgent[]
  createdBy: string
  createdAt: string
  completedAt?: string
  feedMode: 'silent' | 'summary' | 'live'
  workingDirectory?: string
  worktree?: 'team'
  worktreePath?: string
  worktreeBranch?: string
  replacementCount?: number
  /**
   * The caller named the agents, so nobody substitutes one. Without this,
   * a stalled agent was replaced by whatever the fallback order offered: on
   * 03-11-2026 a run started as "codex,claude" ended up with agy and glm.
   */
  agentsExplicit?: boolean
  result?: EnsembleTeamResult
}

export interface EnsembleTeamAgent {
  startedAt?: string
  agentId: string
  name: string
  program: string
  role: string
  hostId: string
  status: 'spawning' | 'active' | 'idle' | 'done' | 'failed' | 'replaced'
  /**
   * How far the prompt got. 'confirmed' means this agent has posted a message,
   * which is the only proof its prompt was executed. The launcher waits on
   * this instead of counting seconds.
   *
   * 'silent' and 'failed' are not the same thing and must not be reported as
   * one: 'failed' means the pane took nothing (a dialog, a dead CLI), 'silent'
   * means the prompt arrived and the agent has not spoken yet. Measured
   * 03-11-2026, glm needed over a minute for its first message, and calling
   * that a failed delivery sent the reader looking in the wrong place.
   */
  delivery?: 'pending' | 'delivered' | 'confirmed' | 'silent' | 'failed'
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

export interface EnsembleMessage {
  id: string
  teamId: string
  from: string
  to: string
  content: string
  type: 'chat' | 'decision' | 'question' | 'result'
  timestamp: string
  options?: string[]
}

export interface CreateTeamRequest {
  name: string
  description: string
  agents?: Array<{
    program: string
    role?: string
    hostId?: string
  }>
  feedMode?: 'silent' | 'summary' | 'live'
  workingDirectory?: string
  templateName?: string
  worktree?: 'team'
  useWorktrees?: boolean
  staged?: boolean
  stagedConfig?: StagedWorkflowConfig
  /** Set by a caller that named its agents: no replacements, no fallback. */
  agentsExplicit?: boolean
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
