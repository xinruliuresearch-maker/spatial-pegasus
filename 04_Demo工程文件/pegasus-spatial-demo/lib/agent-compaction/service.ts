import { createHash } from 'crypto'
import { buildAsyncCompactionMessage } from '../agent/compaction'
import type { ConversationMessage } from '../types'
import {
  applyPreparedCompaction,
  beginCompactionSummary,
  establishContextCompactionFence,
  failCompactionJob,
  failCompactionJobForMissingOwner,
  getDurableCompactionJob,
  heartbeatCompactionJob,
  prepareDurableMergeContext,
  prepareCompactionMerge,
  releaseCompactionForRetry,
  saveCompactionSummary,
} from './repository'
import type {
  ApplyCompactionResult,
  ClaimedCompactionJob,
  DurableCompactionJobRecord,
  DurableCompactionProcessor,
} from './types'

const DEFAULT_HEARTBEAT_MS = 20_000
const DEFAULT_MAX_ATTEMPTS = 5

export class DurableCompactionLeaseLostError extends Error {
  readonly code = 'DURABLE_COMPACTION_LEASE_LOST'
  constructor(jobId: string) {
    super(`Durable CompactionJob lease was lost: ${jobId}`)
    this.name = 'DurableCompactionLeaseLostError'
  }
}

function replacementMessageId(jobId: string): string {
  return `cmpmsg_${createHash('sha256').update(jobId).digest('hex').slice(0, 40)}`
}

/**
 * Deterministic replacement construction is required for crash replay. The
 * timestamp is the Job creation time, not the retry time.
 */
export async function buildDefaultDurableReplacement(
  job: DurableCompactionJobRecord,
  summary: string,
): Promise<ConversationMessage> {
  return buildAsyncCompactionMessage(summary, {
    ...((job.merge_workspace_projection ?? job.workspace_projection)
      ? { workspaceProjection: job.merge_workspace_projection ?? job.workspace_projection! }
      : {}),
    ...((job.merge_project_context_snapshot ?? job.project_context_snapshot)
      ? { projectContext: job.merge_project_context_snapshot ?? job.project_context_snapshot! }
      : {}),
    messageId: replacementMessageId(job.job_id),
    ...(job.source_run_id ? { runId: job.source_run_id } : {}),
    timestamp: job.created_at,
  })
}

async function refreshClaimJob(claim: ClaimedCompactionJob): Promise<DurableCompactionJobRecord> {
  const job = await getDurableCompactionJob(claim.job.job_id)
  if (!job) throw new Error(`Compaction Job disappeared: ${claim.job.job_id}`)
  claim.job = job
  return job
}

async function summarizeWithHeartbeat(
  claim: ClaimedCompactionJob,
  processor: DurableCompactionProcessor,
  heartbeatMs: number,
  leaseMs: number,
  parentSignal?: AbortSignal,
): Promise<Awaited<ReturnType<DurableCompactionProcessor['summarize']>>> {
  const controller = new AbortController()
  let leaseLost = false
  let heartbeatInFlight = false
  const timer = setInterval(() => {
    if (heartbeatInFlight || leaseLost) return
    heartbeatInFlight = true
    void heartbeatCompactionJob(claim, leaseMs).then(alive => {
      if (!alive) {
        leaseLost = true
        controller.abort(new DurableCompactionLeaseLostError(claim.job.job_id))
      }
    }).catch(() => {
      // A transient heartbeat DB failure is not proof of lease loss. The owner
      // write remains fenced by the persisted expiry and will fail closed.
    }).finally(() => {
      heartbeatInFlight = false
    })
  }, Math.max(1_000, heartbeatMs))
  timer.unref?.()
  try {
    const signal = parentSignal
      ? AbortSignal.any([controller.signal, parentSignal])
      : controller.signal
    const outcome = await processor.summarize(claim.job, signal)
    if (leaseLost) throw new DurableCompactionLeaseLostError(claim.job.job_id)
    return outcome
  } finally {
    clearInterval(timer)
  }
}

