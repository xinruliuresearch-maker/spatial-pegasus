import { createHash, randomUUID } from 'node:crypto'
import type { AgentExecutionContext, ToolExecutionInvocation } from '../agent/execution-context'
import {
  boundedErrorMessage,
  ImageGenerationProviderError,
  ImageGenerationReceiptConflictError,
} from '../image-generation/errors'
import { createDefaultImageGenerationProvider } from '../image-generation/providers/newapi-chat-image'
import { mongoImageGenerationReceiptStore } from '../image-generation/receipt-store'
import {
  IMAGE_GENERATION_SUBMISSION_LEASE_MS,
  normalizeImageAspectRatio,
  receiptToolResult,
  type GenerateImageDependencies,
  type ImageAspectRatio,
  type ImageGenerationReceipt,
  type ImageGenerationReceiptKey,
  type ImageGenerationProvider,
  type ImageGenerationProviderSnapshot,
  type ImageGenerationSource,
} from '../image-generation/types'
import { toRasterAssetRef } from '../media/reference'
import { claimImageAsset, writeImageAsset } from '../media/storage'
import {
  registerPublishedSpatialArtifact,
  SpatialPaidCapacityError,
  type SpatialPaidSlotClaim,
} from '../spatial'
import type { ToolResult } from '../types'
import { assertWorkspaceWritePath, normalizeWorkspacePath } from '../workspace/path-policy'
import type { WorkspaceInstance } from '../workspace/types'

const IMAGE_OUTPUT_ROOT = 'output/spatial/images/'

export interface GenerateImageInput {
  prompt: string
  output_path: string
  input_image_path?: string
  aspect_ratio?: ImageAspectRatio
}

export interface GenerateImageToolRuntime {
  executionContext: AgentExecutionContext
  invocation: ToolExecutionInvocation
  signal?: AbortSignal
  /** Public publication target for an explicitly authorized Member. Source reads still use the scoped Workspace. */
  publicationWorkspace?: WorkspaceInstance
  /** Dependency injection for adapter and crash-window tests. */
  dependencies?: GenerateImageDependencies
  /** Trusted Operator seam; product calls default to `allow-submit`. */
  submissionPolicy?: 'allow-submit' | 'prepare-only' | 'forbid-submit'
}

