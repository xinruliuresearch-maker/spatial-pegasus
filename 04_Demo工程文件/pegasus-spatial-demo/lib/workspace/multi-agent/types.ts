export const MULTI_AGENT_WORKSPACE_MAX_FILES = 500

export type WorkspaceFileVisibility = 'public' | 'agent_private' | 'managed_reference'

/**
 * Durable, credential-free locators for immutable content. The referenced
 * object must be written before a WorkspaceFile revision is committed.
 */
export type WorkspaceStorageRef =
  | { driver: 'gridfs'; object_id: string }
  | { driver: 'asset'; asset_id: string; variant?: 'original' | 'model' | 'thumbnail' }
  | { driver: 'object'; storage_key: string }

export interface WorkspaceFileMetadata {
  kind: 'text' | 'document' | 'raster' | 'artifact'
  mime_type: string
  size_bytes: number
  sha256: string
  filename?: string
  note?: string
}

export interface WorkspaceWriterProvenance {
  team_id: string
  agent_id: string
  task_id?: string
  run_id: string
  /** Opaque lease/fence value. It is deliberately not interpreted by Workspace. */
  execution_fence_token: string
}

/** Immutable source identity bound to one Root-approved proposal publication. */
export interface WorkspaceProposalPublicationSource {
  path: string
  revision: number
  version_id: string
  sha256: string
}

export interface WorkspaceActor {
  teamId: string
  agentId: string
  rootAgentId: string
  role: 'root' | 'member'
  /** Exact private paths shared with this Agent. Directory grants are not supported. */
  privatePathReferences?: readonly string[]
  /** Set only by the trusted literature tool adapter, never from model input. */
  managedReferenceTool?: boolean
  /**
   * Narrow public-output capability held only by the trusted GenerateImage
   * adapter after Root explicitly delegates that tool. It is never derived
   * from a model-supplied path or a wildcard grant.
   */
  publicWriteTool?: 'GenerateImage'
}

export interface WorkspaceFileSnapshot {
  workspace_id: string
  path: string
  revision: number
  version_id: string
  visibility: WorkspaceFileVisibility
  owner_agent_id?: string
  storage_ref: WorkspaceStorageRef
  metadata: WorkspaceFileMetadata
  writer: WorkspaceWriterProvenance
  canonical_artifact_key?: string
  publication_key?: string
  publication_source?: WorkspaceProposalPublicationSource
  capacity_reservation_id?: string
  created_at: Date
  updated_at: Date
}

export interface WorkspaceFileWrite {
  workspaceId: string
  path: string
  expectedRevision: number | null
  visibility: WorkspaceFileVisibility
  ownerAgentId?: string
  storageRef: WorkspaceStorageRef
  metadata: WorkspaceFileMetadata
  writer: WorkspaceWriterProvenance
  /** Required when staging one member of an explicitly reserved file set. */
  reservationId?: string
  canonicalArtifactKey?: string
  /** Stable across Run-owner takeover; only used by proposal publication. */
  publicationKey?: string
  publicationSource?: WorkspaceProposalPublicationSource
}

export type CapacityReservationStatus = 'reserved' | 'finalized' | 'released'

export interface CapacityReservation {
  reservation_id: string
  requested_paths: string[]
  new_paths: string[]
  status: CapacityReservationStatus
  created_at: Date
  finalized_at?: Date
  released_at?: Date
}

export interface WorkspaceCapacityState {
  workspace_id: string
  max_files: number
  revision: number
  published_paths: string[]
  reservations: CapacityReservation[]
}

export interface WorkspaceCapacityReservationResult {
  reservationId: string
  requestedPaths: string[]
  newPaths: string[]
  status: CapacityReservationStatus
  /** True only for the executor that owns this materialization attempt. */
  acquired: boolean
}

export interface ManagedReferenceCommitInput {
  workspaceId: string
  canonicalArtifactKey: string
  path: string
  storageRef: WorkspaceStorageRef
  metadata: WorkspaceFileMetadata
  writer: WorkspaceWriterProvenance
  idempotencyKey: string
}

export interface ManagedReferenceCommitResult {
  file: WorkspaceFileSnapshot
  created: boolean
}

export interface ProposalAcceptInput {
  workspaceId: string
  sourcePath: string
  targetPath: string
  /** Stable proposal + target identity, independent of the current lease owner. */
  publicationKey: string
  /** Optional submit-time checksum; the authoritative source identity is read from Workspace. */
  expectedSourceSha256?: string | null
  /** null means the target must not yet exist. */
  expectedTargetRevision: number | null
  actor: WorkspaceActor
  writer: WorkspaceWriterProvenance
}

export type ProposalAcceptResult =
  | { status: 'accepted'; file: WorkspaceFileSnapshot }
  | {
      status: 'conflict'
      code: 'target_revision_conflict' | 'target_reserved'
      path: string
      expectedRevision: number | null
      actualRevision: number | null
    }

export interface WorkspaceFenceValidationInput {
  workspaceId: string
  writer: WorkspaceWriterProvenance
}

export type WorkspaceFenceValidator = (
  input: WorkspaceFenceValidationInput,
) => Promise<boolean> | boolean

export interface CanonicalArtifactRecord {
  workspace_id: string
  canonical_artifact_key: string
  idempotency_key: string
  path: string
  content_sha256: string
  status: 'staging' | 'published' | 'failed'
  file_revision?: number
  created_at: Date
  updated_at: Date
}

export type CanonicalArtifactClaim =
  | { state: 'claimed'; record: CanonicalArtifactRecord }
  | { state: 'existing'; record: CanonicalArtifactRecord }
