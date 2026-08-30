import { randomUUID } from 'crypto'
import { connectDB } from '../db/mongodb'
import { AgentRun, ConversationRuntime, type AgentRunDocument, type ConversationRuntimeDocument } from './models'
import type {
  CompactionCheckpoint,
  AgentRunCurrentAction,
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
import type {
  HippocampusSafetyState,
  HippocampusTelemetryState,
} from '../agent/hippocampus-runtime'
import {
  dispatchRetryDelayMs,
  MAX_DISPATCH_ATTEMPTS,
} from './dispatch-policy'
import { deleteCompactionJobsForConversation } from '../agent-compaction/repository'
import { agentRunFailureSignature } from './failure-policy'

const DEFAULT_LEASE_MS = 45_000
const RUNTIME_FENCE_ERROR = 'ConversationRuntime lease fence could not be established.'

export class ActiveAgentRunError extends Error {
  readonly code = 'ACTIVE_AGENT_RUN'
  constructor(public readonly runId?: string) {
    super('Conversation already has an active agent run')
    this.name = 'ActiveAgentRunError'
  }
}

export class AgentRunLeaseLostError extends Error {
  readonly code = 'AGENT_RUN_LEASE_LOST'
  constructor(public readonly runId: string) {
    super(`AgentRun ${runId} is no longer owned by this executor`)
    this.name = 'AgentRunLeaseLostError'
  }
}

export function newAgentRunId(): string {
  return `run_${randomUUID()}`
}

async function establishRuntimeLeaseFence(
  run: AgentRunDocument,
  ownerId: string,
): Promise<boolean> {
  // Agent-session Runs are fenced by AgentRun.active_key + the owned Run
  // lease itself. Their durable AgentSessionRuntime lives in the team control
  // plane and must never overwrite the root ConversationRuntime pointer.
  if (run.execution_mode === 'agent_session') return true
  const runtime = await ConversationRuntime.findOneAndUpdate(
    { conversation_id: run.conversation_id, user_id: run.user_id },
    {
      $set: {
        active_run_id: run.run_id,
        active_lease_owner_id: ownerId,
      },
      $inc: { revision: 1 },
    },
    { returnDocument: 'after' },
  ).lean()

  return runtime?.active_run_id === run.run_id
    && runtime.active_lease_owner_id === ownerId
}

async function relinquishRunAfterFenceFailure(
  runIdValue: string,
  ownerId: string,
): Promise<void> {
  await AgentRun.updateOne(
    {
      run_id: runIdValue,
      status: 'running',
      'lease.owner_id': ownerId,
    },
    {
      $set: {
        status: 'recoverable',
        lease: null,
        last_error: RUNTIME_FENCE_ERROR,
      },
      $inc: { recovery_count: 1 },
    },
  )
}

export async function getOrCreateConversationRuntime(
  conversationId: string,
  userId: string,
  legacyTelemetry?: PersistentHippocampusState['telemetry'],
): Promise<ConversationRuntimeDocument> {
  await connectDB()
  return ConversationRuntime.findOneAndUpdate(
    { conversation_id: conversationId, user_id: userId },
    {
      $setOnInsert: {
        conversation_id: conversationId,
        user_id: userId,
        active_run_id: null,
        active_lease_owner_id: null,
        revision: 0,
        hippocampus: {
          snapshot_version: 1,
          telemetry: legacyTelemetry ?? null,
          rapid_refills: 0,
          turns_since_merge: 0,
        },
        project_context_snapshot: null,
      },
    },
    { upsert: true, returnDocument: 'after' },
  )
}

export async function getConversationRuntime(
  conversationId: string,
  userId: string,
): Promise<ConversationRuntimeDocument | null> {
  await connectDB()
  return ConversationRuntime.findOne({ conversation_id: conversationId, user_id: userId })
}

export async function updateRuntimeTelemetry(
  conversationId: string,
  userId: string,
  telemetry: HippocampusTelemetryState,
  activeRunId?: string,
  leaseOwnerId?: string,
): Promise<boolean> {
  await connectDB()
  const result = await ConversationRuntime.updateOne(
    {
      conversation_id: conversationId,
      user_id: userId,
      ...(activeRunId ? { active_run_id: activeRunId } : {}),
      ...(leaseOwnerId ? { active_lease_owner_id: leaseOwnerId } : {}),
    },
    {
      $set: { 'hippocampus.telemetry': telemetry },
      $inc: { 'hippocampus.snapshot_version': 1, revision: 1 },
    },
  )
  return result.matchedCount === 1
}

export async function updateRuntimeSafetyState(
  conversationId: string,
  userId: string,
  safety: HippocampusSafetyState,
  activeRunId?: string,
  leaseOwnerId?: string,
): Promise<boolean> {
  await connectDB()
  const result = await ConversationRuntime.updateOne(
    {
      conversation_id: conversationId,
      user_id: userId,
      ...(activeRunId ? { active_run_id: activeRunId } : {}),
      ...(leaseOwnerId ? { active_lease_owner_id: leaseOwnerId } : {}),
    },
    {
      $set: {
        'hippocampus.breaker_state': safety,
        'hippocampus.rapid_refills': safety.rapidRefills,
        'hippocampus.turns_since_merge': safety.turnsSinceMerge,
      },
      $inc: { revision: 1 },
    },
  )
  return result.matchedCount === 1
}

export async function updateRuntimeCompactionCheckpoint(
  conversationId: string,
  userId: string,
  checkpoint: CompactionCheckpoint | null,
  activeRunId?: string,
  leaseOwnerId?: string,
): Promise<boolean> {
  await connectDB()
  const update = checkpoint
    ? { $set: { 'hippocampus.active_compaction': checkpoint }, $inc: { revision: 1 } }
    : { $unset: { 'hippocampus.active_compaction': 1 }, $inc: { revision: 1 } }
  const result = await ConversationRuntime.updateOne(
    {
      conversation_id: conversationId,
      user_id: userId,
      ...(activeRunId ? { active_run_id: activeRunId } : {}),
      ...(leaseOwnerId ? { active_lease_owner_id: leaseOwnerId } : {}),
    },
    update,
  )
  return result.matchedCount === 1
}

export async function updateRuntimeProfileSnapshot(
  conversationId: string,
  userId: string,
  profileSnapshot: FrozenProfileSnapshot | null,
  activeRunId?: string,
  leaseOwnerId?: string,
): Promise<boolean> {
  await connectDB()
  const result = await ConversationRuntime.updateOne(
    {
      conversation_id: conversationId,
      user_id: userId,
      ...(activeRunId ? { active_run_id: activeRunId } : {}),
      ...(leaseOwnerId ? { active_lease_owner_id: leaseOwnerId } : {}),
    },
    { $set: { profile_snapshot: profileSnapshot }, $inc: { revision: 1 } },
  )
  return result.matchedCount === 1
}

/**
 * Replace the frozen Project Guide/workspace epoch. Optional Run and lease
 * predicates form the same ownership fence as the other Runtime writes, so a
 * stale executor cannot overwrite the snapshot after another Runner takes
 * over the Conversation.
 */
export async function updateRuntimeProjectContextSnapshot(
  conversationId: string,
  userId: string,
  projectContextSnapshot: FrozenProjectContextSnapshot | null,
  activeRunId?: string,
  leaseOwnerId?: string,
): Promise<boolean> {
  await connectDB()
  const result = await ConversationRuntime.updateOne(
    {
      conversation_id: conversationId,
      user_id: userId,
      ...(activeRunId ? { active_run_id: activeRunId } : {}),
      ...(leaseOwnerId ? { active_lease_owner_id: leaseOwnerId } : {}),
    },
    {
      $set: { project_context_snapshot: projectContextSnapshot },
      $inc: { revision: 1 },
    },
  )
  return result.matchedCount === 1
}

export async function createAgentRun(input: {
  runId?: string
  conversationId: string
  userId: string
  request: AgentRunRequest
  startedMessageId: string
  teamId?: string
  agentId?: string
  agentSessionId?: string
  taskId?: string
  trigger?: AgentRunTrigger
  modelAliasSnapshot?: string
  policyVersion?: number
  rootVisible?: boolean
  executionMode?: AgentRunExecutionMode
}): Promise<AgentRunDocument> {
  await connectDB()
  const sessionExecution = input.executionMode === 'agent_session'
  if (sessionExecution && !input.agentSessionId) {
    throw new Error('agent_session execution requires agentSessionId')
  }
  // Repository callers should not have to establish the Runtime separately.
  // This also covers old Conversations whose first V2 interaction creates the
  // Run before any other migration path has touched conversation_runtimes.
  if (input.executionMode !== 'agent_session') {
    await getOrCreateConversationRuntime(input.conversationId, input.userId)
  }
  const sequenceScope = input.agentSessionId
    ? { agent_session_id: input.agentSessionId }
    : { conversation_id: input.conversationId, agent_session_id: { $exists: false } }
  const latest = await AgentRun.findOne(sequenceScope)
    .sort({ sequence: -1 })
    .select('sequence')
    .lean()
  const id = input.runId ?? newAgentRunId()
  try {
    const run = await AgentRun.create({
      run_id: id,
      conversation_id: input.conversationId,
      user_id: input.userId,
      sequence: (latest?.sequence ?? 0) + 1,
      status: 'queued',
      // Root keeps the Conversation lifecycle key even though it also owns an
      // AgentSessionRuntime. Member Runs are independent and key activity by
      // session, allowing up to the team execution-slot limit in parallel.
      active_key: sessionExecution
        ? input.agentSessionId
        : input.conversationId,
      team_id: input.teamId,
      agent_id: input.agentId,
      agent_session_id: input.agentSessionId,
      task_id: input.taskId,
      trigger: input.trigger ?? 'user',
      model_alias_snapshot: input.modelAliasSnapshot,
      policy_version: input.policyVersion,
      root_visible: input.rootVisible ?? true,
      execution_mode: input.executionMode ?? 'conversation',
      request: input.request,
      started_message_id: input.startedMessageId,
      checkpoint_message_id: input.startedMessageId,
      checkpoint_seq: 0,
      cancellation_requested: false,
      recovery_count: 0,
      dispatch_attempts: 0,
      available_at: null,
    })
    if (input.executionMode !== 'agent_session') {
      await ConversationRuntime.updateOne(
        { conversation_id: input.conversationId, user_id: input.userId },
        {
          $set: {
            active_run_id: id,
            active_lease_owner_id: null,
          },
          $inc: { revision: 1 },
        },
      )
    }
    return run
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      const active = sessionExecution && input.agentSessionId
        ? await getActiveAgentRunForSession(input.agentSessionId, input.userId)
        : await getActiveAgentRun(input.conversationId, input.userId)
      throw new ActiveAgentRunError(active?.run_id)
    }
    throw error
  }
}

