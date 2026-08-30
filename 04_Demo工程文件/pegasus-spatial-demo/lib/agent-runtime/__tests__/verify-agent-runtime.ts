import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { ConversationMessage } from '../../types'
import type { WorkspaceInstance } from '../../workspace/types'
import { partitionQueuedMessages } from '../../agent/message-queue'
import { recoverCompactionCheckpoint } from '../compaction-recovery'
import {
  classifyCompactionBarrierJob,
  compactionBarrierOwnerKeyForRun,
  isReloadableCompactionPrepareConflict,
} from '../compaction-barrier'
import {
  filterFreshRunMessages,
  lastMessageId,
  stampRunMessages,
} from '../messages'
import {
  createInternalAgentRunnerSignature,
  isAgentRunnerEnabled,
  isInternalAgentRunnerRequest,
  registerAgentRunnerWake,
  teamAgentStatusAfterRun,
  teamRunExecutionIneligibility,
  wakeAgentRunner,
} from '../runner'
import { dispatchRetryDelayMs } from '../dispatch-policy'
import {
  buildOrphanedToolRecoveryMessage,
  buildInterruptedToolRecoveryMessage,
  buildSelectiveToolRecoveryMessage,
  INTERRUPTED_TOOL_RESULT,
  ORPHANED_TOOL_RESULT,
  type InterruptedAgentTeamToolReplay,
} from '../tool-recovery'
import { isActiveAgentRunStatus, isPublicRootAgentRun } from '../types'
import type { FrozenProjectContextSnapshot } from '../types'
import {
  getToolSchemasForCapabilities,
  toolSchemas,
} from '../../tools/schemas'
import {
  getLegacyAgentTeamRecoverySchemaNames,
} from '../../agent-team/recovery-tool-schemas'
import {
  databaseRetryDelayMs,
  shouldLogDatabaseFailure,
} from '../../db/retry-policy'

function message(text: string, messageId?: string): ConversationMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    ...(messageId ? { message_id: messageId } : {}),
  }
}

function testOrphanedToolRecovery(): void {
  const runId = 'run_orphan_window'
  const messages: ConversationMessage[] = [
    {
      role: 'assistant',
      run_id: runId,
      sequence: 1,
      content: [
        { type: 'tool_use', id: 'orphan_write', name: 'Write', input: { file_path: 'analysis/x.md', content: 'x' } },
        { type: 'tool_use', id: 'paired_read', name: 'Read', input: { file_path: 'analysis/x.md' } },
        { type: 'tool_use', id: 'orphan_ask', name: 'AskUserQuestion', input: { questions: [] } },
      ],
    },
    {
      role: 'user',
      run_id: runId,
      sequence: 2,
      content: [{ type: 'tool_result', tool_use_id: 'paired_read', content: 'done' }],
    },
    {
      role: 'assistant',
      run_id: 'run_other',
      content: [{ type: 'tool_use', id: 'other_run_orphan', name: 'Write', input: {} }],
    },
  ]
  const repaired = buildOrphanedToolRecoveryMessage({
    messages,
    runId,
    sequence: 3,
    messageId: 'msg_orphan_repair',
  })
  assert.ok(repaired)
  assert.equal(repaired.message_id, 'msg_orphan_repair')
  assert.equal(repaired.sequence, 3)
  assert.deepEqual(repaired.content.map(block => block.type === 'tool_result' ? block.tool_use_id : ''), [
    'orphan_write',
    'orphan_ask',
  ])
  assert.ok(repaired.content.every(block => (
    block.type === 'tool_result'
    && block.is_error === true
    && block.content === ORPHANED_TOOL_RESULT
  )))
  assert.equal(buildOrphanedToolRecoveryMessage({
    messages: [...messages, repaired],
    runId,
    sequence: 4,
  }), null, 'orphan repair must be idempotent once results are durable')
}

function hashMessages(messages: ConversationMessage[]): string {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex')
}

const emptyWorkspace = {
  list: () => [],
} as unknown as WorkspaceInstance

const visibleRecoverySchemas = getToolSchemasForCapabilities({
  supportsVision: true,
  includeRecallHistory: true,
})

function testRunMessageStamping(): void {
  const original = [
    message('first', 'msg_existing'),
    { ...message('second'), run_id: 'run_older', sequence: 17 },
  ]
  const stamped = stampRunMessages(original, 'run_current', 4)

  assert.equal(stamped[0].message_id, 'msg_existing')
  assert.equal(stamped[0].run_id, 'run_current')
  assert.equal(stamped[0].sequence, 4)
  assert.match(stamped[1].message_id ?? '', /^msg_/)
  assert.equal(stamped[1].run_id, 'run_older')
  assert.equal(stamped[1].sequence, 17)
  assert.equal(lastMessageId(stamped), stamped[1].message_id)
  assert.equal(original[0].run_id, undefined, 'stamping must not mutate stored input')
}

