import { createHash, randomUUID } from 'node:crypto'
import type { AgentExecutionContext, ToolExecutionInvocation } from '../agent/execution-context'
import { agentTeamService } from '../agent-team'
import { connectDB } from '../db/mongodb'
import { Conversation } from '../db/models'
import { getConversation } from '../db/repository'
import { NewApiChatImageAdapter } from '../image-generation/providers/newapi-chat-image'
import { mongoImageGenerationReceiptStore } from '../image-generation/receipt-store'
import { normalizeImageAspectRatio, type ImageGenerationReceipt } from '../image-generation/types'
import { ensureProviderImageDeliveryUrl } from '../media/storage'
import {
  createDefaultGenerateImageDependencies,
  executeGenerateImage,
  imageGenerationJobId,
} from '../tools/generate-image'
import {
  executeCreateObject3D,
  executeCreateWorld3D,
  type SpatialToolDependencies,
} from '../tools/spatial'
import { createWorkspaceInstance } from '../workspace/instance'
import { spatialCreationWorkspace } from '../workspace/definitions/spatial-creation'
import {
  createMultiAgentWorkspaceBridge,
  MultiAgentWorkspaceRepository,
  type WorkspaceActor,
  type WorkspaceWriterProvenance,
} from '../workspace/multi-agent'
import { assertWorkspaceWritePath, normalizeWorkspacePath } from '../workspace/path-policy'
import type { FileEntry, ManifestEntry, WorkspaceInstance } from '../workspace/types'
import {
  activateOperatorSpatialBuildPaidSlot,
  claimSpatialBuildJobForOperator,
  countActiveSpatialJobs,
  getSpatialBuildJob,
  heartbeatSpatialBuildJob,
  prepareSpatialBuild,
  recoverAmbiguousSpatialSubmissions,
} from './repository'
import {
  createProductionSpatialDependencies,
  parseSpatialAssetHostAllowlist,
  readSpatialRuntimeConfig,
  sanitizeSpatialRuntimeError,
  type SpatialRuntimeConfig,
} from './runtime'
import { getSpatialJobResult, inspectSpatialArtifactResult, waitSpatialJobResult } from './service'
import { processClaimedSpatialBuildJob } from './processor'
import { resolveSpatialArtifactHostnameWithGoogleDoh } from './artifact-mirror'
import { normalizeSpatialWorkspacePrefix } from './identity'
import { SpatialBuildJobModel, SpatialOperatorSmokeIntentModel } from './models'
import {
  assertSpatialOperatorProviderSubmissionGuard,
  authorizeSpatialOperatorSmokeIntent,
  operatorSmokeBudgetKey,
  operatorSmokeIdentity,
  prepareSpatialOperatorSmokeIntent,
  requireSpatialOperatorSmokeIntent,
  reconcileSpatialOperatorSmokeUnknown,
  syncSpatialOperatorSmokeIntent,
  type PrepareSpatialOperatorSmokeIntentInput,
} from './operator-smoke'
import type {
  ClaimedSpatialBuildJob,
  SpatialBuildJobRecord,
  SpatialOperatorSmokeIntentRecord,
  SpatialOperatorSmokeProvider,
  SpatialOperatorSmokeState,
} from './types'

export interface OperatorSmokePrepareInput {
  provider: SpatialOperatorSmokeProvider
  projectId: string
  phase: string
  purpose: string
  prompt?: string
  inputPath?: string
  outputPath?: string
  imageMode?: 'text' | 'edit'
  aspectRatio?: string
}

export interface OperatorSmokeDryRunInput extends Omit<OperatorSmokePrepareInput, 'phase' | 'purpose'> {
  phase?: string
  purpose?: string
}

export interface OperatorSmokeReport {
  smoke_id?: string
  provider: SpatialOperatorSmokeProvider
  image_mode?: 'text' | 'edit'
  phase?: string
  purpose?: string
  state: SpatialOperatorSmokeState | 'dry_run'
  supplier_submissions: number
  target_id?: string
  request_hash?: string
  external_job_id_hash?: string
  provider_status?: string
  artifact_hostnames?: string[]
  workspace_paths?: string[]
  error?: string
  checks?: Array<{ name: string; ok: boolean; detail: string }>
  updated_at: string
}