export async function getAgentRun(runIdValue: string, userId?: string): Promise<AgentRunDocument | null> {
  await connectDB()
  return AgentRun.findOne({
    run_id: runIdValue,
    ...(userId ? { user_id: userId } : {}),
  })
}

/** Lazily binds a pre-Team migration Run to its durable Root identity. */
export async function attachAgentRunTeamIdentity(input: {
  runId: string
  userId: string
  teamId: string
  agentId: string
  agentSessionId: string
  policyVersion: number
}): Promise<AgentRunDocument | null> {
  await connectDB()
  const existing = await AgentRun.findOne({ run_id: input.runId, user_id: input.userId })
  if (!existing) return null
  const bindings = [
    ['team_id', existing.team_id, input.teamId],
    ['agent_id', existing.agent_id, input.agentId],
    ['agent_session_id', existing.agent_session_id, input.agentSessionId],
  ] as const
  const mismatch = bindings.find(([, current, expected]) => current && current !== expected)
  if (mismatch) {
    throw new Error(`Agent Run ${input.runId} already belongs to a different ${mismatch[0]}.`)
  }
  return AgentRun.findOneAndUpdate(
    { run_id: input.runId, user_id: input.userId },
    {
      $set: {
        team_id: input.teamId,
        agent_id: input.agentId,
        agent_session_id: input.agentSessionId,
        policy_version: existing.policy_version ?? input.policyVersion,
        root_visible: true,
        execution_mode: 'conversation',
      },
    },
    { returnDocument: 'after' },
  )
}

