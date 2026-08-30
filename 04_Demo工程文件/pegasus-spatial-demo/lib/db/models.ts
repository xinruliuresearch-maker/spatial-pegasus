import mongoose, { Schema, Document } from 'mongoose'
import { ConversationDoc } from '../types'

export interface ConversationDocument extends Omit<ConversationDoc, 'messages'>, Document {
  messages: unknown[]
}

const ConversationSchema = new Schema<ConversationDocument>(
  {
    conversation_id: { type: String, required: true, unique: true, index: true },
    user_id: { type: String, required: true, index: true },
    title: { type: String, default: '新对话' },
    settings: {
      orchestrator_model: { type: String, default: 'google/gemini-2.5-flash' },
      research_domain: { type: String, default: '' },
      memory_enabled: { type: Boolean },
    },
    /** Immutable reference to the task-specific Project Guide template. */
    project_guide: { type: Schema.Types.Mixed, default: undefined, immutable: true },
    user_input: { type: String, default: '' },
    analysis: { type: Schema.Types.Mixed, default: {} },
    output: {
      // GridFS-backed research workspace files and version manifest.
      files: { type: Schema.Types.Mixed, default: {} },
      manifest: { type: Schema.Types.Mixed, default: {} },
    },
    messages: { type: [Schema.Types.Mixed], default: [] },
    /** Compacted messages for API use — when non-empty, used instead of messages for LLM calls */
    compacted_messages: { type: [Schema.Types.Mixed], default: [] },
    /** Number of times compaction has been performed */
    compaction_count: { type: Number, default: 0 },
    /** CAS epoch for messages/compacted_messages, independent from metadata writes. */
    context_revision: { type: Number, default: 0 },
    last_applied_compaction_id: { type: String, default: null },
    context_compaction_fence: { type: Schema.Types.Mixed, default: null },
    /** Conservative cache-validity marker used before rewriting active context. */
    prompt_cache_last_activity_at: { type: Date, default: null },
    /** Small bounded sample arrays; these are observations, not tuning knobs. */
    hippocampus_telemetry: { type: Schema.Types.Mixed, default: null },
    /** Memory V2 run journal and one-time first-turn history snapshot. */
    memory_context: { type: Schema.Types.Mixed, default: null },
    /** True when the last agent run was aborted — fallback for checkpoint-1 interruption rendering */
    _last_interrupted: { type: Boolean, default: false },
    /** True when the agent loop exited via AskUserQuestion and is awaiting user response */
    _waiting_for_user: { type: Boolean, default: false },
    /** User-pinned conversations always float to the top of the sidebar list. */
    pinned: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
)

ConversationSchema.index({ user_id: 1, pinned: -1, updated_at: -1 })

/**
 * Patch additive schema paths into Next.js' cached development model. Without
 * this, Mongoose strict mode silently drops a newly-added project_guide until
 * the dev server is restarted.
 */
function getConversationModel() {
  const existing = mongoose.models.Conversation as mongoose.Model<ConversationDocument> | undefined
  if (!existing) {
    return mongoose.model<ConversationDocument>('Conversation', ConversationSchema)
  }
  if (!existing.schema.path('project_guide')) {
    existing.schema.add({
      project_guide: { type: Schema.Types.Mixed, default: undefined, immutable: true },
    })
  } else {
    const projectGuidePath = existing.schema.path('project_guide') as typeof existing.schema.paths[string] & {
      $immutable?: boolean
    }
    if (!projectGuidePath.$immutable) projectGuidePath.immutable(true)
  }
  if (!existing.schema.path('context_revision')) {
    existing.schema.add({
      context_revision: { type: Number, default: 0 },
      last_applied_compaction_id: { type: String, default: null },
      context_compaction_fence: { type: Schema.Types.Mixed, default: null },
    })
  }
  return existing
}

export const Conversation = getConversationModel()
