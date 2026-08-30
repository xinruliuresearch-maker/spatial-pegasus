import mongoose, { Schema, type Model } from 'mongoose'
import type {
  AgentExecutionSlotRecord,
  AgentExecutionBudgetState,
  AgentBudgetAdmissionRecord,
  AgentExecutionTelemetry,
  AgentMailboxMessageRecord,
  AgentResultRecord,
  AgentSessionRuntimeRecord,
  AgentTaskRecord,
  AgentTeamRecord,
  AgentWaitSubscriptionRecord,
  CommandReceiptRecord,
  DelegationGrantRecord,
  TeamAgentRecord,
  TeamEventRecord,
  TeamSupervisionBatchRecord,
  WorkspaceProposalRecord,
} from './types'

const timestamps = { createdAt: 'created_at', updatedAt: 'updated_at' } as const

const AgentTeamSchema = new Schema({
  team_id: { type: String, required: true, unique: true, index: true },
  conversation_id: { type: String, required: true, index: true },
  user_id: { type: String, required: true, index: true },
  root_agent_id: { type: String, required: true },
  workspace_id: { type: String, required: true, index: true },
  status: { type: String, enum: ['active', 'completed'], required: true, index: true },
  policy: { type: Schema.Types.Mixed, required: true },
  next_event_seq: { type: Number, default: 0 },
  supervision_cursor: { type: Number, default: 0 },
  supervision_lease_owner_id: { type: String, default: null },
  supervision_lease_token: { type: String, default: null },
  supervision_lease_expires_at: { type: Date, default: null },
  completed_at: { type: Date, default: null },
}, {
  timestamps,
  collection: 'agent_teams',
})
AgentTeamSchema.index({ user_id: 1, conversation_id: 1 }, { unique: true })

const TeamAgentSchema = new Schema({
  agent_id: { type: String, required: true, unique: true, index: true },
  team_id: { type: String, required: true, index: true },
  conversation_id: { type: String, required: true, index: true },
  user_id: { type: String, required: true, index: true },
  slot: { type: Number, required: true },
  display_name: { type: String, required: true },
  normalized_name: { type: String, required: true },
  role: { type: String, required: true },
  instructions: { type: String, default: null },
  is_root: { type: Boolean, required: true, index: true },
  created_by_agent_id: { type: String, default: null },
  status: {
    type: String,
    enum: ['running', 'idle', 'paused', 'completed', 'failed'],
    required: true,
    index: true,
  },
  generation: { type: Number, required: true },
  current_session_id: { type: String, required: true, index: true },
  active_grant_id: { type: String, required: true },
  grant_version: { type: Number, required: true },
  private_workspace_prefix: { type: String, required: true },
  creation_command_key: { type: String, default: null },
  last_command_key: { type: String, default: null },
  last_transition_at: { type: Date, required: true },
  last_progress_at: { type: Date, default: null },
  progress_snapshot: { type: Schema.Types.Mixed, default: null },
  interrupt_requested_at: { type: Date, default: null },
  completed_at: { type: Date, default: null },
}, {
  timestamps,
  collection: 'team_agents',
})
TeamAgentSchema.index({ team_id: 1, slot: 1 }, { unique: true })
TeamAgentSchema.index({ team_id: 1, normalized_name: 1 }, { unique: true })
TeamAgentSchema.index(
  { team_id: 1, creation_command_key: 1 },
  { unique: true, partialFilterExpression: { creation_command_key: { $type: 'string' } } },
)