/** Freeze the model alias once per Run; retries always reuse the winner. */
export async function freezeAgentRunModelAlias(
  runIdValue: string,
  userId: string,
  leaseOwnerId: string,
  proposedAlias: string,
): Promise<string> {
  await connectDB()
  const run = await AgentRun.findOneAndUpdate(
    {
      run_id: runIdValue,
      user_id: userId,
      status: 'running',
      'lease.owner_id': leaseOwnerId,
      $or: [
        { model_alias_snapshot: { $exists: false } },
        { model_alias_snapshot: null },
        { model_alias_snapshot: '' },
      ],
    },
    { $set: { model_alias_snapshot: proposedAlias } },
    { returnDocument: 'after' },
  ).lean<Pick<AgentRunDocument, 'model_alias_snapshot'>>()
  if (run?.model_alias_snapshot) return run.model_alias_snapshot
  const existing = await AgentRun.findOne({
    run_id: runIdValue,
    user_id: userId,
    status: 'running',
    'lease.owner_id': leaseOwnerId,
  }).select('model_alias_snapshot').lean<Pick<AgentRunDocument, 'model_alias_snapshot'>>()
  if (!existing) throw new AgentRunLeaseLostError(runIdValue)
  if (!existing.model_alias_snapshot) {
    throw new Error(`Agent Run ${runIdValue} could not freeze its model alias.`)
  }
  return existing.model_alias_snapshot
}

export async function getActiveAgentRun(
  conversationId: string,
  userId: string,
): Promise<AgentRunDocument | null> {
  await connectDB()
  return AgentRun.findOne({
    conversation_id: conversationId,
    user_id: userId,
    active_key: conversationId,
  }).sort({ sequence: -1 })
}

export async function getActiveAgentRunForSession(
  agentSessionId: string,
  userId: string,
): Promise<AgentRunDocument | null> {
  await connectDB()
  return AgentRun.findOne({
    agent_session_id: agentSessionId,
    user_id: userId,
    active_key: agentSessionId,
  }).sort({ sequence: -1 })
}

export async function getLatestAgentRun(
  conversationId: string,
  userId: string,
): Promise<AgentRunDocument | null> {
  await connectDB()
  return AgentRun.findOne({
    conversation_id: conversationId,
    user_id: userId,
    // Member Runs share the project Conversation id, but they are private
    // session executions. Public Conversation lifecycle flags must describe
    // the Root loop only; comparing per-session sequence numbers would also
    // make an arbitrary long-lived member look like the newest public Run.
    execution_mode: { $ne: 'agent_session' },
  }).sort({ sequence: -1 })
}

export interface LatestAgentRunState {
  run_id: string
  status: AgentRunStatus
}

/**
 * Return the newest Run state for every Conversation in one aggregation.
 * Conversation list responses use this as the lifecycle authority while the
 * legacy Conversation flags remain a read-only fallback for pre-V2 data.
 */
export async function listLatestAgentRunStatesForUser(
  userId: string,
): Promise<Map<string, LatestAgentRunState>> {
  await connectDB()
  const rows = await AgentRun.aggregate<{
    _id: string
    run_id: string
    status: AgentRunStatus
  }>([
    {
      $match: {
        user_id: userId,
        execution_mode: { $ne: 'agent_session' },
      },
    },
    { $sort: { conversation_id: 1, sequence: -1 } },
    {
      $group: {
        _id: '$conversation_id',
        run_id: { $first: '$run_id' },
        status: { $first: '$status' },
      },
    },
  ])
  return new Map(rows.map(row => [row._id, {
    run_id: row.run_id,
    status: row.status,
  }]))
}

