import mongoose, { Schema, type Model } from 'mongoose'
import {
  SPATIAL_ARTIFACT_KINDS,
  SPATIAL_ARTIFACT_RELATIONS,
  SPATIAL_BUILD_KINDS,
  SPATIAL_BUILD_STATUSES,
  SPATIAL_EXECUTION_GATES,
  SPATIAL_OPERATOR_SMOKE_PROVIDERS,
  SPATIAL_OPERATOR_SMOKE_STATES,
  type SpatialArtifactNodeRecord,
  type SpatialBuildJobRecord,
  type SpatialPaidSlotRecord,
  type SpatialOperatorSmokeIntentRecord,
  type SpatialStagedBatchRecord,
} from './types'
import type {
  SpatialObservationRecord,
  SpatialRenderCommandRecord,
  SpatialRenderSessionRecord,
  SpatialSceneRecord,
  SpatialSceneRevisionRecord,
} from './scene-types'

const SpatialBuildJobSchema = new Schema<SpatialBuildJobRecord>({
  job_id: { type: String, required: true, unique: true, index: true },
  idempotency_key: { type: String, required: true },
  project_id: { type: String, required: true, index: true },
  run_id: { type: String, required: true, index: true },
  tool_use_id: { type: String, required: true },
  user_id: { type: String, required: true, index: true },
  conversation_id: { type: String, required: true, index: true },
  kind: { type: String, enum: SPATIAL_BUILD_KINDS, required: true },
  provider: { type: String, required: true, index: true },
  model_snapshot: { type: String, default: null },
  request_hash: { type: String, required: true },
  request_snapshot: { type: Schema.Types.Mixed, required: true },
  output_path_prefix: { type: String, required: true },
  status: { type: String, enum: SPATIAL_BUILD_STATUSES, required: true, index: true },
  execution_gate: { type: String, enum: SPATIAL_EXECUTION_GATES, default: 'worker', index: true },
  active_slot: { type: Number, enum: [0, 1], default: undefined },
  status_revision: { type: Number, default: 0 },
  execution_attempts: { type: Number, default: 0 },
  consecutive_failures: { type: Number, default: 0 },
  submission_attempts: { type: Number, default: 0 },
  poll_attempts: { type: Number, default: 0 },
  lease: { type: Schema.Types.Mixed, default: null },
  external_job_id: { type: String, default: null, index: true },
  provider_status: { type: String, default: null },
  published_artifact_ids: { type: [String], default: [] },
  published_workspace_paths: { type: [String], default: [] },
  publication_token: { type: String, default: null },
  available_at: { type: Date, default: null, index: true },
  last_error: { type: String, default: null },
  unknown_reason: { type: String, default: null },
  configuration_blocked_hosts: { type: [String], default: [] },
  completion_notification_requested: { type: Boolean, default: false, index: true },
  completion_notified_at: { type: Date, default: null, index: true },
  completion_notification_last_error: { type: String, default: null },
  finished_at: { type: Date, default: null },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'spatial_build_jobs',
})

SpatialBuildJobSchema.index(
  { project_id: 1, run_id: 1, tool_use_id: 1 },
  { unique: true },
)
SpatialBuildJobSchema.index(
  { project_id: 1, output_path_prefix: 1 },
  { unique: true },
)
SpatialBuildJobSchema.index(
  { project_id: 1, active_slot: 1 },
  {
    unique: true,
    partialFilterExpression: { active_slot: { $type: 'number' } },
  },
)
SpatialBuildJobSchema.index({
  status: 1,
  available_at: 1,
  'lease.expires_at': 1,
  created_at: 1,
})
SpatialBuildJobSchema.index({ user_id: 1, project_id: 1, created_at: -1 })
SpatialBuildJobSchema.index({
  completion_notification_requested: 1,
  completion_notified_at: 1,
  status: 1,
  finished_at: 1,
})

const SpatialArtifactRelationSchema = new Schema({
  kind: { type: String, enum: SPATIAL_ARTIFACT_RELATIONS, required: true },
  artifact_id: { type: String, required: true },
}, { _id: false })

