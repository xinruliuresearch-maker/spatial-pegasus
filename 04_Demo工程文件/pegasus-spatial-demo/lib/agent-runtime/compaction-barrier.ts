import { connectDB } from '../db/mongodb'
import { DurableCompactionJobModel } from '../agent-compaction/models'
import { compactionOwnerKey, type DurableCompactionStatus } from '../agent-compaction/types'
import type { AgentRunDocument } from './models'

export const ACTIVE_COMPACTION_BARRIER_STATUSES = [
  'queued',
  'summarizing',
  'summary_ready',
  'merge_prepared',
  'retryable',
] as const satisfies readonly DurableCompactionStatus[]

type ActiveCompactionBarrierStatus = typeof ACTIVE_COMPACTION_BARRIER_STATUSES[number]

const ACTIVE_STATUS_SET = new Set<string>(ACTIVE_COMPACTION_BARRIER_STATUSES)
const OPEN_TERMINAL_STATUS_SET = new Set<string>([
  'merged',
  'cancelled',
  // Reserved for a future explicit replacement transition. Treating it as an
  // open terminal state now makes rolling schema upgrades fail safely without
  // teaching the Runner about a second compaction implementation.
  'superseded',
])

const DEFAULT_BARRIER_RECHECK_MS = 2_000
const MAX_BARRIER_RECHECK_MS = 5_000
const COMPACTION_PREFIX_CONFLICT_CODE = 'COMPACTION_PREFIX_CONFLICT'

interface CompactionBarrierJobSnapshot {
  job_id: string
  idempotency_key?: string
  status: string
  available_at?: Date | null
  last_error?: string | null
  created_at?: Date | null
}

export type CompactionBarrierDecision =
  | {
      kind: 'open'
      ownerKey: string | null
      terminalJobId?: string
      terminalStatus?: string
      terminalIdempotencyKey?: string
      repairRequired?: boolean
      terminalError?: string
    }
  | {
      kind: 'defer'
      ownerKey: string
      jobId: string
      status: ActiveCompactionBarrierStatus
      retryAt: Date
    }
  | {
      kind: 'failed'
      ownerKey: string
      jobId: string
      error: string
    }

export type ExecutorCompactionBarrierStop =
  | {
      kind: 'deferred'
      jobId: string
      retryAt: Date
    }
  | {
      kind: 'failed'
      jobId: string
      error: string
    }
  | {
      kind: 'detached'
      jobId: string
      error: string
    }

/**
 * Non-error control flow used only after the HTTP executor has accepted a
 * leased Run. The Run transition is already durable before this is thrown;
 * route/member catch boundaries must return immediately without applying the
 * ordinary execution-failure policy.
 */
export class ExecutorCompactionBarrierStoppedError extends Error {
  readonly code = 'EXECUTOR_COMPACTION_BARRIER_STOPPED'

  constructor(readonly stop: ExecutorCompactionBarrierStop) {
    super(
      stop.kind === 'deferred'
        ? `Run deferred for context compaction Job ${stop.jobId}.`
        : stop.error,
    )
    this.name = 'ExecutorCompactionBarrierStoppedError'
  }
}

/**
 * A Root Run owns its Conversation context. A member Run owns its private
 * AgentSession context. Incomplete member identity is left to the Team
 * identity fence, which can provide the more precise terminal error.
 */
export function compactionBarrierOwnerKeyForRun(
  run: Pick<AgentRunDocument, 'execution_mode' | 'conversation_id' | 'agent_session_id'>,
): string | null {
  if (run.execution_mode === 'agent_session') {
    return run.agent_session_id
      ? compactionOwnerKey({
          kind: 'agent_session',
          sessionId: run.agent_session_id,
          conversationId: run.conversation_id,
          userId: '',
        })
      : null
  }
  return compactionOwnerKey({
    kind: 'conversation',
    conversationId: run.conversation_id,
    userId: '',
  })
}

