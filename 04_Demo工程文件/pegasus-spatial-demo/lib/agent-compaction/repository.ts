import { createHash, randomUUID } from 'crypto'
import { connectDB } from '../db/mongodb'
import { Conversation } from '../db/models'
import { AgentSessionRuntimeModel, AgentTeamModel } from '../agent-team/models'
import { agentTeamRepository } from '../agent-team/repository'
import { ConversationRuntime } from '../agent-runtime/models'
import { buildWorkspaceProjection } from '../agent/compaction'
import { MultiAgentWorkspaceRepository } from '../workspace/multi-agent/repository'
import type { WorkspaceActor } from '../workspace/multi-agent/types'
import type { WorkspaceFileStat, WorkspaceInstance } from '../workspace/types'
import type { ConversationMessage } from '../types'
import {
  resolveAuthoritativeModelSnapshot,
  validateFrozenModelResolutionSnapshot,
  type FrozenModelResolutionSnapshot,
} from '../llm-registry'
import { DurableCompactionJobModel } from './models'
import {
  compactionOwnerKey,
  isSourceTurnCompactionGuardLive,
  ownerFromJob,
  type AcquireSourceTurnCompactionGuardInput,
  type ApplyCompactionResult,
  type CloseFailedCompactionRepairInput,
  type ClaimedCompactionJob,
  type CompactionContextOwner,
  type DurableCompactionJobCommandInput,
  type DurableCompactionJobCommandResult,
  type DurableCompactionJobRecord,
  type DurableCompactionStatus,
  type DurableCompactionStatusOutboxEntry,
  type EnqueueCompactionInput,
  type OfferPreparedCompactionSummaryInput,
  type OfferPreparedCompactionSummaryResult,
  type SourceTurnCompactionGuardAcquireResult,
  type SourceTurnCompactionGuardCommandInput,
  type TerminateDurableCompactionJobInput,
} from './types'

const DEFAULT_LEASE_MS = 90_000
const DEFAULT_SOURCE_TURN_GUARD_MS = 30_000
const MAX_MERGE_CAS_ATTEMPTS = 8
const MAX_STATUS_CAS_ATTEMPTS = 4

type ContextOwnerSnapshot = {
  owner: CompactionContextOwner
  contextRevision: number
  activeMessages: ConversationMessage[]
  lastAppliedCompactionId: string | null
}

function cloneMessages(messages: readonly ConversationMessage[]): ConversationMessage[] {
  return messages.map(message => structuredClone(message))
}

/** Canonical for persisted JSON/Mongo values, including Date -> ISO conversion. */
export function hashCompactionMessages(messages: readonly ConversationMessage[]): string {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex')
}

export function hashCompactionValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

interface StatusTransitionInput {
  filter: Record<string, unknown>
  status: DurableCompactionStatus
  set?: Record<string, unknown>
  unset?: readonly string[]
  reason?: string | null
  returnDocument?: 'before' | 'after'
}

function statusRevisionFilter(revision: number): Record<string, unknown> {
  return revision === 0
    ? {
        $or: [
          { status_revision: 0 },
          { status_revision: null },
          { status_revision: { $exists: false } },
        ],
      }
    : { status_revision: revision }
}

/**
 * Advance Job status and append its delivery intent in one Mongo document CAS.
 * TeamEvent delivery may fail independently; this transition never does.
 */
async function transitionCompactionStatus(
  input: StatusTransitionInput,
): Promise<DurableCompactionJobRecord | null> {
  for (let attempt = 0; attempt < MAX_STATUS_CAS_ATTEMPTS; attempt += 1) {
    const current = await DurableCompactionJobModel.findOne(input.filter)
      .select('job_id status_revision attempt')
      .lean<Pick<DurableCompactionJobRecord, 'job_id' | 'status_revision' | 'attempt'>>()
    if (!current) return null
    const revision = Math.max(0, current.status_revision ?? 0) + 1
    const entry: DurableCompactionStatusOutboxEntry = {
      transition_id: `cmpstatus_${randomUUID()}`,
      revision,
      status: input.status,
      attempt: Math.max(0, current.attempt ?? 0),
      reason: input.reason?.trim().slice(0, 2_000) || null,
      created_at: new Date(),
      delivered_at: null,
      delivery_attempt: 0,
      next_attempt_at: new Date(),
      undeliverable_at: null,
      delivery_error: null,
    }
    const update: Record<string, unknown> = {
      $set: {
        ...(input.set ?? {}),
        status: input.status,
        status_revision: revision,
      },
      $push: { status_outbox: entry },
    }
    if (input.unset?.length) {
      update.$unset = Object.fromEntries(input.unset.map(field => [field, 1]))
    }
    const freshFilter = 'lease.expires_at' in input.filter
      ? {
          ...input.filter,
          // The pre-read used to allocate a monotonic status revision must not
          // extend a lease that expires between the read and the actual CAS.
          'lease.expires_at': { $gt: new Date() },
        }
      : input.filter
    const transitioned = await DurableCompactionJobModel.findOneAndUpdate(
      {
        $and: [
          freshFilter,
          statusRevisionFilter(Math.max(0, current.status_revision ?? 0)),
        ],
      },
      update,
      { returnDocument: input.returnDocument ?? 'after' },
    ).lean<DurableCompactionJobRecord>()
    if (transitioned) return transitioned
  }
  return null
}

function deterministicJobId(ownerKey: string, idempotencyKey: string): string {
  const digest = createHash('sha256')
    .update(`${ownerKey}\0${idempotencyKey}`)
    .digest('hex')
    .slice(0, 40)
  return `cmpjob_${digest}`
}

function duplicateKey(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 11000
}

function revisionFilter(revision: number): Record<string, unknown> {
  return revision === 0
    ? {
        $or: [
          { context_revision: 0 },
          { context_revision: null },
          { context_revision: { $exists: false } },
        ],
      }
    : { context_revision: revision }
}

async function loadOwnerSnapshot(owner: CompactionContextOwner): Promise<ContextOwnerSnapshot | null> {
  if (owner.kind === 'conversation') {
    const document = await Conversation.findOne({
      conversation_id: owner.conversationId,
      user_id: owner.userId,
    }).select(
      'messages compacted_messages context_revision last_applied_compaction_id',
    ).lean<{
      messages?: ConversationMessage[]
      compacted_messages?: ConversationMessage[]
      context_revision?: number
      last_applied_compaction_id?: string | null
    }>()
    if (!document) return null
    const compacted = document.compacted_messages ?? []
    return {
      owner,
      contextRevision: document.context_revision ?? 0,
      activeMessages: cloneMessages(compacted.length > 0 ? compacted : (document.messages ?? [])),
      lastAppliedCompactionId: document.last_applied_compaction_id ?? null,
    }
  }

  const document = await AgentSessionRuntimeModel.findOne({
    session_id: owner.sessionId,
    conversation_id: owner.conversationId,
    user_id: owner.userId,
  }).select(
    'messages compacted_messages context_revision last_applied_compaction_id',
  ).lean<{
    messages?: ConversationMessage[]
    compacted_messages?: ConversationMessage[]
    context_revision?: number
    last_applied_compaction_id?: string | null
  }>()
  if (!document) return null
  const compacted = document.compacted_messages ?? []
  return {
    owner,
    contextRevision: document.context_revision ?? 0,
    activeMessages: cloneMessages(compacted.length > 0 ? compacted : (document.messages ?? [])),
    lastAppliedCompactionId: document.last_applied_compaction_id ?? null,
  }
}

export class CompactionOwnerNotFoundError extends Error {
  readonly code = 'COMPACTION_OWNER_NOT_FOUND'
  constructor(ownerKey: string) {
    super(`Compaction context owner does not exist: ${ownerKey}`)
    this.name = 'CompactionOwnerNotFoundError'
  }
}

export class CompactionPrefixConflictError extends Error {
  readonly code = 'COMPACTION_PREFIX_CONFLICT'
  constructor(message: string) {
    super(message)
    this.name = 'CompactionPrefixConflictError'
  }
}

export class CompactionJobCommandRejectedError extends Error {
  readonly code = 'COMPACTION_JOB_COMMAND_REJECTED'
  constructor() {
    // Deliberately do not distinguish a missing Job from an ownership/key
    // mismatch. A command boundary must not disclose another user's Job.
    super('Compaction Job command rejected: identity did not match.')
    this.name = 'CompactionJobCommandRejectedError'
  }
}

export class CompactionJobNotUnclaimedQueuedError extends Error {
  readonly code = 'COMPACTION_JOB_NOT_UNCLAIMED_QUEUED'
  constructor() {
    super('Compaction Job is no longer an active, unclaimed queued barrier.')
    this.name = 'CompactionJobNotUnclaimedQueuedError'
  }
}

