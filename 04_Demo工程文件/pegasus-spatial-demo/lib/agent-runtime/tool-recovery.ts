import { createHash, randomUUID } from 'node:crypto'
import { isAgentTeamTool } from '../agent-team/tool-adapter'
import {
  isLegacyAgentTeamToolName,
  normalizeAgentTeamToolNameForExecution,
} from '../agent-team/policy'
import { getLegacyAgentTeamRecoverySchema } from '../agent-team/recovery-tool-schemas'
import {
  enforceToolInputBoundary,
  enforceVisibleToolInputBoundary,
  rejectedToolInputResultMessage,
} from '../agent/tool-input-boundary'
import type { ConversationMessage, ToolResult, ToolSchema, ToolUseBlock } from '../types'
import type { AgentRunCurrentAction } from './types'

export const INTERRUPTED_TOOL_RESULT =
  'Tool execution was interrupted by a process restart. The result is unknown. Inspect the workspace or current state before deciding whether to retry.'

export const ORPHANED_TOOL_RESULT =
  'Tool call was checkpointed before execution was durably authorized. It was not run during recovery; inspect current state and issue a new tool call if still needed.'

export interface InterruptedAgentTeamToolReplay {
  name: string
  input: Record<string, unknown>
  toolUseId: string
  actionId: string
}

export function findDurableToolResultMessage(
  action: AgentRunCurrentAction | null | undefined,
  messages: readonly ConversationMessage[],
): ConversationMessage | null {
  if (action?.kind !== 'tool_call' || !action.tool_use_id) return null
  return messages.find(message => message.content.some(block => (
    block.type === 'tool_result' && block.tool_use_id === action.tool_use_id
  ))) ?? null
}

export function findInterruptedAgentTeamToolUse(
  action: AgentRunCurrentAction,
  messages: readonly ConversationMessage[],
): ToolUseBlock | null {
  if (!action.tool_use_id || !action.tool_name || !isAgentTeamTool(action.tool_name)) {
    return null
  }
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const blocks = messages[messageIndex].content
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = blocks[blockIndex]
      if (
        block.type !== 'tool_use'
        || block.id !== action.tool_use_id
        || block.name !== action.tool_name
      ) continue
      if (action.input_hash) {
        const boundary = enforceToolInputBoundary(block.input)
        if (!boundary.ok) return null
        const actualHash = createHash('sha256')
          .update(boundary.serialized)
          .digest('hex')
        if (actualHash !== action.input_hash) return null
      }
      return block
    }
  }
  return null
}

/**
 * Close every tool_use persisted for this Run that has no matching durable
 * tool_result. This repairs the crash window after the assistant checkpoint is
 * committed but before the first tool action journal is written. Orphans are
 * never replayed because no durable action proves execution was authorized.
 */
export function buildOrphanedToolRecoveryMessage(input: {
  messages: readonly ConversationMessage[]
  runId: string
  sequence: number
  now?: Date
  messageId?: string
}): ConversationMessage | null {
  const completedIds = new Set<string>()
  for (const message of input.messages) {
    for (const block of message.content) {
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        completedIds.add(block.tool_use_id)
      }
    }
  }

  const orphanIds: string[] = []
  const seenIds = new Set<string>()
  for (const message of input.messages) {
    if (message.role !== 'assistant' || message.run_id !== input.runId) continue
    for (const block of message.content) {
      if (
        block.type !== 'tool_use'
        || typeof block.id !== 'string'
        || completedIds.has(block.id)
        || seenIds.has(block.id)
      ) continue
      seenIds.add(block.id)
      orphanIds.push(block.id)
    }
  }
  if (orphanIds.length === 0) return null

  return {
    role: 'user',
    content: orphanIds.map(toolUseId => ({
      type: 'tool_result' as const,
      tool_use_id: toolUseId,
      content: ORPHANED_TOOL_RESULT,
      is_error: true,
      cache_control: { type: 'ephemeral' as const },
    })),
    timestamp: input.now ?? new Date(),
    message_id: input.messageId ?? `msg_${randomUUID()}`,
    run_id: input.runId,
    sequence: input.sequence,
  }
}

/**
 * Close an interrupted tool_use/tool_result pair without replaying a possibly
 * side-effecting tool. The synthetic result is produced only when the exact
 * tool_use_id has no durable result yet; replaying recovery is therefore
 * idempotent at the conversation-history boundary.
 */
