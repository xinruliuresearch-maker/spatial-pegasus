import { createHash } from 'node:crypto'
import mongoose from 'mongoose'
import { connectDB } from '../db/mongodb'
import { ImageAsset } from '../media/model'
import { claimImageAsset, writeImageAsset } from '../media/storage'
import { toRasterAssetRef } from '../media/reference'
import type { WorkspaceInstance } from '../workspace/types'
import type {
  PublishedSpatialAsset,
  SpatialAssetPublisher,
  SpatialBuildJobRecord,
  StagedSpatialAsset,
} from './types'
import { SpatialBuildJobModel, SpatialStagedBatchModel } from './models'

interface PrivateWorkspaceStage extends StagedSpatialAsset {
  buffer: Buffer
}

const STAGE_BUCKET_NAME = 'pegasus_spatial_staging'
const STAGE_TTL_MS = 24 * 60 * 60 * 1_000
type StageBucket = ReturnType<typeof createStageBucket>
let stageBucket: StageBucket | null = null

function createStageBucket(db: mongoose.mongo.Db) {
  return new mongoose.mongo.GridFSBucket(db, { bucketName: STAGE_BUCKET_NAME })
}

async function getStageBucket(): Promise<StageBucket> {
  if (stageBucket) return stageBucket
  await connectDB()
  const db = mongoose.connection.db
  if (!db) throw new Error('MongoDB not connected for spatial staging.')
  stageBucket = createStageBucket(db)
  return stageBucket
}

export function spatialStageObjectId(artifactId: string): mongoose.Types.ObjectId {
  const value = createHash('sha256').update(`spatial-stage-v1\0${artifactId}`).digest('hex').slice(0, 24)
  return new mongoose.Types.ObjectId(value)
}

async function deleteOrphanStageChunks(id: mongoose.Types.ObjectId): Promise<number> {
  await connectDB()
  const db = mongoose.connection.db
  if (!db) throw new Error('MongoDB not connected for spatial staging cleanup.')
  const file = await db.collection(`${STAGE_BUCKET_NAME}.files`).findOne({ _id: id })
  if (file) return 0
  const result = await db.collection(`${STAGE_BUCKET_NAME}.chunks`).deleteMany({ files_id: id })
  return result.deletedCount
}

function duplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 11000
}

function publicStage(input: PrivateWorkspaceStage): StagedSpatialAsset {
  const safe = { ...input } as Partial<PrivateWorkspaceStage>
  delete safe.buffer
  return structuredClone(safe) as StagedSpatialAsset
}

async function stageFileInfo(stageId: string) {
  const bucket = await getStageBucket()
  return (await bucket.find({ _id: new mongoose.Types.ObjectId(stageId) }).limit(1).toArray())[0] ?? null
}

async function readStageBuffer(stageId: string): Promise<Buffer> {
  const bucket = await getStageBucket()
  const chunks: Buffer[] = []
  const stream = bucket.openDownloadStream(new mongoose.Types.ObjectId(stageId))
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.once('end', () => resolve(Buffer.concat(chunks)))
    stream.once('error', reject)
  })
}

async function deleteStage(stageId: string): Promise<boolean> {
  const bucket = await getStageBucket()
  try {
    await bucket.delete(new mongoose.Types.ObjectId(stageId))
    return true
  } catch (error) {
    if (error instanceof Error && /FileNotFound/i.test(error.message)) return false
    throw error
  }
}

function publishedAsset(asset: StagedSpatialAsset, storageUri: string): PublishedSpatialAsset {
  return {
    ...structuredClone(asset),
    storageUri,
  }
}

async function rollbackOwnedRasterClaim(input: {
  assetId: string | null
  ownerUserId: string
  conversationId: string
}): Promise<void> {
  if (!input.assetId) return
  await ImageAsset.updateOne({
    asset_id: input.assetId,
    owner_user_id: input.ownerUserId,
    conversation_id: input.conversationId,
    state: 'active',
  }, {
    $set: { state: 'staged', conversation_id: null, claimed_at: null },
  }).catch(() => undefined)
}

