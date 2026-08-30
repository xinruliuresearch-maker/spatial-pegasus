import { randomUUID } from 'node:crypto'
import { connectDB } from '../db/mongodb'
import {
  canonicalSpatialJson,
  deterministicSpatialJobId,
  normalizeSpatialWorkspacePrefix,
  spatialIdempotencyKey,
  spatialRequestHash,
} from './identity'
import { SpatialArtifactNodeModel, SpatialBuildJobModel } from './models'
import {
  acquireSpatialPaidSlot,
  bindSpatialPaidSlot,
  reconcileSpatialBuildPaidSlots,
  releaseSpatialPaidSlot,
  SpatialPaidCapacityError,
} from './paid-slots'
import { assertSpatialStatusTransition } from './state-machine'
import type {
  ClaimedSpatialBuildJob,
  MaterializedSpatialArtifact,
  PrepareSpatialBuildInput,
  RegisterPublishedSpatialArtifactInput,
  SpatialArtifactNodeRecord,
  SpatialBuildJobRecord,
  SpatialBuildStatus,
  SpatialCommandScope,
} from './types'
import { isSpatialTerminalStatus } from './types'

const DEFAULT_LEASE_MS = 90_000

function duplicateKey(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 11000
}

function cloneRecord<T>(value: T): T {
  return structuredClone(value)
}

function requireText(label: string, value: string): string {
  const normalized = value.trim()
  if (!normalized) throw new TypeError(`${label} must not be empty.`)
  return normalized
}

function safeError(error: string): string {
  const redacted = error
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[redacted]')
    .replace(/\b(api[_-]?key|token|secret)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[redacted]')
    .replace(/https?:\/\/[^\s)]+/gi, raw => {
      try {
        const url = new URL(raw)
        url.username = ''
        url.password = ''
        url.search = ''
        url.hash = ''
        return url.toString()
      } catch {
        return '[redacted-url]'
      }
    })
  return redacted.trim().slice(0, 4_000) || 'Unknown spatial job error.'
}

function unleasedOrExpired(now: Date): Record<string, unknown> {
  return {
    $or: [
      { lease: null },
      { lease: { $exists: false } },
      { 'lease.expires_at': { $lte: now } },
    ],
  }
}

function availableNow(now: Date): Record<string, unknown> {
  return {
    $or: [
      { available_at: null },
      { available_at: { $exists: false } },
      { available_at: { $lte: now } },
    ],
  }
}

function claimFilter(
  claim: ClaimedSpatialBuildJob,
  statuses?: readonly SpatialBuildStatus[],
): Record<string, unknown> {
  return {
    job_id: claim.job.job_id,
    'lease.owner_id': claim.ownerId,
    'lease.token': claim.leaseToken,
    'lease.expires_at': { $gt: new Date() },
    ...(statuses ? { status: { $in: statuses } } : {}),
  }
}

function claimedWithJob(
  claim: ClaimedSpatialBuildJob,
  job: SpatialBuildJobRecord,
): ClaimedSpatialBuildJob {
  return { ...claim, job }
}

function assertSameFrozenRequest(
  existing: SpatialBuildJobRecord,
  input: PrepareSpatialBuildInput,
  requestHash: string,
): void {
  const modelSnapshot = input.modelSnapshot?.trim() || null
  const executionGate = input.executionGate ?? 'worker'
  if (
    existing.user_id !== input.userId.trim()
    || existing.conversation_id !== input.conversationId.trim()
    || existing.kind !== input.kind
    || existing.provider !== input.provider.trim()
    || existing.model_snapshot !== modelSnapshot
    || (existing.execution_gate ?? 'worker') !== executionGate
    || existing.request_hash !== requestHash
  ) {
    throw new SpatialIdempotencyConflictError(existing.job_id)
  }
}

export class SpatialIdempotencyConflictError extends Error {
  readonly code = 'SPATIAL_IDEMPOTENCY_CONFLICT'

  constructor(public readonly jobId: string) {
    super(`Spatial tool use ${jobId} was replayed with different frozen inputs.`)
    this.name = 'SpatialIdempotencyConflictError'
  }
}

