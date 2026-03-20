export interface OrchestraTeam {
  id: string
  name: string
  description: string
  status: 'forming' | 'active' | 'paused' | 'completed' | 'disbanded' | 'failed'
  agents: OrchestraTeamAgent[]
  createdBy: string
  createdAt: string
  completedAt?: string
  feedMode: 'silent' | 'summary' | 'live'
  result?: OrchestraTeamResult
}

export interface OrchestraTeamAgent {
  agentId: string
  name: string
  program: string
  role: string
  hostId: string
  status: 'spawning' | 'active' | 'idle' | 'done' | 'failed'
  worktreePath?: string
  worktreeBranch?: string
}

export interface OrchestraTeamResult {
  summary: string
  decisions: string[]
  discoveries: string[]
  filesChanged: string[]
  duration: number
}

export interface OrchestraMessage {
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
