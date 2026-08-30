import { createHash } from 'node:crypto'
import { readFileFromGridFSAsBuffer } from '../../db/gridfs'
import { readImageAsset } from '../../media/storage'
import {
  isDocumentFileEntry,
  isRasterFileEntry,
  type FileEntry,
  type WorkspaceFileMutationContext,
  type WorkspaceFileSetLease,
  type WorkspaceFileMutation,
} from '../types'
import {
  assertWorkspaceWritePath,
  isManagedLiteratureArtifactPath,
  normalizeWorkspacePath,
} from '../path-policy'
import {
  WorkspaceExecutionFenceError,
  WorkspaceRevisionConflictError,
} from './errors'
import { MultiAgentWorkspaceRepository } from './repository'
import type {
  WorkspaceActor,
  WorkspaceFileMetadata,
  WorkspaceFileSnapshot,
  WorkspaceFileVisibility,
  WorkspaceStorageRef,
  WorkspaceWriterProvenance,
} from './types'

const TEXT_MIME_BY_EXTENSION: Record<string, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  jsonl: 'application/x-ndjson',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/tsx',
  jsx: 'text/jsx',
  csv: 'text/csv',
}

function cloneEntry<T extends FileEntry>(entry: T): T {
  return structuredClone(entry)
}

function extension(path: string): string {
  return path.split('.').pop()?.toLowerCase() || ''
}

function textMime(path: string, entry: FileEntry): string {
  return ('mime_type' in entry && entry.mime_type)
    || TEXT_MIME_BY_EXTENSION[extension(path)]
    || 'text/plain'
}

function storageRef(entry: FileEntry): WorkspaceStorageRef {
  if (isRasterFileEntry(entry)) {
    return { driver: 'asset', asset_id: entry.asset_id, variant: 'model' }
  }
  return { driver: 'gridfs', object_id: entry.gridfs_id }
}

function sameStorageRef(left: WorkspaceStorageRef, right: WorkspaceStorageRef): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function privateOwner(path: string): string | undefined {
  return /^\.sci-pegasus\/agents\/([^/]+)\//.exec(normalizeWorkspacePath(path))?.[1]
}

function isVersionArchivePath(path: string): boolean {
  return path.startsWith('.sci-pegasus/versions/')
    || /^\.sci-pegasus\/agents\/[^/]+\/\.versions\//.test(path)
}

/** Literature-service outputs are immutable shared assets, not ordinary public notes. */
export function isManagedReferenceWorkspacePath(pathInput: string): boolean {
  return isManagedLiteratureArtifactPath(pathInput)
}

function accessForPath(
  path: string,
): { visibility: WorkspaceFileVisibility; ownerAgentId?: string; canonicalArtifactKey?: string } {
  const ownerAgentId = privateOwner(path)
  if (ownerAgentId) {
    return { visibility: 'agent_private', ownerAgentId }
  }
  if (isManagedReferenceWorkspacePath(path)) {
    return {
      visibility: 'managed_reference',
      canonicalArtifactKey: `workspace-path:${path}`,
    }
  }
  return { visibility: 'public' }
}

function snapshotMatches(
  snapshot: WorkspaceFileSnapshot,
  descriptor: {
    storageRef: WorkspaceStorageRef
    metadata: WorkspaceFileMetadata
    visibility: WorkspaceFileVisibility
    ownerAgentId?: string
    canonicalArtifactKey?: string
  },
): boolean {
  return sameStorageRef(snapshot.storage_ref, descriptor.storageRef)
    && snapshot.metadata.sha256 === descriptor.metadata.sha256
    && snapshot.metadata.size_bytes === descriptor.metadata.size_bytes
    && snapshot.metadata.mime_type === descriptor.metadata.mime_type
    && snapshot.visibility === descriptor.visibility
    && snapshot.owner_agent_id === descriptor.ownerAgentId
    && snapshot.canonical_artifact_key === descriptor.canonicalArtifactKey
}

function sameWriter(
  left: WorkspaceWriterProvenance,
  right: WorkspaceWriterProvenance,
): boolean {
  return left.team_id === right.team_id
    && left.agent_id === right.agent_id
    && left.task_id === right.task_id
    && left.run_id === right.run_id
    && left.execution_fence_token === right.execution_fence_token
}

export type WorkspaceEntryBytesReader = (
  path: string,
  entry: FileEntry,
) => Promise<Buffer | null>

