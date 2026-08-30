/**
 * Node.js-only instrumentation logic. Kept in a separate file so that the
 * Edge runtime never statically imports it — the static analyzer would warn
 * about `process.on` / `process.exit` otherwise, even with a runtime guard.
 */

import mongoose from 'mongoose'
import { runStartupChecks } from './lib/startup-checks'
import { connectDB } from './lib/db/mongodb'
import { shouldLogDatabaseFailure } from './lib/db/retry-policy'
import { abortAllConversations } from './lib/agent/abort-registry'
import { shutdownAllBroadcasts } from './lib/agent/stream-registry'
import { startMemoryV2Worker, stopMemoryV2Worker } from './lib/memory-v2/worker'
import {
  finalizeOrphanedCancelledRuns,
  markAbandonedQueuedRunsRecoverable,
  markExpiredRunsRecoverable,
} from './lib/agent-runtime/repository'
import {
  releaseQueuedMessagesForRun,
  releaseStaleQueueClaims,
} from './lib/agent/message-queue'
import { QueuedMessage } from './lib/db/queue-model'
import { AgentRun, ConversationRuntime } from './lib/agent-runtime/models'
import {
  startAgentRunner,
  stopAgentRunner,
} from './lib/agent-runtime/runner'
import {
  AGENT_TEAM_MODELS,
  recoverExpiredAgentSessionRuns,
  recoverExpiredExecutionSlots,
} from './lib/agent-team'
import {
  WorkspaceCanonicalArtifact,
  WorkspaceCapacity,
  WorkspaceFile,
  WorkspaceFileRevision,
  reclaimUnreferencedWorkspaceGridFS,
} from './lib/workspace/multi-agent'
import { runAgentTeamMaintenanceSweep } from './lib/agent-team/orchestrator'
import { repairRunnableMemberWork } from './lib/agent-runtime/team-recovery'
import { DurableCompactionJobModel } from './lib/agent-compaction/models'
import {
  createProductionDurableCompactionProcessor,
  startDurableCompactionWorker,
  type DurableCompactionWorker,
} from './lib/agent-compaction'
import {
  ImageGenerationReceiptModel,
  reconcileImageGenerationPaidSlots,
} from './lib/image-generation'
import {
  recoverAmbiguousSpatialSubmissions,
  deliverPendingSpatialJobNotifications,
  readSpatialRuntimeConfig,
  sanitizeSpatialRuntimeError,
  SPATIAL_MODELS,
  startProductionSpatialBuildWorker,
  type SpatialBuildWorker,
} from './lib/spatial'