const AgentSessionRuntimeSchema = new Schema({
  session_id: { type: String, required: true, unique: true, index: true },
  team_id: { type: String, required: true, index: true },
  conversation_id: { type: String, required: true, index: true },
  user_id: { type: String, required: true, index: true },
  agent_id: { type: String, required: true, index: true },
  generation: { type: Number, required: true },
  active_run_id: { type: String, default: null },
  active_lease_owner_id: { type: String, default: null },
  run_lease: { type: Schema.Types.Mixed, default: null },
  revision: { type: Number, default: 0 },
  context_revision: { type: Number, default: 0 },
  last_applied_compaction_id: { type: String, default: null },
  context_compaction_fence: { type: Schema.Types.Mixed, default: null },
  messages: { type: [Schema.Types.Mixed], default: [] },
  compacted_messages: { type: [Schema.Types.Mixed], default: [] },
  hippocampus: { type: Schema.Types.Mixed, default: {} },
  model_snapshot: { type: Schema.Types.Mixed, default: null },
}, {
  timestamps,
  collection: 'agent_session_runtimes',
})
AgentSessionRuntimeSchema.index({ team_id: 1, agent_id: 1, generation: 1 }, { unique: true })
AgentSessionRuntimeSchema.index(
  { active_run_id: 1 },
  { unique: true, partialFilterExpression: { active_run_id: { $type: 'string' } } },
)

const DelegationGrantSchema = new Schema({
  grant_id: { type: String, required: true, unique: true, index: true },
  team_id: { type: String, required: true, index: true },
  user_id: { type: String, required: true, index: true },
  agent_id: { type: String, required: true, index: true },
  version: { type: Number, required: true },
  active_key: { type: String, default: null },
  granted_by_agent_id: { type: String, required: true },
  reason: { type: String, default: null },
  capabilities: { type: Schema.Types.Mixed, required: true },
  allowed_tool_names: { type: [String], default: [] },
  allowed_read_paths: { type: [String], default: [] },
  budget: { type: Schema.Types.Mixed, default: null },
  created_at: { type: Date, default: Date.now },
  revoked_at: { type: Date, default: null },
}, {
  collection: 'agent_delegation_grants',
  versionKey: false,
})
DelegationGrantSchema.index({ team_id: 1, agent_id: 1, version: 1 }, { unique: true })
DelegationGrantSchema.index(
  { active_key: 1 },
  { unique: true, partialFilterExpression: { active_key: { $type: 'string' } } },
)

const AgentTaskSchema = new Schema({
  task_id: { type: String, required: true, unique: true, index: true },
  team_id: { type: String, required: true, index: true },
  conversation_id: { type: String, required: true, index: true },
  user_id: { type: String, required: true, index: true },
  title: { type: String, required: true },
  objective: { type: String, required: true },
  acceptance_criteria: { type: [String], default: [] },
  context_refs: { type: [Schema.Types.Mixed], default: [] },
  assigned_agent_id: { type: String, required: true, index: true },
  created_by_agent_id: { type: String, required: true },
  dependency_task_ids: { type: [String], default: [] },
  status: {
    type: String,
    enum: ['queued', 'running', 'waiting', 'submitted', 'accepted', 'rework', 'failed', 'cancelled'],
    required: true,
    index: true,
  },
  waiting_kind: {
    type: String,
    enum: ['dependencies', 'manual'],
    default: null,
  },
  budget: { type: Schema.Types.Mixed, default: null },
  result_ids: { type: [String], default: [] },
  active_result_id: { type: String, default: null },
  creation_command_key: { type: String, default: null },
  last_command_key: { type: String, default: null },
  started_at: { type: Date, default: null },
  submitted_at: { type: Date, default: null },
  completed_at: { type: Date, default: null },
}, {
  timestamps,
  collection: 'agent_tasks',
})
AgentTaskSchema.index({ team_id: 1, assigned_agent_id: 1, status: 1, waiting_kind: 1, created_at: 1 })
AgentTaskSchema.index(
  { team_id: 1, creation_command_key: 1 },
  { unique: true, partialFilterExpression: { creation_command_key: { $type: 'string' } } },
)

const MailboxDeliverySchema = new Schema({
  agent_id: { type: String, required: true },
  kind: { type: String, enum: ['primary', 'root_observer'], required: true },
  status: { type: String, enum: ['pending', 'claimed', 'acknowledged'], required: true },
  claim_id: { type: String, default: null },
  claimed_at: { type: Date, default: null },
  acknowledged_at: { type: Date, default: null },
}, { _id: false })

