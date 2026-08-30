import assert from 'node:assert/strict'
import type { BackgroundCompactionHandoffDescriptor } from '../../agent/loop'
import type { FrozenProjectContextSnapshot } from '../../agent-runtime/types'
import type { ConversationMessage } from '../../types'

const mongoUri = process.env.AGENT_COMPACTION_TEST_MONGODB_URI?.trim()
  || 'mongodb://127.0.0.1:27018/sci_pegasus_agent_compaction_handoff_test'
const databaseName = mongoUri.match(/\/([^/?]+)(?:\?|$)/)?.[1]
if (!databaseName?.endsWith('_test')) {
  throw new Error('Refusing to run compaction handoff verification outside an isolated *_test database.')
}
process.env.MONGODB_URI = mongoUri

function message(id: string, text: string): ConversationMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    message_id: id,
    timestamp: new Date('2026-08-10T00:00:00.000Z'),
  }
}

function projectContext(epoch: number): FrozenProjectContextSnapshot {
  return {
    epoch,
    template_id: 'materials-discovery',
    version: 1,
    guide_title: 'Materials Discovery',
    compiled_guide: 'Frozen guide',
    guide_hash: 'guide-hash',
    workspace_projection: {
      version: 1,
      content: `Frozen workspace epoch ${epoch}`,
      files_hash: 'workspace-files-hash',
      generated_at: new Date('2026-08-10T00:00:00.000Z'),
    },
  }
}