export class SpatialJobCommandRejectedError extends Error {
  readonly code = 'SPATIAL_JOB_COMMAND_REJECTED'

  constructor() {
    super('Spatial job command rejected: identity did not match.')
    this.name = 'SpatialJobCommandRejectedError'
  }
}

export class SpatialJobLeaseLostError extends Error {
  readonly code = 'SPATIAL_JOB_LEASE_LOST'

  constructor(public readonly jobId: string) {
    super(`SpatialBuildJob ${jobId} is no longer owned by this worker.`)
    this.name = 'SpatialJobLeaseLostError'
  }
}

export class SpatialProjectCapacityError extends Error {
  readonly code = 'SPATIAL_PROJECT_CAPACITY_EXCEEDED'

  constructor(public readonly projectId: string) {
    super(`Spatial project ${projectId} already has two active paid jobs.`)
    this.name = 'SpatialProjectCapacityError'
  }
}

export class SpatialOutputPathConflictError extends Error {
  readonly code = 'SPATIAL_OUTPUT_PATH_CONFLICT'

  constructor(public readonly projectId: string, public readonly outputPathPrefix: string) {
    super(`Spatial output prefix is already owned by another build: ${outputPathPrefix}`)
    this.name = 'SpatialOutputPathConflictError'
  }
}

export async function prepareSpatialBuild(
  input: PrepareSpatialBuildInput,
): Promise<SpatialBuildJobRecord> {
  await connectDB()
  const projectId = requireText('projectId', input.projectId)
  const runId = requireText('runId', input.runId)
  const toolUseId = requireText('toolUseId', input.toolUseId)
  const userId = requireText('userId', input.userId)
  const conversationId = requireText('conversationId', input.conversationId)
  const provider = requireText('provider', input.provider)
  const request = cloneRecord(input.request)
  request.output_path_prefix = normalizeSpatialWorkspacePrefix(request.output_path_prefix)
  const requestHash = spatialRequestHash(request)
  const identity = { projectId, runId, toolUseId }
  const jobId = deterministicSpatialJobId(identity)
  const idempotencyKey = spatialIdempotencyKey(identity)

  const existing = await SpatialBuildJobModel.findOne({
    project_id: projectId,
    run_id: runId,
    tool_use_id: toolUseId,
  }).lean<SpatialBuildJobRecord>()
  if (existing) {
    assertSameFrozenRequest(existing, { ...input, projectId, runId, toolUseId }, requestHash)
    const shouldNotify = input.notifyOnTerminal
      ?? ((input.executionGate ?? existing.execution_gate ?? 'worker') === 'worker')
    if (
      shouldNotify
      && !existing.completion_notification_requested
      && !isSpatialTerminalStatus(existing.status)
    ) {
      const enabled = await SpatialBuildJobModel.findOneAndUpdate({
        job_id: existing.job_id,
        status_revision: existing.status_revision,
        completion_notification_requested: { $ne: true },
      }, {
        $set: {
          completion_notification_requested: true,
          completion_notification_last_error: null,
        },
      }, { returnDocument: 'after' }).lean<SpatialBuildJobRecord>()
      if (enabled) Object.assign(existing, enabled)
    }
    return existing
  }

  const createJob = async () => SpatialBuildJobModel.create({
      job_id: jobId,
      idempotency_key: idempotencyKey,
      project_id: projectId,
      run_id: runId,
      tool_use_id: toolUseId,
      user_id: userId,
      conversation_id: conversationId,
      kind: input.kind,
      provider,
      model_snapshot: input.modelSnapshot?.trim() || null,
      request_hash: requestHash,
      request_snapshot: request,
      output_path_prefix: request.output_path_prefix,
      status: 'prepared',
      execution_gate: input.executionGate ?? 'worker',
      status_revision: 0,
      execution_attempts: 0,
      consecutive_failures: 0,
      submission_attempts: 0,
      poll_attempts: 0,
      lease: null,
      external_job_id: null,
      provider_status: null,
      published_artifact_ids: [],
      published_workspace_paths: [],
      publication_token: null,
      available_at: new Date(),
      last_error: null,
      unknown_reason: null,
      configuration_blocked_hosts: [],
      // Deliberately do not backfill old Jobs: enabling the feature must not
      // wake Root once for every historical terminal build.
      completion_notification_requested:
        input.notifyOnTerminal ?? ((input.executionGate ?? 'worker') === 'worker'),
      completion_notified_at: null,
      completion_notification_last_error: null,
      finished_at: null,
    })
  let created
  try {
    created = await createJob()
  } catch (error) {
    if (duplicateKey(error)) {
      const winner = await SpatialBuildJobModel.findOne({
        project_id: projectId,
        run_id: runId,
        tool_use_id: toolUseId,
      }).lean<SpatialBuildJobRecord>()
      if (winner) {
        assertSameFrozenRequest(winner, { ...input, projectId, runId, toolUseId }, requestHash)
        return winner
      }
      const prefixOwner = await SpatialBuildJobModel.findOne({
        project_id: projectId,
        output_path_prefix: request.output_path_prefix,
      }).select('job_id').lean<{ job_id: string }>()
      if (prefixOwner) {
        throw new SpatialOutputPathConflictError(projectId, request.output_path_prefix)
      }
    }
    throw error
  }
  return created.toObject() as SpatialBuildJobRecord
}