function requiredText(label: string, value: string | undefined, max = 12_000): string {
  const normalized = value?.trim() ?? ''
  if (!normalized || normalized.length > max || /\p{Cc}/u.test(normalized)) {
    throw new TypeError(`${label} 必须是 1–${max} 个无控制字符的文本。`)
  }
  return normalized
}

function optionalPrompt(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return requiredText('prompt', value)
}

function assertHttpsBase(label: string, raw: string | undefined): URL {
  let parsed: URL
  try {
    parsed = new URL(requiredText(label, raw, 2_048))
  } catch (error) {
    throw new Error(`${label} 不是有效的 HTTPS URL。`, { cause: error })
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) throw new Error(`${label} 必须是无内嵌凭证、query 或 fragment 的 HTTPS URL。`)
  return parsed
}

function assertImageBase(env: NodeJS.ProcessEnv): { url: URL; insecureDevelopmentHttp: boolean } {
  let parsed: URL
  try {
    parsed = new URL(requiredText('LLM_BASE_URL', env.LLM_BASE_URL, 2_048))
  } catch (error) {
    throw new Error('LLM_BASE_URL 不是有效的 HTTP(S) URL。', { cause: error })
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) throw new Error('LLM_BASE_URL 必须是无内嵌凭证、query 或 fragment 的 HTTP(S) URL。')
  const insecureDevelopmentHttp = parsed.protocol === 'http:'
  if (insecureDevelopmentHttp && (
    env.NODE_ENV === 'production'
    || env.PEGASUS_SPATIAL_ALLOW_INSECURE_NEWAPI_HTTP !== '1'
  )) {
    throw new Error(
      'LLM_BASE_URL 使用 HTTP；仅在非 production 且显式设置 '
      + 'PEGASUS_SPATIAL_ALLOW_INSECURE_NEWAPI_HTTP=1 时允许开发 smoke。',
    )
  }
  return { url: parsed, insecureDevelopmentHttp }
}

function providerKey(provider: SpatialOperatorSmokeProvider, env: NodeJS.ProcessEnv): string {
  const value = provider === 'aholo'
    ? env.AHOLO_API_KEY || env.AHOLO_API_TOKEN
    : provider === 'lux3d'
      ? env.LUX3D_API_KEY || env.LUX3D_API_TOKEN
      : env.LLM_API_KEY_TOOLS
  if (!value?.trim()) throw new Error(`${provider} 凭证未配置。`)
  return value.trim()
}

export function validateOperatorSmokeConfiguration(
  provider: SpatialOperatorSmokeProvider,
  env: NodeJS.ProcessEnv = process.env,
): Array<{ name: string; ok: boolean; detail: string }> {
  providerKey(provider, env)
  if (provider === 'image') {
    const imageBase = assertImageBase(env)
    const model = env.PEGASUS_SPATIAL_IMAGE_MODEL?.trim() || 'GPT-image-2'
    if (model !== 'GPT-image-2') throw new Error('图片 smoke 必须冻结精确模型别名 GPT-image-2。')
    return [
      {
        name: 'image_transport',
        ok: true,
        detail: imageBase.insecureDevelopmentHttp
          ? 'HTTP 开发例外已显式启用；prompt、输入图和返回图均为明文传输'
          : 'HTTPS NewAPI Chat Completions',
      },
      { name: 'image_model', ok: true, detail: 'GPT-image-2' },
      { name: 'supplier_submit', ok: true, detail: 'dry-run 未调用供应商' },
    ]
  }
  const prefix = provider === 'aholo' ? 'AHOLO' : 'LUX3D'
  assertHttpsBase(`${prefix}_API_BASE_URL`, env[`${prefix}_API_BASE_URL`] || 'https://api.aholo3d.cn')
  const allowlist = parseSpatialAssetHostAllowlist(env[`${prefix}_ASSET_HOST_ALLOWLIST`])
  if (allowlist.invalid.length > 0) throw new Error(`${prefix}_ASSET_HOST_ALLOWLIST 包含无效 hostname。`)
  return [
    { name: 'provider_transport', ok: true, detail: 'HTTPS；凭证存在但未输出' },
    {
      name: 'artifact_allowlist',
      ok: true,
      detail: allowlist.hosts.length > 0
        ? `${allowlist.hosts.length} 个精确 hostname`
        : '为空；首次成功后将进入 configuration_blocked',
    },
    { name: 'supplier_submit', ok: true, detail: 'dry-run 未调用供应商' },
  ]
}

