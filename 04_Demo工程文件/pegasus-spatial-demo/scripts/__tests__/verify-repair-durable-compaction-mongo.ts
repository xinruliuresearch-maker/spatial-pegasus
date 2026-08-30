import assert from 'node:assert/strict'
import type { ConversationMessage } from '../../lib/types'

const mongoUri = process.env.AGENT_COMPACTION_TEST_MONGODB_URI?.trim()
  || 'mongodb://127.0.0.1:27018/sci_pegasus_operator_repair_test'
const databaseName = mongoUri.match(/\/([^/?]+)(?:\?|$)/)?.[1]
if (!databaseName?.endsWith('_test')) {
  throw new Error('Refusing to run operator repair verification outside an isolated *_test database.')
}
process.env.MONGODB_URI = mongoUri
process.env.LLM_API_KEY_ORCHESTRATOR = 'operator-repair-test-key'

function message(
  id: string,
  role: ConversationMessage['role'],
  text: string,
): ConversationMessage {
  return {
    role,
    content: [{ type: 'text', text }],
    message_id: id,
    timestamp: new Date('2026-08-10T00:00:00.000Z'),
  }
}

async function main(): Promise<void> {
  const mongoose = (await import('mongoose')).default
  const { connectDB } = await import('../../lib/db/mongodb')
  const { Conversation } = await import('../../lib/db/models')
  const { ConversationRuntime, AgentRun } = await import('../../lib/agent-runtime/models')
  const {
    AgentSessionRuntimeModel,
    AgentTeamModel,
    TeamAgentModel,
  } = await import('../../lib/agent-team/models')
  const { DurableCompactionJobModel } = await import('../../lib/agent-compaction/models')
  const {
    cancelUnclaimedQueuedDurableCompactionJob,
    claimNextCompactionJob,
  } = await import('../../lib/agent-compaction/repository')
  const {
    createDefaultRepairDurableCompactionDependencies,
    executeRepairDurableCompactionCommand,
  } = await import('../repair-durable-compaction-operator')

  try {
    await connectDB()
    const database = mongoose.connection.db
    assert.ok(database)
    await database.dropDatabase()
    await Promise.all([
      Conversation.syncIndexes(),
      ConversationRuntime.syncIndexes(),
      AgentRun.syncIndexes(),
      AgentTeamModel.syncIndexes(),
      TeamAgentModel.syncIndexes(),
      AgentSessionRuntimeModel.syncIndexes(),
      DurableCompactionJobModel.syncIndexes(),
    ])

    const userId = 'operator_repair_user'
    const conversationId = 'operator_repair_conversation'
    const teamId = 'operator_repair_team'
    const rootAgentId = 'operator_repair_root'
    const messages = [
      message('repair_m01', 'user', 'old user request '.repeat(500)),
      message('repair_m02', 'assistant', 'old answer '.repeat(500)),
      message('repair_m03', 'user', 'current user request '.repeat(300)),
      message('repair_m04', 'assistant', 'latest assistant tail'),
    ]

    await Promise.all([
      Conversation.create({
        conversation_id: conversationId,
        user_id: userId,
        title: 'isolated operator repair test',
        settings: { orchestrator_model: 'main_standard' },
        messages: [],
        compacted_messages: messages,
        context_revision: 4,
        context_compaction_fence: null,
      }),
      AgentTeamModel.create({
        team_id: teamId,
        conversation_id: conversationId,
        user_id: userId,
        root_agent_id: rootAgentId,
        workspace_id: conversationId,
        status: 'active',
        policy: {},
        next_event_seq: 0,
        supervision_cursor: 0,
      }),
      TeamAgentModel.create({
        agent_id: rootAgentId,
        team_id: teamId,
        conversation_id: conversationId,
        user_id: userId,
        slot: 0,
        display_name: 'Root',
        normalized_name: 'root',
        role: 'Research coordinator',
        is_root: true,
        status: 'idle',
        generation: 1,
        current_session_id: 'operator_repair_root_session',
        active_grant_id: 'operator_repair_root_grant',
        grant_version: 1,
        private_workspace_prefix: '.sci-pegasus/agents/operator_repair_root',
        last_transition_at: new Date(),
      }),
      AgentSessionRuntimeModel.create({
        session_id: 'operator_repair_root_session',
        team_id: teamId,
        conversation_id: conversationId,
        user_id: userId,
        agent_id: rootAgentId,
        generation: 1,
        active_run_id: null,
        active_lease_owner_id: null,
        run_lease: null,
        revision: 0,
        context_revision: 0,
        messages: [],
        compacted_messages: [],
        hippocampus: {},
      }),
    ])

    const dependencies = await createDefaultRepairDurableCompactionDependencies()
    const fixtureAttemptId = 'rpa_22222222222222222222222222222222'
    assert.equal(await DurableCompactionJobModel.countDocuments({}), 0)

    for (const rootStatus of ['running', 'failed'] as const) {
      await TeamAgentModel.updateOne(
        { agent_id: rootAgentId },
        { $set: { status: rootStatus } },
      )
      await assert.rejects(
        executeRepairDurableCompactionCommand({
          mode: 'prepare',
          conversationId,
          notBeforeMinutes: 10,
          repairAttemptId: fixtureAttemptId,
        }, dependencies),
        new RegExp(`Root TeamAgent is ${rootStatus}`),
      )
      assert.equal(await DurableCompactionJobModel.countDocuments({}), 0)
    }
    await TeamAgentModel.updateOne(
      { agent_id: rootAgentId },
      { $set: { status: 'idle' } },
    )

    await ConversationRuntime.updateOne(
      { conversation_id: conversationId, user_id: userId },
      {
        $setOnInsert: {
          conversation_id: conversationId,
          user_id: userId,
          revision: 0,
          hippocampus: {},
        },
        $set: { active_lease_owner_id: 'runtime_lease_test' },
      },
      { upsert: true },
    )
    await assert.rejects(
      executeRepairDurableCompactionCommand({
        mode: 'prepare',
        conversationId,
        notBeforeMinutes: 10,
        repairAttemptId: fixtureAttemptId,
      }, dependencies),
      /ConversationRuntime has an active lease owner/,
    )
    await ConversationRuntime.updateOne(
      { conversation_id: conversationId, user_id: userId },
      { $set: { active_lease_owner_id: null, active_run_id: null } },
    )

    await AgentSessionRuntimeModel.updateOne(
      { session_id: 'operator_repair_root_session' },
      {
        $set: {
          active_run_id: 'session_run_test',
          active_lease_owner_id: 'session_owner_test',
          run_lease: {
            owner_id: 'session_owner_test',
            fence_token: 'session_fence_test',
            heartbeat_at: new Date(),
            expires_at: new Date(Date.now() + 60_000),
          },
        },
      },
    )
    await assert.rejects(
      executeRepairDurableCompactionCommand({
        mode: 'prepare',
        conversationId,
        notBeforeMinutes: 10,
        repairAttemptId: fixtureAttemptId,
      }, dependencies),
      /Current Root AgentSession has an active Run or lease/,
    )
    await AgentSessionRuntimeModel.updateOne(
      { session_id: 'operator_repair_root_session' },
      { $set: { active_run_id: null, active_lease_owner_id: null, run_lease: null } },
    )

    const dryRun = await executeRepairDurableCompactionCommand({
      mode: 'dry-run',
      conversationId,
      notBeforeMinutes: 10,
    }, dependencies)
    assert.equal(dryRun.write_performed, false)
    assert.equal(await DurableCompactionJobModel.countDocuments({}), 0)
    const repairAttemptId = String(dryRun.repair_attempt_id)
    assert.match(repairAttemptId, /^rpa_[a-f0-9]{32}$/)

    const prepared = await executeRepairDurableCompactionCommand({
      mode: 'prepare',
      conversationId,
      notBeforeMinutes: 10,
      repairAttemptId,
    }, dependencies)
    assert.equal(prepared.write_performed, true)
    assert.equal(await DurableCompactionJobModel.countDocuments({}), 1)
    const preparedJob = prepared.job as Record<string, unknown>
    const firstJobId = String(preparedJob.job_id)
    const firstIdempotencyKey = String(prepared.idempotency_key)
    assert.match(firstIdempotencyKey, /^operator-repair:/)
    assert.ok(firstIdempotencyKey.includes(repairAttemptId))
    const storedPrepared = await DurableCompactionJobModel.findOne({ job_id: firstJobId }).lean()
    assert.ok(storedPrepared?.model_resolution_snapshot)
    assert.equal(
      storedPrepared?.model_resolution_snapshot?.alias,
      storedPrepared?.model_alias_snapshot,
    )
    assert.equal(
      storedPrepared?.model_resolution_snapshot?.context_window,
      (prepared.capacity as Record<string, unknown>).context_window,
    )
    assert.equal(
      storedPrepared?.model_resolution_snapshot?.compaction_max_output_tokens,
      (prepared.capacity as Record<string, unknown>).compaction_max_output_tokens,
    )
    assert.equal('api_key' in (storedPrepared?.model_resolution_snapshot ?? {}), false)
    const preparedOutput = JSON.stringify(prepared)
    assert.equal(
      preparedOutput.includes(storedPrepared!.model_resolution_snapshot!.real_model),
      false,
    )
    assert.equal(
      preparedOutput.includes(storedPrepared!.model_resolution_snapshot!.registry_hash),
      false,
    )
    assert.equal(preparedOutput.includes('key_channel'), false)

    const replay = await executeRepairDurableCompactionCommand({
      mode: 'prepare',
      conversationId,
      notBeforeMinutes: 10,
      repairAttemptId,
    }, dependencies)
    assert.equal(replay.write_performed, false)
    assert.equal((replay.job as Record<string, unknown>).job_id, firstJobId)
    assert.equal(await DurableCompactionJobModel.countDocuments({}), 1)

    const cancelledFirstAttempt = await cancelUnclaimedQueuedDurableCompactionJob({
      jobId: firstJobId,
      owner: {
        kind: 'conversation',
        conversationId,
        userId,
      },
      idempotencyKey: firstIdempotencyKey,
      reason: 'operator-repair-attempt-fixture',
    })
    assert.equal(cancelledFirstAttempt.changed, true)
    assert.equal(cancelledFirstAttempt.job.status, 'cancelled')
    assert.equal(Boolean(cancelledFirstAttempt.job.active_key), false)

    await assert.rejects(
      executeRepairDurableCompactionCommand({
        mode: 'prepare',
        conversationId,
        notBeforeMinutes: 10,
        repairAttemptId,
      }, dependencies),
      /exact active, unclaimed queued CompactionJob intent.*manual intervention/,
    )
    const firstTerminal = await DurableCompactionJobModel.findOne({ job_id: firstJobId }).lean()
    assert.equal(firstTerminal?.status, 'cancelled')
    assert.equal(Boolean(firstTerminal?.active_key), false)
    assert.equal(await DurableCompactionJobModel.countDocuments({}), 1)

    const retryDryRun = await executeRepairDurableCompactionCommand({
      mode: 'dry-run',
      conversationId,
      notBeforeMinutes: 10,
    }, dependencies)
    const retryAttemptId = String(retryDryRun.repair_attempt_id)
    assert.notEqual(retryAttemptId, repairAttemptId)
    const retryPrepared = await executeRepairDurableCompactionCommand({
      mode: 'prepare',
      conversationId,
      notBeforeMinutes: 10,
      repairAttemptId: retryAttemptId,
    }, dependencies)
    assert.equal(retryPrepared.write_performed, true)
    const jobId = String((retryPrepared.job as Record<string, unknown>).job_id)
    const idempotencyKey = String(retryPrepared.idempotency_key)
    assert.notEqual(jobId, firstJobId)
    assert.ok(idempotencyKey.includes(retryAttemptId))
    assert.equal(await DurableCompactionJobModel.countDocuments({}), 2)
    const firstTerminalAfterRetry = await DurableCompactionJobModel
      .findOne({ job_id: firstJobId })
      .lean()
    assert.equal(firstTerminalAfterRetry?.status, 'cancelled')
    assert.equal(Boolean(firstTerminalAfterRetry?.active_key), false)

    const beforeWrongKey = await DurableCompactionJobModel.findOne({ job_id: jobId }).lean()
    await assert.rejects(
      executeRepairDurableCompactionCommand({
        mode: 'activate',
        jobId,
        idempotencyKey: 'wrong-operator-key',
      }, dependencies),
      /Compaction Job command rejected/,
    )
    const afterWrongKey = await DurableCompactionJobModel.findOne({ job_id: jobId }).lean()
    assert.equal(
      afterWrongKey?.available_at?.getTime(),
      beforeWrongKey?.available_at?.getTime(),
    )

    const status = await executeRepairDurableCompactionCommand({
      mode: 'status',
      jobId,
    }, dependencies)
    assert.equal(status.write_performed, false)
    assert.equal((status.job as Record<string, unknown>).status, 'queued')
    assert.equal(JSON.stringify(status).includes('operator-repair-test-key'), false)

    const activated = await executeRepairDurableCompactionCommand({
      mode: 'activate',
      jobId,
      idempotencyKey,
    }, dependencies)
    assert.equal(activated.write_performed, true)
    assert.ok(
      new Date((activated.job as Record<string, unknown>).available_at as Date).getTime()
        <= Date.now(),
    )

    const claimed = await claimNextCompactionJob('operator-repair-race-worker')
    assert.equal(claimed?.job.job_id, jobId)
    await assert.rejects(
      executeRepairDurableCompactionCommand({
        mode: 'activate',
        jobId,
        idempotencyKey,
      }, dependencies),
      /queued but already claimed or leased.*manual intervention/,
    )
    const claimedAfter = await DurableCompactionJobModel.findOne({ job_id: jobId }).lean()
    assert.equal(claimedAfter?.lease?.owner_id, 'operator-repair-race-worker')

    console.log('durable compaction operator repair Mongo verification passed')
  } finally {
    await mongoose.disconnect()
  }
}

void main()