async function existingWorkspaceAsset(input: {
  workspace: WorkspaceInstance
  asset: StagedSpatialAsset
}): Promise<{ exists: boolean; exact: boolean; storageUri?: string }> {
  const { workspace, asset } = input
  if (asset.mimeType.startsWith('image/')) {
    const ref = await workspace.readRaster(asset.workspacePath)
    if (!ref) return { exists: workspace.exists(asset.workspacePath), exact: false }
    const buffer = await workspace.readRasterBuffer(asset.workspacePath, 'original')
    const exact = Boolean(buffer && createHash('sha256').update(buffer).digest('hex') === asset.sha256)
    return { exists: true, exact, storageUri: exact ? `asset:${ref.assetId}` : undefined }
  }
  if ([
    'model/gltf-binary',
    'application/ply',
    'application/vnd.aholo.spz',
  ].includes(asset.mimeType)) {
    const ref = await workspace.readDocument(asset.workspacePath)
    if (!ref) return { exists: workspace.exists(asset.workspacePath), exact: false }
    const exact = ref.sha256 === asset.sha256
    return { exists: true, exact, storageUri: exact ? `workspace:${asset.workspacePath}` : undefined }
  }
  const content = await workspace.readText(asset.workspacePath)
  if (content === null) return { exists: workspace.exists(asset.workspacePath), exact: false }
  const exact = createHash('sha256').update(content, 'utf8').digest('hex') === asset.sha256
  return { exists: true, exact, storageUri: exact ? `workspace:${asset.workspacePath}` : undefined }
}

export interface OpaqueWorkspaceArtifactPublisher {
  /**
   * Commit an already-sniffed PLY/SPZ artifact into the authoritative Workspace
   * and return a credential-free locator. Implementations should use the
   * multi-agent `artifact` metadata/storage-ref path, never a signed URL.
   */
  publish(input: {
    job: SpatialBuildJobRecord
    path: string
    buffer: Buffer
    mimeType: string
    sha256: string
  }): Promise<{ storageUri: string }>
}

export interface WorkspaceSpatialPublisherOptions {
  resolveWorkspace(job: SpatialBuildJobRecord): Promise<WorkspaceInstance>
  opaqueArtifactPublisher?: OpaqueWorkspaceArtifactPublisher
}

/**
 * Production-oriented publisher for the existing Workspace primitives.
 * Raster, immutable spatial documents, and JSON outputs are supported directly.
 * The opaque publisher remains as a fail-closed extension point for future
 * bounded binary formats.
 */