const AgentMailboxMessageSchema = new Schema({
  message_id: { type: String, required: true, unique: true, index: true },
  team_id: { type: String, required: true, index: true },
  conversation_id: { type: String, required: true, index: true },
  user_id: { type: String, required: true, index: true },
  sender_agent_id: { type: String, required: true, index: true },
  recipient_agent_id: { type: String, required: true, index: true },
  sender_name: { type: String, default: null },
  recipient_name: { type: String, default: null },
  task_id: { type: String, default: null, index: true },
  correlation_id: { type: String, default: null, index: true },
  reply_to_message_id: { type: String, default: null },
  kind: {
    type: String,
    enum: ['info', 'request', 'review', 'response', 'progress', 'blocker', 'error'],
    required: true,
    index: true,
  },
  summary: { type: String, default: null },
  content: { type: String, required: true },
  attachments: { type: [Schema.Types.Mixed], default: [] },
  deliveries: { type: [MailboxDeliverySchema], default: [] },
  creation_command_key: { type: String, default: null },
  created_at: { type: Date, default: Date.now, index: true },
}, {
  collection: 'agent_mailbox_messages',
  versionKey: false,
})
AgentMailboxMessageSchema.index({ team_id: 1, 'deliveries.agent_id': 1, 'deliveries.status': 1, created_at: 1 })
AgentMailboxMessageSchema.index(
  { team_id: 1, creation_command_key: 1 },
  { unique: true, partialFilterExpression: { creation_command_key: { $type: 'string' } } },
)

const AgentResultSchema = new Schema({
  result_id: { type: String, required: true, unique: true, index: true },
  team_id: { type: String, required: true, index: true },
  conversation_id: { type: String, required: true, index: true },
  user_id: { type: String, required: true, index: true },
  // A conversational Agent turn can produce a durable result without a
  // formal task ledger entry. Existing task-backed records remain unchanged.
  task_id: { type: String, default: null, index: true },
  agent_id: { type: String, required: true, index: true },
  run_id: { type: String, required: true, index: true },
  outcome: {
    type: String,
    enum: ['completed', 'blocked', 'failed'],
    required: true,
    default: 'completed',
  },
  final_response: { type: String, required: true },
  summary: { type: Schema.Types.Mixed, default: {} },
  evidence_refs: { type: [Schema.Types.Mixed], default: [] },
  files: { type: [Schema.Types.Mixed], default: [] },
  proposal_ids: { type: [String], default: [] },
  implicit: { type: Boolean, default: false },
  creation_command_key: { type: String, default: null },
  created_at: { type: Date, default: Date.now },
}, {
  collection: 'agent_results',
  versionKey: false,
})
AgentResultSchema.index(
  { team_id: 1, creation_command_key: 1 },
  { unique: true, partialFilterExpression: { creation_command_key: { $type: 'string' } } },
)

const WorkspaceProposalSchema = new Schema({
  proposal_id: { type: String, required: true, unique: true, index: true },
  team_id: { type: String, required: true, index: true },
  conversation_id: { type: String, required: true, index: true },
  user_id: { type: String, required: true, index: true },
  result_id: { type: String, required: true, index: true },
  task_id: { type: String, default: null, index: true },
  agent_id: { type: String, required: true, index: true },
  source_path: { type: String, required: true },
  target_path: { type: String, required: true },
  expected_target_revision: { type: Number, default: null },
  source_sha256: { type: String, default: null },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'published', 'conflict'],
    required: true,
    index: true,
  },
  review_note: { type: String, default: null },
  reviewed_by_agent_id: { type: String, default: null },
  reviewed_at: { type: Date, default: null },
  review_command_key: { type: String, default: null },
  published_revision: { type: Number, default: null },
}, {
  timestamps,
  collection: 'workspace_proposals',
})
WorkspaceProposalSchema.index({ result_id: 1, source_path: 1, target_path: 1 }, { unique: true })