function stableWriter(intent: SpatialOperatorSmokeIntentRecord, teamId: string, rootAgentId: string): WorkspaceWriterProvenance {
  const digest = createHash('sha256')
    .update(`operator-smoke-workspace-v1\0${intent.smoke_id}\0${intent.request_hash}`)
    .digest('hex')
  return {
    team_id: teamId,
    agent_id: rootAgentId,
    task_id: intent.tool_use_id,
    run_id: intent.run_id,
    execution_fence_token: `operator_smoke_${digest}`,
  }
}

async function operatorWorkspace(
  intent: SpatialOperatorSmokeIntentRecord,
): Promise<WorkspaceInstance> {
  const conversation = await getConversation(intent.conversation_id, intent.user_id)
  if (!conversation) throw new Error('Operator smoke 指向的 Conversation/Workspace 不存在。')
  const team = await agentTeamService.ensureTeam({
    conversationId: intent.conversation_id,
    userId: intent.user_id,
    workspaceId: intent.project_id,
  })
  const actor: WorkspaceActor = {
    teamId: team.team_id,
    agentId: team.root_agent_id,
    rootAgentId: team.root_agent_id,
    role: 'root',
  }
  const writer = stableWriter(intent, team.team_id, team.root_agent_id)
  const repository = new MultiAgentWorkspaceRepository({
    fenceValidator: async ({ workspaceId, writer: candidate }) => {
      if (
        workspaceId !== intent.project_id
        || candidate.team_id !== writer.team_id
        || candidate.agent_id !== writer.agent_id
        || candidate.task_id !== writer.task_id
        || candidate.run_id !== writer.run_id
        || candidate.execution_fence_token !== writer.execution_fence_token
      ) return false
      return Boolean(await SpatialOperatorSmokeIntentModel.exists({
        smoke_id: intent.smoke_id,
        state: {
          $in: [
            'authorized',
            'submitting',
            'submitted',
            'running',
            'materializing',
            'configuration_blocked',
          ],
        },
      }))
    },
  })
  const value = conversation.toObject() as Record<string, unknown>
  const output = (value.output ?? {}) as Record<string, unknown>
  const legacyFiles = output.files as Record<string, FileEntry> | undefined
  const legacyManifest = output.manifest as Record<string, ManifestEntry> | undefined
  const bridge = await createMultiAgentWorkspaceBridge({
    repository,
    workspaceId: intent.project_id,
    actor,
    writer,
    legacyFiles,
  })
  return createWorkspaceInstance(
    spatialCreationWorkspace,
    bridge.projectedFiles,
    legacyManifest,
    {
      conversationId: intent.conversation_id,
      ownerUserId: intent.user_id,
      onFileMutations: bridge.onFileMutations,
      onFileSetBegin: bridge.onFileSetBegin,
      onFileSetFinalize: bridge.onFileSetFinalize,
      onFileSetAbort: bridge.onFileSetAbort,
    },
  )
}

function executionContext(intent: SpatialOperatorSmokeIntentRecord): AgentExecutionContext {
  return {
    userId: intent.user_id,
    conversationId: intent.conversation_id,
    workspaceId: intent.project_id,
    runId: intent.run_id,
    isRoot: true,
  }
}

function invocation(intent: SpatialOperatorSmokeIntentRecord): ToolExecutionInvocation {
  return {
    toolUseId: intent.tool_use_id,
    actionId: `operator_smoke:${intent.smoke_id}`,
    turn: 0,
  }
}

function spatialToolDependencies(): SpatialToolDependencies {
  return {
    prepareSpatialBuild: input => prepareSpatialBuild({ ...input, executionGate: 'operator' }),
    getSpatialBuildJob,
    countActiveSpatialJobs,
    getSpatialJobResult,
    waitSpatialJobResult,
    inspectSpatialArtifactResult,
    resolveProviderRasterUrl: asset => ensureProviderImageDeliveryUrl(asset.assetId),
    now: () => new Date(),
  }
}