export async function listActiveRunConversationIds(userId: string): Promise<Set<string>> {
  await connectDB()
  const docs = await AgentRun.find({
    user_id: userId,
    active_key: { $type: 'string' },
    execution_mode: { $ne: 'agent_session' },
  }).select('conversation_id').lean()
  return new Set(docs.map(doc => doc.conversation_id))
}

export async function countActiveAgentRunsForUser(
  userId: string,
  excludeRunId?: string,
): Promise<number> {
  await connectDB()
  return AgentRun.countDocuments({
    user_id: userId,
    active_key: { $type: 'string' },
    status: { $in: ['queued', 'running'] },
    // This feeds the user-facing "concurrent conversations" admission gate.
    // Member Runs may be queued for every persistent identity (up to 31),
    // while their real execution concurrency is fenced independently by the
    // Team's eight slots and budget ledger. Counting those private Runs here
    // would prevent the user from sending a Root correction exactly when a
    // large team is working.
    execution_mode: { $ne: 'agent_session' },
    ...(excludeRunId ? { run_id: { $ne: excludeRunId } } : {}),
  })
}

export async function findAgentRunWithInteractionAnswer(
  conversationId: string,
  userId: string,
  interactionId: string,
): Promise<AgentRunDocument | null> {
  await connectDB()
  return AgentRun.findOne({
    conversation_id: conversationId,
    user_id: userId,
    $or: [
      { answered_interaction_ids: interactionId },
      { 'pending_inputs.interaction_id': interactionId },
    ],
  }).sort({ sequence: -1 })
}

export async function resumeWaitingAgentRun(
  runIdValue: string,
  userId: string,
  pendingInput?: AgentRunPendingInput,
): Promise<AgentRunDocument | null> {
  await connectDB()
  if (pendingInput?.interaction_id) {
    const existing = await AgentRun.findOne({
      run_id: runIdValue,
      user_id: userId,
      'pending_inputs.interaction_id': pendingInput.interaction_id,
    })
    if (existing) return existing
  }
  return AgentRun.findOneAndUpdate(
    {
      run_id: runIdValue,
      user_id: userId,
      status: { $in: ['waiting_user', 'waiting_agents', 'recoverable'] },
      cancellation_requested: { $ne: true },
      ...(pendingInput?.interaction_id
        ? { 'pending_interaction.interaction_id': pendingInput.interaction_id }
        : {}),
    },
    {
      $set: {
        status: 'queued',
        lease: null,
        last_error: null,
        dispatch_attempts: 0,
        available_at: null,
      },
      ...(pendingInput ? { $push: { pending_inputs: pendingInput } } : {}),
      ...(pendingInput?.interaction_id
        ? { $addToSet: { answered_interaction_ids: pendingInput.interaction_id } }
        : {}),
      ...(pendingInput ? { $unset: { pending_interaction: 1 } } : {}),
    },
    { returnDocument: 'after' },
  )
}

export async function setRunPendingInteraction(
  runIdValue: string,
  interaction: AgentRunPendingInteraction,
  leaseOwnerId?: string,
): Promise<boolean> {
  await connectDB()
  const result = await AgentRun.updateOne(
    {
      run_id: runIdValue,
      ...(leaseOwnerId ? { status: 'running', 'lease.owner_id': leaseOwnerId } : {}),
    },
    { $set: { pending_interaction: interaction } },
  )
  return result.matchedCount === 1
}

export async function acknowledgeRunPendingInputs(
  runIdValue: string,
  messageIds: string[],
  leaseOwnerId: string,
): Promise<boolean> {
  if (messageIds.length === 0) return true
  await connectDB()
  const result = await AgentRun.updateOne(
    {
      run_id: runIdValue,
      status: 'running',
      'lease.owner_id': leaseOwnerId,
    },
    {
      $pull: {
        pending_inputs: {
          message_id: { $in: messageIds },
        },
      },
    },
  )
  return result.matchedCount === 1
}

export async function queueRecoverableAgentRun(
  runIdValue: string,
  userId: string,
): Promise<AgentRunDocument | null> {
  await connectDB()
  return AgentRun.findOneAndUpdate(
    {
      run_id: runIdValue,
      user_id: userId,
      status: 'recoverable',
      cancellation_requested: { $ne: true },
    },
    {
      $set: {
        status: 'queued',
        lease: null,
        last_error: null,
        dispatch_attempts: 0,
        available_at: null,
      },
    },
    { returnDocument: 'after' },
  )
}

export async function claimAgentRun(
  runIdValue: string,
  ownerId: string,
  leaseMs = DEFAULT_LEASE_MS,
): Promise<AgentRunDocument | null> {
  await connectDB()
  const now = new Date()
  const run = await AgentRun.findOneAndUpdate(
    {
      run_id: runIdValue,
      status: { $in: ['queued', 'running', 'recoverable'] },
      cancellation_requested: { $ne: true },
      $or: [
        { lease: null },
        { 'lease.expires_at': { $lte: now } },
        { 'lease.owner_id': ownerId },
      ],
    },
    {
      $set: {
        status: 'running',
        lease: {
          owner_id: ownerId,
          heartbeat_at: now,
          expires_at: new Date(now.getTime() + leaseMs),
        },
      },
    },
    { returnDocument: 'after' },
  )
  if (run) {
    // Heal the narrow crash window between AgentRun creation and the
    // ConversationRuntime pointer update. AgentRun.active_key remains the
    // concurrency authority. Do not start execution until the duplicated
    // Runtime fence has been read back successfully: a stale hot-reload schema
    // used to silently drop owner_id and fail on the first fenced write.
    if (!await establishRuntimeLeaseFence(run, ownerId)) {
      await relinquishRunAfterFenceFailure(run.run_id, ownerId)
      return null
    }
  }
  return run
}