function testRunMessageReplayIdempotency(): void {
  const existing = [
    message('durable', 'msg_durable'),
  ]
  const incoming = [
    message('durable replay', 'msg_durable'),
    message('fresh', 'msg_fresh'),
    message('fresh duplicate', 'msg_fresh'),
    message('legacy without id'),
  ]

  const fresh = filterFreshRunMessages(existing, incoming)
  assert.deepEqual(
    fresh.map(item => item.message_id),
    ['msg_fresh', undefined],
  )
  assert.equal(existing.length, 1, 'filtering must not mutate durable history')
}

function testActiveStatuses(): void {
  assert.equal(isActiveAgentRunStatus('queued'), true)
  assert.equal(isActiveAgentRunStatus('running'), true)
  assert.equal(isActiveAgentRunStatus('waiting_user'), true)
  assert.equal(isActiveAgentRunStatus('waiting_agents'), true)
  assert.equal(isActiveAgentRunStatus('recoverable'), true)
  assert.equal(isActiveAgentRunStatus('completed'), false)
  assert.equal(isActiveAgentRunStatus('cancelled'), false)
  assert.equal(isActiveAgentRunStatus('failed'), false)
}

function testPublicRunBoundary(): void {
  assert.equal(isPublicRootAgentRun({ root_visible: true, execution_mode: 'conversation' }), true)
  assert.equal(isPublicRootAgentRun({}), true, 'legacy Root Runs remain reconnectable')
  assert.equal(isPublicRootAgentRun({ root_visible: false, execution_mode: 'agent_session' }), false)
  assert.equal(isPublicRootAgentRun({ root_visible: true, execution_mode: 'agent_session' }), false)
  assert.equal(isPublicRootAgentRun({ root_visible: false, execution_mode: 'conversation' }), false)
}

function testQueuedMessageIdempotency(): void {
  const persisted: ConversationMessage[] = [{
    ...message('already durable'),
    source_queue_id: 'queue_1',
  }]
  const queued = [
    { queueId: 'queue_1', messageId: 'queue_message_1', claimId: 'claim_1', content: 'duplicate' },
    { queueId: 'queue_2', messageId: 'queue_message_2', claimId: 'claim_1', content: 'fresh' },
    { queueId: 'queue_recreated', messageId: 'msg_already_durable', claimId: 'claim_1', content: 'replay' },
  ]
  persisted.push(message('stable downstream id', 'msg_already_durable'))
  const partitioned = partitionQueuedMessages(persisted, queued)
  assert.deepEqual(partitioned.duplicate.map(item => item.queueId), ['queue_1', 'queue_recreated'])
  assert.deepEqual(partitioned.fresh.map(item => item.queueId), ['queue_2'])
}

function testInterruptedToolRecovery(): void {
  const action = {
    kind: 'tool_call' as const,
    action_id: 'act_tool',
    tool_use_id: 'tool_use_1',
    tool_name: 'Write',
    input_hash: 'hash',
    attempt: 1,
    started_at: new Date('2026-07-29T00:00:00.000Z'),
  }
  const recovered = buildInterruptedToolRecoveryMessage({
    action,
    messages: [message('before interruption', 'msg_before')],
    runId: 'run_recovery',
    sequence: 7,
    now: new Date('2026-07-29T00:01:00.000Z'),
    messageId: 'msg_recovery',
  })
  assert.ok(recovered)
  assert.equal(recovered.run_id, 'run_recovery')
  assert.equal(recovered.sequence, 7)
  assert.equal(recovered.message_id, 'msg_recovery')
  assert.equal(recovered.content[0].type, 'tool_result')
  if (recovered.content[0].type === 'tool_result') {
    assert.equal(recovered.content[0].tool_use_id, 'tool_use_1')
    assert.equal(recovered.content[0].content, INTERRUPTED_TOOL_RESULT)
    assert.equal(recovered.content[0].is_error, true)
  }

  const alreadyDurable: ConversationMessage[] = [{
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'tool_use_1',
      content: 'success',
    }],
  }]
  assert.equal(buildInterruptedToolRecoveryMessage({
    action,
    messages: alreadyDurable,
    runId: 'run_recovery',
    sequence: 8,
  }), null, 'an existing tool_result must suppress synthetic recovery')
  assert.equal(buildInterruptedToolRecoveryMessage({
    action: { ...action, tool_name: 'AskUserQuestion' },
    messages: [],
    runId: 'run_recovery',
    sequence: 8,
  }), null, 'AskUserQuestion is a control action, not a persisted tool pair')
  assert.equal(buildInterruptedToolRecoveryMessage({
    action: { ...action, kind: 'model_request' },
    messages: [],
    runId: 'run_recovery',
    sequence: 8,
  }), null, 'model requests are retried from the previous message checkpoint')
}