function outputPathFor(input: OperatorSmokePrepareInput, smokeId: string): string {
  if (input.outputPath?.trim()) return input.outputPath.trim()
  const short = smokeId.slice(-12)
  if (input.provider === 'aholo') return `output/spatial/worlds/operator-${short}`
  if (input.provider === 'lux3d') return `output/spatial/objects/operator-${short}`
  return `output/spatial/images/operator-${short}.png`
}

function normalizeOperatorOutputPath(
  provider: SpatialOperatorSmokeProvider,
  raw: string,
): string {
  const expectedRoot = provider === 'aholo'
    ? 'output/spatial/worlds/'
    : provider === 'lux3d'
      ? 'output/spatial/objects/'
      : 'output/spatial/images/'
  const normalized = provider === 'image'
    ? assertWorkspaceWritePath(raw, spatialCreationWorkspace.policy)
    : normalizeSpatialWorkspacePrefix(raw)
  if (!normalized.startsWith(expectedRoot) || normalized === expectedRoot.slice(0, -1)) {
    throw new TypeError(`output path 必须位于 ${expectedRoot}`)
  }
  return normalized
}

function normalizedRequest(input: OperatorSmokePrepareInput): Record<string, unknown> {
  const identity = operatorSmokeIdentity({
    projectId: input.projectId,
    phase: input.phase,
    purpose: input.purpose,
  })
  const prompt = optionalPrompt(input.prompt)
  const inputPath = input.inputPath ? normalizeWorkspacePath(input.inputPath) : undefined
  const imageMode = input.provider === 'image' ? input.imageMode ?? 'text' : undefined
  if (!prompt && !inputPath) throw new TypeError('prepare 至少需要 --prompt 或 --input-path。')
  if (input.provider === 'image' && imageMode === 'edit' && !inputPath) {
    throw new TypeError('图片 edit smoke 必须提供 --input-path。')
  }
  if (input.provider === 'image' && imageMode === 'text' && inputPath) {
    throw new TypeError('图片 text smoke 不接受 --input-path；请使用 --mode edit。')
  }
  const outputPath = normalizeOperatorOutputPath(
    input.provider,
    outputPathFor(input, identity.smokeId),
  )
  return {
    ...(prompt ? { prompt } : {}),
    ...(inputPath ? { input_path: inputPath } : {}),
    output_path: outputPath,
    ...(imageMode ? { image_mode: imageMode } : {}),
    ...(input.aspectRatio?.trim() ? { aspect_ratio: input.aspectRatio.trim() } : {}),
  }
}

function toolInput(intent: SpatialOperatorSmokeIntentRecord): Record<string, unknown> {
  const request = intent.request_snapshot
  if (intent.provider === 'aholo') {
    return {
      ...(request.prompt ? { prompt: request.prompt } : {}),
      ...(request.input_path ? { source_image_path: request.input_path } : {}),
      output_path_prefix: request.output_path,
    }
  }
  if (intent.provider === 'lux3d') {
    return {
      ...(request.prompt ? { prompt: request.prompt } : {}),
      ...(request.input_path ? { reference_image_paths: [request.input_path] } : {}),
      output_path_prefix: request.output_path,
    }
  }
  return {
    prompt: request.prompt,
    output_path: request.output_path,
    ...(request.input_path ? { input_image_path: request.input_path } : {}),
    ...(request.aspect_ratio ? { aspect_ratio: request.aspect_ratio } : {}),
  }
}

function parseToolResult(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch (error) {
    throw new Error('Operator smoke 的正式工具返回了无效 envelope。', { cause: error })
  }
}

async function backingForImage(intent: SpatialOperatorSmokeIntentRecord): Promise<ImageGenerationReceipt | null> {
  return mongoImageGenerationReceiptStore.get({
    projectId: intent.project_id,
    runId: intent.run_id,
    toolUseId: intent.tool_use_id,
  })
}

function mapImageState(
  intent: SpatialOperatorSmokeIntentRecord,
  receipt: ImageGenerationReceipt,
): SpatialOperatorSmokeState {
  if (receipt.status === 'asset_stored') return 'materializing'
  if (receipt.status === 'prepared' && intent.authorized_at) return 'authorized'
  return receipt.status
}

