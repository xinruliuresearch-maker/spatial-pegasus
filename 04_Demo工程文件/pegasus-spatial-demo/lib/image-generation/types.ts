import type { RasterAssetRef, ToolResult } from '../types'
import type {
  RegisterPublishedSpatialArtifactInput,
  SpatialArtifactNodeRecord,
  SpatialPaidSlotClaim,
} from '../spatial/types'

export const IMAGE_GENERATION_SUBMISSION_LEASE_MS = 6 * 60_000
export const IMAGE_GENERATION_RESERVATION_RECOVERY_MS = 60_000

/**
 * Aspect ratios remain a numeric `width:height` contract instead of a finite
 * product-level whitelist. The provider maps them to its closest valid pixel
 * dimensions and rejects only ratios outside the upstream model's hard range.
 */
export type ImageAspectRatio = string

export function normalizeImageAspectRatio(value: unknown): ImageAspectRatio | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > 32) return null
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(normalized)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null
  }
  return normalized
}

export interface ImageGenerationSource {
  assetId: string
  mimeType: string
  buffer: Buffer
}

export interface ImageGenerationRequest {
  prompt: string
  aspectRatio?: ImageAspectRatio
  source?: ImageGenerationSource
  signal?: AbortSignal
}

export interface ImageGenerationOutput {
  buffer: Buffer
  mimeType: string
  revisedPrompt?: string
  providerRequestId?: string
}

/**
 * Provider adapters return raster bytes only inside the server process. The
 * bytes are persisted immediately and never become part of ToolResult/SSE.
 */
export interface ImageGenerationProvider {
  readonly provider: string
  readonly model: string
  /**
   * Secret-free hash of the normalized transport configuration. Durable
   * callers freeze this into their request identity so a prepared receipt
   * cannot silently move to another gateway or protocol after restart.
   */
  readonly configurationFingerprint: string
  generate(input: ImageGenerationRequest): Promise<ImageGenerationOutput>
}

/**
 * Secret-free provider identity frozen before a paid submission. `provider`
 * is a versioned transport-contract id (for example
 * `newapi-images-v2`), so the snapshot does not need to retain a gateway
 * URL or any credential material.
 */
export interface ImageGenerationProviderSnapshot {
  provider: string
  model: string
  configurationFingerprint: string
}

export type ImageGenerationReceiptStatus =
  | 'prepared'
  | 'submitting'
  | 'asset_stored'
  | 'published'
  | 'failed'
  | 'unknown'

export interface ImageGenerationReceiptKey {
  projectId: string
  runId: string
  toolUseId: string
}

export interface ImageGenerationReceipt extends ImageGenerationReceiptKey {
  userId: string
  paidSlotHolderKey: string
  /** Legacy, provider-bound command identity retained for migration checks. */
  requestHash: string
  /** Provider-independent identity of prompt/output/source/aspect. */
  commandHash?: string
  inputHash: string
  status: ImageGenerationReceiptStatus
  provider: string
  model: string
  /** Missing only on receipts written before provider snapshot support. */
  providerSnapshot?: ImageGenerationProviderSnapshot
  outputPath: string
  sourcePath?: string
  parentAssetId?: string
  expectedOutputAssetId?: string
  asset?: RasterAssetRef
  assetSha256?: string
  resultContent?: string
  providerRequestId?: string
  submissionOwner?: string
  submissionStartedAt?: Date
  errorCode?: string
  errorMessage?: string
  createdAt: Date
  updatedAt: Date
}

export interface NewImageGenerationReceipt extends ImageGenerationReceiptKey {
  userId: string
  paidSlotHolderKey: string
  requestHash: string
  commandHash: string
  inputHash: string
  providerSnapshot: ImageGenerationProviderSnapshot
  outputPath: string
  sourcePath?: string
  parentAssetId?: string
  expectedOutputAssetId?: string
}

