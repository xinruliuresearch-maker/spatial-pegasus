// ============================================================
// Raster asset storage
//
// MongoDB stores ownership, lifecycle and variant metadata. Raster bytes are
// immutable objects in OSS (or a dedicated GridFS development fallback).
// ============================================================

import { createHash, randomBytes } from 'crypto'
import OSS from 'ali-oss'
import mongoose from 'mongoose'
import sharp from 'sharp'
import { processImageForContext } from '../agent/image-resizer'
import { connectDB } from '../db/mongodb'
import { getMediaStorageDriver, getOSSMediaConfig, type MediaStorageDriver } from './config'
import {
  buildProviderRasterAliasObjectKey,
  buildRasterAssetObjectKey,
  providerRasterExtension,
} from './object-prefix'
import { buildOSSObjectPublicUrl, getMediaPublicBaseUrl } from './public-url'
import {
  ImageAsset,
  type AssetVariantDocument,
  type ImageAssetDocument,
  type RasterAssetSource,
  type RasterAssetState,
  type RasterAssetVariantName,
} from './model'

const GRIDFS_BUCKET_NAME = 'pegasus_spatial_media'
// v2 keeps the lossless original untouched, but encodes sufficiently large
// model variants as WebP when that materially reduces transfer size. The
// transform version participates in per-conversation idempotency, so assets
// produced by the old and new pipelines are never confused.
export const RASTER_TRANSFORM_VERSION = 2
export const STAGED_ASSET_TTL_MS = 24 * 60 * 60 * 1000

const MODEL_WEBP_MIN_SOURCE_BYTES = 256 * 1024
const MODEL_WEBP_MAX_SIZE_RATIO = 0.88

const FORMAT_MIME: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

export interface StoredAssetVariant {
  storageKey: string
  mimeType: string
  width: number
  height: number
  sizeBytes: number
}

export interface StoredImageAsset {
  assetId: string
  ownerUserId: string
  conversationId?: string
  source: RasterAssetSource
  sha256: string
  state: RasterAssetState
  storageDriver: MediaStorageDriver
  variants: Record<RasterAssetVariantName, StoredAssetVariant>
  uploadedAt: Date
  claimedAt?: Date
  /** Compatibility conveniences. They point at the model variant. */
  storageKey: string
  mimeType: string
  width: number
  height: number
  sizeBytes: number
}

export interface ReadImageAsset {
  buffer: Buffer
  asset: StoredImageAsset
  variant: RasterAssetVariantName
}

type MediaBucket = ReturnType<typeof createBucket>

function createBucket(db: mongoose.mongo.Db) {
  return new mongoose.mongo.GridFSBucket(db, { bucketName: GRIDFS_BUCKET_NAME })
}

let bucket: MediaBucket | null = null
let ossClient: OSS | null = null

async function getBucket(): Promise<MediaBucket> {
  if (bucket) return bucket
  await connectDB()
  const db = mongoose.connection.db
  if (!db) throw new Error('MongoDB not connected')
  bucket = createBucket(db)
  return bucket
}

function getOSSClient(): OSS {
  if (ossClient) return ossClient
  const config = getOSSMediaConfig()
  ossClient = new OSS({
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    stsToken: config.stsToken,
    endpoint: config.endpoint,
    secure: true,
    timeout: config.requestTimeoutMs,
  })
  return ossClient
}

function ossErrorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown; statusCode?: unknown } | null)?.status
    ?? (error as { statusCode?: unknown } | null)?.statusCode
  return typeof status === 'number' ? status : undefined
}

export function isRetryableOSSWriteError(error: unknown): boolean {
  const status = ossErrorStatus(error)
  if (status !== undefined && (status === 408 || status === 429 || status >= 500)) return true
  const code = String((error as { code?: unknown } | null)?.code || '').toLowerCase()
  const name = String((error as { name?: unknown } | null)?.name || '').toLowerCase()
  const message = String((error as { message?: unknown } | null)?.message || error || '').toLowerCase()
  return [code, name, message].some(value => (
    value.includes('timeout')
    || value.includes('econnreset')
    || value.includes('socket')
    || value.includes('connection')
    || value.includes('network')
  ))
}