async function syncImage(intent: SpatialOperatorSmokeIntentRecord): Promise<SpatialOperatorSmokeIntentRecord> {
  const receipt = await backingForImage(intent)
  if (!receipt) return intent
  return syncSpatialOperatorSmokeIntent(intent.smoke_id, {
    targetId: imageGenerationJobId(receipt),
    state: mapImageState(intent, receipt),
    submissionCount: receipt.status === 'prepared' ? 0 : 1,
    lastError: receipt.errorMessage ? sanitizeSpatialRuntimeError(receipt.errorMessage) : null,
    finishedAt: ['published', 'failed', 'unknown'].includes(receipt.status) ? receipt.updatedAt : null,
  })
}

function mapSpatialState(
  intent: SpatialOperatorSmokeIntentRecord,
  job: SpatialBuildJobRecord,
): SpatialOperatorSmokeState {
  // Backing terminal state is authoritative. provider_status is diagnostic
  // and may retain the last pre-terminal value (for example a configuration
  // block followed by a permanent validation failure).
  if (job.status === 'failed' || job.status === 'unknown' || job.status === 'published') {
    return job.status
  }
  if (job.status === 'cancelled') return 'failed'
  if (job.provider_status === 'configuration_blocked') return 'configuration_blocked'
  if (job.status === 'prepared' && intent.authorized_at) return 'authorized'
  return job.status
}

async function backingForSpatial(
  intent: SpatialOperatorSmokeIntentRecord,
): Promise<SpatialBuildJobRecord | null> {
  if (!intent.target_id) return null
  return SpatialBuildJobModel.findOne({
    job_id: intent.target_id,
    project_id: intent.project_id,
    user_id: intent.user_id,
    conversation_id: intent.conversation_id,
    run_id: intent.run_id,
    tool_use_id: intent.tool_use_id,
    provider: intent.provider,
  }).lean<SpatialBuildJobRecord>()
}

async function syncSpatial(intent: SpatialOperatorSmokeIntentRecord): Promise<SpatialOperatorSmokeIntentRecord> {
  if (!intent.target_id) return intent
  const job = await backingForSpatial(intent)
  if (!job) return intent
  return syncSpatialOperatorSmokeIntent(intent.smoke_id, {
    targetId: job.job_id,
    state: mapSpatialState(intent, job),
    submissionCount: job.submission_attempts > 0 ? 1 : 0,
    artifactHostnames: job.configuration_blocked_hosts ?? [],
    lastError: job.last_error,
    finishedAt: job.finished_at,
  })
}

async function syncIntent(intent: SpatialOperatorSmokeIntentRecord): Promise<SpatialOperatorSmokeIntentRecord> {
  return intent.provider === 'image' ? syncImage(intent) : syncSpatial(intent)
}

export async function prepareOperatorSmoke(
  input: OperatorSmokePrepareInput,
): Promise<OperatorSmokeReport> {
  validateOperatorSmokeConfiguration(input.provider, process.env)
  const request = normalizedRequest(input)
  await connectDB()
  const conversation = await Conversation.findOne({ conversation_id: input.projectId.trim() })
    .select('conversation_id user_id')
    .lean<{ conversation_id: string; user_id: string }>()
  if (!conversation) throw new Error('找不到 --project-id 对应的 Conversation。请先在界面创建项目。')
  let intent = await prepareSpatialOperatorSmokeIntent({
    projectId: conversation.conversation_id,
    userId: conversation.user_id,
    conversationId: conversation.conversation_id,
    provider: input.provider,
    imageMode: input.provider === 'image' ? input.imageMode ?? 'text' : null,
    phase: input.phase,
    purpose: input.purpose,
    request,
  })
  const workspace = await operatorWorkspace(intent)
  if (intent.provider === 'image') {
    const dependencies = createDefaultGenerateImageDependencies()
    const result = await executeGenerateImage(toolInput(intent), workspace, {
      executionContext: executionContext(intent),
      invocation: invocation(intent),
      dependencies: {
        ...dependencies,
        provider: new NewApiChatImageAdapter(),
      },
      submissionPolicy: 'prepare-only',
    })
    if (result.is_error) throw new Error(String(parseToolResult(result.content).error || '图片 receipt 准备失败。'))
    intent = await syncImage(intent)
  } else {
    const result = intent.provider === 'aholo'
      ? await executeCreateWorld3D(toolInput(intent), workspace, {
          executionContext: executionContext(intent),
          invocation: invocation(intent),
          dependencies: spatialToolDependencies(),
        })
      : await executeCreateObject3D(toolInput(intent), workspace, {
          executionContext: executionContext(intent),
          invocation: invocation(intent),
          dependencies: spatialToolDependencies(),
        })
    const envelope = parseToolResult(result.content)
    if (result.is_error || envelope.status === 'failed') {
      throw new Error(String(envelope.error || '空间 Job 准备失败。'))
    }
    const targetId = String(envelope.job_id || '')
    if (!targetId) throw new Error('空间工具没有返回 durable job_id。')
    intent = await syncSpatialOperatorSmokeIntent(intent.smoke_id, {
      targetId,
      state: intent.state,
      submissionCount: intent.submission_count,
    })
    intent = await syncSpatial(intent)
  }
  return reportForIntent(intent)
}

