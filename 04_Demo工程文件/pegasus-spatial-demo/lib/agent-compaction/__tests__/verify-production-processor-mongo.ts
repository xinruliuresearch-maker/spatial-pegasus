import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { ConversationMessage } from '../../types'

const mongoUri = process.env.AGENT_COMPACTION_PROCESSOR_TEST_MONGODB_URI?.trim()
  || 'mongodb://127.0.0.1:27018/sci_pegasus_agent_compaction_processor_test'
const databaseName = mongoUri.match(/\/([^/?]+)(?:\?|$)/)?.[1]
if (!databaseName?.endsWith('_test')) {
  throw new Error('Refusing to run processor tests outside an isolated *_test database.')
}
process.env.MONGODB_URI = mongoUri

const zeroUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cost_usd: 0,
  tool_calls: 0,
  download_bytes: 0,
}

function message(id: string): ConversationMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: `message ${id}` }],
    message_id: id,
    timestamp: new Date(),
  }
}

async function main(): Promise<void> {
  const mongoose = (await import('mongoose')).default
  const { connectDB } = await import('../../db/mongodb')
  const { Conversation } = await import('../../db/models')
  const { ModelConfig } = await import('../../db/model-config-models')
  const {
    AgentBudgetAdmissionModel,
    AgentExecutionBudgetStateModel,
  } = await import('../../agent-team/models')
  const { MongoAgentExecutionBudgetLedger } = await import('../../agent-team/execution-budget')
  const { DurableCompactionJobModel } = await import('../models')
  const repository = await import('../repository')
  const { resolveAuthoritativeModelSnapshot } = await import('../../llm-registry')
  const { processClaimedCompactionJob } = await import('../service')
  const { DurableCompactionProcessorError } = await import('../processor')

  await connectDB()
  assert.ok(mongoose.connection.db)
  await mongoose.connection.db.dropDatabase()
  await Promise.all([
    Conversation.syncIndexes(),
    DurableCompactionJobModel.syncIndexes(),
    AgentExecutionBudgetStateModel.syncIndexes(),
    AgentBudgetAdmissionModel.syncIndexes(),
    ModelConfig.syncIndexes(),
  ])
  const aliasConfig = (realModel: string) => ({
    realModel,
    keyChannel: 'orchestrator',
    availableToPlans: ['pro'],
    supportsVision: false,
    contextWindow: 20_000,
    maxOutputTokens: 2_000,
    compactionMaxOutputTokens: 500,
    promptCacheTtl: '5m',
  })
  await ModelConfig.create({
    config_key: 'main',
    aliases: {
      main_test: aliasConfig('real-test-model'),
      removed_alias: aliasConfig('removed-real-model'),
    },
    toolSelection: {
      websearch: { free: '', pro: '', team: '' },
      memory: { free: '', pro: '', team: '' },
    },
    defaultMainAlias: { free: 'main_test', pro: 'main_test', team: 'main_test' },
    high_cost_aliases_disabled: [],
    updated_at: new Date('2026-08-10T00:00:00.000Z'),
  })

  // Maintenance must recognize a live detached Job lease. Valid compaction
  // budget reservations cannot be abandoned merely because the source Run is
  // already complete.
  const now = new Date()
  const jobId = 'cmpjob_budget_fence'
  await DurableCompactionJobModel.create({
    job_id: jobId,
    owner_key: 'conversation:budget_fence_conversation',
    owner_kind: 'conversation',
    conversation_id: 'budget_fence_conversation',
    user_id: 'budget_fence_user',
    idempotency_key: 'budget_fence',
    idempotency_keys: ['budget_fence'],
    model_alias_snapshot: 'main_test',
    status: 'summarizing',
    active_key: 'conversation:budget_fence_conversation',
    frozen_prefix: {
      context_revision: 0,
      prefix_length: 1,
      prefix_hash: 'budget_prefix_hash',
      messages: [message('budget_message')],
    },
    attempt: 1,
    lease: {
      owner_id: 'budget_worker',
      fence_token: 'budget_fence_token',
      heartbeat_at: now,
      expires_at: new Date(now.getTime() + 60_000),
    },
    available_at: now,
  })
  const reservationKey = 'reservation_key'
  const budgetTeamId = 'team_compaction_processor'
  await AgentExecutionBudgetStateModel.create({
    budget_state_id: `execution_budget_${createHash('sha256').update(budgetTeamId).digest('hex')}`,
    team_id: budgetTeamId,
    conversation_id: 'budget_fence_conversation',
    user_id: 'budget_fence_user',
    team_usage: zeroUsage,
    agent_usage: {},
    task_usage: {},
    active_reservations: {
      [reservationKey]: {
        admission_id: 'admission_compaction_processor',
        admission_key: 'attempt_compaction_processor',
        kind: 'compaction',
        label: 'real-test-model',
        conversation_id: 'budget_fence_conversation',
        user_id: 'budget_fence_user',
        agent_id: 'agent_compaction_processor',
        task_id: null,
        run_id: `compaction:${jobId}`,
        execution_owner_id: 'budget_worker',
        agent_session_id: null,
        team_fence_required: false,
        status: 'started',
        attempt: 1,
        reserved_tool_calls: 0,
        created_at: now,
        started_at: now,
      },
    },
    initialized_at: now,
  })
  const budgetLedger = new MongoAgentExecutionBudgetLedger()
  assert.deepEqual(
    await budgetLedger.recoverStaleAdmissions({ teamId: budgetTeamId }),
    { released: 0, abandoned: 0 },
  )
  assert.ok(await AgentExecutionBudgetStateModel.exists({
    team_id: budgetTeamId,
    [`active_reservations.${reservationKey}.status`]: 'started',
  }))
  await DurableCompactionJobModel.updateOne(
    { job_id: jobId },
    { $set: { 'lease.expires_at': new Date(0) } },
  )
  assert.deepEqual(
    await budgetLedger.recoverStaleAdmissions({ teamId: budgetTeamId }),
    { released: 0, abandoned: 1 },
  )
  assert.equal(await AgentExecutionBudgetStateModel.exists({
    team_id: budgetTeamId,
    [`active_reservations.${reservationKey}`]: { $exists: true },
  }), null)
  await DurableCompactionJobModel.updateOne(
    { job_id: jobId },
    {
      $set: { status: 'failed', lease: null, finished_at: new Date() },
      $unset: { active_key: 1 },
    },
  )

  // A legacy alias-only Job freezes one authoritative mapping under the exact
  // worker lease; replay cannot overwrite the snapshot after registry drift.
  const legacyConversationId = 'processor_legacy_snapshot_conversation'
  const legacyUserId = 'processor_legacy_snapshot_user'
  await Conversation.create({
    conversation_id: legacyConversationId,
    user_id: legacyUserId,
    settings: { orchestrator_model: 'main_test' },
    messages: [message('legacy_snapshot_message')],
    compacted_messages: [],
    context_revision: 0,
  })
  const legacyJob = await repository.enqueueDurableCompaction({
    owner: {
      kind: 'conversation',
      conversationId: legacyConversationId,
      userId: legacyUserId,
    },
    idempotencyKey: 'legacy_snapshot',
    modelAliasSnapshot: 'main_test',
  })
  await DurableCompactionJobModel.updateOne(
    { job_id: legacyJob.job_id },
    { $set: { model_resolution_snapshot: null } },
  )
  const legacyClaim = await repository.claimNextCompactionJob('legacy_snapshot_worker', 60_000)
  assert.equal(legacyClaim?.job.job_id, legacyJob.job_id)
  assert.ok(legacyClaim)
  const frozenResolution = await resolveAuthoritativeModelSnapshot('main_test')
  const frozenLegacy = await repository.freezeClaimedCompactionModelResolution(
    legacyClaim,
    frozenResolution,
  )
  assert.equal(frozenLegacy?.model_resolution_snapshot?.real_model, 'real-test-model')
  await ModelConfig.updateOne(
    { config_key: 'main' },
    {
      $set: {
        'aliases.main_test.realModel': 'drifted-model-must-not-win',
        updated_at: new Date('2026-08-10T01:00:00.000Z'),
      },
    },
  )
  const driftedResolution = await resolveAuthoritativeModelSnapshot('main_test')
  const replayedLegacy = await repository.freezeClaimedCompactionModelResolution(
    legacyClaim,
    driftedResolution,
  )
  assert.equal(replayedLegacy?.model_resolution_snapshot?.real_model, 'real-test-model')
  assert.equal(await repository.failCompactionJob(legacyClaim, 'fixture cleanup'), true)
  await ModelConfig.updateOne(
    { config_key: 'main' },
    {
      $set: {
        'aliases.main_test.realModel': 'real-test-model',
        updated_at: new Date('2026-08-10T00:00:00.000Z'),
      },
    },
  )

  // Fatal configuration errors do not burn all retry attempts; ordinary
  // transient errors remain recoverable with the context barrier intact.
  const userId = 'processor_failure_user'
  const conversationId = 'processor_failure_conversation'
  const prefix = [message('processor_failure_message')]
  await Conversation.create({
    conversation_id: conversationId,
    user_id: userId,
    title: 'processor failure classification',
    settings: { orchestrator_model: 'main_test' },
    messages: prefix,
    compacted_messages: [],
    context_revision: 0,
  })
  const owner = { kind: 'conversation' as const, conversationId, userId }
  const fatalJob = await repository.enqueueDurableCompaction({
    owner,
    idempotencyKey: 'fatal_processor',
    modelAliasSnapshot: 'removed_alias',
    prefixMessages: prefix,
  })
  assert.equal(fatalJob.model_resolution_snapshot?.real_model, 'removed-real-model')
  const fatalClaim = await repository.claimNextCompactionJob('fatal_worker', 60_000)
  assert.equal(fatalClaim?.job.job_id, fatalJob.job_id)
  await processClaimedCompactionJob(fatalClaim!, {
    async summarize() {
      throw new DurableCompactionProcessorError('Unknown model alias: removed_alias', 'fatal')
    },
  })
  const failed = await repository.getDurableCompactionJob(fatalJob.job_id)
  assert.equal(failed?.status, 'failed')
  assert.equal(failed?.attempt, 1)
  assert.equal(failed?.active_key, undefined)

  const transientJob = await repository.enqueueDurableCompaction({
    owner,
    idempotencyKey: 'transient_processor',
    modelAliasSnapshot: 'main_test',
    prefixMessages: prefix,
  })
  assert.equal(transientJob.model_resolution_snapshot?.real_model, 'real-test-model')
  const transientClaim = await repository.claimNextCompactionJob('transient_worker', 60_000)
  assert.equal(transientClaim?.job.job_id, transientJob.job_id)
  await processClaimedCompactionJob(transientClaim!, {
    async summarize() { throw new Error('temporary gateway outage') },
  }, { retryBaseDelayMs: 0 })
  const retryable = await repository.getDurableCompactionJob(transientJob.job_id)
  assert.equal(retryable?.status, 'retryable')
  assert.equal(retryable?.attempt, 1)
  assert.equal(retryable?.active_key, `conversation:${conversationId}`)

  console.log('production durable compaction Mongo verification passed')
  await mongoose.disconnect()
}

void main().catch(async error => {
  console.error(error)
  const mongoose = (await import('mongoose')).default
  await mongoose.disconnect().catch(() => undefined)
  process.exitCode = 1
})
