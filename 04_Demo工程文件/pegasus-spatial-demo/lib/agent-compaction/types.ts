import type { ConversationMessage, TokenUsage } from '../types'
import type { FrozenProjectContextSnapshot, FrozenWorkspaceProjection } from '../agent-runtime/types'
import type { FrozenModelResolutionSnapshot } from '../llm-registry'

/**
 * Durable compaction belongs to an active model context, never to the Run that
 * happened to notice pressure. Root owns the Conversation context; every
 * member owns its AgentSession context.
 */
export type CompactionContextOwner =
  | {
      kind: 'conversation'
      conversationId: string
      userId: string
    }
  | {
      kind: 'agent_session'
      sessionId: string
      conversationId: string
      userId: string
      teamId?: string
      agentId?: string
    }

export type DurableCompactionStatus =
  | 'queued'
  | 'summarizing'
  | 'summary_ready'
  | 'merge_prepared'
  | 'retryable'
  | 'merged'
  | 'failed'
  | 'cancelled'
  | 'superseded'

export interface DurableCompactionLease {
  owner_id: string
  fence_token: string
  heartbeat_at: Date
  expires_at: Date
}

/**
 * Short-lived ownership held by the source Agent turn while its local silent
 * summary request is still running. This is a fence, not an execution slot or
 * a credential; expiry lets the detached worker recover a crashed source turn.
 */
export interface DurableCompactionSourceTurnGuard {
  token: string
  owner_id: string
  source_run_id: string
  heartbeat_at: Date
  expires_at: Date
}

export function isSourceTurnCompactionGuardLive(
  guard: DurableCompactionSourceTurnGuard | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!guard?.token || !guard.owner_id || !guard.source_run_id) return false
  const expiresAt = new Date(guard.expires_at).getTime()
  return Number.isFinite(expiresAt) && expiresAt > now.getTime()
}

/**
 * Transactional outbox entry written by the same Mongo CAS as a Job status
 * transition. Delivery to TeamEvent is repairable and never gates the Job.
 */
export interface DurableCompactionStatusOutboxEntry {
  transition_id: string
  revision: number
  status: DurableCompactionStatus
  attempt: number
  reason?: string | null
  created_at: Date
  delivered_at?: Date | null
  delivery_attempt?: number
  next_attempt_at?: Date | null
  undeliverable_at?: Date | null
  delivery_error?: string | null
}

export interface ContextCompactionFence {
  job_id: string
  fence_token: string
  expires_at: Date
}

export interface FrozenCompactionPrefix {
  /** Context revision observed when the prefix was frozen. */
  context_revision: number
  prefix_length: number
  prefix_hash: string
  boundary_message_id?: string
  /**
   * Persist the exact input instead of relying on a Run closure. This makes a
   * queued job resumable after process restart and protects legacy messages
   * that do not yet have stable message IDs.
   */
  messages: ConversationMessage[]
}

export interface DurableCompactionJobRecord {
  job_id: string
  owner_key: string
  owner_kind: CompactionContextOwner['kind']
  conversation_id: string
  user_id: string
  agent_session_id?: string | null
  team_id?: string | null
  agent_id?: string | null
  source_run_id?: string | null
  idempotency_key: string
  /** Includes triggers that joined this Job while its context barrier was active. */
  idempotency_keys: string[]
  model_alias_snapshot?: string | null
  /** Immutable real model/capacity mapping; credentials are never persisted. */
  model_resolution_snapshot?: FrozenModelResolutionSnapshot | null
  status: DurableCompactionStatus
  status_revision?: number
  status_outbox?: DurableCompactionStatusOutboxEntry[]
  active_key?: string | null
  frozen_prefix: FrozenCompactionPrefix
  project_context_snapshot?: FrozenProjectContextSnapshot | null
  workspace_projection?: FrozenWorkspaceProjection | null
  /** Canonical Workspace/Project epoch frozen once immediately before replacement preparation. */
  merge_project_context_snapshot?: FrozenProjectContextSnapshot | null
  merge_workspace_projection?: FrozenWorkspaceProjection | null
  merge_projection_prepared_at?: Date | null
  summary?: string | null
  summary_usage?: TokenUsage | null
  replacement_message?: ConversationMessage | null
  replacement_hash?: string | null
  merge_context_revision?: number | null
  merged_context_revision?: number | null
  /** Runtime/Hippocampus epoch settled after owner swap and before `merged`. */
  runtime_settled_at?: Date | null
  attempt: number
  lease?: DurableCompactionLease | null
  source_turn_guard?: DurableCompactionSourceTurnGuard | null
  available_at?: Date | null
  last_error?: string | null
  created_at: Date
  updated_at: Date
  finished_at?: Date | null
}