/** Reserve shared paid capacity only when a quarantined Operator intent is authorized. */
export async function activateOperatorSpatialBuildPaidSlot(
  jobIdValue: string,
): Promise<SpatialBuildJobRecord> {
  await connectDB()
  const jobId = requireText('jobId', jobIdValue)
  const current = await SpatialBuildJobModel.findOne({ job_id: jobId }).lean<SpatialBuildJobRecord>()
  if (!current) throw new SpatialJobCommandRejectedError()
  if (current.status !== 'prepared' || current.execution_gate !== 'operator') return current
  if (current.active_slot !== undefined) return current
  let paidSlot
  try {
    paidSlot = await acquireSpatialPaidSlot({
      projectId: current.project_id,
      userId: current.user_id,
      holderType: 'spatial_build',
      holderKey: current.job_id,
    })
  } catch (error) {
    if (error instanceof SpatialPaidCapacityError) {
      throw new SpatialProjectCapacityError(current.project_id)
    }
    throw error
  }
  const activated = await SpatialBuildJobModel.findOneAndUpdate(
    {
      job_id: current.job_id,
      status: 'prepared',
      execution_gate: 'operator',
      active_slot: { $exists: false },
    },
    { $set: { active_slot: paidSlot.slot } },
    { returnDocument: 'after' },
  ).lean<SpatialBuildJobRecord>()
  if (!activated) {
    const winner = await SpatialBuildJobModel.findOne({ job_id: current.job_id }).lean<SpatialBuildJobRecord>()
    if (winner?.active_slot === paidSlot.slot) {
      await bindSpatialPaidSlot(paidSlot)
      return winner
    }
    await releaseSpatialPaidSlot({
      projectId: current.project_id,
      userId: current.user_id,
      holderType: 'spatial_build',
      holderKey: current.job_id,
      reservationToken: paidSlot.reservationToken,
    }).catch(() => false)
    if (!winner) throw new SpatialJobCommandRejectedError()
    return winner
  }
  await bindSpatialPaidSlot(paidSlot)
  return activated
}

export async function getSpatialBuildJob(
  jobId: string,
  scope: SpatialCommandScope,
): Promise<SpatialBuildJobRecord | null> {
  await connectDB()
  return SpatialBuildJobModel.findOne({
    job_id: jobId.trim(),
    project_id: scope.projectId.trim(),
    user_id: scope.userId.trim(),
  }).lean<SpatialBuildJobRecord>()
}

