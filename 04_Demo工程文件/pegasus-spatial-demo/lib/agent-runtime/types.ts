import type {
  HippocampusSafetyState,
  HippocampusTelemetryState,
} from '@/lib/agent/hippocampus-runtime'
import type {
  AskUserQuestionItem,
  ConversationMessage,
  ImageAttachment,
  ModelProvider,
  ProjectGuideParameter,
} from '@/lib/types'

export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'waiting_agents'
  | 'recoverable'
  | 'completed'
  | 'cancelled'
  | 'failed'

export type AgentRunTerminationReason =
  | 'model_finished'
  | 'user_cancelled'
  | 'max_turns'
  | 'model_error'
  | 'runtime_error'

export type AgentRunFailureRecoverability = 'transient' | 'fatal'

export type AgentRunFailureCategory =
  | 'provider_transient'
  | 'message_format'
  | 'run_limit'
  | 'runtime_transient'
  | 'configuration'
  | 'identity_invariant'

export type AgentRunActionKind = 'model_request' | 'tool_call' | 'compaction'

export type AgentRunTrigger =
  | 'user'
  | 'task'
  | 'message'
  | 'supervision'
  | 'reopen'

export type AgentRunExecutionMode = 'conversation' | 'agent_session'

export interface AgentRunCurrentAction {
  kind: AgentRunActionKind
  action_id: string
  tool_use_id?: string
  tool_name?: string
  input_hash?: string
  prefix_hash?: string
  attempt: number
  started_at: Date
}

export interface AgentRunLease {
  owner_id: string
  heartbeat_at: Date
  expires_at: Date
}

export interface AgentRunLiveState {
  revision: number
  assistant_text: string
  updated_at: Date
}

export interface AgentRunRequest {
  message: string
  images?: ImageAttachment[]
  settings?: {
    orchestrator_model?: ModelProvider
    research_domain?: string
    memory_enabled?: boolean
  }
  internal?: {
    kind: 'agent_update' | 'team_supervision' | 'task_wakeup'
    source_ids?: string[]
  }
}

export interface AgentRunPendingInput {
  message_id: string
  message: string
  images?: ImageAttachment[]
  interaction_id?: string
  visibility?: 'public' | 'internal'
  source_kind?: 'user' | 'agent' | 'team_supervision'
  created_at: Date
}

export interface AgentRunPendingInteraction {
  interaction_id: string
  questions: AskUserQuestionItem[]
  created_at: Date
}

export type CompactionCheckpointStatus = 'started' | 'summary_ready' | 'merged'

/**
 * Actual-file workspace tree frozen at a prompt epoch. It intentionally
 * contains no file bodies; the projection is prompt context, not a backup.
 */
export interface FrozenWorkspaceProjection {
  version: number
  content: string
  files_hash: string
  generated_at: Date
}

/**
 * Exact Project Guide and workspace projection used by a prompt epoch.
 * Storing compiled text prevents registry edits from changing recovery of an
 * already-started Run or compaction checkpoint.
 */
export interface FrozenProjectContextSnapshot {
  epoch: number
  template_id: string
  version: number
  parameters?: Record<string, ProjectGuideParameter>
  guide_title: string
  compiled_guide: string
  guide_hash: string
  workspace_projection: FrozenWorkspaceProjection
}

export interface CompactionCheckpoint {
  compaction_id: string
  status: CompactionCheckpointStatus
  prefix_hash?: string
  prefix_message_id?: string
  summary?: string
  /** Frozen independently for legacy recovery paths that predate Project Context. */
  workspace_projection?: FrozenWorkspaceProjection
  /** Exact guide/projection epoch used when composing the replacement prefix. */
  project_context_snapshot?: FrozenProjectContextSnapshot
  /** Exact replacement persisted before compacted_messages is swapped. */
  replacement_message?: ConversationMessage
  started_at: Date
  updated_at: Date
}

export interface PersistentHippocampusState {
  snapshot_version: number
  telemetry: Partial<HippocampusTelemetryState> | null
  breaker_state?: HippocampusSafetyState | null
  rapid_refills: number
  turns_since_merge: number
  /** Last context-scoped CompactionJob whose post-swap runtime epoch settled. */
  last_settled_compaction_id?: string | null
  active_compaction?: CompactionCheckpoint
}

export interface FrozenProfileSnapshot {
  version: number
  token_count: number
  /** Exact System Block 3 text frozen for a resumed top-level Run. */
  compiled_text?: string
}

export const ACTIVE_AGENT_RUN_STATUSES: AgentRunStatus[] = [
  'queued',
  'running',
  'waiting_user',
  'waiting_agents',
  'recoverable',
]

export function isActiveAgentRunStatus(status: AgentRunStatus): boolean {
  return ACTIVE_AGENT_RUN_STATUSES.includes(status)
}

/** Public transcript/retry routes are Root-only; member Runs stay private. */
export function isPublicRootAgentRun(run: {
  root_visible?: boolean
  execution_mode?: AgentRunExecutionMode
}): boolean {
  return run.root_visible !== false && run.execution_mode !== 'agent_session'
}
