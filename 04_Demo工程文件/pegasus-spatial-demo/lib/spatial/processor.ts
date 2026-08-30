import {
  ProviderConfigurationBlockedError,
  ProviderDefinitelyNotAcceptedError,
  ProviderPermanentError,
  ProviderSubmissionUnknownError,
} from './adapters/errors'
import {
  mirrorRemoteSpatialArtifacts,
  publishReadySpatialArtifacts,
  isUnsafeSpatialArtifactHost,
  SpatialAssetValidationError,
  spatialMaxArtifactCountFromEnv,
  spatialMaxAssetBytesFromEnv,
  spatialMaxBatchBytesFromEnv,
  type SpatialHostnameResolver,
} from './artifact-mirror'
import { providerSpatialIdempotencyKey, spatialPublicationToken } from './identity'
import {
  cancelClaimedSpatialJob,
  deferSpatialJobPolling,
  failSpatialJob,
  markSpatialJobMaterializing,
  markSpatialJobSubmitting,
  markSpatialJobUnknown,
  publishSpatialJob,
  recordSpatialConfigurationBlocked,
  recordSpatialJobSubmitted,
  recordSpatialSubmissionRetry,
  releaseSpatialJobForRetry,
} from './repository'
import type {
  ClaimedSpatialBuildJob,
  ProviderArtifactDescriptor,
  SpatialAssetPublisher,
  SpatialProviderAdapter,
  StagedSpatialAsset,
} from './types'

export interface ProcessSpatialBuildDependencies {
  adapters: ReadonlyMap<string, SpatialProviderAdapter> | Readonly<Record<string, SpatialProviderAdapter>>
  publisher: SpatialAssetPublisher
  fetchImpl?: typeof fetch
  resolveArtifactHostname?: SpatialHostnameResolver
  maxAssetBytes?: number
  allowedArtifactHosts?: (provider: string) => readonly string[] | undefined
  artifactMirroringConfigured?: (provider: string) => boolean
  maxArtifactCount?: (provider: string) => number | undefined
  maxBatchBytes?: (provider: string) => number | undefined
  allowInsecureLocalhostAssets?: boolean
}

function manifestArtifacts(
  claim: ClaimedSpatialBuildJob,
  artifacts: readonly StagedSpatialAsset[],
): ProviderArtifactDescriptor[] {
  if (!['object', 'world'].includes(claim.job.kind)) return []
  const paths = artifacts.map(artifact => ({
    key: artifact.providerAssetKey,
    kind: artifact.kind,
    path: artifact.workspacePath,
    mime_type: artifact.mimeType,
    size_bytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    relations: artifact.relations,
    metadata: artifact.metadata,
  }))
  const preview = paths.find(asset => asset.kind === 'thumbnail' || asset.kind === 'image')?.path
  const upAxis = artifacts
    .map(artifact => artifact.metadata.up_axis)
    .find((value): value is string => typeof value === 'string')
  const options = claim.job.request_snapshot.provider_options ?? {}
  const name = typeof options.name === 'string' && options.name.trim()
    ? options.name.trim()
    : claim.job.kind === 'world' ? 'Pegasus Spatial World' : 'Pegasus Spatial Object'
  const timestamp = claim.job.created_at.toISOString()
  const manifest = {
    schema_version: 1,
    title: name,
    status: 'succeeded',
    provider: claim.job.provider,
    kind: claim.job.kind,
    job_id: claim.job.job_id,
    publication_token: spatialPublicationToken(claim.job.job_id),
    provider_task_id: claim.job.external_job_id,
    ...(claim.job.kind === 'world'
      ? {
          world_id: claim.job.external_job_id,
          viewer_url: `https://studio.aholo3d.cn/viewer?projectId=${encodeURIComponent(claim.job.external_job_id || '')}&subSiteFrom=embed`,
        }
      : { model: claim.job.model_snapshot }),
    ...(preview ? { preview_path: preview } : {}),
    assets: paths,
    ...(upAxis ? { up_axis: upAxis } : {}),
    ...(claim.job.request_snapshot.source_image_path
      ? { source_image_path: claim.job.request_snapshot.source_image_path }
      : {}),
    relations: claim.job.request_snapshot.relations ?? [],
    created_at: timestamp,
    updated_at: timestamp,
  }
  const relations = new Map<string, StagedSpatialAsset['relations'][number]>()
  for (const artifact of artifacts) {
    for (const relation of artifact.relations) {
      relations.set(`${relation.kind}\0${relation.artifact_id}`, relation)
    }
  }
  return [{
      assetKey: `${claim.job.kind}-manifest`,
      kind: 'manifest',
      fileName: 'manifest.json',
      inlineContent: JSON.stringify({ ...manifest, relations: [...relations.values()] }, null, 2),
      claimedMimeType: 'application/json',
      metadata: { schema_version: 1 },
    }]
}