async function ossObjectMatches(
  objectKey: string,
  expectedSha256: string,
  expectedBytes: number,
): Promise<boolean> {
  try {
    const head = await getOSSClient().head(objectKey) as {
      res?: { headers?: Record<string, string | number | undefined> }
    }
    const headers = head.res?.headers || {}
    const storedSha = String(headers['x-oss-meta-sha256'] || '')
    const storedBytes = Number(headers['content-length'])
    return storedSha === expectedSha256 && storedBytes === expectedBytes
  } catch {
    return false
  }
}

async function writeOSSObjectWithRetry(input: {
  objectKey: string
  buffer: Buffer
  mimeType: string
}): Promise<void> {
  const config = getOSSMediaConfig()
  const sha256 = createHash('sha256').update(input.buffer).digest('hex')
  let lastError: unknown
  for (let attempt = 1; attempt <= config.uploadAttempts; attempt += 1) {
    try {
      await getOSSClient().put(input.objectKey, input.buffer, {
        headers: {
          'Content-Type': input.mimeType,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'x-oss-forbid-overwrite': 'true',
          'x-oss-meta-sha256': sha256,
        },
      })
      return
    } catch (error) {
      lastError = error
      // A timed-out response may hide a successful immutable PUT. Verify the
      // exact object before retrying so local persistence recovery never
      // creates a second paid image request.
      if (await ossObjectMatches(input.objectKey, sha256, input.buffer.length)) return
      if (!isRetryableOSSWriteError(error) || attempt === config.uploadAttempts) throw error
      await new Promise(resolve => setTimeout(resolve, attempt * 500))
    }
  }
  throw lastError
}

function toVariant(value: AssetVariantDocument): StoredAssetVariant {
  return {
    storageKey: value.storage_key,
    mimeType: value.mime_type,
    width: value.width,
    height: value.height,
    sizeBytes: value.size_bytes,
  }
}

function documentToAsset(doc: ImageAssetDocument): StoredImageAsset {
  const hasVariants = Boolean(
    doc.variants?.original?.storage_key
      && doc.variants?.model?.storage_key
      && doc.variants?.thumbnail?.storage_key,
  )
  if (!hasVariants) throw new Error(`图片资产 ${doc.asset_id} 缺少必要 variants`)
  const variants: Record<RasterAssetVariantName, StoredAssetVariant> = {
    original: toVariant(doc.variants!.original),
    model: toVariant(doc.variants!.model),
    thumbnail: toVariant(doc.variants!.thumbnail),
  }
  const model = variants.model

  return {
    assetId: doc.asset_id,
    ownerUserId: doc.owner_user_id,
    conversationId: doc.conversation_id || undefined,
    source: doc.source || 'user_upload',
    sha256: doc.sha256 || '',
    state: doc.state || (doc.conversation_id ? 'active' : 'staged'),
    storageDriver: doc.storage_driver,
    variants,
    uploadedAt: doc.created_at,
    claimedAt: doc.claimed_at || undefined,
    storageKey: model.storageKey,
    mimeType: model.mimeType,
    width: model.width,
    height: model.height,
    sizeBytes: model.sizeBytes,
  }
}

export async function inspectRasterContent(buffer: Buffer, claimedMimeType?: string): Promise<{
  mimeType: string
  width: number
  height: number
}> {
  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>
  try {
    metadata = await sharp(buffer, { animated: true }).metadata()
  } catch {
    throw new Error('无法解析图片内容')
  }
  const mimeType = metadata.format ? FORMAT_MIME[metadata.format] : undefined
  if (!mimeType || !metadata.width || !metadata.height) {
    throw new Error('仅支持 PNG、JPEG、WebP 和 GIF 栅格图片')
  }
  const normalizedClaim = claimedMimeType === 'image/jpg' ? 'image/jpeg' : claimedMimeType
  if (normalizedClaim && normalizedClaim !== mimeType) {
    // Browser File.type is derived from the filename / operating-system
    // metadata and is not authoritative. Security comes from decoding and
    // allow-listing the actual bytes above, so keep the sniffed MIME and only
    // retain the mismatch as an observable diagnostic.
    console.warn(`[media] corrected claimed MIME ${normalizedClaim} to sniffed ${mimeType}`)
  }
  return { mimeType, width: metadata.width, height: metadata.height }
}

