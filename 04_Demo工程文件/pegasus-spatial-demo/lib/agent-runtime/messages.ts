import { randomUUID } from 'crypto'
import type { ConversationMessage } from '@/lib/types'
import type { AgentRunActionKind } from './types'

export function newMessageId(): string {
  return `msg_${randomUUID()}`
}

export function stampRunMessages(
  messages: ConversationMessage[],
  runId: string,
  startingSequence: number,
): ConversationMessage[] {
  return messages.map((message, index) => ({
    ...message,
    message_id: message.message_id ?? newMessageId(),
    run_id: message.run_id ?? runId,
    sequence: message.sequence ?? startingSequence + index,
  }))
}

export function lastMessageId(messages: ConversationMessage[]): string | undefined {
  return messages[messages.length - 1]?.message_id
}

/**
 * Remove messages that have already crossed a durable message boundary.
 *
 * Runtime V2 retries a whole checkpoint after a process interruption. Stable
 * message IDs make replay safe without changing the legacy append semantics
 * for callers that do not yet assign IDs.
 */
export function filterFreshRunMessages(
  existingMessages: ConversationMessage[] | undefined,
  incomingMessages: ConversationMessage[],
): ConversationMessage[] {
  const seen = new Set(
    (existingMessages ?? [])
      .map(message => message.message_id)
      .filter((messageId): messageId is string => Boolean(messageId)),
  )

  return incomingMessages.filter(message => {
    if (!message.message_id) return true
    if (seen.has(message.message_id)) return false
    seen.add(message.message_id)
    return true
  })
}

function messageSequence(message: ConversationMessage): number | null {
  return typeof message.sequence === 'number' && Number.isFinite(message.sequence)
    ? message.sequence
    : null
}

function messageIdSet(messages: readonly ConversationMessage[]): Set<string> {
  return new Set(messages
    .map(message => message.message_id)
    .filter((messageId): messageId is string => Boolean(messageId)))
}

function uniqueMessagesById(
  messages: readonly ConversationMessage[],
): ConversationMessage[] {
  const seen = new Set<string>()
  const unique: ConversationMessage[] = []
  for (const message of messages) {
    const messageId = message.message_id
    if (!messageId || seen.has(messageId)) continue
    seen.add(messageId)
    unique.push(message)
  }
  return unique
}

/**
 * Select the exact current-Run tail that may have crossed only one side of the
 * legacy `messages` -> `compacted_messages` two-write boundary.
 *
 * A compacted prefix intentionally omits old full-history messages, so a plain
 * union would undo compaction. We only open a repair window when a durable
 * current action is incomplete, or when a still-unacknowledged input/queue ID
 * is present on exactly one side. The checkpoint sequence then bounds the tail
 * that is safe to put back into both arrays.
 */
export function selectActiveRunTakeoverTail(input: {
  fullMessages: readonly ConversationMessage[]
  compactedMessages: readonly ConversationMessage[]
  runId: string
  checkpointMessageId?: string | null
  currentActionKind?: AgentRunActionKind | null
  currentToolUseId?: string | null
  requiredMessageIds?: readonly string[]
}): ConversationMessage[] {
  if (input.compactedMessages.length === 0) return []

  const fullIds = messageIdSet(input.fullMessages)
  const compactedIds = messageIdSet(input.compactedMessages)
  const oneSidedRequiredIds = new Set((input.requiredMessageIds ?? []).filter(messageId => (
    fullIds.has(messageId) !== compactedIds.has(messageId)
  )))
  const hasIncompleteAppendAction = input.currentActionKind === 'model_request'
    || input.currentActionKind === 'tool_call'
  if (!hasIncompleteAppendAction && oneSidedRequiredIds.size === 0) return []

  const union = uniqueMessagesById([
    ...input.fullMessages,
    ...input.compactedMessages,
  ])
  const checkpoint = input.checkpointMessageId
    ? union.find(message => message.message_id === input.checkpointMessageId)
    : undefined
  const checkpointSequence = checkpoint ? messageSequence(checkpoint) : null

  let candidates = union.filter(message => {
    if (message.run_id !== input.runId || !message.message_id) return false
    if (oneSidedRequiredIds.has(message.message_id)) return true
    const sequence = messageSequence(message)
    if (hasIncompleteAppendAction && checkpointSequence !== null && sequence !== null) {
      return sequence > checkpointSequence
    }
    if (input.currentActionKind === 'tool_call' && input.currentToolUseId) {
      return message.content.some(block => (
        (block.type === 'tool_use' && block.id === input.currentToolUseId)
        || (block.type === 'tool_result' && block.tool_use_id === input.currentToolUseId)
      ))
    }
    return false
  })

  if (candidates.length === 0) return []

  // A legacy multi-message append can leave different members of one tail on
  // opposite sides. Once the bounded tail starts, carry every later sequenced
  // message from this Run so the repaired arrays have identical pair order.
  const firstSequence = candidates
    .map(messageSequence)
    .filter((sequence): sequence is number => sequence !== null)
    .reduce<number | null>((minimum, sequence) => (
      minimum === null ? sequence : Math.min(minimum, sequence)
    ), null)
  if (firstSequence !== null) {
    candidates = union.filter(message => (
      message.run_id === input.runId
      && message.message_id
      && messageSequence(message) !== null
      && messageSequence(message)! >= firstSequence
    ))
  }

  return candidates.sort((left, right) => {
    const leftSequence = messageSequence(left)
    const rightSequence = messageSequence(right)
    if (leftSequence !== null && rightSequence !== null) return leftSequence - rightSequence
    if (leftSequence !== null) return -1
    if (rightSequence !== null) return 1
    return 0
  })
}

/** Merge a repaired current-Run tail into the provider's active context. */
export function mergeActiveRunTakeoverTail(
  activeMessages: readonly ConversationMessage[],
  takeoverTail: readonly ConversationMessage[],
): ConversationMessage[] {
  if (takeoverTail.length === 0) return [...activeMessages]
  const runId = takeoverTail[0].run_id
  const firstSequence = takeoverTail
    .map(messageSequence)
    .filter((sequence): sequence is number => sequence !== null)
    .reduce<number | null>((minimum, sequence) => (
      minimum === null ? sequence : Math.min(minimum, sequence)
    ), null)
  const takeoverIds = messageIdSet(takeoverTail)
  const activeTail = firstSequence === null
    ? []
    : activeMessages.filter(message => (
        message.run_id === runId
        && messageSequence(message) !== null
        && messageSequence(message)! >= firstSequence
      ))
  const activeTailIds = messageIdSet(activeTail)
  const prefix = activeMessages.filter(message => (
    !takeoverIds.has(message.message_id ?? '')
    && !activeTailIds.has(message.message_id ?? '')
  ))
  const mergedTail = uniqueMessagesById([...activeTail, ...takeoverTail])
    .sort((left, right) => {
      const leftSequence = messageSequence(left)
      const rightSequence = messageSequence(right)
      if (leftSequence !== null && rightSequence !== null) return leftSequence - rightSequence
      if (leftSequence !== null) return -1
      if (rightSequence !== null) return 1
      return 0
    })
  return [...prefix, ...mergedTail]
}