function commandIdentityFilter(
  input: DurableCompactionJobCommandInput,
): Record<string, unknown> {
  return {
    job_id: input.jobId,
    owner_key: compactionOwnerKey(input.owner),
    owner_kind: input.owner.kind,
    conversation_id: input.owner.conversationId,
    user_id: input.owner.userId,
    idempotency_keys: input.idempotencyKey,
    ...(input.owner.kind === 'agent_session'
      ? { agent_session_id: input.owner.sessionId }
      : {}),
  }
}

async function requireCommandJob(
  input: DurableCompactionJobCommandInput,
): Promise<DurableCompactionJobRecord> {
  const job = await DurableCompactionJobModel.findOne(
    commandIdentityFilter(input),
  ).lean<DurableCompactionJobRecord>()
  if (!job) throw new CompactionJobCommandRejectedError()
  return job
}

function sourceTurnCommandIdentityFilter(
  input: AcquireSourceTurnCompactionGuardInput | SourceTurnCompactionGuardCommandInput,
): Record<string, unknown> {
  return {
    ...commandIdentityFilter(input),
    // A joined exit/retry key may activate the existing barrier, but it may
    // not impersonate the source turn that owns the local summarizer.
    idempotency_key: input.idempotencyKey,
    source_run_id: input.sourceRunId.trim(),
  }
}

function unleasedCompactionFilter(): Record<string, unknown> {
  return {
    $or: [
      { lease: null },
      { lease: { $exists: false } },
    ],
  }
}

function noLiveSourceTurnGuardFilter(now: Date): Record<string, unknown> {
  return {
    $or: [
      { source_turn_guard: null },
      { source_turn_guard: { $exists: false } },
      { 'source_turn_guard.expires_at': null },
      { 'source_turn_guard.expires_at': { $exists: false } },
      { 'source_turn_guard.expires_at': { $lte: now } },
    ],
  }
}

function sourceTurnGuardCommandFilter(
  now: Date,
  guardToken?: string,
): Record<string, unknown> {
  const token = guardToken?.trim()
  return {
    $or: [
      { source_turn_guard: null },
      { source_turn_guard: { $exists: false } },
      { 'source_turn_guard.expires_at': null },
      { 'source_turn_guard.expires_at': { $exists: false } },
      { 'source_turn_guard.expires_at': { $lte: now } },
      ...(token ? [{ 'source_turn_guard.token': token }] : []),
    ],
  }
}

function sourceTurnGuardDeadline(now: Date, ttlMs?: number): Date {
  const requestedTtlMs = ttlMs ?? DEFAULT_SOURCE_TURN_GUARD_MS
  if (!Number.isFinite(requestedTtlMs)) {
    throw new TypeError('Source-turn guard ttlMs must be finite.')
  }
  return new Date(
    now.getTime() + Math.max(5_000, requestedTtlMs),
  )
}

function requireSourceTurnIdentity(
  input: AcquireSourceTurnCompactionGuardInput | SourceTurnCompactionGuardCommandInput,
): void {
  if (!input.sourceRunId.trim() || !input.guardOwnerId.trim()) {
    throw new TypeError('Source-turn guard requires sourceRunId and guardOwnerId.')
  }
}

/**
 * Create one durable Job per context/idempotency key. A different trigger that
 * races while a Job is active joins the existing context barrier rather than
 * starting a second summary over the same mutable tail.
 */
export async function enqueueDurableCompaction(
  input: EnqueueCompactionInput,
): Promise<DurableCompactionJobRecord> {
  await connectDB()
  const ownerKey = compactionOwnerKey(input.owner)
  const jobId = deterministicJobId(ownerKey, input.idempotencyKey)
  const prior = await DurableCompactionJobModel.findOne({
    owner_key: ownerKey,
    $or: [
      { job_id: jobId },
      { idempotency_keys: input.idempotencyKey },
    ],
  })
    .lean<DurableCompactionJobRecord>()
  if (prior) return prior

  const snapshot = await loadOwnerSnapshot(input.owner)
  if (!snapshot) throw new CompactionOwnerNotFoundError(ownerKey)
  const prefix = cloneMessages(input.prefixMessages ?? snapshot.activeMessages)
  if (prefix.length === 0) {
    throw new CompactionPrefixConflictError('Cannot compact an empty active context.')
  }
  if (prefix.length > snapshot.activeMessages.length) {
    throw new CompactionPrefixConflictError(
      'Frozen compaction prefix is longer than the persisted active context.',
    )
  }
  const persistedPrefix = snapshot.activeMessages.slice(0, prefix.length)
  const prefixHash = hashCompactionMessages(prefix)
  if (hashCompactionMessages(persistedPrefix) !== prefixHash) {
    throw new CompactionPrefixConflictError(
      'Frozen compaction prefix does not match the persisted active context.',
    )
  }

  const modelAliasSnapshot = input.modelAliasSnapshot?.trim() || null
  if (input.modelResolutionSnapshot && !modelAliasSnapshot) {
    throw new Error('A model resolution snapshot requires modelAliasSnapshot.')
  }
  const modelResolutionSnapshot = modelAliasSnapshot
    ? input.modelResolutionSnapshot
      ? validateFrozenModelResolutionSnapshot(
          input.modelResolutionSnapshot,
          modelAliasSnapshot,
        )
      : await resolveAuthoritativeModelSnapshot(modelAliasSnapshot)
    : null

  const now = new Date()
  const initialAvailableAt = input.initialAvailableAt ?? input.availableAt ?? now
  if (!Number.isFinite(initialAvailableAt.getTime())) {
    throw new TypeError('initialAvailableAt must be a valid Date.')
  }
  const ownerIdentity = input.owner.kind === 'agent_session'
    ? {
        agent_session_id: input.owner.sessionId,
        team_id: input.owner.teamId ?? null,
        agent_id: input.owner.agentId ?? null,
      }
    : {
        agent_session_id: null,
        team_id: null,
        agent_id: null,
      }
  try {
    const initialStatusEvent: DurableCompactionStatusOutboxEntry = {
      transition_id: `cmpstatus_${randomUUID()}`,
      revision: 1,
      status: 'queued',
      attempt: 0,
      reason: null,
      created_at: now,
      delivered_at: null,
      delivery_attempt: 0,
      next_attempt_at: now,
      undeliverable_at: null,
      delivery_error: null,
    }
    return await DurableCompactionJobModel.create({
      job_id: jobId,
      owner_key: ownerKey,
      owner_kind: input.owner.kind,
      conversation_id: input.owner.conversationId,
      user_id: input.owner.userId,
      ...ownerIdentity,
      source_run_id: input.sourceRunId ?? null,
      idempotency_key: input.idempotencyKey,
      idempotency_keys: [input.idempotencyKey],
      model_alias_snapshot: modelAliasSnapshot,
      model_resolution_snapshot: modelResolutionSnapshot,
      status: 'queued',
      status_revision: 1,
      status_outbox: [initialStatusEvent],
      active_key: ownerKey,
      frozen_prefix: {
        context_revision: snapshot.contextRevision,
        prefix_length: prefix.length,
        prefix_hash: prefixHash,
        ...(prefix[prefix.length - 1]?.message_id
          ? { boundary_message_id: prefix[prefix.length - 1].message_id }
          : {}),
        messages: prefix,
      },
      project_context_snapshot: input.projectContextSnapshot ?? null,
      workspace_projection: input.workspaceProjection
        ?? input.projectContextSnapshot?.workspace_projection
        ?? null,
      attempt: 0,
      lease: null,
      // active_key is installed even for a future shadow intent. This blocks
      // a new Run at the context barrier while claimNext leaves it untouched
      // until the deadline or an explicit activation.
      available_at: initialAvailableAt,
      last_error: null,
      finished_at: null,
    }) as unknown as DurableCompactionJobRecord
  } catch (error) {
    if (!duplicateKey(error)) throw error
    const winner = await DurableCompactionJobModel.findOneAndUpdate({
      $or: [
        { job_id: jobId },
        { active_key: ownerKey },
      ],
    }, {
      $addToSet: { idempotency_keys: input.idempotencyKey },
    }, { returnDocument: 'after' }).lean<DurableCompactionJobRecord>()
    if (winner) return winner
    throw error
  }
}

export async function getDurableCompactionJob(
  jobId: string,
): Promise<DurableCompactionJobRecord | null> {
  await connectDB()
  return DurableCompactionJobModel.findOne({ job_id: jobId }).lean<DurableCompactionJobRecord>()
}

export async function getActiveCompactionForOwner(
  owner: CompactionContextOwner,
): Promise<DurableCompactionJobRecord | null> {
  await connectDB()
  return DurableCompactionJobModel.findOne({
    active_key: compactionOwnerKey(owner),
  }).lean<DurableCompactionJobRecord>()
}

export interface FlushCompactionStatusOutboxOptions {
  limit?: number
  onError?: (error: unknown) => void
}

function statusOutboxEntryIsDue(
  entry: DurableCompactionStatusOutboxEntry,
  now: Date,
): boolean {
  if (entry.delivered_at || entry.undeliverable_at) return false
  return !entry.next_attempt_at || entry.next_attempt_at.getTime() <= now.getTime()
}