const AgentWaitSubscriptionSchema = new Schema({
  wait_id: { type: String, required: true, unique: true, index: true },
  team_id: { type: String, required: true, index: true },
  conversation_id: { type: String, required: true, index: true },
  user_id: { type: String, required: true, index: true },
  agent_id: { type: String, required: true, index: true },
  run_id: { type: String, required: true, index: true },
  task_ids: { type: [String], default: [] },
  mode: { type: String, enum: ['all', 'any'], required: true },
  status: { type: String, enum: ['waiting', 'triggered', 'timed_out', 'cancelled'], required: true, index: true },
  after_event_seq: { type: Number, required: true },
  deadline_at: { type: Date, required: true, index: true },
  trigger_reason: { type: String, default: null },
  triggered_event_seq: { type: Number, default: null },
  creation_command_key: { type: String, default: null },
  resolved_at: { type: Date, default: null },
  wake_delivered_at: { type: Date, default: null },
}, {
  timestamps,
  collection: 'agent_wait_subscriptions',
})
AgentWaitSubscriptionSchema.index({ team_id: 1, agent_id: 1, status: 1, deadline_at: 1 })
AgentWaitSubscriptionSchema.index(
  { team_id: 1, creation_command_key: 1 },
  { unique: true, partialFilterExpression: { creation_command_key: { $type: 'string' } } },
)

const TeamEventSchema = new Schema({
  event_id: { type: String, required: true, unique: true, index: true },
  team_id: { type: String, required: true, index: true },
  conversation_id: { type: String, required: true, index: true },
  user_id: { type: String, required: true, index: true },
  seq: { type: Number, required: true },
  type: { type: String, required: true, index: true },
  actor_agent_id: { type: String, default: null },
  subject_agent_id: { type: String, default: null },
  task_id: { type: String, default: null },
  run_id: { type: String, default: null },
  payload: { type: Schema.Types.Mixed, default: {} },
  dedupe_key: { type: String, default: null },
  created_at: { type: Date, default: Date.now, index: true },
}, {
  collection: 'team_events',
  versionKey: false,
})
TeamEventSchema.index({ team_id: 1, seq: 1 }, { unique: true })
TeamEventSchema.index(
  { team_id: 1, dedupe_key: 1 },
  { unique: true, partialFilterExpression: { dedupe_key: { $type: 'string' } } },
)

const TeamSupervisionBatchSchema = new Schema({
  batch_id: { type: String, required: true, unique: true, index: true },
  team_id: { type: String, required: true, index: true },
  user_id: { type: String, required: true, index: true },
  after_seq: { type: Number, required: true, min: 0 },
  through_seq: { type: Number, required: true, min: 1 },
  events: { type: [Schema.Types.Mixed], default: [] },
  message_ids: { type: [String], default: [] },
  delivered_run_id: { type: String, default: null },
  delivered_at: { type: Date, default: null },
}, {
  timestamps,
  collection: 'team_supervision_batches',
})
TeamSupervisionBatchSchema.index({ team_id: 1, after_seq: 1 }, { unique: true })

const CommandReceiptSchema = new Schema({
  receipt_id: { type: String, required: true, unique: true, index: true },
  team_id: { type: String, required: true, index: true },
  user_id: { type: String, required: true, index: true },
  command_key: { type: String, required: true },
  command_name: { type: String, required: true },
  run_id: { type: String, required: true, index: true },
  tool_use_id: { type: String, required: true },
  actor_agent_id: { type: String, required: true },
  status: { type: String, enum: ['processing', 'completed', 'failed'], required: true, index: true },
  reservations: { type: Schema.Types.Mixed, default: {} },
  response: { type: Schema.Types.Mixed, default: null },
  error: { type: String, default: null },
  attempt: { type: Number, default: 1 },
  lease_owner_id: { type: String, default: null },
  lease_expires_at: { type: Date, default: null },
  completed_at: { type: Date, default: null },
}, {
  timestamps,
  collection: 'agent_command_receipts',
})
CommandReceiptSchema.index({ team_id: 1, command_key: 1 }, { unique: true })

