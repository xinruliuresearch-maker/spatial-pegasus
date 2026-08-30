import assert from 'node:assert/strict'
import type { AgentProvider } from '../../agent/loop'
import { agentLoop } from '../../agent/loop'
import {
  mergeActiveRunTakeoverTail,
  selectActiveRunTakeoverTail,
} from '../../agent-runtime/messages'
import type {
  ConversationMessage,
  LLMResponse,
  ToolResult,
  ToolSchema,
} from '../../types'

const TEST_DATABASE_SUFFIX = '_test'
const mongoUri = process.env.CONVERSATION_CONTEXT_TEST_MONGODB_URI?.trim()
  || 'mongodb://127.0.0.1:27018/sci_pegasus_conversation_context_test'
const databaseName = mongoUri.match(/\/([^/?]+)(?:\?|$)/)?.[1]

if (!databaseName?.endsWith(TEST_DATABASE_SUFFIX)) {
  throw new Error(
    `Refusing to run Conversation context tests outside an isolated *${TEST_DATABASE_SUFFIX} database.`,
  )
}
process.env.MONGODB_URI = mongoUri

const EMPTY_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

function message(
  id: string,
  sequence: number | undefined,
  content: ConversationMessage['content'],
  role: ConversationMessage['role'] = 'user',
): ConversationMessage {
  return {
    role,
    content,
    timestamp: new Date(`2026-08-10T00:00:${String((sequence ?? 0) + 10).padStart(2, '0')}.000Z`),
    message_id: id,
    run_id: 'run_takeover',
    ...(sequence === undefined ? {} : { sequence }),
  }
}

const summary = message(
  'msg_summary',
  undefined,
  [{ type: 'text', text: 'compacted prefix' }],
)
const oldFullPrefix = message(
  'msg_old_full_prefix',
  -1,
  [{ type: 'text', text: 'must remain full-history only' }],
)
const checkpoint = message(
  'msg_checkpoint',
  0,
  [{ type: 'text', text: 'start current checkpoint' }],
)
const toolUse = message(
  'msg_tool_use',
  1,
  [{
    type: 'tool_use',
    id: 'tool_takeover',
    name: 'Read',
    input: { file_path: 'analysis/research-scope.md' },
  }],
  'assistant',
)
const toolResult = message(
  'msg_tool_result',
  2,
  [{
    type: 'tool_result',
    tool_use_id: 'tool_takeover',
    content: 'durable result',
  }],
)
const laterAssistant = message(
  'msg_later_assistant',
  3,
  [{ type: 'text', text: 'continued after the tool' }],
  'assistant',
)

class CaptureProvider implements AgentProvider {
  readonly toolSchemas: readonly ToolSchema[] = [{
    name: 'Read',
    description: 'test schema',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path'],
    },
  }]
  captured: ConversationMessage[] = []

  buildRequest(messages: ConversationMessage[]): Record<string, unknown> {
    this.captured = messages
    return {}
  }

  buildCompactionRequest(): Record<string, unknown> {
    return {}
  }

  async callLLM(): Promise<LLMResponse> {
    return {
      content: [{ type: 'text', text: 'provider accepted repaired history' }],
      stop_reason: 'end_turn',
      usage: { ...EMPTY_USAGE },
    }
  }

  async callLLMSilent(): Promise<LLMResponse> {
    throw new Error('compaction is not expected')
  }

  async executeTool(): Promise<ToolResult> {
    throw new Error('historical tools must not execute')
  }
}

function assertCompleteToolPairs(messages: readonly ConversationMessage[]): void {
  const uses: string[] = []
  const results: string[] = []
  for (const entry of messages) {
    for (const block of entry.content) {
      if (block.type === 'tool_use') uses.push(block.id)
      if (block.type === 'tool_result') results.push(block.tool_use_id)
    }
  }
  assert.deepEqual(uses, ['tool_takeover'])
  assert.deepEqual(results, ['tool_takeover'])
  assert.ok(
    messages.findIndex(item => item.message_id === 'msg_tool_use')
      < messages.findIndex(item => item.message_id === 'msg_tool_result'),
  )
}