async function testSelectiveAgentTeamToolReplay(): Promise<void> {
  const replayInput = {
    to: 'evidence-scout',
    message: 'Continue the evidence sweep.',
    summary: 'Continue evidence sweep',
  }
  const action = {
    kind: 'tool_call' as const,
    action_id: 'act_team_replay',
    tool_use_id: 'tool_team_replay',
    tool_name: 'SendMessage',
    input_hash: createHash('sha256').update(JSON.stringify(replayInput)).digest('hex'),
    attempt: 1,
    started_at: new Date('2026-08-09T00:00:00.000Z'),
  }
  const assistantToolUse: ConversationMessage = {
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: action.tool_use_id,
      name: action.tool_name,
      input: replayInput,
    }],
    message_id: 'msg_team_tool_use',
  }
  const replays: InterruptedAgentTeamToolReplay[] = []
  const replayed = await buildSelectiveToolRecoveryMessage({
    action,
    messages: [assistantToolUse],
    runId: 'run_team_replay',
    sequence: 3,
    visibleToolSchemas: visibleRecoverySchemas,
    messageId: 'msg_team_replayed_result',
    replayAgentTeamTool: async replay => {
      replays.push(replay)
      return { content: '{"message_id":"mail_1"}' }
    },
  })
  assert.ok(replayed)
  assert.equal(replays.length, 1, 'an incomplete Agent Team tool must replay exactly once')
  assert.deepEqual(replays[0], {
    name: 'SendMessage',
    input: replayInput,
    toolUseId: action.tool_use_id,
    actionId: action.action_id,
  })
  assert.equal(replayed.message_id, 'msg_team_replayed_result')
  assert.equal(replayed.content[0].type, 'tool_result')
  if (replayed.content[0].type === 'tool_result') {
    assert.equal(replayed.content[0].content, '{"message_id":"mail_1"}')
    assert.equal(replayed.content[0].is_error, undefined)
  }

  const legacyInputs: Record<string, Record<string, unknown>> = {
    CreateAgent: {
      alias: 'legacy-scout',
      role: 'Recover an old create command',
      initial_task: { objective: 'Inspect the legacy evidence set.' },
    },
    AssignAgentTask: {
      agent_id: 'agent_legacy_scout',
      objective: 'Inspect the legacy evidence set.',
    },
    SendAgentMessage: {
      to_agent_id: 'agent_legacy_scout',
      kind: 'request',
      message: 'Continue the legacy evidence sweep.',
    },
    InspectAgentTeam: { include_results: true },
    WaitForAgents: { task_ids: ['task_legacy'], mode: 'all', timeout_seconds: 120 },
    SubmitAgentResult: {
      task_id: 'task_legacy',
      outcome: 'completed',
      summary: 'The legacy task is complete.',
    },
    ReviewAgentResult: {
      result_id: 'result_legacy',
      task_action: 'accept',
      file_reviews: [],
    },
  }
  assert.deepEqual(
    getLegacyAgentTeamRecoverySchemaNames().sort(),
    Object.keys(legacyInputs).sort(),
    'every execution-only legacy Team tool must retain its original recovery contract',
  )
  for (const legacyName of getLegacyAgentTeamRecoverySchemaNames()) {
    assert.ok(
      !toolSchemas.some(schema => schema.name === legacyName),
      `${legacyName} must never enter the provider/model-visible catalogue`,
    )
    const legacyInput = legacyInputs[legacyName]
    const legacyAction = {
      ...action,
      action_id: `act_${legacyName}`,
      tool_use_id: `tool_${legacyName}`,
      tool_name: legacyName,
      input_hash: createHash('sha256').update(JSON.stringify(legacyInput)).digest('hex'),
    }
    const legacyReplays: InterruptedAgentTeamToolReplay[] = []
    const legacyRecovered = await buildSelectiveToolRecoveryMessage({
      action: legacyAction,
      messages: [{
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: legacyAction.tool_use_id,
          name: legacyName,
          input: legacyInput,
        }],
      }],
      runId: `run_${legacyName}`,
      sequence: 1,
      visibleToolSchemas: visibleRecoverySchemas,
      replayAgentTeamTool: async legacyReplay => {
        legacyReplays.push(legacyReplay)
        return { content: `replayed ${legacyName}` }
      },
    })
    assert.ok(legacyRecovered, `${legacyName} must produce one durable recovery result`)
    assert.equal(legacyReplays.length, 1, `${legacyName} must replay exactly once for Root`)
    assert.equal(legacyReplays[0].name, legacyName)
    assert.strictEqual(
      legacyReplays[0].input,
      legacyInput,
      `${legacyName} recovery must preserve the exact validated persisted input`,
    )
  }

  const memberVisibleSchemas = getToolSchemasForCapabilities({
    supportsVision: false,
    allowedTools: ['SendMessage', 'TaskUpdate', 'TaskList', 'TaskGet'],
    allowAskUser: false,
  })
  const deniedLegacyInput = legacyInputs.CreateAgent
  const deniedLegacyAction = {
    ...action,
    action_id: 'act_member_denied_legacy_create',
    tool_use_id: 'tool_member_denied_legacy_create',
    tool_name: 'CreateAgent',
    input_hash: createHash('sha256').update(JSON.stringify(deniedLegacyInput)).digest('hex'),
  }
  let deniedLegacyReplayCalls = 0
  const deniedLegacyRecovery = await buildSelectiveToolRecoveryMessage({
    action: deniedLegacyAction,
    messages: [{
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: deniedLegacyAction.tool_use_id,
        name: deniedLegacyAction.tool_name,
        input: deniedLegacyInput,
      }],
    }],
    runId: 'run_member_denied_legacy_create',
    sequence: 2,
    visibleToolSchemas: memberVisibleSchemas,
    replayAgentTeamTool: async () => {
      deniedLegacyReplayCalls += 1
      return { content: 'must never execute' }
    },
  })
  assert.ok(deniedLegacyRecovery)
  assert.equal(deniedLegacyReplayCalls, 0, 'legacy recovery must honor the current canonical member grant')
  assert.equal(deniedLegacyRecovery.content[0].type, 'tool_result')
  if (deniedLegacyRecovery.content[0].type === 'tool_result') {
    assert.equal(deniedLegacyRecovery.content[0].is_error, true)
    assert.match(String(deniedLegacyRecovery.content[0].content), /unknown_tool/)
  }

  const authorizedLegacyInput = legacyInputs.SendAgentMessage
  const authorizedLegacyAction = {
    ...action,
    action_id: 'act_member_authorized_legacy_message',
    tool_use_id: 'tool_member_authorized_legacy_message',
    tool_name: 'SendAgentMessage',
    input_hash: createHash('sha256').update(JSON.stringify(authorizedLegacyInput)).digest('hex'),
  }
  let authorizedLegacyReplayCalls = 0
  await buildSelectiveToolRecoveryMessage({
    action: authorizedLegacyAction,
    messages: [{
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: authorizedLegacyAction.tool_use_id,
        name: authorizedLegacyAction.tool_name,
        input: authorizedLegacyInput,
      }],
    }],
    runId: 'run_member_authorized_legacy_message',
    sequence: 2,
    visibleToolSchemas: memberVisibleSchemas,
    replayAgentTeamTool: async () => {
      authorizedLegacyReplayCalls += 1
      return { content: 'authorized legacy member replay' }
    },
  })
  assert.equal(authorizedLegacyReplayCalls, 1, 'canonical SendMessage authority must permit its legacy replay alias')

  const crashBatchRunId = 'run_selective_plus_orphan'
  const crashBatch: ConversationMessage[] = [{
    ...assistantToolUse,
    run_id: crashBatchRunId,
    content: [
      ...assistantToolUse.content,
      {
        type: 'tool_use',
        id: 'tool_batch_orphan',
        name: 'Write',
        input: { file_path: 'analysis/orphan.md', content: 'not executed' },
      },
    ],
  }]
  const currentRecovered = await buildSelectiveToolRecoveryMessage({
    action,
    messages: crashBatch,
    runId: crashBatchRunId,
    sequence: 4,
    visibleToolSchemas: visibleRecoverySchemas,
    replayAgentTeamTool: async () => ({ content: 'current action recovered' }),
  })
  assert.ok(currentRecovered)
  const remainingOrphans = buildOrphanedToolRecoveryMessage({
    messages: [...crashBatch, currentRecovered],
    runId: crashBatchRunId,
    sequence: 5,
  })
  assert.ok(remainingOrphans)
  assert.deepEqual(
    remainingOrphans.content.map(block => block.type === 'tool_result' ? block.tool_use_id : ''),
    ['tool_batch_orphan'],
    'selective recovery result must exclude its current action from orphan repair',
  )

  let completedReplayCalls = 0
  const alreadyCompleted = await buildSelectiveToolRecoveryMessage({
    action,
    messages: [assistantToolUse, {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: action.tool_use_id,
        content: 'durable',
      }],
    }],
    runId: 'run_team_replay',
    sequence: 4,
    visibleToolSchemas: visibleRecoverySchemas,
    replayAgentTeamTool: async () => {
      completedReplayCalls += 1
      return { content: 'must not execute' }
    },
  })
  assert.equal(alreadyCompleted, null)
  assert.equal(completedReplayCalls, 0, 'a durable tool_result must suppress Team replay')

  let nonTeamReplayCalls = 0
  const nonTeam = await buildSelectiveToolRecoveryMessage({
    action: { ...action, tool_name: 'Write' },
    messages: [{
      ...assistantToolUse,
      content: [{
        type: 'tool_use',
        id: action.tool_use_id,
        name: 'Write',
        input: replayInput,
      }],
    }],
    runId: 'run_non_team',
    sequence: 5,
    visibleToolSchemas: visibleRecoverySchemas,
    replayAgentTeamTool: async () => {
      nonTeamReplayCalls += 1
      return { content: 'must not execute' }
    },
  })
  assert.ok(nonTeam)
  assert.equal(nonTeamReplayCalls, 0, 'non-Team tools must never be replayed automatically')
  assert.equal(nonTeam.content[0].type, 'tool_result')
  if (nonTeam.content[0].type === 'tool_result') {
    assert.equal(nonTeam.content[0].content, INTERRUPTED_TOOL_RESULT)
    assert.equal(nonTeam.content[0].is_error, true)
  }

  const failedReplay = await buildSelectiveToolRecoveryMessage({
    action,
    messages: [assistantToolUse],
    runId: 'run_failed_team_replay',
    sequence: 6,
    visibleToolSchemas: visibleRecoverySchemas,
    replayAgentTeamTool: async () => {
      throw new Error('simulated lease loss')
    },
  })
  assert.ok(failedReplay)
  assert.equal(failedReplay.content[0].type, 'tool_result')
  if (failedReplay.content[0].type === 'tool_result') {
    assert.equal(failedReplay.content[0].content, INTERRUPTED_TOOL_RESULT)
    assert.equal(failedReplay.content[0].is_error, true)
  }

  const rejectedMarker = {
    _sci_pegasus_rejected_tool_input: {
      code: 'not_object',
      path: '$',
      message: 'legacy rejected input',
    },
  }
  const markerAction = {
    ...action,
    action_id: 'act_marker',
    tool_use_id: 'tool_marker',
    tool_name: 'SendAgentMessage',
    input_hash: createHash('sha256').update(JSON.stringify(rejectedMarker)).digest('hex'),
  }
  let markerReplayCalls = 0
  const markerRecovery = await buildSelectiveToolRecoveryMessage({
    action: markerAction,
    messages: [{
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: markerAction.tool_use_id,
        name: markerAction.tool_name,
        input: rejectedMarker,
      }],
    }],
    runId: 'run_marker',
    sequence: 7,
    visibleToolSchemas: visibleRecoverySchemas,
    replayAgentTeamTool: async () => {
      markerReplayCalls += 1
      return { content: 'must never execute' }
    },
  })
  assert.ok(markerRecovery)
  assert.equal(markerReplayCalls, 0, 'a persisted rejected-input marker must never replay')
  assert.equal(markerRecovery.content[0].type, 'tool_result')
  if (markerRecovery.content[0].type === 'tool_result') {
    assert.equal(markerRecovery.content[0].is_error, true)
  }

  const schemaInvalidInput = { to_agent_id: 'agent_evidence_scout', kind: 'request' }
  const schemaAction = {
    ...action,
    action_id: 'act_schema_invalid',
    tool_use_id: 'tool_schema_invalid',
    tool_name: 'SendAgentMessage',
    input_hash: createHash('sha256').update(JSON.stringify(schemaInvalidInput)).digest('hex'),
  }
  let schemaReplayCalls = 0
  const schemaRecovery = await buildSelectiveToolRecoveryMessage({
    action: schemaAction,
    messages: [{
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: schemaAction.tool_use_id,
        name: schemaAction.tool_name,
        input: schemaInvalidInput,
      }],
    }],
    runId: 'run_schema_invalid',
    sequence: 8,
    visibleToolSchemas: visibleRecoverySchemas,
    replayAgentTeamTool: async () => {
      schemaReplayCalls += 1
      return { content: 'must never execute' }
    },
  })
  assert.ok(schemaRecovery)
  assert.equal(schemaReplayCalls, 0, 'schema-invalid Team input must never replay')
  assert.equal(schemaRecovery.content[0].type, 'tool_result')
  if (schemaRecovery.content[0].type === 'tool_result') {
    assert.equal(schemaRecovery.content[0].is_error, true)
    assert.match(String(schemaRecovery.content[0].content), /rejected before execution/)
  }
}