export async function createModelVariant(
  original: Buffer,
  originalMime: string,
): Promise<{ buffer: Buffer; mimeType: string; width: number; height: number; reusedOriginal: boolean }> {
  let candidate: Buffer
  let candidateMime: string
  let width: number
  let height: number
  let reusedOriginal: boolean

  // Animated GIFs are intentionally reduced to the first frame for model input.
  if (originalMime === 'image/gif') {
    const firstFrame = await sharp(original, { animated: false, pages: 1 })
      .rotate()
      .png({ compressionLevel: 9 })
      .toBuffer()
    const processed = await processImageForContext(firstFrame.toString('base64'), 'image/png')
    candidate = Buffer.from(processed.base64, 'base64')
    candidateMime = processed.mimeType
    width = processed.width
    height = processed.height
    reusedOriginal = false
  } else {
    const processed = await processImageForContext(original.toString('base64'), originalMime)
    candidate = processed.wasProcessed ? Buffer.from(processed.base64, 'base64') : original
    candidateMime = processed.mimeType
    width = processed.width
    height = processed.height
    reusedOriginal = !processed.wasProcessed
  }

  // The provider limit is a safety ceiling, not a useful browser payload
  // target. Large PNG files used to be copied verbatim into /model whenever
  // they were below 3.75 MB. Preserve /original byte-for-byte, and use WebP
  // only when it cuts at least 12% from the model payload.
  if (candidate.length >= MODEL_WEBP_MIN_SOURCE_BYTES) {
    const webp = await sharp(candidate, { animated: false, pages: 1 })
      .rotate()
      .webp({ quality: 88, alphaQuality: 92, effort: 4 })
      .toBuffer()
    if (webp.length <= candidate.length * MODEL_WEBP_MAX_SIZE_RATIO) {
      const metadata = await sharp(webp).metadata()
      return {
        buffer: webp,
        mimeType: 'image/webp',
        width: metadata.width || width,
        height: metadata.height || height,
        reusedOriginal: false,
      }
    }
  }

  return {
    buffer: candidate,
    mimeType: candidateMime,
    width,
    height,
    reusedOriginal,
  }
}

async function createThumbnailVariant(
  original: Buffer,
): Promise<{ buffer: Buffer; mimeType: string; width: number; height: number }> {
  const buffer = await sharp(original, { animated: false, pages: 1 })
    .rotate()
    .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82, effort: 4 })
    .toBuffer()
  const metadata = await sharp(buffer).metadata()
  return {
    buffer,
    mimeType: 'image/webp',
    width: metadata.width || 0,
    height: metadata.height || 0,
  }
}

async function writeGridFS(
  assetId: string,
  variant: RasterAssetVariantName,
  buffer: Buffer,
  metadata: Record<string, unknown>,
): Promise<string> {
  const mediaBucket = await getBucket()
  const upload = mediaBucket.openUploadStream(`${assetId}/${variant}`, {
    metadata: { ...metadata, variant },
  })
  await new Promise<void>((resolve, reject) => {
    upload.once('finish', () => resolve())
    upload.once('error', reject)
    upload.end(buffer)
  })
  return upload.id.toString()
}

async function writeStoredObject(input: {
  driver: MediaStorageDriver
  assetId: string
  variant: RasterAssetVariantName
  buffer: Buffer
  mimeType: string
  metadata: Record<string, unknown>
}): Promise<string> {
  if (input.driver === 'oss') {
    const objectKey = buildRasterAssetObjectKey(input.assetId, input.variant)
    await writeOSSObjectWithRetry({
      objectKey,
      buffer: input.buffer,
      mimeType: input.mimeType,
    })
    return objectKey
  }
  return writeGridFS(input.assetId, input.variant, input.buffer, input.metadata)
}

