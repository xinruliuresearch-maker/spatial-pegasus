import mongoose from 'mongoose'
import { connectDB } from '../../db/mongodb'
import {
  WorkspaceCanonicalArtifact,
  WorkspaceCapacity,
  WorkspaceFile,
  WorkspaceFileRevision,
} from './models'
import type {
  CanonicalArtifactClaim,
  CanonicalArtifactRecord,
  WorkspaceCapacityState,
  WorkspaceFileSnapshot,
} from './types'

export interface MultiAgentWorkspaceStore {
  createCapacityIfMissing(state: WorkspaceCapacityState): Promise<WorkspaceCapacityState>
  getCapacity(workspaceId: string): Promise<WorkspaceCapacityState | null>
  compareAndSwapCapacity(expectedRevision: number, next: WorkspaceCapacityState): Promise<boolean>

  getFile(workspaceId: string, path: string): Promise<WorkspaceFileSnapshot | null>
  listFiles(workspaceId: string): Promise<WorkspaceFileSnapshot[]>
  compareAndSwapFile(
    expectedRevision: number | null,
    candidate: WorkspaceFileSnapshot,
  ): Promise<{ committed: true } | { committed: false; actualRevision: number | null }>
  /** Delete unpublished heads owned by an abandoned whole-set reservation. */
  deleteStagedFiles(workspaceId: string, reservationId: string): Promise<number>
  /** Mark GridFS uploads from a successfully published whole-set reservation. */
  markFileSetPublished?(workspaceId: string, reservationId: string): Promise<number>

  claimCanonicalArtifact(record: CanonicalArtifactRecord): Promise<CanonicalArtifactClaim>
  getCanonicalArtifact(
    workspaceId: string,
    canonicalArtifactKey: string,
  ): Promise<CanonicalArtifactRecord | null>
  markCanonicalArtifactPublished(
    workspaceId: string,
    canonicalArtifactKey: string,
    fileRevision: number,
  ): Promise<void>
  markCanonicalArtifactFailed(
    workspaceId: string,
    canonicalArtifactKey: string,
  ): Promise<void>
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function capacityFrom(value: unknown): WorkspaceCapacityState {
  const doc = value as WorkspaceCapacityState
  return clone({
    workspace_id: doc.workspace_id,
    max_files: doc.max_files,
    revision: doc.revision,
    published_paths: doc.published_paths ?? [],
    reservations: doc.reservations ?? [],
  })
}

function canonicalFrom(value: unknown): CanonicalArtifactRecord {
  const doc = value as CanonicalArtifactRecord
  return clone({
    workspace_id: doc.workspace_id,
    canonical_artifact_key: doc.canonical_artifact_key,
    idempotency_key: doc.idempotency_key,
    path: doc.path,
    content_sha256: doc.content_sha256,
    status: doc.status,
    file_revision: doc.file_revision,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  })
}

function isDuplicateKey(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 11000)
}

/** Production MongoDB implementation. All publication authority is fenced by CAS. */
export class MongooseMultiAgentWorkspaceStore implements MultiAgentWorkspaceStore {
  async createCapacityIfMissing(state: WorkspaceCapacityState): Promise<WorkspaceCapacityState> {
    await connectDB()
    try {
      const doc = await WorkspaceCapacity.findOneAndUpdate(
        { workspace_id: state.workspace_id },
        { $setOnInsert: state },
        { upsert: true, returnDocument: 'after', lean: true },
      )
      return capacityFrom(doc)
    } catch (error) {
      // Concurrent first access can make two upserts race the unique index.
      if (!isDuplicateKey(error)) throw error
      const existing = await WorkspaceCapacity.findOne({ workspace_id: state.workspace_id }).lean()
      if (!existing) throw error
      return capacityFrom(existing)
    }
  }

  async getCapacity(workspaceId: string): Promise<WorkspaceCapacityState | null> {
    await connectDB()
    const doc = await WorkspaceCapacity.findOne({ workspace_id: workspaceId }).lean()
    return doc ? capacityFrom(doc) : null
  }

