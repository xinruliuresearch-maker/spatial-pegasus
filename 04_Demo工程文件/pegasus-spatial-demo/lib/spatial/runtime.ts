import { createHash } from 'node:crypto'
import { agentTeamService } from '../agent-team'
import { getConversation } from '../db/repository'
import { createWorkspaceInstance } from '../workspace/instance'
import { spatialCreationWorkspace } from '../workspace/definitions/spatial-creation'
import {
  createMultiAgentWorkspaceBridge,
  MultiAgentWorkspaceRepository,
  type WorkspaceActor,
  type WorkspaceWriterProvenance,
} from '../workspace/multi-agent'
import type { FileEntry, ManifestEntry, WorkspaceInstance } from '../workspace/types'
import { AholoAdapter } from './adapters/aholo'
import { Lux3DAdapter } from './adapters/lux3d'
import { SpatialBuildJobModel } from './models'
import type { ProcessSpatialBuildDependencies } from './processor'
import type { SpatialBuildJobRecord, SpatialProviderAdapter } from './types'
import {
  startSpatialBuildWorker,
  type SpatialBuildWorker,
  type SpatialBuildWorkerOptions,
} from './worker'
import { createWorkspaceSpatialPublisher } from './workspace-publisher'
import { resolveSpatialArtifactHostnameWithGoogleDoh } from './artifact-mirror'
import { deliverSpatialJobCompletion } from './notifications'

const OFFICIAL_API_BASE_URL = 'https://api.aholo3d.cn'
const DENY_ALL_ARTIFACT_HOST = 'spatial-artifacts-not-configured.invalid'

export interface SpatialProviderRuntimeConfig {
  apiBaseUrl: string
  apiKey?: string
  assetHosts: readonly string[]
  submissionEnabled: boolean
}

export interface SpatialRuntimeConfig {
  workerEnabled: boolean
  concurrency: number
  pollIntervalMs: number
  leaseMs: number
  aholo: SpatialProviderRuntimeConfig
  lux3d: SpatialProviderRuntimeConfig
  configurationWarnings: readonly string[]
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(raw)
  return Number.isSafeInteger(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback
}

/** Exact hostnames only: paths, schemes, ports and wildcards are rejected. */
export function parseSpatialAssetHostAllowlist(raw: string | undefined): {
  hosts: string[]
  invalid: string[]
} {
  const hosts = new Set<string>()
  const invalid: string[] = []
  for (const item of raw?.split(',') ?? []) {
    const candidate = item.trim().toLowerCase().replace(/\.$/, '')
    if (!candidate) continue
    if (
      candidate.includes('/')
      || candidate.includes(':')
      || candidate.includes('*')
      || !/^[a-z0-9.-]+$/.test(candidate)
      || candidate.startsWith('.')
      || candidate.endsWith('.')
      || candidate.includes('..')
    ) {
      invalid.push(item.trim())
      continue
    }
    try {
      const parsed = new URL(`https://${candidate}`)
      if (parsed.hostname !== candidate) {
        invalid.push(item.trim())
        continue
      }
    } catch {
      invalid.push(item.trim())
      continue
    }
    hosts.add(candidate)
  }
  return { hosts: [...hosts].sort(), invalid }
}

function providerConfig(input: {
  provider: 'Aholo' | 'Lux3D'
  apiBaseUrl: string | undefined
  apiKey: string | undefined
  allowlist: string | undefined
  warnings: string[]
}): SpatialProviderRuntimeConfig {
  const parsed = parseSpatialAssetHostAllowlist(input.allowlist)
  if (parsed.invalid.length > 0) {
    input.warnings.push(
      `${input.provider} 产物域名白名单包含无效条目；该供应商的付费提交已关闭。`,
    )
  }
  if (parsed.hosts.length === 0) {
    input.warnings.push(
      `${input.provider} 缺少产物域名白名单；为避免任意远程下载，该供应商的付费提交已关闭。`,
    )
  }
  if (!input.apiKey?.trim()) {
    input.warnings.push(`${input.provider} 缺少 API Key；该供应商的付费提交已关闭。`)
  }
  return {
    apiBaseUrl: input.apiBaseUrl?.trim() || OFFICIAL_API_BASE_URL,
    apiKey: input.apiKey?.trim() || undefined,
    assetHosts: parsed.hosts,
    submissionEnabled: parsed.invalid.length === 0
      && parsed.hosts.length > 0
      && Boolean(input.apiKey?.trim()),
  }
}

export function readSpatialRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): SpatialRuntimeConfig {
  // Provider submission is controlled by concrete credentials, artifact-host
  // allowlists and durable receipts. There is no separate global paid-call
  // switch in the Agent path: it caused valid jobs to fail before provider I/O.
  const warnings: string[] = []
  const aholo = providerConfig({
    provider: 'Aholo',
    apiBaseUrl: env.AHOLO_API_BASE_URL,
    apiKey: env.AHOLO_API_KEY || env.AHOLO_API_TOKEN,
    allowlist: env.AHOLO_ASSET_HOST_ALLOWLIST,
    warnings,
  })
  const lux3d = providerConfig({
    provider: 'Lux3D',
    apiBaseUrl: env.LUX3D_API_BASE_URL,
    apiKey: env.LUX3D_API_KEY || env.LUX3D_API_TOKEN,
    allowlist: env.LUX3D_ASSET_HOST_ALLOWLIST,
    warnings,
  })
  return {
    workerEnabled: env.SPATIAL_WORKER_ENABLED?.trim() !== '0',
    // This bounds local network/lease work only. It is not a product-level
    // limit on how many durable image or 3D jobs a project may create.
    concurrency: boundedInteger(env.SPATIAL_WORKER_CONCURRENCY, 8, 1, 32),
    pollIntervalMs: boundedInteger(env.SPATIAL_WORKER_POLL_MS, 2_000, 250, 60_000),
    leaseMs: boundedInteger(env.SPATIAL_WORKER_LEASE_MS, 90_000, 5_000, 15 * 60_000),
    aholo,
    lux3d,
    configurationWarnings: warnings,
  }
}