async function deleteStoredObject(driver: MediaStorageDriver, storageKey: string): Promise<void> {
  if (!storageKey) return
  if (driver === 'oss') {
    await getOSSClient().delete(storageKey)
    return
  }
  const mediaBucket = await getBucket()
  await mediaBucket.delete(new mongoose.Types.ObjectId(storageKey))
}

async function deleteAssetObjects(asset: StoredImageAsset): Promise<void> {
  const keys = new Set(Object.values(asset.variants).map(variant => variant.storageKey).filter(Boolean))
  if (asset.storageDriver === 'oss') {
    keys.add(buildProviderRasterAliasObjectKey(
      asset.variants.original.storageKey,
      asset.variants.original.mimeType,
    ))
  }
  for (const key of keys) {
    await deleteStoredObject(asset.storageDriver, key)
  }
}

export async function writeImageAsset(input: {
  ownerUserId: string
  conversationId?: string | null
  buffer: Buffer
  mimeType?: string
  /** Retained for source compatibility; dimensions are always sniffed from bytes. */
  width?: number
  height?: number
  source?: RasterAssetSource
  /** A deterministic transform identity for derived assets. */
  transformVersion?: number
}): Promise<StoredImageAsset> {
  await connectDB()
  const originalInfo = await inspectRasterContent(input.buffer, input.mimeType)
  const sha256 = createHash('sha256').update(input.buffer).digest('hex')
  const conversationId = input.conversationId || null
  const transformVersion = input.transformVersion ?? RASTER_TRANSFORM_VERSION

  if (conversationId) {
    const existing = await ImageAsset.findOne({
      owner_user_id: input.ownerUserId,
      conversation_id: conversationId,
      sha256,
      transform_version: transformVersion,
      state: 'active',
    })
    if (existing) {
      return documentToAsset(existing)
    }
  }

  const assetId = randomBytes(32).toString('base64url')
  const driver = getMediaStorageDriver()
  // Model and thumbnail transforms are independent reads of the same immutable
  // source bytes. Running them together removes one full Sharp transform from
  // the critical path for every generated or extracted image.
  const [model, thumbnail] = await Promise.all([
    createModelVariant(input.buffer, originalInfo.mimeType),
    createThumbnailVariant(input.buffer),
  ])
  const metadata = {
    assetId,
    ownerUserId: input.ownerUserId,
    conversationId,
    source: input.source || 'user_upload',
    sha256,
    transformVersion,
    uploadedAt: new Date().toISOString(),
  }

  const writtenKeys: string[] = []
  try {
    // Keep the public object contract literal: every new asset has all three
    // immutable keys. When no resize/re-encode is necessary, `model.buffer`
    // reuses the original bytes, but the /model object still exists so a
    // provider can construct its URL from assetId without a database lookup.
    const writes = await Promise.allSettled([
      writeStoredObject({
        driver,
        assetId,
        variant: 'original',
        buffer: input.buffer,
        mimeType: originalInfo.mimeType,
        metadata,
      }),
      writeStoredObject({
        driver,
        assetId,
        variant: 'model',
        buffer: model.buffer,
        mimeType: model.mimeType,
        metadata,
      }),
      writeStoredObject({
        driver,
        assetId,
        variant: 'thumbnail',
        buffer: thumbnail.buffer,
        mimeType: thumbnail.mimeType,
        metadata,
      }),
    ])
    for (const write of writes) {
      if (write.status === 'fulfilled') writtenKeys.push(write.value)
    }
    const failedWrite = writes.find((write): write is PromiseRejectedResult => write.status === 'rejected')
    if (failedWrite) throw failedWrite.reason
    const [originalKey, modelKey, thumbnailKey] = writes.map(write =>
      (write as PromiseFulfilledResult<string>).value,
    )

    const doc = await ImageAsset.create({
      asset_id: assetId,
      owner_user_id: input.ownerUserId,
      conversation_id: conversationId,
      source: input.source || 'user_upload',
      sha256,
      transform_version: transformVersion,
      state: conversationId ? 'active' : 'staged',
      storage_driver: driver,
      variants: {
        original: {
          storage_key: originalKey,
          mime_type: originalInfo.mimeType,
          width: originalInfo.width,
          height: originalInfo.height,
          size_bytes: input.buffer.length,
        },
        model: {
          storage_key: modelKey,
          mime_type: model.mimeType,
          width: model.width,
          height: model.height,
          size_bytes: model.buffer.length,
        },
        thumbnail: {
          storage_key: thumbnailKey,
          mime_type: thumbnail.mimeType,
          width: thumbnail.width,
          height: thumbnail.height,
          size_bytes: thumbnail.buffer.length,
        },
      },
      claimed_at: conversationId ? new Date() : null,
    })
    return documentToAsset(doc)
  } catch (error) {
    for (const key of new Set(writtenKeys)) {
      await deleteStoredObject(driver, key).catch(() => undefined)
    }
    // Concurrent idempotent writes can race at the unique index. Prefer the
    // already-committed asset after cleaning up this writer's objects.
    if ((error as { code?: number }).code === 11000 && conversationId) {
      const existing = await ImageAsset.findOne({
        owner_user_id: input.ownerUserId,
        conversation_id: conversationId,
        sha256,
        transform_version: transformVersion,
        state: 'active',
      })
      if (existing) return documentToAsset(existing)
    }
    throw error
  }
}