export function createDefaultGenerateImageDependencies(): GenerateImageDependencies {
  return {
    provider: createDefaultImageGenerationProvider(),
    receipts: mongoImageGenerationReceiptStore,
    async storeGeneratedImage({ ownerUserId, output }) {
      const stored = await writeImageAsset({
        ownerUserId,
        buffer: output.buffer,
        mimeType: output.mimeType,
        source: 'tool_output',
      })
      return { asset: toRasterAssetRef(stored), sha256: stored.sha256 }
    },
    async claimStoredImage({ ownerUserId, conversationId, asset, sha256 }) {
      const claimed = await claimImageAsset(asset.assetId, ownerUserId, conversationId)
      if (!claimed || claimed.sha256 !== sha256) {
        throw new ImageGenerationReceiptConflictError(
          `无法认领已持久化的 GenerateImage 资产：${asset.assetId}`,
        )
      }
      return { asset: toRasterAssetRef(claimed), sha256: claimed.sha256 }
    },
    registerPublishedArtifact: registerPublishedSpatialArtifact,
    // Product GenerateImage calls are not globally throttled. Durable receipt
    // identity still prevents duplicate submission; tests and Operator smoke
    // may inject a paidSlots coordinator when an explicit budget gate is needed.
  }
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function commandHash(input: GenerateImageInput): string {
  return stableHash({
    prompt: input.prompt,
    outputPath: input.output_path,
    sourcePath: input.input_image_path || null,
    aspectRatio: input.aspect_ratio || null,
  })
}

/** Reproduces the request identity written by pre-snapshot receipts. */
function legacyRequestHash(
  input: GenerateImageInput,
  provider: Pick<ImageGenerationProviderSnapshot, 'provider' | 'model'>,
): string {
  return stableHash({
    prompt: input.prompt,
    outputPath: input.output_path,
    sourcePath: input.input_image_path || null,
    aspectRatio: input.aspect_ratio || null,
    provider: provider.provider,
    model: provider.model,
  })
}

function submissionProviderSnapshot(
  provider: ImageGenerationProvider,
): ImageGenerationProviderSnapshot {
  const providerId = provider.provider.trim()
  const model = provider.model.trim()
  const configurationFingerprint = provider.configurationFingerprint.trim()
  if (!providerId || !model) {
    throw new Error('图片供应商缺少 provider/model 稳定标识。')
  }
  if (!/^[a-f0-9]{64}$/.test(configurationFingerprint)) {
    throw new Error('图片供应商 configurationFingerprint 必须是小写 SHA-256；禁止持久化地址或密钥明文。')
  }
  return { provider: providerId, model, configurationFingerprint }
}

function sameProviderSnapshot(
  left: ImageGenerationProviderSnapshot | undefined,
  right: ImageGenerationProviderSnapshot,
): boolean {
  return !!left
    && left.provider === right.provider
    && left.model === right.model
    && left.configurationFingerprint === right.configurationFingerprint
}

function receiptMatchesCommand(
  receipt: ImageGenerationReceipt,
  input: GenerateImageInput,
  currentCommandHash: string,
): boolean {
  if (receipt.commandHash) return receipt.commandHash === currentCommandHash
  return receipt.requestHash === legacyRequestHash(input, receipt)
}

function receiptInputHash(
  receipt: Pick<ImageGenerationReceipt, 'commandHash' | 'requestHash'>,
  parentAssetId: string | null,
  expectedOutputAssetId: string | null,
): string {
  return receipt.commandHash
    ? stableHash({
        commandHash: receipt.commandHash,
        parentAssetId,
        expectedOutputAssetId,
      })
    : stableHash({
        requestHash: receipt.requestHash,
        parentAssetId,
        expectedOutputAssetId,
      })
}

export function imageGenerationJobId(receipt: Pick<ImageGenerationReceipt, 'projectId' | 'runId' | 'toolUseId'>): string {
  return `spimg_${stableHash({
    projectId: receipt.projectId,
    runId: receipt.runId,
    toolUseId: receipt.toolUseId,
  }).slice(0, 24)}`
}

async function releasePaidSlot(
  receipt: Pick<ImageGenerationReceipt, 'projectId' | 'userId' | 'paidSlotHolderKey'>,
  dependencies: GenerateImageDependencies,
  claim?: SpatialPaidSlotClaim,
): Promise<void> {
  if (!dependencies.paidSlots) return
  try {
    await dependencies.paidSlots.release({
      projectId: receipt.projectId,
      userId: receipt.userId,
      holderKey: receipt.paidSlotHolderKey,
      ...(claim ? { reservationToken: claim.reservationToken } : {}),
    })
  } catch {
    // Publication/result durability wins. The periodic reconciler will remove
    // a stale terminal holder after a transient slot-release failure.
  }
}

function imageEnvelope(
  receipt: ImageGenerationReceipt,
  status: 'published' | 'failed' | 'unknown',
  message: string,
): string {
  return JSON.stringify({
    schema_version: 1,
    job_id: imageGenerationJobId(receipt),
    ...(receipt.asset?.assetId ? { artifact_id: receipt.asset.assetId } : {}),
    kind: 'image',
    status,
    provider: receipt.provider,
    ...(status === 'published' ? { workspace_paths: [receipt.outputPath] } : {}),
    message,
    ...(receipt.parentAssetId
      ? { relations: [{ kind: 'revision_of', artifact_id: receipt.parentAssetId }] }
      : {}),
    ...(receipt.asset
      ? {
          metadata: {
            model: receipt.model,
            width: receipt.asset.width,
            height: receipt.asset.height,
          },
        }
      : {}),
    created_at: receipt.createdAt.toISOString(),
    updated_at: receipt.updatedAt.toISOString(),
    elapsed_ms: Math.max(0, receipt.updatedAt.getTime() - receipt.createdAt.getTime()),
    ...(
      status === 'failed' || status === 'unknown'
        ? { error: receipt.errorMessage || message }
        : {}
    ),
  })
}

function preparedImageResult(receipt: ImageGenerationReceipt, message: string): ToolResult {
  return {
    content: JSON.stringify({
      schema_version: 1,
      job_id: imageGenerationJobId(receipt),
      kind: 'image',
      status: 'prepared',
      provider: receipt.provider,
      message,
      created_at: receipt.createdAt.toISOString(),
      updated_at: receipt.updatedAt.toISOString(),
      elapsed_ms: Math.max(0, receipt.updatedAt.getTime() - receipt.createdAt.getTime()),
    }),
  }
}

function invalid(content: string): ToolResult {
  const now = new Date()
  return {
    content: JSON.stringify({
      schema_version: 1,
      kind: 'image',
      status: 'failed',
      provider: 'image',
      error: content,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      elapsed_ms: 0,
    }),
    is_error: true,
  }
}

function parseInput(rawInput: unknown, workspace: WorkspaceInstance): GenerateImageInput | ToolResult {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return invalid('GenerateImage 输入必须是对象。')
  }
  const input = rawInput as Partial<GenerateImageInput>
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
    return invalid('GenerateImage 需要非空 prompt。')
  }
  if (input.prompt.trim().length > 20_000) {
    return invalid('GenerateImage prompt 不能超过 20000 个字符。')
  }
  if (typeof input.output_path !== 'string' || !input.output_path.trim()) {
    return invalid('GenerateImage 需要 output_path。')
  }
  if (
    input.input_image_path !== undefined
    && (typeof input.input_image_path !== 'string' || !input.input_image_path.trim())
  ) {
    return invalid('input_image_path 必须是非空 Workspace 路径。')
  }
  const aspectRatio = input.aspect_ratio === undefined
    ? undefined
    : normalizeImageAspectRatio(input.aspect_ratio) ?? undefined
  if (input.aspect_ratio !== undefined && !aspectRatio) {
    return invalid('aspect_ratio 必须是正数“宽:高”，例如 2:1、16:9 或 2.39:1。')
  }

  let outputPath: string
  try {
    outputPath = assertWorkspaceWritePath(input.output_path.trim(), workspace.definition.policy)
  } catch (error) {
    return invalid(`无效的 GenerateImage 输出路径：${boundedErrorMessage(error)}`)
  }
  if (!outputPath.startsWith(IMAGE_OUTPUT_ROOT)) {
    return invalid(`GenerateImage 输出必须位于 ${IMAGE_OUTPUT_ROOT}`)
  }
  if (!/\.(?:png|jpe?g|webp)$/i.test(outputPath)) {
    return invalid('GenerateImage output_path 必须使用 .png、.jpg、.jpeg 或 .webp。')
  }

  let sourcePath: string | undefined
  if (input.input_image_path) {
    try {
      sourcePath = normalizeWorkspacePath(input.input_image_path.trim())
    } catch (error) {
      return invalid(`无效的 input_image_path：${boundedErrorMessage(error)}`)
    }
  }

  return {
    prompt: input.prompt.trim(),
    output_path: outputPath,
    input_image_path: sourcePath,
    aspect_ratio: aspectRatio,
  }
}