/**
 * Logs and persisted worker errors must never echo API keys or URI userinfo.
 * Provider response bodies are already excluded by the HTTP adapters; this is
 * the final bootstrap-layer guard for unexpected driver errors.
 */
export function sanitizeSpatialRuntimeError(
  error: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let message = error instanceof Error ? error.message : String(error)
  message = message.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
  for (const key of [
    env.AHOLO_API_KEY,
    env.AHOLO_API_TOKEN,
    env.LUX3D_API_KEY,
    env.LUX3D_API_TOKEN,
    env.LLM_API_KEY_TOOLS,
  ]) {
    const secret = key?.trim()
    if (secret && secret.length >= 4) message = message.split(secret).join('[redacted]')
  }
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 2_000)
}

export function spatialWorkspaceWriterIdentity(
  job: Pick<SpatialBuildJobRecord, 'job_id' | 'request_hash' | 'tool_use_id'>,
  teamId: string,
  rootAgentId: string,
): WorkspaceWriterProvenance {
  const digest = createHash('sha256')
    .update(`pegasus-spatial-publication-v1\0${job.job_id}\0${job.request_hash}`)
    .digest('hex')
  return {
    team_id: teamId,
    agent_id: rootAgentId,
    task_id: job.tool_use_id,
    run_id: `spatial_job_${job.job_id}`,
    // This identity is deliberately stable across short worker leases. The
    // live lease is checked independently at every repository fence boundary.
    execution_fence_token: `spatial_publication_${digest}`,
  }
}

/**
 * Resolve the authoritative root Workspace for a claimed spatial job.
 * Unlike an Agent tool workspace, its execution fence is the durable spatial
 * lease, not the AgentRun that originally submitted the external task.
 */
