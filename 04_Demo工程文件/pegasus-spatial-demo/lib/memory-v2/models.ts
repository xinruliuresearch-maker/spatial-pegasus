import mongoose, { Document, Schema } from 'mongoose'
import type {
  AtomicPreference,
  CandidateStatus,
  HistoryArtifactRef,
  MemoryEvidenceRef,
  MemoryRunStatus,
  PreferencePolarity,
} from './types'

export interface UserMemoryProfileDocument extends Document {
  user_id: string
  version: number
  preferences: AtomicPreference[]
  compiled_text: string
  token_count: number
  token_limit: number
  suppressed_fingerprints: string[]
  created_at: Date
  updated_at: Date
}

export interface MemoryHistoryEventDocument extends Document {
  event_id: string
  user_id: string
  conversation_id: string | null
  source_run_id: string | null
  title: string
  summary: string
  detail: string
  project: string
  decisions: string[]
  artifacts: HistoryArtifactRef[]
  tags: string[]
  search_terms: string[]
  normalized_search_text: string
  token_count: number
  source: 'memory_v2' | 'legacy_migration' | 'manual'
  status: 'active' | 'deleted'
  access_count: number
  last_recalled_at: Date | null
  event_at: Date
  created_at: Date
  updated_at: Date
}

export interface MemoryCandidateDocument extends Document {
  candidate_id: string
  user_id: string
  run_id: string
  kind: 'preference' | 'history'
  category: string
  subject: string
  statement: string
  scope: string
  polarity: PreferencePolarity
  history_payload: Record<string, unknown> | null
  evidence_refs: MemoryEvidenceRef[]
  cluster_key: string
  status: CandidateStatus
  batch_id: string | null
  suppression_fingerprint: string
  resolution_note: string
  created_at: Date
  updated_at: Date
}

export interface MemoryRunDocument extends Document {
  run_id: string
  agent_run_id?: string | null
  user_id: string
  conversation_id: string
  status: MemoryRunStatus
  evidence: MemoryEvidenceRef[]
  attempts: number
  available_at: Date
  locked_until: Date | null
  lease_id: string | null
  error: string
  completed_at: Date | null
  created_at: Date
  updated_at: Date
}

const EvidenceSchema = new Schema(
  {
    evidence_id: { type: String, required: true },
    role: { type: String, enum: ['user', 'assistant', 'tool', 'workspace', 'completion'], required: true },
    excerpt: { type: String, required: true },
    message_index: { type: Number },
    tool_name: { type: String },
    created_at: { type: Date, default: Date.now },
  },
  { _id: false }
)

const PreferenceSchema = new Schema(
  {
    preference_id: { type: String, required: true },
    source_candidate_id: { type: String },
    category: { type: String, required: true },
    subject: { type: String, required: true },
    statement: { type: String, required: true },
    scope: { type: String, default: 'general' },
    polarity: { type: String, enum: ['positive', 'negative', 'neutral'], default: 'neutral' },
    status: { type: String, enum: ['active', 'conflict'], default: 'active' },
    evidence_refs: { type: [EvidenceSchema], default: [] },
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now },
  },
  { _id: false }
)

const HistoryArtifactSchema = new Schema(
  {
    path: { type: String },
    asset_id: { type: String },
    url: { type: String },
    mime_type: { type: String },
    label: { type: String },
  },
  { _id: false }
)

const UserMemoryProfileSchema = new Schema<UserMemoryProfileDocument>(
  {
    user_id: { type: String, required: true, unique: true, index: true },
    version: { type: Number, default: 1 },
    preferences: { type: [PreferenceSchema], default: [] },
    compiled_text: { type: String, default: '' },
    token_count: { type: Number, default: 0 },
    token_limit: { type: Number, default: 20_000 },
    suppressed_fingerprints: { type: [String], default: [] },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'user_memory_profiles' }
)