function statusOutboxEntryIdentity(
  jobId: string,
  transitionId: string,
): Record<string, unknown> {
  return {
    job_id: jobId,
    status_outbox: {
      $elemMatch: {
        transition_id: transitionId,
        delivered_at: null,
        $or: [
          { undeliverable_at: null },
          { undeliverable_at: { $exists: false } },
        ],
      },
    },
  }
}

async function deferStatusOutboxEntry(
  jobId: string,
  entry: DurableCompactionStatusOutboxEntry,
  error: string,
  now: Date,
): Promise<void> {
  const attempt = Math.max(0, entry.delivery_attempt ?? 0) + 1
  const backoffMs = Math.min(5 * 60_000, 1_000 * (2 ** Math.min(8, attempt - 1)))
  await DurableCompactionJobModel.updateOne(
    statusOutboxEntryIdentity(jobId, entry.transition_id),
    {
      $set: {
        'status_outbox.$.delivery_attempt': attempt,
        'status_outbox.$.next_attempt_at': new Date(now.getTime() + backoffMs),
        'status_outbox.$.delivery_error': error.trim().slice(0, 500),
      },
    },
  )
}

/**
 * Repair CompactionJob status intents into the team's replayable event log.
 * A Team may not exist during legacy migration. Every failed delivery is
 * deferred at entry level so a fixed-size batch of deleted legacy teams can
 * never starve later live events. The Job remains the source of truth.
 */
export async function flushDurableCompactionStatusOutbox(
  options: FlushCompactionStatusOutboxOptions = {},
): Promise<number> {
  await connectDB()
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500))
  const now = new Date()
  const jobs = await DurableCompactionJobModel.find({
    status_outbox: {
      $elemMatch: {
        delivered_at: null,
        $and: [
          {
            $or: [
              { undeliverable_at: null },
              { undeliverable_at: { $exists: false } },
            ],
          },
          {
            $or: [
              { next_attempt_at: null },
              { next_attempt_at: { $exists: false } },
              { next_attempt_at: { $lte: now } },
            ],
          },
        ],
      },
    },
  }).sort({ updated_at: 1 }).limit(limit).lean<DurableCompactionJobRecord[]>()
  let delivered = 0

  for (const job of jobs) {
    const team = await AgentTeamModel.findOne({
      ...(job.team_id ? { team_id: job.team_id } : {}),
      conversation_id: job.conversation_id,
      user_id: job.user_id,
    }).select('team_id root_agent_id').lean<{
      team_id: string
      root_agent_id: string
    }>()
    const dueEntries = (job.status_outbox ?? []).filter(entry => (
      statusOutboxEntryIsDue(entry, now)
    ))
    if (!team) {
      await Promise.all(dueEntries.map(entry => deferStatusOutboxEntry(
        job.job_id,
        entry,
        'team_missing',
        now,
      )))
      continue
    }

    for (const entry of dueEntries) {
      try {
        await agentTeamRepository.appendEvent({
          teamId: team.team_id,
          userId: job.user_id,
          type: 'compaction_status',
          subjectAgentId: job.agent_id ?? team.root_agent_id,
          payload: {
            job: job.job_id,
            owner: job.owner_key,
            status: entry.status,
            attempt: entry.attempt,
            reason: entry.reason ?? null,
            revision: entry.revision,
          },
          dedupeKey: `compaction_status:${job.job_id}:${entry.revision}`,
        })
        const updated = await DurableCompactionJobModel.updateOne(
          statusOutboxEntryIdentity(job.job_id, entry.transition_id),
          {
            $set: {
              'status_outbox.$.delivered_at': new Date(),
              'status_outbox.$.next_attempt_at': null,
              'status_outbox.$.delivery_error': null,
            },
          },
        )
        if (updated.modifiedCount === 1) delivered += 1
      } catch (error) {
        options.onError?.(error)
        await deferStatusOutboxEntry(
          job.job_id,
          entry,
          error instanceof Error ? error.message : String(error),
          now,
        )
      }
    }
  }
  return delivered
}

/**
 * Fence the delayed shadow while its source turn performs local provider I/O.
 * The primary trigger key and source Run must both match; joined keys cannot
 * acquire or replace this ownership. A live replay by the same turn returns
 * the existing token, while an expired guard may be replaced atomically.
 */
export async function acquireSourceTurnCompactionGuard(
  input: AcquireSourceTurnCompactionGuardInput,
): Promise<SourceTurnCompactionGuardAcquireResult> {
  await connectDB()
  requireSourceTurnIdentity(input)
  const sourceRunId = input.sourceRunId.trim()
  const guardOwnerId = input.guardOwnerId.trim()
  const now = new Date()
  const current = await requireCommandJob(input)
  if (
    current.idempotency_key !== input.idempotencyKey
    || current.source_run_id !== sourceRunId
  ) throw new CompactionJobCommandRejectedError()

  const isExactUnclaimedShadow = current.active_key === compactionOwnerKey(input.owner)
    && current.status === 'queued'
    && !current.lease
  if (!isExactUnclaimedShadow) throw new CompactionJobNotUnclaimedQueuedError()

  const liveGuard = current.source_turn_guard
  if (isSourceTurnCompactionGuardLive(liveGuard, now)) {
    if (
      liveGuard!.owner_id === guardOwnerId
      && liveGuard!.source_run_id === sourceRunId
    ) {
      return {
        job: current,
        changed: false,
        guardToken: liveGuard!.token,
        expiresAt: new Date(liveGuard!.expires_at),
      }
    }
    throw new CompactionJobNotUnclaimedQueuedError()
  }

  const isDelayedShadow = Boolean(
    current.available_at && new Date(current.available_at).getTime() > now.getTime(),
  )
  if (!isDelayedShadow) throw new CompactionJobNotUnclaimedQueuedError()

  const guardToken = `cmpguard_${randomUUID()}`
  const expiresAt = sourceTurnGuardDeadline(now, input.ttlMs)
  const guarded = await DurableCompactionJobModel.findOneAndUpdate(
    {
      ...sourceTurnCommandIdentityFilter(input),
      active_key: compactionOwnerKey(input.owner),
      status: 'queued',
      available_at: { $gt: now },
      $and: [
        unleasedCompactionFilter(),
        noLiveSourceTurnGuardFilter(now),
      ],
    },
    {
      $set: {
        source_turn_guard: {
          token: guardToken,
          owner_id: guardOwnerId,
          source_run_id: sourceRunId,
          heartbeat_at: now,
          expires_at: expiresAt,
        },
      },
    },
    { returnDocument: 'after' },
  ).lean<DurableCompactionJobRecord>()
  if (guarded) return { job: guarded, changed: true, guardToken, expiresAt }

  const winner = await requireCommandJob(input)
  const winnerGuard = winner.source_turn_guard
  if (
    winner.idempotency_key === input.idempotencyKey
    && winner.source_run_id === sourceRunId
    && isSourceTurnCompactionGuardLive(winnerGuard, new Date())
    && winnerGuard!.owner_id === guardOwnerId
    && winnerGuard!.source_run_id === sourceRunId
  ) {
    return {
      job: winner,
      changed: false,
      guardToken: winnerGuard!.token,
      expiresAt: new Date(winnerGuard!.expires_at),
    }
  }
  throw new CompactionJobNotUnclaimedQueuedError()
}

/** Extend only the exact, still-live source-turn guard; expiry is irreversible. */
export async function heartbeatSourceTurnCompactionGuard(
  input: SourceTurnCompactionGuardCommandInput,
): Promise<Date | null> {
  await connectDB()
  requireSourceTurnIdentity(input)
  if (!input.guardToken.trim()) return null
  const now = new Date()
  const expiresAt = sourceTurnGuardDeadline(now, input.ttlMs)
  const updated = await DurableCompactionJobModel.findOneAndUpdate(
    {
      ...sourceTurnCommandIdentityFilter(input),
      active_key: compactionOwnerKey(input.owner),
      status: 'queued',
      $and: [unleasedCompactionFilter()],
      'source_turn_guard.token': input.guardToken.trim(),
      'source_turn_guard.owner_id': input.guardOwnerId.trim(),
      'source_turn_guard.source_run_id': input.sourceRunId.trim(),
      'source_turn_guard.expires_at': { $gt: now },
    },
    {
      $set: {
        'source_turn_guard.heartbeat_at': now,
        'source_turn_guard.expires_at': expiresAt,
      },
    },
    { returnDocument: 'after' },
  ).select('source_turn_guard').lean<DurableCompactionJobRecord>()
  return updated?.source_turn_guard
    ? new Date(updated.source_turn_guard.expires_at)
    : null
}