export async function countActiveSpatialJobs(scope: SpatialCommandScope): Promise<number> {
  await connectDB()
  return SpatialBuildJobModel.countDocuments({
    project_id: scope.projectId.trim(),
    user_id: scope.userId.trim(),
    $or: [
      { status: { $in: ['submitting', 'submitted', 'running', 'materializing'] } },
      { status: 'prepared', active_slot: { $in: [0, 1] } },
    ],
  })
}

export async function claimNextSpatialBuildJob(
  ownerIdValue: string,
  leaseMsValue: number = DEFAULT_LEASE_MS,
): Promise<ClaimedSpatialBuildJob | null> {
  await connectDB()
  const ownerId = requireText('ownerId', ownerIdValue)
  const leaseMs = Math.max(5_000, Number.isFinite(leaseMsValue) ? leaseMsValue : DEFAULT_LEASE_MS)
  const now = new Date()
  const leaseToken = `splease_${randomUUID()}`
  const job = await SpatialBuildJobModel.findOneAndUpdate(
    {
      status: { $in: ['prepared', 'submitted', 'running', 'materializing'] },
      $or: [
        { execution_gate: 'worker' },
        { execution_gate: { $exists: false } },
      ],
      $and: [unleasedOrExpired(now), availableNow(now)],
    },
    {
      $set: {
        lease: {
          owner_id: ownerId,
          token: leaseToken,
          acquired_at: now,
          heartbeat_at: now,
          expires_at: new Date(now.getTime() + leaseMs),
        },
        available_at: null,
      },
      $inc: { execution_attempts: 1 },
    },
    { returnDocument: 'after', sort: { available_at: 1, created_at: 1 } },
  ).lean<SpatialBuildJobRecord>()
  return job ? { job, ownerId, leaseToken } : null
}

export async function heartbeatSpatialBuildJob(
  claim: ClaimedSpatialBuildJob,
  leaseMsValue: number = DEFAULT_LEASE_MS,
): Promise<boolean> {
  await connectDB()
  const now = new Date()
  const leaseMs = Math.max(5_000, Number.isFinite(leaseMsValue) ? leaseMsValue : DEFAULT_LEASE_MS)
  const result = await SpatialBuildJobModel.updateOne(
    claimFilter(claim),
    {
      $set: {
        'lease.heartbeat_at': now,
        'lease.expires_at': new Date(now.getTime() + leaseMs),
      },
    },
  )
  return result.matchedCount === 1
}

/** Release a lease returned after the worker had already begun shutdown. */
export async function releaseUnstartedSpatialClaim(
  claim: ClaimedSpatialBuildJob,
): Promise<boolean> {
  await connectDB()
  const result = await SpatialBuildJobModel.updateOne(
    claimFilter(claim, ['prepared', 'submitted', 'running', 'materializing']),
    { $set: { lease: null, available_at: new Date() } },
  )
  return result.matchedCount === 1
}

/**
 * Claim a quarantined Operator build without exposing all operator-prepared
 * jobs to the normal worker. `allowKnownExternalJob` is used by --resume and
 * can only claim states that already have a durable external id; it can never
 * cross the provider submit boundary.
 */
export async function claimSpatialBuildJobForOperator(input: {
  jobId: string
  ownerId: string
  leaseMs?: number
  allowKnownExternalJob?: boolean
}): Promise<ClaimedSpatialBuildJob | null> {
  await connectDB()
  const ownerId = requireText('ownerId', input.ownerId)
  const jobId = requireText('jobId', input.jobId)
  const leaseMs = Math.max(5_000, Number.isFinite(input.leaseMs)
    ? Number(input.leaseMs)
    : DEFAULT_LEASE_MS)
  const now = new Date()
  const leaseToken = `splease_${randomUUID()}`
  const stateFilter = input.allowKnownExternalJob
    ? {
        status: { $in: ['submitted', 'running', 'materializing'] },
        external_job_id: { $type: 'string' },
      }
    : {
        status: 'prepared',
        execution_gate: 'operator',
        active_slot: { $type: 'number' },
        $or: [
          { external_job_id: null },
          { external_job_id: { $exists: false } },
        ],
      }
  const filter: Record<string, unknown> = {
      job_id: jobId,
      ...stateFilter,
      $and: [
        unleasedOrExpired(now),
        ...(input.allowKnownExternalJob ? [] : [availableNow(now)]),
      ],
    }
  const job = await SpatialBuildJobModel.findOneAndUpdate(
    filter,
    {
      $set: {
        lease: {
          owner_id: ownerId,
          token: leaseToken,
          acquired_at: now,
          heartbeat_at: now,
          expires_at: new Date(now.getTime() + leaseMs),
        },
        available_at: null,
      },
      $inc: { execution_attempts: 1 },
    },
    { returnDocument: 'after' },
  ).lean<SpatialBuildJobRecord>()
  return job ? { job, ownerId, leaseToken } : null
}