export async function leaseNextAgentRun(
  ownerId: string,
  leaseMs = DEFAULT_LEASE_MS,
): Promise<AgentRunDocument | null> {
  await connectDB()
  const now = new Date()
  const run = await AgentRun.findOneAndUpdate(
    {
      status: 'queued',
      cancellation_requested: { $ne: true },
      $and: [
        { $or: [{ lease: null }, { 'lease.expires_at': { $lte: now } }] },
        {
          $or: [
            { available_at: null },
            { available_at: { $exists: false } },
            { available_at: { $lte: now } },
          ],
        },
      ],
    },
    {
      $set: {
        status: 'running',
        available_at: null,
        lease: {
          owner_id: ownerId,
          heartbeat_at: now,
          expires_at: new Date(now.getTime() + leaseMs),
        },
      },
    },
    { returnDocument: 'after', sort: { created_at: 1 } },
  )
  if (run) {
    if (!await establishRuntimeLeaseFence(run, ownerId)) {
      await relinquishRunAfterFenceFailure(run.run_id, ownerId)
      return null
    }
  }
  return run
}

/**
 * Return a lease to the queue only when the worker failed before the internal
 * executor accepted the request. Once /api/chat returns 2xx, lease expiry—not
 * this helper—decides whether another worker may take over.
 */
export async function requeueAgentRunAfterDispatchFailure(
  runIdValue: string,
  ownerId: string,
  error: string,
): Promise<boolean> {
  await connectDB()
  const ownedRun = await AgentRun.findOne({
    run_id: runIdValue,
    status: 'running',
    'lease.owner_id': ownerId,
    cancellation_requested: { $ne: true },
  }).select('dispatch_attempts').lean()
  if (!ownedRun) return false

  const dispatchAttempts = (ownedRun.dispatch_attempts ?? 0) + 1
  const exhausted = dispatchAttempts >= MAX_DISPATCH_ATTEMPTS
  const run = await AgentRun.findOneAndUpdate(
    {
      run_id: runIdValue,
      status: 'running',
      'lease.owner_id': ownerId,
      cancellation_requested: { $ne: true },
    },
    {
      $set: {
        status: exhausted ? 'recoverable' : 'queued',
        lease: null,
        last_error: error,
        dispatch_attempts: dispatchAttempts,
        available_at: exhausted
          ? null
          : new Date(Date.now() + dispatchRetryDelayMs(dispatchAttempts)),
      },
      ...(exhausted ? { $inc: { recovery_count: 1 } } : {}),
    },
    { returnDocument: 'after' },
  )
  if (!run) return false
  if (run.execution_mode !== 'agent_session') {
    await ConversationRuntime.updateOne(
      {
        conversation_id: run.conversation_id,
        active_run_id: run.run_id,
        active_lease_owner_id: ownerId,
      },
      {
        $set: { active_lease_owner_id: null },
        $inc: { revision: 1 },
      },
    )
  }
  return true
}

/**
 * Yield a freshly claimed Run when its AgentTeam has no free execution slot.
 * Capacity pressure is normal queueing, not a dispatch failure: it must not
 * consume retry budget or turn the Run recoverable after a few polls.
 */
export async function deferAgentRunForExecutionCapacity(
  runIdValue: string,
  ownerId: string,
  delayMs = 750,
): Promise<boolean> {
  await connectDB()
  const run = await AgentRun.findOneAndUpdate(
    {
      run_id: runIdValue,
      status: 'running',
      'lease.owner_id': ownerId,
      cancellation_requested: { $ne: true },
    },
    {
      $set: {
        status: 'queued',
        lease: null,
        available_at: new Date(Date.now() + Math.max(100, delayMs)),
      },
    },
    { returnDocument: 'after' },
  )
  if (!run) return false
  if (run.execution_mode !== 'agent_session') {
    await ConversationRuntime.updateOne(
      {
        conversation_id: run.conversation_id,
        active_run_id: run.run_id,
        active_lease_owner_id: ownerId,
      },
      {
        $set: { active_lease_owner_id: null },
        $inc: { revision: 1 },
      },
    )
  }
  return true
}

/**
 * Yield a Run while its context owner has an independent durable compaction
 * Job. This is a scheduling boundary, not a dispatch failure: preserve the
 * exact request, pending inputs, checkpoint, active key, and retry counters.
 */
