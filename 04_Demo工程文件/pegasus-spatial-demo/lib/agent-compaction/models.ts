import mongoose, { Schema, type Model } from 'mongoose'
import type { DurableCompactionJobRecord } from './types'

const CompactionJobSchema = new Schema({
  job_id: { type: String, required: true, unique: true, index: true },
  owner_key: { type: String, required: true, index: true },
  owner_kind: { type: String, enum: ['conversation', 'agent_session'], required: true },
  conversation_id: { type: String, required: true, index: true },
  user_id: { type: String, required: true, index: true },
  agent_session_id: { type: String, default: null, index: true },
  team_id: { type: String, default: null, index: true },
  agent_id: { type: String, default: null, index: true },
  source_run_id: { type: String, default: null, index: true },
  idempotency_key: { type: String, required: true },
  idempotency_keys: { type: [String], required: true, default: [] },
  model_alias_snapshot: { type: String, default: null },
  model_resolution_snapshot: { type: Schema.Types.Mixed, default: null },
  status: {
    type: String,
    enum: [
      'queued',
      'summarizing',
      'summary_ready',
      'merge_prepared',
      'retryable',
      'merged',
      'failed',
      'cancelled',
      'superseded',
    ],
    required: true,
    index: true,
  },
  status_revision: { type: Number, default: 0 },
  status_outbox: { type: [Schema.Types.Mixed], default: [] },
  /** Present only while a non-terminal Job owns the context barrier. */
  active_key: { type: String, default: undefined },
  frozen_prefix: { type: Schema.Types.Mixed, required: true },
  project_context_snapshot: { type: Schema.Types.Mixed, default: null },
  workspace_projection: { type: Schema.Types.Mixed, default: null },
  merge_project_context_snapshot: { type: Schema.Types.Mixed, default: null },
  merge_workspace_projection: { type: Schema.Types.Mixed, default: null },
  merge_projection_prepared_at: { type: Date, default: null },
  summary: { type: String, default: null },
  summary_usage: { type: Schema.Types.Mixed, default: null },
  replacement_message: { type: Schema.Types.Mixed, default: null },
  replacement_hash: { type: String, default: null },
  merge_context_revision: { type: Number, default: null },
  merged_context_revision: { type: Number, default: null },
  runtime_settled_at: { type: Date, default: null },
  attempt: { type: Number, default: 0 },
  lease: { type: Schema.Types.Mixed, default: null },
  source_turn_guard: { type: Schema.Types.Mixed, default: null },
  available_at: { type: Date, default: null, index: true },
  last_error: { type: String, default: null },
  finished_at: { type: Date, default: null },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'context_compaction_jobs',
})

CompactionJobSchema.index({ owner_key: 1, idempotency_key: 1 }, { unique: true })
CompactionJobSchema.index({ owner_key: 1, idempotency_keys: 1 }, { unique: true })
CompactionJobSchema.index(
  { active_key: 1 },
  {
    unique: true,
    partialFilterExpression: { active_key: { $type: 'string' } },
  },
)
CompactionJobSchema.index({
  status: 1,
  available_at: 1,
  'source_turn_guard.expires_at': 1,
  'lease.expires_at': 1,
  created_at: 1,
})

export const DurableCompactionJobModel =
  (mongoose.models.ContextCompactionJob as Model<DurableCompactionJobRecord> | undefined)
  ?? mongoose.model<DurableCompactionJobRecord>(
    'ContextCompactionJob',
    CompactionJobSchema as Schema<DurableCompactionJobRecord>,
  )