function isToolResult(value: GenerateImageInput | ToolResult): value is ToolResult {
  return !('prompt' in value)
}

async function resolveSource(
  workspace: WorkspaceInstance,
  sourcePath: string | undefined,
): Promise<ImageGenerationSource | undefined> {
  if (!sourcePath) return undefined
  const asset = await workspace.readRaster(sourcePath)
  if (!asset) throw new Error(`Workspace 中不存在可用的源图片：${sourcePath}`)
  // Match the proven Pegasus edit path: send the bounded model variant rather
  // than an unbounded camera original. The source is still resolved from the
  // authorized Workspace path and never accepts a caller-supplied remote URL.
  const buffer = await workspace.readRasterBuffer(sourcePath, 'model')
  if (!buffer) throw new Error(`无法读取源图片字节：${sourcePath}`)
  const stillCurrent = await workspace.readRaster(sourcePath)
  if (!stillCurrent || stillCurrent.assetId !== asset.assetId) {
    throw new Error(`读取期间源图片发生变化，请重新提交：${sourcePath}`)
  }
  return {
    assetId: asset.assetId,
    mimeType: asset.mimeType,
    buffer,
  }
}

function statusResult(receipt: ImageGenerationReceipt): ToolResult | null {
  const published = receiptToolResult(receipt)
  if (published) return published
  if (receipt.status === 'failed') {
    const detail = boundedErrorMessage(receipt.errorMessage || '供应商返回失败。')
    const message = `图片生成未完成（${receipt.errorCode || 'failed'}）：${detail}`
    return { content: imageEnvelope(receipt, 'failed', message), is_error: true }
  }
  if (receipt.status === 'unknown') {
    const detail = boundedErrorMessage(
      receipt.errorMessage || '供应商可能已接受请求，系统不会自动重复付费提交。',
    )
    const message = `图片生成结果状态未知（${receipt.errorCode || 'unknown'}）：${detail}`
    return { content: imageEnvelope(receipt, 'unknown', message), is_error: true }
  }
  return null
}