export interface EnqueueCompactionInput {
  owner: CompactionContextOwner
  /** Stable per trigger/handoff. Replaying it returns the same Job. */
  idempotencyKey: string
  sourceRunId?: string
  modelAliasSnapshot?: string
  /** Exact credential-free resolution used when sizing an operator handoff. */
  modelResolutionSnapshot?: FrozenModelResolutionSnapshot
  /**
   * Shadow intents remain queued but unclaimable until this deadline. The
   * local summarizer may offer its result into this same Job; after a normal
   * Loop exit the Job is activated, and after a hard crash the worker can
   * claim it when the deadline expires.
   */
  /** @deprecated Use `initialAvailableAt`; retained for rolling deploys. */
  availableAt?: Date
  /**
   * Optional explicit prefix from an in-process handoff. When omitted, the
   * repository freezes the owner's complete active context.
   */
  prefixMessages?: readonly ConversationMessage[]
  projectContextSnapshot?: FrozenProjectContextSnapshot | null
  workspaceProjection?: FrozenWorkspaceProjection | null
  /** Future shadow deadline; active_key is still installed immediately. */
  initialAvailableAt?: Date
}

export interface DurableCompactionJobCommandInput {
  jobId: string
  owner: CompactionContextOwner
  /** Must be one of the immutable trigger/handoff keys joined to this Job. */
  idempotencyKey: string
}

export interface TerminateDurableCompactionJobInput
  extends DurableCompactionJobCommandInput {
  reason: string
  /** Required only while a live source-turn guard protects this Job. */
  guardToken?: string
}

export interface DurableCompactionJobCommandResult {
  job: DurableCompactionJobRecord
  changed: boolean
}

export interface OfferPreparedCompactionSummaryInput
  extends DurableCompactionJobCommandInput {
  expectedPrefixHash: string
  summary: string
  usage?: TokenUsage | null
  /** A live source turn may publish only through its exact guard token. */
  guardToken?: string
}

export type OfferPreparedCompactionSummaryResult =
  | { outcome: 'accepted'; job: DurableCompactionJobRecord }
  | { outcome: 'already_offered'; job: DurableCompactionJobRecord }
  | { outcome: 'durable_owned'; job: DurableCompactionJobRecord }

export interface AcquireSourceTurnCompactionGuardInput
  extends DurableCompactionJobCommandInput {
  sourceRunId: string
  /** Unique identity for this in-process source turn, not a user/Agent ID. */
  guardOwnerId: string
  ttlMs?: number
}

export interface SourceTurnCompactionGuardCommandInput
  extends DurableCompactionJobCommandInput {
  sourceRunId: string
  guardOwnerId: string
  guardToken: string
  ttlMs?: number
}

export interface SourceTurnCompactionGuardAcquireResult {
  job: DurableCompactionJobRecord
  changed: boolean
  guardToken: string
  expiresAt: Date
}

export interface CloseFailedCompactionRepairInput
  extends DurableCompactionJobCommandInput {
  replacementMessageId: string
}

export interface ClaimedCompactionJob {
  job: DurableCompactionJobRecord
  ownerId: string
  fenceToken: string
}

export interface CompactionSummaryOutcome {
  summary: string
  usage?: TokenUsage
}

export interface DurableCompactionProcessor {
  summarize(
    job: DurableCompactionJobRecord,
    signal: AbortSignal,
  ): Promise<CompactionSummaryOutcome>
  buildReplacement?(
    job: DurableCompactionJobRecord,
    summary: string,
  ): Promise<ConversationMessage> | ConversationMessage
}

export interface ApplyCompactionResult {
  outcome: 'merged' | 'already_merged' | 'conflict' | 'lost_lease' | 'owner_missing'
  contextRevision?: number
  reason?: string
}

export function compactionOwnerKey(owner: CompactionContextOwner): string {
  return owner.kind === 'conversation'
    ? `conversation:${owner.conversationId}`
    : `agent_session:${owner.sessionId}`
}

export function ownerFromJob(job: DurableCompactionJobRecord): CompactionContextOwner {
  if (job.owner_kind === 'conversation') {
    return {
      kind: 'conversation',
      conversationId: job.conversation_id,
      userId: job.user_id,
    }
  }
  if (!job.agent_session_id) {
    throw new Error(`Compaction Job ${job.job_id} has no Agent Session identity.`)
  }
  return {
    kind: 'agent_session',
    sessionId: job.agent_session_id,
    conversationId: job.conversation_id,
    userId: job.user_id,
    ...(job.team_id ? { teamId: job.team_id } : {}),
    ...(job.agent_id ? { agentId: job.agent_id } : {}),
  }
}
