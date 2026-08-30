import { connectDB } from './mongodb'
import { Conversation, ConversationDocument } from './models'
import {
  ConversationDoc,
  ConversationMessage,
  type ProjectGuideRef,
} from '../types'
import { randomUUID } from 'crypto'
import { deleteConversationFiles } from './gridfs'
import { deleteConversationImageAssets } from '../media/storage'
import { filterFreshRunMessages } from '../agent-runtime/messages'

/**
 * Soft cap on a single Conversation document — 14MB, ~87% of MongoDB's
 * 16MB BSON hard limit. New image messages contain only opaque asset IDs and
 * their bytes live in OSS (with GridFS only as a development fallback), so reaching 14MB now
 * requires an extreme amount of text/tool history. We refuse the write
 * before we'd otherwise crash with a 16MB driver error so the user gets a
 * graceful "open a new conversation" message instead of a stack trace.
 */
const MAX_DOC_BYTES = 14 * 1024 * 1024

export class DocumentTooLargeError extends Error {
  readonly code = 'DOCUMENT_TOO_LARGE'
  readonly currentBytes: number
  readonly addedBytes: number
  constructor(currentBytes: number, addedBytes: number) {
    super('对话已达单文档存储上限，请新建对话继续')
    this.name = 'DocumentTooLargeError'
    this.currentBytes = currentBytes
    this.addedBytes = addedBytes
  }
}

export class ImmutableConversationFieldError extends Error {
  readonly code = 'IMMUTABLE_CONVERSATION_FIELD'
  readonly field: string

  constructor(field: string) {
    super(`Conversation field is immutable after creation: ${field}`)
    this.name = 'ImmutableConversationFieldError'
    this.field = field
  }
}

export interface CreateConversationInput {
  settings?: Partial<ConversationDoc['settings']>
  projectGuide?: ProjectGuideRef
}

type LegacyCreateConversationSettings = Partial<ConversationDoc['settings']>

function normalizeCreateConversationInput(
  input?: CreateConversationInput | LegacyCreateConversationSettings,
): CreateConversationInput {
  if (!input) return {}
  if ('settings' in input || 'projectGuide' in input) {
    return input as CreateConversationInput
  }
  // Compatibility with existing callers that passed settings directly.
  return { settings: input as LegacyCreateConversationSettings }
}

/** Approximate BSON byte cost via JSON serialization. JSON is ~5-10% larger
 *  than BSON for our payload (string-heavy), and the 14MB threshold has a
 *  2MB buffer to the 16MB hard limit, so the approximation is safe. */
function estimateBytes(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload))
}

async function appendMessagesIdempotently(
  conversationId: string,
  userId: string,
  field: 'messages' | 'compacted_messages',
  messages: ConversationMessage[],
): Promise<void> {
  if (messages.length === 0) return
  const now = new Date()
  for (const message of messages) {
    await Conversation.updateOne(
      {
        conversation_id: conversationId,
        user_id: userId,
        ...(message.message_id
          ? { [`${field}.message_id`]: { $ne: message.message_id } }
          : {}),
      },
      {
        $push: { [field]: message },
        $set: { updated_at: now },
        $inc: { context_revision: 1 },
      },
    )
  }
}

export async function createConversation(
  userId: string,
  input?: CreateConversationInput | LegacyCreateConversationSettings,
): Promise<ConversationDocument> {
  await connectDB()
  const { settings, projectGuide } = normalizeCreateConversationInput(input)
  const doc = await Conversation.create({
    conversation_id: randomUUID(),
    user_id: userId,
    settings: {
      orchestrator_model: settings?.orchestrator_model ?? 'anthropic/claude-opus-4-6',
      research_domain: settings?.research_domain ?? '',
    },
    ...(projectGuide ? { project_guide: projectGuide } : {}),
  })
  return doc
}

export async function getConversation(
  conversationId: string,
  userId: string
): Promise<ConversationDocument | null> {
  await connectDB()
  return Conversation.findOne({ conversation_id: conversationId, user_id: userId })
}

/**
 * Atomically pin a Project Guide on legacy Conversations that predate the
 * field. The raw collection write deliberately bypasses Mongoose's immutable
 * setter, while the filter guarantees an existing value can never be
 * overwritten. Normal updates must go through updateConversationFields(),
 * which rejects this field altogether.
 */