async function transitionClaimedJob(input: {
  claim: ClaimedSpatialBuildJob
  from: readonly SpatialBuildStatus[]
  to: SpatialBuildStatus
  set?: Record<string, unknown>
  inc?: Record<string, number>
  unset?: readonly string[]
  releaseLease?: boolean
}): Promise<ClaimedSpatialBuildJob> {
  input.from.forEach(from => assertSpatialStatusTransition(from, input.to))
  const update: Record<string, unknown> = {
    $set: {
      ...(input.set ?? {}),
      status: input.to,
      ...(input.releaseLease ? { lease: null } : {}),
    },
    $inc: { status_revision: 1, ...(input.inc ?? {}) },
  }
  if (input.unset?.length) {
    update.$unset = Object.fromEntries(input.unset.map(field => [field, 1]))
  }
  const job = await SpatialBuildJobModel.findOneAndUpdate(
    claimFilter(input.claim, input.from),
    update,
    { returnDocument: 'after' },
  ).lean<SpatialBuildJobRecord>()
  if (!job) throw new SpatialJobLeaseLostError(input.claim.job.job_id)
  if (isSpatialTerminalStatus(input.to)) {
    await releaseSpatialPaidSlot({
      projectId: job.project_id,
      userId: job.user_id,
      holderType: 'spatial_build',
      holderKey: job.job_id,
    }).catch(error => {
      console.error('[spatial] failed to release terminal paid slot:', safeError(String(error)))
      return false
    })
  }
  return claimedWithJob(input.claim, job)
}

export async function markSpatialJobSubmitting(
  claim: ClaimedSpatialBuildJob,
): Promise<ClaimedSpatialBuildJob> {
  return transitionClaimedJob({
    claim,
    from: ['prepared'],
    to: 'submitting',
    set: { last_error: null, unknown_reason: null },
    inc: { submission_attempts: 1 },
  })
}

export async function recordSpatialSubmissionRetry(
  claim: ClaimedSpatialBuildJob,
  error: string,
): Promise<ClaimedSpatialBuildJob> {
  await connectDB()
  const job = await SpatialBuildJobModel.findOneAndUpdate(
    claimFilter(claim, ['submitting']),
    {
      $set: { last_error: safeError(error) },
      $inc: { submission_attempts: 1 },
    },
    { returnDocument: 'after' },
  ).lean<SpatialBuildJobRecord>()
  if (!job) throw new SpatialJobLeaseLostError(claim.job.job_id)
  return claimedWithJob(claim, job)
}

export async function recordSpatialJobSubmitted(
  claim: ClaimedSpatialBuildJob,
  submission: { externalJobId: string; providerStatus?: string },
): Promise<ClaimedSpatialBuildJob> {
  const externalJobId = requireText('externalJobId', submission.externalJobId)
  return transitionClaimedJob({
    claim,
    from: ['submitting'],
    to: 'submitted',
    set: {
      external_job_id: externalJobId,
      provider_status: submission.providerStatus?.trim() || 'submitted',
      execution_gate: 'worker',
      last_error: null,
    },
  })
}