export async function resolveSpatialJobWorkspace(
  job: SpatialBuildJobRecord,
): Promise<WorkspaceInstance> {
  if (job.project_id !== job.conversation_id) {
    throw new Error('Spatial job project does not match its conversation Workspace.')
  }
  const capturedLease = job.lease
  if (!capturedLease?.token || !capturedLease.owner_id) {
    throw new Error('Spatial publication requires an active durable job lease.')
  }
  const conversation = await getConversation(job.conversation_id, job.user_id)
  if (!conversation) throw new Error('Spatial job conversation no longer exists.')
  const team = await agentTeamService.ensureTeam({
    conversationId: job.conversation_id,
    userId: job.user_id,
    workspaceId: job.project_id,
  })
  const actor: WorkspaceActor = {
    teamId: team.team_id,
    agentId: team.root_agent_id,
    rootAgentId: team.root_agent_id,
    role: 'root',
  }
  const writer = spatialWorkspaceWriterIdentity(
    job,
    team.team_id,
    team.root_agent_id,
  )
  const workspaceRepository = new MultiAgentWorkspaceRepository({
    fenceValidator: async ({ workspaceId, writer: candidate }) => {
      if (
        workspaceId !== team.workspace_id
        || candidate.team_id !== writer.team_id
        || candidate.agent_id !== writer.agent_id
        || candidate.run_id !== writer.run_id
        || candidate.execution_fence_token !== writer.execution_fence_token
      ) return false
      const current = await SpatialBuildJobModel.exists({
        job_id: job.job_id,
        project_id: job.project_id,
        user_id: job.user_id,
        status: 'materializing',
        'lease.owner_id': capturedLease.owner_id,
        'lease.token': capturedLease.token,
        'lease.expires_at': { $gt: new Date() },
      })
      return Boolean(current)
    },
  })
  const value = conversation.toObject() as Record<string, unknown>
  const output = (value.output ?? {}) as Record<string, unknown>
  const legacyFiles = output.files as Record<string, FileEntry> | undefined
  const legacyManifest = output.manifest as Record<string, ManifestEntry> | undefined
  const bridge = await createMultiAgentWorkspaceBridge({
    repository: workspaceRepository,
    workspaceId: team.workspace_id,
    actor,
    writer,
    legacyFiles,
  })
  return createWorkspaceInstance(
    spatialCreationWorkspace,
    bridge.projectedFiles,
    legacyManifest,
    {
      conversationId: job.conversation_id,
      ownerUserId: job.user_id,
      onFileMutations: bridge.onFileMutations,
      onFileSetBegin: bridge.onFileSetBegin,
      onFileSetFinalize: bridge.onFileSetFinalize,
      // Spatial publication is all-or-nothing. The generic bridge preserves
      // partial outputs for research workflows; a spatial Build must instead
      // tombstone every staged head so a failed batch exposes zero files.
      onFileSetAbort: async reservationId => {
        await workspaceRepository.discardFileSet(team.workspace_id, reservationId)
        return {}
      },
      // WorkspaceFile heads are authoritative. Do not rewrite the legacy
      // whole-map projection from a background process.
    },
  )
}

export function createProductionSpatialDependencies(
  config: SpatialRuntimeConfig = readSpatialRuntimeConfig(),
  options: {
    fetchImpl?: typeof fetch
    resolveArtifactHostname?: ProcessSpatialBuildDependencies['resolveArtifactHostname']
  } = {},
): ProcessSpatialBuildDependencies {
  const adapters = new Map<string, SpatialProviderAdapter>([
    ['aholo', new AholoAdapter({
      baseUrl: config.aholo.apiBaseUrl,
      token: config.aholo.apiKey,
      allowPaidCalls: config.aholo.submissionEnabled,
      fetchImpl: options.fetchImpl,
    })],
    ['lux3d', new Lux3DAdapter({
      baseUrl: config.lux3d.apiBaseUrl,
      token: config.lux3d.apiKey,
      allowPaidCalls: config.lux3d.submissionEnabled,
      fetchImpl: options.fetchImpl,
    })],
  ])
  return {
    adapters,
    publisher: createWorkspaceSpatialPublisher({
      resolveWorkspace: resolveSpatialJobWorkspace,
    }),
    fetchImpl: options.fetchImpl,
    resolveArtifactHostname: options.resolveArtifactHostname
      ?? (process.env.SPATIAL_ARTIFACT_DNS_RESOLVER === 'google-doh'
        ? resolveSpatialArtifactHostnameWithGoogleDoh
        : undefined),
    // A non-empty deny sentinel is intentional. artifact-mirror treats an
    // absent/empty list as unrestricted, which is never safe in production.
    allowedArtifactHosts(provider) {
      const hosts = provider === 'aholo'
        ? config.aholo.assetHosts
        : provider === 'lux3d'
          ? config.lux3d.assetHosts
          : []
      return hosts.length > 0 ? hosts : [DENY_ALL_ARTIFACT_HOST]
    },
    artifactMirroringConfigured(provider) {
      return provider === 'aholo'
        ? config.aholo.assetHosts.length > 0
        : provider === 'lux3d'
          ? config.lux3d.assetHosts.length > 0
          : false
    },
    maxArtifactCount(provider) {
      return provider === 'aholo' ? 8 : provider === 'lux3d' ? 4 : 1
    },
  }
}

export function startProductionSpatialBuildWorker(
  env: NodeJS.ProcessEnv = process.env,
  options: Pick<SpatialBuildWorkerOptions, 'onError' | 'onTerminalJob'> = {},
): SpatialBuildWorker | null {
  const config = readSpatialRuntimeConfig(env)
  if (!config.workerEnabled) return null
  return startSpatialBuildWorker(
    createProductionSpatialDependencies(config),
    {
      concurrency: config.concurrency,
      pollIntervalMs: config.pollIntervalMs,
      leaseMs: config.leaseMs,
      onError: options.onError,
      onTerminalJob: options.onTerminalJob ?? (job => deliverSpatialJobCompletion(job).then(() => undefined)),
    },
  )
}
