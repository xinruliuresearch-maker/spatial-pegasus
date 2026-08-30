import mongoose, { Schema, type Model } from 'mongoose'
import { connectDB } from '../db/mongodb'
import { boundedErrorMessage, ImageGenerationReceiptConflictError } from './errors'
import { reconcileSpatialPaidSlots } from '../spatial/paid-slots'
import {
  IMAGE_GENERATION_RESERVATION_RECOVERY_MS,
  IMAGE_GENERATION_SUBMISSION_LEASE_MS,
  type ImageGenerationReceipt,
  type ImageGenerationReceiptKey,
  type ImageGenerationProviderSnapshot,
  type ImageGenerationReceiptStore,
  type NewImageGenerationReceipt,
} from './types'
import type { RasterAssetRef } from '../types'

interface ImageGenerationReceiptDocument {
  project_id: string
  user_id: string
  run_id: string
  tool_use_id: string
  paid_slot_holder_key: string
  request_hash: string
  command_hash?: string
  input_hash: string
  status: ImageGenerationReceipt['status']
  provider: string
  model: string
  provider_configuration_fingerprint?: string
  output_path: string
  source_path?: string
  parent_asset_id?: string
  expected_output_asset_id?: string
  asset?: RasterAssetRef
  asset_sha256?: string
  result_content?: string
  provider_request_id?: string
  submission_owner?: string
  submission_started_at?: Date
  error_code?: string
  error_message?: string
  created_at: Date
  updated_at: Date
}

const ReceiptSchema = new Schema<ImageGenerationReceiptDocument>({
  project_id: { type: String, required: true },
  user_id: { type: String, required: true },
  run_id: { type: String, required: true },
  tool_use_id: { type: String, required: true },
  paid_slot_holder_key: { type: String, required: true },
  request_hash: { type: String, required: true },
  command_hash: String,
  input_hash: { type: String, required: true },
  status: {
    type: String,
    required: true,
    enum: ['prepared', 'submitting', 'asset_stored', 'published', 'failed', 'unknown'],
  },
  provider: { type: String, required: true },
  model: { type: String, required: true },
  // `provider` is itself the versioned transport-contract id. Only this
  // SHA-256 fingerprint is persisted; API base URLs and keys are never stored.
  provider_configuration_fingerprint: String,
  output_path: { type: String, required: true },
  source_path: String,
  parent_asset_id: String,
  expected_output_asset_id: String,
  asset: Schema.Types.Mixed,
  asset_sha256: String,
  result_content: String,
  provider_request_id: String,
  submission_owner: String,
  submission_started_at: Date,
  error_code: String,
  error_message: String,
  created_at: { type: Date, required: true, default: Date.now },
  updated_at: { type: Date, required: true, default: Date.now },
}, {
  collection: 'spatial_image_generation_receipts',
  versionKey: false,
})

ReceiptSchema.index(
  { project_id: 1, run_id: 1, tool_use_id: 1 },
  { unique: true, name: 'image_generation_tool_command' },
)
ReceiptSchema.index({ status: 1, updated_at: 1 })
ReceiptSchema.index(
  { project_id: 1, user_id: 1, paid_slot_holder_key: 1 },
  {
    unique: true,
    name: 'image_generation_paid_slot_holder',
    partialFilterExpression: {
      user_id: { $type: 'string' },
      paid_slot_holder_key: { $type: 'string' },
    },
  },
)

/**
 * Durable model export used by the Node bootstrap to reconcile indexes before
 * image commands are accepted. Keeping the model identity stable also avoids
 * Next.js development reloads compiling the schema more than once.
 */
export const ImageGenerationReceiptModel = (mongoose.models.SpatialImageGenerationReceipt
    || mongoose.model<ImageGenerationReceiptDocument>(
      'SpatialImageGenerationReceipt',
      ReceiptSchema,
    )) as Model<ImageGenerationReceiptDocument>

function filter(key: ImageGenerationReceiptKey): Record<string, string> {
  return {
    project_id: key.projectId,
    run_id: key.runId,
    tool_use_id: key.toolUseId,
  }
}

