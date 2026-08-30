import mongoose, { Document, Schema, type Model } from 'mongoose'
import type {
  AgentRunCurrentAction,
  AgentRunLease,
  AgentRunLiveState,
  AgentRunPendingInput,
  AgentRunPendingInteraction,
  AgentRunRequest,
  AgentRunStatus,
  AgentRunTerminationReason,
  AgentRunTrigger,
  AgentRunExecutionMode,
  AgentRunFailureCategory,
  AgentRunFailureRecoverability,
  FrozenProjectContextSnapshot,
  FrozenProfileSnapshot,
  PersistentHippocampusState,
} from './types'

export interface ConversationRuntimeDocument extends Document {
  conversation_id: string
  user_id: string
  active_run_id?: string | null
  active_lease_owner_id?: string | null
  revision: number
  hippocampus: PersistentHippocampusState
  profile_snapshot?: FrozenProfileSnapshot | null
  project_context_snapshot?: FrozenProjectContextSnapshot | null
  created_at: Date
  updated_at: Date
}

export interface AgentRunDocument extends Document {
  run_id: string
  conversation_id: string
  user_id: string
  sequence: number
  status: AgentRunStatus
  active_key?: string
  team_id?: string
  agent_id?: string
  agent_session_id?: string
  task_id?: string
  trigger?: AgentRunTrigger
  model_alias_snapshot?: string
  policy_version?: number
  root_visible?: boolean
  execution_mode?: AgentRunExecutionMode
  request: AgentRunRequest
  pending_inputs: AgentRunPendingInput[]
  pending_interaction?: AgentRunPendingInteraction | null
  answered_interaction_ids: string[]
  started_message_id: string
  checkpoint_message_id?: string | null
  checkpoint_seq: number
  current_action?: AgentRunCurrentAction | null
  termination_reason?: AgentRunTerminationReason | null
  failure_recoverability?: AgentRunFailureRecoverability | null
  failure_category?: AgentRunFailureCategory | null
  failure_signature?: string | null
  cancellation_requested: boolean
  lease?: AgentRunLease | null
  live?: AgentRunLiveState | null
  recovery_count: number
  dispatch_attempts: number
  available_at?: Date | null
  last_error?: string | null
  memory_run_id?: string | null
  created_at: Date
  updated_at: Date
  finished_at?: Date | null
}