async function testCompactionRecovery(): Promise<void> {
  const messages = [
    message('frozen prefix', 'msg_prefix'),
    message('verbatim tail', 'msg_tail'),
  ]
  const prefix = messages.slice(0, 1)
  const now = new Date('2026-07-29T00:00:00.000Z')

  const retry = await recoverCompactionCheckpoint({
    compaction_id: 'compact_started',
    status: 'started',
    prefix_hash: hashMessages(prefix),
    prefix_message_id: 'msg_prefix',
    started_at: now,
    updated_at: now,
  }, messages, emptyWorkspace, 'run_1')
  assert.equal(retry.action, 'retry')
  assert.deepEqual(retry.messages, messages)

  const invalidBoundary = await recoverCompactionCheckpoint({
    compaction_id: 'compact_missing',
    status: 'summary_ready',
    prefix_hash: hashMessages(prefix),
    prefix_message_id: 'msg_missing',
    summary: 'summary',
    started_at: now,
    updated_at: now,
  }, messages, emptyWorkspace, 'run_1')
  assert.equal(invalidBoundary.action, 'invalid')
  assert.match(invalidBoundary.reason ?? '', /boundary/)

  const invalidHash = await recoverCompactionCheckpoint({
    compaction_id: 'compact_stale',
    status: 'summary_ready',
    prefix_hash: 'stale',
    prefix_message_id: 'msg_prefix',
    summary: 'summary',
    started_at: now,
    updated_at: now,
  }, messages, emptyWorkspace, 'run_1')
  assert.equal(invalidHash.action, 'invalid')
  assert.match(invalidHash.reason ?? '', /hash/)

  const merged = await recoverCompactionCheckpoint({
    compaction_id: 'compact_ready',
    status: 'summary_ready',
    prefix_hash: hashMessages(prefix),
    prefix_message_id: 'msg_prefix',
    summary: 'The work completed before the preserved tail.',
    started_at: now,
    updated_at: now,
  }, messages, emptyWorkspace, 'run_1')
  assert.equal(merged.action, 'merged')
  assert.equal(merged.messages.length, 2)
  assert.equal(merged.messages[0].run_id, 'run_1')
  assert.match(merged.messages[0].message_id ?? '', /^msg_/)
  assert.equal(merged.messages[1].message_id, 'msg_tail')
  const replacementText = merged.messages[0].content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  assert.match(replacementText, /compacted in the background/)
  assert.match(replacementText, /The work completed before the preserved tail/)

  const frozenProjectContext: FrozenProjectContextSnapshot = {
    epoch: 7,
    template_id: 'materials-discovery',
    version: 1,
    guide_title: '材料科学文献发现项目',
    compiled_guide: 'frozen guide',
    guide_hash: 'guide_hash',
    workspace_projection: {
      version: 1,
      content: 'old projection',
      files_hash: 'old_hash',
      generated_at: now,
    },
  }
  const legacyProjectMerge = await recoverCompactionCheckpoint({
    compaction_id: 'compact_legacy_project_context',
    status: 'summary_ready',
    prefix_hash: hashMessages(prefix),
    prefix_message_id: 'msg_prefix',
    summary: 'Legacy checkpoint summary.',
    started_at: now,
    updated_at: now,
  }, messages, emptyWorkspace, 'run_1', frozenProjectContext)
  assert.equal(legacyProjectMerge.action, 'merged')
  assert.equal(
    legacyProjectMerge.checkpointUpgrade?.project_context_snapshot?.epoch,
    8,
    'materializing a legacy replacement must advance the project context epoch exactly once',
  )
  assert.equal(
    legacyProjectMerge.checkpointUpgrade?.project_context_snapshot?.workspace_projection.files_hash,
    legacyProjectMerge.checkpointUpgrade?.workspace_projection?.files_hash,
  )

  const repeatedProjectMerge = await recoverCompactionCheckpoint(
    legacyProjectMerge.checkpointUpgrade,
    messages,
    emptyWorkspace,
    'run_1',
    frozenProjectContext,
  )
  assert.equal(repeatedProjectMerge.action, 'merged')
  assert.equal(
    repeatedProjectMerge.checkpointUpgrade,
    undefined,
    'replaying an upgraded checkpoint must reuse the exact replacement without creating another epoch',
  )
  assert.equal(
    repeatedProjectMerge.messages[0].message_id,
    legacyProjectMerge.checkpointUpgrade?.replacement_message?.message_id,
  )

  // Older deployments could persist the exact replacement and projection
  // before project_context_snapshot was added to the checkpoint schema. The
  // first recovery must backfill the snapshot used by ConversationRuntime;
  // retries must reuse that epoch and replacement identity.
  const replacementOnlyCheckpoint = {
    ...legacyProjectMerge.checkpointUpgrade!,
    compaction_id: 'compact_replacement_without_project_snapshot',
    status: 'summary_ready' as const,
    project_context_snapshot: undefined,
  }
  const replacementBackfill = await recoverCompactionCheckpoint(
    replacementOnlyCheckpoint,
    messages,
    emptyWorkspace,
    'run_1',
    frozenProjectContext,
  )
  assert.equal(replacementBackfill.action, 'merged')
  assert.equal(replacementBackfill.checkpointUpgrade?.status, 'merged')
  assert.equal(replacementBackfill.checkpointUpgrade?.project_context_snapshot?.epoch, 8)
  assert.equal(
    replacementBackfill.messages[0].message_id,
    replacementOnlyCheckpoint.replacement_message?.message_id,
  )

  const repeatedReplacementBackfill = await recoverCompactionCheckpoint(
    replacementBackfill.checkpointUpgrade,
    messages,
    emptyWorkspace,
    'run_1',
    frozenProjectContext,
  )
  assert.equal(repeatedReplacementBackfill.action, 'merged')
  assert.equal(repeatedReplacementBackfill.checkpointUpgrade, undefined)
  assert.equal(
    repeatedReplacementBackfill.messages[0].message_id,
    replacementOnlyCheckpoint.replacement_message?.message_id,
  )

  const alreadyAppliedReplacementBackfill = await recoverCompactionCheckpoint(
    replacementOnlyCheckpoint,
    replacementBackfill.messages,
    emptyWorkspace,
    'run_1',
    frozenProjectContext,
  )
  assert.equal(alreadyAppliedReplacementBackfill.action, 'merged')
  assert.equal(
    alreadyAppliedReplacementBackfill.checkpointUpgrade?.project_context_snapshot?.epoch,
    8,
  )
  assert.deepEqual(
    alreadyAppliedReplacementBackfill.messages,
    replacementBackfill.messages,
    'an already-applied replacement must not be inserted twice',
  )

  const recoveredMergedCheckpoint = await recoverCompactionCheckpoint({
    compaction_id: 'compact_merged_before_db_write',
    status: 'merged',
    prefix_hash: hashMessages(prefix),
    prefix_message_id: 'msg_prefix',
    summary: 'A merge happened in memory before the process stopped.',
    started_at: now,
    updated_at: now,
  }, messages, emptyWorkspace, 'run_1')
  assert.equal(recoveredMergedCheckpoint.action, 'merged')
  assert.equal(recoveredMergedCheckpoint.messages[1].message_id, 'msg_tail')

  const repeatedMerge = await recoverCompactionCheckpoint({
    compaction_id: 'compact_ready',
    status: 'merged',
    prefix_hash: hashMessages(prefix),
    prefix_message_id: 'msg_prefix',
    summary: 'The work completed before the preserved tail.',
    started_at: now,
    updated_at: now,
  }, merged.messages, emptyWorkspace, 'run_1')
  assert.equal(repeatedMerge.action, 'invalid')
  assert.match(repeatedMerge.reason ?? '', /boundary/)
}

