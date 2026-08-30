import { createHash, randomUUID } from 'node:crypto'
import { assertWorkspaceWritePath, normalizeWorkspacePath } from '../path-policy'
import {
  assertWorkspaceReadAllowed,
  assertWorkspaceWriteAllowed,
} from './acl'
import {
  WorkspaceAclError,
  WorkspaceCanonicalArtifactConflictError,
  WorkspaceCapacityError,
  WorkspaceExecutionFenceError,
  WorkspaceReservationConflictError,
  WorkspaceReservationError,
  WorkspaceRevisionConflictError,
  WorkspaceProposalPublicationConflictError,
} from './errors'
import {
  MongooseMultiAgentWorkspaceStore,
  type MultiAgentWorkspaceStore,
} from './store'
import {
  MULTI_AGENT_WORKSPACE_MAX_FILES,
  type CapacityReservation,
  type ManagedReferenceCommitInput,
  type ManagedReferenceCommitResult,
  type ProposalAcceptInput,
  type ProposalAcceptResult,
  type WorkspaceActor,
  type WorkspaceCapacityReservationResult,
  type WorkspaceCapacityState,
  type WorkspaceFenceValidator,
  type WorkspaceFileMetadata,
  type WorkspaceFileSnapshot,
  type WorkspaceFileWrite,
  type WorkspaceProposalPublicationSource,
  type WorkspaceStorageRef,
  type WorkspaceWriterProvenance,
} from './types'

const MAX_CAS_ATTEMPTS = 32
const SHA256 = /^[a-f0-9]{64}$/i

function clone<T>(value: T): T {
  return structuredClone(value)
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

function immutableSnapshot(value: WorkspaceFileSnapshot): WorkspaceFileSnapshot {
  return deepFreeze(clone(value))
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map(path => assertWorkspaceWritePath(path)))].sort()
}

function reservationResult(
  reservation: CapacityReservation,
  acquired: boolean,
): WorkspaceCapacityReservationResult {
  return {
    reservationId: reservation.reservation_id,
    requestedPaths: [...reservation.requested_paths],
    newPaths: [...reservation.new_paths],
    status: reservation.status,
    acquired,
  }
}

function validateMetadata(metadata: WorkspaceFileMetadata): void {
  if (!['text', 'document', 'raster', 'artifact'].includes(metadata.kind)) {
    throw new Error('Workspace file metadata.kind is invalid')
  }
  if (!metadata.mime_type || metadata.mime_type.length > 255 || /\p{Cc}/u.test(metadata.mime_type)) {
    throw new Error('Workspace file metadata.mime_type is invalid')
  }
  if (!Number.isSafeInteger(metadata.size_bytes) || metadata.size_bytes < 0) {
    throw new Error('Workspace file metadata.size_bytes must be a non-negative integer')
  }
  if (!SHA256.test(metadata.sha256)) throw new Error('Workspace file metadata.sha256 is invalid')
  if (metadata.filename && (metadata.filename.length > 255 || /[\\/\p{Cc}]/u.test(metadata.filename))) {
    throw new Error('Workspace file metadata.filename is invalid')
  }
  if (metadata.note && metadata.note.length > 4096) throw new Error('Workspace file metadata.note is too long')
}

function validateStorageRef(ref: WorkspaceStorageRef): void {
  const value = ref.driver === 'gridfs'
    ? ref.object_id
    : ref.driver === 'asset'
      ? ref.asset_id
      : ref.storage_key
  if (!value || value.length > 2048 || /\p{Cc}/u.test(value)) {
    throw new Error('Workspace storage reference is invalid')
  }
  if (ref.driver === 'object' && /^[a-z]+:\/\//i.test(ref.storage_key)) {
    throw new Error('Object storage references must be stable keys, not URLs')
  }
}

function validateWriter(actor: WorkspaceActor, writer: WorkspaceWriterProvenance): void {
  if (writer.team_id !== actor.teamId || writer.agent_id !== actor.agentId) {
    throw new WorkspaceAclError('Workspace writer provenance does not match the acting Agent')
  }
  if (!writer.run_id || !writer.execution_fence_token) {
    throw new Error('Workspace writes require run and execution fence provenance')
  }
}