/** Release only the exact token; an expired/replaced guard is never cleared. */
export async function releaseSourceTurnCompactionGuard(
  input: SourceTurnCompactionGuardCommandInput,
): Promise<boolean> {
  await connectDB()
  requireSourceTurnIdentity(input)
  if (!input.guardToken.trim()) return false
  const result = await DurableCompactionJobModel.updateOne(
    {
      ...sourceTurnCommandIdentityFilter(input),
      'source_turn_guard.token': input.guardToken.trim(),
      'source_turn_guard.owner_id': input.guardOwnerId.trim(),
      'source_turn_guard.source_run_id': input.sourceRunId.trim(),
    },
    { $unset: { source_turn_guard: 1 } },
  )
  return result.modifiedCount === 1
}

export async function claimNextCompactionJob(
  ownerId: string,
  leaseMs = DEFAULT_LEASE_MS,
): Promise<ClaimedCompactionJob | null> {
  await connectDB()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + Math.max(5_000, leaseMs))
  const fenceToken = `cmpf_${randomUUID()}`
  const job = await DurableCompactionJobModel.findOneAndUpdate(
    {
      active_key: { $type: 'string' },
      status: { $in: ['queued', 'summarizing', 'summary_ready', 'merge_prepared', 'retryable'] },
      $and: [
        {
          $or: [
            { available_at: null },
            { available_at: { $exists: false } },
            { available_at: { $lte: now } },
          ],
        },
        {
          $or: [
            { lease: null },
            { lease: { $exists: false } },
            { 'lease.expires_at': { $lte: now } },
          ],
        },
        noLiveSourceTurnGuardFilter(now),
      ],
    },
    {
      $set: {
        lease: {
          owner_id: ownerId,
          fence_token: fenceToken,
          heartbeat_at: now,
          expires_at: expiresAt,
        },
        last_error: null,
      },
      $unset: { source_turn_guard: 1 },
      $inc: { attempt: 1 },
    },
    { sort: { created_at: 1 }, returnDocument: 'after' },
  ).lean<DurableCompactionJobRecord>()
  if (!job) return null
  return { job, ownerId, fenceToken }
}

/**
 * One-time compatibility upgrade for Jobs created before model mappings were
 * persisted. The exact worker lease is required and an existing snapshot is
 * immutable; a crash after this CAS simply resumes from the frozen mapping.
 */
export async function freezeClaimedCompactionModelResolution(
  claim: ClaimedCompactionJob,
  snapshot: FrozenModelResolutionSnapshot,
): Promise<DurableCompactionJobRecord | null> {
  const alias = claim.job.model_alias_snapshot?.trim()
  if (!alias || snapshot.alias !== alias) {
    throw new CompactionPrefixConflictError(
      'Compaction model resolution does not match the frozen alias.',
    )
  }
  if (claim.job.model_resolution_snapshot) return claim.job
  const updated = await DurableCompactionJobModel.findOneAndUpdate(
    {
      ...liveJobLeaseFilter(
        claim.job.job_id,
        claim.ownerId,
        claim.fenceToken,
        ['queued', 'summarizing', 'summary_ready', 'merge_prepared', 'retryable'],
      ),
      $or: [
        { model_resolution_snapshot: null },
        { model_resolution_snapshot: { $exists: false } },
      ],
    },
    { $set: { model_resolution_snapshot: snapshot } },
    { returnDocument: 'after' },
  ).lean<DurableCompactionJobRecord>()
  if (updated) {
    claim.job = updated
    return updated
  }
  const winner = await DurableCompactionJobModel.findOne(
    liveJobLeaseFilter(
      claim.job.job_id,
      claim.ownerId,
      claim.fenceToken,
      ['queued', 'summarizing', 'summary_ready', 'merge_prepared', 'retryable'],
    ),
  ).lean<DurableCompactionJobRecord>()
  if (!winner?.model_resolution_snapshot) return null
  claim.job = winner
  return winner
}

function liveJobLeaseFilter(
  jobId: string,
  ownerId: string,
  fenceToken: string,
  statuses?: DurableCompactionJobRecord['status'][],
): Record<string, unknown> {
  return {
    job_id: jobId,
    ...(statuses ? { status: { $in: statuses } } : {}),
    'lease.owner_id': ownerId,
    'lease.fence_token': fenceToken,
    'lease.expires_at': { $gt: new Date() },
  }
}

/** Install the Job lease token in the context document before any merge write. */
export async function establishContextCompactionFence(
  claim: ClaimedCompactionJob,
): Promise<boolean> {
  const live = await DurableCompactionJobModel.findOne(
    liveJobLeaseFilter(claim.job.job_id, claim.ownerId, claim.fenceToken),
  ).select('lease owner_kind conversation_id user_id agent_session_id').lean<DurableCompactionJobRecord>()
  if (!live?.lease) return false
  const now = new Date()
  const fence = {
    job_id: claim.job.job_id,
    fence_token: claim.fenceToken,
    expires_at: live.lease.expires_at,
  }
  const reusableFence = {
    $or: [
      { context_compaction_fence: null },
      { context_compaction_fence: { $exists: false } },
      { 'context_compaction_fence.expires_at': { $lte: now } },
      {
        'context_compaction_fence.job_id': claim.job.job_id,
        'context_compaction_fence.fence_token': claim.fenceToken,
      },
    ],
  }
  const result = live.owner_kind === 'conversation'
    ? await Conversation.updateOne(
        {
          conversation_id: live.conversation_id,
          user_id: live.user_id,
          ...reusableFence,
        },
        { $set: { context_compaction_fence: fence } },
      )
    : await AgentSessionRuntimeModel.updateOne(
        {
          session_id: live.agent_session_id,
          conversation_id: live.conversation_id,
          user_id: live.user_id,
          ...reusableFence,
        },
        { $set: { context_compaction_fence: fence } },
      )
  return result.matchedCount === 1
}

export async function heartbeatCompactionJob(
  claim: ClaimedCompactionJob,
  leaseMs = DEFAULT_LEASE_MS,
): Promise<boolean> {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + Math.max(5_000, leaseMs))
  const jobResult = await DurableCompactionJobModel.updateOne(
    liveJobLeaseFilter(claim.job.job_id, claim.ownerId, claim.fenceToken),
    {
      $set: {
        'lease.heartbeat_at': now,
        'lease.expires_at': expiresAt,
      },
    },
  )
  if (jobResult.matchedCount !== 1) return false
  const job = await getDurableCompactionJob(claim.job.job_id)
  if (!job) return false
  const filter = {
    'context_compaction_fence.job_id': job.job_id,
    'context_compaction_fence.fence_token': claim.fenceToken,
  }
  const update = { $set: { 'context_compaction_fence.expires_at': expiresAt } }
  const ownerResult = job.owner_kind === 'conversation'
    ? await Conversation.updateOne({
        conversation_id: job.conversation_id,
        user_id: job.user_id,
        ...filter,
      }, update)
    : await AgentSessionRuntimeModel.updateOne({
        session_id: job.agent_session_id,
        conversation_id: job.conversation_id,
        user_id: job.user_id,
        ...filter,
      }, update)
  // Once owner swap succeeded the fence is deliberately gone. The Job can
  // still be finalized idempotently by inspecting last_applied_compaction_id.
  if (ownerResult.matchedCount === 1) return true
  const snapshot = await loadOwnerSnapshot(ownerFromJob(job))
  return snapshot?.lastAppliedCompactionId === job.job_id
}

export async function beginCompactionSummary(claim: ClaimedCompactionJob): Promise<boolean> {
  const baseFilter = liveJobLeaseFilter(
    claim.job.job_id,
    claim.ownerId,
    claim.fenceToken,
    ['queued', 'retryable'],
  )
  const transitioned = await transitionCompactionStatus({
    filter: baseFilter,
    status: 'summarizing',
  })
  if (transitioned) return true
  // An in-process replay after the status CAS is a no-op, not a second event.
  return Boolean(await DurableCompactionJobModel.exists(
    liveJobLeaseFilter(
      claim.job.job_id,
      claim.ownerId,
      claim.fenceToken,
      ['summarizing'],
    ),
  ))
}

export async function saveCompactionSummary(
  claim: ClaimedCompactionJob,
  summary: string,
  usage?: DurableCompactionJobRecord['summary_usage'],
): Promise<boolean> {
  if (!summary.trim()) throw new Error('A durable compaction summary cannot be empty.')
  const transitioned = await transitionCompactionStatus({
    filter: liveJobLeaseFilter(
      claim.job.job_id,
      claim.ownerId,
      claim.fenceToken,
      ['summarizing'],
    ),
    status: 'summary_ready',
    set: {
      summary,
      summary_usage: usage ?? null,
    },
  })
  if (transitioned) return true
  return Boolean(await DurableCompactionJobModel.exists(
    liveJobLeaseFilter(
      claim.job.job_id,
      claim.ownerId,
      claim.fenceToken,
      ['summary_ready'],
    ),
  ))
}