function testRunnerGate(): void {
  const previous = process.env.AGENT_RUNTIME_BACKGROUND_RUNNER
  const previousSecret = process.env.AGENT_RUNTIME_INTERNAL_SECRET
  process.env.AGENT_RUNTIME_BACKGROUND_RUNNER = '1'
  process.env.AGENT_RUNTIME_INTERNAL_SECRET = 'runtime-test-secret'
  registerAgentRunnerWake(null)
  assert.equal(isAgentRunnerEnabled(), false, 'an env flag alone must not accept background work')

  let wakes = 0
  registerAgentRunnerWake(() => { wakes += 1 })
  assert.equal(isAgentRunnerEnabled(), true)
  wakeAgentRunner()
  assert.equal(wakes, 1)

  registerAgentRunnerWake(null)
  if (previous === undefined) delete process.env.AGENT_RUNTIME_BACKGROUND_RUNNER
  else process.env.AGENT_RUNTIME_BACKGROUND_RUNNER = previous
  if (previousSecret === undefined) delete process.env.AGENT_RUNTIME_INTERNAL_SECRET
  else process.env.AGENT_RUNTIME_INTERNAL_SECRET = previousSecret
}

function testRunnerDispatchSignatureAndBackoff(): void {
  const previousSecret = process.env.AGENT_RUNTIME_INTERNAL_SECRET
  process.env.AGENT_RUNTIME_INTERNAL_SECRET = 'runtime-test-secret'
  const signature = createInternalAgentRunnerSignature('run_1', 'owner_1')
  assert.ok(signature)
  assert.equal(isInternalAgentRunnerRequest(signature, 'run_1', 'owner_1'), true)
  assert.equal(isInternalAgentRunnerRequest(signature, 'run_2', 'owner_1'), false)
  assert.equal(isInternalAgentRunnerRequest('invalid', 'run_1', 'owner_1'), false)
  assert.equal(dispatchRetryDelayMs(1), 2_000)
  assert.equal(dispatchRetryDelayMs(2), 4_000)
  assert.equal(dispatchRetryDelayMs(20), 60_000)
  if (previousSecret === undefined) delete process.env.AGENT_RUNTIME_INTERNAL_SECRET
  else process.env.AGENT_RUNTIME_INTERNAL_SECRET = previousSecret
}

