import type { AgentExecutionContext, ToolExecutionInvocation } from '../agent/execution-context'
import {
  countActiveSpatialJobs,
  getSpatialBuildJob,
  getSpatialJobResult,
  inspectSpatialArtifactResult,
  normalizeSpatialWorkspacePrefix,
  prepareSpatialBuild,
  serializeSpatialToolResult,
  waitSpatialJobResult,
  type PrepareSpatialBuildInput,
  type SpatialBuildJobRecord,
  type SpatialCommandScope,
  type SpatialToolResultEnvelope,
} from '../spatial'
import { ensureProviderImageDeliveryUrl } from '../media/storage'
import type { RasterAssetRef, ToolResult } from '../types'
import { normalizeWorkspacePath } from '../workspace/path-policy'
import type { WorkspaceInstance } from '../workspace/types'

export const SPATIAL_TOOL_NAMES = [
  'CreateObject3D',
  'CreateWorld3D',
  'GetSpatialJob',
  'WaitSpatialJob',
  'InspectSpatialArtifact',
] as const

export type SpatialToolName = typeof SPATIAL_TOOL_NAMES[number]

const OBJECT_OUTPUT_ROOT = 'output/spatial/objects/'
const WORLD_OUTPUT_ROOT = 'output/spatial/worlds/'

export interface CreateObject3DInput {
  prompt?: string
  reference_image_paths?: string[]
  output_path_prefix: string
}

export interface CreateWorld3DInput {
  prompt?: string
  source_image_path?: string
  output_path_prefix: string
}

export interface SpatialStatusInput {
  job_id: string
}

export interface WaitSpatialJobInput extends SpatialStatusInput {
  timeout_ms?: number
}

export interface InspectSpatialArtifactInput {
  artifact_id: string
}

export interface SpatialToolDependencies {
  prepareSpatialBuild(input: PrepareSpatialBuildInput): Promise<SpatialBuildJobRecord>
  getSpatialBuildJob(
    jobId: string,
    scope: SpatialCommandScope,
  ): Promise<SpatialBuildJobRecord | null>
  /** Operator/test diagnostics only; normal product creation is not gated by this count. */
  countActiveSpatialJobs(scope: SpatialCommandScope): Promise<number>
  getSpatialJobResult(input: {
    jobId: string
    scope: SpatialCommandScope
  }): Promise<SpatialToolResultEnvelope>
  waitSpatialJobResult(input: {
    jobId: string
    scope: SpatialCommandScope
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<SpatialToolResultEnvelope>
  inspectSpatialArtifactResult(input: {
    artifactId: string
    scope: SpatialCommandScope
  }): Promise<SpatialToolResultEnvelope>
  resolveProviderRasterUrl(asset: RasterAssetRef): Promise<string>
  now(): Date
}

export interface SpatialToolRuntime {
  executionContext?: AgentExecutionContext
  invocation?: ToolExecutionInvocation
  signal?: AbortSignal
  dependencies?: SpatialToolDependencies
}

const defaultDependencies: SpatialToolDependencies = {
  prepareSpatialBuild,
  getSpatialBuildJob,
  countActiveSpatialJobs,
  getSpatialJobResult,
  waitSpatialJobResult,
  inspectSpatialArtifactResult,
  resolveProviderRasterUrl: asset => ensureProviderImageDeliveryUrl(asset.assetId),
  now: () => new Date(),
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function onlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed)
  return Object.keys(record).every(key => allowedSet.has(key))
}

function cleanOptionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new TypeError('字段必须是字符串。')
  const normalized = value.trim()
  if (!normalized) throw new TypeError('字段不能是空字符串。')
  if (normalized.length > maxLength) throw new TypeError(`字段不能超过 ${maxLength} 个字符。`)
  return normalized
}