export async function initializeConversationProjectGuide(
  conversationId: string,
  userId: string,
  projectGuide: ProjectGuideRef,
): Promise<boolean> {
  await connectDB()
  const result = await Conversation.collection.updateOne(
    {
      conversation_id: conversationId,
      user_id: userId,
      $or: [
        { project_guide: { $exists: false } },
        { project_guide: null },
      ],
    },
    { $set: { project_guide: projectGuide } },
  )
  return result.modifiedCount === 1
}

export async function listConversations(userId: string): Promise<ConversationDocument[]> {
  await connectDB()
  return Conversation.find({ user_id: userId })
    .select('conversation_id title settings created_at updated_at _waiting_for_user _last_interrupted pinned')
    .sort({ pinned: -1, updated_at: -1 })
    .limit(50)
}

export async function listProjects(
  userId: string,
  page = 1,
  limit = 20,
  search?: string
): Promise<{ data: ConversationDocument[]; total: number }> {
  await connectDB()
  const filter: Record<string, unknown> = { user_id: userId }
  if (search?.trim()) {
    filter.title = { $regex: search.trim(), $options: 'i' }
  }
  const [data, total] = await Promise.all([
    Conversation.find(filter)
      .select('conversation_id title settings output.files created_at updated_at _waiting_for_user _last_interrupted')
      .sort({ updated_at: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Conversation.countDocuments(filter),
  ])
  return { data, total }
}

export async function listCanvasConversations(userId: string): Promise<ConversationDocument[]> {
  await connectDB()
  return Conversation.find({
    user_id: userId,
    $expr: {
      $ne: [
        { $ifNull: [{ $getField: { field: 'gridfs_id', input: { $getField: { field: 'output/diagram/main.xml', input: '$output.files' } } } }, null] },
        null,
      ],
    },
  })
    .select('conversation_id title settings updated_at')
    .sort({ updated_at: -1 })
    .limit(50)
}

export async function updateConversationFields(
  conversationId: string,
  userId: string,
  fields: Record<string, unknown>
): Promise<void> {
  const update: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'project_guide' || key.startsWith('project_guide.')) {
      throw new ImmutableConversationFieldError(key)
    }
    update[key] = value
  }
  await connectDB()
  await Conversation.updateOne({ conversation_id: conversationId, user_id: userId }, { $set: update })
}

export async function appendMessages(
  conversationId: string,
  userId: string,
  messages: ConversationMessage[]
): Promise<void> {
  await connectDB()

  // Pre-write size guard — fetch the doc once and refuse if pushing the new
  // messages would tip us past 14MB. The findOne adds one round-trip per
  // append, but chat/route.ts already loaded the same doc moments earlier
  // so it's almost certainly server-cached.
  const existing = await Conversation.findOne(
    { conversation_id: conversationId, user_id: userId },
  ).lean()
  const freshMessages = filterFreshRunMessages(
    existing?.messages as ConversationMessage[] | undefined,
    messages,
  )
  if (freshMessages.length === 0) return

  if (existing) {
    const currentBytes = estimateBytes(existing)
    const addedBytes = estimateBytes(freshMessages)
    if (currentBytes + addedBytes > MAX_DOC_BYTES) {
      throw new DocumentTooLargeError(currentBytes, addedBytes)
    }
  }

  await appendMessagesIdempotently(
    conversationId,
    userId,
    'messages',
    freshMessages,
  )
}

function requireDurableMessageBatch(
  messages: readonly ConversationMessage[],
): ConversationMessage[] {
  const byId = new Map<string, ConversationMessage>()
  for (const message of messages) {
    if (!message.message_id) {
      throw new Error('Atomic Conversation message append requires a stable message_id.')
    }
    // Keep the last copy at the last requested position. A retry of a whole
    // checkpoint therefore canonicalizes accidental duplicates as one tail.
    byId.delete(message.message_id)
    byId.set(message.message_id, message)
  }
  return [...byId.values()]
}

function reconcileMessageTail(
  existing: readonly ConversationMessage[],
  batch: readonly ConversationMessage[],
): ConversationMessage[] {
  const batchIds = new Set(batch.map(message => message.message_id))
  return [
    ...existing.filter(message => !message.message_id || !batchIds.has(message.message_id)),
    ...batch,
  ]
}