function testRunnerTeamIdentityGate(): void {
  const run = {
    run_id: 'run_team_identity_gate',
    conversation_id: 'conv_team_identity_gate',
    team_id: 'team_identity_gate',
    agent_id: 'agent_identity_gate',
    agent_session_id: 'session_current',
  }
  const eligible = {
    teamStatus: 'active' as const,
    teamConversationId: run.conversation_id,
    agentStatus: 'idle' as const,
    currentSessionId: run.agent_session_id,
  }
  assert.equal(teamRunExecutionIneligibility(run, eligible), null)
  assert.equal(
    teamRunExecutionIneligibility(run, { ...eligible, agentStatus: 'running' }),
    null,
  )
  for (const status of ['paused', 'completed', 'failed'] as const) {
    assert.match(
      teamRunExecutionIneligibility(run, { ...eligible, agentStatus: status }) ?? '',
      new RegExp(`TeamAgent is ${status}`),
      `${status} is permanent identity ineligibility, not capacity pressure`,
    )
  }
  assert.match(
    teamRunExecutionIneligibility(run, {
      ...eligible,
      currentSessionId: 'session_reopened_generation',
    }) ?? '',
    /stale TeamAgent session/,
  )
  assert.match(
    teamRunExecutionIneligibility(run, { ...eligible, agentStatus: null }) ?? '',
    /no longer exists/,
  )
  assert.match(
    teamRunExecutionIneligibility(run, { ...eligible, teamStatus: 'completed' }) ?? '',
    /Team that is completed/,
  )
}