function cleanId(label: string, value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} 必须是非空字符串。`)
  const normalized = value.trim()
  if (normalized.length > 160) throw new TypeError(`${label} 不能超过 160 个字符。`)
  return normalized
}

function normalizeBuildPrefix(value: unknown, root: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('output_path_prefix 必须是非空 Workspace 路径。')
  }
  const normalized = normalizeSpatialWorkspacePrefix(value)
  if (!normalized.startsWith(root) || normalized === root.slice(0, -1)) {
    throw new TypeError(`output_path_prefix 必须位于 ${root}`)
  }
  if (normalized.length > 512 || normalized.split('/').length > 8) {
    throw new TypeError('output_path_prefix 超出 Workspace 路径限制。')
  }
  return normalized
}

function toolEnvelope(input: {
  kind: 'object' | 'world' | 'job' | 'artifact'
  provider: string
  status?: SpatialToolResultEnvelope['status']
  message?: string
  error?: string
  now: Date
}): SpatialToolResultEnvelope {
  return {
    schema_version: 1,
    kind: input.kind,
    status: input.status ?? 'failed',
    provider: input.provider,
    ...(input.message ? { message: input.message } : {}),
    ...(input.error ? { error: input.error } : {}),
    updated_at: input.now.toISOString(),
  }
}

function resultFromEnvelope(
  envelope: SpatialToolResultEnvelope,
  isError = false,
): ToolResult {
  return {
    content: serializeSpatialToolResult(envelope),
    ...(isError ? { is_error: true } : {}),
  }
}

function failed(
  kind: 'object' | 'world' | 'job' | 'artifact',
  provider: string,
  message: string,
  dependencies: SpatialToolDependencies,
): ToolResult {
  return resultFromEnvelope(toolEnvelope({
    kind,
    provider,
    error: message.slice(0, 4_000),
    now: dependencies.now(),
  }), true)
}

function requireDurableContext(
  runtime: SpatialToolRuntime,
  kind: 'object' | 'world' | 'job' | 'artifact',
  provider: string,
  dependencies: SpatialToolDependencies,
): { context: AgentExecutionContext; invocation: ToolExecutionInvocation } | ToolResult {
  if (!runtime.executionContext || !runtime.invocation) {
    return failed(kind, provider, '空间工具需要持久化的 Agent 执行上下文。', dependencies)
  }
  return { context: runtime.executionContext, invocation: runtime.invocation }
}

function isContextResult(
  value: { context: AgentExecutionContext; invocation: ToolExecutionInvocation } | ToolResult,
): value is ToolResult {
  return 'content' in value
}

function scopeFor(context: AgentExecutionContext): SpatialCommandScope {
  return {
    projectId: context.workspaceId || context.conversationId,
    userId: context.userId,
  }
}

function providerUrlFromAsset(asset: RasterAssetRef): string {
  const raw = asset.urls.original || asset.urls.model
  if (!raw) throw new Error(`图片资产 ${asset.assetId} 没有可供空间供应商读取的 URL。`)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`图片资产 ${asset.assetId} 尚未映射到可访问的绝对 URL。`)
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`图片资产 ${asset.assetId} 必须映射为无内嵌凭证的公网 HTTPS URL。`)
  }
  return url.toString()
}

async function resolveAuthorizedRaster(
  workspace: WorkspaceInstance,
  rawPath: string,
  dependencies: SpatialToolDependencies,
): Promise<{ path: string; assetId: string; url: string }> {
  let path: string
  try {
    path = normalizeWorkspacePath(rawPath)
  } catch (error) {
    throw new Error(`无效的 Workspace 图片路径：${(error as Error).message}`)
  }
  const first = await workspace.readRaster(path)
  if (!first) throw new Error(`Workspace 中不存在可用图片：${path}`)
  const providerAsset = { ...first, urls: { ...first.urls, original: await dependencies.resolveProviderRasterUrl(first) } }
  const url = providerUrlFromAsset(providerAsset)
  // Guard against a path being revised while this invocation is resolving its
  // provider input. The frozen asset identity must match the frozen URL.
  const current = await workspace.readRaster(path)
  if (!current || current.assetId !== first.assetId) {
    throw new Error(`读取期间 Workspace 图片发生变化，请重新提交：${path}`)
  }
  return { path, assetId: first.assetId, url }
}

async function preparePaidBuild(input: {
  context: AgentExecutionContext
  invocation: ToolExecutionInvocation
  kind: 'object' | 'world'
  provider: 'lux3d' | 'aholo'
  modelSnapshot: string
  request: PrepareSpatialBuildInput['request']
  dependencies: SpatialToolDependencies
}): Promise<ToolResult> {
  const scope = scopeFor(input.context)
  const job = await input.dependencies.prepareSpatialBuild({
    projectId: scope.projectId,
    runId: input.context.runId,
    toolUseId: input.invocation.toolUseId,
    userId: input.context.userId,
    conversationId: input.context.conversationId,
    kind: input.kind,
    provider: input.provider,
    modelSnapshot: input.modelSnapshot,
    request: input.request,
    notifyOnTerminal: true,
  })
  return resultFromEnvelope(await input.dependencies.getSpatialJobResult({
    jobId: job.job_id,
    scope,
  }))
}

export async function executeCreateObject3D(
  rawInput: unknown,
  workspace: WorkspaceInstance,
  runtime: SpatialToolRuntime,
): Promise<ToolResult> {
  const dependencies = runtime.dependencies ?? defaultDependencies
  const durable = requireDurableContext(runtime, 'object', 'lux3d', dependencies)
  if (isContextResult(durable)) return durable
  try {
    if (!isRecord(rawInput) || !onlyKeys(rawInput, ['prompt', 'reference_image_paths', 'output_path_prefix'])) {
      throw new TypeError('CreateObject3D 输入包含未知字段或不是对象。')
    }
    const prompt = cleanOptionalText(rawInput.prompt, 12_000)
    const prefix = normalizeBuildPrefix(rawInput.output_path_prefix, OBJECT_OUTPUT_ROOT)
    let referencePaths: string[] = []
    if (rawInput.reference_image_paths !== undefined) {
      if (
        !Array.isArray(rawInput.reference_image_paths)
        || rawInput.reference_image_paths.length < 1
        || rawInput.reference_image_paths.length > 4
        || rawInput.reference_image_paths.some(value => typeof value !== 'string' || !value.trim())
      ) {
        throw new TypeError('reference_image_paths 必须包含 1–4 个非空 Workspace 图片路径。')
      }
      referencePaths = rawInput.reference_image_paths.map(value => String(value))
      if (new Set(referencePaths).size !== referencePaths.length) {
        throw new TypeError('reference_image_paths 不能包含重复路径。')
      }
    }
    if (!prompt && referencePaths.length === 0) {
      throw new TypeError('CreateObject3D 至少需要 prompt 或 reference_image_paths。')
    }
    const references = await Promise.all(
      referencePaths.map(path => resolveAuthorizedRaster(workspace, path, dependencies)),
    )
    // Lux exposes two distinct public contracts: text-to-3D accepts at most
    // one optional image, while img-to-3D accepts an ordered `imgs` array.
    // Multiple views are therefore authoritative geometry input. Preserve a
    // caller-supplied prompt in the durable receipt for audit/lineage, but do
    // not let it accidentally route the paid request to text-to-3D.
    const isMultiView = references.length > 1
    const luxVersion = isMultiView ? 'G1-Turbo' : 'G1'
    return await preparePaidBuild({
      context: durable.context,
      invocation: durable.invocation,
      kind: 'object',
      provider: 'lux3d',
      modelSnapshot: luxVersion,
      request: {
        output_path_prefix: prefix,
        ...(prompt && !isMultiView ? { prompt } : {}),
        ...(references.length ? { input_image_paths: references.map(reference => reference.path) } : {}),
        provider_options: {
          version: luxVersion,
          ...(prompt && isMultiView ? { reference_guidance: prompt } : {}),
          // Freeze both representations in one supplier task. The GLB mesh is
          // useful for transforms/collision proxies, while the Gaussian PLY
          // lets the product compare Lux3D's native 3DGS appearance without a
          // second paid submission.
          output_formats: ['glb', 'ply'],
          ...(references.length
            ? {
                source_image_urls: references.map(reference => reference.url),
                source_asset_ids: references.map(reference => reference.assetId),
              }
            : {}),
        },
      },
      dependencies,
    })
  } catch (error) {
    return failed('object', 'lux3d', (error as Error).message, dependencies)
  }
}

export async function executeCreateWorld3D(
  rawInput: unknown,
  workspace: WorkspaceInstance,
  runtime: SpatialToolRuntime,
): Promise<ToolResult> {
  const dependencies = runtime.dependencies ?? defaultDependencies
  const durable = requireDurableContext(runtime, 'world', 'aholo', dependencies)
  if (isContextResult(durable)) return durable
  try {
    if (!isRecord(rawInput) || !onlyKeys(rawInput, ['prompt', 'source_image_path', 'output_path_prefix'])) {
      throw new TypeError('CreateWorld3D 输入包含未知字段或不是对象。')
    }
    const prompt = cleanOptionalText(rawInput.prompt, 12_000)
    const prefix = normalizeBuildPrefix(rawInput.output_path_prefix, WORLD_OUTPUT_ROOT)
    let source: Awaited<ReturnType<typeof resolveAuthorizedRaster>> | undefined
    if (rawInput.source_image_path !== undefined) {
      if (typeof rawInput.source_image_path !== 'string' || !rawInput.source_image_path.trim()) {
        throw new TypeError('source_image_path 必须是非空 Workspace 图片路径。')
      }
      source = await resolveAuthorizedRaster(workspace, rawInput.source_image_path, dependencies)
    }
    if (!prompt && !source) {
      throw new TypeError('CreateWorld3D 至少需要 prompt 或 source_image_path。')
    }
    return await preparePaidBuild({
      context: durable.context,
      invocation: durable.invocation,
      kind: 'world',
      provider: 'aholo',
      modelSnapshot: 'world-v1',
      request: {
        output_path_prefix: prefix,
        ...(prompt ? { prompt } : {}),
        ...(source ? { source_image_path: source.path } : {}),
        provider_options: {
          ...(source
            ? { source_image_url: source.url, source_asset_id: source.assetId }
            : {}),
        },
      },
      dependencies,
    })
  } catch (error) {
    return failed('world', 'aholo', (error as Error).message, dependencies)
  }
}

export async function executeGetSpatialJob(
  rawInput: unknown,
  runtime: SpatialToolRuntime,
): Promise<ToolResult> {
  const dependencies = runtime.dependencies ?? defaultDependencies
  const durable = requireDurableContext(runtime, 'job', 'spatial', dependencies)
  if (isContextResult(durable)) return durable
  try {
    if (!isRecord(rawInput) || !onlyKeys(rawInput, ['job_id'])) {
      throw new TypeError('GetSpatialJob 输入包含未知字段或不是对象。')
    }
    const envelope = await dependencies.getSpatialJobResult({
      jobId: cleanId('job_id', rawInput.job_id),
      scope: scopeFor(durable.context),
    })
    return resultFromEnvelope(envelope)
  } catch (error) {
    return failed('job', 'spatial', (error as Error).message, dependencies)
  }
}

export async function executeWaitSpatialJob(
  rawInput: unknown,
  runtime: SpatialToolRuntime,
): Promise<ToolResult> {
  const dependencies = runtime.dependencies ?? defaultDependencies
  const durable = requireDurableContext(runtime, 'job', 'spatial', dependencies)
  if (isContextResult(durable)) return durable
  try {
    if (!isRecord(rawInput) || !onlyKeys(rawInput, ['job_id', 'timeout_ms'])) {
      throw new TypeError('WaitSpatialJob 输入包含未知字段或不是对象。')
    }
    let timeoutMs: number | undefined
    if (rawInput.timeout_ms !== undefined) {
      if (!Number.isInteger(rawInput.timeout_ms) || Number(rawInput.timeout_ms) < 1_000 || Number(rawInput.timeout_ms) > 120_000) {
        throw new TypeError('timeout_ms 必须是 1000–120000 的整数。')
      }
      timeoutMs = Number(rawInput.timeout_ms)
    }
    const envelope = await dependencies.waitSpatialJobResult({
      jobId: cleanId('job_id', rawInput.job_id),
      scope: scopeFor(durable.context),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      signal: runtime.signal,
    })
    return resultFromEnvelope(envelope)
  } catch (error) {
    return failed('job', 'spatial', (error as Error).message, dependencies)
  }
}

export async function executeInspectSpatialArtifact(
  rawInput: unknown,
  runtime: SpatialToolRuntime,
): Promise<ToolResult> {
  const dependencies = runtime.dependencies ?? defaultDependencies
  const durable = requireDurableContext(runtime, 'artifact', 'spatial', dependencies)
  if (isContextResult(durable)) return durable
  try {
    if (!isRecord(rawInput) || !onlyKeys(rawInput, ['artifact_id'])) {
      throw new TypeError('InspectSpatialArtifact 输入包含未知字段或不是对象。')
    }
    const envelope = await dependencies.inspectSpatialArtifactResult({
      artifactId: cleanId('artifact_id', rawInput.artifact_id),
      scope: scopeFor(durable.context),
    })
    return resultFromEnvelope(envelope)
  } catch (error) {
    return failed('artifact', 'spatial', (error as Error).message, dependencies)
  }
}

export async function executeSpatialTool(
  name: SpatialToolName,
  input: unknown,
  workspace: WorkspaceInstance,
  runtime: SpatialToolRuntime,
): Promise<ToolResult> {
  switch (name) {
    case 'CreateObject3D': return executeCreateObject3D(input, workspace, runtime)
    case 'CreateWorld3D': return executeCreateWorld3D(input, workspace, runtime)
    case 'GetSpatialJob': return executeGetSpatialJob(input, runtime)
    case 'WaitSpatialJob': return executeWaitSpatialJob(input, runtime)
    case 'InspectSpatialArtifact': return executeInspectSpatialArtifact(input, runtime)
  }
}