function sameFileContent(
  file: WorkspaceFileSnapshot,
  input: Pick<
    WorkspaceFileWrite,
    'storageRef' | 'metadata' | 'canonicalArtifactKey' | 'publicationKey' | 'publicationSource'
  >,
): boolean {
  return JSON.stringify(file.storage_ref) === JSON.stringify(input.storageRef)
    && file.metadata.sha256 === input.metadata.sha256
    && file.canonical_artifact_key === input.canonicalArtifactKey
    && file.publication_key === input.publicationKey
    && JSON.stringify(file.publication_source) === JSON.stringify(input.publicationSource)
}

function validatePublication(
  visibility: WorkspaceFileWrite['visibility'],
  publicationKey: string | undefined,
  publicationSource: WorkspaceProposalPublicationSource | undefined,
): void {
  if (Boolean(publicationKey) !== Boolean(publicationSource)) {
    throw new WorkspaceProposalPublicationConflictError(
      publicationKey ?? 'missing',
      'Proposal publication key and source identity must be provided together',
    )
  }
  if (!publicationKey || !publicationSource) return
  if (visibility !== 'public') {
    throw new WorkspaceAclError('Proposal publication identity is only valid for public files')
  }
  if (publicationKey.length > 512 || /\p{Cc}/u.test(publicationKey)) {
    throw new WorkspaceProposalPublicationConflictError(publicationKey, 'Proposal publication key is invalid')
  }
  if (
    !publicationSource.path
    || !Number.isSafeInteger(publicationSource.revision)
    || publicationSource.revision < 1
    || !publicationSource.version_id
    || !SHA256.test(publicationSource.sha256)
  ) {
    throw new WorkspaceProposalPublicationConflictError(
      publicationKey,
      'Proposal publication source identity is invalid',
    )
  }
}

function proposalPublicationMatches(
  file: WorkspaceFileSnapshot | null,
  publicationKey: string,
  source: WorkspaceFileSnapshot,
): boolean {
  return Boolean(file
    && file.publication_key === publicationKey
    && file.publication_source?.path === source.path
    && file.publication_source.revision === source.revision
    && file.publication_source.version_id === source.version_id
    && file.publication_source.sha256 === source.metadata.sha256
    && JSON.stringify(file.storage_ref) === JSON.stringify(source.storage_ref)
    && file.metadata.sha256 === source.metadata.sha256)
}

function deterministicReservationId(namespace: string, ...values: string[]): string {
  const digest = createHash('sha256').update([namespace, ...values].join('\u0000')).digest('hex').slice(0, 32)
  return `wsr_${digest}`
}

export interface MultiAgentWorkspaceRepositoryOptions {
  store?: MultiAgentWorkspaceStore
  maxFiles?: number
  fenceValidator?: WorkspaceFenceValidator
  now?: () => Date
  versionId?: () => string
}

/**
 * Multi-Agent Workspace control plane. Blob writes happen before this layer;
 * this repository atomically publishes immutable references to those blobs.
 */
export class MultiAgentWorkspaceRepository {
  readonly store: MultiAgentWorkspaceStore
  private readonly maxFiles: number
  private readonly fenceValidator: WorkspaceFenceValidator
  private readonly now: () => Date
  private readonly versionId: () => string

  constructor(options: MultiAgentWorkspaceRepositoryOptions = {}) {
    this.store = options.store ?? new MongooseMultiAgentWorkspaceStore()
    this.maxFiles = options.maxFiles ?? MULTI_AGENT_WORKSPACE_MAX_FILES
    this.fenceValidator = options.fenceValidator ?? (() => true)
    this.now = options.now ?? (() => new Date())
    this.versionId = options.versionId ?? (() => `wfver_${randomUUID()}`)
    if (!Number.isSafeInteger(this.maxFiles) || this.maxFiles < 1) {
      throw new Error('Workspace maxFiles must be a positive integer')
    }
  }

  /** Migration/bootstrap seam for importing paths from the legacy workspace index. */
  async initializeCapacity(
    workspaceId: string,
    publishedPaths: readonly string[] = [],
  ): Promise<WorkspaceCapacityState> {
    if (!workspaceId) throw new Error('workspaceId is required')
    const paths = uniquePaths(publishedPaths)
    if (paths.length > this.maxFiles) throw new WorkspaceCapacityError(this.maxFiles, paths.length)
    return this.store.createCapacityIfMissing({
      workspace_id: workspaceId,
      max_files: this.maxFiles,
      revision: 0,
      published_paths: paths,
      reservations: [],
    })
  }