const AgentExecutionSlotSchema = new Schema({
  execution_slot_id: { type: String, required: true, unique: true, index: true },
  team_id: { type: String, required: true, index: true },
  user_id: { type: String, required: true, index: true },
  slot: { type: Number, required: true },
  agent_id: { type: String, required: true, index: true },
  session_id: { type: String, required: true, index: true },
  run_id: { type: String, required: true, unique: true, index: true },
  owner_id: { type: String, required: true },
  fence_token: { type: String, required: true },
  heartbeat_at: { type: Date, required: true },
  expires_at: { type: Date, required: true, index: true },
}, {
  timestamps,
  collection: 'agent_execution_slots',
})
AgentExecutionSlotSchema.index({ team_id: 1, slot: 1 }, { unique: true })

const AgentExecutionTelemetrySchema = new Schema({
  telemetry_id: { type: String, required: true, unique: true, index: true },
  team_id: { type: String, required: true, index: true },
  conversation_id: { type: String, required: true, index: true },
  user_id: { type: String, required: true, index: true },
  agent_id: { type: String, required: true, index: true },
  task_id: { type: String, default: null, index: true },
  run_id: { type: String, required: true, unique: true, index: true },
  input_tokens: { type: Number, default: 0, min: 0 },
  output_tokens: { type: Number, default: 0, min: 0 },
  cache_creation_input_tokens: { type: Number, default: 0, min: 0 },
  cache_read_input_tokens: { type: Number, default: 0, min: 0 },
  cost_usd: { type: Number, default: 0, min: 0 },
  tool_calls: { type: Number, default: 0, min: 0 },
  download_bytes: { type: Number, default: 0, min: 0 },
  applied_admission_ids: { type: [String], default: [] },
}, {
  timestamps,
  collection: 'agent_execution_telemetry',
})
AgentExecutionTelemetrySchema.index({ team_id: 1, updated_at: -1 })
AgentExecutionTelemetrySchema.index({ team_id: 1, agent_id: 1, updated_at: -1 })
AgentExecutionTelemetrySchema.index({ team_id: 1, task_id: 1, updated_at: -1 })

const AgentExecutionBudgetStateSchema = new Schema({
  budget_state_id: { type: String, required: true, unique: true, index: true },
  team_id: { type: String, required: true, unique: true, index: true },
  conversation_id: { type: String, required: true, index: true },
  user_id: { type: String, required: true, index: true },
  team_usage: { type: Schema.Types.Mixed, required: true },
  agent_usage: { type: Schema.Types.Mixed, default: {} },
  task_usage: { type: Schema.Types.Mixed, default: {} },
  active_reservations: { type: Schema.Types.Mixed, default: {} },
  initialized_at: { type: Date, required: true },
}, {
  timestamps,
  collection: 'agent_execution_budget_states',
})

const AgentBudgetAdmissionSchema = new Schema({
  admission_id: { type: String, required: true, unique: true, index: true },
  admission_key: { type: String, required: true },
  reservation_key: { type: String, required: true },
  team_id: { type: String, required: true, index: true },
  conversation_id: { type: String, required: true, index: true },
  user_id: { type: String, required: true, index: true },
  agent_id: { type: String, required: true, index: true },
  task_id: { type: String, default: null, index: true },
  run_id: { type: String, required: true, index: true },
  execution_owner_id: { type: String, required: true },
  agent_session_id: { type: String, default: null },
  team_fence_required: { type: Boolean, required: true },
  kind: { type: String, enum: ['model', 'compaction', 'tool'], required: true },
  label: { type: String, default: null },
  status: {
    type: String,
    enum: ['reserved', 'started', 'settling', 'completed', 'releasing', 'released', 'abandoned'],
    required: true,
    index: true,
  },
  attempt: { type: Number, required: true, min: 1 },
  reserved_tool_calls: { type: Number, required: true, min: 0 },
  usage_delta: { type: Schema.Types.Mixed, required: true },
  usage_observed: { type: Boolean, required: true },
  started_at: { type: Date, default: null },
  completed_at: { type: Date, default: null },
  released_at: { type: Date, default: null },
  abandoned_at: { type: Date, default: null },
  release_reason: { type: String, default: null },
  attempt_history: { type: [Schema.Types.Mixed], default: [] },
}, {
  timestamps,
  collection: 'agent_budget_admissions',
})
AgentBudgetAdmissionSchema.index({ team_id: 1, status: 1, updated_at: 1 })
AgentBudgetAdmissionSchema.index({ run_id: 1, status: 1 })