export interface ImageGenerationReceiptStore {
  get(key: ImageGenerationReceiptKey): Promise<ImageGenerationReceipt | null>
  createOrGet(input: NewImageGenerationReceipt): Promise<{
    receipt: ImageGenerationReceipt
    created: boolean
  }>
  claimSubmission(
    key: ImageGenerationReceiptKey,
    owner: string,
    now: Date,
    providerSnapshot: ImageGenerationProviderSnapshot,
  ): Promise<ImageGenerationReceipt | null>
  markAssetStored(
    key: ImageGenerationReceiptKey,
    owner: string,
    asset: RasterAssetRef,
    assetSha256: string,
    providerRequestId: string | undefined,
    now: Date,
  ): Promise<ImageGenerationReceipt>
  adoptClaimedAsset(
    receipt: ImageGenerationReceipt,
    expectedAssetId: string,
    asset: RasterAssetRef,
    assetSha256: string,
    now: Date,
  ): Promise<ImageGenerationReceipt>
  markPublished(
    key: ImageGenerationReceiptKey,
    asset: RasterAssetRef,
    resultContent: string,
    now: Date,
  ): Promise<ImageGenerationReceipt>
  markFailed(
    key: ImageGenerationReceiptKey,
    owner: string,
    code: string,
    message: string,
    now: Date,
  ): Promise<ImageGenerationReceipt>
  markUnknown(
    key: ImageGenerationReceiptKey,
    code: string,
    message: string,
    now: Date,
  ): Promise<ImageGenerationReceipt>
}

export interface StoredGeneratedImage {
  asset: RasterAssetRef
  sha256: string
}

export interface ImageGenerationHooks {
  /** Test-only crash window after paid capacity reservation, before receipt creation. */
  afterPaidSlotReserved?: () => void | Promise<void>
  /** Test-only crash window after receipt creation + slot bind, before provider submission claim. */
  afterPaidSlotBound?: () => void | Promise<void>
  /** Test-only crash window after submission claim, immediately before provider I/O. */
  afterSubmissionClaimed?: () => void | Promise<void>
  /** Test-only true-crash window after private staging, before receipt linkage. */
  afterAssetStagedBeforeReceipt?: () => void | Promise<void>
  /** Test-only crash window after durable asset receipt, before Workspace publication. */
  afterAssetStored?: () => void | Promise<void>
  /** Test-only crash window after Workspace publication, before published receipt. */
  afterWorkspacePublished?: () => void | Promise<void>
}

export interface GenerateImageDependencies {
  provider: ImageGenerationProvider
  receipts: ImageGenerationReceiptStore
  storeGeneratedImage(input: {
    ownerUserId: string
    output: ImageGenerationOutput
  }): Promise<StoredGeneratedImage>
  claimStoredImage(input: {
    ownerUserId: string
    conversationId: string
    asset: RasterAssetRef
    sha256: string
  }): Promise<StoredGeneratedImage>
  registerPublishedArtifact?(
    input: RegisterPublishedSpatialArtifactInput,
  ): Promise<SpatialArtifactNodeRecord>
  /** Optional Operator/test budget gate; normal product generation has no fixed project slot cap. */
  paidSlots?: {
    acquire(input: {
      projectId: string
      userId: string
      holderKey: string
    }): Promise<SpatialPaidSlotClaim>
    bind(claim: SpatialPaidSlotClaim): Promise<SpatialPaidSlotClaim>
    release(input: {
      projectId: string
      userId: string
      holderKey: string
      reservationToken?: string
    }): Promise<boolean>
  }
  now?: () => Date
  randomId?: () => string
  submissionLeaseMs?: number
  hooks?: ImageGenerationHooks
}

export function receiptToolResult(receipt: ImageGenerationReceipt): ToolResult | null {
  if (receipt.status !== 'published' || !receipt.asset || !receipt.resultContent) return null
  return {
    content: receipt.resultContent,
    media: [receipt.asset],
  }
}