export const readWorkspaceEntryBytes: WorkspaceEntryBytesReader = async (_path, entry) => {
  if (isRasterFileEntry(entry)) {
    return (await readImageAsset(entry.asset_id, 'model'))?.buffer ?? null
  }
  return readFileFromGridFSAsBuffer(entry.gridfs_id)
}

async function metadataForEntry(
  path: string,
  entry: FileEntry,
  readEntryBytes: WorkspaceEntryBytesReader,
  suppliedBytes?: Buffer,
): Promise<WorkspaceFileMetadata> {
  const bytes = isRasterFileEntry(entry)
    ? await readEntryBytes(path, entry)
    : suppliedBytes ?? await readEntryBytes(path, entry)

  if (isDocumentFileEntry(entry)) {
    return {
      kind: 'document',
      mime_type: entry.mime_type,
      size_bytes: suppliedBytes?.byteLength ?? entry.size_bytes,
      sha256: suppliedBytes
        ? createHash('sha256').update(suppliedBytes).digest('hex')
        : entry.sha256,
      filename: entry.filename,
      note: entry.note,
    }
  }

  if (!bytes) throw new Error(`Cannot calculate immutable Workspace metadata for ${path}`)
  const kind = isRasterFileEntry(entry)
    || (textMime(path, entry).startsWith('image/') && textMime(path, entry) !== 'image/svg+xml')
    ? 'raster'
    : 'text'
  return {
    kind,
    mime_type: textMime(path, entry),
    size_bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    note: entry.note,
  }
}

function timestamps(snapshot: WorkspaceFileSnapshot): Pick<FileEntry, 'version' | 'created_at' | 'updated_at'> {
  return {
    version: snapshot.revision,
    created_at: snapshot.created_at.toISOString(),
    updated_at: snapshot.updated_at.toISOString(),
  }
}

/** Convert an authoritative head back into the legacy Conversation projection. */
export function workspaceFileSnapshotToFileEntry(
  snapshot: WorkspaceFileSnapshot,
  fallback?: FileEntry,
): FileEntry {
  const common = {
    note: snapshot.metadata.note || '',
    ...timestamps(snapshot),
  }
  if (snapshot.storage_ref.driver === 'asset') {
    const rasterFallback = fallback && isRasterFileEntry(fallback) ? fallback : undefined
    return {
      storage: 'asset',
      kind: 'raster',
      asset_id: snapshot.storage_ref.asset_id,
      mime_type: snapshot.metadata.mime_type,
      width: rasterFallback?.width ?? 0,
      height: rasterFallback?.height ?? 0,
      size_bytes: snapshot.metadata.size_bytes,
      ...common,
    }
  }
  if (snapshot.storage_ref.driver !== 'gridfs') {
    throw new Error(`Legacy Workspace projection does not support ${snapshot.storage_ref.driver} storage`)
  }
  if (snapshot.metadata.kind === 'document') {
    const documentFallback = fallback && isDocumentFileEntry(fallback) ? fallback : undefined
    return {
      storage: 'gridfs',
      kind: 'document',
      gridfs_id: snapshot.storage_ref.object_id,
      filename: snapshot.metadata.filename || documentFallback?.filename || snapshot.path.split('/').at(-1) || 'document.pdf',
      mime_type: snapshot.metadata.mime_type,
      size_bytes: snapshot.metadata.size_bytes,
      sha256: snapshot.metadata.sha256,
      source: documentFallback?.source ?? { provider: 'workspace' },
      provenance: documentFallback?.provenance ?? { retrieved_at: snapshot.created_at.toISOString() },
      ...common,
    }
  }
  return {
    storage: 'gridfs',
    kind: 'text',
    gridfs_id: snapshot.storage_ref.object_id,
    mime_type: snapshot.metadata.mime_type,
    ...common,
  }
}

interface PreparedMutation {
  mutation: WorkspaceFileMutation
  descriptor: {
    storageRef: WorkspaceStorageRef
    metadata: WorkspaceFileMetadata
    visibility: WorkspaceFileVisibility
    ownerAgentId?: string
    canonicalArtifactKey?: string
  }
  expectedRevision: number | null
  skip: boolean
}