function cloneAsset(asset: RasterAssetRef | undefined): RasterAssetRef | undefined {
  if (!asset) return undefined
  return {
    ...asset,
    urls: { ...asset.urls },
  }
}

function fromDocument(doc: ImageGenerationReceiptDocument): ImageGenerationReceipt {
  const providerSnapshot: ImageGenerationProviderSnapshot | undefined =
    typeof doc.provider_configuration_fingerprint === 'string'
      && doc.provider_configuration_fingerprint.length > 0
      ? {
          provider: doc.provider,
          model: doc.model,
          configurationFingerprint: doc.provider_configuration_fingerprint,
        }
      : undefined
  return {
    projectId: doc.project_id,
    userId: doc.user_id,
    runId: doc.run_id,
    toolUseId: doc.tool_use_id,
    paidSlotHolderKey: doc.paid_slot_holder_key,
    requestHash: doc.request_hash,
    commandHash: doc.command_hash,
    inputHash: doc.input_hash,
    status: doc.status,
    provider: doc.provider,
    model: doc.model,
    providerSnapshot,
    outputPath: doc.output_path,
    sourcePath: doc.source_path,
    parentAssetId: doc.parent_asset_id,
    expectedOutputAssetId: doc.expected_output_asset_id,
    asset: cloneAsset(doc.asset),
    assetSha256: doc.asset_sha256,
    resultContent: doc.result_content,
    providerRequestId: doc.provider_request_id,
    submissionOwner: doc.submission_owner,
    submissionStartedAt: doc.submission_started_at,
    errorCode: doc.error_code,
    errorMessage: doc.error_message,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  }
}

async function currentOrConflict(
  key: ImageGenerationReceiptKey,
  expected: string,
): Promise<ImageGenerationReceipt> {
  const current = await mongoImageGenerationReceiptStore.get(key)
  if (!current) throw new ImageGenerationReceiptConflictError('Image generation receipt disappeared')
  throw new ImageGenerationReceiptConflictError(
    `Image generation receipt transition conflict: expected ${expected}, found ${current.status}`,
  )
}