function retryAtForActiveCompaction(
  job: CompactionBarrierJobSnapshot,
  now: Date,
): Date {
  const availableAt = job.available_at instanceof Date
    ? job.available_at.getTime()
    : Number.NaN
  const untilJobAvailable = Number.isFinite(availableAt)
    ? Math.max(0, availableAt - now.getTime())
    : 0
  // Poll slowly enough to avoid a hot loop, but never inherit an arbitrarily
  // long compaction backoff. A Job may be merged/cancelled by another process
  // before available_at, and the deferred Run should resume promptly.
  const delayMs = Math.min(
    MAX_BARRIER_RECHECK_MS,
    Math.max(DEFAULT_BARRIER_RECHECK_MS, untilJobAvailable),
  )
  return new Date(now.getTime() + delayMs)
}

/** Pure status classifier used by the Mongo-backed double-check. */
export function classifyCompactionBarrierJob(
  ownerKey: string,
  job: CompactionBarrierJobSnapshot | null,
  now = new Date(),
): CompactionBarrierDecision {
  if (!job) return { kind: 'open', ownerKey }
  if (ACTIVE_STATUS_SET.has(job.status)) {
    return {
      kind: 'defer',
      ownerKey,
      jobId: job.job_id,
      status: job.status as ActiveCompactionBarrierStatus,
      retryAt: retryAtForActiveCompaction(job, now),
    }
  }
  if (job.status === 'failed') {
    const detail = job.last_error?.trim() || 'the compaction worker exhausted its retry policy'
    return {
      kind: 'open',
      ownerKey,
      terminalJobId: job.job_id,
      terminalStatus: job.status,
      terminalIdempotencyKey: job.idempotency_key,
      repairRequired: true,
      terminalError: `Context compaction Job ${job.job_id} failed: ${detail}`,
    }
  }
  if (OPEN_TERMINAL_STATUS_SET.has(job.status)) {
    return {
      kind: 'open',
      ownerKey,
      terminalJobId: job.job_id,
      terminalStatus: job.status,
      terminalIdempotencyKey: job.idempotency_key,
    }
  }
  // Unknown states are not permission to run against a potentially stale or
  // over-budget context. Fail closed and surface an actionable persisted Run
  // failure instead of waiting forever or silently bypassing the barrier.
  return {
    kind: 'failed',
    ownerKey,
    jobId: job.job_id,
    error: `Context compaction Job ${job.job_id} has unsupported status ${job.status}.`,
  }
}

/**
 * Read the barrier twice by intent: callers invoke this before acquiring Team
 * execution leases and again immediately before HTTP dispatch. The active-key
 * lookup takes precedence; after it terminalizes, the latest owner Job keeps a
 * failed compaction from being mistaken for a safe, empty barrier.
 */
export async function inspectRunCompactionBarrier(
  run: Pick<AgentRunDocument,
    'execution_mode' | 'conversation_id' | 'agent_session_id' | 'user_id'>,
  now = new Date(),
): Promise<CompactionBarrierDecision> {
  const ownerKey = compactionBarrierOwnerKeyForRun(run)
  if (!ownerKey) return { kind: 'open', ownerKey: null }

  await connectDB()
  const projection = 'job_id idempotency_key status available_at last_error created_at'
  const active = await DurableCompactionJobModel.findOne({
    active_key: ownerKey,
    user_id: run.user_id,
  }).select(projection).lean<CompactionBarrierJobSnapshot>()
  if (active) return classifyCompactionBarrierJob(ownerKey, active, now)

  const latest = await DurableCompactionJobModel.findOne({
    owner_key: ownerKey,
    user_id: run.user_id,
  }).sort({ created_at: -1, _id: -1 }).select(projection).lean<CompactionBarrierJobSnapshot>()
  return classifyCompactionBarrierJob(ownerKey, latest, now)
}

/**
 * Final executor-side barrier, immediately before AgentLoop/provider entry.
 * This closes the race where Runner's pre-dispatch read was open and an older
 * execution handed off a Job before the HTTP executor reached its first model
 * request. The same Run is durably deferred; no request envelope is copied.
 */