function model<T>(name: string, schema: Schema): Model<T> {
  return (mongoose.models[name] as Model<T> | undefined)
    ?? mongoose.model<T>(name, schema as Schema<T>)
}

export const AgentTeamModel = model<AgentTeamRecord>('AgentTeamV1', AgentTeamSchema)
if (!AgentTeamModel.schema.path('supervision_lease_owner_id')) {
  AgentTeamModel.schema.add({
    supervision_lease_owner_id: { type: String, default: null },
    supervision_lease_token: { type: String, default: null },
    supervision_lease_expires_at: { type: Date, default: null },
  })
}
export const TeamAgentModel = model<TeamAgentRecord>('TeamAgentV1', TeamAgentSchema)
export const AgentSessionRuntimeModel = model<AgentSessionRuntimeRecord>('AgentSessionRuntimeV1', AgentSessionRuntimeSchema)
if (!AgentSessionRuntimeModel.schema.path('context_revision')) {
  AgentSessionRuntimeModel.schema.add({
    context_revision: { type: Number, default: 0 },
    last_applied_compaction_id: { type: String, default: null },
    context_compaction_fence: { type: Schema.Types.Mixed, default: null },
  })
}
export const DelegationGrantModel = model<DelegationGrantRecord>('DelegationGrantV1', DelegationGrantSchema)
export const AgentTaskModel = model<AgentTaskRecord>('AgentTaskV1', AgentTaskSchema)
export const AgentMailboxMessageModel = model<AgentMailboxMessageRecord>('AgentMailboxMessageV1', AgentMailboxMessageSchema)
export const AgentResultModel = model<AgentResultRecord>('AgentResultV1', AgentResultSchema)
export const WorkspaceProposalModel = model<WorkspaceProposalRecord>('WorkspaceProposalV1', WorkspaceProposalSchema)
export const AgentWaitSubscriptionModel = model<AgentWaitSubscriptionRecord>('AgentWaitSubscriptionV1', AgentWaitSubscriptionSchema)
export const TeamEventModel = model<TeamEventRecord>('TeamEventV1', TeamEventSchema)
export const TeamSupervisionBatchModel = model<TeamSupervisionBatchRecord>(
  'TeamSupervisionBatchV1',
  TeamSupervisionBatchSchema,
)
export const AgentCommandReceiptModel = model<CommandReceiptRecord>('AgentCommandReceiptV1', CommandReceiptSchema)
export const AgentExecutionSlotModel = model<AgentExecutionSlotRecord>('AgentExecutionSlotV1', AgentExecutionSlotSchema)
export const AgentExecutionTelemetryModel = model<AgentExecutionTelemetry>('AgentExecutionTelemetryV1', AgentExecutionTelemetrySchema)
export const AgentExecutionBudgetStateModel = model<AgentExecutionBudgetState>(
  'AgentExecutionBudgetStateV1',
  AgentExecutionBudgetStateSchema,
)
export const AgentBudgetAdmissionModel = model<AgentBudgetAdmissionRecord>(
  'AgentBudgetAdmissionV1',
  AgentBudgetAdmissionSchema,
)

export const AGENT_TEAM_MODELS = [
  AgentTeamModel,
  TeamAgentModel,
  AgentSessionRuntimeModel,
  DelegationGrantModel,
  AgentTaskModel,
  AgentMailboxMessageModel,
  AgentResultModel,
  WorkspaceProposalModel,
  AgentWaitSubscriptionModel,
  TeamEventModel,
  TeamSupervisionBatchModel,
  AgentCommandReceiptModel,
  AgentExecutionSlotModel,
  AgentExecutionTelemetryModel,
  AgentExecutionBudgetStateModel,
  AgentBudgetAdmissionModel,
] as const