export function registerNode(): void {
  runStartupChecks()
  const backgroundRunnerConfigured =
    process.env.AGENT_RUNTIME_BACKGROUND_RUNNER === '1'
  let recoverySweepRunning = false
  let runtimeIndexesReady = false
  let runnerStartAttempted = false
  let durableCompactionWorker: DurableCompactionWorker | null = null
  let spatialBuildWorker: SpatialBuildWorker | null = null
  let spatialWorkerStartAttempted = false
  let recoveryFailureCount = 0
  let recoveryOutageStartedAt: number | null = null
  let recoveryLastLogAt: number | null = null
  const runRecoverySweep = async (): Promise<void> => {
    if (recoverySweepRunning) return
    recoverySweepRunning = true
    try {
      // This call is intentionally part of every sweep. connectDB() is cached
      // after success, but clears a rejected initial promise, so a process that
      // starts before MongoDB is ready can initialize itself on a later sweep.
      await connectDB()
      if (!runtimeIndexesReady) {
        // Index reconciliation is idempotent. Keep it inside the retryable
        // bootstrap path so a cold-start connection failure does not leave the
        // durable Runner permanently uninitialized until a process restart.
        await Promise.all([
          QueuedMessage.syncIndexes(),
          AgentRun.syncIndexes(),
          ConversationRuntime.syncIndexes(),
          DurableCompactionJobModel.syncIndexes(),
          ImageGenerationReceiptModel.syncIndexes(),
          ...SPATIAL_MODELS.map(model => model.syncIndexes()),
          ...AGENT_TEAM_MODELS.map(model => model.syncIndexes()),
          WorkspaceFile.syncIndexes(),
          WorkspaceFileRevision.syncIndexes(),
          WorkspaceCapacity.syncIndexes(),
          WorkspaceCanonicalArtifact.syncIndexes(),
        ])
        runtimeIndexesReady = true
      }
      // Cancellation wins over recovery. Finalize stale cancelled Runs before
      // the expired-lease sweep can classify them as recoverable.
      const cancelledRunIds = await finalizeOrphanedCancelledRuns()
      const [
        recoverableRuns,
        abandonedQueuedRuns,
        releasedQueueClaims,
        expiredExecutionSlots,
        expiredAgentSessions,
      ] = await Promise.all([
        markExpiredRunsRecoverable(),
        backgroundRunnerConfigured
          ? Promise.resolve(0)
          : markAbandonedQueuedRunsRecoverable(),
        releaseStaleQueueClaims(),
        recoverExpiredExecutionSlots(),
        recoverExpiredAgentSessionRuns(),
      ])
      await Promise.all(cancelledRunIds.map(runId => releaseQueuedMessagesForRun(runId)))
      if (cancelledRunIds.length > 0) {
        console.warn(`[agent-runtime] finalized ${cancelledRunIds.length} orphaned cancelled run(s)`)
      }
      if (recoverableRuns > 0) {
        console.warn(`[agent-runtime] marked ${recoverableRuns} expired run(s) recoverable`)
      }
      if (abandonedQueuedRuns > 0) {
        console.warn(`[agent-runtime] marked ${abandonedQueuedRuns} abandoned queued run(s) recoverable`)
      }
      if (releasedQueueClaims > 0) {
        console.warn(`[agent-runtime] released ${releasedQueueClaims} stale queue claim(s)`)
      }
      if (expiredExecutionSlots.length > 0 || expiredAgentSessions.length > 0) {
        console.warn(
          `[agent-team] recovered ${expiredExecutionSlots.length} execution slot(s) and `
          + `${expiredAgentSessions.length} Agent Session lease(s)`,
        )
      }
      const repairedMemberWork = await repairRunnableMemberWork()
      if (repairedMemberWork.root_runs_queued > 0) {
        console.warn(
          `[agent-team] requeued ${repairedMemberWork.root_runs_queued} recoverable Root Run(s)`,
        )
      }
      if (repairedMemberWork.recoverable_runs_queued > 0) {
        console.warn(
          `[agent-team] requeued ${repairedMemberWork.recoverable_runs_queued} recoverable member Run(s)`,
        )
      }
      const [spatialRecovery, imageSlotRecovery] = await Promise.all([
        recoverAmbiguousSpatialSubmissions(),
        reconcileImageGenerationPaidSlots(),
      ])
      const workspaceBlobRecovery = await reclaimUnreferencedWorkspaceGridFS()
      if (spatialRecovery.unknown > 0 || spatialRecovery.repairedSubmitted > 0) {
        console.warn(
          `[spatial] recovered ${spatialRecovery.repairedSubmitted} submitted job(s) and `
          + `sealed ${spatialRecovery.unknown} ambiguous submission(s) as unknown`,
        )
      }
      if (
        imageSlotRecovery.bound > 0
        || imageSlotRecovery.released > 0
        || imageSlotRecovery.markedUnknown > 0
      ) {
        console.warn(
          `[spatial] reconciled image paid slots: ${imageSlotRecovery.bound} bound, `
          + `${imageSlotRecovery.released} released, `
          + `${imageSlotRecovery.markedUnknown} ambiguous receipt(s) sealed as unknown`,
        )
      }
      if (workspaceBlobRecovery.blobsRemoved > 0 || workspaceBlobRecovery.revisionsRemoved > 0) {
        console.warn(
          `[workspace] reclaimed ${workspaceBlobRecovery.blobsRemoved} unreferenced GridFS blob(s) and `
          + `${workspaceBlobRecovery.revisionsRemoved} unreachable revision(s)`,
        )
      }
      await runAgentTeamMaintenanceSweep()
      const spatialNotifications = await deliverPendingSpatialJobNotifications()
      if (spatialNotifications.dispatched > 0 || spatialNotifications.failed > 0) {
        console.info(
          `[spatial] terminal notifications: ${spatialNotifications.dispatched} dispatched, `
          + `${spatialNotifications.failed} pending retry`,
        )
      }
      if (!durableCompactionWorker) {
        durableCompactionWorker = startDurableCompactionWorker(
          createProductionDurableCompactionProcessor(),
          {
            onError(error) {
              const message = error instanceof Error ? error.message : String(error)
              console.error('[agent-compaction] worker error:', message.slice(0, 2_000))
            },
          },
        )
        console.info(`[agent-compaction] durable worker started (${durableCompactionWorker.ownerId})`)
      }
      if (!spatialWorkerStartAttempted) {
        spatialWorkerStartAttempted = true
        const spatialConfig = readSpatialRuntimeConfig()
        for (const warning of spatialConfig.configurationWarnings) {
          console.warn(`[spatial] ${warning}`)
        }
        spatialBuildWorker = startProductionSpatialBuildWorker(process.env, {
          onError(error) {
            console.error(`[spatial] worker error: ${sanitizeSpatialRuntimeError(error)}`)
          },
        })
        if (spatialBuildWorker) {
          console.info(`[spatial] durable worker started (${spatialBuildWorker.ownerId})`)
        } else {
          console.info('[spatial] durable worker disabled by SPATIAL_WORKER_ENABLED=0')
        }
      }
      if (!runnerStartAttempted) {
        runnerStartAttempted = true
        startAgentRunner()
      }
      if (recoveryFailureCount > 0) {
        const unavailableMs = recoveryOutageStartedAt === null
          ? 0
          : Date.now() - recoveryOutageStartedAt
        console.info(
          `[agent-runtime] Mongo connection restored after `
          + `${Math.max(1, Math.round(unavailableMs / 1_000))}s; recovery sweep resumed`,
        )
        recoveryFailureCount = 0
        recoveryOutageStartedAt = null
        recoveryLastLogAt = null
      }
    } catch (error) {
      const now = Date.now()
      recoveryFailureCount += 1
      recoveryOutageStartedAt ??= now
      if (shouldLogDatabaseFailure(recoveryFailureCount, recoveryLastLogAt, now)) {
        const attempts = recoveryFailureCount > 1
          ? ` (${recoveryFailureCount} failed sweeps)`
          : ''
        console.error(
          `[agent-runtime] Mongo unavailable during recovery sweep${attempts}; `
          + `repeating failures are suppressed: ${(error as Error).message}`,
        )
        recoveryLastLogAt = now
      }
    } finally {
      recoverySweepRunning = false
    }
  }

  // Establish MongoDB eagerly, but keep the whole initialization path
  // retryable. A laptop wake-up, slow Docker startup, or brief local MongoDB
  // outage must not require restarting the Next.js process.
  void runRecoverySweep()
  startMemoryV2Worker()
  // Startup can happen before a dead process's 45-second lease expires. Keep
  // sweeping so the Run becomes recoverable as soon as that lease is actually
  // stale instead of remaining permanently "running".
  const runtimeRecoveryTimer = setInterval(() => {
    void runRecoverySweep()
  }, 15_000)
  runtimeRecoveryTimer.unref()

  let shuttingDown = false
  const FORCE_EXIT_MS = 10_000

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[shutdown] ${signal} received, starting graceful shutdown...`)

    // Bounds the cleanup — if any step hangs (DB disconnect stuck, SSE peer won't
    // accept close frame), force exit so the container orchestrator can restart us.
    const forceTimer = setTimeout(() => {
      console.warn(`[shutdown] force-exit after ${FORCE_EXIT_MS}ms`)
      process.exit(1)
    }, FORCE_EXIT_MS)
    forceTimer.unref()

    try {
      // Tell connected clients why they're being cut off — they'll show a clean
      // "server restarting" message instead of a network error.
      const closedChannels = shutdownAllBroadcasts({ type: 'shutdown', reason: signal })
      if (closedChannels > 0) console.log(`[shutdown] closed ${closedChannels} SSE channels`)

      // Abort in-flight agent loops so pending DB writes (incremental message
      // saves) have a chance to settle via their own abort handlers.
      const aborted = abortAllConversations('server_shutdown')
      if (aborted > 0) console.log(`[shutdown] aborted ${aborted} agent loops`)
      clearInterval(runtimeRecoveryTimer)
      stopMemoryV2Worker()
      if (durableCompactionWorker) {
        await durableCompactionWorker.stop()
        durableCompactionWorker = null
        console.log('[shutdown] durable compaction worker stopped')
      }
      if (spatialBuildWorker) {
        await spatialBuildWorker.stop()
        spatialBuildWorker = null
        console.log('[shutdown] durable spatial worker stopped')
      }
      await stopAgentRunner()

      // Let settle briefly so the abort handlers drain their last DB writes
      // before we tear down mongoose.
      await new Promise(resolve => setTimeout(resolve, 500))

      await mongoose.disconnect()
      console.log('[shutdown] mongoose disconnected')
    } catch (err) {
      console.error('[shutdown] cleanup error:', (err as Error).message)
    }

    console.log('[shutdown] complete')
    clearTimeout(forceTimer)
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}