const SpatialArtifactNodeSchema = new Schema<SpatialArtifactNodeRecord>({
  artifact_id: { type: String, required: true, unique: true, index: true },
  job_id: { type: String, required: true, index: true },
  project_id: { type: String, required: true, index: true },
  user_id: { type: String, required: true, index: true },
  provider: { type: String, required: true },
  kind: { type: String, enum: SPATIAL_ARTIFACT_KINDS, required: true },
  state: { type: String, enum: ['published', 'orphaned'], required: true, index: true },
  publication_token: { type: String, required: true, index: true },
  provider_asset_key: { type: String, required: true },
  filename: { type: String, required: true },
  workspace_path: { type: String, required: true },
  storage_uri: { type: String, required: true },
  mime_type: { type: String, required: true },
  size_bytes: { type: Number, required: true },
  sha256: { type: String, required: true, index: true },
  relations: { type: [SpatialArtifactRelationSchema], default: [] },
  metadata: { type: Schema.Types.Mixed, default: {} },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'spatial_artifact_nodes',
})

const SpatialPaidSlotSchema = new Schema<SpatialPaidSlotRecord>({
  project_id: { type: String, required: true, index: true },
  user_id: { type: String, required: true, index: true },
  slot: { type: Number, enum: [0, 1], required: true },
  holder_type: { type: String, enum: ['spatial_build', 'image_generation'], required: true },
  holder_key: { type: String, required: true },
  reservation_token: { type: String, required: true },
  state: { type: String, enum: ['reserved', 'active'], required: true, index: true },
  reservation_expires_at: { type: Date, default: null, index: true },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'spatial_paid_slots',
})

// Image generation and slow 3D builds have independent concurrency lanes.
// Two running Lux jobs must not prevent an Agent from producing the next
// reference image while those jobs continue in the background.
SpatialPaidSlotSchema.index({ project_id: 1, holder_type: 1, slot: 1 }, { unique: true })
SpatialPaidSlotSchema.index(
  { project_id: 1, holder_type: 1, holder_key: 1 },
  { unique: true },
)

SpatialArtifactNodeSchema.index({ job_id: 1, publication_token: 1 })
SpatialArtifactNodeSchema.index({ user_id: 1, project_id: 1, created_at: -1 })

const SpatialStagedBatchSchema = new Schema<SpatialStagedBatchRecord>({
  job_id: { type: String, required: true, index: true },
  project_id: { type: String, required: true, index: true },
  user_id: { type: String, required: true, index: true },
  publication_token: { type: String, required: true },
  state: { type: String, enum: ['ready'], required: true },
  assets: { type: [Schema.Types.Mixed], required: true } as never,
  expires_at: { type: Date, required: true, index: true },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'spatial_staged_batches',
})

SpatialStagedBatchSchema.index({ job_id: 1, publication_token: 1 }, { unique: true })

const SpatialOperatorSmokeIntentSchema = new Schema<SpatialOperatorSmokeIntentRecord>({
  smoke_id: { type: String, required: true, unique: true, index: true },
  project_id: { type: String, required: true, index: true },
  user_id: { type: String, required: true, index: true },
  conversation_id: { type: String, required: true },
  provider: { type: String, enum: SPATIAL_OPERATOR_SMOKE_PROVIDERS, required: true, index: true },
  image_mode: { type: String, enum: ['text', 'edit', null], default: null },
  phase: { type: String, required: true },
  purpose: { type: String, required: true },
  budget_key: { type: String, required: true },
  provider_fence_key: { type: String, default: undefined, index: true },
  request_hash: { type: String, required: true },
  request_snapshot: { type: Schema.Types.Mixed, required: true },
  run_id: { type: String, required: true },
  tool_use_id: { type: String, required: true },
  target_id: { type: String, default: null },
  state: { type: String, enum: SPATIAL_OPERATOR_SMOKE_STATES, required: true, index: true },
  authorized_at: { type: Date, default: null },
  submission_count: { type: Number, default: 0 },
  artifact_hostnames: { type: [String], default: [] },
  last_error: { type: String, default: null },
  unknown_reconciled_at: { type: Date, default: null, index: true },
  unknown_reconciled_by: { type: String, default: null },
  unknown_reconciliation_reason: { type: String, default: null },
  finished_at: { type: Date, default: null },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'spatial_operator_smoke_intents',
})

SpatialOperatorSmokeIntentSchema.index(
  { project_id: 1, phase: 1, purpose: 1 },
  { unique: true, name: 'operator_smoke_purpose_budget' },
)
SpatialOperatorSmokeIntentSchema.index(
  { project_id: 1, phase: 1, budget_key: 1 },
  { unique: true, name: 'operator_smoke_provider_budget' },
)
SpatialOperatorSmokeIntentSchema.index({
  project_id: 1,
  provider_fence_key: 1,
  state: 1,
  unknown_reconciled_at: 1,
})

interface SpatialOperatorProviderSubmissionGuardRecord {
  project_id: string
  provider_fence_key: string
  smoke_id: string
  created_at: Date
  updated_at: Date
}

