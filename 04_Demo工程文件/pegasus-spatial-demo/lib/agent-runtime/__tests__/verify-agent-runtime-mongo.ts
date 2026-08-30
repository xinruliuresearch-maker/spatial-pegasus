import assert from 'node:assert/strict'

const TEST_DATABASE_SUFFIX = '_test'
const mongoUri = process.env.AGENT_RUNTIME_TEST_MONGODB_URI?.trim()
  || 'mongodb://127.0.0.1:27018/sci_pegasus_agent_runtime_test'
const databaseName = mongoUri.match(/\/([^/?]+)(?:\?|$)/)?.[1]

if (!databaseName?.endsWith(TEST_DATABASE_SUFFIX)) {
  throw new Error(
    `Refusing to run Agent Runtime integration tests outside an isolated *${TEST_DATABASE_SUFFIX} database.`,
  )
}

process.env.MONGODB_URI = mongoUri

async function main(): Promise<void> {
  const mongoose = (await import('mongoose')).default
  const { connectDB } = await import('../../db/mongodb')
  const { QueuedMessage } = await import('../../db/queue-model')
  const messageQueue = await import('../../agent/message-queue')
  const { AgentRun, ConversationRuntime } = await import('../models')
  const repository = await import('../repository')
  const { failIneligibleTeamRun } = await import('../runner')

  await connectDB()
  const database = mongoose.connection.db
  assert.ok(database, 'MongoDB test connection must expose a database')

  await database.dropDatabase()
  await Promise.all([
    AgentRun.syncIndexes(),
    ConversationRuntime.syncIndexes(),
    QueuedMessage.syncIndexes(),
  ])

  const conversationId = 'conv_runtime_integration'
  const userId = 'user_runtime_integration'
  const startedAt = new Date('2026-07-30T00:00:00.000Z')

  try {
    const runtime = await repository.getOrCreateConversationRuntime(conversationId, userId)
    assert.equal(runtime.conversation_id, conversationId)
    assert.equal(runtime.hippocampus.snapshot_version, 1)

    const firstRun = await repository.createAgentRun({
      runId: 'run_runtime_lease',
      conversationId,
      userId,
      request: { message: 'exercise lease recovery' },
      startedMessageId: 'msg_runtime_lease',
    })
    assert.equal(firstRun.status, 'queued')

    await assert.rejects(
      repository.createAgentRun({
        runId: 'run_runtime_duplicate',
        conversationId,
        userId,
        request: { message: 'must not run concurrently' },
        startedMessageId: 'msg_runtime_duplicate',
      }),
      (error: unknown) => error instanceof repository.ActiveAgentRunError,
      'the sparse active-key index must reject a second active Run',
    )

    const competingClaims = await Promise.all([
      repository.leaseNextAgentRun('runner_alpha', 30_000),
      repository.leaseNextAgentRun('runner_beta', 30_000),
    ])
    const winners = competingClaims.filter((claim): claim is NonNullable<typeof claim> => !!claim)
    assert.equal(winners.length, 1, 'exactly one Runner may acquire a queued Run')
    const firstOwner = winners[0].lease?.owner_id
    assert.ok(firstOwner)
    const losingOwner = firstOwner === 'runner_alpha' ? 'runner_beta' : 'runner_alpha'
    assert.equal(await repository.heartbeatAgentRun(firstRun.run_id, losingOwner), 'lost')
    assert.equal(await repository.heartbeatAgentRun(firstRun.run_id, firstOwner), 'renewed')

    const interruptedToolAction = {
      kind: 'tool_call' as const,
      action_id: 'action_interrupted_tool',
      tool_use_id: 'tool_use_interrupted',
      tool_name: 'Write',
      input_hash: 'input_hash',
      attempt: 1,
      started_at: startedAt,
    }
    assert.equal(
      await repository.setRunCurrentAction(firstRun.run_id, interruptedToolAction, firstOwner),
      true,
    )
    assert.equal(
      await repository.advanceRunCheckpoint(
        firstRun.run_id,
        interruptedToolAction.action_id,
        'msg_wrong_owner',
        losingOwner,
      ),
      false,
      'a stale executor must not advance another Runner\'s checkpoint',
    )

    await AgentRun.updateOne(
      { run_id: firstRun.run_id },
      {
        $set: {
          'lease.heartbeat_at': new Date(0),
          'lease.expires_at': new Date(0),
        },
      },
    )
    assert.equal(await repository.markExpiredRunsRecoverable(), 1)
    const expiredToolRun = await repository.getAgentRun(firstRun.run_id, userId)
    assert.equal(expiredToolRun?.status, 'recoverable')
    assert.equal(expiredToolRun?.current_action?.action_id, interruptedToolAction.action_id)
    const unfencedRuntime = await repository.getConversationRuntime(conversationId, userId)
    assert.equal(unfencedRuntime?.active_lease_owner_id, null)

    assert.ok(await repository.queueRecoverableAgentRun(firstRun.run_id, userId))
    const takeoverOwner = 'runner_takeover'
    const takeover = await repository.claimAgentRun(firstRun.run_id, takeoverOwner, 30_000)
    assert.equal(takeover?.current_action?.action_id, interruptedToolAction.action_id)
    assert.equal(takeover?.lease?.owner_id, takeoverOwner)
    const takeoverRuntime = await repository.getConversationRuntime(conversationId, userId)
    assert.equal(takeoverRuntime?.active_lease_owner_id, takeoverOwner)

    assert.ok(await repository.requestRunCancellation(conversationId, userId, firstRun.run_id))
    assert.equal(
      await repository.heartbeatAgentRun(firstRun.run_id, takeoverOwner),
      'cancellation_requested',
      'a stop requested on another instance must be observed through the durable heartbeat',
    )
    await AgentRun.updateOne(
      { run_id: firstRun.run_id },
      { $set: { 'lease.expires_at': new Date(0) } },
    )
    assert.deepEqual(await repository.finalizeOrphanedCancelledRuns(), [firstRun.run_id])
    const cancelledRun = await repository.getAgentRun(firstRun.run_id, userId)
    assert.equal(cancelledRun?.status, 'cancelled')
    assert.equal(cancelledRun?.termination_reason, 'user_cancelled')
    assert.equal(cancelledRun?.current_action, null)

    const compactionRun = await repository.createAgentRun({
      runId: 'run_runtime_compaction',
      conversationId,
      userId,
      request: { message: 'exercise compaction recovery' },
      startedMessageId: 'msg_runtime_compaction',
    })
    const compactionOwner = 'runner_compaction'
    assert.ok(await repository.claimAgentRun(compactionRun.run_id, compactionOwner, 30_000))
    const compactionAction = {
      kind: 'compaction' as const,
      action_id: 'action_compaction',
      prefix_hash: 'prefix_hash',
      attempt: 1,
      started_at: startedAt,
    }
    assert.equal(
      await repository.setRunCurrentAction(compactionRun.run_id, compactionAction, compactionOwner),
      true,
    )
    const startedCheckpoint = {
      compaction_id: 'compact_persistent',
      status: 'started' as const,
      prefix_hash: 'prefix_hash',
      prefix_message_id: 'msg_prefix',
      started_at: startedAt,
      updated_at: startedAt,
    }
    assert.equal(
      await repository.updateRuntimeCompactionCheckpoint(
        conversationId,
        userId,
        startedCheckpoint,
        compactionRun.run_id,
        compactionOwner,
      ),
      true,
    )
    assert.equal(
      await repository.updateRuntimeCompactionCheckpoint(
        conversationId,
        userId,
        null,
        compactionRun.run_id,
        'runner_stale',
      ),
      false,
    )

    await AgentRun.updateOne(
      { run_id: compactionRun.run_id },
      { $set: { 'lease.expires_at': new Date(0) } },
    )
    assert.equal(await repository.markExpiredRunsRecoverable(), 1)
    assert.ok(await repository.queueRecoverableAgentRun(compactionRun.run_id, userId))
    const recoveredCompactionOwner = 'runner_compaction_takeover'
    assert.ok(await repository.claimAgentRun(
      compactionRun.run_id,
      recoveredCompactionOwner,
      30_000,
    ))
    const recoveredRuntime = await repository.getConversationRuntime(conversationId, userId)
    assert.equal(recoveredRuntime?.hippocampus.active_compaction?.status, 'started')
    assert.equal(recoveredRuntime?.hippocampus.active_compaction?.prefix_hash, 'prefix_hash')
    assert.equal(
      await repository.updateRuntimeCompactionCheckpoint(
        conversationId,
        userId,
        {
          ...startedCheckpoint,
          status: 'summary_ready',
          summary: 'durable summary',
          updated_at: new Date('2026-07-30T00:01:00.000Z'),
        },
        compactionRun.run_id,
        recoveredCompactionOwner,
      ),
      true,
    )
    assert.equal(
      await repository.updateRuntimeCompactionCheckpoint(
        conversationId,
        userId,
        null,
        compactionRun.run_id,
        recoveredCompactionOwner,
      ),
      true,
    )
    assert.equal(
      await repository.advanceRunCheckpoint(
        compactionRun.run_id,
        compactionAction.action_id,
        'msg_after_compaction',
        recoveredCompactionOwner,
      ),
      true,
    )
    assert.equal(
      await repository.setRunStatus(compactionRun.run_id, 'completed', {
        terminationReason: 'model_finished',
        leaseOwnerId: recoveredCompactionOwner,
      }),
      true,
    )

    const askConversationId = 'conv_runtime_ask_user'
    const freeAnswerRun = await repository.createAgentRun({
      runId: 'run_runtime_ask_free_answer',
      conversationId: askConversationId,
      userId,
      request: { message: 'ask before continuing' },
      startedMessageId: 'msg_runtime_ask_free_answer',
    })
    const askOwner = 'runner_ask_user'
    assert.ok(await repository.claimAgentRun(freeAnswerRun.run_id, askOwner, 30_000))
    assert.equal(await repository.setRunPendingInteraction(freeAnswerRun.run_id, {
      interaction_id: 'ask_free_answer',
      questions: [{
        id: 'format',
        header: '输出形式',
        question: '你希望输出什么？',
        options: [{ label: '画布' }, { label: '图片' }],
        multi_select: false,
        required: true,
        allow_custom: true,
      }],
      created_at: startedAt,
    }, askOwner), true)
    assert.equal(await repository.setRunStatus(freeAnswerRun.run_id, 'waiting_user', {
      leaseOwnerId: askOwner,
    }), true)
    const freeAnswerResume = await repository.resumeWaitingAgentRun(
      freeAnswerRun.run_id,
      userId,
      {
        message_id: 'msg_runtime_ask_free_response',
        message: '直接在输入框回答',
        created_at: startedAt,
      },
    )
    assert.equal(freeAnswerResume?.status, 'queued')
    assert.equal(freeAnswerResume?.pending_interaction, null)
    assert.equal(await repository.cancelInactiveAgentRun(freeAnswerRun.run_id, userId), true)

    const structuredAnswerRun = await repository.createAgentRun({
      runId: 'run_runtime_ask_structured_answer',
      conversationId: askConversationId,
      userId,
      request: { message: 'ask with form' },
      startedMessageId: 'msg_runtime_ask_structured_answer',
    })
    assert.ok(await repository.claimAgentRun(structuredAnswerRun.run_id, askOwner, 30_000))
    assert.equal(await repository.setRunPendingInteraction(structuredAnswerRun.run_id, {
      interaction_id: 'ask_structured_answer',
      questions: [{
        id: 'palette',
        header: '配色方向',
        question: '希望使用哪种配色？',
        options: [{ label: '冷色' }, { label: '暖色' }],
        multi_select: true,
        required: true,
        allow_custom: true,
      }],
      created_at: startedAt,
    }, askOwner), true)
    assert.equal(await repository.setRunStatus(structuredAnswerRun.run_id, 'waiting_user', {
      leaseOwnerId: askOwner,
    }), true)
    const structuredResume = await repository.resumeWaitingAgentRun(
      structuredAnswerRun.run_id,
      userId,
      {
        message_id: 'msg_runtime_ask_structured_response',
        message: '冷色、暖色',
        interaction_id: 'ask_structured_answer',
        created_at: startedAt,
      },
    )
    assert.equal(structuredResume?.status, 'queued')
    assert.deepEqual(structuredResume?.answered_interaction_ids, ['ask_structured_answer'])
    await AgentRun.updateOne(
      { run_id: structuredAnswerRun.run_id },
      { $set: { pending_inputs: [] } },
    )
    assert.equal(
      (await repository.findAgentRunWithInteractionAnswer(
        askConversationId,
        userId,
        'ask_structured_answer',
      ))?.run_id,
      structuredAnswerRun.run_id,
      'idempotency must survive pending input acknowledgement',
    )
    assert.equal(await repository.cancelInactiveAgentRun(structuredAnswerRun.run_id, userId), true)

    const dispatchConversationId = 'conv_runtime_dispatch_failure'
    const dispatchRun = await repository.createAgentRun({
      runId: 'run_runtime_dispatch_failure',
      conversationId: dispatchConversationId,
      userId,
      request: { message: 'exercise dispatch exhaustion' },
      startedMessageId: 'msg_runtime_dispatch_failure',
    })
    const dispatchOwner = 'runner_dispatch_failure'
    assert.ok(await repository.claimAgentRun(dispatchRun.run_id, dispatchOwner, 30_000))
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      assert.equal(
        await repository.requeueAgentRunAfterDispatchFailure(
          dispatchRun.run_id,
          dispatchOwner,
          `dispatch failure ${attempt}`,
        ),
        true,
      )
      const persisted = await repository.getAgentRun(dispatchRun.run_id, userId)
      assert.equal(persisted?.dispatch_attempts, attempt)
      if (attempt < 5) {
        assert.equal(persisted?.status, 'queued')
        assert.ok(await repository.claimAgentRun(dispatchRun.run_id, dispatchOwner, 30_000))
      }
    }
    const exhaustedDispatch = await repository.getAgentRun(dispatchRun.run_id, userId)
    assert.equal(exhaustedDispatch?.status, 'recoverable')
    assert.equal(exhaustedDispatch?.recovery_count, 1)
    assert.equal(
      (await repository.getConversationRuntime(dispatchConversationId, userId))
        ?.active_lease_owner_id,
      null,
    )
    assert.equal(await repository.cancelInactiveAgentRun(dispatchRun.run_id, userId), true)

    const ineligibleConversationId = 'conv_runtime_ineligible_team_run'
    const ineligibleRun = await repository.createAgentRun({
      runId: 'run_runtime_ineligible_team_run',
      conversationId: ineligibleConversationId,
      userId,
      request: { message: 'must not hot-loop after its Team identity closes' },
      startedMessageId: 'msg_runtime_ineligible_team_run',
      teamId: 'team_runtime_ineligible',
      agentId: 'agent_runtime_ineligible',
      agentSessionId: 'session_runtime_ineligible',
      trigger: 'supervision',
      executionMode: 'conversation',
    })
    const ineligibleOwner = 'runner_ineligible_team_run'
    assert.ok(await repository.claimAgentRun(
      ineligibleRun.run_id,
      ineligibleOwner,
      30_000,
    ))
    assert.equal(
      await failIneligibleTeamRun(
        ineligibleRun,
        'runner_stale_ineligible_team_run',
        'TeamAgent is failed.',
      ),
      false,
      'a stale Runner must not terminalize another owner\'s exact leased Run',
    )
    assert.equal(
      (await repository.getAgentRun(ineligibleRun.run_id, userId))?.status,
      'running',
    )
    const ineligibleError = 'Agent Run cannot execute because its TeamAgent is failed.'
    assert.equal(
      await failIneligibleTeamRun(ineligibleRun, ineligibleOwner, ineligibleError),
      true,
    )
    const terminalIneligibleRun = await repository.getAgentRun(ineligibleRun.run_id, userId)
    assert.equal(terminalIneligibleRun?.status, 'failed')
    assert.equal(terminalIneligibleRun?.termination_reason, 'runtime_error')
    assert.equal(terminalIneligibleRun?.last_error, ineligibleError)
    assert.equal(terminalIneligibleRun?.lease, null)
    const terminalIneligibleRuntime = await repository.getConversationRuntime(
      ineligibleConversationId,
      userId,
    )
    assert.equal(terminalIneligibleRuntime?.active_run_id, null)
    assert.equal(terminalIneligibleRuntime?.active_lease_owner_id, null)

    const queueConversationId = 'conv_runtime_message_queue'
    await Promise.all([
      messageQueue.enqueueMessage(queueConversationId, 'queued input 1'),
      messageQueue.enqueueMessage(queueConversationId, 'queued input 2'),
      messageQueue.enqueueMessage(queueConversationId, 'queued input 3'),
      messageQueue.enqueueMessage(queueConversationId, 'queued input 4'),
    ])
    const concurrentQueueClaims = await Promise.all([
      messageQueue.dequeueMessages(queueConversationId),
      messageQueue.dequeueMessages(queueConversationId),
    ])
    const allClaimedQueueMessages = concurrentQueueClaims.flat()
    assert.equal(allClaimedQueueMessages.length, 4)
    assert.equal(
      new Set(allClaimedQueueMessages.map(message => message.queueId)).size,
      4,
      'concurrent queue consumers must never claim the same message twice',
    )
    for (const claim of concurrentQueueClaims) {
      if (claim.length > 0) {
        await messageQueue.acknowledgeDequeuedMessages(
          claim.map(message => message.queueId),
          claim[0].claimId,
        )
      }
    }
    assert.equal(await QueuedMessage.countDocuments({ conversation_id: queueConversationId }), 0)

    const targetRunId = 'run_queue_target'
    await messageQueue.enqueueMessage(
      queueConversationId,
      'release me to the next Run',
      undefined,
      targetRunId,
    )
    const targetedClaim = await messageQueue.dequeueMessages(queueConversationId, targetRunId)
    assert.equal(targetedClaim.length, 1)
    assert.equal(await messageQueue.releaseQueuedMessagesForRun(targetRunId), 1)
    const releasedClaim = await messageQueue.dequeueMessages(queueConversationId)
    assert.equal(releasedClaim.length, 1)
    assert.equal(releasedClaim[0].queueId, targetedClaim[0].queueId)
    await messageQueue.acknowledgeDequeuedMessages(
      releasedClaim.map(message => message.queueId),
      releasedClaim[0].claimId,
    )

    await messageQueue.enqueueMessage(queueConversationId, 'recover stale claim')
    const staleClaim = await messageQueue.dequeueMessages(queueConversationId)
    assert.equal(staleClaim.length, 1)
    await QueuedMessage.updateOne(
      { _id: staleClaim[0].queueId },
      { $set: { claimed_at: new Date(0) } },
    )
    assert.equal(await messageQueue.releaseStaleQueueClaims(1), 1)
    const reclaimed = await messageQueue.dequeueMessages(queueConversationId)
    assert.equal(reclaimed.length, 1)
    assert.equal(reclaimed[0].queueId, staleClaim[0].queueId)
    await messageQueue.acknowledgeDequeuedMessages(
      reclaimed.map(message => message.queueId),
      reclaimed[0].claimId,
    )

    const durableQueueKey = 'team-delivery:message-1'
    const durableQueueOptions = {
      visibility: 'internal' as const,
      sourceKind: 'team_supervision' as const,
      idempotencyKey: durableQueueKey,
      messageId: 'root_team_message_1',
    }
    const [durableFirst, durableConcurrentReplay] = await Promise.all([
      messageQueue.enqueueMessage(
        queueConversationId,
        'durable team update',
        undefined,
        undefined,
        durableQueueOptions,
      ),
      messageQueue.enqueueMessage(
        queueConversationId,
        'durable team update',
        undefined,
        undefined,
        durableQueueOptions,
      ),
    ])
    assert.equal(durableConcurrentReplay.queueId, durableFirst.queueId)
    assert.equal(await QueuedMessage.countDocuments({
      conversation_id: queueConversationId,
      idempotency_key: durableQueueKey,
    }), 1)
    const durableConsumerRunId = 'run_durable_queue_consumer'
    const durableClaim = await messageQueue.dequeueMessages(
      queueConversationId,
      durableConsumerRunId,
    )
    assert.equal(durableClaim.length, 1)
    assert.equal(durableClaim[0].messageId, 'root_team_message_1')
    await messageQueue.acknowledgeDequeuedMessages(
      durableClaim.map(message => message.queueId),
      durableClaim[0].claimId,
    )
    assert.equal((await QueuedMessage.findOne({
      conversation_id: queueConversationId,
      idempotency_key: durableQueueKey,
    }).lean())?.status, 'acknowledged')
    assert.equal((await messageQueue.getIdempotentQueuedMessage(
      queueConversationId,
      durableQueueKey,
    ))?.targetRunId, durableConsumerRunId)
    const durableAfterAckReplay = await messageQueue.enqueueMessage(
      queueConversationId,
      'durable team update',
      undefined,
      undefined,
      durableQueueOptions,
    )
    assert.equal(durableAfterAckReplay.queueId, durableFirst.queueId)
    assert.equal(durableAfterAckReplay.status, 'acknowledged')

    const inactiveRun = await repository.createAgentRun({
      runId: 'run_runtime_inactive_cancel',
      conversationId,
      userId,
      request: { message: 'cancel before execution' },
      startedMessageId: 'msg_runtime_inactive_cancel',
    })
    assert.equal(await repository.cancelInactiveAgentRun(inactiveRun.run_id, userId), true)
    assert.equal((await repository.getAgentRun(inactiveRun.run_id, userId))?.status, 'cancelled')

    const finalRuntime = await repository.getConversationRuntime(conversationId, userId)
    assert.equal(finalRuntime?.active_run_id, null)
    assert.equal(finalRuntime?.active_lease_owner_id, null)
    console.log('✓ Agent Runtime V2 Mongo recovery verification passed')
  } finally {
    await database.dropDatabase()
    await mongoose.disconnect()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