export async function claimImageAsset(
  assetId: string,
  ownerUserId: string,
  conversationId: string,
): Promise<StoredImageAsset | null> {
  await connectDB()
  try {
    const doc = await ImageAsset.findOneAndUpdate(
      {
        asset_id: assetId,
        owner_user_id: ownerUserId,
        state: { $ne: 'deleted' },
        $or: [{ conversation_id: null }, { conversation_id: conversationId }],
      },
      {
        $set: {
          conversation_id: conversationId,
          state: 'active',
          claimed_at: new Date(),
        },
      },
      { returnDocument: 'after' },
    )
    return doc ? documentToAsset(doc) : null
  } catch (error) {
    // Two staged uploads with identical bytes may be claimed into the same
    // conversation. The active checksum index intentionally allows only one.
    if ((error as { code?: number }).code !== 11000) throw error
    const staged = await ImageAsset.findOne({
      asset_id: assetId,
      owner_user_id: ownerUserId,
      conversation_id: null,
      state: 'staged',
    })
    if (!staged?.sha256) return null
    const existing = await ImageAsset.findOne({
      owner_user_id: ownerUserId,
      conversation_id: conversationId,
      sha256: staged.sha256,
      transform_version: staged.transform_version ?? RASTER_TRANSFORM_VERSION,
      state: 'active',
    })
    if (!existing) throw error
    await deleteAssetObjects(documentToAsset(staged))
    await ImageAsset.updateOne({ _id: staged._id, state: 'staged' }, {
      $set: { state: 'deleted', deleted_at: new Date() },
    })
    return documentToAsset(existing)
  }
}

export async function readImageAsset(
  assetId: string,
  variant: RasterAssetVariantName = 'original',
): Promise<ReadImageAsset | null> {
  const asset = await getImageAsset(assetId)
  if (!asset || asset.state === 'deleted') return null
  const selected = asset.variants[variant]

  let buffer: Buffer
  if (asset.storageDriver === 'oss') {
    const result = await getOSSClient().get(selected.storageKey)
    buffer = Buffer.isBuffer(result.content) ? result.content : Buffer.from(result.content)
  } else {
    const mediaBucket = await getBucket()
    const chunks: Buffer[] = []
    buffer = await new Promise<Buffer>((resolve, reject) => {
      const download = mediaBucket.openDownloadStream(new mongoose.Types.ObjectId(selected.storageKey))
      download.on('data', (chunk: Buffer) => chunks.push(chunk))
      download.once('end', () => resolve(Buffer.concat(chunks)))
      download.once('error', reject)
    })
  }

  return { buffer, asset, variant }
}

export async function getImageAsset(assetId: string): Promise<StoredImageAsset | null> {
  await connectDB()
  const doc = await ImageAsset.findOne({ asset_id: assetId })
  return doc ? documentToAsset(doc) : null
}

