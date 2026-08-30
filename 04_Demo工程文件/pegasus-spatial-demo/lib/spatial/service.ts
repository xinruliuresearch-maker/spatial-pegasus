import {
  getSpatialBuildJob,
  inspectPublishedSpatialArtifact,
  requireSpatialBuildJob,
  SpatialJobCommandRejectedError,
} from './repository'
import type { SpatialArtifactNodeRecord, SpatialBuildJobRecord, SpatialCommandScope } from './types'
import { isSpatialTerminalStatus } from './types'
import {
  SPATIAL_TOOL_RESULT_SCHEMA_VERSION,
  type SpatialToolResultEnvelope,
} from './tool-result'

function jobEnvelope(job: SpatialBuildJobRecord, message?: string): SpatialToolResultEnvelope {
  const elapsedEnd = job.finished_at ?? new Date()
  const options = job.request_snapshot.provider_options
  const sourceIds = options && typeof options === 'object' && !Array.isArray(options)
    ? [
        ...(typeof options.source_asset_id === 'string' ? [options.source_asset_id] : []),
        ...(Array.isArray(options.source_asset_ids)
          ? options.source_asset_ids.filter((value): value is string => typeof value === 'string')
          : []),
      ]
    : []
  const relations = new Map<string, NonNullable<SpatialToolResultEnvelope['relations']>[number]>()
  for (const relation of [
    ...(job.request_snapshot.relations ?? []),
    ...sourceIds.map(artifact_id => ({ kind: 'conditioned_by' as const, artifact_id })),
  ]) {
    const artifactId = relation.artifact_id.trim()
    if (artifactId) relations.set(`${relation.kind}\0${artifactId}`, { ...relation, artifact_id: artifactId })
  }
  return {
    schema_version: SPATIAL_TOOL_RESULT_SCHEMA_VERSION,
    job_id: job.job_id,
    kind: job.kind,
    status: job.status,
    provider: job.provider,
    ...(job.published_workspace_paths.length
      ? { workspace_paths: [...job.published_workspace_paths] }
      : {}),
    ...(message
      ? { message }
      : job.status === 'prepared' && job.completion_notification_requested
        ? {
            message: '空间任务已加入持久生成队列；后台会负责提交与发布。请继续其他可执行工作，完成后系统会自动通知 Root Agent。',
          }
        : {}),
    created_at: job.created_at.toISOString(),
    elapsed_ms: Math.max(0, elapsedEnd.getTime() - job.created_at.getTime()),
    ...(relations.size ? { relations: [...relations.values()] } : {}),
    updated_at: job.updated_at.toISOString(),
    ...(job.last_error ? { error: job.last_error } : {}),
  }
}

function artifactEnvelope(
  artifact: SpatialArtifactNodeRecord,
): SpatialToolResultEnvelope {
  const observable = Object.fromEntries(
    Object.entries(artifact.metadata ?? {})
      .filter(([key, value]) => (
        ['up_axis', 'output_index', 'schema_version'].includes(key)
        && (value === null || ['string', 'number', 'boolean'].includes(typeof value))
      )),
  ) as Record<string, string | number | boolean | null>
  return {
    schema_version: SPATIAL_TOOL_RESULT_SCHEMA_VERSION,
    job_id: artifact.job_id,
    artifact_id: artifact.artifact_id,
    kind: 'artifact',
    status: 'published',
    provider: artifact.provider,
    workspace_paths: [artifact.workspace_path],
    message: `${artifact.kind} · ${artifact.mime_type} · ${artifact.size_bytes} bytes · sha256:${artifact.sha256}`,
    created_at: artifact.created_at.toISOString(),
    elapsed_ms: Math.max(0, artifact.updated_at.getTime() - artifact.created_at.getTime()),
    relations: structuredClone(artifact.relations ?? []),
    metadata: {
      filename: artifact.filename,
      mime_type: artifact.mime_type,
      size_bytes: artifact.size_bytes,
      sha256: artifact.sha256,
      provider_asset_key: artifact.provider_asset_key,
      ...observable,
    },
    updated_at: artifact.updated_at.toISOString(),
  }
}

export async function getSpatialJobResult(input: {
  jobId: string
  scope: SpatialCommandScope
}): Promise<SpatialToolResultEnvelope> {
  const job = await requireSpatialBuildJob(input.jobId, input.scope)
  return jobEnvelope(job)
}

export async function waitSpatialJobResult(input: {
  jobId: string
  scope: SpatialCommandScope
  timeoutMs?: number
  pollIntervalMs?: number
  signal?: AbortSignal
}): Promise<SpatialToolResultEnvelope> {
  const timeoutMs = Math.max(0, Math.min(120_000, input.timeoutMs ?? 30_000))
  const pollIntervalMs = Math.max(100, Math.min(5_000, input.pollIntervalMs ?? 500))
  const deadline = Date.now() + timeoutMs
  while (true) {
    if (input.signal?.aborted) throw input.signal.reason ?? new Error('Spatial job wait aborted.')
    const job = await getSpatialBuildJob(input.jobId, input.scope)
    if (!job) {
      // Do not distinguish a missing job from another user's job.
      await requireSpatialBuildJob(input.jobId, input.scope)
    }
    if (job && isSpatialTerminalStatus(job.status)) return jobEnvelope(job)
    if (Date.now() >= deadline) return jobEnvelope(job!, '等待超时；空间任务仍在后台继续。')
    await new Promise<void>((resolve, reject) => {
      const remaining = Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()))
      const cleanup = () => input.signal?.removeEventListener('abort', onAbort)
      const timer = setTimeout(() => {
        cleanup()
        resolve()
      }, remaining)
      const onAbort = () => {
        clearTimeout(timer)
        cleanup()
        reject(input.signal?.reason ?? new Error('Spatial job wait aborted.'))
      }
      input.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}

export async function inspectSpatialArtifactResult(input: {
  artifactId: string
  scope: SpatialCommandScope
}): Promise<SpatialToolResultEnvelope> {
  const artifact = await inspectPublishedSpatialArtifact(input.artifactId, input.scope)
  if (!artifact) {
    throw new SpatialJobCommandRejectedError()
  }
  return artifactEnvelope(artifact)
}
