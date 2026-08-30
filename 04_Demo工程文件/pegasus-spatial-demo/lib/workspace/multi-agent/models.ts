import mongoose, { Document, Schema, type Model } from 'mongoose'
import type {
  CanonicalArtifactRecord,
  CapacityReservation,
  WorkspaceFileMetadata,
  WorkspaceFileVisibility,
  WorkspaceProposalPublicationSource,
  WorkspaceStorageRef,
  WorkspaceWriterProvenance,
} from './types'

export interface WorkspaceFileDocument extends Document {
  workspace_id: string
  path: string
  revision: number
  current_version_id: string
  visibility: WorkspaceFileVisibility
  owner_agent_id?: string
  writer: WorkspaceWriterProvenance
  canonical_artifact_key?: string
  publication_key?: string
  publication_source?: WorkspaceProposalPublicationSource
  capacity_reservation_id?: string
  created_at: Date
  updated_at: Date
}

export interface WorkspaceFileRevisionDocument extends Document {
  version_id: string
  workspace_id: string
  path: string
  revision: number
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
}

export interface WorkspaceCapacityDocument extends Document {
  workspace_id: string
  max_files: number
  revision: number
  published_paths: string[]
  reservations: CapacityReservation[]
  created_at: Date
  updated_at: Date
}

export interface WorkspaceCanonicalArtifactDocument extends Document, CanonicalArtifactRecord {}

const WriterSchema = new Schema<WorkspaceWriterProvenance>({
  team_id: { type: String, required: true },
  agent_id: { type: String, required: true },
  task_id: { type: String, default: undefined },
  run_id: { type: String, required: true },
  execution_fence_token: { type: String, required: true },
}, { _id: false })

const ProposalPublicationSourceSchema = new Schema<WorkspaceProposalPublicationSource>({
  path: { type: String, required: true },
  revision: { type: Number, required: true, min: 1 },
  version_id: { type: String, required: true },
  sha256: { type: String, required: true },
}, { _id: false })

const ReservationSchema = new Schema<CapacityReservation>({
  reservation_id: { type: String, required: true },
  requested_paths: { type: [String], required: true },
  new_paths: { type: [String], required: true },
  status: { type: String, enum: ['reserved', 'finalized', 'released'], required: true },
  created_at: { type: Date, required: true },
  finalized_at: { type: Date, default: undefined },
  released_at: { type: Date, default: undefined },
}, { _id: false })

const WorkspaceFileSchema = new Schema<WorkspaceFileDocument>({
  workspace_id: { type: String, required: true, index: true },
  path: { type: String, required: true },
  revision: { type: Number, required: true, min: 1 },
  current_version_id: { type: String, required: true },
  visibility: {
    type: String,
    enum: ['public', 'agent_private', 'managed_reference'],
    required: true,
  },
  owner_agent_id: { type: String, default: undefined },
  writer: { type: WriterSchema, required: true },
  canonical_artifact_key: { type: String, default: undefined },
  publication_key: { type: String, default: undefined },
  publication_source: { type: ProposalPublicationSourceSchema, default: undefined },
  capacity_reservation_id: { type: String, default: undefined },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'workspace_files',
})

WorkspaceFileSchema.index({ workspace_id: 1, path: 1 }, { unique: true })
WorkspaceFileSchema.index({ workspace_id: 1, visibility: 1, owner_agent_id: 1 })

const WorkspaceFileRevisionSchema = new Schema<WorkspaceFileRevisionDocument>({
  version_id: { type: String, required: true, unique: true, index: true, immutable: true },
  workspace_id: { type: String, required: true, index: true, immutable: true },
  path: { type: String, required: true, immutable: true },
  revision: { type: Number, required: true, min: 1, immutable: true },
  visibility: {
    type: String,
    enum: ['public', 'agent_private', 'managed_reference'],
    required: true,
    immutable: true,
  },
  owner_agent_id: { type: String, default: undefined, immutable: true },
  // Mixed value objects are cloned/frozen by the repository and never updated.
  storage_ref: { type: Schema.Types.Mixed, required: true, immutable: true },
  metadata: { type: Schema.Types.Mixed, required: true, immutable: true },
  writer: { type: WriterSchema, required: true, immutable: true },
  canonical_artifact_key: { type: String, default: undefined, immutable: true },
  publication_key: { type: String, default: undefined, immutable: true },
  publication_source: { type: ProposalPublicationSourceSchema, default: undefined, immutable: true },
  capacity_reservation_id: { type: String, default: undefined, immutable: true },
  created_at: { type: Date, required: true, immutable: true },
}, {
  collection: 'workspace_file_revisions',
  versionKey: false,
})

// Losing writers may leave unreachable immutable revisions before the head CAS.
// Do not make logical revision numbers unique: doing so would let an orphaned
// pre-CAS record permanently block recovery. version_id remains globally unique.
WorkspaceFileRevisionSchema.index({ workspace_id: 1, path: 1, revision: 1 })

const WorkspaceCapacitySchema = new Schema<WorkspaceCapacityDocument>({
  workspace_id: { type: String, required: true, unique: true, index: true },
  max_files: { type: Number, required: true, min: 1 },
  revision: { type: Number, required: true, min: 0 },
  published_paths: { type: [String], default: [] },
  reservations: { type: [ReservationSchema], default: [] },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'workspace_capacities',
})

const WorkspaceCanonicalArtifactSchema = new Schema<WorkspaceCanonicalArtifactDocument>({
  workspace_id: { type: String, required: true, index: true },
  canonical_artifact_key: { type: String, required: true },
  idempotency_key: { type: String, required: true },
  path: { type: String, required: true },
  content_sha256: { type: String, required: true },
  status: { type: String, enum: ['staging', 'published', 'failed'], required: true },
  file_revision: { type: Number, default: undefined },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'workspace_canonical_artifacts',
})

WorkspaceCanonicalArtifactSchema.index(
  { workspace_id: 1, canonical_artifact_key: 1 },
  { unique: true },
)

function model<T extends Document>(name: string, schema: Schema<T>): Model<T> {
  return (mongoose.models[name] as Model<T> | undefined) ?? mongoose.model<T>(name, schema)
}

export const WorkspaceFile = model('WorkspaceFile', WorkspaceFileSchema)
export const WorkspaceFileRevision = model('WorkspaceFileRevision', WorkspaceFileRevisionSchema)
export const WorkspaceCapacity = model('WorkspaceCapacity', WorkspaceCapacitySchema)
export const WorkspaceCanonicalArtifact = model(
  'WorkspaceCanonicalArtifact',
  WorkspaceCanonicalArtifactSchema,
)