export interface ProcessCompactionOptions {
  heartbeatMs?: number
  leaseMs?: number
  maxAttempts?: number
  retryBaseDelayMs?: number
  /** Worker shutdown aborts the external request but leaves the Job retryable. */
  signal?: AbortSignal
}

/**
 * Execute one claimed Job to a terminal merge. Every phase is durable; calling
 * this again after any process crash resumes from the persisted phase.
 */
export async function processClaimedCompactionJob(
  claim: ClaimedCompactionJob,
  processor: DurableCompactionProcessor,
  options: ProcessCompactionOptions = {},
): Promise<ApplyCompactionResult> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const leaseMs = Math.max(heartbeatMs * 3, options.leaseMs ?? 90_000)
  const retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? 2_000)

  if (!await establishContextCompactionFence(claim)) {
    if (await failCompactionJobForMissingOwner(claim)) {
      return {
        outcome: 'owner_missing',
        reason: 'Compaction context owner was deleted before merge.',
      }
    }
    return { outcome: 'lost_lease', reason: 'Could not establish the context fence.' }
  }

  try {
    let job = await refreshClaimJob(claim)
    if (job.status === 'merged') {
      return { outcome: 'already_merged', contextRevision: job.merged_context_revision ?? undefined }
    }

    if (!job.summary?.trim()) {
      if (!await beginCompactionSummary(claim)) {
        throw new DurableCompactionLeaseLostError(job.job_id)
      }
      job = await refreshClaimJob(claim)
      const summary = await summarizeWithHeartbeat(
        claim,
        processor,
        heartbeatMs,
        leaseMs,
        options.signal,
      )
      if (!summary.summary.trim()) throw new Error('Compaction processor returned an empty summary.')
      if (!await saveCompactionSummary(claim, summary.summary, summary.usage ?? null)) {
        throw new DurableCompactionLeaseLostError(job.job_id)
      }
      job = await refreshClaimJob(claim)
    }

    if (!job.replacement_message) {
      const mergeContext = await prepareDurableMergeContext(claim)
      if (!mergeContext) throw new DurableCompactionLeaseLostError(job.job_id)
      job = mergeContext
      claim.job = mergeContext
      const replacement = processor.buildReplacement
        ? await processor.buildReplacement(job, job.summary!)
        : await buildDefaultDurableReplacement(job, job.summary!)
      if (!await prepareCompactionMerge(claim, replacement)) {
        throw new DurableCompactionLeaseLostError(job.job_id)
      }
      job = await refreshClaimJob(claim)
    } else if (job.status === 'retryable') {
      if (!await prepareCompactionMerge(claim, job.replacement_message)) {
        throw new DurableCompactionLeaseLostError(job.job_id)
      }
      job = await refreshClaimJob(claim)
    }

    const merged = await applyPreparedCompaction(claim)
    if (merged.outcome === 'conflict' || merged.outcome === 'owner_missing') {
      const reason = merged.reason ?? (
        merged.outcome === 'owner_missing'
          ? 'Compaction context owner was deleted before merge.'
          : 'Frozen context prefix no longer matches.'
      )
      if (merged.outcome === 'owner_missing') {
        await failCompactionJobForMissingOwner(claim, reason)
      } else {
        await failCompactionJob(claim, reason)
      }
    }
    return merged
  } catch (error) {
    if (error instanceof DurableCompactionLeaseLostError) {
      return { outcome: 'lost_lease', reason: error.message }
    }
    const latest = await getDurableCompactionJob(claim.job.job_id)
    const message = error instanceof Error ? error.message : String(error)
    const fatal = typeof error === 'object'
      && error !== null
      && 'recoverability' in error
      && (error as { recoverability?: unknown }).recoverability === 'fatal'
    if (fatal || (latest?.attempt ?? claim.job.attempt) >= maxAttempts) {
      await failCompactionJob(claim, message)
    } else {
      const attempt = Math.max(1, latest?.attempt ?? claim.job.attempt)
      const delay = Math.min(60_000, retryBaseDelayMs * (2 ** (attempt - 1)))
      await releaseCompactionForRetry(claim, message, delay)
    }
    return { outcome: 'conflict', reason: message }
  }
}