const ConversationRuntimeSchema = new Schema<ConversationRuntimeDocument>(
  {
    conversation_id: { type: String, required: true, unique: true, index: true },
    user_id: { type: String, required: true, index: true },
    active_run_id: { type: String, default: null, index: true },
    active_lease_owner_id: { type: String, default: null },
    revision: { type: Number, default: 0 },
    hippocampus: {
      type: Schema.Types.Mixed,
      default: {
        snapshot_version: 1,
        telemetry: null,
        rapid_refills: 0,
        turns_since_merge: 0,
      },
    },
    profile_snapshot: { type: Schema.Types.Mixed, default: null },
    project_context_snapshot: { type: Schema.Types.Mixed, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'conversation_runtimes',
  },
)

const AgentRunPendingInputSchema = new Schema<AgentRunPendingInput>(
  {
    message_id: { type: String, required: true },
    message: { type: String, required: true },
    images: { type: Schema.Types.Mixed, default: undefined },
    interaction_id: { type: String, default: undefined },
    visibility: { type: String, enum: ['public', 'internal'], default: 'public' },
    source_kind: {
      type: String,
      enum: ['user', 'agent', 'team_supervision'],
      default: 'user',
    },
    created_at: { type: Date, required: true },
  },
  { _id: false },
)

const AgentRunSchema = new Schema<AgentRunDocument>(
  {
    run_id: { type: String, required: true, unique: true, index: true },
    conversation_id: { type: String, required: true, index: true },
    user_id: { type: String, required: true, index: true },
    sequence: { type: Number, required: true },
    status: {
      type: String,
      enum: ['queued', 'running', 'waiting_user', 'waiting_agents', 'recoverable', 'completed', 'cancelled', 'failed'],
      required: true,
      index: true,
    },
    active_key: { type: String, default: undefined },
    team_id: { type: String, default: undefined, index: true },
    agent_id: { type: String, default: undefined, index: true },
    agent_session_id: { type: String, default: undefined, index: true },
    task_id: { type: String, default: undefined, index: true },
    trigger: {
      type: String,
      enum: ['user', 'task', 'message', 'supervision', 'reopen'],
      default: 'user',
    },
    model_alias_snapshot: { type: String, default: undefined },
    policy_version: { type: Number, default: undefined },
    root_visible: { type: Boolean, default: true },
    execution_mode: {
      type: String,
      enum: ['conversation', 'agent_session'],
      default: 'conversation',
    },
    request: { type: Schema.Types.Mixed, required: true },
    pending_inputs: { type: [AgentRunPendingInputSchema], default: [] },
    pending_interaction: { type: Schema.Types.Mixed, default: null },
    answered_interaction_ids: { type: [String], default: [] },
    started_message_id: { type: String, required: true },
    checkpoint_message_id: { type: String, default: null },
    checkpoint_seq: { type: Number, default: 0 },
    current_action: { type: Schema.Types.Mixed, default: null },
    termination_reason: {
      type: String,
      enum: ['model_finished', 'user_cancelled', 'max_turns', 'model_error', 'runtime_error', null],
      default: null,
    },
    failure_recoverability: {
      type: String,
      enum: ['transient', 'fatal', null],
      default: null,
    },
    failure_category: {
      type: String,
      enum: [
        'provider_transient',
        'message_format',
        'run_limit',
        'runtime_transient',
        'configuration',
        'identity_invariant',
        null,
      ],
      default: null,
    },
    failure_signature: { type: String, default: null, index: true },
    cancellation_requested: { type: Boolean, default: false },
    lease: { type: Schema.Types.Mixed, default: null },
    live: { type: Schema.Types.Mixed, default: null },
    recovery_count: { type: Number, default: 0 },
    dispatch_attempts: { type: Number, default: 0 },
    available_at: { type: Date, default: null, index: true },
    last_error: { type: String, default: null },
    memory_run_id: { type: String, default: null },
    finished_at: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'agent_runs',
  },
)

AgentRunSchema.index({ conversation_id: 1, sequence: -1 })
AgentRunSchema.index(
  { agent_session_id: 1, sequence: -1 },
  {
    unique: true,
    partialFilterExpression: { agent_session_id: { $type: 'string' } },
  },
)
AgentRunSchema.index({ status: 1, available_at: 1, 'lease.expires_at': 1, created_at: 1 })
AgentRunSchema.index(
  { active_key: 1 },
  {
    unique: true,
    partialFilterExpression: { active_key: { $type: 'string' } },
  },
)

/**
 * Next.js keeps mongoose.models alive across development hot reloads. When a
 * schema gains a path, blindly reusing the cached model makes Mongoose strict
 * mode silently remove that path from updates until the whole dev server is
 * restarted. Runtime fencing cannot tolerate that: dropping
 * active_lease_owner_id makes every subsequent fenced write look like lease
 * loss even though AgentRun still owns the lease.
 *
 * Patch the cached schema in place for additive changes. Production processes
 * compile the current schema once and never enter this branch.
 */
function getConversationRuntimeModel(): Model<ConversationRuntimeDocument> {
  const existing = mongoose.models.ConversationRuntime as Model<ConversationRuntimeDocument> | undefined
  if (!existing) {
    return mongoose.model<ConversationRuntimeDocument>('ConversationRuntime', ConversationRuntimeSchema)
  }
  if (!existing.schema.path('active_lease_owner_id')) {
    existing.schema.add({
      active_lease_owner_id: { type: String, default: null },
    })
  }
  if (!existing.schema.path('project_context_snapshot')) {
    existing.schema.add({
      project_context_snapshot: { type: Schema.Types.Mixed, default: null },
    })
  }
  return existing
}

export const ConversationRuntime = getConversationRuntimeModel()

function getAgentRunModel(): Model<AgentRunDocument> {
  const existing = mongoose.models.AgentRun as Model<AgentRunDocument> | undefined
  if (!existing) {
    return mongoose.model<AgentRunDocument>('AgentRun', AgentRunSchema)
  }
  if (!existing.schema.path('dispatch_attempts')) {
    existing.schema.add({
      dispatch_attempts: { type: Number, default: 0 },
      available_at: { type: Date, default: null },
    })
  }
  if (!existing.schema.path('pending_interaction')) {
    existing.schema.add({ pending_interaction: { type: Schema.Types.Mixed, default: null } })
  }
  if (!existing.schema.path('answered_interaction_ids')) {
    existing.schema.add({ answered_interaction_ids: { type: [String], default: [] } })
  }
  if (!existing.schema.path('agent_session_id')) {
    existing.schema.add({
      team_id: { type: String, default: undefined },
      agent_id: { type: String, default: undefined },
      agent_session_id: { type: String, default: undefined },
      task_id: { type: String, default: undefined },
      trigger: { type: String, default: 'user' },
      model_alias_snapshot: { type: String, default: undefined },
      policy_version: { type: Number, default: undefined },
      root_visible: { type: Boolean, default: true },
      execution_mode: { type: String, default: 'conversation' },
    })
  }
  if (!existing.schema.path('failure_recoverability')) {
    existing.schema.add({
      failure_recoverability: { type: String, enum: ['transient', 'fatal', null], default: null },
      failure_category: {
        type: String,
        enum: [
          'provider_transient',
          'message_format',
          'run_limit',
          'runtime_transient',
          'configuration',
          'identity_invariant',
          null,
        ],
        default: null,
      },
      failure_signature: { type: String, default: null },
    })
  }
  return existing
}

export const AgentRun = getAgentRunModel()