export function buildInterruptedToolRecoveryMessage(input: {
  action: AgentRunCurrentAction | null | undefined
  messages: ConversationMessage[]
  runId: string
  sequence: number
  now?: Date
  messageId?: string
}): ConversationMessage | null {
  const { action, messages } = input
  if (
    action?.kind !== 'tool_call'
    || !action.tool_use_id
    || action.tool_name === 'AskUserQuestion'
  ) {
    return null
  }
  if (findDurableToolResultMessage(action, messages)) return null

  return {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: action.tool_use_id,
      content: INTERRUPTED_TOOL_RESULT,
      is_error: true,
    }],
    timestamp: input.now ?? new Date(),
    message_id: input.messageId ?? `msg_${randomUUID()}`,
    run_id: input.runId,
    sequence: input.sequence,
  }
}

/**
 * Selectively replay an interrupted Agent Team command from its durable
 * assistant tool_use. Team commands use (run_id, tool_use_id) receipts (and
 * derived child keys), so replay closes multi-step create/publish operations
 * without duplicating their side effects. Every other tool keeps the cautious
 * synthetic-unknown recovery contract.
 */
export async function buildSelectiveToolRecoveryMessage(input: {
  action: AgentRunCurrentAction | null | undefined
  messages: ConversationMessage[]
  runId: string
  sequence: number
  /** Exact schema set visible to this Agent when recovery is attempted. */
  visibleToolSchemas: readonly ToolSchema[]
  replayAgentTeamTool: (
    replay: InterruptedAgentTeamToolReplay,
  ) => Promise<ToolResult>
  now?: Date
  messageId?: string
}): Promise<ConversationMessage | null> {
  const { action, messages } = input
  if (
    action?.kind !== 'tool_call'
    || !action.tool_use_id
    || !action.tool_name
    || action.tool_name === 'AskUserQuestion'
  ) {
    return null
  }
  if (findDurableToolResultMessage(action, messages)) return null

  const toolUse = findInterruptedAgentTeamToolUse(action, messages)
  if (!toolUse) {
    return buildInterruptedToolRecoveryMessage(input)
  }

  // Legacy Team schemas are intentionally absent from provider-visible tools.
  // Recovery may use one only when the corresponding canonical tool is still
  // visible under the Agent's *current* grant.  A legacy name supplied in the
  // caller's schema list never grants authority by itself.
  let validationSchemas = input.visibleToolSchemas
  if (isLegacyAgentTeamToolName(toolUse.name)) {
    const canonicalName = normalizeAgentTeamToolNameForExecution(toolUse.name)
    const canonicalAuthorized = input.visibleToolSchemas.some(schema => (
      schema.name === canonicalName
    ))
    const recoverySchema = canonicalAuthorized
      ? getLegacyAgentTeamRecoverySchema(toolUse.name)
      : undefined
    validationSchemas = recoverySchema ? [recoverySchema] : []
  }

  const boundary = enforceVisibleToolInputBoundary(
    toolUse.name,
    toolUse.input,
    validationSchemas,
  )
  if (!boundary.ok) {
    return {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: rejectedToolInputResultMessage(boundary.rejection),
        is_error: true,
        cache_control: { type: 'ephemeral' },
      }],
      timestamp: input.now ?? new Date(),
      message_id: input.messageId ?? `msg_${randomUUID()}`,
      run_id: input.runId,
      sequence: input.sequence,
    }
  }

  try {
    const result = await input.replayAgentTeamTool({
      name: toolUse.name,
      input: boundary.input,
      toolUseId: toolUse.id,
      actionId: action.action_id,
    })
    return {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result.content,
        is_error: result.is_error,
        cache_control: { type: 'ephemeral' },
      }],
      timestamp: input.now ?? new Date(),
      message_id: input.messageId ?? `msg_${randomUUID()}`,
      run_id: input.runId,
      sequence: input.sequence,
    }
  } catch (error) {
    console.error(
      `[agent-run] Agent Team tool replay failed for ${action.tool_name}; falling back to unknown result:`,
      error instanceof Error ? error.message : String(error),
    )
    return buildInterruptedToolRecoveryMessage(input)
  }
}