  async compareAndSwapCapacity(
    expectedRevision: number,
    next: WorkspaceCapacityState,
  ): Promise<boolean> {
    await connectDB()
    const result = await WorkspaceCapacity.updateOne(
      { workspace_id: next.workspace_id, revision: expectedRevision },
      {
        $set: {
          max_files: next.max_files,
          revision: next.revision,
          published_paths: next.published_paths,
          reservations: next.reservations,
        },
      },
    )
    return result.modifiedCount === 1
  }

  async getFile(workspaceId: string, path: string): Promise<WorkspaceFileSnapshot | null> {
    await connectDB()
    const head = await WorkspaceFile.findOne({ workspace_id: workspaceId, path }).lean()
    if (!head) return null
    const version = await WorkspaceFileRevision.findOne({
      version_id: head.current_version_id,
    }).lean()
    if (!version) throw new Error(`Workspace file ${path} points to a missing immutable revision`)
    return clone({
      workspace_id: version.workspace_id,
      path: version.path,
      revision: version.revision,
      version_id: version.version_id,
      visibility: version.visibility,
      owner_agent_id: version.owner_agent_id,
      storage_ref: version.storage_ref,
      metadata: version.metadata,
      writer: version.writer,
      canonical_artifact_key: version.canonical_artifact_key,
      publication_key: version.publication_key,
      publication_source: version.publication_source,
      capacity_reservation_id: version.capacity_reservation_id,
      created_at: head.created_at,
      updated_at: head.updated_at,
    })
  }

  async listFiles(workspaceId: string): Promise<WorkspaceFileSnapshot[]> {
    await connectDB()
    const heads = await WorkspaceFile.find({ workspace_id: workspaceId }).sort({ path: 1 }).lean()
    if (heads.length === 0) return []
    const versions = await WorkspaceFileRevision.find({
      version_id: { $in: heads.map(head => head.current_version_id) },
    }).lean()
    const byId = new Map(versions.map(version => [version.version_id, version]))
    return heads.map(head => {
      const version = byId.get(head.current_version_id)
      if (!version) throw new Error(`Workspace file ${head.path} points to a missing immutable revision`)
      return clone({
        workspace_id: version.workspace_id,
        path: version.path,
        revision: version.revision,
        version_id: version.version_id,
        visibility: version.visibility,
        owner_agent_id: version.owner_agent_id,
        storage_ref: version.storage_ref,
        metadata: version.metadata,
        writer: version.writer,
        canonical_artifact_key: version.canonical_artifact_key,
        publication_key: version.publication_key,
        publication_source: version.publication_source,
        capacity_reservation_id: version.capacity_reservation_id,
        created_at: head.created_at,
        updated_at: head.updated_at,
      })
    })
  }