export async function deferSpatialJobPolling(
  claim: ClaimedSpatialBuildJob,
  input: { running: boolean; providerStatus?: string; delayMs?: number },
): Promise<ClaimedSpatialBuildJob> {
  const from = claim.job.status === 'submitted' ? ['submitted'] as const : ['running'] as const
  return transitionClaimedJob({
    claim,
    from,
    to: 'running',
    set: {
      provider_status: input.providerStatus?.trim() || (input.running ? 'running' : 'queued'),
      available_at: new Date(Date.now() + Math.max(250, input.delayMs ?? 2_000)),
      last_error: null,
      consecutive_failures: 0,
    },
    inc: { poll_attempts: 1 },
    releaseLease: true,
  })
}

export async function markSpatialJobMaterializing(
  claim: ClaimedSpatialBuildJob,
  providerStatus?: string,
): Promise<ClaimedSpatialBuildJob> {
  const from = claim.job.status === 'submitted' ? ['submitted'] as const : ['running'] as const
  return transitionClaimedJob({
    claim,
    from,
    to: 'materializing',
    set: {
      provider_status: providerStatus?.trim() || 'succeeded',
      last_error: null,
      consecutive_failures: 0,
    },
    inc: { poll_attempts: 1 },
  })
}

export async function releaseSpatialJobForRetry(
  claim: ClaimedSpatialBuildJob,
  error: string,
  delayMs = 2_000,
  countFailure = true,
): Promise<boolean> {
  await connectDB()
  const result = await SpatialBuildJobModel.updateOne(
    claimFilter(claim, ['submitted', 'running', 'materializing']),
    {
      $set: {
        lease: null,
        available_at: new Date(Date.now() + Math.max(250, delayMs)),
        last_error: safeError(error),
        ...(!countFailure ? { provider_status: 'configuration_blocked' } : {}),
      },
      ...(countFailure ? { $inc: { consecutive_failures: 1 } } : {}),
    },
  )
  return result.matchedCount === 1
}

export async function recordSpatialConfigurationBlocked(
  claim: ClaimedSpatialBuildJob,
  error: string,
  hostnames: readonly string[],
  delayMs = 5 * 60_000,
): Promise<boolean> {
  await connectDB()
  const normalizedHosts = [...new Set(hostnames.map(host => host.trim().toLowerCase()).filter(Boolean))]
    .filter(host => /^[a-z0-9.-]+$/.test(host))
    .sort()
  const result = await SpatialBuildJobModel.updateOne(
    claimFilter(claim, ['submitted', 'running', 'materializing']),
    {
      $set: {
        lease: null,
        available_at: new Date(Date.now() + Math.max(250, delayMs)),
        last_error: safeError(error),
        provider_status: 'configuration_blocked',
        configuration_blocked_hosts: normalizedHosts,
      },
    },
  )
  return result.matchedCount === 1
}

export async function markSpatialJobUnknown(
  claim: ClaimedSpatialBuildJob,
  reason: string,
): Promise<ClaimedSpatialBuildJob> {
  return transitionClaimedJob({
    claim,
    from: ['submitting'],
    to: 'unknown',
    set: {
      unknown_reason: safeError(reason),
      last_error: safeError(reason),
      finished_at: new Date(),
      available_at: null,
    },
    releaseLease: true,
    unset: ['active_slot'],
  })
}

export async function failSpatialJob(
  claim: ClaimedSpatialBuildJob,
  error: string,
  providerStatus?: string,
): Promise<ClaimedSpatialBuildJob> {
  const from = [claim.job.status]
  if (!['submitting', 'submitted', 'running', 'materializing'].includes(claim.job.status)) {
    throw new SpatialJobLeaseLostError(claim.job.job_id)
  }
  return transitionClaimedJob({
    claim,
    from,
    to: 'failed',
    set: {
      last_error: safeError(error),
      ...(providerStatus?.trim() ? { provider_status: providerStatus.trim() } : {}),
      finished_at: new Date(),
      available_at: null,
    },
    releaseLease: true,
    unset: ['active_slot'],
  })
}