function testRootSupervisionFailureContainment(): void {
  const rootSupervision = {
    trigger: 'supervision' as const,
    execution_mode: 'conversation' as const,
    root_visible: true,
  }
  assert.equal(
    teamAgentStatusAfterRun(rootSupervision, { status: 'failed' }),
    'idle',
    'one automatic Root supervision failure must not brick the coordinator',
  )
  assert.equal(
    teamAgentStatusAfterRun(
      { ...rootSupervision, trigger: 'user' },
      { status: 'failed' },
    ),
    'failed',
    'a public/user Root failure retains the existing failure semantics',
  )
  assert.equal(
    teamAgentStatusAfterRun(
      {
        trigger: 'message',
        execution_mode: 'agent_session',
        root_visible: false,
      },
      { status: 'failed' },
    ),
    'failed',
    'member Run failures retain the existing failure semantics',
  )
  assert.equal(
    teamAgentStatusAfterRun(rootSupervision, { status: 'completed' }),
    'idle',
  )
}

function testDatabaseOutageBackoff(): void {
  const midpoint = () => 0.5
  assert.equal(databaseRetryDelayMs(1, midpoint), 1_000)
  assert.equal(databaseRetryDelayMs(2, midpoint), 2_000)
  assert.equal(databaseRetryDelayMs(3, midpoint), 4_000)
  assert.equal(databaseRetryDelayMs(6, midpoint), 30_000)
  assert.equal(databaseRetryDelayMs(20, midpoint), 30_000)
  assert.equal(databaseRetryDelayMs(1, () => 0), 800)
  assert.equal(databaseRetryDelayMs(1, () => 1), 1_200)

  const startedAt = 1_000_000
  assert.equal(shouldLogDatabaseFailure(1, null, startedAt), true)
  assert.equal(shouldLogDatabaseFailure(2, startedAt, startedAt + 59_999), false)
  assert.equal(shouldLogDatabaseFailure(3, startedAt, startedAt + 60_000), true)
}