async function main(): Promise<void> {
  const mongoose = (await import('mongoose')).default
  const { connectDB } = await import('../mongodb')
  const { Conversation } = await import('../models')
  const { appendConversationMessages } = await import('../repository')
  const { AgentSessionRuntimeModel } = await import('../../agent-team/models')
  const { appendMemberSessionMessages } = await import('../../agent-runtime/member-session')

  await connectDB()
  assert.ok(mongoose.connection.db)
  await mongoose.connection.db.dropDatabase()
  await Promise.all([
    Conversation.syncIndexes(),
    AgentSessionRuntimeModel.syncIndexes(),
  ])

  const cases = [
    {
      label: 'raw_only',
      full: [oldFullPrefix, checkpoint, toolUse],
      compacted: [summary, checkpoint],
      expectedTail: ['msg_tool_use'],
      persistedBatch: [toolUse, toolResult],
    },
    {
      label: 'compacted_only',
      full: [oldFullPrefix, checkpoint],
      compacted: [summary, checkpoint, toolUse],
      expectedTail: ['msg_tool_use'],
      persistedBatch: [toolUse, toolResult],
    },
    {
      label: 'mixed_multi_message',
      full: [oldFullPrefix, checkpoint, toolUse, laterAssistant],
      compacted: [summary, checkpoint, toolResult],
      expectedTail: ['msg_tool_use', 'msg_tool_result', 'msg_later_assistant'],
      persistedBatch: [toolUse, toolResult, laterAssistant],
    },
  ] as const

  try {
    for (const crashCase of cases) {
      const conversationId = `conversation_${crashCase.label}`
      await Conversation.create({
        conversation_id: conversationId,
        user_id: 'user_takeover',
        messages: [...crashCase.full],
        compacted_messages: [...crashCase.compacted],
      })

      const takeoverTail = selectActiveRunTakeoverTail({
        fullMessages: crashCase.full,
        compactedMessages: crashCase.compacted,
        runId: 'run_takeover',
        checkpointMessageId: 'msg_checkpoint',
        currentActionKind: 'model_request',
      })
      assert.deepEqual(
        takeoverTail.map(item => item.message_id),
        [...crashCase.expectedTail],
      )
      const activeHistory = mergeActiveRunTakeoverTail(
        crashCase.compacted,
        takeoverTail,
      )
      assert.deepEqual(
        activeHistory
          .filter(item => item.run_id === 'run_takeover' && typeof item.sequence === 'number')
          .map(item => item.sequence),
        crashCase.label === 'mixed_multi_message'
          ? [0, 1, 2, 3]
          : [0, 1],
      )
      // Concurrent whole-checkpoint takeover is idempotent and exercises the
      // optimistic CAS retry rather than relying on one in-process writer.
      await Promise.all([
        appendConversationMessages(
          conversationId,
          'user_takeover',
          crashCase.persistedBatch,
          true,
        ),
        appendConversationMessages(
          conversationId,
          'user_takeover',
          crashCase.persistedBatch,
          true,
        ),
      ])

      const stored = await Conversation.findOne({ conversation_id: conversationId }).lean()
      assert.ok(stored)
      const full = stored.messages as ConversationMessage[]
      const compacted = stored.compacted_messages as ConversationMessage[]
      assert.equal(new Set(full.map(item => item.message_id)).size, full.length)
      assert.equal(new Set(compacted.map(item => item.message_id)).size, compacted.length)
      assert.equal(
        compacted.some(item => item.message_id === 'msg_old_full_prefix'),
        false,
        'repair must not restore a deliberately compacted prefix',
      )
      assertCompleteToolPairs(compacted)

      // The actual next provider source of truth is the repaired compacted
      // field. Run it too, ensuring no hidden history repair occurs in-memory.
      const persistedProvider = new CaptureProvider()
      await agentLoop(persistedProvider, compacted, {
        runId: 'run_takeover',
        maxTurns: 1,
      })
      assertCompleteToolPairs(persistedProvider.captured)
    }

    // A durable compaction worker can install the active compacted context
    // after an executor captured a stale `false` hint. The append itself must
    // branch on the document state atomically, keeping the full audit and the
    // provider tail in lockstep without duplicates.
    const staleRootConversationId = 'conversation_stale_active_hint'
    const staleRootTail = message(
      'msg_stale_root_tail',
      4,
      [{ type: 'text', text: 'arrived after worker merge' }],
    )
    await Conversation.create({
      conversation_id: staleRootConversationId,
      user_id: 'user_takeover',
      messages: [oldFullPrefix],
      compacted_messages: [summary],
      context_revision: 9,
    })
    await Promise.all([
      appendConversationMessages(
        staleRootConversationId,
        'user_takeover',
        [staleRootTail],
        false,
      ),
      appendConversationMessages(
        staleRootConversationId,
        'user_takeover',
        [staleRootTail],
        false,
      ),
    ])
    const staleRootStored = await Conversation.findOne({
      conversation_id: staleRootConversationId,
    }).lean()
    assert.ok(staleRootStored)
    const staleRootFull = staleRootStored.messages as ConversationMessage[]
    const staleRootActive = staleRootStored.compacted_messages as ConversationMessage[]
    assert.equal(staleRootFull.filter(item => item.message_id === staleRootTail.message_id).length, 1)
    assert.equal(staleRootActive.filter(item => item.message_id === staleRootTail.message_id).length, 1)
    assert.ok((staleRootStored.context_revision ?? 0) > 9)

    const memberLease = {
      teamId: 'team_member_takeover',
      userId: 'user_takeover',
      agentId: 'agent_member_takeover',
      sessionId: 'session_member_takeover',
      runId: 'run_takeover',
      ownerId: 'owner_member_takeover',
      sessionFenceToken: 'fence_member_takeover',
    }
    await AgentSessionRuntimeModel.create({
      session_id: memberLease.sessionId,
      team_id: memberLease.teamId,
      conversation_id: 'conversation_member_takeover',
      user_id: memberLease.userId,
      agent_id: memberLease.agentId,
      generation: 1,
      active_run_id: memberLease.runId,
      active_lease_owner_id: memberLease.ownerId,
      run_lease: {
        owner_id: memberLease.ownerId,
        fence_token: memberLease.sessionFenceToken,
        heartbeat_at: new Date(),
        expires_at: new Date(Date.now() + 60_000),
      },
      messages: [oldFullPrefix, checkpoint, toolUse, laterAssistant],
      compacted_messages: [summary, checkpoint, toolResult],
    })
    const memberTail = selectActiveRunTakeoverTail({
      fullMessages: [oldFullPrefix, checkpoint, toolUse, laterAssistant],
      compactedMessages: [summary, checkpoint, toolResult],
      runId: memberLease.runId,
      checkpointMessageId: checkpoint.message_id,
      currentActionKind: 'model_request',
    })
    assert.deepEqual(
      memberTail.map(item => item.message_id),
      ['msg_tool_use', 'msg_tool_result', 'msg_later_assistant'],
    )
    await appendMemberSessionMessages(memberLease, memberTail, true)
    await appendMemberSessionMessages(memberLease, memberTail, true)
    const memberSession = await AgentSessionRuntimeModel.findOne({
      session_id: memberLease.sessionId,
    }).lean()
    assert.ok(memberSession)
    const memberFull = memberSession.messages as ConversationMessage[]
    const memberCompacted = memberSession.compacted_messages as ConversationMessage[]
    assert.equal(new Set(memberFull.map(item => item.message_id)).size, memberFull.length)
    assert.equal(new Set(memberCompacted.map(item => item.message_id)).size, memberCompacted.length)
    assert.equal(memberCompacted.some(item => item.message_id === 'msg_old_full_prefix'), false)
    assertCompleteToolPairs(memberCompacted)

    const staleMemberTail = message(
      'msg_stale_member_tail',
      5,
      [{ type: 'text', text: 'member tail after worker merge' }],
    )
    await appendMemberSessionMessages(memberLease, [staleMemberTail], false)
    await appendMemberSessionMessages(memberLease, [staleMemberTail], false)
    const staleMemberSession = await AgentSessionRuntimeModel.findOne({
      session_id: memberLease.sessionId,
    }).lean()
    assert.ok(staleMemberSession)
    const staleMemberFull = staleMemberSession.messages as ConversationMessage[]
    const staleMemberActive = staleMemberSession.compacted_messages as ConversationMessage[]
    assert.equal(staleMemberFull.filter(item => item.message_id === staleMemberTail.message_id).length, 1)
    assert.equal(staleMemberActive.filter(item => item.message_id === staleMemberTail.message_id).length, 1)
    assert.ok((staleMemberSession.context_revision ?? 0) >= 4)
    console.log('✓ Conversation active-context atomic takeover verification passed')
  } finally {
    await mongoose.disconnect()
  }
}

void main()
