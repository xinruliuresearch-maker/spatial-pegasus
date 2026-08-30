import { randomUUID } from 'crypto'
import {
  claimNextCompactionJob as claimNextCompactionJobFromRepository,
  clearExpiredContextCompactionFences as clearExpiredContextCompactionFencesFromRepository,
  flushDurableCompactionStatusOutbox as flushDurableCompactionStatusOutboxFromRepository,
  releaseCompactionForRetry as releaseCompactionForRetryFromRepository,
} from './repository'
import {
  processClaimedCompactionJob as processClaimedCompactionJobFromService,
  type ProcessCompactionOptions,
} from './service'
import type { ClaimedCompactionJob, DurableCompactionProcessor } from './types'

export interface DurableCompactionWorkerOptions extends ProcessCompactionOptions {
  ownerId?: string
  pollIntervalMs?: number
  concurrency?: number
  onError?: (error: unknown) => void
}

export interface DurableCompactionWorker {
  readonly ownerId: string
  wake(): void
  stop(): Promise<void>
}

export interface DurableCompactionWorkerTimer {
  unref?(): void
}

/** Dependency seam used by deterministic scheduler tests. */
export interface DurableCompactionWorkerDependencies {
  claimNextCompactionJob(
    ownerId: string,
    leaseMs: number,
  ): Promise<ClaimedCompactionJob | null>
  clearExpiredContextCompactionFences(): Promise<number>
  flushDurableCompactionStatusOutbox(options: {
    onError: (error: unknown) => void
  }): Promise<number>
  releaseCompactionForRetry(
    claim: ClaimedCompactionJob,
    error: string,
    delayMs: number,
  ): Promise<boolean>
  processClaimedCompactionJob: typeof processClaimedCompactionJobFromService
  setTimeout(
    callback: () => void,
    delayMs: number,
  ): DurableCompactionWorkerTimer
  clearTimeout(timer: DurableCompactionWorkerTimer): void
}

const defaultDependencies: DurableCompactionWorkerDependencies = {
  claimNextCompactionJob: claimNextCompactionJobFromRepository,
  clearExpiredContextCompactionFences: clearExpiredContextCompactionFencesFromRepository,
  flushDurableCompactionStatusOutbox: flushDurableCompactionStatusOutboxFromRepository,
  releaseCompactionForRetry: releaseCompactionForRetryFromRepository,
  processClaimedCompactionJob: processClaimedCompactionJobFromService,
  setTimeout(callback, delayMs) {
    return setTimeout(callback, delayMs)
  },
  clearTimeout(timer) {
    clearTimeout(timer as ReturnType<typeof setTimeout>)
  },
}

/**
 * Finite-concurrency maintenance worker. It is safe to run on every process:
 * Mongo leases elect one executor and expired leases are taken over.
 */
export function startDurableCompactionWorker(
  processor: DurableCompactionProcessor,
  options: DurableCompactionWorkerOptions = {},
  dependencies: DurableCompactionWorkerDependencies = defaultDependencies,
): DurableCompactionWorker {
  const ownerId = options.ownerId ?? `cmpworker_${process.pid}_${randomUUID()}`
  const pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 2_000)
  const leaseMs = Math.max(
    5_000,
    (options.heartbeatMs ?? 20_000) * 3,
    options.leaseMs ?? 90_000,
  )
  const concurrency = Math.max(1, Math.min(8, options.concurrency ?? 2))
  let stopped = false
  let pumping = false
  let immediateRunRequested = false
  let timer: DurableCompactionWorkerTimer | null = null
  let timerDelayMs: number | null = null
  const running = new Set<Promise<void>>()
  const inFlightPumps = new Set<Promise<void>>()
  const shutdownController = new AbortController()

  const report = (error: unknown) => {
    if (options.onError) options.onError(error)
    else console.error('[agent-compaction] worker error:', error)
  }

  const schedule = (delayMs: number) => {
    if (stopped) return
    const normalizedDelayMs = Math.max(0, delayMs)
    if (pumping) {
      if (normalizedDelayMs === 0) immediateRunRequested = true
      return
    }
    if (timer) {
      // An explicit wake or a released capacity slot must preempt the normal
      // polling timer. Equal/later requests are already covered by it.
      if (normalizedDelayMs > 0 || timerDelayMs === 0) return
      dependencies.clearTimeout(timer)
      timer = null
      timerDelayMs = null
    }
    timerDelayMs = normalizedDelayMs
    timer = dependencies.setTimeout(() => {
      timer = null
      timerDelayMs = null
      const task = pump()
      inFlightPumps.add(task)
      void task.finally(() => { inFlightPumps.delete(task) })
    }, normalizedDelayMs)
    timer.unref?.()
  }

  const executeClaim = async (claim: ClaimedCompactionJob): Promise<void> => {
    try {
      await dependencies.processClaimedCompactionJob(claim, processor, {
        ...options,
        leaseMs,
        signal: shutdownController.signal,
      })
    } finally {
      // Job completion never depends on TeamEvent availability. This merely
      // drains the transactional status intent after the durable CAS.
      await dependencies.flushDurableCompactionStatusOutbox({ onError: report })
    }
  }

  const startClaim = (claim: ClaimedCompactionJob) => {
    const task = executeClaim(claim)
      .catch(report)
      .finally(() => {
        running.delete(task)
        // A real claim consumed queue work. Refill the released slot without
        // waiting for the maintenance poll interval.
        if (!stopped) schedule(0)
      })
    running.add(task)
  }

  const pump = async (): Promise<void> => {
    if (stopped) return
    if (pumping) {
      immediateRunRequested = true
      return
    }
    pumping = true
    try {
      await dependencies.flushDurableCompactionStatusOutbox({ onError: report })
      await dependencies.clearExpiredContextCompactionFences()
      while (!stopped && running.size < concurrency) {
        // Claim serially so an empty queue is an explicit scheduling result,
        // rather than an immediately-resolving task that can hot-loop.
        const claim = await dependencies.claimNextCompactionJob(ownerId, leaseMs)
        if (!claim) break
        if (stopped) {
          // stop() may race an in-flight repository claim. The returned lease
          // must be settled before shutdown completes, but no new processor
          // work may start after the worker has entered the stopped state.
          const released = await dependencies.releaseCompactionForRetry(
            claim,
            'Durable compaction worker stopped immediately after claiming the Job.',
            0,
          )
          if (!released) {
            report(new Error(
              `Durable compaction worker lost the shutdown release lease for ${claim.job.job_id}.`,
            ))
          }
          break
        }
        startClaim(claim)
      }
    } catch (error) {
      report(error)
    } finally {
      pumping = false
      if (stopped) return
      if (immediateRunRequested) {
        immediateRunRequested = false
        schedule(0)
      } else {
        schedule(pollIntervalMs)
      }
    }
  }

  schedule(0)
  return {
    ownerId,
    wake() { schedule(0) },
    async stop() {
      stopped = true
      shutdownController.abort(new Error('Durable compaction worker is shutting down.'))
      if (timer) dependencies.clearTimeout(timer)
      timer = null
      timerDelayMs = null
      immediateRunRequested = false
      // A pump can still be awaiting claimNextCompactionJob when shutdown
      // starts. Wait to a fixed point because that pump may have started a
      // processor task immediately before observing `stopped`.
      while (inFlightPumps.size > 0 || running.size > 0) {
        await Promise.allSettled([...inFlightPumps, ...running])
      }
    },
  }
}