export async function cancelClaimedSpatialJob(
  claim: ClaimedSpatialBuildJob,
  reason = 'Provider reported the spatial job as cancelled.',
): Promise<ClaimedSpatialBuildJob> {
  if (!['submitted', 'running', 'materializing'].includes(claim.job.status)) {
    throw new SpatialJobLeaseLostError(claim.job.job_id)
  }
  return transitionClaimedJob({
    claim,
    from: [claim.job.status],
    to: 'cancelled',
    set: {
      last_error: safeError(reason),
      finished_at: new Date(),
      available_at: null,
    },
    releaseLease: true,
    unset: ['active_slot'],
  })
}

export async function publishSpatialJob(
  claim: ClaimedSpatialBuildJob,
  publicationToken: string,
  artifacts: readonly MaterializedSpatialArtifact[],
): Promise<ClaimedSpatialBuildJob> {
  await connectDB()
  if (claim.job.status !== 'materializing') {
    throw new SpatialJobLeaseLostError(claim.job.job_id)
  }
  if (!artifacts.length) throw new TypeError('A published spatial job must contain at least one artifact.')
  const token = requireText('publicationToken', publicationToken)
  const now = new Date()
  const records: SpatialArtifactNodeRecord[] = artifacts.map(artifact => ({
    artifact_id: artifact.artifactId,
    job_id: claim.job.job_id,
    project_id: claim.job.project_id,
    user_id: claim.job.user_id,
    provider: claim.job.provider,
    kind: artifact.kind,
    state: 'published',
    publication_token: token,
    provider_asset_key: artifact.providerAssetKey,
    filename: artifact.filename,
    workspace_path: artifact.workspacePath,
    storage_uri: artifact.storageUri,
    mime_type: artifact.mimeType,
    size_bytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    relations: artifact.relations,
    metadata: artifact.metadata,
    created_at: now,
    updated_at: now,
  }))
  await SpatialArtifactNodeModel.bulkWrite(records.map(record => ({
    replaceOne: {
      filter: { artifact_id: record.artifact_id },
      replacement: record,
      upsert: true,
    },
  })))
  try {
    return await transitionClaimedJob({
      claim,
      from: ['materializing'],
      to: 'published',
      set: {
        publication_token: token,
        published_artifact_ids: records.map(record => record.artifact_id),
        published_workspace_paths: records.map(record => record.workspace_path),
        last_error: null,
        available_at: null,
        finished_at: now,
      },
      releaseLease: true,
      unset: ['active_slot'],
    })
  } catch (error) {
    await SpatialArtifactNodeModel.updateMany(
      { publication_token: token, job_id: claim.job.job_id },
      { $set: { state: 'orphaned' } },
    )
    throw error
  }
}

/**
 * A process that dies after entering `submitting` leaves no safe evidence that
 * the paid provider rejected the request. Such work is terminally `unknown`
 * and must never be picked up for an automatic second submission.
 */
export async function recoverAmbiguousSpatialSubmissions(now = new Date()): Promise<{
  unknown: number
  repairedSubmitted: number
}> {
  await connectDB()
  const ambiguousLease = unleasedOrExpired(now)
  const repaired = await SpatialBuildJobModel.updateMany(
    {
      status: 'submitting',
      external_job_id: { $type: 'string' },
      ...ambiguousLease,
    },
    {
      $set: {
        status: 'submitted',
        lease: null,
        available_at: now,
        provider_status: 'submitted_recovered',
      },
      $inc: { status_revision: 1 },
    },
  )
  const reason = 'Submission lease expired before an external job id was durably recorded; provider acceptance is unknown and automatic resubmission is forbidden.'
  const unknown = await SpatialBuildJobModel.updateMany(
    {
      status: 'submitting',
      $and: [
        ambiguousLease,
        {
          $or: [
            { external_job_id: null },
            { external_job_id: { $exists: false } },
          ],
        },
      ],
    },
    {
      $set: {
        status: 'unknown',
        lease: null,
        available_at: null,
        unknown_reason: reason,
        last_error: reason,
        finished_at: now,
      },
      $inc: { status_revision: 1 },
      $unset: { active_slot: 1 },
    },
  )
  await reconcileSpatialBuildPaidSlots(now)
  return { unknown: unknown.modifiedCount, repairedSubmitted: repaired.modifiedCount }
}