const MemoryHistoryEventSchema = new Schema<MemoryHistoryEventDocument>(
  {
    event_id: { type: String, required: true, unique: true, index: true },
    user_id: { type: String, required: true, index: true },
    conversation_id: { type: String, default: null, index: true },
    source_run_id: { type: String, default: null },
    title: { type: String, required: true },
    summary: { type: String, required: true },
    detail: { type: String, default: '' },
    project: { type: String, default: '' },
    decisions: { type: [String], default: [] },
    artifacts: { type: [HistoryArtifactSchema], default: [] },
    tags: { type: [String], default: [] },
    search_terms: { type: [String], default: [] },
    normalized_search_text: { type: String, default: '' },
    token_count: { type: Number, default: 0 },
    source: { type: String, enum: ['memory_v2', 'legacy_migration', 'manual'], default: 'memory_v2' },
    status: { type: String, enum: ['active', 'deleted'], default: 'active', index: true },
    access_count: { type: Number, default: 0 },
    last_recalled_at: { type: Date, default: null },
    event_at: { type: Date, default: Date.now, index: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'memory_history_events' }
)
MemoryHistoryEventSchema.index({ user_id: 1, status: 1, event_at: -1 })
MemoryHistoryEventSchema.index(
  { user_id: 1, source_run_id: 1 },
  { unique: true, partialFilterExpression: { source_run_id: { $type: 'string' } } }
)

const MemoryCandidateSchema = new Schema<MemoryCandidateDocument>(
  {
    candidate_id: { type: String, required: true, unique: true, index: true },
    user_id: { type: String, required: true, index: true },
    run_id: { type: String, required: true, index: true },
    kind: { type: String, enum: ['preference', 'history'], required: true },
    category: { type: String, default: '' },
    subject: { type: String, default: '' },
    statement: { type: String, default: '' },
    scope: { type: String, default: 'general' },
    polarity: { type: String, enum: ['positive', 'negative', 'neutral'], default: 'neutral' },
    history_payload: { type: Schema.Types.Mixed, default: null },
    evidence_refs: { type: [EvidenceSchema], default: [] },
    cluster_key: { type: String, default: '', index: true },
    status: {
      type: String,
      enum: ['pending', 'claimed', 'promoted', 'ignored', 'conflict', 'quota_blocked', 'legacy_review'],
      default: 'pending',
      index: true,
    },
    batch_id: { type: String, default: null, index: true },
    suppression_fingerprint: { type: String, default: '' },
    resolution_note: { type: String, default: '' },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'memory_candidates' }
)
MemoryCandidateSchema.index({ user_id: 1, status: 1, created_at: 1 })
MemoryCandidateSchema.index(
  { user_id: 1, run_id: 1, suppression_fingerprint: 1 },
  { unique: true, partialFilterExpression: { suppression_fingerprint: { $type: 'string', $ne: '' } } }
)

const MemoryRunSchema = new Schema<MemoryRunDocument>(
  {
    run_id: { type: String, required: true, unique: true, index: true },
    agent_run_id: { type: String, default: null, index: true },
    user_id: { type: String, required: true, index: true },
    conversation_id: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ['recording', 'awaiting_user', 'queued', 'processing', 'completed', 'discarded', 'failed'],
      default: 'recording',
      index: true,
    },
    evidence: { type: [EvidenceSchema], default: [] },
    attempts: { type: Number, default: 0 },
    available_at: { type: Date, default: Date.now, index: true },
    locked_until: { type: Date, default: null, index: true },
    lease_id: { type: String, default: null },
    error: { type: String, default: '' },
    completed_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'memory_runs' }
)
MemoryRunSchema.index({ status: 1, available_at: 1, locked_until: 1 })

export const UserMemoryProfile =
  mongoose.models.UserMemoryProfile ||
  mongoose.model<UserMemoryProfileDocument>('UserMemoryProfile', UserMemoryProfileSchema)
export const MemoryHistoryEvent =
  mongoose.models.MemoryHistoryEvent ||
  mongoose.model<MemoryHistoryEventDocument>('MemoryHistoryEvent', MemoryHistoryEventSchema)
export const MemoryCandidate =
  mongoose.models.MemoryCandidate ||
  mongoose.model<MemoryCandidateDocument>('MemoryCandidate', MemoryCandidateSchema)
export const MemoryRun =
  mongoose.models.MemoryRun || mongoose.model<MemoryRunDocument>('MemoryRun', MemoryRunSchema)