export async function deferAgentRunForCompactionBarrier(
  runIdValue: string,
  ownerId: string,
  retryAt: Date,
): Promise<boolean> {
  await connectDB()
  const minimumRetryAt = Date.now() + 1_000
  const safeRetryAt = new Date(Math.max(
    minimumRetryAt,
    Number.isFinite(retryAt.getTime()) ? retryAt.getTime() : minimumRetryAt,
  ))
  const run = await AgentRun.findOneAndUpdate(
    {
      run_id: runIdValue,
      status: 'running',
      'lease.owner_id': ownerId,
      cancellation_requested: { $ne: true },
    },
    {
      $set: {
        status: 'queued',
        lease: null,
        available_at: safeRetryAt,
      },
    },
    { returnDocument: 'after' },
  )
  if (!run) return false
  if (run.execution_mode !== 'agent_session') {
    await ConversationRuntime.updateOne(
      {
        conversation_id: run.conversation_id,
        active_run_id: run.run_id,
        active_lease_owner_id: ownerId,
      },
      {
        $set: { active_lease_owner_id: null },
        $inc: { revision: 1 },
      },
    )
  }
  return true
}

/** Unsupported/future Job states fail closed; ordinary terminal `failed` Jobs
 * are classified open by compaction-barrier and never enter this path. */
export async function failAgentRunForCompactionBarrier(
  runIdValue: string,
  ownerId: string,
  error: string,
): Promise<boolean> {
  const failureCategory = 'runtime_transient' as const
  return setRunStatus(runIdValue, 'failed', {
    terminationReason: 'runtime_error',
    error,
    failureRecoverability: 'fatal',
    failureCategory,
    failureSignature: agentRunFailureSignature(error, failureCategory),
    releaseActive: true,
    leaseOwnerId: ownerId,
  })
}

export type AgentRunHeartbeatResult =
  | 'renewed'
  | 'cancellation_requested'
  | 'lost'

export async function heartbeatAgentRun(
  runIdValue: string,
  ownerId: string,
  leaseMs = DEFAULT_LEASE_MS,
): Promise<AgentRunHeartbeatResult> {
  await connectDB()
  const now = new Date()
  const run = await AgentRun.findOneAndUpdate(
    { run_id: runIdValue, status: 'running', 'lease.owner_id': ownerId },
    {
      $set: {
        'lease.heartbeat_at': now,
        'lease.expires_at': new Date(now.getTime() + leaseMs),
      },
    },
    { returnDocument: 'after' },
  )
    .select('cancellation_requested')
    .lean()
  if (!run) return 'lost'
  return run.cancellation_requested ? 'cancellation_requested' : 'renewed'
}

export async function validateAgentRunLeaseFence(
  runIdValue: string,
  ownerId: string,
): Promise<boolean> {
  await connectDB()
  return Boolean(await AgentRun.exists({
    run_id: runIdValue,
    status: 'running',
    cancellation_requested: { $ne: true },
    'lease.owner_id': ownerId,
    'lease.expires_at': { $gt: new Date() },
  }))
}

export async function setRunCurrentAction(
  runIdValue: string,
  action: AgentRunCurrentAction | null,
  leaseOwnerId?: string,
): Promise<boolean> {
  await connectDB()
  const result = await AgentRun.updateOne(
    {
      run_id: runIdValue,
      ...(leaseOwnerId ? { 'lease.owner_id': leaseOwnerId, status: 'running' } : {}),
    },
    { $set: { current_action: action } },
  )
  return result.matchedCount === 1
}

export async function advanceRunCheckpoint(
  runIdValue: string,
  actionId: string,
  checkpointMessageId?: string,
  leaseOwnerId?: string,
): Promise<boolean> {
  await connectDB()
  const result = await AgentRun.updateOne(
    {
      run_id: runIdValue,
      'current_action.action_id': actionId,
      ...(leaseOwnerId ? { 'lease.owner_id': leaseOwnerId, status: 'running' } : {}),
    },
    {
      $set: {
        current_action: null,
        ...(checkpointMessageId ? { checkpoint_message_id: checkpointMessageId } : {}),
      },
      $inc: { checkpoint_seq: 1 },
    },
  )
  return result.modifiedCount === 1
}

export async function updateRunLive(
  runIdValue: string,
  assistantText: string,
  leaseOwnerId?: string,
): Promise<boolean> {
  await connectDB()
  const filter: {
    run_id: string
    'lease.owner_id'?: string
    status?: AgentRunStatus
  } = {
    run_id: runIdValue,
    ...(leaseOwnerId ? { 'lease.owner_id': leaseOwnerId, status: 'running' } : {}),
  }
  const current = await AgentRun.findOne(filter).select('live.revision').lean()
  if (!current) return false
  const live: AgentRunLiveState = {
    revision: (current?.live?.revision ?? 0) + 1,
    assistant_text: assistantText.slice(-64_000),
    updated_at: new Date(),
  }
  const result = await AgentRun.updateOne(filter, { $set: { live } })
  return result.matchedCount === 1
}

export async function clearRunLive(
  runIdValue: string,
  leaseOwnerId?: string,
): Promise<boolean> {
  await connectDB()
  const result = await AgentRun.updateOne(
    {
      run_id: runIdValue,
      ...(leaseOwnerId ? { 'lease.owner_id': leaseOwnerId, status: 'running' } : {}),
    },
    { $set: { live: null } },
  )
  return result.matchedCount === 1
}