async function main(): Promise<void> {
  const mongoose = (await import('mongoose')).default
  const { connectDB } = await import('../../db/mongodb')
  const { Conversation } = await import('../../db/models')
  const { AgentSessionRuntimeModel } = await import('../../agent-team/models')
  const { AgentRun } = await import('../../agent-runtime/models')
  const { DurableCompactionJobModel } = await import('../models')
  const { resolveAuthoritativeModelSnapshot } = await import('../../llm-registry')
  const {
    activatePreparedCompactionJob,
    cancelCompactionJob,
    claimNextCompactionJob,
    hashCompactionMessages,
  } = await import('../repository')
  const { handoffBackgroundCompaction } = await import('../handoff')

  await connectDB()
  const database = mongoose.connection.db
  assert.ok(database)
  await database.dropDatabase()
  await Promise.all([
    Conversation.syncIndexes(),
    AgentSessionRuntimeModel.syncIndexes(),
    AgentRun.syncIndexes(),
    DurableCompactionJobModel.syncIndexes(),
  ])
  const mainProResolution = await resolveAuthoritativeModelSnapshot('main_pro')

  const userId = 'handoff_user'

  // The intent is durable before the local silent provider call begins, but
  // the worker cannot steal it before the background timeout. Activating the
  // same Job models loop-exit/interrupt; cancelling it models a local merge.
  const shadowConversationId = 'handoff_shadow_conversation'
  const shadowPrefix = [message('shadow_01', 'shadow prefix')]
  await Conversation.create({
    conversation_id: shadowConversationId,
    user_id: userId,
    settings: { orchestrator_model: 'main_pro' },
    messages: shadowPrefix,
    compacted_messages: [],
  })
  const shadowSnapshot = projectContext(1)
  const shadowDescriptor: BackgroundCompactionHandoffDescriptor = {
    idempotencyKey: 'cmp_shadow_stable',
    sourceRunId: 'handoff_shadow_run',
    modelAliasSnapshot: 'main_pro',
    modelIdSnapshot: mainProResolution.real_model,
    prefixMessages: shadowPrefix,
    prefixTokens: 7_000,
    prefixHash: hashCompactionMessages(shadowPrefix),
    prefixLength: 1,
    boundaryMessageId: 'shadow_01',
    projectContextSnapshot: shadowSnapshot,
  }
  const shadowDeadline = new Date(Date.now() + 120_000)
  const shadow = await handoffBackgroundCompaction({
    owner: {
      kind: 'conversation',
      conversationId: shadowConversationId,
      userId,
    },
    sourceRunId: 'handoff_shadow_run',
    modelAliasSnapshot: 'main_pro',
    descriptor: shadowDescriptor,
    notBefore: shadowDeadline,
  })
  const persistedShadow = await DurableCompactionJobModel.findOne({
    job_id: shadow.jobId,
  }).lean()
  assert.ok(persistedShadow, 'hard-crash intent must exist before local summary work')
  assert.equal(persistedShadow.status, 'queued')
  assert.equal(persistedShadow.available_at?.getTime(), shadowDeadline.getTime())
  assert.equal(await claimNextCompactionJob('shadow_worker_too_early'), null)
  assert.equal(await activatePreparedCompactionJob(shadow.jobId, userId), true)
  const activatedShadow = await claimNextCompactionJob('shadow_worker_after_exit')
  assert.equal(activatedShadow?.job.job_id, shadow.jobId)
  assert.equal(await cancelCompactionJob(shadow.jobId, userId, 'local_merge'), true)
  const cancelledShadow = await DurableCompactionJobModel.findOne({ job_id: shadow.jobId }).lean()
  assert.equal(cancelledShadow?.status, 'cancelled')
  assert.equal(cancelledShadow?.active_key, undefined)

  const conversationId = 'handoff_conversation'
  const rootRunId = 'handoff_root_run'
  const rootPrefix = [message('root_01', 'root prefix one'), message('root_02', 'root prefix two')]
  await Conversation.create({
    conversation_id: conversationId,
    user_id: userId,
    settings: { orchestrator_model: 'main_pro' },
    messages: [...rootPrefix, message('root_tail', 'tail after the frozen prefix')],
    compacted_messages: [],
  })
  await AgentRun.create({
    run_id: rootRunId,
    conversation_id: conversationId,
    user_id: userId,
    sequence: 1,
    status: 'running',
    active_key: `conversation:${conversationId}`,
    model_alias_snapshot: 'main_pro',
    execution_mode: 'conversation',
    request: { message: 'root request' },
    started_message_id: 'root_started',
    current_action: {
      kind: 'model_request',
      action_id: 'root_model_action',
      attempt: 1,
      started_at: new Date(),
    },
  })
  const rootSnapshot = projectContext(7)
  const rootDescriptor: BackgroundCompactionHandoffDescriptor = {
    idempotencyKey: 'cmp_root_stable',
    sourceRunId: rootRunId,
    modelAliasSnapshot: 'main_pro',
    modelIdSnapshot: mainProResolution.real_model,
    prefixMessages: rootPrefix,
    prefixTokens: 10_000,
    prefixHash: hashCompactionMessages(rootPrefix),
    prefixLength: rootPrefix.length,
    boundaryMessageId: 'root_02',
    projectContextSnapshot: rootSnapshot,
  }
  await assert.rejects(
    handoffBackgroundCompaction({
      owner: { kind: 'conversation', conversationId, userId },
      sourceRunId: rootRunId,
      modelAliasSnapshot: 'main_pro',
      descriptor: {
        ...rootDescriptor,
        modelIdSnapshot: 'stale-run-model',
      },
    }),
    /model mapping changed/,
  )
  assert.equal(await DurableCompactionJobModel.countDocuments({
    owner_key: `conversation:${conversationId}`,
  }), 0)
  const rootHandoffs = await Promise.all(Array.from({ length: 12 }, () => (
    handoffBackgroundCompaction({
      owner: { kind: 'conversation', conversationId, userId },
      sourceRunId: rootRunId,
      modelAliasSnapshot: 'main_pro',
      descriptor: rootDescriptor,
    })
  )))
  assert.equal(new Set(rootHandoffs.map(result => result.jobId)).size, 1)
  assert.equal(await DurableCompactionJobModel.countDocuments({
    owner_key: `conversation:${conversationId}`,
  }), 1, 'concurrent/replayed Root handoff must enqueue exactly one Job')
  const rootJob = await DurableCompactionJobModel.findOne({
    owner_key: `conversation:${conversationId}`,
  }).lean()
  assert.equal(rootJob?.source_run_id, rootRunId)
  assert.equal(rootJob?.model_alias_snapshot, 'main_pro')
  assert.equal(rootJob?.model_resolution_snapshot?.alias, 'main_pro')
  assert.ok(rootJob?.model_resolution_snapshot?.real_model)
  assert.equal('api_key' in (rootJob?.model_resolution_snapshot ?? {}), false)
  assert.equal(rootJob?.frozen_prefix.prefix_length, 2)
  assert.equal(rootJob?.project_context_snapshot?.epoch, 7)
  assert.deepEqual(rootJob?.workspace_projection, rootSnapshot.workspace_projection)

  // Ending and releasing the AgentRun must not cancel/delete the Job. It is
  // owned by the Conversation context from this point onward.
  await AgentRun.updateOne({ run_id: rootRunId }, {
    $set: {
      status: 'completed',
      current_action: null,
      finished_at: new Date(),
    },
    $unset: { active_key: 1 },
  })
  assert.equal((await DurableCompactionJobModel.findOne({ job_id: rootJob?.job_id }))?.status, 'queued')

  const sessionId = 'handoff_member_session'
  const memberRunId = 'handoff_member_run'
  const memberPrefix = [message('member_01', 'member prefix')]
  await AgentSessionRuntimeModel.create({
    session_id: sessionId,
    team_id: 'handoff_team',
    conversation_id: conversationId,
    user_id: userId,
    agent_id: 'handoff_member',
    generation: 1,
    messages: [...memberPrefix, message('member_tail', 'member tail')],
    compacted_messages: [],
  })
  await AgentRun.create({
    run_id: memberRunId,
    conversation_id: conversationId,
    user_id: userId,
    sequence: 1,
    status: 'running',
    active_key: `agent_session:${sessionId}`,
    agent_session_id: sessionId,
    team_id: 'handoff_team',
    agent_id: 'handoff_member',
    model_alias_snapshot: 'main_pro',
    execution_mode: 'agent_session',
    request: { message: 'member request', internal: { kind: 'task_wakeup' } },
    started_message_id: 'member_started',
  })
  const memberSnapshot = projectContext(3)
  const memberDescriptor: BackgroundCompactionHandoffDescriptor = {
    idempotencyKey: 'cmp_member_stable',
    sourceRunId: memberRunId,
    modelAliasSnapshot: 'main_pro',
    modelIdSnapshot: mainProResolution.real_model,
    prefixMessages: memberPrefix,
    prefixTokens: 8_000,
    prefixHash: hashCompactionMessages(memberPrefix),
    prefixLength: 1,
    boundaryMessageId: 'member_01',
    projectContextSnapshot: memberSnapshot,
  }
  const memberHandoff = await handoffBackgroundCompaction({
    owner: {
      kind: 'agent_session',
      sessionId,
      conversationId,
      userId,
      teamId: 'handoff_team',
      agentId: 'handoff_member',
    },
    sourceRunId: memberRunId,
    modelAliasSnapshot: 'main_pro',
    descriptor: memberDescriptor,
  })
  const memberJob = await DurableCompactionJobModel.findOne({
    job_id: memberHandoff.jobId,
  }).lean()
  assert.equal(memberJob?.owner_kind, 'agent_session')
  assert.equal(memberJob?.agent_session_id, sessionId)
  assert.equal(memberJob?.source_run_id, memberRunId)
  assert.equal(memberJob?.model_alias_snapshot, 'main_pro')
  assert.equal(memberJob?.model_resolution_snapshot?.alias, 'main_pro')

  await AgentRun.updateOne({ run_id: memberRunId }, {
    $set: { status: 'completed', finished_at: new Date() },
    $unset: { active_key: 1 },
  })
  assert.equal((await DurableCompactionJobModel.findOne({ job_id: memberHandoff.jobId }))?.status, 'queued')

  console.log('durable compaction handoff Mongo verification passed')
  await mongoose.disconnect()
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
