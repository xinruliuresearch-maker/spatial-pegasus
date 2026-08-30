// ============================================================
// Mid-turn message queue — MongoDB-backed
// Allows users to send messages while the agent loop is running
// ============================================================

import { connectDB } from '../db/mongodb'
import { QueuedMessage, type QueuedMessageDocument } from '../db/queue-model'
import type { ConversationMessage, ImageAttachment } from '../types'
import { randomUUID } from 'crypto'
import { AgentRun } from '../agent-runtime/models'
import { AgentTeamModel } from '../agent-team/models'

export interface DequeuedMessage {
  queueId: string
  messageId: string
  claimId: string
  content: string
  images?: ImageAttachment[]
  visibility?: 'public' | 'internal'
  sourceKind?: 'user' | 'agent' | 'team_supervision'
}

export function partitionQueuedMessages(
  persistedMessages: ConversationMessage[],
  queuedMessages: DequeuedMessage[],
): { fresh: DequeuedMessage[]; duplicate: DequeuedMessage[] } {
  const persistedQueueIds = new Set(
    persistedMessages
      .map(message => message.source_queue_id)
      .filter((queueId): queueId is string => !!queueId),
  )
  const persistedMessageIds = new Set(
    persistedMessages
      .map(message => message.message_id)
      .filter((messageId): messageId is string => !!messageId),
  )
  return {
    fresh: queuedMessages.filter(message => (
      !persistedQueueIds.has(message.queueId) && !persistedMessageIds.has(message.messageId)
    )),
    duplicate: queuedMessages.filter(message => (
      persistedQueueIds.has(message.queueId) || persistedMessageIds.has(message.messageId)
    )),
  }
}

export interface IdempotentQueuedMessageReceipt {
  queueId: string
  messageId: string
  targetRunId: string | null
  status: 'pending' | 'claimed' | 'acknowledged'
}

function receipt(document: QueuedMessageDocument): IdempotentQueuedMessageReceipt {
  return {
    queueId: String(document._id),
    messageId: document.message_id || `queue_msg_legacy_${String(document._id)}`,
    targetRunId: document.target_run_id ?? null,
    status: document.status,
  }
}

/** Enqueue a mid-turn message for a running conversation */
export async function enqueueMessage(
  conversationId: string,
  content: string,
  images?: ImageAttachment[],
  targetRunId?: string,
  options?: {
    visibility?: 'public' | 'internal'
    sourceKind?: 'user' | 'agent' | 'team_supervision'
    /** Stable across process takeover. The row becomes a retained delivery receipt. */
    idempotencyKey?: string
    /** Stable ConversationMessage id used to suppress replay after queue acknowledgement. */
    messageId?: string
  },
): Promise<IdempotentQueuedMessageReceipt> {
  await connectDB()
  const messageId = options?.messageId ?? `queue_msg_${randomUUID()}`
  let stored: QueuedMessageDocument
  if (options?.idempotencyKey) {
    try {
      stored = await QueuedMessage.findOneAndUpdate(
        {
          conversation_id: conversationId,
          idempotency_key: options.idempotencyKey,
        },
        {
          $setOnInsert: {
            conversation_id: conversationId,
            target_run_id: targetRunId ?? null,
            content,
            message_id: messageId,
            idempotency_key: options.idempotencyKey,
            images,
            priority: 'next',
            status: 'pending',
            visibility: options.visibility ?? 'public',
            source_kind: options.sourceKind ?? 'user',
          },
        },
        { upsert: true, returnDocument: 'after' },
      )
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error
      const winner = await QueuedMessage.findOne({
        conversation_id: conversationId,
        idempotency_key: options.idempotencyKey,
      })
      if (!winner) throw error
      stored = winner
    }
    if (
      stored.message_id !== messageId
      || stored.content !== content
      || stored.visibility !== (options.visibility ?? 'public')
      || stored.source_kind !== (options.sourceKind ?? 'user')
    ) {
      throw new Error(`Queued message idempotency key was reused with a different payload: ${options.idempotencyKey}`)
    }
  } else {
    stored = await QueuedMessage.create({
      conversation_id: conversationId,
      target_run_id: targetRunId ?? null,
      content,
      message_id: messageId,
      idempotency_key: null,
      images,
      priority: 'next',
      status: 'pending',
      visibility: options?.visibility ?? 'public',
      source_kind: options?.sourceKind ?? 'user',
    })
  }
  console.log(`[message-queue] Enqueued message for ${conversationId}: "${content.slice(0, 50)}"`)
  return receipt(stored)
}