function successContent(receipt: ImageGenerationReceipt): string {
  const asset = receipt.asset!
  const message = [
    '图片已生成并发布。',
    `路径：${receipt.outputPath}`,
    `资产：${asset.assetId}`,
    `供应商：${receipt.provider} / ${receipt.model}`,
    receipt.parentAssetId
      ? `来源：基于资产 ${receipt.parentAssetId} 编辑生成。`
      : '来源：文生图。',
  ].join('\n')
  return imageEnvelope(receipt, 'published', message)
}

async function registerImageArtifact(
  receipt: ImageGenerationReceipt,
  dependencies: GenerateImageDependencies,
): Promise<void> {
  if (!dependencies.registerPublishedArtifact) return
  if (!receipt.asset || !receipt.assetSha256) {
    throw new ImageGenerationReceiptConflictError(
      'asset_stored receipt 缺少统一空间资产登记所需的 asset/sha256',
    )
  }
  const artifact = receipt.asset
  await dependencies.registerPublishedArtifact({
    artifactId: artifact.assetId,
    jobId: imageGenerationJobId(receipt),
    projectId: receipt.projectId,
    userId: receipt.userId,
    provider: receipt.provider,
    publicationToken: `spimgpub_${stableHash({
      jobId: imageGenerationJobId(receipt),
      assetId: artifact.assetId,
    }).slice(0, 32)}`,
    providerAssetKey: artifact.assetId,
    kind: 'image',
    filename: receipt.outputPath.split('/').at(-1) || `${artifact.assetId}.png`,
    workspacePath: receipt.outputPath,
    storageUri: `asset:${artifact.assetId}`,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    sha256: receipt.assetSha256,
    relations: receipt.parentAssetId
      ? [{ kind: 'revision_of', artifact_id: receipt.parentAssetId }]
      : [],
    metadata: {
      model: receipt.model,
      width: artifact.width,
      height: artifact.height,
      ...(receipt.sourcePath ? { source_path: receipt.sourcePath } : {}),
      ...(receipt.providerRequestId ? { provider_request_id: receipt.providerRequestId } : {}),
    },
  })
}