export interface MultiAgentWorkspaceBridgeOptions {
  repository: MultiAgentWorkspaceRepository
  workspaceId: string
  actor: WorkspaceActor
  writer: WorkspaceWriterProvenance | (() => WorkspaceWriterProvenance)
  legacyFiles?: Record<string, FileEntry>
  readEntryBytes?: WorkspaceEntryBytesReader
  /** Test/recovery tuning; production defaults avoid stealing a slow download. */
  fileSetPollMs?: number
  fileSetWaitMs?: number
  fileSetStaleMs?: number
}

export interface MultiAgentWorkspaceBridge {
  /** Merge of legacy entries and authoritative heads, ready for WorkspaceInstance. */
  projectedFiles: Record<string, FileEntry>
  /** Pass directly as WorkspaceInstanceOptions.onFileMutations. */
  onFileMutations(
    mutations: readonly WorkspaceFileMutation[],
    context?: WorkspaceFileMutationContext,
  ): Promise<void>
  onFileSetBegin(paths: readonly string[], idempotencyKey: string): Promise<WorkspaceFileSetLease>
  onFileSetFinalize(reservationId: string): Promise<Record<string, FileEntry>>
  onFileSetAbort(reservationId: string): Promise<Record<string, FileEntry>>
}

/**
 * Bridges the legacy in-memory Workspace API to durable path-level CAS.
 * Existing Conversation entries are registered with capacity immediately but
 * imported into immutable heads only when a path is first mutated.
 */