/**
 * A single durable owner for the paid provider boundary within one project.
 * The unique compound index is the concurrency primitive: two phases or image
 * modes cannot both become authorized for the same provider, even when their
 * preflight reads race.
 */
const SpatialOperatorProviderSubmissionGuardSchema =
  new Schema<SpatialOperatorProviderSubmissionGuardRecord>({
    project_id: { type: String, required: true, index: true },
    provider_fence_key: { type: String, required: true },
    smoke_id: { type: String, required: true, index: true },
  }, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'spatial_operator_provider_submission_guards',
  })

SpatialOperatorProviderSubmissionGuardSchema.index(
  { project_id: 1, provider_fence_key: 1 },
  { unique: true, name: 'operator_provider_submission_guard' },
)

export const SpatialBuildJobModel =
  (mongoose.models.SpatialBuildJob as Model<SpatialBuildJobRecord> | undefined)
  ?? mongoose.model<SpatialBuildJobRecord>('SpatialBuildJob', SpatialBuildJobSchema)

export const SpatialArtifactNodeModel =
  (mongoose.models.SpatialArtifactNode as Model<SpatialArtifactNodeRecord> | undefined)
  ?? mongoose.model<SpatialArtifactNodeRecord>('SpatialArtifactNode', SpatialArtifactNodeSchema)

export const SpatialPaidSlotModel =
  (mongoose.models.SpatialPaidSlot as Model<SpatialPaidSlotRecord> | undefined)
  ?? mongoose.model<SpatialPaidSlotRecord>('SpatialPaidSlot', SpatialPaidSlotSchema)

export const SpatialStagedBatchModel =
  (mongoose.models.SpatialStagedBatch as Model<SpatialStagedBatchRecord> | undefined)
  ?? mongoose.model<SpatialStagedBatchRecord>('SpatialStagedBatch', SpatialStagedBatchSchema)

export const SpatialOperatorSmokeIntentModel =
  (mongoose.models.SpatialOperatorSmokeIntent as Model<SpatialOperatorSmokeIntentRecord> | undefined)
  ?? mongoose.model<SpatialOperatorSmokeIntentRecord>(
    'SpatialOperatorSmokeIntent',
    SpatialOperatorSmokeIntentSchema,
  )

export const SpatialOperatorProviderSubmissionGuardModel =
  (mongoose.models.SpatialOperatorProviderSubmissionGuard as
    Model<SpatialOperatorProviderSubmissionGuardRecord> | undefined)
  ?? mongoose.model<SpatialOperatorProviderSubmissionGuardRecord>(
    'SpatialOperatorProviderSubmissionGuard',
    SpatialOperatorProviderSubmissionGuardSchema,
  )

const SpatialSceneSchema = new Schema<SpatialSceneRecord>({
  scene_id: { type: String, required: true, unique: true, index: true },
  project_id: { type: String, required: true, index: true },
  user_id: { type: String, required: true, index: true },
  conversation_id: { type: String, required: true, index: true },
  title: { type: String, required: true },
  current_revision_id: { type: String, required: true, index: true },
  current_version: { type: Number, required: true, min: 1 },
  agent_viewpoint: { type: Schema.Types.Mixed, default: null },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'spatial_scenes',
})
SpatialSceneSchema.index({ project_id: 1, updated_at: -1 })

const SpatialSceneRevisionSchema = new Schema<SpatialSceneRevisionRecord>({
  revision_id: { type: String, required: true, unique: true, index: true },
  scene_id: { type: String, required: true, index: true },
  project_id: { type: String, required: true, index: true },
  user_id: { type: String, required: true, index: true },
  version: { type: Number, required: true, min: 1 },
  parent_revision_id: { type: String, default: null, index: true },
  mutation_key: { type: String, required: true },
  mutation_hash: { type: String, required: true },
  environment: { type: Schema.Types.Mixed, default: null },
  world: { type: Schema.Types.Mixed, default: null },
  instances: { type: [Schema.Types.Mixed], default: [] } as never,
  change_summary: { type: String, required: true },
  observation_id: { type: String, default: null, index: true },
  created_by: { type: String, required: true },
  committed: { type: Boolean, required: true, default: false, index: true },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'spatial_scene_revisions',
})
SpatialSceneRevisionSchema.index({ project_id: 1, mutation_key: 1 }, { unique: true })
SpatialSceneRevisionSchema.index({ scene_id: 1, version: -1, committed: 1 })