function operatorSpatialConfig(
  provider: 'aholo' | 'lux3d',
  env: NodeJS.ProcessEnv,
): SpatialRuntimeConfig {
  validateOperatorSmokeConfiguration(provider, env)
  const config = readSpatialRuntimeConfig(env)
  return {
    ...config,
    aholo: { ...config.aholo, submissionEnabled: provider === 'aholo' },
    lux3d: { ...config.lux3d, submissionEnabled: provider === 'lux3d' },
  }
}

async function processWithHeartbeat(
  claim: ClaimedSpatialBuildJob,
  dependencies: ReturnType<typeof createProductionSpatialDependencies>,
): Promise<void> {
  const leaseMs = 15 * 60_000
  const timer = setInterval(() => {
    void heartbeatSpatialBuildJob(claim, leaseMs).catch(() => undefined)
  }, 20_000)
  timer.unref()
  try {
    await processClaimedSpatialBuildJob(claim, dependencies, {
      providerPollDelayMs: 2_000,
      // Keep the Operator path single-attempt even in the presence of a future
      // claim-filter regression. A resume adapter is additionally submit-off.
      maxSubmissionAttempts: 1,
    })
  } finally {
    clearInterval(timer)
  }
}

async function submitOrResumeSpatial(
  intent: SpatialOperatorSmokeIntentRecord,
  allowSubmit: boolean,
): Promise<SpatialOperatorSmokeIntentRecord> {
  if (!intent.target_id) throw new Error('Operator smoke 尚未创建正式 SpatialBuildJob。')
  if (allowSubmit) await assertSpatialOperatorProviderSubmissionGuard(intent.smoke_id)
  await recoverAmbiguousSpatialSubmissions()
  let current = await syncSpatial(intent)
  const job = await backingForSpatial(intent)
  if (!job) throw new Error('Operator smoke 的 SpatialBuildJob 不存在或身份不匹配。')
  if (job.status === 'prepared') {
    if (!allowSubmit) return current
    await activateOperatorSpatialBuildPaidSlot(job.job_id)
  }
  const claim = await claimSpatialBuildJobForOperator({
    jobId: job.job_id,
    ownerId: `operator_${process.pid}_${randomUUID()}`,
    leaseMs: 15 * 60_000,
    allowKnownExternalJob: job.status !== 'prepared',
  })
  if (!claim) return syncSpatial(current)
  const config = allowSubmit
    ? operatorSpatialConfig(intent.provider as 'aholo' | 'lux3d', process.env)
    : readSpatialRuntimeConfig(process.env)
  await processWithHeartbeat(claim, createProductionSpatialDependencies(config, {
    resolveArtifactHostname: process.env.SPATIAL_ARTIFACT_DNS_RESOLVER === 'google-doh'
      ? resolveSpatialArtifactHostnameWithGoogleDoh
      : undefined,
  }))
  current = await requireSpatialOperatorSmokeIntent(intent.smoke_id)
  return syncSpatial(current)
}