async function currentOwnerProjectContext(
  job: DurableCompactionJobRecord,
): Promise<DurableCompactionJobRecord['project_context_snapshot']> {
  if (job.owner_kind === 'conversation') {
    const runtime = await ConversationRuntime.findOne({
      conversation_id: job.conversation_id,
      user_id: job.user_id,
    }).select('project_context_snapshot').lean<{
      project_context_snapshot?: DurableCompactionJobRecord['project_context_snapshot']
    }>()
    return runtime?.project_context_snapshot ?? null
  }
  const session = await AgentSessionRuntimeModel.findOne({
    session_id: job.agent_session_id,
    conversation_id: job.conversation_id,
    user_id: job.user_id,
  }).select('hippocampus.project_context_snapshot').lean<{
    hippocampus?: {
      project_context_snapshot?: DurableCompactionJobRecord['project_context_snapshot']
    }
  }>()
  return session?.hippocampus?.project_context_snapshot ?? null
}

async function canonicalMergeWorkspaceProjection(
  job: DurableCompactionJobRecord,
): Promise<DurableCompactionJobRecord['workspace_projection']> {
  const team = await AgentTeamModel.findOne({
    ...(job.team_id ? { team_id: job.team_id } : {}),
    conversation_id: job.conversation_id,
    user_id: job.user_id,
  }).select('team_id workspace_id root_agent_id').lean<{
    team_id: string
    workspace_id: string
    root_agent_id: string
  }>()
  if (!team) return job.workspace_projection ?? null
  const agentId = job.owner_kind === 'conversation'
    ? team.root_agent_id
    : job.agent_id
  if (!agentId) return job.workspace_projection ?? null
  const actor: WorkspaceActor = {
    teamId: team.team_id,
    agentId,
    rootAgentId: team.root_agent_id,
    role: job.owner_kind === 'conversation' ? 'root' : 'member',
    managedReferenceTool: true,
  }
  const files = await new MultiAgentWorkspaceRepository().listFiles(
    team.workspace_id,
    actor,
  )
  const stats = new Map<string, WorkspaceFileStat>(files.map(file => [
    file.path,
    {
      path: file.path,
      // The legacy projection formatter is metadata-only and currently types
      // canonical `artifact`/`object` values more narrowly than the path-level
      // Workspace. Preserve the canonical runtime value without widening the
      // legacy WorkspaceInstance contract for unrelated callers.
      kind: file.metadata.kind as WorkspaceFileStat['kind'],
      storage: file.storage_ref.driver as WorkspaceFileStat['storage'],
      mimeType: file.metadata.mime_type,
      sizeBytes: file.metadata.size_bytes,
      filename: file.metadata.filename,
      sha256: file.metadata.sha256,
      version: file.revision,
      createdAt: file.created_at.toISOString(),
      updatedAt: file.updated_at.toISOString(),
    },
  ]))
  const metadataOnlyWorkspace = {
    list: () => [...stats.keys()],
    stat: async (path: string) => stats.get(path) ?? null,
  } as unknown as WorkspaceInstance
  return buildWorkspaceProjection(metadataOnlyWorkspace)
}

/**
 * Freeze one merge-time prompt epoch before constructing the deterministic
 * replacement. Crash retries reuse these persisted fields and never re-list
 * a later Workspace state.
 */
export async function prepareDurableMergeContext(
  claim: ClaimedCompactionJob,
): Promise<DurableCompactionJobRecord | null> {
  const current = await DurableCompactionJobModel.findOne(
    liveJobLeaseFilter(
      claim.job.job_id,
      claim.ownerId,
      claim.fenceToken,
      ['summary_ready', 'merge_prepared', 'retryable'],
    ),
  ).lean<DurableCompactionJobRecord>()
  if (!current) return null
  if (current.replacement_message || current.merge_projection_prepared_at) return current

  const [projection, runtimeProjectContext] = await Promise.all([
    canonicalMergeWorkspaceProjection(current),
    currentOwnerProjectContext(current),
  ])
  const frozenProjectContext = current.project_context_snapshot ?? null
  const baseProjectContext = (
    (runtimeProjectContext?.epoch ?? -1) >= (frozenProjectContext?.epoch ?? -1)
      ? runtimeProjectContext
      : frozenProjectContext
  ) ?? null
  const nextEpoch = Math.max(
    runtimeProjectContext?.epoch ?? 0,
    frozenProjectContext?.epoch ?? 0,
  ) + 1
  const mergeProjectContext = baseProjectContext && projection
    ? {
        ...structuredClone(baseProjectContext),
        epoch: nextEpoch,
        workspace_projection: structuredClone(projection),
      }
    : baseProjectContext
      ? { ...structuredClone(baseProjectContext), epoch: nextEpoch }
      : null
  const preparedAt = new Date()
  const prepared = await DurableCompactionJobModel.findOneAndUpdate(
    {
      ...liveJobLeaseFilter(
        current.job_id,
        claim.ownerId,
        claim.fenceToken,
        ['summary_ready', 'retryable'],
      ),
      replacement_message: null,
      $or: [
        { merge_projection_prepared_at: null },
        { merge_projection_prepared_at: { $exists: false } },
      ],
    },
    {
      $set: {
        merge_workspace_projection: projection,
        merge_project_context_snapshot: mergeProjectContext,
        merge_projection_prepared_at: preparedAt,
      },
    },
    { returnDocument: 'after' },
  ).lean<DurableCompactionJobRecord>()
  if (prepared) return prepared
  return DurableCompactionJobModel.findOne(
    liveJobLeaseFilter(
      current.job_id,
      claim.ownerId,
      claim.fenceToken,
      ['summary_ready', 'retryable'],
    ),
  ).lean<DurableCompactionJobRecord>()
}

export async function prepareCompactionMerge(
  claim: ClaimedCompactionJob,
  replacementMessage: ConversationMessage,
): Promise<boolean> {
  const current = await DurableCompactionJobModel.findOne(
    liveJobLeaseFilter(
      claim.job.job_id,
      claim.ownerId,
      claim.fenceToken,
      ['summary_ready', 'merge_prepared', 'retryable'],
    ),
  ).lean<DurableCompactionJobRecord>()
  if (!current?.summary?.trim()) return false
  const replacement = structuredClone(replacementMessage)
  const replacementHash = hashCompactionValue(replacement)
  if (current.status === 'merge_prepared') {
    // A replay may rebuild a semantically identical replacement. Timestamp and
    // message ID must be deterministic, otherwise fail closed.
    return current.replacement_hash === replacementHash
  }
  if (current.replacement_message) {
    if (current.replacement_hash !== replacementHash) return false
    const restored = await transitionCompactionStatus({
      filter: liveJobLeaseFilter(
        claim.job.job_id,
        claim.ownerId,
        claim.fenceToken,
        ['retryable'],
      ),
      status: 'merge_prepared',
    })
    return Boolean(restored)
  }
  const transitioned = await transitionCompactionStatus({
    filter: liveJobLeaseFilter(
      claim.job.job_id,
      claim.ownerId,
      claim.fenceToken,
      ['summary_ready', 'retryable'],
    ),
    status: 'merge_prepared',
    set: {
      replacement_message: replacement,
      replacement_hash: replacementHash,
    },
  })
  return Boolean(transitioned)
}

async function markMergedWithFence(
  claim: ClaimedCompactionJob,
  contextRevision: number,
): Promise<boolean> {
  const now = new Date()
  const transitioned = await transitionCompactionStatus({
    filter: {
      ...liveJobLeaseFilter(
        claim.job.job_id,
        claim.ownerId,
        claim.fenceToken,
        ['merge_prepared'],
      ),
      runtime_settled_at: { $type: 'date' },
    },
    status: 'merged',
    set: {
      merged_context_revision: contextRevision,
      finished_at: now,
      lease: null,
    },
    unset: ['active_key', 'source_turn_guard'],
  })
  return Boolean(transitioned)
}

/**
 * Phase 1 of the standalone-Mongo merge. It atomically swaps the owner context,
 * preserves every append-only tail message, and writes last_applied in the
 * same document update. It intentionally does not mark the Job merged: a
 * crash between phases is repaired by finalizeAppliedCompactionJob().
 */