export async function setRunStatus(
  runIdValue: string,
  status: AgentRunStatus,
  options?: {
    terminationReason?: AgentRunTerminationReason
    error?: string
    failureRecoverability?: AgentRunFailureRecoverability
    failureCategory?: AgentRunFailureCategory
    failureSignature?: string
    releaseActive?: boolean
    incrementRecovery?: boolean
    leaseOwnerId?: string
    onlyIfUnleased?: boolean
  },
): Promise<boolean> {
  await connectDB()
  const terminal = ['completed', 'cancelled', 'failed'].includes(status)
  const update: Record<string, unknown> = {
    status,
    lease: terminal || status === 'waiting_user' || status === 'waiting_agents' || status === 'recoverable' ? null : undefined,
    ...(options?.terminationReason ? { termination_reason: options.terminationReason } : {}),
    ...(options?.error ? { last_error: options.error } : {}),
    ...(options?.failureRecoverability
      ? { failure_recoverability: options.failureRecoverability }
      : {}),
    ...(options?.failureCategory ? { failure_category: options.failureCategory } : {}),
    ...(options?.failureSignature ? { failure_signature: options.failureSignature } : {}),
    ...(terminal ? { finished_at: new Date(), live: null, current_action: null } : {}),
  }
  for (const [key, value] of Object.entries(update)) {
    if (value === undefined) delete update[key]
  }
  if (terminal || options?.releaseActive) {
    update.active_key = undefined
  }
  const mongoUpdate: Record<string, unknown> = { $set: update }
  if (terminal || options?.releaseActive) {
    mongoUpdate.$unset = { active_key: 1 }
  }
  if (options?.incrementRecovery) {
    mongoUpdate.$inc = { recovery_count: 1 }
  }
  const run = await AgentRun.findOneAndUpdate(
    {
      run_id: runIdValue,
      ...(options?.leaseOwnerId
        ? { 'lease.owner_id': options.leaseOwnerId, status: 'running' }
        : {}),
      ...(options?.onlyIfUnleased
        ? { $or: [{ lease: null }, { lease: { $exists: false } }] }
        : {}),
    },
    mongoUpdate,
    { returnDocument: 'after' },
  )
  if (run && run.execution_mode !== 'agent_session' && (terminal || options?.releaseActive)) {
    await ConversationRuntime.updateOne(
      { conversation_id: run.conversation_id, active_run_id: runIdValue },
      {
        $set: {
          active_run_id: null,
          active_lease_owner_id: null,
        },
        $inc: { revision: 1 },
      },
    )
  } else if (run && run.execution_mode !== 'agent_session' && (status === 'waiting_user' || status === 'waiting_agents' || status === 'recoverable')) {
    await ConversationRuntime.updateOne(
      { conversation_id: run.conversation_id, active_run_id: runIdValue },
      {
        $set: { active_lease_owner_id: null },
        $inc: { revision: 1 },
      },
    )
  }
  return !!run
}

export async function requestRunCancellation(
  conversationId: string,
  userId: string,
  requestedRunId?: string,
): Promise<AgentRunDocument | null> {
  await connectDB()
  return AgentRun.findOneAndUpdate(
    {
      conversation_id: conversationId,
      user_id: userId,
      active_key: conversationId,
      ...(requestedRunId ? { run_id: requestedRunId } : {}),
    },
    { $set: { cancellation_requested: true } },
    { returnDocument: 'after' },
  )
}

export async function requestAgentSessionRunCancellation(
  agentSessionId: string,
  userId: string,
  requestedRunId?: string,
): Promise<AgentRunDocument | null> {
  await connectDB()
  const run = await AgentRun.findOne({
    user_id: userId,
    agent_session_id: agentSessionId,
    active_key: agentSessionId,
    ...(requestedRunId ? { run_id: requestedRunId } : {}),
  })
  if (!run) return null
  if (run.status === 'running') {
    return AgentRun.findOneAndUpdate(
      { _id: run._id, status: 'running' },
      { $set: { cancellation_requested: true } },
      { returnDocument: 'after' },
    )
  }
  if (['queued', 'waiting_user', 'waiting_agents', 'recoverable'].includes(run.status)) {
    return AgentRun.findOneAndUpdate(
      { _id: run._id, status: run.status },
      {
        $set: {
          status: 'cancelled',
          cancellation_requested: true,
          termination_reason: 'user_cancelled',
          lease: null,
          live: null,
          current_action: null,
          finished_at: new Date(),
        },
        $unset: { active_key: 1 },
      },
      { returnDocument: 'after' },
    )
  }
  return run
}

export async function cancelInactiveAgentRun(
  runIdValue: string,
  userId: string,
): Promise<boolean> {
  await connectDB()
  const run = await AgentRun.findOneAndUpdate(
    {
      run_id: runIdValue,
      user_id: userId,
      status: { $in: ['queued', 'waiting_user', 'waiting_agents', 'recoverable'] },
    },
    {
      $set: {
        status: 'cancelled',
        termination_reason: 'user_cancelled',
        cancellation_requested: true,
        finished_at: new Date(),
        lease: null,
        live: null,
        current_action: null,
      },
      $unset: { active_key: 1 },
    },
    { returnDocument: 'after' },
  )
  if (!run) return false
  if (run.execution_mode !== 'agent_session') {
    await ConversationRuntime.updateOne(
      { conversation_id: run.conversation_id, active_run_id: runIdValue },
      {
        $set: {
          active_run_id: null,
          active_lease_owner_id: null,
        },
        $inc: { revision: 1 },
      },
    )
  }
  return true
}

export async function isRunCancellationRequested(runIdValue: string): Promise<boolean> {
  await connectDB()
  const run = await AgentRun.findOne({ run_id: runIdValue }).select('cancellation_requested').lean()
  return !!run?.cancellation_requested
}