export async function inspectPublishedSpatialArtifact(
  artifactId: string,
  scope: SpatialCommandScope,
): Promise<SpatialArtifactNodeRecord | null> {
  await connectDB()
  return SpatialArtifactNodeModel.findOne({
    artifact_id: artifactId.trim(),
    project_id: scope.projectId.trim(),
    user_id: scope.userId.trim(),
    state: 'published',
  }).lean<SpatialArtifactNodeRecord>()
}

/**
 * Register an already-published, credential-free asset (for example a
 * GenerateImage media asset) in the unified inspect/lineage index.
 */
export async function registerPublishedSpatialArtifact(
  input: RegisterPublishedSpatialArtifactInput,
): Promise<SpatialArtifactNodeRecord> {
  await connectDB()
  const artifactId = requireText('artifactId', input.artifactId)
  const jobId = requireText('jobId', input.jobId)
  const projectId = requireText('projectId', input.projectId)
  const userId = requireText('userId', input.userId)
  const workspacePath = normalizeSpatialWorkspacePrefix(input.workspacePath)
  const sizeBytes = input.sizeBytes
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new TypeError('sizeBytes must be non-negative.')
  const sha256 = input.sha256.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new TypeError('sha256 must be a 64-character hex digest.')
  const storageUri = requireText('storageUri', input.storageUri)
  if (/^https?:/i.test(storageUri)) throw new TypeError('storageUri must not contain a provider URL.')
  const now = new Date()
  const record: SpatialArtifactNodeRecord = {
    artifact_id: artifactId,
    job_id: jobId,
    project_id: projectId,
    user_id: userId,
    provider: requireText('provider', input.provider),
    kind: input.kind,
    state: 'published',
    publication_token: requireText('publicationToken', input.publicationToken),
    provider_asset_key: requireText('providerAssetKey', input.providerAssetKey),
    filename: requireText('filename', input.filename),
    workspace_path: workspacePath,
    storage_uri: storageUri,
    mime_type: requireText('mimeType', input.mimeType),
    size_bytes: sizeBytes,
    sha256,
    relations: cloneRecord(input.relations ?? []),
    metadata: cloneRecord(input.metadata ?? {}),
    created_at: now,
    updated_at: now,
  }
  const fingerprint = (value: SpatialArtifactNodeRecord) => canonicalSpatialJson({
    artifact_id: value.artifact_id,
    job_id: value.job_id,
    project_id: value.project_id,
    user_id: value.user_id,
    provider: value.provider,
    kind: value.kind,
    state: value.state,
    publication_token: value.publication_token,
    provider_asset_key: value.provider_asset_key,
    filename: value.filename,
    workspace_path: value.workspace_path,
    storage_uri: value.storage_uri,
    mime_type: value.mime_type,
    size_bytes: value.size_bytes,
    sha256: value.sha256,
    relations: value.relations,
    metadata: value.metadata,
  })
  const existing = await SpatialArtifactNodeModel.findOne({ artifact_id: artifactId }).lean<SpatialArtifactNodeRecord>()
  if (existing) {
    if (fingerprint(existing) !== fingerprint(record)) throw new SpatialIdempotencyConflictError(artifactId)
    return existing
  }
  try {
    const created = await SpatialArtifactNodeModel.create(record)
    return created.toObject() as SpatialArtifactNodeRecord
  } catch (error) {
    if (!duplicateKey(error)) throw error
    const winner = await SpatialArtifactNodeModel.findOne({ artifact_id: artifactId }).lean<SpatialArtifactNodeRecord>()
    if (!winner) throw error
    if (fingerprint(winner) !== fingerprint(record)) throw new SpatialIdempotencyConflictError(artifactId)
    return winner
  }
}

export async function requireSpatialBuildJob(
  jobId: string,
  scope: SpatialCommandScope,
): Promise<SpatialBuildJobRecord> {
  const job = await getSpatialBuildJob(jobId, scope)
  if (!job) throw new SpatialJobCommandRejectedError()
  return job
}
