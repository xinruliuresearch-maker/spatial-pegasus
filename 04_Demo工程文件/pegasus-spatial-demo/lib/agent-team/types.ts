export const DEFAULT_MAX_ACTIVE_AGENTS = 8
export const DEFAULT_MAX_TOTAL_AGENTS = 32
export const DEFAULT_SUPERVISION_INTERVAL_MS = 120_000
export const MAX_WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1000

export type AgentTeamStatus = 'active' | 'completed'

export type TeamAgentStatus = 'running' | 'idle' | 'paused' | 'completed' | 'failed'

export type AgentTaskStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'submitted'
  | 'accepted'
  | 'rework'
  | 'failed'
  | 'cancelled'

export type AgentTaskWaitingKind = 'dependencies' | 'manual'

export type AgentMessageKind =
  | 'info'
  | 'request'
  | 'review'
  | 'response'
  | 'progress'
  | 'blocker'
  | 'error'

export type MailboxDeliveryKind = 'primary' | 'root_observer'
export type MailboxDeliveryStatus = 'pending' | 'claimed' | 'acknowledged'

export type AgentWaitMode = 'all' | 'any'
export type AgentWaitStatus = 'waiting' | 'triggered' | 'timed_out' | 'cancelled'

export type AgentResultOutcome = 'completed' | 'blocked' | 'failed'

export type WorkspaceProposalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'published'
  | 'conflict'

export type AgentManagementAction = 'interrupt' | 'close' | 'reopen'

export interface AgentBudget {
  max_tokens?: number
  max_cost_usd?: number
  max_tool_calls?: number
  max_download_bytes?: number
}

export interface AgentTeamPolicySnapshot {
  version: number
  strategy_version: number
  max_active_agents: number
  max_total_agents: number
  supervision_interval_ms: number
  global_budget?: AgentBudget
}

export interface AgentGrantCapabilities {
  is_coordinator: boolean
  can_create_agents: boolean
  can_delegate_tasks: boolean
  can_message_agents: boolean
  can_inspect_team: boolean
  can_wait_for_agents: boolean
  can_submit_results: boolean
  can_review_results: boolean
  can_manage_agents: boolean
  can_read_public_workspace: boolean
  can_write_private_workspace: boolean
  can_publish_references: boolean
  can_ask_user: boolean
}

export interface DelegationGrantSnapshot {
  capabilities: AgentGrantCapabilities
  allowed_tool_names: string[]
  allowed_read_paths: string[]
  budget?: AgentBudget
}

export interface AgentTeamRecord {
  team_id: string
  conversation_id: string
  user_id: string
  root_agent_id: string
  workspace_id: string
  status: AgentTeamStatus
  policy: AgentTeamPolicySnapshot
  next_event_seq: number
  supervision_cursor: number
  supervision_lease_owner_id?: string | null
  supervision_lease_token?: string | null
  supervision_lease_expires_at?: Date | null
  created_at: Date
  updated_at: Date
  completed_at?: Date | null
}

export interface TeamSupervisionBatchRecord {
  batch_id: string
  team_id: string
  user_id: string
  after_seq: number
  through_seq: number
  events: TeamEventRecord[]
  message_ids: string[]
  delivered_run_id?: string | null
  delivered_at?: Date | null
  created_at: Date
  updated_at: Date
}

export interface TeamAgentRecord {
  agent_id: string
  team_id: string
  conversation_id: string
  user_id: string
  slot: number
  display_name: string
  normalized_name: string
  role: string
  instructions?: string | null
  is_root: boolean
  created_by_agent_id?: string | null
  status: TeamAgentStatus
  generation: number
  current_session_id: string
  active_grant_id: string
  grant_version: number
  private_workspace_prefix: string
  creation_command_key?: string | null
  last_command_key?: string | null
  last_transition_at: Date
  last_progress_at?: Date | null
  progress_snapshot?: AgentProgressSnapshot | null
  interrupt_requested_at?: Date | null
  completed_at?: Date | null
  created_at: Date
  updated_at: Date
}