export interface ProcessSpatialBuildOptions {
  signal?: AbortSignal
  providerPollDelayMs?: number
  maxExecutionAttempts?: number
  /** Product default retains one proven pre-acceptance retry; Operator smoke uses 1. */
  maxSubmissionAttempts?: number
}

function adapterFor(
  dependencies: ProcessSpatialBuildDependencies,
  provider: string,
): SpatialProviderAdapter | undefined {
  const adapters = dependencies.adapters
  return 'get' in adapters && typeof adapters.get === 'function'
    ? adapters.get(provider)
    : (adapters as Readonly<Record<string, SpatialProviderAdapter>>)[provider]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function submitSpatialBuild(
  initial: ClaimedSpatialBuildJob,
  adapter: SpatialProviderAdapter,
  options: ProcessSpatialBuildOptions,
): Promise<ClaimedSpatialBuildJob> {
  let claim = await markSpatialJobSubmitting(initial)
  const maxAttempts = Math.max(1, Math.min(2, options.maxSubmissionAttempts ?? 2))
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const submission = await adapter.submit(claim.job, {
        providerIdempotencyKey: providerSpatialIdempotencyKey(claim.job.job_id),
        signal: options.signal,
      })
      return recordSpatialJobSubmitted(claim, submission)
    } catch (error) {
      if (error instanceof ProviderDefinitelyNotAcceptedError) {
        if (attempt + 1 < maxAttempts) {
          claim = await recordSpatialSubmissionRetry(claim, error.message)
          continue
        }
        return failSpatialJob(claim, error.message)
      }
      const reason = error instanceof ProviderSubmissionUnknownError
        ? error.message
        : `Submission ended without durable provider acceptance evidence: ${errorMessage(error)}`
      return markSpatialJobUnknown(claim, reason)
    }
  }
  return claim
}

/** Parse only credential-free hostnames; never persist a signed URL. */
export function spatialArtifactHostnames(
  artifacts: readonly ProviderArtifactDescriptor[],
): string[] {
  const hosts = new Set<string>()
  for (const artifact of artifacts) {
    if (!artifact.remoteUrl) continue
    try {
      const parsed = new URL(artifact.remoteUrl)
      if (
        parsed.protocol === 'https:'
        && !parsed.username
        && !parsed.password
        && /^[a-z0-9.-]+$/i.test(parsed.hostname)
        && !isUnsafeSpatialArtifactHost(parsed.hostname)
      ) hosts.add(parsed.hostname.toLowerCase().replace(/\.$/, ''))
    } catch {
      // The normal mirror validation will reject malformed URLs once an
      // allowlist exists. Discovery itself must remain side-effect free.
    }
  }
  return [...hosts].sort()
}

