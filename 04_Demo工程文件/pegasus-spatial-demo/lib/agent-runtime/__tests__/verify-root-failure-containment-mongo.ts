import assert from 'node:assert/strict'

const TEST_DATABASE_SUFFIX = '_test'
const mongoUri = process.env.AGENT_RUNTIME_TEST_MONGODB_URI?.trim()
  || 'mongodb://127.0.0.1:27018/sci_pegasus_root_containment_test'
const databaseName = mongoUri.match(/\/([^/?]+)(?:\?|$)/)?.[1]

if (!databaseName?.endsWith(TEST_DATABASE_SUFFIX)) {
  throw new Error(`Refusing to run Root containment tests outside an isolated *${TEST_DATABASE_SUFFIX} database.`)
}
process.env.MONGODB_URI = mongoUri

async function main(): Promise<void> {
  const mongoose = (await import('mongoose')).default
  const { connectDB } = await import('../../db/mongodb')
  const { QueuedMessage } = await import('../../db/queue-model')
  const { AGENT_TEAM_MODELS, TeamAgentModel } = await import('../../agent-team/models')
  const { agentTeamService } = await import('../../agent-team/service')
  const { runAgentTeamMaintenanceSweep } = await import('../../agent-team/orchestrator')
  const teamRepository = await import('../../agent-team/repository')
  const runRepository = await import('../repository')
  const { AgentRun, ConversationRuntime } = await import('../models')
  const {
    acknowledgeDequeuedMessages,
    dequeueMessages,
    enqueueMessage,
    repairTerminalRootTeamQueueReceipts,
  } = await import('../../agent/message-queue')
  const {
    releaseTeamExecutionLeases,
  } = await import('../runner')

  await connectDB()
  const database = mongoose.connection.db
  assert.ok(database)
  await database.dropDatabase()
  await Promise.all([
    ...AGENT_TEAM_MODELS.map(model => model.syncIndexes()),
    AgentRun.syncIndexes(),
    ConversationRuntime.syncIndexes(),
    QueuedMessage.syncIndexes(),
  ])

  const userId = 'user_root_containment'

  async function createTeam(suffix: string) {
    const conversationId = `conversation_root_containment_${suffix}`
    const team = await agentTeamService.ensureTeam({ conversationId, userId })
    const root = await agentTeamService.getAgent({
      teamId: team.team_id,
      userId,
      agentId: team.root_agent_id,
    })
    return { conversationId, team, root }
  }

  async function executeFailedRootRun(input: {
    suffix: string
    trigger: 'user' | 'supervision'
    recoverability: 'transient' | 'fatal'
    signature: string
    category?: 'runtime_transient' | 'configuration'
  }) {
    const context = await createTeam(input.suffix)
    const run = await runRepository.createAgentRun({
      runId: `run_${input.suffix}`,
      conversationId: context.conversationId,
      userId,
      request: { message: `${input.trigger} failure` },
      startedMessageId: `message_${input.suffix}`,
      teamId: context.team.team_id,
      agentId: context.root.agent_id,
      agentSessionId: context.root.current_session_id,
      trigger: input.trigger,
      rootVisible: true,
      executionMode: 'conversation',
    })
    const ownerId = `owner_${input.suffix}`
    assert.ok(await runRepository.claimAgentRun(run.run_id, ownerId))
    const slot = await teamRepository.claimExecutionSlot({
      teamId: context.team.team_id,
      userId,
      agentId: context.root.agent_id,
      sessionId: context.root.current_session_id,
      runId: run.run_id,
      ownerId,
    })
    assert.ok(slot)
    const session = await teamRepository.claimAgentSessionRun({
      teamId: context.team.team_id,
      userId,
      sessionId: context.root.current_session_id,
      runId: run.run_id,
      ownerId,
    })
    assert.ok(session?.run_lease?.fence_token)
    assert.equal(await runRepository.setRunStatus(run.run_id, 'failed', {
      terminationReason: input.recoverability === 'fatal' ? 'model_error' : 'runtime_error',
      error: `${input.signature} diagnostic`,
      failureRecoverability: input.recoverability,
      failureCategory: input.category ?? (input.recoverability === 'fatal' ? 'configuration' : 'runtime_transient'),
      failureSignature: input.signature,
      releaseActive: true,
      leaseOwnerId: ownerId,
    }), true)
    await releaseTeamExecutionLeases(run, ownerId, {
      executionFenceToken: slot!.fence_token,
      sessionFenceToken: session!.run_lease!.fence_token,
    })
    return {
      ...context,
      run: await runRepository.getAgentRun(run.run_id, userId),
      agent: await agentTeamService.getAgent({
        teamId: context.team.team_id,
        userId,
        agentId: context.root.agent_id,
      }),
    }
  }

  const transientPublic = await executeFailedRootRun({
    suffix: 'public_transient',
    trigger: 'user',
    recoverability: 'transient',
    signature: 'signature_public_transient',
  })
  assert.equal(transientPublic.agent.status, 'idle', 'one transient public failure is contained')

  const fatalSupervision = await executeFailedRootRun({
    suffix: 'supervision_fatal',
    trigger: 'supervision',
    recoverability: 'fatal',
    signature: 'signature_configuration_fatal',
    category: 'configuration',
  })
  assert.equal(fatalSupervision.agent.status, 'failed', 'fatal supervision failure must remain visible')

  // If a process dies after persisting a fatal Run but before releasing the
  // Team session, lease-expiry recovery must preserve the fatal decision.
  const expiredFatal = await createTeam('expired_fatal_lease')
  const expiredFatalRun = await runRepository.createAgentRun({
    runId: 'run_expired_fatal_lease',
    conversationId: expiredFatal.conversationId,
    userId,
    request: { message: 'fatal before session release' },
    startedMessageId: 'message_expired_fatal_lease',
    teamId: expiredFatal.team.team_id,
    agentId: expiredFatal.root.agent_id,
    agentSessionId: expiredFatal.root.current_session_id,
    trigger: 'supervision',
    rootVisible: true,
    executionMode: 'conversation',
  })
  const expiredOwner = 'owner_expired_fatal_lease'
  assert.ok(await runRepository.claimAgentRun(expiredFatalRun.run_id, expiredOwner))
  const expiredSession = await teamRepository.claimAgentSessionRun({
    teamId: expiredFatal.team.team_id,
    userId,
    sessionId: expiredFatal.root.current_session_id,
    runId: expiredFatalRun.run_id,
    ownerId: expiredOwner,
  })
  assert.ok(expiredSession?.run_lease?.fence_token)
  assert.equal(await runRepository.setRunStatus(expiredFatalRun.run_id, 'failed', {
    terminationReason: 'model_error',
    error: 'provider configuration is invalid',
    failureRecoverability: 'fatal',
    failureCategory: 'configuration',
    failureSignature: 'signature_expired_fatal',
    releaseActive: true,
    leaseOwnerId: expiredOwner,
  }), true)
  await mongoose.connection.db!.collection('agent_session_runtimes').updateOne(
    { session_id: expiredFatal.root.current_session_id },
    { $set: { 'run_lease.expires_at': new Date(0) } },
  )
  assert.deepEqual(await teamRepository.recoverExpiredAgentSessionRuns({
    teamId: expiredFatal.team.team_id,
    userId,
  }), [expiredFatalRun.run_id])
  assert.equal((await TeamAgentModel.findOne({
    agent_id: expiredFatal.root.agent_id,
  }).lean())?.status, 'failed')

  const circuit = await createTeam('supervision_circuit')
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const run = await runRepository.createAgentRun({
      runId: `run_supervision_circuit_${attempt}`,
      conversationId: circuit.conversationId,
      userId,
      request: { message: 'same transient supervision failure' },
      startedMessageId: `message_supervision_circuit_${attempt}`,
      teamId: circuit.team.team_id,
      agentId: circuit.root.agent_id,
      agentSessionId: circuit.root.current_session_id,
      trigger: 'supervision',
      rootVisible: true,
      executionMode: 'conversation',
    })
    const ownerId = `owner_supervision_circuit_${attempt}`
    assert.ok(await runRepository.claimAgentRun(run.run_id, ownerId))
    const slot = await teamRepository.claimExecutionSlot({
      teamId: circuit.team.team_id,
      userId,
      agentId: circuit.root.agent_id,
      sessionId: circuit.root.current_session_id,
      runId: run.run_id,
      ownerId,
    })
    const session = await teamRepository.claimAgentSessionRun({
      teamId: circuit.team.team_id,
      userId,
      sessionId: circuit.root.current_session_id,
      runId: run.run_id,
      ownerId,
    })
    assert.ok(slot && session?.run_lease?.fence_token)
    assert.equal(await runRepository.setRunStatus(run.run_id, 'failed', {
      terminationReason: 'runtime_error',
      error: 'repeatable transient failure',
      failureRecoverability: 'transient',
      failureCategory: 'runtime_transient',
      failureSignature: 'signature_repeatable_transient',
      releaseActive: true,
      leaseOwnerId: ownerId,
    }), true)
    await releaseTeamExecutionLeases(run, ownerId, {
      executionFenceToken: slot!.fence_token,
      sessionFenceToken: session!.run_lease!.fence_token,
    })
    const current = await TeamAgentModel.findOne({ agent_id: circuit.root.agent_id }).lean()
    assert.equal(current?.status, attempt < 3 ? 'idle' : 'failed')
  }
  const circuitEvents = await agentTeamService.listEventsAfter({
    teamId: circuit.team.team_id,
    userId,
    afterSeq: 0,
    limit: 100,
  })
  assert.equal(circuitEvents.some(event => (
    event.payload.reason === 'supervision_failure_circuit_open'
    && event.payload.status === 'failed'
  )), true, 'opening the circuit must be auditable')

  // Crash boundary A: Run is terminal, Root is still failed, and both pending
  // and claimed outbox rows remain bound to the dead Run.
  const crashBeforeIdle = await createTeam('crash_before_idle')
  await TeamAgentModel.updateOne(
    { agent_id: crashBeforeIdle.root.agent_id },
    { $set: { status: 'failed', last_transition_at: new Date() } },
  )
  const terminalRunA = await runRepository.createAgentRun({
    runId: 'run_crash_before_idle',
    conversationId: crashBeforeIdle.conversationId,
    userId,
    request: { message: 'terminal outbox repair A' },
    startedMessageId: 'message_crash_before_idle',
    teamId: crashBeforeIdle.team.team_id,
    agentId: crashBeforeIdle.root.agent_id,
    agentSessionId: crashBeforeIdle.root.current_session_id,
    trigger: 'supervision',
    rootVisible: true,
    executionMode: 'conversation',
  })
  await enqueueMessage(crashBeforeIdle.conversationId, 'claimed receipt', undefined, terminalRunA.run_id, {
    visibility: 'internal',
    sourceKind: 'team_supervision',
    idempotencyKey: 'crash-before-idle-claimed',
    messageId: 'message_crash_before_idle_claimed',
  })
  const claimedA = await dequeueMessages(crashBeforeIdle.conversationId, terminalRunA.run_id, { targetedOnly: true })
  assert.equal(claimedA.length, 1)
  await enqueueMessage(crashBeforeIdle.conversationId, 'pending receipt', undefined, terminalRunA.run_id, {
    visibility: 'internal',
    sourceKind: 'team_supervision',
    idempotencyKey: 'crash-before-idle-pending',
    messageId: 'message_crash_before_idle_pending',
  })
  assert.equal(await runRepository.setRunStatus(terminalRunA.run_id, 'cancelled', {
    terminationReason: 'runtime_error',
    releaseActive: true,
    onlyIfUnleased: true,
  }), true)
  assert.equal(await repairTerminalRootTeamQueueReceipts({ runId: terminalRunA.run_id }), 2)
  const repairedA = await QueuedMessage.find({
    idempotency_key: { $in: ['crash-before-idle-claimed', 'crash-before-idle-pending'] },
  }).lean()
  assert.ok(repairedA.every(receipt => receipt.status === 'pending' && receipt.target_run_id === null))
  const recoveredA = await agentTeamService.recoverFailedRootForPublicInput({
    conversationId: crashBeforeIdle.conversationId,
    userId,
  })
  assert.equal(recoveredA.recovered, true)

  // Crash boundary B: Root already became idle before the caller could unbind
  // the terminal receipt. Recovery no longer runs, so the periodic/public
  // repair must find it independently of Agent status.
  const crashAfterIdle = await createTeam('crash_after_idle')
  const terminalRunB = await runRepository.createAgentRun({
    runId: 'run_crash_after_idle',
    conversationId: crashAfterIdle.conversationId,
    userId,
    request: { message: 'terminal outbox repair B' },
    startedMessageId: 'message_crash_after_idle',
    teamId: crashAfterIdle.team.team_id,
    agentId: crashAfterIdle.root.agent_id,
    agentSessionId: crashAfterIdle.root.current_session_id,
    trigger: 'supervision',
    rootVisible: true,
    executionMode: 'conversation',
  })
  await enqueueMessage(crashAfterIdle.conversationId, 'pending after idle', undefined, terminalRunB.run_id, {
    visibility: 'internal',
    sourceKind: 'team_supervision',
    idempotencyKey: 'crash-after-idle-pending',
    messageId: 'message_crash_after_idle_pending',
  })
  assert.equal(await runRepository.setRunStatus(terminalRunB.run_id, 'cancelled', {
    terminationReason: 'runtime_error',
    releaseActive: true,
    onlyIfUnleased: true,
  }), true)
  assert.equal((await TeamAgentModel.findOne({ agent_id: crashAfterIdle.root.agent_id }).lean())?.status, 'idle')
  const maintenanceRepair = await runAgentTeamMaintenanceSweep()
  assert.ok(maintenanceRepair.terminal_root_receipts_released >= 1)
  const repairedB = await QueuedMessage.findOne({ idempotency_key: 'crash-after-idle-pending' }).lean()
  assert.equal(repairedB?.status, 'pending')
  assert.equal(repairedB?.target_run_id, null)

  // Acknowledged receipts already have a durable ConversationMessage and are
  // audit records, not backlog; the repair must not rewrite them.
  const nextRun = await runRepository.createAgentRun({
    runId: 'run_recovered_backlog_consumer',
    conversationId: crashAfterIdle.conversationId,
    userId,
    request: { message: 'consume repaired backlog' },
    startedMessageId: 'message_recovered_backlog_consumer',
    teamId: crashAfterIdle.team.team_id,
    agentId: crashAfterIdle.root.agent_id,
    agentSessionId: crashAfterIdle.root.current_session_id,
    trigger: 'user',
    rootVisible: true,
    executionMode: 'conversation',
  })
  const recoveredBacklog = await dequeueMessages(crashAfterIdle.conversationId, nextRun.run_id)
  assert.deepEqual(recoveredBacklog.map(item => item.messageId), ['message_crash_after_idle_pending'])
  await acknowledgeDequeuedMessages(
    recoveredBacklog.map(item => item.queueId),
    recoveredBacklog[0]!.claimId,
  )
  assert.equal(await repairTerminalRootTeamQueueReceipts({
    conversationId: crashAfterIdle.conversationId,
  }), 0)
  const acknowledged = await QueuedMessage.findOne({ idempotency_key: 'crash-after-idle-pending' }).lean()
  assert.equal(acknowledged?.status, 'acknowledged')
  assert.equal(acknowledged?.target_run_id, nextRun.run_id)

  console.log('Root failure containment Mongo verification passed.')
  await mongoose.disconnect()
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