export async function markExpiredRunsRecoverable(): Promise<number> {
  await connectDB()
  const now = new Date()
  const candidates = await AgentRun.find({
    status: 'running',
    cancellation_requested: { $ne: true },
    'lease.expires_at': { $lte: now },
  }).select('run_id conversation_id lease.owner_id').lean()

  let recovered = 0
  for (const candidate of candidates) {
    const run = await AgentRun.findOneAndUpdate(
      {
        run_id: candidate.run_id,
        status: 'running',
        cancellation_requested: { $ne: true },
        'lease.expires_at': { $lte: now },
      },
      {
        $set: {
          status: 'recoverable',
          lease: null,
          last_error: 'Runner lease expired before the current action completed.',
        },
        $inc: { recovery_count: 1 },
      },
      { returnDocument: 'after' },
    )
    if (!run) continue
    recovered += 1
    if (run.execution_mode !== 'agent_session') {
      await ConversationRuntime.updateOne(
        {
          conversation_id: run.conversation_id,
          active_run_id: run.run_id,
          ...(candidate.lease?.owner_id
            ? { active_lease_owner_id: candidate.lease.owner_id }
            : {}),
        },
        {
          $set: { active_lease_owner_id: null },
          $inc: { revision: 1 },
        },
      )
    }
  }
  return recovered
}

/**
 * Finish cancellation requests that outlived their executor.
 *
 * A live running executor owns cancellation until its lease expires so it can
 * persist any partial assistant/tool checkpoints first. Once the lease is
 * stale—or the Run is not executing—there is no process left that can perform
 * that transition, so the recovery sweep completes it durably instead of
 * incorrectly advertising the Run as recoverable.
 */
export async function finalizeOrphanedCancelledRuns(): Promise<string[]> {
  await connectDB()
  const now = new Date()
  const candidates = await AgentRun.find({
    cancellation_requested: true,
    active_key: { $type: 'string' },
    $or: [
      { status: { $in: ['queued', 'waiting_user', 'waiting_agents', 'recoverable'] } },
      { status: 'running', 'lease.expires_at': { $lte: now } },
    ],
  }).select('run_id conversation_id user_id status active_key lease.expires_at').lean()

  const cancelledRunIds: string[] = []
  for (const candidate of candidates) {
    const run = await AgentRun.findOneAndUpdate(
      {
        run_id: candidate.run_id,
        cancellation_requested: true,
        active_key: candidate.active_key,
        $or: [
          { status: { $in: ['queued', 'waiting_user', 'waiting_agents', 'recoverable'] } },
          { status: 'running', 'lease.expires_at': { $lte: now } },
        ],
      },
      {
        $set: {
          status: 'cancelled',
          termination_reason: 'user_cancelled',
          finished_at: now,
          lease: null,
          live: null,
          current_action: null,
        },
        $unset: { active_key: 1 },
      },
      { returnDocument: 'after' },
    )
    if (!run) continue
    cancelledRunIds.push(run.run_id)
    if (run.execution_mode !== 'agent_session') {
      await ConversationRuntime.updateOne(
        { conversation_id: run.conversation_id, active_run_id: run.run_id },
        {
          $set: {
            active_run_id: null,
            active_lease_owner_id: null,
          },
          $inc: { revision: 1 },
        },
      )
    }
  }
  return cancelledRunIds
}

/**
 * Phase-one inline execution can die after reserving a queued Run but before
 * acquiring its lease. With no background executor, that Run would otherwise
 * keep the sparse active key forever. Do not use this sweep once a real
 * background Runner is registered: queued is then a healthy work state.
 */
export async function markAbandonedQueuedRunsRecoverable(
  maxAgeMs = 60_000,
): Promise<number> {
  await connectDB()
  const result = await AgentRun.updateMany(
    {
      status: 'queued',
      cancellation_requested: { $ne: true },
      lease: null,
      updated_at: { $lte: new Date(Date.now() - maxAgeMs) },
    },
    {
      $set: {
        status: 'recoverable',
        last_error: 'Inline executor stopped before acquiring the Run lease.',
      },
      $inc: { recovery_count: 1 },
    },
  )
  return result.modifiedCount
}

export async function bindMemoryRun(agentRunId: string, memoryRunId: string): Promise<void> {
  await connectDB()
  await AgentRun.updateOne({ run_id: agentRunId }, { $set: { memory_run_id: memoryRunId } })
}

/**
 * Remove internal runtime state after its owning Conversation has been deleted.
 *
 * The caller must first ensure there is no active Run. Runtime documents are
 * intentionally not useful without the user-visible Conversation and retaining
 * them would leave profile snapshots, checkpoints, and request payloads orphaned.
 */
export async function deleteConversationRuntimeState(
  conversationId: string,
  userId: string,
): Promise<{ runs: number; runtimes: number; compactions: number }> {
  await connectDB()
  const [runs, runtimes, compactions] = await Promise.all([
    AgentRun.deleteMany({ conversation_id: conversationId, user_id: userId }),
    ConversationRuntime.deleteMany({ conversation_id: conversationId, user_id: userId }),
    deleteCompactionJobsForConversation(conversationId, userId),
  ])
  return {
    runs: runs.deletedCount,
    runtimes: runtimes.deletedCount,
    compactions,
  }
}