export const mongoImageGenerationReceiptStore: ImageGenerationReceiptStore = {
  async get(key) {
    await connectDB()
    const doc = await ImageGenerationReceiptModel.findOne(filter(key)).lean<ImageGenerationReceiptDocument>()
    return doc ? fromDocument(doc) : null
  },

  async createOrGet(input) {
    await connectDB()
    const now = new Date()
    try {
      const created = await ImageGenerationReceiptModel.create({
        project_id: input.projectId,
        user_id: input.userId,
        run_id: input.runId,
        tool_use_id: input.toolUseId,
        paid_slot_holder_key: input.paidSlotHolderKey,
        request_hash: input.requestHash,
        command_hash: input.commandHash,
        input_hash: input.inputHash,
        status: 'prepared',
        provider: input.providerSnapshot.provider,
        model: input.providerSnapshot.model,
        provider_configuration_fingerprint:
          input.providerSnapshot.configurationFingerprint,
        output_path: input.outputPath,
        source_path: input.sourcePath,
        parent_asset_id: input.parentAssetId,
        expected_output_asset_id: input.expectedOutputAssetId,
        created_at: now,
        updated_at: now,
      })
      return { receipt: fromDocument(created.toObject()), created: true }
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error
      const existing = await mongoImageGenerationReceiptStore.get(input)
      if (!existing) throw error
      return { receipt: existing, created: false }
    }
  },

  async claimSubmission(key, owner, now, providerSnapshot) {
    await connectDB()
    const doc = await ImageGenerationReceiptModel.findOneAndUpdate(
      {
        ...filter(key),
        status: 'prepared',
        provider: providerSnapshot.provider,
        model: providerSnapshot.model,
        provider_configuration_fingerprint:
          providerSnapshot.configurationFingerprint,
      },
      {
        $set: {
          status: 'submitting',
          submission_owner: owner,
          submission_started_at: now,
          updated_at: now,
        },
      },
      { returnDocument: 'after' },
    ).lean<ImageGenerationReceiptDocument>()
    return doc ? fromDocument(doc) : null
  },

  async markAssetStored(key, owner, asset, assetSha256, providerRequestId, now) {
    await connectDB()
    const doc = await ImageGenerationReceiptModel.findOneAndUpdate(
      { ...filter(key), status: 'submitting', submission_owner: owner },
      {
        $set: {
          status: 'asset_stored',
          asset: cloneAsset(asset),
          asset_sha256: assetSha256,
          provider_request_id: providerRequestId,
          updated_at: now,
        },
      },
      { returnDocument: 'after' },
    ).lean<ImageGenerationReceiptDocument>()
    if (doc) return fromDocument(doc)
    const current = await mongoImageGenerationReceiptStore.get(key)
    if (current?.status === 'asset_stored' && current.asset?.assetId === asset.assetId) return current
    return currentOrConflict(key, 'submitting owned by this execution')
  },

  async adoptClaimedAsset(receipt, expectedAssetId, asset, assetSha256, now) {
    await connectDB()
    const doc = await ImageGenerationReceiptModel.findOneAndUpdate(
      {
        ...filter(receipt),
        status: 'asset_stored',
        'asset.assetId': expectedAssetId,
      },
      {
        $set: {
          asset: cloneAsset(asset),
          asset_sha256: assetSha256,
          updated_at: now,
        },
      },
      { returnDocument: 'after' },
    ).lean<ImageGenerationReceiptDocument>()
    if (doc) return fromDocument(doc)
    const current = await mongoImageGenerationReceiptStore.get(receipt)
    if (
      current?.status === 'asset_stored'
      && current.asset?.assetId === asset.assetId
      && current.assetSha256 === assetSha256
    ) return current
    return currentOrConflict(receipt, `asset_stored for ${expectedAssetId}`)
  },

  async markPublished(key, asset, resultContent, now) {
    await connectDB()
    const doc = await ImageGenerationReceiptModel.findOneAndUpdate(
      { ...filter(key), status: 'asset_stored', 'asset.assetId': asset.assetId },
      {
        $set: {
          status: 'published',
          result_content: resultContent,
          updated_at: now,
        },
      },
      { returnDocument: 'after' },
    ).lean<ImageGenerationReceiptDocument>()
    if (doc) return fromDocument(doc)
    const current = await mongoImageGenerationReceiptStore.get(key)
    if (current?.status === 'published' && current.asset?.assetId === asset.assetId) return current
    return currentOrConflict(key, 'asset_stored for the generated asset')
  },

  async markFailed(key, owner, code, message, now) {
    await connectDB()
    const doc = await ImageGenerationReceiptModel.findOneAndUpdate(
      { ...filter(key), status: 'submitting', submission_owner: owner },
      {
        $set: {
          status: 'failed',
          error_code: code,
          error_message: boundedErrorMessage(message),
          updated_at: now,
        },
      },
      { returnDocument: 'after' },
    ).lean<ImageGenerationReceiptDocument>()
    if (doc) return fromDocument(doc)
    return currentOrConflict(key, 'submitting owned by this execution')
  },

  async markUnknown(key, code, message, now) {
    await connectDB()
    const doc = await ImageGenerationReceiptModel.findOneAndUpdate(
      { ...filter(key), status: 'submitting' },
      {
        $set: {
          status: 'unknown',
          error_code: code,
          error_message: boundedErrorMessage(message),
          updated_at: now,
        },
      },
      { returnDocument: 'after' },
    ).lean<ImageGenerationReceiptDocument>()
    if (doc) return fromDocument(doc)
    const current = await mongoImageGenerationReceiptStore.get(key)
    if (current?.status === 'unknown') return current
    return currentOrConflict(key, 'submitting')
  },
}

export type ImagePaidSlotDisposition = 'active' | 'terminal_or_missing' | 'seal_unknown'