export async function enforceExecutorCompactionBarrier(
  run: AgentRunDocument,
  ownerId: string,
  options?: {
    /**
     * Exact delayed shadow prepared by this live executor. It is safe to
     * ignore only at later request boundaries in the same process; recovery
     * and the pre-loop barrier deliberately never pass this value.
     */
    ignoreActiveJobId?: string
    /** The delayed shadow becomes normal durable ownership at this instant. */
    ignoreActiveJobBefore?: Date
  },
): Promise<CompactionBarrierDecision> {
  const decision = await inspectRunCompactionBarrier(run)
  if (decision.kind === 'open') return decision
  if (
    decision.kind === 'defer'
    && decision.status === 'queued'
    && options?.ignoreActiveJobId
    && decision.jobId === options.ignoreActiveJobId
    && options.ignoreActiveJobBefore instanceof Date
    && Number.isFinite(options.ignoreActiveJobBefore.getTime())
    && Date.now() < options.ignoreActiveJobBefore.getTime()
  ) {
    return decision
  }

  const repository = await import('./repository')
  if (decision.kind === 'defer') {
    const stored = await repository.deferAgentRunForCompactionBarrier(
      run.run_id,
      ownerId,
      decision.retryAt,
    )
    throw new ExecutorCompactionBarrierStoppedError(stored
      ? {
          kind: 'deferred',
          jobId: decision.jobId,
          retryAt: decision.retryAt,
        }
      : {
          kind: 'detached',
          jobId: decision.jobId,
          error: `Run lease changed while deferring for compaction Job ${decision.jobId}.`,
        })
  }

  const stored = await repository.failAgentRunForCompactionBarrier(
    run.run_id,
    ownerId,
    decision.error,
  )
  throw new ExecutorCompactionBarrierStoppedError(stored
    ? {
        kind: 'failed',
        jobId: decision.jobId,
        error: decision.error,
      }
    : {
        kind: 'detached',
        jobId: decision.jobId,
        error: `Run lease changed while opening the compaction circuit for Job ${decision.jobId}.`,
      })
}

/**
 * Requeue a live executor even if the Job already merged between checks. Its
 * in-memory messages were built from the pre-merge owner revision and must be
 * reloaded before any further model/tool work.
 */
export async function deferExecutorForCompactionReload(
  run: AgentRunDocument,
  ownerId: string,
  jobId: string,
  retryAt = new Date(Date.now() + DEFAULT_BARRIER_RECHECK_MS),
): Promise<never> {
  const repository = await import('./repository')
  const stored = await repository.deferAgentRunForCompactionBarrier(
    run.run_id,
    ownerId,
    retryAt,
  )
  throw new ExecutorCompactionBarrierStoppedError(stored
    ? { kind: 'deferred', jobId, retryAt }
    : {
        kind: 'detached',
        jobId,
        error: `Run lease changed while reloading after compaction Job ${jobId}.`,
      })
}

/**
 * Preparing a delayed compaction shadow races with ordinary durable context
 * appends (for example, Root mailbox delivery). A prefix conflict means the
 * in-memory snapshot is stale, not that the Conversation is corrupt. Requeue
 * the same Run so the executor rebuilds from the canonical persisted context.
 */
export function isReloadableCompactionPrepareConflict(cause: unknown): boolean {
  return Boolean(
    cause
    && typeof cause === 'object'
    && 'code' in cause
    && cause.code === COMPACTION_PREFIX_CONFLICT_CODE,
  )
}

/** Fail closed when delayed-shadow preparation cannot prove exact ownership. */
export async function failClosedExecutorCompactionPrepare(
  run: AgentRunDocument,
  ownerId: string,
  cause: unknown,
): Promise<never> {
  const decision = await inspectRunCompactionBarrier(run)
  if (decision.kind === 'defer') {
    return deferExecutorForCompactionReload(run, ownerId, decision.jobId, decision.retryAt)
  }
  if (decision.kind === 'open' && decision.terminalJobId) {
    return deferExecutorForCompactionReload(run, ownerId, decision.terminalJobId)
  }
  if (decision.kind === 'failed') {
    const repository = await import('./repository')
    const stored = await repository.failAgentRunForCompactionBarrier(
      run.run_id,
      ownerId,
      decision.error,
    )
    throw new ExecutorCompactionBarrierStoppedError(stored
      ? { kind: 'failed', jobId: decision.jobId, error: decision.error }
      : {
          kind: 'detached',
          jobId: decision.jobId,
          error: `Run lease changed while failing closed for compaction Job ${decision.jobId}.`,
      })
  }
  if (isReloadableCompactionPrepareConflict(cause)) {
    return deferExecutorForCompactionReload(
      run,
      ownerId,
      `context-reload:${run.run_id}:prefix-conflict`,
    )
  }
  throw cause
}