export async function getIdempotentQueuedMessage(
  conversationId: string,
  idempotencyKey: string,
): Promise<IdempotentQueuedMessageReceipt | null> {
  await connectDB()
  const document = await QueuedMessage.findOne({
    conversation_id: conversationId,
    idempotency_key: idempotencyKey,
  })
  return document ? receipt(document) : null
}

/**
 * Bind a durable delivery receipt to the Run that will consume it. A null
 * target is deliberately CAS-only: takeover may discover that another worker
 * already bound or claimed the same receipt, in which case that identity wins.
 */
export async function bindIdempotentQueuedMessageToRun(
  conversationId: string,
  idempotencyKey: string,
  targetRunId: string,
): Promise<IdempotentQueuedMessageReceipt | null> {
  await connectDB()
  const bound = await QueuedMessage.findOneAndUpdate(
    {
      conversation_id: conversationId,
      idempotency_key: idempotencyKey,
      $or: [
        { target_run_id: null },
        { target_run_id: { $exists: false } },
        { target_run_id: targetRunId },
      ],
    },
    { $set: { target_run_id: targetRunId } },
    { returnDocument: 'after' },
  )
  if (bound) return receipt(bound)
  return getIdempotentQueuedMessage(conversationId, idempotencyKey)
}

/**
 * Move one exact member-only reminder away from a superseded Run. The message
 * id is derived from the durable mailbox source, so this never touches an
 * unrelated user/Root queue item and never makes the row globally claimable.
 */
export async function rerouteTargetedInternalAgentMessage(
  conversationId: string,
  messageId: string,
  targetRunId: string,
): Promise<boolean> {
  await connectDB()
  const routed = await QueuedMessage.findOneAndUpdate(
    {
      conversation_id: conversationId,
      message_id: messageId,
      visibility: 'internal',
      source_kind: 'agent',
      target_run_id: { $type: 'string', $ne: targetRunId },
    },
    {
      $set: {
        target_run_id: targetRunId,
        status: 'pending',
        claim_id: null,
        claimed_at: null,
      },
    },
    { returnDocument: 'after' },
  )
  if (routed) return true
  return Boolean(await QueuedMessage.exists({
    conversation_id: conversationId,
    message_id: messageId,
    visibility: 'internal',
    source_kind: 'agent',
    target_run_id: targetRunId,
  }))
}

/**
 * A successor Run whose start envelope already contains this mailbox source
 * supersedes the old reminder. Retain idempotent rows as acknowledged receipts
 * and remove legacy non-idempotent rows; importantly, neither path untargets
 * the member-only content into Root's conversation queue.
 */
export async function settleSupersededInternalAgentMessage(
  conversationId: string,
  messageId: string,
  successorRunId: string,
): Promise<number> {
  await connectDB()
  const exact = {
    conversation_id: conversationId,
    message_id: messageId,
    visibility: 'internal' as const,
    source_kind: 'agent' as const,
  }
  const retained = await QueuedMessage.updateMany(
    { ...exact, idempotency_key: { $type: 'string' } },
    {
      $set: {
        target_run_id: successorRunId,
        status: 'acknowledged',
        claim_id: null,
        claimed_at: null,
      },
    },
  )
  const removed = await QueuedMessage.deleteMany({
    ...exact,
    $or: [
      { idempotency_key: null },
      { idempotency_key: { $exists: false } },
    ],
  })
  return retained.modifiedCount + removed.deletedCount
}