async function submitOrResumeImage(
  intent: SpatialOperatorSmokeIntentRecord,
  allowSubmit: boolean,
): Promise<SpatialOperatorSmokeIntentRecord> {
  if (allowSubmit) {
    validateOperatorSmokeConfiguration('image', process.env)
    await assertSpatialOperatorProviderSubmissionGuard(intent.smoke_id)
  }
  const workspace = await operatorWorkspace(intent)
  const dependencies = createDefaultGenerateImageDependencies()
  const result = await executeGenerateImage(toolInput(intent), workspace, {
    executionContext: executionContext(intent),
    invocation: invocation(intent),
    dependencies: {
      ...dependencies,
      provider: new NewApiChatImageAdapter(),
    },
    submissionPolicy: allowSubmit ? 'allow-submit' : 'forbid-submit',
  })
  // The receipt, not the transient ToolResult, is authoritative. An is_error
  // result can legitimately mean a durable unknown/failed state.
  void result
  return syncImage(await requireSpatialOperatorSmokeIntent(intent.smoke_id))
}

export async function submitOperatorSmoke(
  smokeId: string,
  confirmation: string,
): Promise<OperatorSmokeReport> {
  const initial = await requireSpatialOperatorSmokeIntent(smokeId)
  validateOperatorSmokeConfiguration(initial.provider, process.env)
  let intent = await authorizeSpatialOperatorSmokeIntent(smokeId, confirmation)
  await assertSpatialOperatorProviderSubmissionGuard(intent.smoke_id)
  intent = intent.provider === 'image'
    ? await submitOrResumeImage(intent, true)
    : await submitOrResumeSpatial(intent, true)
  return reportForIntent(intent)
}

export async function resumeOperatorSmoke(smokeId: string): Promise<OperatorSmokeReport> {
  let intent = await requireSpatialOperatorSmokeIntent(smokeId)
  intent = await syncIntent(intent)
  if (intent.state === 'prepared' || intent.state === 'authorized') {
    return reportForIntent(intent, 'resume 禁止从 prepared 跨入供应商提交。')
  }
  intent = intent.provider === 'image'
    ? await submitOrResumeImage(intent, false)
    : await submitOrResumeSpatial(intent, false)
  return reportForIntent(intent)
}

export async function statusOperatorSmoke(smokeId: string): Promise<OperatorSmokeReport> {
  const intent = await requireSpatialOperatorSmokeIntent(smokeId)
  return reportForIntent(await syncIntent(intent))
}

export async function reconcileUnknownOperatorSmoke(
  smokeId: string,
  input: { confirmation: string; actor: string; reason: string },
): Promise<OperatorSmokeReport> {
  const intent = await reconcileSpatialOperatorSmokeUnknown(smokeId, input)
  return reportForIntent(intent, 'unknown 已人工核销；原 intent 保持 unknown，后续必须使用新的 phase/purpose。')
}