/** Process one leased state transition. Long provider work remains external. */
export async function processClaimedSpatialBuildJob(
  initial: ClaimedSpatialBuildJob,
  dependencies: ProcessSpatialBuildDependencies,
  options: ProcessSpatialBuildOptions = {},
): Promise<ClaimedSpatialBuildJob> {
  const adapter = adapterFor(dependencies, initial.job.provider)
  if (!adapter || adapter.provider !== initial.job.provider || !adapter.supports(initial.job.kind)) {
    const submitting = initial.job.status === 'prepared'
      ? await markSpatialJobSubmitting(initial)
      : initial
    return failSpatialJob(
      submitting,
      `No compatible adapter is installed for ${initial.job.provider}/${initial.job.kind}.`,
    )
  }

  let claim = initial
  if (claim.job.status === 'prepared') {
    claim = await submitSpatialBuild(claim, adapter, options)
    if (['unknown', 'failed'].includes(claim.job.status)) return claim
  }

  if (!['submitted', 'running', 'materializing'].includes(claim.job.status)) return claim
  const publicationToken = spatialPublicationToken(claim.job.job_id)

  // A complete private mirror is authoritative recovery evidence. Resume it
  // before polling so an expired short-lived provider URL is never required.
  if (claim.job.status === 'materializing') {
    try {
      const recovered = await publishReadySpatialArtifacts({
        job: claim.job,
        publicationToken,
        publisher: dependencies.publisher,
      })
      if (recovered) {
        const result = await publishSpatialJob(claim, publicationToken, recovered.artifacts)
        await dependencies.publisher.discardBatch(recovered.stages).catch(() => undefined)
        return result
      }
    } catch (error) {
      const maxFailures = Math.max(1, options.maxExecutionAttempts ?? 12)
      if ((claim.job.consecutive_failures ?? 0) + 1 >= maxFailures) {
        await dependencies.publisher.discardJobStages({ job: claim.job, publicationToken }).catch(() => 0)
        return failSpatialJob(claim, `Artifact publication exhausted retries: ${errorMessage(error)}`)
      }
      await releaseSpatialJobForRetry(claim, errorMessage(error), options.providerPollDelayMs ?? 2_000)
      return claim
    }
  }

  let polled
  try {
    polled = await adapter.poll(claim.job, { signal: options.signal })
  } catch (error) {
    if (error instanceof ProviderPermanentError) return failSpatialJob(claim, error.message)
    if (error instanceof ProviderConfigurationBlockedError) {
      await releaseSpatialJobForRetry(claim, error.message, 5 * 60_000, false)
      return claim
    }
    const maxFailures = Math.max(1, options.maxExecutionAttempts ?? 12)
    if ((claim.job.consecutive_failures ?? 0) + 1 >= maxFailures) {
      return failSpatialJob(claim, `Provider polling exhausted retries: ${errorMessage(error)}`)
    }
    await releaseSpatialJobForRetry(claim, errorMessage(error), options.providerPollDelayMs ?? 2_000)
    return claim
  }

  if (polled.state !== 'succeeded') {
    if (polled.state === 'queued' || polled.state === 'running') {
      if (claim.job.status === 'materializing') {
        await releaseSpatialJobForRetry(
          claim,
          `Provider output was not materializable yet (${polled.providerStatus ?? polled.state}).`,
          options.providerPollDelayMs ?? 2_000,
        )
        return claim
      }
      return deferSpatialJobPolling(claim, {
        running: polled.state === 'running',
        providerStatus: polled.providerStatus,
        delayMs: options.providerPollDelayMs,
      })
    }
    if (polled.state === 'failed') {
      if (claim.job.status === 'materializing') {
        await dependencies.publisher.discardJobStages({ job: claim.job, publicationToken }).catch(() => 0)
      }
      return failSpatialJob(
        claim,
        polled.error || 'Provider reported spatial generation failure.',
        polled.providerStatus,
      )
    }
    if (claim.job.status === 'materializing') {
      await dependencies.publisher.discardJobStages({ job: claim.job, publicationToken }).catch(() => 0)
    }
    return cancelClaimedSpatialJob(
      claim,
      polled.error || 'Provider reported the spatial job as cancelled.',
    )
  }
  if (claim.job.status !== 'materializing') {
    claim = await markSpatialJobMaterializing(claim, polled.providerStatus)
  }

  if (dependencies.artifactMirroringConfigured?.(claim.job.provider) === false) {
    const hostnames = spatialArtifactHostnames(polled.artifacts)
    const observed = hostnames.length > 0
      ? ` Observed artifact hostnames: ${hostnames.join(', ')}.`
      : ''
    await recordSpatialConfigurationBlocked(
      claim,
      `${claim.job.provider} artifact host allowlist is not configured; paid output remains recoverable.${observed}`,
      hostnames,
      5 * 60_000,
    )
    return claim
  }
  try {
    const artifacts = await mirrorRemoteSpatialArtifacts({
      job: claim.job,
      publicationToken,
      artifacts: polled.artifacts,
      publisher: dependencies.publisher,
      fetchImpl: dependencies.fetchImpl,
      resolveHostname: dependencies.resolveArtifactHostname,
      maxAssetBytes: dependencies.maxAssetBytes ?? spatialMaxAssetBytesFromEnv(),
      maxBatchBytes: dependencies.maxBatchBytes?.(claim.job.provider) ?? spatialMaxBatchBytesFromEnv(),
      maxArtifactCount: dependencies.maxArtifactCount?.(claim.job.provider) ?? spatialMaxArtifactCountFromEnv(),
      allowedHosts: dependencies.allowedArtifactHosts?.(claim.job.provider),
      allowInsecureLocalhost: dependencies.allowInsecureLocalhostAssets,
      signal: options.signal,
      deriveArtifacts: staged => manifestArtifacts(claim, staged),
    })
    const result = await publishSpatialJob(claim, publicationToken, artifacts)
    const stages = await dependencies.publisher.recoverReadyBatch({ job: claim.job, publicationToken })
    if (stages) await dependencies.publisher.discardBatch(stages).catch(() => undefined)
    return result
  } catch (error) {
    if (error instanceof SpatialAssetValidationError || error instanceof ProviderPermanentError) {
      await dependencies.publisher.discardJobStages({ job: claim.job, publicationToken }).catch(() => 0)
      return failSpatialJob(claim, error.message)
    }
    const maxFailures = Math.max(1, options.maxExecutionAttempts ?? 12)
    if ((claim.job.consecutive_failures ?? 0) + 1 >= maxFailures) {
      await dependencies.publisher.discardJobStages({ job: claim.job, publicationToken }).catch(() => 0)
      return failSpatialJob(claim, `Artifact publication exhausted retries: ${errorMessage(error)}`)
    }
    await releaseSpatialJobForRetry(
      claim,
      errorMessage(error),
      options.providerPollDelayMs ?? 2_000,
    )
    return claim
  }
}