function testDurableCompactionBarrierPolicy(): void {
  const now = new Date('2026-08-10T00:00:00.000Z')
  assert.equal(compactionBarrierOwnerKeyForRun({
    execution_mode: 'conversation',
    conversation_id: 'conv_barrier_root',
  }), 'conversation:conv_barrier_root')
  assert.equal(compactionBarrierOwnerKeyForRun({
    execution_mode: 'agent_session',
    conversation_id: 'conv_barrier_member',
    agent_session_id: 'session_barrier_member',
  }), 'agent_session:session_barrier_member')
  assert.equal(compactionBarrierOwnerKeyForRun({
    execution_mode: 'agent_session',
    conversation_id: 'conv_barrier_member',
  }), null)

  for (const status of [
    'queued',
    'summarizing',
    'summary_ready',
    'merge_prepared',
    'retryable',
  ] as const) {
    const decision = classifyCompactionBarrierJob('conversation:conv_barrier_root', {
      job_id: `job_${status}`,
      status,
      available_at: new Date(now.getTime() + 60_000),
    }, now)
    assert.equal(decision.kind, 'defer')
    if (decision.kind === 'defer') {
      assert.ok(decision.retryAt.getTime() >= now.getTime() + 2_000)
      assert.ok(decision.retryAt.getTime() <= now.getTime() + 5_000)
    }
  }

  for (const status of ['merged', 'cancelled', 'superseded']) {
    assert.equal(classifyCompactionBarrierJob('conversation:conv_barrier_root', {
      job_id: `job_${status}`,
      status,
    }, now).kind, 'open')
  }
  const failed = classifyCompactionBarrierJob('conversation:conv_barrier_root', {
    job_id: 'job_failed',
    idempotency_key: 'failed_trigger_key',
    status: 'failed',
    last_error: 'summary retries exhausted',
  }, now)
  assert.equal(failed.kind, 'open')
  if (failed.kind === 'open') {
    assert.equal(failed.terminalStatus, 'failed')
    assert.equal(failed.repairRequired, true)
    assert.equal(failed.terminalIdempotencyKey, 'failed_trigger_key')
    assert.match(failed.terminalError ?? '', /summary retries exhausted/)
  }
  assert.equal(classifyCompactionBarrierJob('conversation:conv_barrier_root', {
    job_id: 'job_unknown',
    status: 'future_non_terminal_state',
  }, now).kind, 'failed', 'unknown states must fail closed')
  assert.equal(
    classifyCompactionBarrierJob('conversation:conv_barrier_root', null, now).kind,
    'open',
  )
  assert.equal(isReloadableCompactionPrepareConflict({
    code: 'COMPACTION_PREFIX_CONFLICT',
  }), true, 'a stale frozen prefix must reload the canonical context')
  assert.equal(isReloadableCompactionPrepareConflict({
    code: 'COMPACTION_OWNER_NOT_FOUND',
  }), false, 'unrelated prepare failures must still fail closed')
}

async function main(): Promise<void> {
  testRunMessageStamping()
  testRunMessageReplayIdempotency()
  testActiveStatuses()
  testPublicRunBoundary()
  testQueuedMessageIdempotency()
  testInterruptedToolRecovery()
  testOrphanedToolRecovery()
  await testSelectiveAgentTeamToolReplay()
  await testCompactionRecovery()
  testRunnerGate()
  testRunnerDispatchSignatureAndBackoff()
  testRunnerTeamIdentityGate()
  testRootSupervisionFailureContainment()
  testDatabaseOutageBackoff()
  testDurableCompactionBarrierPolicy()
  console.log('✓ Agent Runtime V2 verification passed')
}

void main()