export function createWorkspaceSpatialPublisher(
  options: WorkspaceSpatialPublisherOptions,
): SpatialAssetPublisher {
  return {
    async recoverStage(input) {
      const stageId = spatialStageObjectId(input.artifactId).toString()
      const stored = await stageFileInfo(stageId)
      if (!stored) return null
      const metadata = stored.metadata as Record<string, unknown> | undefined
      const mimeType = typeof metadata?.mime_type === 'string' ? metadata.mime_type : ''
      const sha256 = typeof metadata?.sha256 === 'string' ? metadata.sha256 : ''
      const declaredSize = typeof metadata?.size_bytes === 'number' ? metadata.size_bytes : -1
      if (
        metadata?.job_id !== input.job.job_id
        || metadata?.project_id !== input.job.project_id
        || metadata?.user_id !== input.job.user_id
        || metadata?.publication_token !== input.publicationToken
        || metadata?.artifact_id !== input.artifactId
        || metadata?.workspace_path !== input.workspacePath
        || !mimeType
        || !/^[a-f0-9]{64}$/i.test(sha256)
        || declaredSize !== stored.length
      ) {
        throw new Error(`Conflicting durable spatial stage: ${input.artifactId}`)
      }
      return {
        stageId,
        artifactId: input.artifactId,
        jobId: input.job.job_id,
        publicationToken: input.publicationToken,
        providerAssetKey: input.providerAssetKey,
        kind: input.kind,
        filename: input.filename,
        workspacePath: input.workspacePath,
        mimeType,
        sizeBytes: stored.length,
        sha256,
        relations: structuredClone(input.relations),
        metadata: structuredClone(input.metadata),
      }
    },

    async stage(input) {
      const id = spatialStageObjectId(input.artifactId)
      const stageId = id.toString()
      const value: PrivateWorkspaceStage = {
        stageId,
        artifactId: input.artifactId,
        jobId: input.job.job_id,
        publicationToken: input.publicationToken,
        providerAssetKey: input.providerAssetKey,
        kind: input.kind,
        filename: input.filename,
        workspacePath: input.workspacePath,
        mimeType: input.mimeType,
        sizeBytes: input.buffer.length,
        sha256: input.sha256,
        relations: structuredClone(input.relations),
        metadata: structuredClone(input.metadata),
        buffer: Buffer.from(input.buffer),
      }
      const bucket = await getStageBucket()
      const expiresAt = new Date(Date.now() + STAGE_TTL_MS)
      const metadata = {
        job_id: value.jobId,
        project_id: input.job.project_id,
        user_id: input.job.user_id,
        publication_token: value.publicationToken,
        artifact_id: value.artifactId,
        workspace_path: value.workspacePath,
        mime_type: value.mimeType,
        size_bytes: value.sizeBytes,
        sha256: value.sha256,
        expires_at: expiresAt,
      }
      if (!(await stageFileInfo(stageId))) await deleteOrphanStageChunks(id)
      try {
        const upload = bucket.openUploadStreamWithId(id, `${value.jobId}/${value.artifactId}`, { metadata })
        await new Promise<void>((resolve, reject) => {
          upload.once('finish', resolve)
          upload.once('error', reject)
          upload.end(value.buffer)
        })
      } catch (error) {
        if (!duplicateKey(error)) throw error
      }
      const stored = await stageFileInfo(stageId)
      if (
        !stored
        || stored.length !== value.sizeBytes
        || stored.metadata?.sha256 !== value.sha256
        || stored.metadata?.job_id !== value.jobId
        || stored.metadata?.workspace_path !== value.workspacePath
      ) throw new Error(`Conflicting durable spatial stage: ${value.artifactId}`)
      return publicStage(value)
    },

    async markBatchReady(input) {
      if (!input.assets.length) throw new Error('Cannot mark an empty spatial stage batch ready.')
      await SpatialStagedBatchModel.findOneAndUpdate(
        { job_id: input.job.job_id, publication_token: input.publicationToken },
        {
          $setOnInsert: {
            job_id: input.job.job_id,
            project_id: input.job.project_id,
            user_id: input.job.user_id,
            publication_token: input.publicationToken,
            state: 'ready',
            assets: structuredClone([...input.assets]),
          },
          $set: { expires_at: new Date(Date.now() + STAGE_TTL_MS) },
        },
        { upsert: true, returnDocument: 'after' },
      )
      const ready = await SpatialStagedBatchModel.findOne({
        job_id: input.job.job_id,
        publication_token: input.publicationToken,
      }).lean()
      if (!ready || JSON.stringify(ready.assets) !== JSON.stringify(input.assets)) {
        throw new Error('Conflicting durable spatial batch receipt.')
      }
    },

    async recoverReadyBatch(input) {
      const ready = await SpatialStagedBatchModel.findOneAndUpdate({
          job_id: input.job.job_id,
          project_id: input.job.project_id,
          user_id: input.job.user_id,
          publication_token: input.publicationToken,
          state: 'ready',
        },
        { $set: { expires_at: new Date(Date.now() + STAGE_TTL_MS) } },
        { returnDocument: 'after' },
      ).lean()
      if (!ready) return null
      for (const asset of ready.assets) {
        const stored = await stageFileInfo(asset.stageId)
        if (!stored || stored.length !== asset.sizeBytes || stored.metadata?.sha256 !== asset.sha256) {
          throw new Error(`Durable spatial stage is incomplete: ${asset.artifactId}`)
        }
      }
      return structuredClone(ready.assets)
    },

    async publishBatch(input) {
      if (input.assets.filter(asset => asset.mimeType.startsWith('image/')).length > 1) {
        throw new Error('Spatial publication supports at most one raster preview per atomic Build.')
      }
      const workspace = await options.resolveWorkspace(input.job)
      const existing: Array<Awaited<ReturnType<typeof existingWorkspaceAsset>>> = []
      for (const asset of input.assets) {
        existing.push(await existingWorkspaceAsset({ workspace, asset }))
      }
      if (existing.every(value => value.exists && value.exact && value.storageUri)) {
        return input.assets.map((asset, index) => publishedAsset(asset, existing[index].storageUri!))
      }
      if (existing.some(value => value.exists)) {
        throw new Error(
          'Spatial output set already exists partially or with different bytes; refusing non-atomic overwrite.',
        )
      }
      const published: PublishedSpatialAsset[] = []
      let ownedRasterClaim: string | null = null
      try {
        await workspace.withFileSetReservation(
          input.assets.map(asset => asset.workspacePath),
          `${input.job.idempotency_key}:spatial-publication`,
          async () => {
          // Load and commit one private object at a time. Peak resident bytes
          // are bounded by one validated artifact, not the whole batch.
          const orderedAssets = [...input.assets].sort((left, right) => (
            Number(left.mimeType.startsWith('image/')) - Number(right.mimeType.startsWith('image/'))
          ))
          for (const asset of orderedAssets) {
            const buffer = await readStageBuffer(asset.stageId)
            if (
              buffer.length !== asset.sizeBytes
              || createHash('sha256').update(buffer).digest('hex') !== asset.sha256
            ) throw new Error(`Durable spatial stage failed integrity verification: ${asset.artifactId}`)
            let storageUri: string
            if (asset.mimeType.startsWith('image/')) {
              const stagedImage = await writeImageAsset({
                ownerUserId: input.job.user_id,
                buffer,
                mimeType: asset.mimeType,
                source: 'tool_output',
              })
              const claimed = await claimImageAsset(
                stagedImage.assetId,
                input.job.user_id,
                input.job.conversation_id,
              )
              if (!claimed) throw new Error(`Unable to claim staged spatial raster: ${asset.artifactId}`)
              if (claimed.assetId === stagedImage.assetId) ownedRasterClaim = claimed.assetId
              try {
                await workspace.writeRasters([{
                  path: asset.workspacePath,
                  asset: toRasterAssetRef(claimed),
                  note: `Spatial job ${input.job.job_id}`,
                }])
              } catch (error) {
                if (claimed.assetId === stagedImage.assetId) {
                  // Make the capability inaccessible again; normal staged-asset
                  // TTL cleanup removes its backing object.
                  await ImageAsset.updateOne({
                    asset_id: claimed.assetId,
                    owner_user_id: input.job.user_id,
                    conversation_id: input.job.conversation_id,
                    state: 'active',
                  }, {
                    $set: { state: 'staged', conversation_id: null, claimed_at: null },
                  }).catch(() => undefined)
                  ownedRasterClaim = null
                }
                throw error
              }
              storageUri = `asset:${claimed.assetId}`
            } else if ([
              'model/gltf-binary',
              'application/ply',
              'application/vnd.aholo.spz',
            ].includes(asset.mimeType)) {
              await workspace.writeDocument({
                path: asset.workspacePath,
                buffer,
                filename: asset.workspacePath.split('/').at(-1)!,
                mimeType: asset.mimeType,
                source: {
                  provider: input.job.provider,
                  external_id: input.job.external_job_id || undefined,
                },
                provenance: {
                  retrieved_at: new Date().toISOString(),
                  version: input.job.model_snapshot || undefined,
                },
                note: `Spatial job ${input.job.job_id}`,
              })
              storageUri = `workspace:${asset.workspacePath}`
            } else if (
              asset.mimeType === 'application/json'
              || asset.mimeType === 'model/gltf+json'
            ) {
              await workspace.writeText(
                asset.workspacePath,
                buffer.toString('utf8'),
                `Spatial job ${input.job.job_id}`,
                { archive: false },
              )
              storageUri = `workspace:${asset.workspacePath}`
            } else {
              if (!options.opaqueArtifactPublisher) {
                throw new Error(
                  `Workspace has no opaque artifact publisher for ${asset.mimeType} (${asset.workspacePath}).`,
                )
              }
              storageUri = (await options.opaqueArtifactPublisher.publish({
                job: input.job,
                path: asset.workspacePath,
                buffer,
                mimeType: asset.mimeType,
                sha256: asset.sha256,
              })).storageUri
            }
            published.push(publishedAsset(asset, storageUri))
          }
          },
        )
      } catch (error) {
        await rollbackOwnedRasterClaim({
          assetId: ownedRasterClaim,
          ownerUserId: input.job.user_id,
          conversationId: input.job.conversation_id,
        })
        throw error
      }
      ownedRasterClaim = null
      return published
    },

    async discardBatch(assets) {
      const batches = new Set<string>()
      for (const asset of assets) {
        await deleteStage(asset.stageId)
        batches.add(`${asset.jobId}\0${asset.publicationToken}`)
      }
      for (const value of batches) {
        const [jobId, publicationToken] = value.split('\0')
        await SpatialStagedBatchModel.deleteOne({ job_id: jobId, publication_token: publicationToken })
      }
    },

    async discardJobStages(input) {
      const bucket = await getStageBucket()
      const files = await bucket.find({
        'metadata.job_id': input.job.job_id,
        'metadata.publication_token': input.publicationToken,
      }).toArray()
      let removed = 0
      for (const file of files) removed += await deleteStage(file._id.toString()) ? 1 : 0
      await SpatialStagedBatchModel.deleteOne({
        job_id: input.job.job_id,
        publication_token: input.publicationToken,
      })
      return removed
    },

    async cleanupExpired(now = new Date()) {
      let removed = 0
      const expired = await SpatialStagedBatchModel.find({ expires_at: { $lte: now } }).lean()
      for (const batch of expired) {
        const active = await SpatialBuildJobModel.exists({
          job_id: batch.job_id,
          project_id: batch.project_id,
          user_id: batch.user_id,
          status: 'materializing',
        })
        if (active) {
          await SpatialStagedBatchModel.updateOne(
            { _id: (batch as { _id?: unknown })._id },
            { $set: { expires_at: new Date(now.getTime() + STAGE_TTL_MS) } },
          )
          continue
        }
        for (const asset of batch.assets) removed += await deleteStage(asset.stageId) ? 1 : 0
      }
      await SpatialStagedBatchModel.deleteMany({ expires_at: { $lte: now } })
      const bucket = await getStageBucket()
      const orphaned = await bucket.find({ 'metadata.expires_at': { $lte: now } }).toArray()
      for (const file of orphaned) {
        const jobId = typeof file.metadata?.job_id === 'string' ? file.metadata.job_id : ''
        if (jobId && await SpatialBuildJobModel.exists({ job_id: jobId, status: 'materializing' })) continue
        removed += await deleteStage(file._id.toString()) ? 1 : 0
      }
      const db = mongoose.connection.db
      if (db) {
        const cutoffId = mongoose.Types.ObjectId.createFromTime(
          Math.floor((now.getTime() - STAGE_TTL_MS) / 1_000),
        )
        const orphanChunks = await db.collection(`${STAGE_BUCKET_NAME}.chunks`).aggregate<{
          _id: mongoose.Types.ObjectId
        }>([
          { $match: { _id: { $lt: cutoffId } } },
          { $lookup: {
            from: `${STAGE_BUCKET_NAME}.files`,
            localField: 'files_id',
            foreignField: '_id',
            as: 'file',
          } },
          { $match: { file: { $size: 0 } } },
          { $project: { _id: 1 } },
          { $limit: 10_000 },
        ]).toArray()
        if (orphanChunks.length) {
          const result = await db.collection(`${STAGE_BUCKET_NAME}.chunks`).deleteMany({
            _id: { $in: orphanChunks.map(chunk => chunk._id) },
          })
          removed += result.deletedCount
        }
      }
      return removed
    },
  }
}