async function publishStoredAsset(
  receipt: ImageGenerationReceipt,
  workspace: WorkspaceInstance,
  dependencies: GenerateImageDependencies,
  conversationId: string,
): Promise<ToolResult> {
  if (!receipt.asset) {
    throw new ImageGenerationReceiptConflictError('asset_stored receipt 缺少资产引用')
  }

  // Provider bytes are first persisted as a private staged asset. Only after
  // the durable receipt points at those bytes do we claim the capability into
  // this conversation. A crash before this point therefore leaves no active,
  // user-visible orphan; recovery resumes from the receipt without another
  // paid provider call.
  const claimed = await dependencies.claimStoredImage({
    ownerUserId: receipt.userId,
    conversationId,
    asset: receipt.asset,
    sha256: receipt.assetSha256 || '',
  })
  let publishReceipt = receipt
  if (
    claimed.asset.assetId !== receipt.asset.assetId
    || claimed.sha256 !== receipt.assetSha256
  ) {
    publishReceipt = await dependencies.receipts.adoptClaimedAsset(
      receipt,
      receipt.asset.assetId,
      claimed.asset,
      claimed.sha256,
      (dependencies.now ?? (() => new Date()))(),
    )
  } else {
    publishReceipt = { ...receipt, asset: claimed.asset, assetSha256: claimed.sha256 }
  }

  const currentStat = await workspace.stat(publishReceipt.outputPath)
  const currentRaster = currentStat ? await workspace.readRaster(publishReceipt.outputPath) : null
  if (currentStat && !currentRaster) {
    throw new ImageGenerationReceiptConflictError(
      `输出路径已被非图片文件占用：${publishReceipt.outputPath}`,
    )
  }
  if (currentRaster?.assetId !== publishReceipt.asset!.assetId) {
    if (publishReceipt.expectedOutputAssetId) {
      if (currentRaster?.assetId !== publishReceipt.expectedOutputAssetId) {
        throw new ImageGenerationReceiptConflictError(
          `输出路径在生成期间发生变化，拒绝覆盖：${publishReceipt.outputPath}`,
        )
      }
    } else if (currentRaster) {
      throw new ImageGenerationReceiptConflictError(
        `输出路径在生成期间被创建，拒绝覆盖：${publishReceipt.outputPath}`,
      )
    }
    await workspace.writeRaster(
      publishReceipt.outputPath,
      publishReceipt.asset!,
      'GenerateImage published raster',
      { archive: true },
    )
  }

  await dependencies.hooks?.afterWorkspacePublished?.()
  await registerImageArtifact(publishReceipt, dependencies)
  const publishedAt = (dependencies.now ?? (() => new Date()))()
  const content = successContent({ ...publishReceipt, updatedAt: publishedAt })
  const published = await dependencies.receipts.markPublished(
    publishReceipt,
    publishReceipt.asset!,
    content,
    publishedAt,
  )
  await releasePaidSlot(published, dependencies)
  return receiptToolResult(published) || { content, media: [publishReceipt.asset!] }
}

async function recoverExistingReceipt(
  receipt: ImageGenerationReceipt,
  workspace: WorkspaceInstance,
  dependencies: GenerateImageDependencies,
  conversationId: string,
): Promise<ToolResult | null> {
  const terminal = statusResult(receipt)
  if (terminal) {
    await releasePaidSlot(receipt, dependencies)
    return terminal
  }
  if (receipt.status === 'asset_stored') {
    try {
      return await publishStoredAsset(receipt, workspace, dependencies, conversationId)
    } catch (error) {
      return invalid(`已保存图片资产，但 Workspace 发布尚未完成：${boundedErrorMessage(error)}`)
    }
  }
  if (receipt.status === 'submitting') {
    const now = (dependencies.now ?? (() => new Date()))()
    const startedAt = receipt.submissionStartedAt?.getTime() ?? receipt.updatedAt.getTime()
    const leaseMs = dependencies.submissionLeaseMs ?? IMAGE_GENERATION_SUBMISSION_LEASE_MS
    if (now.getTime() - startedAt < leaseMs) {
      return invalid('相同的图片生成请求仍在执行；系统不会并发重复提交。')
    }
    const unknown = await dependencies.receipts.markUnknown(
      receipt,
      'submission_lease_expired',
      '上一次提交在持久 receipt 中停留于 submitting；供应商可能已接受请求，禁止自动重复付费提交。',
      now,
    )
    await releasePaidSlot(unknown, dependencies)
    return statusResult(unknown)
  }
  return null
}

