import { randomUUID } from 'node:crypto'
import {
  claimNextSpatialBuildJob as claimNextSpatialBuildJobFromRepository,
  heartbeatSpatialBuildJob,
  recoverAmbiguousSpatialSubmissions as recoverAmbiguousSpatialSubmissionsFromRepository,
  releaseUnstartedSpatialClaim as releaseUnstartedSpatialClaimFromRepository,
} from './repository'
import {
  processClaimedSpatialBuildJob,
  type ProcessSpatialBuildDependencies,
  type ProcessSpatialBuildOptions,
} from './processor'
import type { ClaimedSpatialBuildJob } from './types'
import { isSpatialTerminalStatus, type SpatialBuildJobRecord } from './types'

export interface SpatialBuildWorkerOptions extends ProcessSpatialBuildOptions {
  ownerId?: string
  pollIntervalMs?: number
  leaseMs?: number
  concurrency?: number
  heartbeatMs?: number
  onError?: (error: unknown) => void
  /** Best-effort fast path; the recovery sweep remains authoritative. */
  onTerminalJob?: (job: SpatialBuildJobRecord) => Promise<void> | void
}

export interface SpatialBuildWorker {
  readonly ownerId: string
  wake(): void
  stop(): Promise<void>
}

export interface SpatialWorkerTimer {
  unref?(): void
}

/** Deterministic scheduler seam used by worker fault tests. */
export interface SpatialBuildWorkerRuntime {
  claimNextSpatialBuildJob(ownerId: string, leaseMs: number): Promise<ClaimedSpatialBuildJob | null>
  recoverAmbiguousSpatialSubmissions(): Promise<unknown>
  releaseUnstartedSpatialClaim(claim: ClaimedSpatialBuildJob): Promise<boolean>
  processClaim(
    claim: ClaimedSpatialBuildJob,
    dependencies: ProcessSpatialBuildDependencies,
    options: SpatialBuildWorkerOptions,
    signal: AbortSignal,
  ): Promise<ClaimedSpatialBuildJob | void>
  setTimeout(callback: () => void, delayMs: number): SpatialWorkerTimer
  clearTimeout(timer: SpatialWorkerTimer): void
}

function finiteInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.floor(value!) : fallback
}

async function processWithHeartbeat(
  claim: ClaimedSpatialBuildJob,
  dependencies: ProcessSpatialBuildDependencies,
  options: SpatialBuildWorkerOptions,
  signal: AbortSignal,
): Promise<ClaimedSpatialBuildJob> {
  const heartbeatMs = Math.max(1_000, finiteInteger(options.heartbeatMs, 20_000))
  const leaseMs = Math.max(5_000, finiteInteger(options.leaseMs, 90_000), heartbeatMs * 3)
  const timer = setInterval(() => {
    void heartbeatSpatialBuildJob(claim, leaseMs).catch(error => options.onError?.(error))
  }, heartbeatMs)
  timer.unref()
  try {
    return await processClaimedSpatialBuildJob(claim, dependencies, { ...options, signal })
  } finally {
    clearInterval(timer)
  }
}

const defaultRuntime: SpatialBuildWorkerRuntime = {
  claimNextSpatialBuildJob: claimNextSpatialBuildJobFromRepository,
  recoverAmbiguousSpatialSubmissions: recoverAmbiguousSpatialSubmissionsFromRepository,
  releaseUnstartedSpatialClaim: releaseUnstartedSpatialClaimFromRepository,
  processClaim: processWithHeartbeat,
  setTimeout(callback, delayMs) {
    return setTimeout(callback, delayMs)
  },
  clearTimeout(timer) {
    clearTimeout(timer as ReturnType<typeof setTimeout>)
  },
}

/** Mongo leases make this worker safe to start in every application process. */
export function startSpatialBuildWorker(
  dependencies: ProcessSpatialBuildDependencies,
  options: SpatialBuildWorkerOptions = {},
  runtime: SpatialBuildWorkerRuntime = defaultRuntime,
): SpatialBuildWorker {
  const ownerId = options.ownerId ?? `spworker_${process.pid}_${randomUUID()}`
  const pollIntervalMs = Math.max(250, finiteInteger(options.pollIntervalMs, 2_000))
  const heartbeatMs = Math.max(1_000, finiteInteger(options.heartbeatMs, 20_000))
  const leaseMs = Math.max(5_000, finiteInteger(options.leaseMs, 90_000), heartbeatMs * 3)
  // Keep the local process healthy without imposing a project backlog limit.
  // Every accepted build is durable; this value only controls how many lease
  // transitions and provider HTTP operations this worker performs at once.
  const concurrency = Math.max(1, Math.min(32, finiteInteger(options.concurrency, 8)))
  const controller = new AbortController()
  const running = new Set<Promise<void>>()
  let stopped = false
  let pumping = false
  let immediateRunRequested = false
  let timer: SpatialWorkerTimer | null = null
  let timerDelayMs: number | null = null
  let activePump: Promise<void> | null = null
  let lastCleanupAt = 0

  const report = (error: unknown) => {
    if (options.onError) options.onError(error)
    else console.error('[spatial] worker error:', error)
  }

  const schedule = (delayMs: number) => {
    if (stopped) return
    const delay = Math.max(0, delayMs)
    if (pumping) {
      if (delay === 0) immediateRunRequested = true
      return
    }
    if (timer) {
      if (delay > 0 || timerDelayMs === 0) return
      runtime.clearTimeout(timer)
      timer = null
      timerDelayMs = null
    }
    timerDelayMs = delay
    timer = runtime.setTimeout(() => {
      timer = null
      timerDelayMs = null
      void requestPump()
    }, delay)
    timer.unref?.()
  }

  const launch = (claim: ClaimedSpatialBuildJob) => {
    const task = runtime.processClaim(claim, dependencies, options, controller.signal)
      .then(async settled => {
        if (settled && isSpatialTerminalStatus(settled.job.status)) {
          await options.onTerminalJob?.(settled.job)
        }
      })
      .catch(report)
      .finally(() => {
        running.delete(task)
        schedule(0)
      })
    running.add(task)
  }

  const runPump = async () => {
    if (stopped || pumping) return
    pumping = true
    try {
      const now = Date.now()
      if (now - lastCleanupAt >= 60 * 60_000) {
        await dependencies.publisher.cleanupExpired(new Date(now))
        lastCleanupAt = now
      }
      await runtime.recoverAmbiguousSpatialSubmissions()
      while (!stopped && running.size < concurrency) {
        const claim = await runtime.claimNextSpatialBuildJob(ownerId, leaseMs)
        if (!claim) break
        if (stopped) {
          await runtime.releaseUnstartedSpatialClaim(claim)
          break
        }
        launch(claim)
      }
    } catch (error) {
      report(error)
    } finally {
      pumping = false
      if (!stopped) {
        const nextDelay = immediateRunRequested ? 0 : pollIntervalMs
        immediateRunRequested = false
        schedule(nextDelay)
      }
    }
  }

  const requestPump = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (activePump) {
      immediateRunRequested = true
      return activePump
    }
    const task = runPump()
    activePump = task
    void task.finally(() => {
      if (activePump === task) activePump = null
    })
    return task
  }

  schedule(0)
  return {
    ownerId,
    wake() { schedule(0) },
    async stop() {
      if (stopped) return
      stopped = true
      controller.abort(new Error('Spatial build worker is stopping.'))
      if (timer) runtime.clearTimeout(timer)
      timer = null
      timerDelayMs = null
      const pumpAtStop = activePump
      if (pumpAtStop) await pumpAtStop
      await Promise.allSettled([...running])
    },
  }
}