function reconcileMessageArrayExpression(
  field: 'messages' | 'compacted_messages',
  batch: readonly ConversationMessage[],
): Record<string, unknown> {
  const messageIds = batch.map(message => message.message_id)
  return {
    $concatArrays: [
      {
        $filter: {
          input: { $ifNull: [`$${field}`, []] },
          as: 'existing_message',
          cond: {
            $not: [{ $in: ['$$existing_message.message_id', messageIds] }],
          },
        },
      },
      { $literal: batch },
    ],
  }
}

/**
 * Append one durable checkpoint to the full audit history and, when active,
 * the compacted provider history in one MongoDB document update.
 *
 * The pipeline removes each stable message ID before appending the canonical
 * batch. Besides making retries idempotent, this repairs either legacy
 * one-sided crash state without duplicating the full audit history.
 */
export async function appendConversationMessages(
  conversationId: string,
  userId: string,
  messages: readonly ConversationMessage[],
  _appendToCompacted: boolean,
): Promise<void> {
  if (messages.length === 0) return
  // Compatibility-only hint; document state at the atomic update is authoritative.
  void _appendToCompacted
  await connectDB()
  const batch = requireDurableMessageBatch(messages)

  // Optimistic CAS keeps the existing 14MB pre-write guard meaningful when a
  // user submits from two processes. A successful write always changes the
  // timestamp by at least one millisecond, so a loser re-reads and re-checks.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const existing = await Conversation.findOne({
      conversation_id: conversationId,
      user_id: userId,
    }).lean()
    if (!existing) return

    const full = reconcileMessageTail(
      (existing.messages ?? []) as ConversationMessage[],
      batch,
    )
    // Active-context routing is a property of the document at the atomic
    // write boundary. A caller may have read `compacted_messages` before a
    // durable worker swapped the summary in, so its boolean hint is never an
    // authority here.
    const hasCompactedContext = ((existing.compacted_messages ?? []) as unknown[]).length > 0
    const compacted = hasCompactedContext
      ? reconcileMessageTail(
          (existing.compacted_messages ?? []) as ConversationMessage[],
          batch,
        )
      : (existing.compacted_messages ?? []) as ConversationMessage[]
    const projected = {
      ...existing,
      messages: full,
      compacted_messages: compacted,
    }
    const currentBytes = estimateBytes(existing)
    const projectedBytes = estimateBytes(projected)
    if (projectedBytes > MAX_DOC_BYTES) {
      throw new DocumentTooLargeError(currentBytes, projectedBytes - currentBytes)
    }

    const priorUpdatedAt = existing.updated_at instanceof Date
      ? existing.updated_at
      : new Date(existing.updated_at ?? 0)
    const priorContextRevision = typeof existing.context_revision === 'number'
      ? existing.context_revision
      : 0
    const contextRevisionFilter = priorContextRevision === 0
      ? {
          $or: [
            { context_revision: 0 },
            { context_revision: null },
            { context_revision: { $exists: false } },
          ],
        }
      : { context_revision: priorContextRevision }
    const nextUpdatedAt = new Date(Math.max(Date.now(), priorUpdatedAt.getTime() + 1))
    const result = await Conversation.collection.updateOne(
      {
        _id: existing._id,
        updated_at: priorUpdatedAt,
        ...contextRevisionFilter,
      },
      [{
        $set: {
          messages: reconcileMessageArrayExpression('messages', batch),
          compacted_messages: {
            $cond: [
              {
                $gt: [
                  { $size: { $ifNull: ['$compacted_messages', []] } },
                  0,
                ],
              },
              reconcileMessageArrayExpression('compacted_messages', batch),
              { $ifNull: ['$compacted_messages', []] },
            ],
          },
          context_revision: { $add: [{ $ifNull: ['$context_revision', 0] }, 1] },
          updated_at: nextUpdatedAt,
        },
      }],
    )
    if (result.matchedCount === 1) return
  }

  throw new Error('Conversation message append conflicted repeatedly; retry the Run checkpoint.')
}

