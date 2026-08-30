import mongoose, { Schema, Document } from 'mongoose'
import type { ImageAttachment } from '../types'

export interface QueuedMessageDocument extends Document {
  conversation_id: string
  target_run_id?: string | null
  content: string
  /** Stable downstream input id. Deterministic for Agent-Team deliveries. */
  message_id: string
  /** Durable dedupe receipt retained after acknowledgement. */
  idempotency_key?: string | null
  images?: ImageAttachment[]
  priority: 'next'
  status: 'pending' | 'claimed' | 'acknowledged'
  claim_id?: string | null
  claimed_at?: Date | null
  visibility?: 'public' | 'internal'
  source_kind?: 'user' | 'agent' | 'team_supervision'
  created_at: Date
}

const QueuedMessageSchema = new Schema<QueuedMessageDocument>(
  {
    conversation_id: { type: String, required: true, index: true },
    target_run_id: { type: String, default: null, index: true },
    content: { type: String, required: true },
    message_id: { type: String, required: true },
    idempotency_key: { type: String, default: null },
    images: { type: Schema.Types.Mixed },
    priority: { type: String, default: 'next' },
    status: { type: String, enum: ['pending', 'claimed', 'acknowledged'], default: 'pending', index: true },
    claim_id: { type: String, default: null, index: true },
    claimed_at: { type: Date, default: null },
    visibility: { type: String, enum: ['public', 'internal'], default: 'public' },
    source_kind: { type: String, enum: ['user', 'agent', 'team_supervision'], default: 'user' },
    // Run-bound input must not silently disappear. Retention is managed only
    // after a durable message checkpoint acknowledges the claim.
    created_at: { type: Date, default: Date.now },
  },
)

// Compound index for efficient dequeue
QueuedMessageSchema.index({ conversation_id: 1, target_run_id: 1, status: 1, created_at: 1 })
QueuedMessageSchema.index(
  { conversation_id: 1, idempotency_key: 1 },
  { unique: true, partialFilterExpression: { idempotency_key: { $type: 'string' } } },
)
QueuedMessageSchema.index(
  { conversation_id: 1, message_id: 1 },
  { unique: true, partialFilterExpression: { message_id: { $type: 'string' } } },
)

function getQueuedMessageModel(): mongoose.Model<QueuedMessageDocument> {
  const existing = mongoose.models.QueuedMessage as mongoose.Model<QueuedMessageDocument> | undefined
  if (!existing) return mongoose.model<QueuedMessageDocument>('QueuedMessage', QueuedMessageSchema)
  if (!existing.schema.path('visibility')) {
    existing.schema.add({
      visibility: { type: String, enum: ['public', 'internal'], default: 'public' },
      source_kind: { type: String, enum: ['user', 'agent', 'team_supervision'], default: 'user' },
    })
  }
  if (!existing.schema.path('message_id')) {
    existing.schema.add({
      message_id: { type: String, required: true },
      idempotency_key: { type: String, default: null },
    })
    existing.schema.index(
      { conversation_id: 1, idempotency_key: 1 },
      { unique: true, partialFilterExpression: { idempotency_key: { $type: 'string' } } },
    )
    existing.schema.index(
      { conversation_id: 1, message_id: 1 },
      { unique: true, partialFilterExpression: { message_id: { $type: 'string' } } },
    )
  }
  const statusPath = existing.schema.path('status') as typeof existing.schema.paths[string] & {
    enumValues?: string[]
  }
  if (statusPath.enumValues && !statusPath.enumValues.includes('acknowledged')) {
    statusPath.enumValues.push('acknowledged')
  }
  return existing
}

export const QueuedMessage = getQueuedMessageModel()