export async function applyPreparedMergeToOwner(
  claim: ClaimedCompactionJob,
): Promise<ApplyCompactionResult> {
  for (let attempt = 0; attempt < MAX_MERGE_CAS_ATTEMPTS; attempt += 1) {
    const job = await DurableCompactionJobModel.findOne(
      liveJobLeaseFilter(
        claim.job.job_id,
        claim.ownerId,
        claim.fenceToken,
        ['merge_prepared'],
      ),
    ).lean<DurableCompactionJobRecord>()
    if (!job) return { outcome: 'lost_lease' }
    if (!job.replacement_message || !job.replacement_hash) {
      return { outcome: 'conflict', reason: 'Prepared Job has no replacement message.' }
    }
    if (hashCompactionValue(job.replacement_message) !== job.replacement_hash) {
      return { outcome: 'conflict', reason: 'Prepared replacement hash does not match.' }
    }

    const owner = ownerFromJob(job)
    const snapshot = await loadOwnerSnapshot(owner)
    if (!snapshot) return { outcome: 'owner_missing' }
    if (snapshot.lastAppliedCompactionId === job.job_id) {
      return {
        outcome: 'already_merged',
        contextRevision: snapshot.contextRevision,
      }
    }
    if (snapshot.activeMessages.length < job.frozen_prefix.prefix_length) {
      return { outcome: 'conflict', reason: 'Active context is shorter than the frozen prefix.' }
    }
    const livePrefix = snapshot.activeMessages.slice(0, job.frozen_prefix.prefix_length)
    if (hashCompactionMessages(livePrefix) !== job.frozen_prefix.prefix_hash) {
      return { outcome: 'conflict', reason: 'Active context prefix changed after the Job was frozen.' }
    }
    const nextMessages = [
      structuredClone(job.replacement_message),
      ...cloneMessages(snapshot.activeMessages.slice(job.frozen_prefix.prefix_length)),
    ]
    const nextRevision = snapshot.contextRevision + 1
    const fenceFilter = {
      'context_compaction_fence.job_id': job.job_id,
      'context_compaction_fence.fence_token': claim.fenceToken,
      'context_compaction_fence.expires_at': { $gt: new Date() },
    }
    const result = owner.kind === 'conversation'
      ? await Conversation.collection.updateOne(
          {
            conversation_id: owner.conversationId,
            user_id: owner.userId,
            ...revisionFilter(snapshot.contextRevision),
            ...fenceFilter,
          },
          {
            $set: {
              compacted_messages: nextMessages,
              context_revision: nextRevision,
              last_applied_compaction_id: job.job_id,
              context_compaction_fence: null,
            },
            $inc: { compaction_count: 1 },
          },
        )
      : await AgentSessionRuntimeModel.collection.updateOne(
          {
            session_id: owner.sessionId,
            conversation_id: owner.conversationId,
            user_id: owner.userId,
            ...revisionFilter(snapshot.contextRevision),
            ...fenceFilter,
          },
          {
            $set: {
              compacted_messages: nextMessages,
              context_revision: nextRevision,
              last_applied_compaction_id: job.job_id,
              context_compaction_fence: null,
            },
            $inc: { revision: 1 },
          },
        )
    if (result.matchedCount === 1) {
      await DurableCompactionJobModel.updateOne(
        liveJobLeaseFilter(job.job_id, claim.ownerId, claim.fenceToken, ['merge_prepared']),
        { $set: { merge_context_revision: snapshot.contextRevision } },
      )
      return { outcome: 'merged', contextRevision: nextRevision }
    }
    // A concurrent append increments context_revision. Re-read and preserve its
    // tail instead of overwriting it. Other failures are distinguished below.
  }

  const finalJob = await getDurableCompactionJob(claim.job.job_id)
  const snapshot = finalJob ? await loadOwnerSnapshot(ownerFromJob(finalJob)) : null
  if (snapshot?.lastAppliedCompactionId === claim.job.job_id) {
    return { outcome: 'already_merged', contextRevision: snapshot.contextRevision }
  }
  return {
    outcome: 'conflict',
    reason: `Context revision changed during ${MAX_MERGE_CAS_ATTEMPTS} merge attempts.`,
  }
}

function settledHippocampusFields(jobId: string): Record<string, unknown> {
  return {
    'hippocampus.last_settled_compaction_id': jobId,
    'hippocampus.turns_since_merge': 0,
    'hippocampus.rapid_refills': 0,
    'hippocampus.breaker_state': {
      $mergeObjects: [
        { consecutiveFailures: 0, rapidRefills: 0, turnsSinceMerge: 0, breaker: null },
        { $ifNull: ['$hippocampus.breaker_state', {}] },
        { consecutiveFailures: 0, rapidRefills: 0, turnsSinceMerge: 0, breaker: null },
      ],
    },
    'hippocampus.snapshot_version': {
      $add: [{ $ifNull: ['$hippocampus.snapshot_version', 0] }, 1],
    },
    revision: { $add: [{ $ifNull: ['$revision', 0] }, 1] },
  }
}

function guardedProjectContextValue(
  currentPath: string,
  job: DurableCompactionJobRecord,
): unknown {
  const snapshot = job.merge_project_context_snapshot ?? job.project_context_snapshot
  if (!snapshot) return `$${currentPath}`
  return {
    $cond: [
      {
        $lte: [
          { $ifNull: [`$${currentPath}.epoch`, -1] },
          snapshot.epoch,
        ],
      },
      { $literal: structuredClone(snapshot) },
      `$${currentPath}`,
    ],
  }
}

/**
 * Settle the context-independent runtime epoch after the owner swap but before
 * the Job is allowed to become `merged`. A marker inside Hippocampus makes the
 * update replay-safe across both crash windows:
 *
 *   owner swap -> [crash] -> runtime settlement
 *   runtime settlement -> [crash] -> Job finalize
 *
 * A newer Project Context epoch always wins. Compaction may replace history,
 * but it cannot roll back a guide/workspace snapshot created by a later Run.
 */
export async function settleAppliedCompactionRuntime(
  claim: ClaimedCompactionJob,
): Promise<boolean> {
  const job = await DurableCompactionJobModel.findOne(
    liveJobLeaseFilter(
      claim.job.job_id,
      claim.ownerId,
      claim.fenceToken,
      ['merge_prepared'],
    ),
  ).lean<DurableCompactionJobRecord>()
  if (!job) return false
  if (job.runtime_settled_at) return true

  const owner = ownerFromJob(job)
  const ownerSnapshot = await loadOwnerSnapshot(owner)
  if (!ownerSnapshot || ownerSnapshot.lastAppliedCompactionId !== job.job_id) return false

  const markerFilter = {
    'hippocampus.last_settled_compaction_id': { $ne: job.job_id },
  }
  if (owner.kind === 'conversation') {
    const runtimeIdentity = {
      conversation_id: owner.conversationId,
      user_id: owner.userId,
    }
    const runtimeExists = Boolean(await ConversationRuntime.exists(runtimeIdentity))
    if (runtimeExists) {
      await ConversationRuntime.collection.updateOne(
        { ...runtimeIdentity, ...markerFilter },
        [
          {
            $set: {
              ...settledHippocampusFields(job.job_id),
              project_context_snapshot: guardedProjectContextValue(
                'project_context_snapshot',
                job,
              ),
            },
          },
          { $unset: 'hippocampus.active_compaction' },
        ],
      )
      const settled = await ConversationRuntime.exists({
        ...runtimeIdentity,
        'hippocampus.last_settled_compaction_id': job.job_id,
      })
      if (!settled) return false
    }
    // Legacy Conversations may not have a Runtime until their next Run. The
    // active context is already correct; creating a partial runtime here would
    // be less safe than allowing normal runtime initialization to proceed.
  } else {
    const sessionIdentity = {
      session_id: owner.sessionId,
      conversation_id: owner.conversationId,
      user_id: owner.userId,
      last_applied_compaction_id: job.job_id,
    }
    await AgentSessionRuntimeModel.collection.updateOne(
      { ...sessionIdentity, ...markerFilter },
      [
        {
          $set: {
            ...settledHippocampusFields(job.job_id),
            'hippocampus.project_context_snapshot': guardedProjectContextValue(
              'hippocampus.project_context_snapshot',
              job,
            ),
          },
        },
        { $unset: 'hippocampus.active_compaction' },
      ],
    )
    const settled = await AgentSessionRuntimeModel.exists({
      ...sessionIdentity,
      'hippocampus.last_settled_compaction_id': job.job_id,
    })
    if (!settled) return false
  }

  const settledAt = new Date()
  const marked = await DurableCompactionJobModel.updateOne(
    {
      ...liveJobLeaseFilter(
        job.job_id,
        claim.ownerId,
        claim.fenceToken,
        ['merge_prepared'],
      ),
      $or: [
        { runtime_settled_at: null },
        { runtime_settled_at: { $exists: false } },
      ],
    },
    { $set: { runtime_settled_at: settledAt } },
  )
  if (marked.matchedCount === 1) return true
  const replay = await DurableCompactionJobModel.exists({
    job_id: job.job_id,
    runtime_settled_at: { $type: 'date' },
  })
  return Boolean(replay)
}

/** Phase 2: converge Job state after the owner swap, including crash takeover. */
export async function finalizeAppliedCompactionJob(
  claim: ClaimedCompactionJob,
): Promise<ApplyCompactionResult> {
  const job = await getDurableCompactionJob(claim.job.job_id)
  if (!job) return { outcome: 'owner_missing', reason: 'Compaction Job no longer exists.' }
  if (job.status === 'merged') {
    return { outcome: 'already_merged', contextRevision: job.merged_context_revision ?? undefined }
  }
  const liveLease = await DurableCompactionJobModel.exists(
    liveJobLeaseFilter(
      claim.job.job_id,
      claim.ownerId,
      claim.fenceToken,
      ['merge_prepared'],
    ),
  )
  if (!liveLease) return { outcome: 'lost_lease' }
  const snapshot = await loadOwnerSnapshot(ownerFromJob(job))
  if (!snapshot) return { outcome: 'owner_missing' }
  if (snapshot.lastAppliedCompactionId !== job.job_id) {
    return { outcome: 'conflict', reason: 'Owner has not applied this Compaction Job.' }
  }
  if (!job.runtime_settled_at) {
    return { outcome: 'conflict', reason: 'Runtime epoch has not settled this Compaction Job.' }
  }
  if (!await markMergedWithFence(claim, snapshot.contextRevision)) {
    return { outcome: 'lost_lease', contextRevision: snapshot.contextRevision }
  }
  // Crash takeover may have re-installed a fence after the owner swap had
  // already committed. Terminal convergence must not leave that barrier set.
  await clearOwnerFence(job, claim.fenceToken)
  return { outcome: 'merged', contextRevision: snapshot.contextRevision }
}