  private async capacity(workspaceId: string): Promise<WorkspaceCapacityState> {
    return (await this.store.getCapacity(workspaceId)) ?? this.initializeCapacity(workspaceId)
  }

  async reserveFileSet(
    workspaceId: string,
    reservationId: string,
    requestedPaths: readonly string[],
  ): Promise<WorkspaceCapacityReservationResult> {
    if (!reservationId || reservationId.length > 256) throw new Error('reservationId is invalid')
    const paths = uniquePaths(requestedPaths)
    if (paths.length === 0) throw new WorkspaceReservationError('A reservation must contain at least one path')

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.capacity(workspaceId)
      const existingIndex = current.reservations.findIndex(item => item.reservation_id === reservationId)
      const existing = existingIndex >= 0 ? current.reservations[existingIndex] : undefined
      if (existing) {
        if (!sameStrings(existing.requested_paths, paths)) {
          throw new WorkspaceReservationError('reservationId was already used for a different path set')
        }
        if (existing.status === 'reserved') return reservationResult(existing, false)

        // A failed/partial owner finalizes the durable subset. A later retry
        // may revive the same deterministic reservation for only the paths
        // that are still absent, without spending capacity twice.
        const published = new Set(current.published_paths)
        const newPaths = paths.filter(path => !published.has(path))
        if (newPaths.length === 0) return reservationResult(existing, false)
        const reservedByOthers = new Set(
          current.reservations
            .filter((item, index) => index !== existingIndex && item.status === 'reserved')
            .flatMap(item => item.new_paths),
        )
        const collisions = newPaths.filter(path => reservedByOthers.has(path))
        if (collisions.length > 0) throw new WorkspaceReservationConflictError(collisions)
        if (published.size + reservedByOthers.size + newPaths.length > current.max_files) {
          throw new WorkspaceCapacityError(current.max_files, newPaths.length)
        }
        const revived: CapacityReservation = {
          reservation_id: reservationId,
          requested_paths: paths,
          new_paths: newPaths,
          status: 'reserved',
          created_at: this.now(),
        }
        const reservations = clone(current.reservations)
        reservations[existingIndex] = revived
        const next = { ...clone(current), revision: current.revision + 1, reservations }
        if (await this.store.compareAndSwapCapacity(current.revision, next)) {
          return reservationResult(revived, true)
        }
        continue
      }

      const published = new Set(current.published_paths)
      const reservedByOthers = new Set(
        current.reservations
          .filter(item => item.status === 'reserved')
          .flatMap(item => item.new_paths),
      )
      const collisions = paths.filter(path => !published.has(path) && reservedByOthers.has(path))
      if (collisions.length > 0) throw new WorkspaceReservationConflictError(collisions)

      const newPaths = paths.filter(path => !published.has(path))
      if (published.size + reservedByOthers.size + newPaths.length > current.max_files) {
        throw new WorkspaceCapacityError(current.max_files, newPaths.length)
      }

      const reservation: CapacityReservation = {
        reservation_id: reservationId,
        requested_paths: paths,
        new_paths: newPaths,
        status: 'reserved',
        created_at: this.now(),
      }
      const next: WorkspaceCapacityState = {
        ...clone(current),
        revision: current.revision + 1,
        reservations: [...clone(current.reservations), reservation],
      }
      if (await this.store.compareAndSwapCapacity(current.revision, next)) {
        return reservationResult(reservation, true)
      }
    }
    throw new WorkspaceReservationError('Capacity reservation contention exceeded the retry limit')
  }

  async getFileSetReservation(
    workspaceId: string,
    reservationId: string,
  ): Promise<CapacityReservation | null> {
    const current = await this.capacity(workspaceId)
    const reservation = current.reservations.find(item => item.reservation_id === reservationId)
    return reservation ? clone(reservation) : null
  }

  async releaseFileSet(workspaceId: string, reservationId: string): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.capacity(workspaceId)
      const index = current.reservations.findIndex(item => item.reservation_id === reservationId)
      if (index < 0) return false
      const reservation = current.reservations[index]
      if (reservation.status === 'released') return true
      if (reservation.status === 'finalized') {
        throw new WorkspaceReservationError('A finalized reservation cannot be released')
      }
      for (const path of reservation.new_paths) {
        const file = await this.store.getFile(workspaceId, path)
        if (file?.capacity_reservation_id === reservationId) {
          throw new WorkspaceReservationError(
            `A reservation with staged files must be resumed or finalized, not released: ${path}`,
          )
        }
      }
      const reservations = clone(current.reservations)
      reservations[index] = { ...reservations[index], status: 'released', released_at: this.now() }
      const next = { ...clone(current), revision: current.revision + 1, reservations }
      if (await this.store.compareAndSwapCapacity(current.revision, next)) return true
    }
    throw new WorkspaceReservationError('Reservation release contention exceeded the retry limit')
  }

  async finalizeFileSet(workspaceId: string, reservationId: string): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.capacity(workspaceId)
      const index = current.reservations.findIndex(item => item.reservation_id === reservationId)
      if (index < 0) throw new WorkspaceReservationError('Capacity reservation does not exist')
      const reservation = current.reservations[index]
      if (reservation.status === 'finalized') {
        await this.store.markFileSetPublished?.(workspaceId, reservationId)
        return true
      }
      if (reservation.status === 'released') {
        throw new WorkspaceReservationError('A released reservation cannot be finalized')
      }

      for (const path of reservation.new_paths) {
        const file = await this.store.getFile(workspaceId, path)
        if (!file || file.capacity_reservation_id !== reservationId) {
          throw new WorkspaceReservationError(`Reserved path has not been staged: ${path}`)
        }
      }

      const reservations = clone(current.reservations)
      reservations[index] = { ...reservations[index], status: 'finalized', finalized_at: this.now() }
      const next: WorkspaceCapacityState = {
        ...clone(current),
        revision: current.revision + 1,
        published_paths: [...new Set([...current.published_paths, ...reservation.new_paths])].sort(),
        reservations,
      }
      if (await this.store.compareAndSwapCapacity(current.revision, next)) {
        await this.store.markFileSetPublished?.(workspaceId, reservationId)
        return true
      }
    }
    throw new WorkspaceReservationError('Reservation finalization contention exceeded the retry limit')
  }

  /**
   * Crash/failure recovery boundary. Every staged path becomes visible and
   * every unused slot is released in the same capacity CAS.
   */
  async finalizeAvailableFileSet(workspaceId: string, reservationId: string): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.capacity(workspaceId)
      const index = current.reservations.findIndex(item => item.reservation_id === reservationId)
      if (index < 0) throw new WorkspaceReservationError('Capacity reservation does not exist')
      const reservation = current.reservations[index]
      if (reservation.status === 'finalized') return true
      if (reservation.status === 'released') return true

      const stagedPaths: string[] = []
      for (const path of reservation.new_paths) {
        const file = await this.store.getFile(workspaceId, path)
        if (file?.capacity_reservation_id === reservationId) stagedPaths.push(path)
      }
      const reservations = clone(current.reservations)
      reservations[index] = {
        ...reservations[index],
        status: 'finalized',
        finalized_at: this.now(),
      }
      const next: WorkspaceCapacityState = {
        ...clone(current),
        revision: current.revision + 1,
        published_paths: [...new Set([...current.published_paths, ...stagedPaths])].sort(),
        reservations,
      }
      if (await this.store.compareAndSwapCapacity(current.revision, next)) return true
    }
    throw new WorkspaceReservationError('Partial reservation finalization contention exceeded the retry limit')
  }

  /** Drop unpublished heads from a stale executor, then release the set capacity. */
  async discardFileSet(workspaceId: string, reservationId: string): Promise<boolean> {
    await this.store.deleteStagedFiles(workspaceId, reservationId)
    return this.finalizeAvailableFileSet(workspaceId, reservationId)
  }

  /**
   * Recover only when every staged writer has lost its execution fence. A slow
   * but still-live owner is never stolen merely because wall-clock time passed.
   */
  async recoverStaleFileSet(workspaceId: string, reservationId: string): Promise<boolean> {
    const reservation = await this.getFileSetReservation(workspaceId, reservationId)
    if (!reservation || reservation.status !== 'reserved') return true
    const staged = (await this.store.listFiles(workspaceId)).filter(
      file => file.capacity_reservation_id === reservationId,
    )
    if (staged.length === 0) {
      await this.finalizeAvailableFileSet(workspaceId, reservationId)
      return true
    }
    const validity = await Promise.all(staged.map(file => this.fenceValidator({
      workspaceId,
      writer: clone(file.writer),
    })))
    if (validity.some(Boolean)) return false
    await this.discardFileSet(workspaceId, reservationId)
    return true
  }

  async validateExecutionFence(
    workspaceId: string,
    writer: WorkspaceWriterProvenance,
  ): Promise<boolean> {
    return this.fenceValidator({ workspaceId, writer: clone(writer) })
  }

  private async assertFence(workspaceId: string, writer: WorkspaceWriterProvenance): Promise<void> {
    if (!(await this.fenceValidator({ workspaceId, writer: clone(writer) }))) {
      throw new WorkspaceExecutionFenceError()
    }
  }

  private async isPublished(workspaceId: string, path: string): Promise<boolean> {
    const state = await this.capacity(workspaceId)
    return state.published_paths.includes(path)
  }

  async getFile(
    workspaceId: string,
    pathInput: string,
    actor: WorkspaceActor,
  ): Promise<WorkspaceFileSnapshot | null> {
    const path = normalizeWorkspacePath(pathInput)
    if (!(await this.isPublished(workspaceId, path))) return null
    const file = await this.store.getFile(workspaceId, path)
    if (!file) return null
    assertWorkspaceReadAllowed(actor, file)
    return immutableSnapshot(file)
  }

  async listFiles(workspaceId: string, actor: WorkspaceActor): Promise<WorkspaceFileSnapshot[]> {
    const state = await this.capacity(workspaceId)
    const published = new Set(state.published_paths)
    const files = await this.store.listFiles(workspaceId)
    return files
      .filter(file => published.has(file.path))
      .filter(file => {
        try {
          assertWorkspaceReadAllowed(actor, file)
          return true
        } catch (error) {
          if (error instanceof WorkspaceAclError) return false
          throw error
        }
      })
      .map(immutableSnapshot)
  }

  private async reservationForPath(
    workspaceId: string,
    reservationId: string,
    path: string,
  ): Promise<CapacityReservation> {
    const state = await this.capacity(workspaceId)
    const reservation = state.reservations.find(item => item.reservation_id === reservationId)
    if (!reservation || reservation.status !== 'reserved' || !reservation.requested_paths.includes(path)) {
      throw new WorkspaceReservationError('Write path is not covered by an active capacity reservation')
    }
    return reservation
  }

  async commitFile(actor: WorkspaceActor, input: WorkspaceFileWrite): Promise<WorkspaceFileSnapshot> {
    if (input.workspaceId.length === 0) throw new Error('workspaceId is required')
    const path = assertWorkspaceWriteAllowed({
      actor,
      path: input.path,
      visibility: input.visibility,
      ownerAgentId: input.ownerAgentId,
    })
    validateWriter(actor, input.writer)
    validateMetadata(input.metadata)
    validateStorageRef(input.storageRef)
    if (input.canonicalArtifactKey && input.visibility !== 'managed_reference') {
      throw new WorkspaceAclError('Canonical artifact keys are reserved for managed references')
    }
    validatePublication(input.visibility, input.publicationKey, input.publicationSource)

    // Validate once before reserving capacity so a known-stale executor cannot
    // consume slots, then again at the publication CAS boundary.
    await this.assertFence(input.workspaceId, input.writer)

    let reservationId = input.reservationId
    let autoReservation = false
    if (input.expectedRevision === null && !reservationId) {
      reservationId = deterministicReservationId(
        'single-file',
        input.workspaceId,
        path,
        input.writer.run_id,
        input.writer.execution_fence_token,
        input.metadata.sha256,
      )
      await this.reserveFileSet(input.workspaceId, reservationId, [path])
      autoReservation = true
    } else if (reservationId) {
      await this.reservationForPath(input.workspaceId, reservationId, path)
    }

    const existing = await this.store.getFile(input.workspaceId, path)
    if (
      input.expectedRevision === null
      && reservationId
      && existing?.capacity_reservation_id === reservationId
      && sameFileContent(existing, input)
    ) {
      if (autoReservation) await this.finalizeFileSet(input.workspaceId, reservationId)
      return immutableSnapshot(existing)
    }

    try {
      await this.assertFence(input.workspaceId, input.writer)
    } catch (error) {
      if (autoReservation) await this.releaseFileSet(input.workspaceId, reservationId!)
      throw error
    }
    const now = this.now()
    const candidate: WorkspaceFileSnapshot = {
      workspace_id: input.workspaceId,
      path,
      revision: (input.expectedRevision ?? 0) + 1,
      version_id: this.versionId(),
      visibility: input.visibility,
      owner_agent_id: input.ownerAgentId,
      storage_ref: clone(input.storageRef),
      metadata: clone(input.metadata),
      writer: clone(input.writer),
      canonical_artifact_key: input.canonicalArtifactKey,
      publication_key: input.publicationKey,
      publication_source: input.publicationSource ? clone(input.publicationSource) : undefined,
      capacity_reservation_id: reservationId,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    }
    const result = await this.store.compareAndSwapFile(input.expectedRevision, candidate)
    if (!result.committed) {
      const winner = await this.store.getFile(input.workspaceId, path)
      if (
        autoReservation
        && winner
        && winner.capacity_reservation_id === reservationId
        && sameFileContent(winner, input)
      ) {
        await this.finalizeFileSet(input.workspaceId, reservationId!)
        return immutableSnapshot(winner)
      }
      if (autoReservation && winner?.capacity_reservation_id !== reservationId) {
        await this.releaseFileSet(input.workspaceId, reservationId!)
      }
      throw new WorkspaceRevisionConflictError(
        path,
        input.expectedRevision,
        result.actualRevision,
      )
    }

    if (autoReservation) await this.finalizeFileSet(input.workspaceId, reservationId!)
    return immutableSnapshot(candidate)
  }

  async commitManagedReference(
    actor: WorkspaceActor,
    input: ManagedReferenceCommitInput,
  ): Promise<ManagedReferenceCommitResult> {
    const path = assertWorkspaceWriteAllowed({
      actor,
      path: input.path,
      visibility: 'managed_reference',
    })
    validateWriter(actor, input.writer)
    validateMetadata(input.metadata)
    validateStorageRef(input.storageRef)
    await this.assertFence(input.workspaceId, input.writer)
    if (!input.canonicalArtifactKey || input.canonicalArtifactKey.length > 512) {
      throw new Error('canonicalArtifactKey is invalid')
    }
    if (!input.idempotencyKey || input.idempotencyKey.length > 512) {
      throw new Error('idempotencyKey is invalid')
    }

    const now = this.now()
    const claim = await this.store.claimCanonicalArtifact({
      workspace_id: input.workspaceId,
      canonical_artifact_key: input.canonicalArtifactKey,
      idempotency_key: input.idempotencyKey,
      path,
      content_sha256: input.metadata.sha256,
      status: 'staging',
      created_at: now,
      updated_at: now,
    })
    if (
      claim.record.path !== path
      || claim.record.content_sha256 !== input.metadata.sha256
    ) {
      throw new WorkspaceCanonicalArtifactConflictError(input.canonicalArtifactKey)
    }

    const published = await this.getFile(input.workspaceId, path, actor)
    if (
      claim.record.status === 'published'
      && published?.canonical_artifact_key === input.canonicalArtifactKey
      && published.metadata.sha256 === input.metadata.sha256
    ) {
      return { file: published, created: false }
    }

    const reservationId = deterministicReservationId(
      'canonical-artifact',
      input.workspaceId,
      input.canonicalArtifactKey,
    )
    await this.reserveFileSet(input.workspaceId, reservationId, [path])

    let file = await this.store.getFile(input.workspaceId, path)
    let created = false
    if (file) {
      if (
        file.canonical_artifact_key !== input.canonicalArtifactKey
        || file.metadata.sha256 !== input.metadata.sha256
      ) {
        throw new WorkspaceCanonicalArtifactConflictError(input.canonicalArtifactKey)
      }
    } else {
      try {
        file = await this.commitFile(actor, {
          workspaceId: input.workspaceId,
          path,
          expectedRevision: null,
          visibility: 'managed_reference',
          storageRef: input.storageRef,
          metadata: input.metadata,
          writer: input.writer,
          reservationId,
          canonicalArtifactKey: input.canonicalArtifactKey,
        })
        created = true
      } catch (error) {
        if (!(error instanceof WorkspaceRevisionConflictError)) throw error
        file = await this.store.getFile(input.workspaceId, path)
        if (
          !file
          || file.canonical_artifact_key !== input.canonicalArtifactKey
          || file.metadata.sha256 !== input.metadata.sha256
        ) {
          throw new WorkspaceCanonicalArtifactConflictError(input.canonicalArtifactKey)
        }
      }
    }

    await this.finalizeFileSet(input.workspaceId, reservationId)
    await this.store.markCanonicalArtifactPublished(
      input.workspaceId,
      input.canonicalArtifactKey,
      file.revision,
    )
    return { file: immutableSnapshot(file), created }
  }

  async acceptProposalItem(input: ProposalAcceptInput): Promise<ProposalAcceptResult> {
    if (input.actor.role !== 'root') throw new WorkspaceAclError('Only the root Agent may review proposals')
    if (!input.publicationKey || input.publicationKey.length > 512 || /\p{Cc}/u.test(input.publicationKey)) {
      throw new WorkspaceProposalPublicationConflictError(
        input.publicationKey || 'missing',
        'Proposal publication key is invalid',
      )
    }
    if (
      input.expectedTargetRevision !== null
      && (!Number.isSafeInteger(input.expectedTargetRevision) || input.expectedTargetRevision < 0)
    ) {
      throw new WorkspaceRevisionConflictError(input.targetPath, input.expectedTargetRevision, null)
    }
    await this.assertFence(input.workspaceId, input.writer)
    const source = await this.getFile(input.workspaceId, input.sourcePath, input.actor)
    if (!source || source.visibility !== 'agent_private') {
      throw new WorkspaceAclError('Proposal source must be a published Agent-private file')
    }
    if (input.expectedSourceSha256 && input.expectedSourceSha256 !== source.metadata.sha256) {
      throw new WorkspaceProposalPublicationConflictError(
        input.publicationKey,
        `Proposal source checksum changed at ${source.path}`,
      )
    }
    const publicationSource: WorkspaceProposalPublicationSource = {
      path: source.path,
      revision: source.revision,
      version_id: source.version_id,
      sha256: source.metadata.sha256,
    }
    const targetPath = assertWorkspaceWritePath(input.targetPath)
    const current = await this.store.getFile(input.workspaceId, targetPath)
    if (current && proposalPublicationMatches(current, input.publicationKey, source)) {
      if (current.capacity_reservation_id) {
        const reservation = await this.getFileSetReservation(
          input.workspaceId,
          current.capacity_reservation_id,
        )
        if (reservation?.status === 'reserved') {
          await this.finalizeAvailableFileSet(input.workspaceId, current.capacity_reservation_id)
        }
      }
      return { status: 'accepted', file: immutableSnapshot(current) }
    }
    if (current?.publication_key === input.publicationKey) {
      throw new WorkspaceProposalPublicationConflictError(
        input.publicationKey,
        'Proposal publication key already refers to a different source identity',
      )
    }
    if (input.expectedTargetRevision === null && current) {
      return {
        status: 'conflict',
        code: 'target_revision_conflict',
        path: targetPath,
        expectedRevision: null,
        actualRevision: current.revision,
      }
    }
    const reservationId = input.expectedTargetRevision === null
      ? deterministicReservationId(
          'proposal-publication',
          input.workspaceId,
          input.publicationKey,
        )
      : undefined
    try {
      if (reservationId) {
        await this.reserveFileSet(input.workspaceId, reservationId, [targetPath])
      }
      const file = await this.commitFile(input.actor, {
        workspaceId: input.workspaceId,
        path: targetPath,
        expectedRevision: input.expectedTargetRevision,
        visibility: 'public',
        storageRef: source.storage_ref,
        metadata: source.metadata,
        writer: input.writer,
        reservationId,
        publicationKey: input.publicationKey,
        publicationSource,
      })
      if (reservationId) await this.finalizeFileSet(input.workspaceId, reservationId)
      return { status: 'accepted', file }
    } catch (error) {
      if (error instanceof WorkspaceReservationConflictError) {
        const actual = await this.store.getFile(input.workspaceId, targetPath)
        return {
          status: 'conflict',
          code: 'target_reserved',
          path: targetPath,
          expectedRevision: input.expectedTargetRevision,
          actualRevision: actual?.revision ?? null,
        }
      }
      if (!(error instanceof WorkspaceRevisionConflictError)) throw error
      const winner = await this.store.getFile(input.workspaceId, targetPath)
      if (winner && proposalPublicationMatches(winner, input.publicationKey, source)) {
        if (reservationId) await this.finalizeAvailableFileSet(input.workspaceId, reservationId)
        return { status: 'accepted', file: immutableSnapshot(winner) }
      }
      if (reservationId) await this.finalizeAvailableFileSet(input.workspaceId, reservationId)
      return {
        status: 'conflict',
        code: 'target_revision_conflict',
        path: error.path,
        expectedRevision: error.expectedRevision,
        actualRevision: error.actualRevision,
      }
    }
  }
}