export async function createMultiAgentWorkspaceBridge(
  options: MultiAgentWorkspaceBridgeOptions,
): Promise<MultiAgentWorkspaceBridge> {
  const {
    repository,
    workspaceId,
    actor,
    readEntryBytes = readWorkspaceEntryBytes,
  } = options
  const fileSetPollMs = Math.max(10, options.fileSetPollMs ?? 100)
  const fileSetWaitMs = Math.max(fileSetPollMs, options.fileSetWaitMs ?? 30_000)
  const fileSetStaleMs = Math.max(fileSetWaitMs, options.fileSetStaleMs ?? 10 * 60_000)
  if (!workspaceId) throw new Error('workspaceId is required')
  const legacyFiles = Object.fromEntries(
    Object.entries(options.legacyFiles ?? {}).map(([path, entry]) => [
      assertWorkspaceWritePath(path),
      cloneEntry(entry),
    ]),
  )
  await repository.initializeCapacity(workspaceId, Object.keys(legacyFiles))

  const projectedFiles: Record<string, FileEntry> = { ...legacyFiles }
  for (const snapshot of await repository.listFiles(workspaceId, actor)) {
    projectedFiles[snapshot.path] = workspaceFileSnapshotToFileEntry(
      snapshot,
      projectedFiles[snapshot.path],
    )
  }

  const currentWriter = (): WorkspaceWriterProvenance => structuredClone(
    typeof options.writer === 'function' ? options.writer() : options.writer,
  )

  async function projectPublished(paths: readonly string[]): Promise<Record<string, FileEntry>> {
    const result: Record<string, FileEntry> = {}
    for (const path of paths) {
      const snapshot = await repository.getFile(workspaceId, path, actor)
      if (!snapshot) continue
      const entry = workspaceFileSnapshotToFileEntry(snapshot, projectedFiles[path])
      projectedFiles[path] = cloneEntry(entry)
      result[path] = cloneEntry(entry)
    }
    return result
  }

  function materializationReservationId(paths: readonly string[], idempotencyKey: string): string {
    const digest = createHash('sha256')
      .update(['literature-file-set', workspaceId, idempotencyKey, ...paths].join('\u0000'))
      .digest('hex')
      .slice(0, 40)
    return `wfs_${digest}`
  }

  async function onFileSetBegin(
    rawPaths: readonly string[],
    idempotencyKey: string,
  ): Promise<WorkspaceFileSetLease> {
    const paths = [...new Set(rawPaths.map(path => assertWorkspaceWritePath(path)))].sort()
    if (!idempotencyKey || idempotencyKey.length > 512) {
      throw new Error('Workspace file-set idempotency key is invalid')
    }
    if (!(await repository.validateExecutionFence(workspaceId, currentWriter()))) {
      throw new WorkspaceExecutionFenceError()
    }
    const reservationId = materializationReservationId(paths, idempotencyKey)
    const deadline = Date.now() + fileSetWaitMs

    while (true) {
      const projected = await projectPublished(paths)
      if (paths.every(path => projected[path])) return { projectedFiles: projected }

      const reservation = await repository.reserveFileSet(workspaceId, reservationId, paths)
      if (reservation.acquired) {
        if (!(await repository.validateExecutionFence(workspaceId, currentWriter()))) {
          await repository.discardFileSet(workspaceId, reservationId)
          throw new WorkspaceExecutionFenceError()
        }
        return { reservationId, projectedFiles: projected }
      }

      const current = await repository.getFileSetReservation(workspaceId, reservationId)
      if (!current || current.status !== 'reserved') continue
      const ageMs = Date.now() - new Date(current.created_at).getTime()
      if (ageMs >= fileSetStaleMs) {
        if (await repository.recoverStaleFileSet(workspaceId, reservationId)) continue
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `The canonical literature materialization is still running; retry after reservation ${reservationId}`,
        )
      }
      await new Promise(resolve => setTimeout(resolve, fileSetPollMs))
    }
  }

  async function onFileSetFinalize(reservationId: string): Promise<Record<string, FileEntry>> {
    const reservation = await repository.getFileSetReservation(workspaceId, reservationId)
    if (!reservation) throw new Error(`Workspace file-set reservation does not exist: ${reservationId}`)
    if (!(await repository.validateExecutionFence(workspaceId, currentWriter()))) {
      throw new WorkspaceExecutionFenceError()
    }
    await repository.finalizeFileSet(workspaceId, reservationId)
    return projectPublished(reservation.requested_paths)
  }

  async function onFileSetAbort(reservationId: string): Promise<Record<string, FileEntry>> {
    const reservation = await repository.getFileSetReservation(workspaceId, reservationId)
    if (!reservation) return {}
    if (!(await repository.validateExecutionFence(workspaceId, currentWriter()))) {
      await repository.discardFileSet(workspaceId, reservationId)
      return {}
    }
    await repository.finalizeAvailableFileSet(workspaceId, reservationId)
    return projectPublished(reservation.requested_paths)
  }

  async function describe(
    path: string,
    entry: FileEntry,
    suppliedBytes?: Buffer,
  ): Promise<PreparedMutation['descriptor']> {
    const access = accessForPath(path)
    return {
      storageRef: storageRef(entry),
      metadata: await metadataForEntry(path, entry, readEntryBytes, suppliedBytes),
      ...access,
    }
  }

  async function importLegacyHead(
    path: string,
    entry: FileEntry,
    descriptor: PreparedMutation['descriptor'],
    writer: WorkspaceWriterProvenance,
  ): Promise<WorkspaceFileSnapshot> {
    const existing = await repository.store.getFile(workspaceId, path)
    if (existing) {
      if (snapshotMatches(existing, descriptor)) return existing
      throw new WorkspaceRevisionConflictError(path, entry.version ?? null, existing.revision)
    }
    try {
      return await repository.commitFile(actor, {
        workspaceId,
        path,
        expectedRevision: null,
        visibility: descriptor.visibility,
        ownerAgentId: descriptor.ownerAgentId,
        storageRef: descriptor.storageRef,
        metadata: descriptor.metadata,
        writer,
        canonicalArtifactKey: descriptor.canonicalArtifactKey,
      })
    } catch (error) {
      const winner = await repository.store.getFile(workspaceId, path)
      if (winner && snapshotMatches(winner, descriptor)) return winner
      throw error
    }
  }

  async function onFileMutations(
    mutations: readonly WorkspaceFileMutation[],
    context?: WorkspaceFileMutationContext,
  ): Promise<void> {
    if (mutations.length === 0) return
    const writer = currentWriter()
    const paths = new Set<string>()
    const prepared: PreparedMutation[] = []
    const recoverableArchiveReservations = new Set<string>()

    for (const raw of mutations) {
      const path = assertWorkspaceWritePath(raw.path)
      if (paths.has(path)) throw new Error(`Duplicate Workspace mutation path: ${path}`)
      paths.add(path)
      const mutation: WorkspaceFileMutation = {
        path,
        entry: cloneEntry(raw.entry),
        previousEntry: raw.previousEntry ? cloneEntry(raw.previousEntry) : undefined,
        contentBytes: raw.contentBytes ? Buffer.from(raw.contentBytes) : undefined,
      }
      const descriptor = await describe(path, mutation.entry, mutation.contentBytes)
      let current = await repository.store.getFile(workspaceId, path)

      if (mutation.previousEntry) {
        const previousDescriptor = await describe(path, mutation.previousEntry)
        if (!current) {
          current = await importLegacyHead(path, mutation.previousEntry, previousDescriptor, writer)
        } else if (!snapshotMatches(current, previousDescriptor)) {
          if (snapshotMatches(current, descriptor) && sameWriter(current.writer, writer)) {
            prepared.push({ mutation, descriptor, expectedRevision: current.revision, skip: true })
            continue
          }
          throw new WorkspaceRevisionConflictError(path, mutation.previousEntry.version ?? null, current.revision)
        }
      } else if (current) {
        if (
          snapshotMatches(current, descriptor)
          && (sameWriter(current.writer, writer) || isVersionArchivePath(path))
        ) {
          if (isVersionArchivePath(path) && current.capacity_reservation_id) {
            recoverableArchiveReservations.add(current.capacity_reservation_id)
          }
          prepared.push({ mutation, descriptor, expectedRevision: current.revision, skip: true })
          continue
        }
        throw new WorkspaceRevisionConflictError(path, null, current.revision)
      }

      prepared.push({
        mutation,
        descriptor,
        expectedRevision: current?.revision ?? null,
        skip: false,
      })
    }

    const newPaths = prepared
      .filter(item => !item.skip && item.expectedRevision === null)
      .map(item => item.mutation.path)
    let reservationId = context?.reservationId
    const externallyReserved = Boolean(reservationId)
    let internalReservationCreated = false
    if (newPaths.length > 0 && !reservationId) {
      const digest = createHash('sha256')
        .update([
          workspaceId,
          writer.run_id,
          writer.execution_fence_token,
          ...prepared.map(item => `${item.mutation.path}:${item.descriptor.metadata.sha256}`),
        ].join('\u0000'))
        .digest('hex')
        .slice(0, 40)
      reservationId = `wsb_${digest}`
      await repository.reserveFileSet(workspaceId, reservationId, prepared.map(item => item.mutation.path))
      internalReservationCreated = true
    }

    try {
      for (const item of prepared) {
        if (item.skip) continue
        const latest = await repository.store.getFile(workspaceId, item.mutation.path)
        if ((latest?.revision ?? null) !== item.expectedRevision) {
          if (
            latest
            && snapshotMatches(latest, item.descriptor)
            && (
              sameWriter(latest.writer, writer)
              || isVersionArchivePath(item.mutation.path)
            )
          ) {
            if (isVersionArchivePath(item.mutation.path) && latest.capacity_reservation_id) {
              recoverableArchiveReservations.add(latest.capacity_reservation_id)
            }
            continue
          }
          throw new WorkspaceRevisionConflictError(
            item.mutation.path,
            item.expectedRevision,
            latest?.revision ?? null,
          )
        }
        await repository.commitFile(actor, {
          workspaceId,
          path: item.mutation.path,
          expectedRevision: item.expectedRevision,
          visibility: item.descriptor.visibility,
          ownerAgentId: item.descriptor.ownerAgentId,
          storageRef: item.descriptor.storageRef,
          metadata: item.descriptor.metadata,
          writer,
          reservationId: item.expectedRevision === null ? reservationId : undefined,
          canonicalArtifactKey: item.descriptor.canonicalArtifactKey,
        })
      }

      if (reservationId && !externallyReserved) {
        await repository.finalizeFileSet(workspaceId, reservationId)
      }
      for (const staleReservationId of recoverableArchiveReservations) {
        await repository.finalizeAvailableFileSet(workspaceId, staleReservationId)
      }
    } catch (error) {
      const recoveryErrors: unknown[] = []
      if (reservationId && internalReservationCreated) {
        try {
          await repository.finalizeAvailableFileSet(workspaceId, reservationId)
        } catch (recoveryError) {
          recoveryErrors.push(recoveryError)
        }
      }
      for (const staleReservationId of recoverableArchiveReservations) {
        try {
          await repository.finalizeAvailableFileSet(workspaceId, staleReservationId)
        } catch (recoveryError) {
          recoveryErrors.push(recoveryError)
        }
      }
      if (recoveryErrors.length > 0) {
        throw new AggregateError(
          [error, ...recoveryErrors],
          'Workspace mutation failed and archive reservation recovery did not complete',
        )
      }
      throw error
    }
  }

  return {
    projectedFiles,
    onFileMutations,
    onFileSetBegin,
    onFileSetFinalize,
    onFileSetAbort,
  }
}