export interface AgentProgressSnapshot {
  run_id?: string
  task_id?: string
  checkpoint_seq?: number
  current_action?: string
  summary?: string
  updated_at: Date
}

export interface AgentModelSnapshot {
  provider?: string
  model_id?: string
  alias?: string
  settings?: Record<string, unknown>
}

export interface AgentSessionRuntimeRecord {
  session_id: string
  team_id: string
  conversation_id: string
  user_id: string
  agent_id: string
  generation: number
  active_run_id?: string | null
  active_lease_owner_id?: string | null
  run_lease?: AgentSessionRunLease | null
  revision: number
  /** CAS epoch for the model-visible message context only. */
  context_revision?: number
  last_applied_compaction_id?: string | null
  context_compaction_fence?: import('../agent-compaction/types').ContextCompactionFence | null
  messages: unknown[]
  compacted_messages: unknown[]
  hippocampus: Record<string, unknown>
  model_snapshot?: AgentModelSnapshot | null
  created_at: Date
  updated_at: Date
}

export interface AgentSessionRunLease {
  owner_id: string
  fence_token: string
  heartbeat_at: Date
  expires_at: Date
}

export interface AgentExecutionSlotRecord {
  execution_slot_id: string
  team_id: string
  user_id: string
  slot: number
  agent_id: string
  session_id: string
  run_id: string
  owner_id: string
  fence_token: string
  heartbeat_at: Date
  expires_at: Date
  created_at: Date
  updated_at: Date
}

export interface DelegationGrantRecord extends DelegationGrantSnapshot {
  grant_id: string
  team_id: string
  user_id: string
  agent_id: string
  version: number
  active_key?: string | null
  granted_by_agent_id: string
  reason?: string | null
  created_at: Date
  revoked_at?: Date | null
}

export interface AgentContextReference {
  kind: 'workspace_path' | 'evidence' | 'paper' | 'task' | 'message' | 'url'
  value: string
  label?: string
}

export interface AgentTaskRecord {
  task_id: string
  team_id: string
  conversation_id: string
  user_id: string
  title: string
  objective: string
  acceptance_criteria: string[]
  context_refs: AgentContextReference[]
  assigned_agent_id: string
  created_by_agent_id: string
  dependency_task_ids: string[]
  status: AgentTaskStatus
  /** Why a waiting Task is paused. Only dependency waits are scheduler-owned
   * and may resume automatically; manual waits require an explicit update. */
  waiting_kind?: AgentTaskWaitingKind | null
  budget?: AgentBudget
  result_ids: string[]
  active_result_id?: string | null
  creation_command_key?: string | null
  last_command_key?: string | null
  started_at?: Date | null
  submitted_at?: Date | null
  completed_at?: Date | null
  created_at: Date
  updated_at: Date
}

export interface MailboxAttachmentReference {
  kind: 'workspace_path' | 'evidence' | 'paper' | 'result' | 'task' | 'url'
  value: string
  label?: string
}

export interface MailboxDelivery {
  agent_id: string
  kind: MailboxDeliveryKind
  status: MailboxDeliveryStatus
  claim_id?: string | null
  claimed_at?: Date | null
  acknowledged_at?: Date | null
}

export interface AgentMailboxMessageRecord {
  message_id: string
  team_id: string
  conversation_id: string
  user_id: string
  sender_agent_id: string
  recipient_agent_id: string
  /** Immutable display-name snapshots keep recovered prompts human-readable. */
  sender_name?: string | null
  recipient_name?: string | null
  task_id?: string | null
  correlation_id?: string | null
  reply_to_message_id?: string | null
  kind: AgentMessageKind
  /** Short notification/UI preview. The durable message body remains authoritative. */
  summary?: string | null
  content: string
  attachments: MailboxAttachmentReference[]
  deliveries: MailboxDelivery[]
  creation_command_key?: string | null
  created_at: Date
}

export interface AgentResultFile {
  source_path: string
  suggested_target_path?: string
  media_type?: string
  sha256?: string
  size_bytes?: number
}

