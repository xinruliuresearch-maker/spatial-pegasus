import { randomUUID } from 'crypto'
import { memoryV2Flags } from './flags'
import { consolidateCandidates, extractRunMemory } from './extractor'
import {
  addPreference,
  claimPreferenceBatch,
  createHistoryEvent,
  createPreferenceCandidates,
  finalizeCandidate,
  getOrCreateProfile,
  leaseNextMemoryRun,
  MemoryProfileLimitError,
  MemoryQuotaExceededError,
  releaseRunAfterFailure,
  resetClaimedBatch,
  setMemoryRunStatus,
  updatePreference,
} from './repository'
import type { MemoryRunDocument } from './models'
import { getAgentRun } from '@/lib/agent-runtime/repository'
import {
  databaseRetryDelayMs,
  shouldLogDatabaseFailure,
} from '../db/retry-policy'

const POLL_MS = 3_000
let timer: NodeJS.Timeout | null = null
let active = false
let mongoFailureCount = 0
let mongoRetryAfter = 0
let mongoOutageStartedAt: number | null = null
let mongoLastLogAt: number | null = null

function noteMongoFailure(error: unknown): void {
  const now = Date.now()
  mongoFailureCount += 1
  mongoOutageStartedAt ??= now
  const retryMs = databaseRetryDelayMs(mongoFailureCount)
  mongoRetryAfter = now + retryMs
  if (shouldLogDatabaseFailure(mongoFailureCount, mongoLastLogAt, now)) {
    const attempts = mongoFailureCount > 1
      ? ` (${mongoFailureCount} failed polls)`
      : ''
    console.error(
      `[memory-v2] Mongo unavailable while leasing work${attempts}; `
      + `retrying in ${Math.ceil(retryMs / 1_000)}s: ${(error as Error).message}`,
    )
    mongoLastLogAt = now
  }
}

function noteMongoSuccess(): void {
  if (mongoFailureCount === 0) return
  const unavailableMs = mongoOutageStartedAt === null
    ? 0
    : Date.now() - mongoOutageStartedAt
  console.info(
    `[memory-v2] Mongo connection restored after ${Math.max(1, Math.round(unavailableMs / 1_000))}s; `
    + 'memory polling resumed',
  )
  mongoFailureCount = 0
  mongoRetryAfter = 0
  mongoOutageStartedAt = null
  mongoLastLogAt = null
}

async function processConsolidation(userId: string): Promise<void> {
  const batch = await claimPreferenceBatch(userId, 10)
  if (!batch.length) return
  const batchId = batch[0].batch_id
  try {
    const profile = await getOrCreateProfile(userId)
    const decisions = await consolidateCandidates(profile.preferences, batch)
    for (const decision of decisions) {
      const candidate = batch.find(item => item.candidate_id === decision.candidate_id)
      if (!candidate) continue
      if (decision.action === 'add' && decision.preference) {
        try {
          await addPreference(userId, {
            ...decision.preference,
            source_candidate_id: candidate.candidate_id,
            evidence_refs: candidate.evidence_refs,
          })
          await finalizeCandidate(userId, candidate.candidate_id, 'promoted', decision.reason)
        } catch (error) {
          if (error instanceof MemoryProfileLimitError) {
            await finalizeCandidate(userId, candidate.candidate_id, 'ignored', '长期画像已达到 30 条上限')
          } else if (error instanceof MemoryQuotaExceededError) {
            await finalizeCandidate(userId, candidate.candidate_id, 'quota_blocked', '本地项目记忆空间已满，未写入长期画像')
          } else throw error
        }
      } else if (decision.action === 'update' && decision.existing_preference_id && decision.preference) {
        try {
          const updated = await updatePreference(userId, decision.existing_preference_id, decision.preference)
          await finalizeCandidate(userId, candidate.candidate_id, updated ? 'promoted' : 'conflict', decision.reason)
        } catch (error) {
          if (!(error instanceof MemoryQuotaExceededError)) throw error
          await finalizeCandidate(userId, candidate.candidate_id, 'quota_blocked', '本地项目记忆空间已满，未更新长期画像')
        }
      } else {
        await finalizeCandidate(
          userId,
          candidate.candidate_id,
          decision.action === 'conflict' ? 'conflict' : 'ignored',
          decision.reason
        )
      }
    }
  } catch (error) {
    if (batchId) await resetClaimedBatch(userId, batchId)
    throw error
  }
}

async function processRun(run: MemoryRunDocument): Promise<void> {
  // The chat route queues only cleanly completed runs, but the worker repeats
  // the persisted authority check. Retries, legacy rows, or manual queue
  // changes must not extract durable memory from partial execution.
  if (!run.agent_run_id) {
    await setMemoryRunStatus(
      run.run_id,
      run.user_id,
      'discarded',
      '缺少关联的 AgentRun，未执行记忆摘要提取',
    )
    return
  }
  const agentRun = await getAgentRun(run.agent_run_id, run.user_id)
  if (
    !agentRun
    || agentRun.status !== 'completed'
    || agentRun.termination_reason !== 'model_finished'
  ) {
    await setMemoryRunStatus(
      run.run_id,
      run.user_id,
      'discarded',
      '关联的 AgentRun 未自然完成，未执行记忆摘要提取',
    )
    return
  }

  const extraction = await extractRunMemory(run.evidence)
  const notes: string[] = []
  if (extraction.history_event) {
    try {
      await createHistoryEvent(run.user_id, run.conversation_id, extraction.history_event, 'memory_v2', run.run_id)
    } catch (error) {
      if (!(error instanceof MemoryQuotaExceededError)) throw error
      notes.push('本地项目记忆空间已满，本轮历史摘要未写入')
    }
  }
  await createPreferenceCandidates(run.user_id, run.run_id, extraction.preference_candidates, run.evidence)
  await processConsolidation(run.user_id)
  await setMemoryRunStatus(run.run_id, run.user_id, 'completed', notes.join('；'))
}

async function tick(): Promise<void> {
  if (active || !memoryV2Flags.extraction()) return
  if (Date.now() < mongoRetryAfter) return
  active = true
  try {
    let run: MemoryRunDocument | null
    try {
      run = await leaseNextMemoryRun()
      noteMongoSuccess()
    } catch (error) {
      // Timer callbacks intentionally discard tick()'s Promise, so lease
      // failures must be contained here rather than becoming unhandled
      // rejections while MongoDB is waking after a host sleep.
      noteMongoFailure(error)
      return
    }
    if (!run) return
    try {
      await processRun(run)
    } catch (error) {
      console.error(`[memory-v2] run ${run.run_id} failed:`, error)
      try {
        await releaseRunAfterFailure(run, (error as Error).message)
      } catch (releaseError) {
        console.error(
          `[memory-v2] could not release failed run ${run.run_id}:`,
          (releaseError as Error).message,
        )
      }
    }
  } finally {
    active = false
  }
}

export function startMemoryV2Worker(): void {
  if (timer || !memoryV2Flags.extraction()) return
  console.log(`[memory-v2] worker started (${randomUUID().slice(0, 8)})`)
  timer = setInterval(() => void tick(), POLL_MS)
  timer.unref()
  void tick()
}

export function stopMemoryV2Worker(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
  console.log('[memory-v2] worker stopped')
}