/**
 * Atomically claim pending messages. Callers must acknowledge only after the
 * corresponding ConversationMessage checkpoint is durable.
 */
export async function dequeueMessages(
  conversationId: string,
  targetRunId?: string,
  options?: { targetedOnly?: boolean },
): Promise<DequeuedMessage[]> {
  await connectDB()
  const claimId = `queue_claim_${randomUUID()}`
  const docs: QueuedMessageDocument[] = []
  while (true) {
    const doc = await QueuedMessage.findOneAndUpdate(
      {
        conversation_id: conversationId,
        status: 'pending',
        ...(targetRunId
          ? options?.targetedOnly
            ? { target_run_id: targetRunId }
            : { $or: [{ target_run_id: targetRunId }, { target_run_id: null }] }
          : { target_run_id: null }),
      },
      {
        $set: {
          status: 'claimed',
          claim_id: claimId,
          claimed_at: new Date(),
          // If an untargeted update is claimed at the safe boundary, this CAS
          // also records the consuming Run before acknowledgement. Thus a
          // crash cannot leave an acknowledged receipt pointing at no Run.
          ...(targetRunId ? { target_run_id: targetRunId } : {}),
        },
      },
      { sort: { created_at: 1 }, returnDocument: 'after' },
    )
    if (!doc) break
    docs.push(doc)
  }
  if (docs.length === 0) return []

  console.log(`[message-queue] Dequeued ${docs.length} messages for ${conversationId}`)
  return docs.map(d => ({
    queueId: String(d._id),
    messageId: d.message_id || `queue_msg_legacy_${String(d._id)}`,
    claimId,
    content: d.content,
    images: d.images as ImageAttachment[] | undefined,
    visibility: d.visibility,
    sourceKind: d.source_kind,
  }))
}

export async function acknowledgeDequeuedMessages(queueIds: string[], claimId: string): Promise<void> {
  if (queueIds.length === 0) return
  await connectDB()
  await QueuedMessage.updateMany(
    {
      _id: { $in: queueIds },
      status: 'claimed',
      claim_id: claimId,
      idempotency_key: { $type: 'string' },
    },
    {
      $set: {
        status: 'acknowledged',
        claim_id: null,
        claimed_at: null,
      },
    },
  )
  await QueuedMessage.deleteMany({
    _id: { $in: queueIds },
    status: 'claimed',
    claim_id: claimId,
    $or: [
      { idempotency_key: null },
      { idempotency_key: { $exists: false } },
    ],
  })
}

/**
 * Return one exact, uncommitted dequeue claim to the pending state. This is
 * narrower than releaseQueuedMessagesForRun(): the target Run identity is
 * preserved so a member-only update cannot leak into the public Root queue.
 */
export async function releaseDequeuedMessageClaim(
  queueIds: string[],
  claimId: string,
): Promise<void> {
  if (queueIds.length === 0) return
  await connectDB()
  await QueuedMessage.updateMany(
    {
      _id: { $in: queueIds },
      status: 'claimed',
      claim_id: claimId,
    },
    {
      $set: {
        status: 'pending',
        claim_id: null,
        claimed_at: null,
      },
    },
  )
}

export async function releaseQueuedMessagesForRun(targetRunId: string): Promise<number> {
  await connectDB()
  const result = await QueuedMessage.updateMany(
    { target_run_id: targetRunId, status: { $in: ['pending', 'claimed'] } },
    {
      $set: {
        target_run_id: null,
        status: 'pending',
        claim_id: null,
        claimed_at: null,
      },
    },
  )
  return result.modifiedCount
}