export interface AgentResultRecord {
  result_id: string
  team_id: string
  conversation_id: string
  user_id: string
  /** Optional because conversational SendMessage turns do not require a formal Task. */
  task_id?: string | null
  agent_id: string
  run_id: string
  outcome: AgentResultOutcome
  final_response: string
  summary: Record<string, unknown>
  evidence_refs: AgentContextReference[]
  files: AgentResultFile[]
  proposal_ids: string[]
  implicit: boolean
  creation_command_key?: string | null
  created_at: Date
}

export interface WorkspaceProposalRecord {
  proposal_id: string
  team_id: string
  conversation_id: string
  user_id: string
  result_id: string
  task_id?: string | null
  agent_id: string
  source_path: string
  target_path: string
  expected_target_revision?: number | null
  source_sha256?: string | null
  status: WorkspaceProposalStatus
  review_note?: string | null
  reviewed_by_agent_id?: string | null
  reviewed_at?: Date | null
  review_command_key?: string | null
  published_revision?: number | null
  created_at: Date
  updated_at: Date
}

export interface AcceptedWorkspaceIntent {
  proposal_id: string
  result_id: string
  task_id?: string | null
  author_agent_id: string
  source_path: string
  target_path: string
  expected_target_revision?: number | null
  source_sha256?: string | null
}

export interface AgentWaitSubscriptionRecord {
  wait_id: string
  team_id: string
  conversation_id: string
  user_id: string
  agent_id: string
  run_id: string
  task_ids: string[]
  mode: AgentWaitMode
  status: AgentWaitStatus
  after_event_seq: number
  deadline_at: Date
  trigger_reason?: string | null
  triggered_event_seq?: number | null
  creation_command_key?: string | null
  wake_delivered_at?: Date | null
  created_at: Date
  updated_at: Date
  resolved_at?: Date | null
}

export type TeamEventType =
  | 'team_created'
  | 'team_completed'
  | 'agent_created'
  | 'agent_status_changed'
  | 'agent_reopened'
  | 'task_assigned'
  | 'task_status_changed'
  | 'message_sent'
  | 'result_submitted'
  | 'result_reviewed'
  | 'workspace_proposal_outcome'
  | 'wait_started'
  | 'wait_resolved'
  | 'execution_slot_claimed'
  | 'execution_slot_released'
  | 'agent_error'
  | 'compaction_status'
  | 'supervision_due'

export interface TeamEventRecord {
  event_id: string
  team_id: string
  conversation_id: string
  user_id: string
  seq: number
  type: TeamEventType
  actor_agent_id?: string | null
  subject_agent_id?: string | null
  task_id?: string | null
  run_id?: string | null
  payload: Record<string, unknown>
  dedupe_key?: string | null
  created_at: Date
}

export type CommandReceiptStatus = 'processing' | 'completed' | 'failed'

export interface CommandReceiptRecord {
  receipt_id: string
  team_id: string
  user_id: string
  command_key: string
  command_name: string
  run_id: string
  tool_use_id: string
  actor_agent_id: string
  status: CommandReceiptStatus
  reservations: Record<string, string>
  response?: unknown
  error?: string | null
  attempt: number
  lease_owner_id?: string | null
  lease_expires_at?: Date | null
  created_at: Date
  updated_at: Date
  completed_at?: Date | null
}

export interface AgentCommandContext {
  team_id: string
  user_id: string
  caller_agent_id: string
  run_id: string
  tool_use_id: string
  /** AgentRun lease owner. Required for model-issued control commands. */
  execution_owner_id?: string
  /** Session identity used when the background Team worker also owns Team fences. */
  agent_session_id?: string
  /** True for worker-pool Runs that must hold AgentRun + slot + session fences. */
  team_fence_required?: boolean
  /** Legacy/service tests may omit fences; every Agent-facing adapter sets this true. */
  require_execution_fence?: boolean
}