const SpatialObservationSchema = new Schema<SpatialObservationRecord>({
  observation_id: { type: String, required: true, unique: true, index: true },
  scene_id: { type: String, required: true, index: true },
  project_id: { type: String, required: true, index: true },
  user_id: { type: String, required: true, index: true },
  revision_id: { type: String, required: true, index: true },
  source: { type: String, enum: ['user', 'agent'], required: true },
  viewpoint: { type: Schema.Types.Mixed, required: true },
  screenshot_asset_id: { type: String, required: true },
  screenshot_workspace_path: { type: String, required: true },
  selected_instance_id: { type: String, default: null },
  visible_instance_ids: { type: [String], default: [] },
  comment: { type: String, required: true },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'spatial_observations',
})

const SpatialRenderSessionSchema = new Schema<SpatialRenderSessionRecord>({
  session_id: { type: String, required: true, unique: true, index: true },
  scene_id: { type: String, required: true, index: true },
  project_id: { type: String, required: true, index: true },
  user_id: { type: String, required: true, index: true },
  client_id: { type: String, required: true },
  lease_token: { type: String, required: true },
  heartbeat_at: { type: Date, required: true },
  expires_at: { type: Date, required: true, index: true },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'spatial_render_sessions',
})
SpatialRenderSessionSchema.index({ project_id: 1, scene_id: 1, expires_at: -1 })

const SpatialRenderCommandSchema = new Schema<SpatialRenderCommandRecord>({
  command_id: { type: String, required: true, unique: true, index: true },
  scene_id: { type: String, required: true, index: true },
  project_id: { type: String, required: true, index: true },
  user_id: { type: String, required: true, index: true },
  run_id: { type: String, required: true },
  tool_use_id: { type: String, required: true },
  kind: { type: String, enum: ['capture', 'surface_query'], required: true, default: 'capture' },
  revision_id: { type: String, required: true },
  viewpoint: { type: Schema.Types.Mixed, required: true },
  note: { type: String, default: null },
  status: { type: String, enum: ['queued', 'claimed', 'completed', 'failed'], required: true, index: true },
  lease: { type: Schema.Types.Mixed, default: null },
  observation_id: { type: String, required: true, unique: true },
  surface_query: { type: Schema.Types.Mixed, default: null },
  surface_result: { type: Schema.Types.Mixed, default: null },
  screenshot_asset_id: { type: String, default: null },
  screenshot_workspace_path: { type: String, default: null },
  last_error: { type: String, default: null },
  completed_at: { type: Date, default: null },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'spatial_render_commands',
})
SpatialRenderCommandSchema.index({ project_id: 1, run_id: 1, tool_use_id: 1 }, { unique: true })
SpatialRenderCommandSchema.index({ project_id: 1, scene_id: 1, status: 1, created_at: 1 })

export const SpatialSceneModel =
  (mongoose.models.SpatialScene as Model<SpatialSceneRecord> | undefined)
  ?? mongoose.model<SpatialSceneRecord>('SpatialScene', SpatialSceneSchema)
export const SpatialSceneRevisionModel =
  (mongoose.models.SpatialSceneRevision as Model<SpatialSceneRevisionRecord> | undefined)
  ?? mongoose.model<SpatialSceneRevisionRecord>('SpatialSceneRevision', SpatialSceneRevisionSchema)
export const SpatialObservationModel =
  (mongoose.models.SpatialObservation as Model<SpatialObservationRecord> | undefined)
  ?? mongoose.model<SpatialObservationRecord>('SpatialObservation', SpatialObservationSchema)
export const SpatialRenderSessionModel =
  (mongoose.models.SpatialRenderSession as Model<SpatialRenderSessionRecord> | undefined)
  ?? mongoose.model<SpatialRenderSessionRecord>('SpatialRenderSession', SpatialRenderSessionSchema)
export const SpatialRenderCommandModel =
  (mongoose.models.SpatialRenderCommand as Model<SpatialRenderCommandRecord> | undefined)
  ?? mongoose.model<SpatialRenderCommandRecord>('SpatialRenderCommand', SpatialRenderCommandSchema)

export const SPATIAL_MODELS = [
  SpatialBuildJobModel,
  SpatialArtifactNodeModel,
  SpatialPaidSlotModel,
  SpatialStagedBatchModel,
  SpatialOperatorSmokeIntentModel,
  SpatialOperatorProviderSubmissionGuardModel,
  SpatialSceneModel,
  SpatialSceneRevisionModel,
  SpatialObservationModel,
  SpatialRenderSessionModel,
  SpatialRenderCommandModel,
] as const