function isMissingOSSObject(error: unknown): boolean {
  const value = error as { status?: number; statusCode?: number; code?: string }
  return value.status === 404 || value.statusCode === 404 || value.code === 'NoSuchKey'
}

async function providerAliasMatches(
  storageKey: string,
  asset: StoredImageAsset,
): Promise<boolean> {
  try {
    const head = await getOSSClient().head(storageKey) as {
      status?: number
      meta?: Record<string, string> | null
      res?: { headers?: Record<string, string | number | undefined> }
    }
    const headers = head.res?.headers ?? {}
    return head.status === 200
      && head.meta?.sha256 === asset.sha256
      && Number(headers['content-length']) === asset.variants.original.sizeBytes
      && String(headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
        === asset.variants.original.mimeType
  } catch (error) {
    if (isMissingOSSObject(error)) return false
    throw error
  }
}

/**
 * Materialize an immutable, extension-bearing URL for spatial providers.
 * This does not create a paid provider job. Existing aliases are verified by
 * checksum and size, making retries and process takeover idempotent.
 */
export async function ensureProviderImageDeliveryUrl(assetId: string): Promise<string> {
  const asset = await getImageAsset(assetId)
  if (!asset || asset.state === 'deleted') throw new Error('Provider image asset is unavailable')
  const original = asset.variants.original
  const extension = providerRasterExtension(original.mimeType)

  if (asset.storageDriver === 'gridfs') {
    return new URL(
      `/api/media/${encodeURIComponent(asset.assetId)}/provider.${extension}`,
      getMediaPublicBaseUrl(),
    ).toString()
  }

  const aliasKey = buildProviderRasterAliasObjectKey(original.storageKey, original.mimeType)
  if (!await providerAliasMatches(aliasKey, asset)) {
    const found = await readImageAsset(asset.assetId, 'original')
    if (!found) throw new Error('Provider image bytes are unavailable')
    try {
      await getOSSClient().put(aliasKey, found.buffer, {
        headers: {
          'Content-Type': original.mimeType,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'x-oss-forbid-overwrite': 'true',
          'x-oss-meta-sha256': asset.sha256,
        },
      })
    } catch (error) {
      // A concurrent resolver may have won the immutable alias. Only accept
      // that race after reading and validating the exact stored metadata.
      if (!await providerAliasMatches(aliasKey, asset)) throw error
    }
    if (!await providerAliasMatches(aliasKey, asset)) {
      throw new Error('Provider image alias failed immutable verification')
    }
  }
  return buildOSSObjectPublicUrl(aliasKey)
}

export async function getOwnedImageAsset(
  assetId: string,
  ownerUserId: string,
  conversationId?: string,
): Promise<StoredImageAsset | null> {
  await connectDB()
  const doc = await ImageAsset.findOne({
    asset_id: assetId,
    owner_user_id: ownerUserId,
    state: { $ne: 'deleted' },
    ...(conversationId ? { conversation_id: conversationId } : {}),
  })
  return doc ? documentToAsset(doc) : null
}

export async function deleteConversationImageAssets(conversationId: string): Promise<number> {
  await connectDB()
  const docs = await ImageAsset.find({ conversation_id: conversationId, state: { $ne: 'deleted' } })
  for (const doc of docs) {
    await deleteAssetObjects(documentToAsset(doc))
  }
  if (docs.length > 0) {
    await ImageAsset.updateMany(
      { _id: { $in: docs.map(doc => doc._id) } },
      { $set: { state: 'deleted', deleted_at: new Date() } },
    )
  }
  return docs.length
}

export async function cleanupExpiredStagedAssets(now = new Date()): Promise<number> {
  await connectDB()
  const cutoff = new Date(now.getTime() - STAGED_ASSET_TTL_MS)
  const docs = await ImageAsset.find({
    state: 'staged',
    conversation_id: null,
    created_at: { $lt: cutoff },
  })
  for (const doc of docs) {
    await deleteAssetObjects(documentToAsset(doc))
  }
  if (docs.length > 0) {
    await ImageAsset.updateMany(
      { _id: { $in: docs.map(doc => doc._id) } },
      { $set: { state: 'deleted', deleted_at: now } },
    )
  }
  return docs.length
}