  async compareAndSwapFile(
    expectedRevision: number | null,
    candidate: WorkspaceFileSnapshot,
  ): Promise<{ committed: true } | { committed: false; actualRevision: number | null }> {
    await connectDB()
    // Content records are append-only. A losing CAS can leave an unreachable
    // revision, which is safe and can be reclaimed asynchronously.
    await WorkspaceFileRevision.create({
      version_id: candidate.version_id,
      workspace_id: candidate.workspace_id,
      path: candidate.path,
      revision: candidate.revision,
      visibility: candidate.visibility,
      owner_agent_id: candidate.owner_agent_id,
      storage_ref: clone(candidate.storage_ref),
      metadata: clone(candidate.metadata),
      writer: clone(candidate.writer),
      canonical_artifact_key: candidate.canonical_artifact_key,
      publication_key: candidate.publication_key,
      publication_source: candidate.publication_source,
      capacity_reservation_id: candidate.capacity_reservation_id,
      created_at: candidate.updated_at,
    })

    const headFields = {
      revision: candidate.revision,
      current_version_id: candidate.version_id,
      visibility: candidate.visibility,
      owner_agent_id: candidate.owner_agent_id,
      writer: clone(candidate.writer),
      canonical_artifact_key: candidate.canonical_artifact_key,
      publication_key: candidate.publication_key,
      publication_source: candidate.publication_source,
      capacity_reservation_id: candidate.capacity_reservation_id,
    }

    if (expectedRevision === null) {
      try {
        await WorkspaceFile.create({
          workspace_id: candidate.workspace_id,
          path: candidate.path,
          ...headFields,
        })
        return { committed: true }
      } catch (error) {
        if (!isDuplicateKey(error)) throw error
      }
    } else {
      const result = await WorkspaceFile.updateOne(
        {
          workspace_id: candidate.workspace_id,
          path: candidate.path,
          revision: expectedRevision,
        },
        { $set: headFields },
      )
      if (result.modifiedCount === 1) return { committed: true }
    }

    const actual = await WorkspaceFile.findOne({
      workspace_id: candidate.workspace_id,
      path: candidate.path,
    }).select({ revision: 1 }).lean()
    return { committed: false, actualRevision: actual?.revision ?? null }
  }

  async deleteStagedFiles(workspaceId: string, reservationId: string): Promise<number> {
    await connectDB()
    const result = await WorkspaceFile.deleteMany({
      workspace_id: workspaceId,
      capacity_reservation_id: reservationId,
    })
    return result.deletedCount
  }

  async markFileSetPublished(workspaceId: string, reservationId: string): Promise<number> {
    await connectDB()
    const db = mongoose.connection.db
    if (!db) return 0
    const result = await db.collection('workspace_files.files').updateMany({
      'metadata.workspaceId': workspaceId,
      'metadata.capacityReservationId': reservationId,
      'metadata.fileSetState': 'staged',
    }, {
      $set: { 'metadata.fileSetState': 'published' },
    })
    return result.modifiedCount
  }

  async claimCanonicalArtifact(record: CanonicalArtifactRecord): Promise<CanonicalArtifactClaim> {
    await connectDB()
    try {
      await WorkspaceCanonicalArtifact.create(record)
      return { state: 'claimed', record: clone(record) }
    } catch (error) {
      if (!isDuplicateKey(error)) throw error
      const existing = await this.getCanonicalArtifact(
        record.workspace_id,
        record.canonical_artifact_key,
      )
      if (!existing) throw error
      return { state: 'existing', record: existing }
    }
  }

  async getCanonicalArtifact(
    workspaceId: string,
    canonicalArtifactKey: string,
  ): Promise<CanonicalArtifactRecord | null> {
    await connectDB()
    const doc = await WorkspaceCanonicalArtifact.findOne({
      workspace_id: workspaceId,
      canonical_artifact_key: canonicalArtifactKey,
    }).lean()
    return doc ? canonicalFrom(doc) : null
  }

  async markCanonicalArtifactPublished(
    workspaceId: string,
    canonicalArtifactKey: string,
    fileRevision: number,
  ): Promise<void> {
    await connectDB()
    await WorkspaceCanonicalArtifact.updateOne(
      { workspace_id: workspaceId, canonical_artifact_key: canonicalArtifactKey },
      { $set: { status: 'published', file_revision: fileRevision } },
    )
  }

  async markCanonicalArtifactFailed(
    workspaceId: string,
    canonicalArtifactKey: string,
  ): Promise<void> {
    await connectDB()
    await WorkspaceCanonicalArtifact.updateOne(
      {
        workspace_id: workspaceId,
        canonical_artifact_key: canonicalArtifactKey,
        status: 'staging',
      },
      { $set: { status: 'failed' } },
    )
  }
}

export interface WorkspaceGridFSReclaimResult {
  scanned: number
  markedPublished: number
  revisionsRemoved: number
  blobsRemoved: number
  deferred: number
}

