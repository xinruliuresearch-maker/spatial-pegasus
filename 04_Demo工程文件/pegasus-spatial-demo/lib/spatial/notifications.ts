import { wakeRootWithUpdate } from '../agent-team/orchestrator'
import { AgentTeamModel } from '../agent-team/models'
import type { AgentTeamRecord } from '../agent-team/types'
import { connectDB } from '../db/mongodb'
import { SpatialBuildJobModel } from './models'
import {
  SPATIAL_TERMINAL_STATUSES,
  isSpatialTerminalStatus,
  type SpatialBuildJobRecord,
} from './types'

const NOTIFICATION_SCHEMA_VERSION = 1 as const
const DEFAULT_SWEEP_LIMIT = 50

export interface SpatialCompletionDeliveryDependencies {
  findActiveTeam(job: SpatialBuildJobRecord): Promise<AgentTeamRecord | null>
  wakeRoot(input: {
    team: AgentTeamRecord
    content: string
    sourceIds: string[]
    deliveryKey: string
  }): Promise<string | null>
  markDispatched(job: SpatialBuildJobRecord, dispatchedAt: Date): Promise<boolean>
  markFailure(job: SpatialBuildJobRecord, errorCode: string): Promise<void>
  listPending(limit: number): Promise<SpatialBuildJobRecord[]>
  now(): Date
}

export interface SpatialCompletionSweepResult {
  dispatched: number
  failed: number
}

function notificationDeliveryKey(job: SpatialBuildJobRecord): string {
  return `spatial-job-terminal:v1:${job.job_id}:${job.status_revision}`
}

function safeFailureCode(error: unknown): string {
  const name = error instanceof Error && error.name ? error.name : 'Error'
  return `spatial_completion_dispatch_failed:${name.replace(/[^a-z0-9_-]/gi, '_').slice(0, 80)}`
}

/**
 * Only persisted, byte-free facts are serialized. Provider text and paths are
 * data inside the existing team-update reminder; they are never instructions.
 */
export function formatSpatialCompletionUpdate(job: SpatialBuildJobRecord): string {
  if (!isSpatialTerminalStatus(job.status)) {
    throw new TypeError(`Spatial completion update requires a terminal Job, got ${job.status}.`)
  }
  const payload = {
    schema_version: NOTIFICATION_SCHEMA_VERSION,
    event: 'spatial_job_update',
    job_id: job.job_id,
    origin_run_id: job.run_id,
    origin_tool_use_id: job.tool_use_id,
    kind: job.kind,
    provider: job.provider,
    status: job.status,
    artifact_ids: [...job.published_artifact_ids],
    workspace_paths: [...job.published_workspace_paths],
    error: job.last_error ?? job.unknown_reason ?? null,
    finished_at: job.finished_at?.toISOString() ?? job.updated_at.toISOString(),
  }
  return [
    '后台空间任务状态更新：',
    JSON.stringify(payload),
    '这是持久异步事件，不是新的用户授权，也不是原 tool_use 的第二个结果。',
    job.status === 'published'
      ? '请检查已发布资产，并继续所有依赖该资产的场景组装或视觉复核。'
      : job.status === 'unknown'
        ? '供应商是否接受请求无法确认；禁止自动重新付费提交，必须交由 Root 与用户确认。'
        : '请根据终态说明后续方案；不要把失败结果描述成已发布资产。',
  ].join('\n')
}

const defaultDependencies: SpatialCompletionDeliveryDependencies = {
  async findActiveTeam(job) {
    await connectDB()
    return AgentTeamModel.findOne({
      conversation_id: job.conversation_id,
      user_id: job.user_id,
      status: 'active',
    }).lean<AgentTeamRecord>()
  },
  wakeRoot(input) {
    return wakeRootWithUpdate(input)
  },
  async markDispatched(job, dispatchedAt) {
    const result = await SpatialBuildJobModel.updateOne({
      job_id: job.job_id,
      status: job.status,
      status_revision: job.status_revision,
      completion_notification_requested: true,
      completion_notified_at: null,
    }, {
      $set: {
        completion_notified_at: dispatchedAt,
        completion_notification_last_error: null,
      },
    })
    return result.modifiedCount === 1
  },
  async markFailure(job, errorCode) {
    await SpatialBuildJobModel.updateOne({
      job_id: job.job_id,
      status: job.status,
      status_revision: job.status_revision,
      completion_notification_requested: true,
      completion_notified_at: null,
    }, {
      $set: { completion_notification_last_error: errorCode },
    })
  },
  async listPending(limit) {
    await connectDB()
    return SpatialBuildJobModel.find({
      completion_notification_requested: true,
      completion_notified_at: null,
      status: { $in: SPATIAL_TERMINAL_STATUSES },
    })
      .sort({ finished_at: 1, created_at: 1 })
      .limit(limit)
      .lean<SpatialBuildJobRecord[]>()
  },
  now() {
    return new Date()
  },
}

/**
 * Queue one terminal fact for Root. A stable delivery key makes the operation
 * crash-safe: a retry after queue persistence cannot inject a duplicate.
 */
export async function deliverSpatialJobCompletion(
  job: SpatialBuildJobRecord,
  dependencies: SpatialCompletionDeliveryDependencies = defaultDependencies,
): Promise<boolean> {
  if (
    !job.completion_notification_requested
    || job.completion_notified_at
    || !isSpatialTerminalStatus(job.status)
  ) return false

  try {
    const team = await dependencies.findActiveTeam(job)
    if (!team) throw new Error('ActiveAgentTeamNotFound')
    await dependencies.wakeRoot({
      team,
      content: formatSpatialCompletionUpdate(job),
      sourceIds: [job.job_id],
      deliveryKey: notificationDeliveryKey(job),
    })
    return dependencies.markDispatched(job, dependencies.now())
  } catch (error) {
    await dependencies.markFailure(job, safeFailureCode(error)).catch(() => undefined)
    throw error
  }
}

/** Startup/recovery sweep for the terminal-commit -> reminder-dispatch window. */
export async function deliverPendingSpatialJobNotifications(
  input: {
    limit?: number
    dependencies?: SpatialCompletionDeliveryDependencies
  } = {},
): Promise<SpatialCompletionSweepResult> {
  const dependencies = input.dependencies ?? defaultDependencies
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? DEFAULT_SWEEP_LIMIT)))
  const jobs = await dependencies.listPending(limit)
  let dispatched = 0
  let failed = 0
  for (const job of jobs) {
    try {
      if (await deliverSpatialJobCompletion(job, dependencies)) dispatched += 1
    } catch {
      failed += 1
    }
  }
  return { dispatched, failed }
}