/**
 * Sci-native GenerateImage tool. A durable invocation is mandatory: recovery
 * is keyed by project/workspace + runId + toolUseId before any provider call.
 */
export async function executeGenerateImage(
  rawInput: unknown,
  workspace: WorkspaceInstance,
  runtime: GenerateImageToolRuntime,
): Promise<ToolResult> {
  if (!runtime?.executionContext || !runtime.invocation) {
    return invalid('GenerateImage 需要持久化的 Agent 执行上下文。')
  }
  const parsed = parseInput(rawInput, workspace)
  if (isToolResult(parsed)) return parsed
  const dependencies = runtime.dependencies ?? createDefaultGenerateImageDependencies()
  const submissionPolicy = runtime.submissionPolicy ?? 'allow-submit'
  const context = runtime.executionContext
  const publicationWorkspace = runtime.publicationWorkspace ?? workspace
  const projectId = context.workspaceId || context.conversationId
  const key: ImageGenerationReceiptKey = {
    projectId,
    runId: context.runId,
    toolUseId: runtime.invocation.toolUseId,
  }
  const currentCommandHash = commandHash(parsed)
  const paidSlotHolderKey = imageGenerationJobId(key)
  let paidSlot: SpatialPaidSlotClaim | undefined
  let submissionClaimed = false
  let providerSnapshot: ImageGenerationProviderSnapshot | undefined

  const getProviderSnapshot = (): ImageGenerationProviderSnapshot => {
    providerSnapshot ??= submissionProviderSnapshot(dependencies.provider)
    return providerSnapshot
  }

  try {
    const existing = await dependencies.receipts.get(key)
    if (existing) {
      if (!receiptMatchesCommand(existing, parsed, currentCommandHash)) {
        return invalid('同一 tool_use_id 已绑定到不同的 GenerateImage 输入，拒绝覆盖 durable receipt。')
      }
      if (existing.status === 'prepared') {
        if (!existing.commandHash || !existing.providerSnapshot) {
          return invalid(
            '该 prepared receipt 来自旧版且没有供应商协议快照；为避免切换协议后重复付费，系统拒绝自动提交，请发起新的生成请求。',
          )
        }
        if (!sameProviderSnapshot(existing.providerSnapshot, getProviderSnapshot())) {
          return invalid(
            '该 prepared receipt 冻结的图片供应商协议或配置已变化；系统不会换协议提交，请发起新的生成请求。',
          )
        }
      }
      const recovered = await recoverExistingReceipt(
        existing,
        publicationWorkspace,
        dependencies,
        context.conversationId,
      )
      if (recovered) return recovered
      if (existing.status === 'prepared' && submissionPolicy !== 'allow-submit') {
        return preparedImageResult(
          existing,
          submissionPolicy === 'prepare-only'
            ? 'Operator smoke receipt 已准备；未调用图片供应商。'
            : '该 receipt 仍为 prepared；当前操作禁止进入供应商提交。',
        )
      }
    }

    if (!existing && submissionPolicy === 'forbid-submit') {
      return invalid('当前操作禁止创建并提交新的 GenerateImage receipt。')
    }

    if (runtime.signal?.aborted) return invalid('图片生成已在提交供应商前取消。')

    const source = await resolveSource(workspace, parsed.input_image_path)
    const outputStat = await publicationWorkspace.stat(parsed.output_path)
    const outputHead = outputStat ? await publicationWorkspace.readRaster(parsed.output_path) : null
    if (outputStat && !outputHead) {
      return invalid(`GenerateImage 输出路径已被非图片文件占用：${parsed.output_path}`)
    }
    const currentProviderSnapshot = getProviderSnapshot()
    // Retain the former provider-bound hash only so legacy receipts can be
    // compared exactly during migration. New command identity is commandHash.
    const requestHash = legacyRequestHash(parsed, currentProviderSnapshot)
    const inputHash = stableHash({
      commandHash: currentCommandHash,
      parentAssetId: source?.assetId || null,
      expectedOutputAssetId: outputHead?.assetId || null,
    })
    if (dependencies.paidSlots) {
      try {
        paidSlot = await dependencies.paidSlots.acquire({
          projectId,
          userId: context.userId,
          holderKey: paidSlotHolderKey,
        })
      } catch (error) {
        if (error instanceof SpatialPaidCapacityError) {
          return invalid('当前项目已有 2 个图片生成任务在运行；图片生成最多允许同时运行 2 个。后台 3D 任务使用独立并发额度。')
        }
        throw error
      }
      await dependencies.hooks?.afterPaidSlotReserved?.()
    }
    const created = await dependencies.receipts.createOrGet({
      ...key,
      userId: context.userId,
      paidSlotHolderKey,
      requestHash,
      commandHash: currentCommandHash,
      inputHash,
      providerSnapshot: currentProviderSnapshot,
      outputPath: parsed.output_path,
      sourcePath: parsed.input_image_path,
      parentAssetId: source?.assetId,
      expectedOutputAssetId: outputHead?.assetId,
    })
    const createdCommandMatches = receiptMatchesCommand(
      created.receipt,
      parsed,
      currentCommandHash,
    )
    const expectedReceiptInputHash = receiptInputHash(
      created.receipt,
      source?.assetId || null,
      outputHead?.assetId || null,
    )
    if (!createdCommandMatches || created.receipt.inputHash !== expectedReceiptInputHash) {
      if (paidSlot?.state === 'reserved' && dependencies.paidSlots) {
        await dependencies.paidSlots.release({
          projectId,
          userId: context.userId,
          holderKey: paidSlotHolderKey,
          reservationToken: paidSlot.reservationToken,
        })
        paidSlot = undefined
      }
      return invalid('GenerateImage durable receipt 与当前输入不一致。')
    }
    if (
      created.receipt.userId !== context.userId
      || created.receipt.paidSlotHolderKey !== paidSlotHolderKey
    ) {
      if (paidSlot?.state === 'reserved' && dependencies.paidSlots) {
        await dependencies.paidSlots.release({
          projectId,
          userId: context.userId,
          holderKey: paidSlotHolderKey,
          reservationToken: paidSlot.reservationToken,
        })
        paidSlot = undefined
      }
      return invalid('GenerateImage durable receipt 与当前项目容量身份不一致。')
    }
    if (created.receipt.status === 'prepared') {
      if (
        !created.receipt.commandHash
        || !sameProviderSnapshot(created.receipt.providerSnapshot, currentProviderSnapshot)
      ) {
        if (paidSlot?.state === 'reserved' && dependencies.paidSlots) {
          await dependencies.paidSlots.release({
            projectId,
            userId: context.userId,
            holderKey: paidSlotHolderKey,
            reservationToken: paidSlot.reservationToken,
          })
          paidSlot = undefined
        }
        return invalid(
          created.receipt.commandHash
            ? 'GenerateImage prepared receipt 的供应商协议快照不匹配；拒绝换协议提交。'
            : 'GenerateImage 旧版 prepared receipt 没有供应商协议快照；拒绝自动提交。',
        )
      }
    }
    if (!created.created) {
      const recovered = await recoverExistingReceipt(
        created.receipt,
        workspace,
        dependencies,
        context.conversationId,
      )
      if (recovered) return recovered
    }
    if (paidSlot && dependencies.paidSlots) {
      paidSlot = await dependencies.paidSlots.bind(paidSlot)
      await dependencies.hooks?.afterPaidSlotBound?.()
    }

    if (submissionPolicy !== 'allow-submit') {
      await releasePaidSlot(created.receipt, dependencies, paidSlot)
      paidSlot = undefined
      return preparedImageResult(
        created.receipt,
        submissionPolicy === 'prepare-only'
          ? 'Operator smoke receipt 已准备；未调用图片供应商。'
          : '该 receipt 仍为 prepared；当前操作禁止进入供应商提交。',
      )
    }

    if (runtime.signal?.aborted) {
      await releasePaidSlot(created.receipt, dependencies, paidSlot)
      return invalid('图片生成已在提交供应商前取消。')
    }
    const owner = `${runtime.invocation.actionId}:${(dependencies.randomId ?? randomUUID)()}`
    const claimed = await dependencies.receipts.claimSubmission(
      key,
      owner,
      (dependencies.now ?? (() => new Date()))(),
      currentProviderSnapshot,
    )
    if (!claimed) {
      const current = await dependencies.receipts.get(key)
      if (!current) {
        await releasePaidSlot(created.receipt, dependencies, paidSlot)
        return invalid('GenerateImage durable receipt 在提交前丢失。')
      }
      return (await recoverExistingReceipt(
        current,
        workspace,
        dependencies,
        context.conversationId,
      ))
        || invalid(`GenerateImage receipt 当前状态不可提交：${current.status}`)
    }
    submissionClaimed = true

    await dependencies.hooks?.afterSubmissionClaimed?.()
    let output
    try {
      output = await dependencies.provider.generate({
        prompt: parsed.prompt,
        aspectRatio: parsed.aspect_ratio,
        source,
        signal: runtime.signal,
      })
    } catch (error) {
      const message = boundedErrorMessage(error)
      if (error instanceof ImageGenerationProviderError && !error.requestMayHaveBeenAccepted) {
        const failed = await dependencies.receipts.markFailed(
          key,
          owner,
          error.code,
          message,
          (dependencies.now ?? (() => new Date()))(),
        )
        await releasePaidSlot(failed, dependencies)
        return statusResult(failed) || invalid(message)
      }
      const unknown = await dependencies.receipts.markUnknown(
        key,
        error instanceof ImageGenerationProviderError ? error.code : 'provider_result_unknown',
        `${message}；供应商可能已接受请求，系统不会自动重复提交。`,
        (dependencies.now ?? (() => new Date()))(),
      )
      await releasePaidSlot(unknown, dependencies)
      return statusResult(unknown) || invalid(message)
    }

    let stored
    try {
      stored = await dependencies.storeGeneratedImage({
        ownerUserId: context.userId,
        output,
      })
    } catch (error) {
      const message = `供应商已返回图片，但资产持久化失败：${boundedErrorMessage(error)}`
      const unknown = await dependencies.receipts.markUnknown(
        key,
        'asset_persistence_failed',
        `${message}；禁止自动重新付费生成。`,
        (dependencies.now ?? (() => new Date()))(),
      )
      await releasePaidSlot(unknown, dependencies)
      return statusResult(unknown) || invalid(message)
    }

    await dependencies.hooks?.afterAssetStagedBeforeReceipt?.()

    const assetStored = await dependencies.receipts.markAssetStored(
      key,
      owner,
      stored.asset,
      stored.sha256,
      output.providerRequestId,
      (dependencies.now ?? (() => new Date()))(),
    )
    // The external paid operation has completed. Remaining Workspace/artifact
    // publication is locally recoverable and must not leak scarce capacity if
    // this process dies in the following crash window.
    await releasePaidSlot(assetStored, dependencies)
    await dependencies.hooks?.afterAssetStored?.()
    return await publishStoredAsset(
      assetStored,
      publicationWorkspace,
      dependencies,
      context.conversationId,
    )
  } catch (error) {
    if (paidSlot && !submissionClaimed && dependencies.paidSlots) {
      try {
        await dependencies.paidSlots.release({
          projectId,
          userId: context.userId,
          holderKey: paidSlotHolderKey,
          reservationToken: paidSlot.reservationToken,
        })
      } catch {
        // An expired reservation is also removed by startup reconciliation.
      }
    }
    return invalid(`GenerateImage 执行失败：${boundedErrorMessage(error)}`)
  }
}