export interface AgentTeamSnapshot {
  team: AgentTeamRecord
  agents: TeamAgentRecord[]
  tasks: AgentTaskRecord[]
  results: AgentResultRecord[]
  proposals: WorkspaceProposalRecord[]
  messages?: AgentMailboxMessageRecord[]
  counts: {
    total_agents: number
    running_agents: number
    idle_agents: number
    completed_agents: number
    failed_agents: number
    active_tasks: number
    pending_results: number
  }
  latest_event_seq: number
}

export interface AgentWakeEvaluation {
  wait_id: string
  agent_id: string
  run_id: string
  status: Extract<AgentWaitStatus, 'triggered' | 'timed_out'>
  reason: string
  event_seq?: number
}

export interface AgentExecutionTelemetry {
  telemetry_id: string
  team_id: string
  conversation_id: string
  user_id: string
  agent_id: string
  task_id?: string | null
  run_id: string
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  /** USD dollars after converting the authoritative RMB-cent price ledger. */
  cost_usd: number
  tool_calls: number
  download_bytes: number
  /** Admission ids already folded into this per-Run reporting document. */
  applied_admission_ids?: string[]
  created_at: Date
  updated_at: Date
}

export type AgentBudgetAdmissionStatus =
  | 'reserved'
  | 'started'
  | 'settling'
  | 'completed'
  | 'releasing'
  | 'released'
  | 'abandoned'

export interface AgentBudgetUsageCounters {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  cost_usd: number
  tool_calls: number
  download_bytes: number
}

/**
 * A short-lived reservation embedded in the authoritative Team counter doc.
 * `reserved` may be rolled back; once `started`, a tool call is consumed even
 * if the executor crashes or the concrete tool returns an error.
 */
export interface AgentBudgetActiveReservation {
  admission_id: string
  admission_key: string
  kind: 'model' | 'compaction' | 'tool'
  label?: string | null
  conversation_id: string
  user_id: string
  agent_id: string
  task_id?: string | null
  run_id: string
  execution_owner_id: string
  agent_session_id?: string | null
  team_fence_required: boolean
  status: 'reserved' | 'started'
  attempt: number
  reserved_tool_calls: number
  created_at: Date
  started_at?: Date | null
}

/** One Mongo document is the admission authority for every scope in a Team. */
export interface AgentExecutionBudgetState {
  budget_state_id: string
  team_id: string
  conversation_id: string
  user_id: string
  team_usage: AgentBudgetUsageCounters
  /** Keys are SHA-256 digests of stable Agent ids, avoiding unsafe Mongo field names. */
  agent_usage: Record<string, AgentBudgetUsageCounters>
  /** Keys are SHA-256 digests of stable Task ids. */
  task_usage: Record<string, AgentBudgetUsageCounters>
  /** Keys are SHA-256 digests of admission ids. */
  active_reservations: Record<string, AgentBudgetActiveReservation>
  initialized_at: Date
  created_at: Date
  updated_at: Date
}

/** Durable receipt used to reconcile a reservation without Mongo transactions. */
export interface AgentBudgetAdmissionRecord {
  admission_id: string
  admission_key: string
  reservation_key: string
  team_id: string
  conversation_id: string
  user_id: string
  agent_id: string
  task_id?: string | null
  run_id: string
  execution_owner_id: string
  agent_session_id?: string | null
  team_fence_required: boolean
  kind: 'model' | 'compaction' | 'tool'
  label?: string | null
  status: AgentBudgetAdmissionStatus
  attempt: number
  reserved_tool_calls: number
  usage_delta: AgentBudgetUsageCounters
  /** False means the external call ended without authoritative usage data. */
  usage_observed: boolean
  created_at: Date
  updated_at: Date
  started_at?: Date | null
  completed_at?: Date | null
  released_at?: Date | null
  abandoned_at?: Date | null
  release_reason?: string | null
  attempt_history?: Array<{
    attempt: number
    status: AgentBudgetAdmissionStatus
    execution_owner_id: string
    reserved_tool_calls: number
    usage_delta: AgentBudgetUsageCounters
    usage_observed: boolean
    started_at?: Date | null
    completed_at?: Date | null
    released_at?: Date | null
    abandoned_at?: Date | null
    release_reason?: string | null
    archived_at: Date
  }>
}