export async function deleteConversation(
  conversationId: string,
  userId: string
): Promise<boolean> {
  await connectDB()
  // Ownership check before deletion — returning false for non-matching userId
  // also prevents GridFS files from being cleaned by someone who doesn't own them.
  const owned = await Conversation.exists({ conversation_id: conversationId, user_id: userId })
  if (!owned) return false

  // Remove GridFS files and message image assets first. If this fails, we'd rather leave a partial
  // deletion (conversation still present in Mongo) than orphaned GridFS files
  // the user can no longer reference. Worst case retry from the UI.
  try {
    const fileCount = await deleteConversationFiles(conversationId)
    if (fileCount > 0) {
      console.log(`[repository] deleted ${fileCount} GridFS files for conversation ${conversationId}`)
    }
    const imageCount = await deleteConversationImageAssets(conversationId)
    if (imageCount > 0) {
      console.log(`[repository] deleted ${imageCount} message image assets for conversation ${conversationId}`)
    }
  } catch (err) {
    console.error(`[repository] deleteConversationFiles failed for ${conversationId}:`, (err as Error).message)
    throw err
  }

  const result = await Conversation.deleteOne({ conversation_id: conversationId, user_id: userId })
  return result.deletedCount > 0
}

export async function updateTitle(
  conversationId: string,
  userId: string,
  title: string
): Promise<void> {
  await connectDB()
  await Conversation.updateOne(
    { conversation_id: conversationId, user_id: userId },
    { $set: { title } }
  )
}

/**
 * Replace compacted messages and increment compaction count.
 * compacted_messages is used instead of messages for LLM API calls.
 */
export async function replaceCompactedMessages(
  conversationId: string,
  userId: string,
  compactedMessages: ConversationMessage[]
): Promise<void> {
  await writeCompactedMessages(conversationId, userId, compactedMessages, true)
}

/**
 * Synchronize the already-active compacted context without counting another
 * compaction. This is used after a merge checkpoint has been made durable and
 * the same AgentRun subsequently appends a verbatim tail.
 */
export async function setCompactedMessages(
  conversationId: string,
  userId: string,
  compactedMessages: ConversationMessage[]
): Promise<void> {
  await writeCompactedMessages(conversationId, userId, compactedMessages, false)
}

async function writeCompactedMessages(
  conversationId: string,
  userId: string,
  compactedMessages: ConversationMessage[],
  incrementCount: boolean,
): Promise<void> {
  await connectDB()

  // Same 14MB guard as appendMessages. Compaction typically shrinks context
  // so this rarely trips, but a pathological tool result could still bloat.
  const existing = await Conversation.findOne(
    { conversation_id: conversationId, user_id: userId },
  ).lean()

  if (existing) {
    // Replace, not append — substitute the compacted_messages field's size
    // when estimating the post-write total.
    const existingCompactedBytes = estimateBytes(
      (existing as { compacted_messages?: unknown }).compacted_messages ?? [],
    )
    const newCompactedBytes = estimateBytes(compactedMessages)
    const projected = estimateBytes(existing) - existingCompactedBytes + newCompactedBytes
    if (projected > MAX_DOC_BYTES) {
      throw new DocumentTooLargeError(estimateBytes(existing), newCompactedBytes - existingCompactedBytes)
    }
  }

  await Conversation.updateOne(
    { conversation_id: conversationId, user_id: userId },
    incrementCount
      ? {
          $set: { compacted_messages: compactedMessages },
          $inc: { compaction_count: 1, context_revision: 1 },
        }
      : {
          $set: { compacted_messages: compactedMessages },
          $inc: { context_revision: 1 },
        },
  )
}

/**
 * Append new turns to the active compacted context without touching the full
 * audit history or incrementing compaction_count. Once compacted_messages is
 * active it must keep advancing on every normal turn; otherwise the next
 * request resumes from a stale summary and silently loses post-compaction work.
 */
export async function appendCompactedMessages(
  conversationId: string,
  userId: string,
  messages: ConversationMessage[],
): Promise<void> {
  if (messages.length === 0) return
  await connectDB()

  const existing = await Conversation.findOne(
    { conversation_id: conversationId, user_id: userId },
  ).lean()
  const freshMessages = filterFreshRunMessages(
    existing?.compacted_messages as ConversationMessage[] | undefined,
    messages,
  )
  if (freshMessages.length === 0) return

  if (existing) {
    const currentBytes = estimateBytes(existing)
    const addedBytes = estimateBytes(freshMessages)
    if (currentBytes + addedBytes > MAX_DOC_BYTES) {
      throw new DocumentTooLargeError(currentBytes, addedBytes)
    }
  }

  await appendMessagesIdempotently(
    conversationId,
    userId,
    'compacted_messages',
    freshMessages,
  )
}