/**
 * Reclaim GridFS uploads belonging to terminal file-set reservations that did
 * not publish their new path. The GridFS metadata itself is the durable cleanup
 * intent, so crashes between upload, head CAS, abort, and deletion are repaired
 * on a later sweep. Every delete is preceded by both head/revision reference
 * checks; retained immutable history always wins over space reclamation.
 */
export async function reclaimUnreferencedWorkspaceGridFS(
  limit = 200,
  now = new Date(),
): Promise<WorkspaceGridFSReclaimResult> {
  await connectDB()
  const result: WorkspaceGridFSReclaimResult = {
    scanned: 0,
    markedPublished: 0,
    revisionsRemoved: 0,
    blobsRemoved: 0,
    deferred: 0,
  }
  const db = mongoose.connection.db
  if (!db) return result
  const files = await db.collection('workspace_files.files').find({
    'metadata.fileSetState': 'staged',
    'metadata.capacityReservationId': { $type: 'string' },
    'metadata.workspaceId': { $type: 'string' },
    'metadata.workspacePath': { $type: 'string' },
  }).sort({ uploadDate: 1 }).limit(Math.max(1, Math.min(2_000, Math.floor(limit)))).toArray()
  const bucket = new mongoose.mongo.GridFSBucket(db, { bucketName: 'workspace_files' })
  // Preserve unreachable immutable revisions for a bounded audit/debug window.
  // Bytes with no revision at all (upload-before-head crash) remain eligible
  // immediately once their reservation is terminal.
  const revisionRetentionCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1_000)

  for (const file of files) {
    result.scanned += 1
    const workspaceId = String(file.metadata?.workspaceId || '')
    const reservationId = String(file.metadata?.capacityReservationId || '')
    const path = String(file.metadata?.workspacePath || '')
    const capacity = await WorkspaceCapacity.findOne({ workspace_id: workspaceId }).lean()
    const reservation = capacity?.reservations?.find(item => item.reservation_id === reservationId)
    if (capacity?.published_paths?.includes(path)) {
      await db.collection('workspace_files.files').updateOne(
        { _id: file._id, 'metadata.fileSetState': 'staged' },
        { $set: { 'metadata.fileSetState': 'published' } },
      )
      result.markedPublished += 1
      continue
    }
    if (!reservation || reservation.status === 'reserved' || !reservation.new_paths.includes(path)) {
      result.deferred += 1
      continue
    }

    const objectId = file._id.toString()
    const revisions = await WorkspaceFileRevision.find({
      workspace_id: workspaceId,
      capacity_reservation_id: reservationId,
      'storage_ref.driver': 'gridfs',
      'storage_ref.object_id': objectId,
    }).select({ version_id: 1, created_at: 1 }).lean()
    let retainedYoungRevision = false
    for (const revision of revisions) {
      const isHead = await WorkspaceFile.exists({ current_version_id: revision.version_id })
      if (isHead) continue
      if (revision.created_at > revisionRetentionCutoff) {
        retainedYoungRevision = true
        continue
      }
      const removed = await WorkspaceFileRevision.deleteOne({
        version_id: revision.version_id,
        workspace_id: workspaceId,
        capacity_reservation_id: reservationId,
      })
      result.revisionsRemoved += removed.deletedCount
    }
    if (retainedYoungRevision) {
      result.deferred += 1
      continue
    }
    const retainedRevision = await WorkspaceFileRevision.exists({
      'storage_ref.driver': 'gridfs',
      'storage_ref.object_id': objectId,
    })
    if (retainedRevision) {
      await db.collection('workspace_files.files').updateOne(
        { _id: file._id },
        { $set: { 'metadata.fileSetState': 'retained' } },
      )
      result.deferred += 1
      continue
    }
    try {
      await bucket.delete(file._id)
      result.blobsRemoved += 1
    } catch (error) {
      if (!(error instanceof Error) || !/FileNotFound/i.test(error.message)) throw error
    }
  }
  return result
}