export function imagePaidSlotDisposition(input: {
  receipt: Pick<ImageGenerationReceipt, 'status' | 'submissionStartedAt' | 'updatedAt'> | null
  now: Date
  submissionLeaseMs?: number
  reservationRecoveryMs?: number
}): ImagePaidSlotDisposition {
  const receipt = input.receipt
  if (!receipt) return 'terminal_or_missing'
  const submissionLeaseMs = input.submissionLeaseMs ?? IMAGE_GENERATION_SUBMISSION_LEASE_MS
  const reservationRecoveryMs = input.reservationRecoveryMs
    ?? IMAGE_GENERATION_RESERVATION_RECOVERY_MS
  if (receipt.status === 'prepared') {
    return input.now.getTime() - receipt.updatedAt.getTime() < reservationRecoveryMs
      ? 'active'
      : 'terminal_or_missing'
  }
  if (receipt.status === 'submitting') {
    const startedAt = receipt.submissionStartedAt ?? receipt.updatedAt
    return input.now.getTime() - startedAt.getTime() < submissionLeaseMs
      ? 'active'
      : 'seal_unknown'
  }
  // asset_stored has completed provider work; every other status is terminal.
  return 'terminal_or_missing'
}

/**
 * Reconcile image-generation holders during the normal startup/recovery sweep.
 * A prepared receipt has not crossed the provider boundary and may safely
 * reacquire on replay. Unknown is terminal (no automatic paid replay), so it
 * must not occupy capacity forever. Submitting remains active until the same
 * ambiguity lease used by the tool expires; expiry seals it unknown first.
 */
export async function reconcileImageGenerationPaidSlots(
  now = new Date(),
  submissionLeaseMs = IMAGE_GENERATION_SUBMISSION_LEASE_MS,
  reservationRecoveryMs = IMAGE_GENERATION_RESERVATION_RECOVERY_MS,
): Promise<{ bound: number; released: number; markedUnknown: number }> {
  const submittingCutoff = new Date(now.getTime() - submissionLeaseMs)
  // Product GenerateImage no longer requires a global paid-slot gate, so an
  // ambiguous receipt may have no SpatialPaidSlot row to drive reconciliation.
  // Seal every expired submitting receipt directly before reconciling any
  // optional Operator/test slots.
  const expired = await ImageGenerationReceiptModel.updateMany(
    {
      status: 'submitting',
      $or: [
        { submission_started_at: { $lte: submittingCutoff } },
        {
          $and: [
            { $or: [{ submission_started_at: null }, { submission_started_at: { $exists: false } }] },
            { updated_at: { $lte: submittingCutoff } },
          ],
        },
      ],
    },
    {
      $set: {
        status: 'unknown',
        error_code: 'submission_lease_expired',
        error_message: '图片提交租约过期；供应商可能已接受请求，禁止自动重复付费提交。',
        updated_at: now,
      },
    },
  )
  let markedUnknown = expired.modifiedCount
  const result = await reconcileSpatialPaidSlots({
    holderType: 'image_generation',
    now,
    async inspectHolder(slot) {
      const receipt = await ImageGenerationReceiptModel.findOne({
        project_id: slot.project_id,
        user_id: slot.user_id,
        paid_slot_holder_key: slot.holder_key,
      }).select('status submission_started_at updated_at').lean<Pick<
        ImageGenerationReceiptDocument,
        'status' | 'submission_started_at' | 'updated_at'
      >>()
      const disposition = imagePaidSlotDisposition({
        receipt: receipt
          ? {
              status: receipt.status,
              submissionStartedAt: receipt.submission_started_at,
              updatedAt: receipt.updated_at,
            }
          : null,
        now,
        submissionLeaseMs,
        reservationRecoveryMs,
      })
      if (disposition !== 'seal_unknown') return disposition
      const update = await ImageGenerationReceiptModel.updateOne(
        {
          project_id: slot.project_id,
          user_id: slot.user_id,
          paid_slot_holder_key: slot.holder_key,
          status: 'submitting',
        },
        {
          $set: {
            status: 'unknown',
            error_code: 'submission_lease_expired',
            error_message: '图片提交租约在进程恢复前过期；供应商可能已接受请求，禁止自动重复付费提交。',
            updated_at: now,
          },
        },
      )
      markedUnknown += update.modifiedCount
      return 'terminal_or_missing'
    },
  })
  return { ...result, markedUnknown }
}

export type { ImageGenerationReceiptStore, NewImageGenerationReceipt }