/**
 * Repair the standalone-Mongo crash window between terminalizing a Root Run
 * and releasing its durable Team-update receipts. Only internal
 * team-supervision rows are eligible: member-only `source_kind=agent` rows
 * must retain their exact session target and can never leak into Root.
 *
 * The terminal Run plus `(conversation_id, target_run_id, status)` form the
 * durable outbox fence. Repeating this sweep is safe, including after a crash
 * halfway through a bulk update.
 */
export async function repairTerminalRootTeamQueueReceipts(input: {
  conversationId?: string
  runId?: string
  limit?: number
} = {}): Promise<number> {
  await connectDB()
  const limit = Math.max(1, Math.min(input.limit ?? 500, 2_000))
  const candidates = await QueuedMessage.find({
    ...(input.conversationId ? { conversation_id: input.conversationId } : {}),
    ...(input.runId ? { target_run_id: input.runId } : { target_run_id: { $type: 'string' } }),
    visibility: 'internal',
    source_kind: 'team_supervision',
    status: { $in: ['pending', 'claimed'] },
  }).sort({ created_at: 1 }).limit(limit).select('conversation_id target_run_id').lean<Array<{
    conversation_id: string
    target_run_id: string
  }>>()
  if (candidates.length === 0) return 0

  const targetRunIds = [...new Set(candidates.map(candidate => candidate.target_run_id))]
  const terminalRuns = await AgentRun.find({
    run_id: { $in: targetRunIds },
    status: { $in: ['completed', 'cancelled', 'failed'] },
    execution_mode: { $ne: 'agent_session' },
    root_visible: { $ne: false },
    team_id: { $type: 'string' },
    agent_id: { $type: 'string' },
  }).select('run_id conversation_id team_id agent_id').lean<Array<{
    run_id: string
    conversation_id: string
    team_id: string
    agent_id: string
  }>>()
  if (terminalRuns.length === 0) return 0
  const teams = await AgentTeamModel.find({
    team_id: { $in: [...new Set(terminalRuns.map(run => run.team_id))] },
  }).select('team_id conversation_id root_agent_id').lean<Array<{
    team_id: string
    conversation_id: string
    root_agent_id: string
  }>>()
  const rootIdentity = new Set(teams.map(team => (
    `${team.team_id}\u0000${team.conversation_id}\u0000${team.root_agent_id}`
  )))
  const terminalRootRuns = terminalRuns.filter(run => rootIdentity.has(
    `${run.team_id}\u0000${run.conversation_id}\u0000${run.agent_id}`,
  ))
  if (terminalRootRuns.length === 0) return 0

  const result = await QueuedMessage.bulkWrite(terminalRootRuns.map(run => ({
    updateMany: {
      filter: {
        conversation_id: run.conversation_id,
        target_run_id: run.run_id,
        visibility: 'internal',
        source_kind: 'team_supervision',
        status: { $in: ['pending', 'claimed'] },
      },
      update: {
        $set: {
          target_run_id: null,
          status: 'pending',
          claim_id: null,
          claimed_at: null,
        },
      },
    },
  })), { ordered: false })
  return result.modifiedCount
}

export async function releaseStaleQueueClaims(maxAgeMs = 60_000): Promise<number> {
  await connectDB()
  const result = await QueuedMessage.updateMany(
    {
      status: 'claimed',
      claimed_at: { $lte: new Date(Date.now() - maxAgeMs) },
    },
    {
      $set: {
        status: 'pending',
        claim_id: null,
        claimed_at: null,
      },
    },
  )
  return result.modifiedCount
}

/** Check if there are queued messages without fetching them */
export async function hasQueuedMessages(conversationId: string, targetRunId?: string): Promise<boolean> {
  await connectDB()
  const count = await QueuedMessage.countDocuments({
    conversation_id: conversationId,
    status: 'pending',
    ...(targetRunId
      ? { $or: [{ target_run_id: targetRunId }, { target_run_id: null }] }
      : { target_run_id: null }),
  })
  return count > 0
}