export async function dryRunOperatorSmoke(
  input: OperatorSmokeDryRunInput,
): Promise<OperatorSmokeReport> {
  const checks = validateOperatorSmokeConfiguration(input.provider, process.env)
  const prompt = input.prompt === undefined ? 'Operator smoke dry-run placeholder.' : optionalPrompt(input.prompt)
  if (!prompt && !input.inputPath) throw new TypeError('dry-run 至少需要 prompt 或 input path。')
  const mode = input.provider === 'image' ? input.imageMode ?? 'text' : undefined
  if (mode === 'edit' && !input.inputPath) throw new TypeError('图片 edit dry-run 需要 --input-path。')
  if (mode === 'text' && input.inputPath) throw new TypeError('图片 text dry-run 不接受 --input-path。')
  if (
    input.aspectRatio
    && !normalizeImageAspectRatio(input.aspectRatio)
  ) throw new TypeError(`不支持的 aspect ratio：${input.aspectRatio}`)
  if (input.outputPath) {
    normalizeOperatorOutputPath(input.provider, input.outputPath)
  }
  if (input.inputPath) {
    if (!input.projectId?.trim()) throw new TypeError('带 input path 的 dry-run 需要 --project-id。')
    await connectDB()
    const conversation = await Conversation.findOne({ conversation_id: input.projectId.trim() })
      .select('conversation_id user_id output')
      .lean<{ conversation_id: string; user_id: string }>()
    if (!conversation) throw new Error('找不到 --project-id 对应的 Conversation。')
    const synthetic: PrepareSpatialOperatorSmokeIntentInput = {
      projectId: conversation.conversation_id,
      userId: conversation.user_id,
      conversationId: conversation.conversation_id,
      provider: input.provider,
      imageMode: mode ?? null,
      phase: input.phase ?? 'dry-run',
      purpose: input.purpose ?? `dry-run-${Date.now()}`,
      request: {},
    }
    // Dry-run must not create an intent. Build a read-only projection using a
    // transient identity and verify the Workspace raster directly.
    const identity = operatorSmokeIdentity(synthetic)
    const transient: SpatialOperatorSmokeIntentRecord = {
      smoke_id: identity.smokeId,
      project_id: synthetic.projectId,
      user_id: synthetic.userId,
      conversation_id: synthetic.conversationId,
      provider: input.provider,
      image_mode: mode ?? null,
      phase: synthetic.phase,
      purpose: synthetic.purpose,
      budget_key: operatorSmokeBudgetKey(input.provider, mode),
      request_hash: '0'.repeat(64),
      request_snapshot: {},
      run_id: identity.runId,
      tool_use_id: identity.toolUseId,
      target_id: null,
      state: 'prepared',
      authorized_at: null,
      submission_count: 0,
      artifact_hostnames: [],
      last_error: null,
      unknown_reconciled_at: null,
      unknown_reconciled_by: null,
      unknown_reconciliation_reason: null,
      created_at: new Date(),
      updated_at: new Date(),
      finished_at: null,
    }
    const workspace = await operatorWorkspace(transient)
    const raster = await workspace.readRaster(normalizeWorkspacePath(input.inputPath))
    if (!raster) throw new Error('指定 input path 不是当前 Workspace 内可读取的图片。')
    if (input.provider !== 'image') {
      const raw = raster.urls.original || raster.urls.model
      let publicUrl: URL
      try {
        publicUrl = new URL(raw)
      } catch (error) {
        throw new Error('Workspace 图片没有可供空间供应商读取的绝对 URL。', { cause: error })
      }
      if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password) {
        throw new Error('Workspace 图片必须映射为无内嵌凭证的公网 HTTPS URL。')
      }
    }
    checks.push({ name: 'workspace_input', ok: true, detail: '已验证 Workspace 归属（未输出 URL）' })
  }
  return {
    provider: input.provider,
    ...(input.provider === 'image' ? { image_mode: input.imageMode ?? 'text' } : {}),
    state: 'dry_run',
    supplier_submissions: 0,
    checks,
    updated_at: new Date().toISOString(),
  }
}

async function reportForIntent(
  intent: SpatialOperatorSmokeIntentRecord,
  note?: string,
): Promise<OperatorSmokeReport> {
  let providerStatus: string | undefined
  let externalJobIdHash: string | undefined
  let workspacePaths: string[] | undefined
  if (intent.provider === 'image') {
    const receipt = await backingForImage(intent)
    providerStatus = receipt?.status
    workspacePaths = receipt?.status === 'published' ? [receipt.outputPath] : undefined
  } else if (intent.target_id) {
    const backing = await backingForSpatial(intent)
    const job = backing && {
      external_job_id: backing.external_job_id,
      provider_status: backing.provider_status,
      published_workspace_paths: backing.published_workspace_paths,
    }
    providerStatus = job?.provider_status ?? undefined
    externalJobIdHash = job?.external_job_id
      ? createHash('sha256').update(job.external_job_id).digest('hex')
      : undefined
    workspacePaths = job?.published_workspace_paths.length
      ? [...job.published_workspace_paths]
      : undefined
  }
  return {
    smoke_id: intent.smoke_id,
    provider: intent.provider,
    ...(intent.image_mode ? { image_mode: intent.image_mode } : {}),
    phase: intent.phase,
    purpose: intent.purpose,
    state: intent.state,
    supplier_submissions: intent.submission_count,
    ...(intent.target_id ? { target_id: intent.target_id } : {}),
    request_hash: intent.request_hash,
    ...(externalJobIdHash ? { external_job_id_hash: externalJobIdHash } : {}),
    ...(providerStatus ? { provider_status: providerStatus } : {}),
    ...(intent.artifact_hostnames.length ? { artifact_hostnames: [...intent.artifact_hostnames] } : {}),
    ...(workspacePaths ? { workspace_paths: workspacePaths } : {}),
    ...(intent.last_error || note
      ? { error: sanitizeSpatialRuntimeError(intent.last_error || note) }
      : {}),
    updated_at: intent.updated_at.toISOString(),
  }
}