export async function applyPreparedCompaction(
  claim: ClaimedCompactionJob,
): Promise<ApplyCompactionResult> {
  const applied = await applyPreparedMergeToOwner(claim)
  if (applied.outcome !== 'merged' && applied.outcome !== 'already_merged') return applied
  if (!await settleAppliedCompactionRuntime(claim)) {
    return { outcome: 'lost_lease', reason: 'Runtime compaction settlement did not commit.' }
  }
  return finalizeAppliedCompactionJob(claim)
}

async function clearOwnerFence(job: DurableCompactionJobRecord, fenceToken: string): Promise<void> {
  const filter = {
    'context_compaction_fence.job_id': job.job_id,
    'context_compaction_fence.fence_token': fenceToken,
  }
  const update = { $set: { context_compaction_fence: null } }
  if (job.owner_kind === 'conversation') {
    await Conversation.updateOne({
      conversation_id: job.conversation_id,
      user_id: job.user_id,
      ...filter,
    }, update)
  } else {
    await AgentSessionRuntimeModel.updateOne({
      session_id: job.agent_session_id,
      conversation_id: job.conversation_id,
      user_id: job.user_id,
      ...filter,
    }, update)
  }
}

export async function releaseCompactionForRetry(
  claim: ClaimedCompactionJob,
  error: string,
  delayMs: number,
): Promise<boolean> {
  const now = new Date()
  const prior = await transitionCompactionStatus({
    filter: liveJobLeaseFilter(claim.job.job_id, claim.ownerId, claim.fenceToken),
    status: 'retryable',
    set: {
      lease: null,
      last_error: error,
      available_at: new Date(now.getTime() + Math.max(0, delayMs)),
    },
    unset: ['source_turn_guard'],
    reason: error,
    returnDocument: 'before',
  })
  if (!prior) return false
  await clearOwnerFence(prior, claim.fenceToken)
  return true
}

export async function failCompactionJob(
  claim: ClaimedCompactionJob,
  error: string,
): Promise<boolean> {
  const prior = await transitionCompactionStatus({
    filter: liveJobLeaseFilter(claim.job.job_id, claim.ownerId, claim.fenceToken),
    status: 'failed',
    set: {
      lease: null,
      last_error: error,
      finished_at: new Date(),
    },
    unset: ['active_key', 'source_turn_guard'],
    reason: error,
    returnDocument: 'before',
  })
  if (!prior) return false
  await clearOwnerFence(prior, claim.fenceToken)
  return true
}

/**
 * Terminalize an orphaned Job even if its lease expired while discovering the
 * missing owner. The exact fence token still prevents a stale executor from
 * clearing a Job already taken over by another worker.
 */
export async function failCompactionJobForMissingOwner(
  claim: ClaimedCompactionJob,
  error = 'Compaction context owner was deleted before merge.',
): Promise<boolean> {
  const claimed = await DurableCompactionJobModel.findOne({
    job_id: claim.job.job_id,
    status: { $in: ['queued', 'summarizing', 'summary_ready', 'merge_prepared', 'retryable'] },
    'lease.owner_id': claim.ownerId,
    'lease.fence_token': claim.fenceToken,
  }).lean<DurableCompactionJobRecord>()
  if (!claimed) return false
  if (await loadOwnerSnapshot(ownerFromJob(claimed))) return false

  const prior = await transitionCompactionStatus({
    filter: {
      job_id: claimed.job_id,
      status: { $in: ['queued', 'summarizing', 'summary_ready', 'merge_prepared', 'retryable'] },
      'lease.owner_id': claim.ownerId,
      'lease.fence_token': claim.fenceToken,
    },
    status: 'failed',
    set: {
      lease: null,
      last_error: error,
      finished_at: new Date(),
    },
    unset: ['active_key', 'source_turn_guard'],
    reason: error,
    returnDocument: 'before',
  })
  if (!prior) return false
  await clearOwnerFence(prior, claim.fenceToken)
  return true
}

const PREPARE_SAFE_TERMINATION_STATUSES: DurableCompactionJobRecord['status'][] = [
  'queued',
  'summarizing',
  'summary_ready',
  'retryable',
]

const UNCLAIMED_SHADOW_FILTER = {
  status: 'queued',
  $or: [
    { lease: null },
    { lease: { $exists: false } },
  ],
} as const

/**
 * Make a persisted shadow intent immediately claimable. The immutable owner
 * identity and one of the Job's joined idempotency keys are both required, so
 * a stale Run cannot activate a successor Job for the same Conversation.
 */
export async function activateDurableCompactionJob(
  input: DurableCompactionJobCommandInput,
): Promise<DurableCompactionJobCommandResult> {
  await connectDB()
  const now = new Date()
  const activated = await DurableCompactionJobModel.findOneAndUpdate(
    {
      ...commandIdentityFilter(input),
      active_key: { $type: 'string' },
      status: {
        $in: ['queued', 'summarizing', 'summary_ready', 'merge_prepared', 'retryable'],
      },
      // Missing/null means immediately claimable already. Only move a real
      // future deadline, making replay observable as changed=false.
      available_at: { $gt: now },
      $and: [noLiveSourceTurnGuardFilter(now)],
    },
    {
      $set: { available_at: now },
      $unset: { source_turn_guard: 1 },
    },
    { returnDocument: 'after' },
  ).lean<DurableCompactionJobRecord>()
  if (activated) return { job: activated, changed: true }
  return { job: await requireCommandJob(input), changed: false }
}

/**
 * Operator-only activation boundary. Unlike the rolling-deploy/runtime command
 * above, this command is deliberately strict: a worker claim or any status
 * transition wins the race and activation fails closed. An already-claimable
 * exact queued barrier is the only idempotent changed=false result.
 */
export async function activateUnclaimedQueuedDurableCompactionJob(
  input: DurableCompactionJobCommandInput,
): Promise<DurableCompactionJobCommandResult> {
  await connectDB()
  const now = new Date()
  const strictActivationFilter: Record<string, unknown> = {
    ...commandIdentityFilter(input),
    active_key: compactionOwnerKey(input.owner),
    ...UNCLAIMED_SHADOW_FILTER,
    available_at: { $gt: now },
    $and: [noLiveSourceTurnGuardFilter(now)],
  }
  const activated = await DurableCompactionJobModel.findOneAndUpdate(
    strictActivationFilter,
    {
      $set: { available_at: now },
      $unset: { source_turn_guard: 1 },
    },
    { returnDocument: 'after' },
  ).lean<DurableCompactionJobRecord>()
  if (activated) return { job: activated, changed: true }

  const current = await requireCommandJob(input)
  const alreadyClaimable = current.active_key === compactionOwnerKey(input.owner)
    && current.status === 'queued'
    && !current.lease
    && !isSourceTurnCompactionGuardLive(current.source_turn_guard, now)
    && (!current.available_at || new Date(current.available_at).getTime() <= now.getTime())
  if (alreadyClaimable) return { job: current, changed: false }
  throw new CompactionJobNotUnclaimedQueuedError()
}

/**
 * Offer a completed local summary to the single durable owner. The local
 * executor never mutates Conversation/AgentSession context after this point.
 */
export async function offerPreparedCompactionSummary(
  input: OfferPreparedCompactionSummaryInput,
): Promise<OfferPreparedCompactionSummaryResult> {
  await connectDB()
  const summary = input.summary.trim()
  if (!summary) throw new Error('A prepared compaction summary cannot be empty.')
  const identity = commandIdentityFilter(input)
  const current = await requireCommandJob(input)
  if (current.frozen_prefix.prefix_hash !== input.expectedPrefixHash) {
    throw new CompactionPrefixConflictError(
      'Prepared summary prefix hash does not match the durable Job.',
    )
  }
  if (current.status === 'summary_ready' && current.summary === summary) {
    return { outcome: 'already_offered', job: current }
  }
  if (current.status !== 'queued' || current.lease) {
    return { outcome: 'durable_owned', job: current }
  }
  const transitioned = await transitionCompactionStatus({
    filter: {
      ...identity,
      active_key: { $type: 'string' },
      status: 'queued',
      'frozen_prefix.prefix_hash': input.expectedPrefixHash,
      $and: [
        unleasedCompactionFilter(),
        sourceTurnGuardCommandFilter(new Date(), input.guardToken),
      ],
    },
    status: 'summary_ready',
    set: {
      summary,
      summary_usage: input.usage ?? null,
      available_at: new Date(),
    },
    unset: ['source_turn_guard'],
  })
  if (transitioned) return { outcome: 'accepted', job: transitioned }

  const winner = await requireCommandJob(input)
  if (winner.frozen_prefix.prefix_hash !== input.expectedPrefixHash) {
    throw new CompactionPrefixConflictError(
      'Prepared summary lost an exact-prefix race.',
    )
  }
  if (winner.status === 'summary_ready' && winner.summary === summary) {
    return { outcome: 'already_offered', job: winner }
  }
  return { outcome: 'durable_owned', job: winner }
}

/**
 * Retire the latest failed durable intent after a synchronous owner repair has
 * already committed. This command never writes the replacement itself: the
 * caller must provide the exact new head message ID and this boundary verifies
 * it against the canonical owner before changing Job status.
 */
export async function closeFailedCompactionAfterSynchronousRepair(
  input: CloseFailedCompactionRepairInput,
): Promise<DurableCompactionJobCommandResult> {
  await connectDB()
  const replacementMessageId = input.replacementMessageId.trim()
  if (!replacementMessageId) {
    throw new CompactionPrefixConflictError(
      'Synchronous repair requires the committed replacement message ID.',
    )
  }

  const current = await requireCommandJob(input)
  if (current.status === 'superseded' && current.last_error === 'sync_repair') {
    return { job: current, changed: false }
  }

  // "Latest" is over every Job for the owner, not only failed Jobs. A stale
  // Run must never retire an older failure after a successor was created.
  const latest = await DurableCompactionJobModel.findOne({
    owner_key: compactionOwnerKey(input.owner),
  }).sort({ created_at: -1, job_id: -1 }).lean<DurableCompactionJobRecord>()
  if (
    !latest
    || latest.job_id !== current.job_id
    || latest.status !== 'failed'
    || latest.active_key
  ) {
    return { job: current, changed: false }
  }
  if (await DurableCompactionJobModel.exists({
    active_key: compactionOwnerKey(input.owner),
  })) {
    return { job: current, changed: false }
  }

  const ownerSnapshot = await loadOwnerSnapshot(input.owner)
  if (
    !ownerSnapshot
    || ownerSnapshot.contextRevision <= current.frozen_prefix.context_revision
    || ownerSnapshot.activeMessages[0]?.message_id !== replacementMessageId
  ) {
    throw new CompactionPrefixConflictError(
      'Synchronous repair replacement is not the canonical owner head.',
    )
  }

  const transitioned = await transitionCompactionStatus({
    filter: {
      ...commandIdentityFilter(input),
      status: 'failed',
      $and: [
        {
          $or: [
            { active_key: null },
            { active_key: { $exists: false } },
          ],
        },
      ],
    },
    status: 'superseded',
    set: {
      lease: null,
      last_error: 'sync_repair',
      finished_at: new Date(),
    },
    reason: 'sync_repair',
  })
  if (transitioned) return { job: transitioned, changed: true }

  const replay = await requireCommandJob(input)
  return {
    job: replay,
    changed: false,
  }
}

async function terminateDurableCompactionJob(
  input: TerminateDurableCompactionJobInput,
  status: 'cancelled' | 'superseded',
): Promise<DurableCompactionJobCommandResult> {
  await connectDB()
  const reason = input.reason.trim().slice(0, 2_000) || status
  const terminationFilter: Record<string, unknown> = {
    ...commandIdentityFilter(input),
    active_key: { $type: 'string' },
    // A local merge may supersede only a shadow that no worker has claimed.
    // Once claimed, the durable path owns the prefix even while its status
    // still says queued. Explicit cancellation remains allowed until merge
    // preparation, but it never authorizes a competing local replacement.
    ...(status === 'superseded'
      ? UNCLAIMED_SHADOW_FILTER
      : { status: { $in: PREPARE_SAFE_TERMINATION_STATUSES } }),
    $and: [sourceTurnGuardCommandFilter(new Date(), input.guardToken)],
  }
  const prior = await transitionCompactionStatus({
    filter: terminationFilter,
    status,
    set: {
      lease: null,
      last_error: reason,
      finished_at: new Date(),
    },
    unset: ['active_key', 'source_turn_guard'],
    reason,
    returnDocument: 'before',
  })
  if (!prior) return { job: await requireCommandJob(input), changed: false }
  if (prior.lease?.fence_token) {
    await clearOwnerFence(prior, prior.lease.fence_token)
  }
  const job = await requireCommandJob(input)
  return { job, changed: true }
}

/**
 * Roll back an operator-prepared admission barrier only while no worker can
 * own it. The exact command identity and exact owner active-key are required;
 * a concurrent claim/status transition causes changed=false and is left for
 * explicit operator intervention rather than cancelling live work.
 */
export async function cancelUnclaimedQueuedDurableCompactionJob(
  input: TerminateDurableCompactionJobInput,
): Promise<DurableCompactionJobCommandResult> {
  await connectDB()
  const reason = input.reason.trim().slice(0, 2_000) || 'operator_prepare_revalidation'
  const transitioned = await transitionCompactionStatus({
    filter: {
      ...commandIdentityFilter(input),
      active_key: compactionOwnerKey(input.owner),
      ...UNCLAIMED_SHADOW_FILTER,
      $and: [noLiveSourceTurnGuardFilter(new Date())],
    },
    status: 'cancelled',
    set: {
      lease: null,
      last_error: reason,
      finished_at: new Date(),
    },
    unset: ['active_key', 'source_turn_guard'],
    reason,
  })
  if (transitioned) return { job: transitioned, changed: true }
  return { job: await requireCommandJob(input), changed: false }
}

/** User/request cancellation before a replacement owns the merge boundary. */
export async function cancelDurableCompactionJob(
  input: TerminateDurableCompactionJobInput,
): Promise<DurableCompactionJobCommandResult> {
  return terminateDurableCompactionJob(input, 'cancelled')
}

/** Local compaction won; retire its durable shadow without deleting audit data. */
export async function supersedeDurableCompactionJob(
  input: TerminateDurableCompactionJobInput,
): Promise<DurableCompactionJobCommandResult> {
  return terminateDurableCompactionJob(input, 'superseded')
}

/**
 * Legacy cancellation boundary. Kept for rolling deploy compatibility, but
 * now obeys the same pre-merge safety rule as the authenticated command API.
 */
export async function cancelCompactionJob(
  jobId: string,
  userId: string,
  reason: string,
): Promise<boolean> {
  await connectDB()
  const prior = await transitionCompactionStatus({
    filter: {
      job_id: jobId,
      user_id: userId,
      active_key: { $type: 'string' },
      status: { $in: PREPARE_SAFE_TERMINATION_STATUSES },
      $and: [noLiveSourceTurnGuardFilter(new Date())],
    },
    status: 'cancelled',
    set: {
      lease: null,
      last_error: reason,
      finished_at: new Date(),
    },
    unset: ['active_key', 'source_turn_guard'],
    reason,
    returnDocument: 'before',
  })
  if (!prior) return false
  if (prior.lease?.fence_token) await clearOwnerFence(prior, prior.lease.fence_token)
  return true
}

/** Make an already-persisted shadow intent immediately claimable. */
export async function activatePreparedCompactionJob(
  jobId: string,
  userId: string,
): Promise<boolean> {
  await connectDB()
  const result = await DurableCompactionJobModel.updateOne(
    {
      job_id: jobId,
      user_id: userId,
      active_key: { $type: 'string' },
      status: { $in: ['queued', 'summarizing', 'summary_ready', 'merge_prepared', 'retryable'] },
      $and: [noLiveSourceTurnGuardFilter(new Date())],
    },
    {
      $set: { available_at: new Date() },
      $unset: { source_turn_guard: 1 },
    },
  )
  return result.matchedCount === 1
}

/** Reap only the owner fence. Expired summarizing Jobs remain claimable. */
export async function clearExpiredContextCompactionFences(now = new Date()): Promise<number> {
  await connectDB()
  const [conversations, sessions] = await Promise.all([
    Conversation.updateMany(
      { 'context_compaction_fence.expires_at': { $lte: now } },
      { $set: { context_compaction_fence: null } },
    ),
    AgentSessionRuntimeModel.updateMany(
      { 'context_compaction_fence.expires_at': { $lte: now } },
      { $set: { context_compaction_fence: null } },
    ),
  ])
  return conversations.modifiedCount + sessions.modifiedCount
}

/** Remove frozen summaries after the owning project is deleted. */
export async function deleteCompactionJobsForConversation(
  conversationId: string,
  userId: string,
): Promise<number> {
  await connectDB()
  const result = await DurableCompactionJobModel.deleteMany({
    conversation_id: conversationId,
    user_id: userId,
  })
  return result.deletedCount
}
