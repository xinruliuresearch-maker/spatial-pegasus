import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const TEST_DATABASE_SUFFIX = '_test'
const mongoUri = process.env.AGENT_TEAM_TEST_MONGODB_URI?.trim()
  || 'mongodb://127.0.0.1:27018/sci_pegasus_agent_team_test'
const databaseName = mongoUri.match(/\/([^/?]+)(?:\?|$)/)?.[1]

if (!databaseName?.endsWith(TEST_DATABASE_SUFFIX)) {
  throw new Error(`Refusing to run Agent Team integration tests outside an isolated *${TEST_DATABASE_SUFFIX} database.`)
}
process.env.MONGODB_URI = mongoUri

async function main(): Promise<void> {
  const mongoose = (await import('mongoose')).default
  const { connectDB } = await import('../../db/mongodb')
  const { AgentRun } = await import('../../agent-runtime/models')
  const { QueuedMessage } = await import('../../db/queue-model')
  const {
    acknowledgeDequeuedMessages,
    dequeueMessages,
    enqueueMessage,
    releaseQueuedMessagesForRun,
  } = await import('../../agent/message-queue')
  const agentRunRepository = await import('../../agent-runtime/repository')
  const {
    automaticTurnReplyTargets,
    hydrateTurnMailboxRouting,
    mailboxConversationMessage,
  } = await import('../../agent-runtime/member-executor')
  const {
    AGENT_TEAM_MODELS,
    AgentCommandReceiptModel,
    AgentMailboxMessageModel,
    AgentSessionRuntimeModel,
    AgentTeamModel,
    AgentTaskModel,
    AgentWaitSubscriptionModel,
    DelegationGrantModel,
    TeamAgentModel,
    TeamSupervisionBatchModel,
  } = await import('../models')
  const {
    claimAgentSessionRun,
    claimExecutionSlot,
    heartbeatAgentSessionRun,
    heartbeatExecutionSlot,
    validateExecutionFence,
    releaseAgentSessionRun,
    releaseExecutionSlot,
  } = await import('../repository')
  const { agentTeamService } = await import('../service')
  const {
    deliverRootMailbox,
    runAgentTeamMaintenanceSweep,
    scheduleNextAgentTask,
    wakeRootWithUpdate,
    wakeMemberForMailbox,
  } = await import('../orchestrator')
  const { releaseTeamExecutionLeases } = await import('../../agent-runtime/runner')
  const {
    AgentCommandFenceLostError,
    AgentControlFenceLostError,
    InvalidAgentTeamOperationError,
    AgentPermissionError,
    AgentTeamCapacityError,
  } = await import('../errors')

  await connectDB()
  const database = mongoose.connection.db
  assert.ok(database)
  await database.dropDatabase()
  await Promise.all([
    ...AGENT_TEAM_MODELS.map(model => model.syncIndexes()),
    AgentRun.syncIndexes(),
  ])

  const conversationId = 'conversation_team_integration'
  const userId = 'user_team_integration'
  const team = await agentTeamService.ensureTeam({ conversationId, userId })
  const replayedTeam = await agentTeamService.ensureTeam({ conversationId, userId })
  assert.equal(replayedTeam.team_id, team.team_id)
  const root = await agentTeamService.getAgent({
    teamId: team.team_id,
    userId,
    agentId: team.root_agent_id,
  })
  assert.equal(root.is_root, true)
  assert.equal(root.slot, 0)

  // Chat, Team snapshot and Team SSE can all lazily bootstrap the same
  // project. Every caller must converge on one Root identity, Grant and
  // Session without exposing duplicate-key races.
  const concurrentConversationId = 'conversation_concurrent_team_bootstrap'
  const concurrentTeams = await Promise.all(
    Array.from({ length: 12 }, () => agentTeamService.ensureTeam({
      conversationId: concurrentConversationId,
      userId,
    })),
  )
  assert.equal(new Set(concurrentTeams.map(item => item.team_id)).size, 1)
  const concurrentTeam = concurrentTeams[0]
  const [concurrentRoot, concurrentGrants, concurrentSessions] = await Promise.all([
    TeamAgentModel.findOne({
      team_id: concurrentTeam.team_id,
      agent_id: concurrentTeam.root_agent_id,
    }).lean(),
    DelegationGrantModel.find({
      team_id: concurrentTeam.team_id,
      agent_id: concurrentTeam.root_agent_id,
      version: 1,
    }).lean(),
    AgentSessionRuntimeModel.find({
      team_id: concurrentTeam.team_id,
      agent_id: concurrentTeam.root_agent_id,
      generation: 1,
    }).lean(),
  ])
  assert.ok(concurrentRoot)
  assert.equal(concurrentGrants.length, 1)
  assert.equal(concurrentSessions.length, 1)
  assert.equal(concurrentRoot.active_grant_id, concurrentGrants[0].grant_id)
  assert.equal(concurrentRoot.current_session_id, concurrentSessions[0].session_id)

  // A standalone-Mongo crash from an older build may leave TeamAgent pointing
  // at a reserved ID while the logically unique record committed under the
  // competing caller's ID. A replay must adopt the durable records.
  await TeamAgentModel.updateOne(
    { agent_id: concurrentRoot.agent_id },
    {
      $set: {
        active_grant_id: 'agent_grant_stale_reservation',
        current_session_id: 'agent_session_stale_reservation',
      },
    },
  )
  await agentTeamService.ensureTeam({ conversationId: concurrentConversationId, userId })
  const repairedConcurrentRoot = await TeamAgentModel.findOne({
    agent_id: concurrentRoot.agent_id,
  }).lean()
  assert.ok(repairedConcurrentRoot)
  assert.equal(repairedConcurrentRoot.active_grant_id, concurrentGrants[0].grant_id)
  assert.equal(repairedConcurrentRoot.current_session_id, concurrentSessions[0].session_id)

  // A runtime failure must not permanently brick a project. Authenticated
  // public input may recover only the durable Root (same generation/session)
  // and supersede a never-started, unleased supervision Run. The reminder is
  // retained and made available to the next public Run rather than deleted.
  const failedRootConversationId = 'conversation_failed_root_public_recovery'
  const failedRootTeam = await agentTeamService.ensureTeam({
    conversationId: failedRootConversationId,
    userId,
  })
  const failedRoot = await agentTeamService.getAgent({
    teamId: failedRootTeam.team_id,
    userId,
    agentId: failedRootTeam.root_agent_id,
  })
  await TeamAgentModel.updateOne(
    { agent_id: failedRoot.agent_id },
    { $set: { status: 'failed', last_transition_at: new Date() } },
  )
  const failedRootSupervisionRun = await agentRunRepository.createAgentRun({
    runId: 'run_failed_root_public_recovery',
    conversationId: failedRootConversationId,
    userId,
    request: {
      message: 'durable supervision reminder',
      internal: { kind: 'team_supervision', source_ids: ['event_failed_root_recovery'] },
    },
    startedMessageId: 'msg_failed_root_public_recovery',
    teamId: failedRootTeam.team_id,
    agentId: failedRoot.agent_id,
    agentSessionId: failedRoot.current_session_id,
    trigger: 'supervision',
    rootVisible: true,
    executionMode: 'conversation',
  })
  await enqueueMessage(
    failedRootConversationId,
    'durable supervision payload',
    undefined,
    failedRootSupervisionRun.run_id,
    {
      visibility: 'internal',
      sourceKind: 'team_supervision',
      idempotencyKey: 'failed-root-public-recovery-reminder',
      messageId: 'queue_failed_root_public_recovery',
    },
  )
  const failedRootRecovery = await agentTeamService.recoverFailedRootForPublicInput({
    conversationId: failedRootConversationId,
    userId,
  })
  assert.equal(failedRootRecovery.recovered, true)
  assert.equal(failedRootRecovery.supersededRunId, failedRootSupervisionRun.run_id)
  await releaseQueuedMessagesForRun(failedRootRecovery.supersededRunId!)
  const [recoveredRoot, supersededRun, retainedReminder] = await Promise.all([
    agentTeamService.getAgent({
      teamId: failedRootTeam.team_id,
      userId,
      agentId: failedRoot.agent_id,
    }),
    agentRunRepository.getAgentRun(failedRootSupervisionRun.run_id, userId),
    QueuedMessage.findOne({ message_id: 'queue_failed_root_public_recovery' }).lean(),
  ])
  assert.equal(recoveredRoot.status, 'idle')
  assert.equal(recoveredRoot.generation, failedRoot.generation)
  assert.equal(recoveredRoot.current_session_id, failedRoot.current_session_id)
  assert.equal(supersededRun?.status, 'cancelled')
  assert.equal(retainedReminder?.status, 'pending')
  assert.equal(retainedReminder?.target_run_id, null)

  // Automatic updates aimed at a dormant Root must remain durable without
  // creating Runs that are guaranteed to fail their Team identity gate. On
  // recovery, the first normal supervision turn can consume the whole
  // untargeted backlog exactly like queued user follow-up input.
  const dormantRootConversationId = 'conversation_dormant_root_update_guard'
  const dormantRootTeam = await agentTeamService.ensureTeam({
    conversationId: dormantRootConversationId,
    userId,
  })
  const dormantRoot = await agentTeamService.getAgent({
    teamId: dormantRootTeam.team_id,
    userId,
    agentId: dormantRootTeam.root_agent_id,
  })
  for (const status of ['failed', 'paused', 'completed'] as const) {
    await TeamAgentModel.updateOne(
      { agent_id: dormantRoot.agent_id },
      { $set: { status, last_transition_at: new Date() } },
    )
    const dormantUpdate = {
      team: dormantRootTeam,
      content: `Durable update while Root is ${status}.`,
      sourceIds: [`event_dormant_root_${status}`],
      deliveryKey: `dormant-root-update:${status}`,
      messageId: `message_dormant_root_${status}`,
    }
    assert.equal(await wakeRootWithUpdate(dormantUpdate), null)
    if (status === 'failed') {
      assert.equal(
        await wakeRootWithUpdate(dormantUpdate),
        null,
        'a retried dormant delivery must reuse its idempotent queue receipt',
      )
    }
  }
  assert.equal(await AgentRun.countDocuments({
    conversation_id: dormantRootConversationId,
  }), 0, 'a dormant Root must not receive an automatic Run')
  const dormantReceipts = await QueuedMessage.find({
    conversation_id: dormantRootConversationId,
    idempotency_key: { $in: [
      'dormant-root-update:failed',
      'dormant-root-update:paused',
      'dormant-root-update:completed',
    ] },
  }).lean()
  assert.equal(dormantReceipts.length, 3)
  assert.ok(dormantReceipts.every(receipt => (
    receipt.status === 'pending' && receipt.target_run_id === null
  )), 'dormant Root updates must remain pending and untargeted')

  await TeamAgentModel.updateOne(
    { agent_id: dormantRoot.agent_id },
    { $set: { status: 'idle', completed_at: null, last_transition_at: new Date() } },
  )
  const recoveredBacklogRunId = await wakeRootWithUpdate({
    team: dormantRootTeam,
    content: 'Root recovered; consume the retained backlog.',
    sourceIds: ['event_dormant_root_recovered'],
    deliveryKey: 'dormant-root-update:recovered',
    messageId: 'message_dormant_root_recovered',
  })
  assert.ok(recoveredBacklogRunId)
  const recoveredBacklog = await dequeueMessages(
    dormantRootConversationId,
    recoveredBacklogRunId!,
  )
  assert.deepEqual(
    new Set(recoveredBacklog.map(message => message.messageId)),
    new Set([
      'message_dormant_root_failed',
      'message_dormant_root_paused',
      'message_dormant_root_completed',
      'message_dormant_root_recovered',
    ]),
    'the first recovered Run must be able to claim every retained update',
  )
  await acknowledgeDequeuedMessages(
    recoveredBacklog.map(message => message.queueId),
    recoveredBacklog[0]!.claimId,
  )
  await agentRunRepository.cancelInactiveAgentRun(recoveredBacklogRunId!, userId)

  // A failed automatic Root supervision Run is retained as failed audit data,
  // while release of its exact session/slot fences returns Root to idle. A
  // public user Run retains the existing stronger Agent-failure semantics.
  const containedFailureConversationId = 'conversation_root_supervision_failure_containment'
  const containedFailureTeam = await agentTeamService.ensureTeam({
    conversationId: containedFailureConversationId,
    userId,
  })
  const containedFailureRoot = await agentTeamService.getAgent({
    teamId: containedFailureTeam.team_id,
    userId,
    agentId: containedFailureTeam.root_agent_id,
  })
  const failRootRun = async (
    runId: string,
    trigger: 'supervision' | 'user',
  ) => {
    const created = await agentRunRepository.createAgentRun({
      runId,
      conversationId: containedFailureConversationId,
      userId,
      request: { message: `${trigger} failure containment` },
      startedMessageId: `message_${runId}`,
      teamId: containedFailureTeam.team_id,
      agentId: containedFailureRoot.agent_id,
      agentSessionId: containedFailureRoot.current_session_id,
      trigger,
      rootVisible: true,
      executionMode: 'conversation',
    })
    const ownerId = `owner_${runId}`
    const claimed = await agentRunRepository.claimAgentRun(runId, ownerId)
    assert.ok(claimed)
    const slot = await claimExecutionSlot({
      teamId: containedFailureTeam.team_id,
      userId,
      agentId: containedFailureRoot.agent_id,
      sessionId: containedFailureRoot.current_session_id,
      runId,
      ownerId,
    })
    assert.ok(slot)
    const session = await claimAgentSessionRun({
      teamId: containedFailureTeam.team_id,
      userId,
      sessionId: containedFailureRoot.current_session_id,
      runId,
      ownerId,
    })
    assert.ok(session?.run_lease?.fence_token)
    assert.equal(await agentRunRepository.setRunStatus(runId, 'failed', {
      terminationReason: 'runtime_error',
      error: 'synthetic token-estimator failure',
      releaseActive: true,
      leaseOwnerId: ownerId,
    }), true)
    await releaseTeamExecutionLeases(created, ownerId, {
      executionFenceToken: slot!.fence_token,
      sessionFenceToken: session!.run_lease!.fence_token,
    })
    return agentRunRepository.getAgentRun(runId, userId)
  }

  const containedSupervisionRun = await failRootRun(
    'run_root_supervision_failure_contained',
    'supervision',
  )
  assert.equal(containedSupervisionRun?.status, 'failed')
  assert.equal(containedSupervisionRun?.last_error, 'synthetic token-estimator failure')
  assert.equal((await TeamAgentModel.findOne({
    agent_id: containedFailureRoot.agent_id,
  }).lean())?.status, 'idle', 'a failed automatic supervision turn must return Root to idle')
  const containedReleaseEvent = await agentTeamService.listEventsAfter({
    teamId: containedFailureTeam.team_id,
    userId,
    afterSeq: 0,
    limit: 200,
  })
  assert.equal(containedReleaseEvent.some(event => (
    event.run_id === containedSupervisionRun?.run_id
    && event.type === 'agent_status_changed'
    && event.payload.status === 'idle'
    && event.payload.reason === 'supervision_run_failed'
  )), true, 'the containment decision must remain auditable without an agent_error wake')

  const failedPublicRun = await failRootRun(
    'run_root_public_failure_retains_semantics',
    'user',
  )
  assert.equal(failedPublicRun?.status, 'failed')
  assert.equal((await TeamAgentModel.findOne({
    agent_id: containedFailureRoot.agent_id,
  }).lean())?.status, 'failed', 'a public Root failure must retain existing semantics')

  const rootContext = (run: string, tool: string) => ({
    team_id: team.team_id,
    user_id: userId,
    caller_agent_id: root.agent_id,
    run_id: run,
    tool_use_id: tool,
  })

  try {
    const first = await agentTeamService.createAgent(rootContext('run_create_1', 'tool_create_1'), {
      displayName: 'Evidence Scout',
      role: 'Find converging evidence',
      grant: { allowed_tool_names: ['ArxivFetchPaper', 'Read', 'SearchDocument'] },
      initialTask: {
        title: 'Map the evidence',
        objective: 'Find primary papers that support or challenge the hypothesis.',
        acceptanceCriteria: ['At least three primary sources'],
      },
    })
    const replay = await agentTeamService.createAgent(rootContext('run_create_1', 'tool_create_1'), {
      displayName: 'A different replay payload is ignored',
      role: 'Idempotent replay',
    })
    assert.equal(replay.agent.agent_id, first.agent.agent_id)
    assert.equal(replay.task?.task_id, first.task?.task_id)
    assert.equal(first.grant.capabilities.can_publish_references, true)

    const second = await agentTeamService.createAgent(rootContext('run_create_2', 'tool_create_2'), {
      displayName: 'Materials Reviewer',
      role: 'Review materials-science claims',
    })
    const third = await agentTeamService.createAgent(rootContext('run_create_3', 'tool_create_3'), {
      displayName: 'Synthesis Analyst',
      role: 'Integrate evidence and identify disagreements',
    })

    const broadcastPlanContext = rootContext(
      'run_broadcast_plan_freeze',
      'tool_broadcast_plan_freeze',
    )
    await TeamAgentModel.updateOne(
      { agent_id: second.agent.agent_id },
      { $set: { status: 'paused', last_transition_at: new Date() } },
    )
    const frozenBroadcastAudience = await agentTeamService.planBroadcast(broadcastPlanContext)
    assert.ok(!frozenBroadcastAudience.includes(second.agent.agent_id))
    await TeamAgentModel.updateOne(
      { agent_id: second.agent.agent_id },
      { $set: { status: 'idle', last_transition_at: new Date() } },
    )
    assert.deepEqual(
      await agentTeamService.planBroadcast(broadcastPlanContext),
      frozenBroadcastAudience,
      'broadcast replay must use its durable recipient snapshot instead of including later-active Agents',
    )

    const conversationalResumeTask = await agentTeamService.assignTask(
      rootContext('run_message_resume_task_create', 'tool_message_resume_task_create'),
      {
        assignedAgentId: third.agent.agent_id,
        title: 'Resume by direct message',
        objective: 'Pause once, then continue in the same formal Task context when Root replies.',
      },
    )
    await agentTeamService.updateTask({
      team_id: team.team_id,
      user_id: userId,
      caller_agent_id: third.agent.agent_id,
      run_id: 'run_message_resume_wait',
      tool_use_id: 'tool_message_resume_wait',
    }, {
      taskId: conversationalResumeTask.task_id,
      status: 'waiting',
    })
    const resumeMessage = await agentTeamService.sendMessage(
      rootContext('run_message_resume_send', 'tool_message_resume_send'),
      {
        recipientAgentId: third.agent.agent_id,
        kind: 'request',
        content: 'The missing decision is available. Continue this Task now.',
        taskId: conversationalResumeTask.task_id,
      },
    )
    const resumedTaskRunId = await wakeMemberForMailbox({
      teamId: team.team_id,
      userId,
      agentId: third.agent.agent_id,
      messageId: resumeMessage.message.message_id,
      kind: resumeMessage.message.kind,
    })
    assert.ok(resumedTaskRunId)
    const resumedTaskRun = await agentRunRepository.getAgentRun(resumedTaskRunId!, userId)
    assert.equal(resumedTaskRun?.task_id, conversationalResumeTask.task_id,
      'a direct same-task message must resume with the formal Task context')
    assert.equal((await AgentTaskModel.findOne({
      task_id: conversationalResumeTask.task_id,
    }).lean())?.status, 'running')
    await agentTeamService.updateTask(
      rootContext('run_message_resume_cancel', 'tool_message_resume_cancel'),
      { taskId: conversationalResumeTask.task_id, status: 'cancelled' },
    )

    const taskUpdateTarget = await agentTeamService.assignTask(
      rootContext('run_task_update_create', 'tool_task_update_create'),
      {
        assignedAgentId: second.agent.agent_id,
        title: 'Exercise TaskUpdate',
        objective: 'Verify owner permissions, state transitions, and command takeover.',
      },
    )
    const memberTaskContext = (runId: string, toolUseId: string) => ({
      team_id: team.team_id,
      user_id: userId,
      caller_agent_id: second.agent.agent_id,
      run_id: runId,
      tool_use_id: toolUseId,
    })
    const waitingTaskContext = memberTaskContext('run_task_update_wait', 'tool_task_update_wait')
    const ownerWaiting = await agentTeamService.updateTask(waitingTaskContext, {
      taskId: taskUpdateTarget.task_id,
      status: 'waiting',
    })
    assert.equal(ownerWaiting.status, 'waiting')
    assert.equal(ownerWaiting.waiting_kind, 'manual')
    await AgentCommandReceiptModel.updateOne(
      {
        team_id: team.team_id,
        user_id: userId,
        run_id: waitingTaskContext.run_id,
        tool_use_id: waitingTaskContext.tool_use_id,
        command_name: 'TaskUpdate',
      },
      {
        $set: {
          status: 'processing',
          response: null,
          completed_at: null,
          lease_owner_id: 'crashed_task_update_owner',
          lease_expires_at: new Date(0),
        },
      },
    )
    const recoveredOwnerWaiting = await agentTeamService.updateTask(waitingTaskContext, {
      taskId: taskUpdateTarget.task_id,
      status: 'waiting',
    })
    assert.equal(recoveredOwnerWaiting.status, 'waiting')
    assert.equal(recoveredOwnerWaiting.waiting_kind, 'manual')
    assert.equal(recoveredOwnerWaiting.last_command_key, ownerWaiting.last_command_key)
    const activeRunsBeforeManualWait = await AgentRun.countDocuments({
      team_id: team.team_id,
      agent_id: second.agent.agent_id,
      active_key: { $type: 'string' },
    })
    assert.equal(await scheduleNextAgentTask({
      teamId: team.team_id,
      userId,
      agentId: second.agent.agent_id,
    }), null)
    assert.equal(await scheduleNextAgentTask({
      teamId: team.team_id,
      userId,
      agentId: second.agent.agent_id,
    }), null)
    assert.equal(await AgentRun.countDocuments({
      team_id: team.team_id,
      agent_id: second.agent.agent_id,
      active_key: { $type: 'string' },
    }), activeRunsBeforeManualWait, 'manual waiting must not create scheduler hot-loop Runs')
    const waitingCheckpoint = await agentTeamService.submitResult({
      team_id: team.team_id,
      user_id: userId,
      caller_agent_id: second.agent.agent_id,
      run_id: 'run_task_update_waiting_checkpoint',
      tool_use_id: 'natural_turn_result_v2',
    }, {
      taskId: taskUpdateTarget.task_id,
      finalResponse: 'Blocked pending explicit coordinator direction.',
      implicit: true,
    })
    assert.equal(waitingCheckpoint.result.outcome, 'blocked')
    const durableWaitingCheckpoint = await AgentTaskModel.findOne({
      task_id: taskUpdateTarget.task_id,
    }).lean()
    assert.equal(durableWaitingCheckpoint?.status, 'waiting')
    assert.equal(durableWaitingCheckpoint?.waiting_kind, 'manual')
    assert.ok(durableWaitingCheckpoint?.result_ids.includes(waitingCheckpoint.result.result_id))
    await assert.rejects(
      agentTeamService.updateTask(
        memberTaskContext('run_task_update_illegal_owner', 'tool_task_update_illegal_owner'),
        {
          taskId: taskUpdateTarget.task_id,
          ownerAgentId: third.agent.agent_id,
        },
      ),
      (error: unknown) => error instanceof AgentPermissionError,
    )
    const rootQueued = await agentTeamService.updateTask(
      rootContext('run_task_update_resume', 'tool_task_update_resume'),
      { taskId: taskUpdateTarget.task_id, status: 'queued' },
    )
    assert.equal(rootQueued.status, 'queued')
    assert.equal(rootQueued.waiting_kind ?? null, null)
    await assert.rejects(
      agentTeamService.updateTask(
        memberTaskContext('run_task_update_running', 'tool_task_update_running'),
        { taskId: taskUpdateTarget.task_id, status: 'running' },
      ),
      (error: unknown) => error instanceof InvalidAgentTeamOperationError,
    )
    await agentTeamService.submitResult({
      team_id: team.team_id,
      user_id: userId,
      caller_agent_id: second.agent.agent_id,
      run_id: 'run_task_update_submit',
      tool_use_id: 'natural_turn_result_v2',
    }, {
      taskId: taskUpdateTarget.task_id,
      finalResponse: 'TaskUpdate acceptance candidate is ready.',
      implicit: true,
    })
    await assert.rejects(
      agentTeamService.updateTask(
        memberTaskContext('run_task_update_illegal_accept', 'tool_task_update_illegal_accept'),
        { taskId: taskUpdateTarget.task_id, status: 'accepted' },
      ),
      (error: unknown) => error instanceof AgentPermissionError,
    )
    const rootAcceptContext = rootContext('run_task_update_accept', 'tool_task_update_accept')
    const rootAccepted = await agentTeamService.updateTask(rootAcceptContext, {
      taskId: taskUpdateTarget.task_id,
      status: 'accepted',
    })
    assert.equal(rootAccepted.status, 'accepted')
    await AgentCommandReceiptModel.updateOne(
      {
        team_id: team.team_id,
        user_id: userId,
        run_id: rootAcceptContext.run_id,
        tool_use_id: rootAcceptContext.tool_use_id,
        command_name: 'TaskUpdate',
      },
      {
        $set: {
          status: 'processing',
          response: null,
          completed_at: null,
          lease_owner_id: 'crashed_task_accept_owner',
          lease_expires_at: new Date(0),
        },
      },
    )
    const recoveredRootAccepted = await agentTeamService.updateTask(rootAcceptContext, {
      taskId: taskUpdateTarget.task_id,
      status: 'accepted',
    })
    assert.equal(recoveredRootAccepted.status, 'accepted')

    const dependencyBlocker = await agentTeamService.assignTask(
      rootContext('run_dependency_blocker', 'tool_dependency_blocker'),
      {
        assignedAgentId: first.agent.agent_id,
        title: 'Dependency blocker',
        objective: 'Remain pending until the dependency scheduler test releases it.',
      },
    )
    const dependencyWaiting = await agentTeamService.assignTask(
      rootContext('run_dependency_waiting', 'tool_dependency_waiting'),
      {
        assignedAgentId: third.agent.agent_id,
        title: 'Dependency waiting task',
        objective: 'Start only after the blocker is accepted.',
        dependencyTaskIds: [dependencyBlocker.task_id],
      },
    )
    assert.equal(await scheduleNextAgentTask({
      teamId: team.team_id,
      userId,
      agentId: third.agent.agent_id,
    }), null)
    const durableDependencyWait = await AgentTaskModel.findOne({
      task_id: dependencyWaiting.task_id,
    }).lean()
    assert.equal(durableDependencyWait?.status, 'waiting')
    assert.equal(durableDependencyWait?.waiting_kind, 'dependencies')
    await AgentTaskModel.updateOne(
      { task_id: dependencyBlocker.task_id },
      { $set: { status: 'accepted', waiting_kind: null, completed_at: new Date() } },
    )
    const dependencyRunId = await scheduleNextAgentTask({
      teamId: team.team_id,
      userId,
      agentId: third.agent.agent_id,
    })
    assert.ok(dependencyRunId, 'dependency waiting must resume after every dependency is accepted')
    const durableDependencyRunning = await AgentTaskModel.findOne({
      task_id: dependencyWaiting.task_id,
    }).lean()
    assert.equal(durableDependencyRunning?.status, 'running')
    assert.equal(durableDependencyRunning?.waiting_kind ?? null, null)
    const cancelledDependencyRun = await agentTeamService.updateTask(
      rootContext('run_cancel_active_task', 'tool_cancel_active_task'),
      { taskId: dependencyWaiting.task_id, status: 'cancelled' },
    )
    assert.equal(cancelledDependencyRun.status, 'cancelled')
    const durableCancelledRun = await agentRunRepository.getAgentRun(dependencyRunId!, userId)
    assert.equal(durableCancelledRun?.status, 'cancelled')
    assert.equal(durableCancelledRun?.cancellation_requested, true,
      'TaskUpdate(cancelled) must propagate to the matching active owner Run')

    const schedulerRaceTask = await agentTeamService.assignTask(
      rootContext('run_scheduler_cas_race_create', 'tool_scheduler_cas_race_create'),
      {
        assignedAgentId: second.agent.agent_id,
        title: 'Scheduler CAS race task',
        objective: 'Cancel during Run creation so stale execution is retired.',
      },
    )
    type MutableTaskModel = {
      updateOne: (
        filter: Record<string, unknown>,
        update: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => Promise<unknown>
    }
    const mutableTaskModel = AgentTaskModel as unknown as MutableTaskModel
    const originalTaskUpdateOne = mutableTaskModel.updateOne.bind(AgentTaskModel)
    let injectedSchedulerRace = false
    mutableTaskModel.updateOne = async (filter, update, options) => {
      const set = (update.$set ?? {}) as Record<string, unknown>
      if (!injectedSchedulerRace
        && filter.task_id === schedulerRaceTask.task_id
        && set.status === 'running') {
        injectedSchedulerRace = true
        await originalTaskUpdateOne(
          { task_id: schedulerRaceTask.task_id },
          { $set: { status: 'cancelled', waiting_kind: null, completed_at: new Date() } },
        )
      }
      return originalTaskUpdateOne(filter, update, options)
    }
    try {
      assert.equal(await scheduleNextAgentTask({
        teamId: team.team_id,
        userId,
        agentId: second.agent.agent_id,
      }), null)
    } finally {
      mutableTaskModel.updateOne = originalTaskUpdateOne
    }
    assert.equal(injectedSchedulerRace, true)
    const retiredSchedulerRaceRun = await AgentRun.findOne({
      team_id: team.team_id,
      task_id: schedulerRaceTask.task_id,
    }).lean()
    assert.equal(retiredSchedulerRaceRun?.status, 'cancelled')
    assert.equal(retiredSchedulerRaceRun?.cancellation_requested, true)
    assert.equal((await AgentTaskModel.findOne({
      task_id: schedulerRaceTask.task_id,
    }).lean())?.status, 'cancelled')

    const reassignedPrivatePath = `${first.agent.private_workspace_prefix}reassignment-context.md`
    const reassignmentTask = await agentTeamService.assignTask(
      rootContext('run_reassignment_acl_create', 'tool_reassignment_acl_create'),
      {
        assignedAgentId: second.agent.agent_id,
        title: 'Reassignment ACL task',
        objective: 'Keep delegated private context readable after owner reassignment.',
        contextRefs: [{
          kind: 'workspace_path',
          value: reassignedPrivatePath,
        }],
      },
    )
    const reassignContext = rootContext('run_reassignment_acl', 'tool_reassignment_acl')
    const reassigned = await agentTeamService.updateTask(reassignContext, {
      taskId: reassignmentTask.task_id,
      ownerAgentId: third.agent.agent_id,
    })
    assert.equal(reassigned.assigned_agent_id, third.agent.agent_id)
    assert.ok((await agentTeamService.getActiveGrant({
      teamId: team.team_id,
      userId,
      agentId: third.agent.agent_id,
    })).allowed_read_paths.includes(reassignedPrivatePath))
    await Promise.all([
      AgentCommandReceiptModel.updateOne(
        {
          team_id: team.team_id,
          user_id: userId,
          run_id: reassignContext.run_id,
          tool_use_id: reassignContext.tool_use_id,
          command_name: 'TaskUpdate',
        },
        {
          $set: {
            status: 'processing',
            response: null,
            completed_at: null,
            lease_owner_id: 'crashed_reassignment_acl_owner',
            lease_expires_at: new Date(0),
          },
        },
      ),
      DelegationGrantModel.updateOne(
        {
          team_id: team.team_id,
          user_id: userId,
          agent_id: third.agent.agent_id,
          active_key: `${team.team_id}:${third.agent.agent_id}`,
        },
        { $pull: { allowed_read_paths: reassignedPrivatePath } },
      ),
    ])
    const recoveredReassignment = await agentTeamService.updateTask(reassignContext, {
      taskId: reassignmentTask.task_id,
      ownerAgentId: third.agent.agent_id,
    })
    assert.equal(recoveredReassignment.assigned_agent_id, third.agent.agent_id)
    assert.ok((await agentTeamService.getActiveGrant({
      teamId: team.team_id,
      userId,
      agentId: third.agent.agent_id,
    })).allowed_read_paths.includes(reassignedPrivatePath),
    'TaskUpdate takeover must replay the new owner private-path grant idempotently')

    const wait = await agentTeamService.createWaitSubscription({
      team_id: team.team_id,
      user_id: userId,
      caller_agent_id: second.agent.agent_id,
      run_id: 'run_wait_second',
      tool_use_id: 'tool_wait_second',
    }, {
      taskIds: [first.task!.task_id],
      mode: 'all',
      timeoutMs: 60_000,
    })
    assert.equal(wait.subscription.status, 'waiting')

    const message = await agentTeamService.sendMessage({
      team_id: team.team_id,
      user_id: userId,
      caller_agent_id: first.agent.agent_id,
      run_id: 'run_message_first',
      tool_use_id: 'tool_message_first',
    }, {
      recipientAgentId: second.agent.agent_id,
      kind: 'request',
      summary: 'Review the evidence table',
      content: 'Please review the evidence table.',
      taskId: first.task!.task_id,
      attachments: [{
        kind: 'workspace_path',
        value: `${first.agent.private_workspace_prefix}evidence.md`,
      }],
    })
    assert.deepEqual(message.wake_agent_ids, [second.agent.agent_id])
    assert.equal(message.message.summary, 'Review the evidence table')
    assert.equal(message.message.sender_name, first.agent.display_name)
    assert.equal(message.message.recipient_name, second.agent.display_name)
    assert.deepEqual(
      message.message.deliveries.map(delivery => [delivery.agent_id, delivery.kind]),
      [
        [second.agent.agent_id, 'primary'],
        [root.agent_id, 'root_observer'],
      ],
    )
    const secondGrantAfterReference = await agentTeamService.getActiveGrant({
      teamId: team.team_id,
      userId,
      agentId: second.agent.agent_id,
    })
    assert.ok(
      secondGrantAfterReference.allowed_read_paths.includes(
        `${first.agent.private_workspace_prefix}evidence.md`,
      ),
      'an exact private path reference must remain readable in later Runs',
    )
    await assert.rejects(
      agentTeamService.sendMessage({
        team_id: team.team_id,
        user_id: userId,
        caller_agent_id: second.agent.agent_id,
        run_id: 'run_message_illegal_path_delegation',
        tool_use_id: 'tool_message_illegal_path_delegation',
      }, {
        recipientAgentId: first.agent.agent_id,
        kind: 'info',
        content: 'This must not delegate a third Agent private path.',
        attachments: [{
          kind: 'workspace_path',
          value: '.sci-pegasus/agents/agent_not_granted/secret.md',
        }],
      }),
      (error: unknown) => error instanceof AgentPermissionError,
    )
    const durableWait = await AgentWaitSubscriptionModel.findOne({ wait_id: wait.subscription.wait_id }).lean()
    assert.equal(durableWait?.status, 'triggered')

    const claimed = await agentTeamService.repository.claimMailboxMessages({
      teamId: team.team_id,
      userId,
      agentId: root.agent_id,
    })
    assert.equal(claimed.messages.length, 1)
    assert.equal(await agentTeamService.repository.acknowledgeMailboxClaim({
      teamId: team.team_id,
      userId,
      agentId: root.agent_id,
      claimId: claimed.claim_id,
    }), 1)
    const persistedMessage = await AgentMailboxMessageModel.findOne({ message_id: message.message.message_id }).lean()
    assert.equal(persistedMessage?.deliveries.find(delivery => delivery.agent_id === root.agent_id)?.status, 'acknowledged')
    const primaryClaim = await agentTeamService.repository.claimMailboxMessages({
      teamId: team.team_id,
      userId,
      agentId: second.agent.agent_id,
    })
    assert.equal(primaryClaim.messages.length, 1)
    assert.equal(await agentTeamService.repository.releaseMailboxClaim({
      teamId: team.team_id,
      userId,
      agentId: second.agent.agent_id,
      claimId: primaryClaim.claim_id,
    }), 1)
    const reclaimedPrimary = await agentTeamService.repository.claimMailboxMessages({
      teamId: team.team_id,
      userId,
      agentId: second.agent.agent_id,
    })
    assert.equal(reclaimedPrimary.messages.length, 1)
    assert.equal(await agentTeamService.repository.acknowledgeMailboxClaim({
      teamId: team.team_id,
      userId,
      agentId: second.agent.agent_id,
      claimId: reclaimedPrimary.claim_id,
    }), 1)

    const hydratedTerminalRace = await hydrateTurnMailboxRouting({
      teamId: team.team_id,
      userId,
      recipientAgentId: second.agent.agent_id,
      sourceMessageIds: [message.message.message_id],
      claimedMessages: [],
    })
    assert.deepEqual(
      hydratedTerminalRace.map(item => item.message_id),
      [message.message.message_id],
      'an acknowledged late message must remain routable from the next Run source id',
    )
    const lateReplyTargets = automaticTurnReplyTargets({
      currentAgentId: second.agent.agent_id,
      rootAgentId: root.agent_id,
      messages: hydratedTerminalRace,
    })
    assert.deepEqual(
      [...lateReplyTargets.entries()],
      [[first.agent.agent_id, message.message.message_id]],
      'the next Run must reply to the actual late-message sender, not fall back to Root',
    )
    const humanReadableReminder = mailboxConversationMessage(
      hydratedTerminalRace[0],
      'run_human_readable_mailbox',
      0,
    )
    assert.match(JSON.stringify(humanReadableReminder.content), /Evidence Scout/)
    assert.match(JSON.stringify(humanReadableReminder.content), /Materials Reviewer/)

    const automaticResponseContext = {
      team_id: team.team_id,
      user_id: userId,
      caller_agent_id: second.agent.agent_id,
      run_id: 'run_automatic_peer_response',
      tool_use_id: 'automatic_turn_delivery_v2_0',
    }
    const automaticResponse = await agentTeamService.sendMessage(automaticResponseContext, {
      recipientAgentId: first.agent.agent_id,
      kind: 'response',
      summary: 'Materials Reviewer completed turn',
      content: 'The late request has now been answered.',
      correlationId: 'result_automatic_peer_response',
      replyToMessageId: message.message.message_id,
      suppressRootObserver: true,
    })
    assert.deepEqual(
      automaticResponse.message.deliveries.map(delivery => [delivery.agent_id, delivery.kind]),
      [[first.agent.agent_id, 'primary']],
      'the separately delivered AgentResult covers Root; peer response must not duplicate the observer copy',
    )
    const replayedAutomaticResponse = await agentTeamService.sendMessage(automaticResponseContext, {
      recipientAgentId: first.agent.agent_id,
      kind: 'response',
      content: 'A replay must not create another mailbox response.',
      suppressRootObserver: true,
    })
    assert.equal(replayedAutomaticResponse.message.message_id, automaticResponse.message.message_id)
    assert.equal(await AgentMailboxMessageModel.countDocuments({
      correlation_id: 'result_automatic_peer_response',
    }), 1)
    assert.deepEqual(
      [...automaticTurnReplyTargets({
        currentAgentId: first.agent.agent_id,
        rootAgentId: root.agent_id,
        messages: [automaticResponse.message],
      }).keys()],
      [root.agent_id],
      'a response notification must not be auto-answered back to its sender',
    )

    const infoWait = await agentTeamService.createWaitSubscription({
      team_id: team.team_id,
      user_id: userId,
      caller_agent_id: third.agent.agent_id,
      run_id: 'run_wait_info_message',
      tool_use_id: 'tool_wait_info_message',
    }, {
      taskIds: [first.task!.task_id],
      mode: 'all',
      timeoutMs: 60_000,
    })
    const informationalWake = await agentTeamService.sendMessage({
      team_id: team.team_id,
      user_id: userId,
      caller_agent_id: first.agent.agent_id,
      run_id: 'run_info_wakes_idle',
      tool_use_id: 'tool_info_wakes_idle',
    }, {
      recipientAgentId: third.agent.agent_id,
      kind: 'info',
      summary: 'New evidence is available',
      content: 'This direct informational message must wake its idle recipient.',
      suppressRootObserver: true,
    })
    assert.deepEqual(informationalWake.wake_agent_ids, [third.agent.agent_id])
    assert.deepEqual(
      informationalWake.message.deliveries.map(delivery => delivery.agent_id),
      [third.agent.agent_id],
      'automatic/runtime-covered messages can suppress a duplicate Root observer delivery',
    )
    assert.equal(
      (await AgentWaitSubscriptionModel.findOne({ wait_id: infoWait.subscription.wait_id }).lean())?.status,
      'triggered',
      'every direct message kind must trigger an idle/waiting recipient',
    )

    const eventsBeforeClaimRace = await agentTeamService.listEventsAfter({
      conversationId,
      userId,
      afterSeq: 0,
    })
    const cursorBeforeClaimRace = eventsBeforeClaimRace.at(-1)!.seq
    await agentTeamService.repository.advanceSupervisionCursor({
      teamId: team.team_id,
      userId,
      throughSeq: cursorBeforeClaimRace,
    })
    const claimedByAnotherSupervisor = await agentTeamService.sendMessage({
      team_id: team.team_id,
      user_id: userId,
      caller_agent_id: first.agent.agent_id,
      run_id: 'run_message_claim_race',
      tool_use_id: 'tool_message_claim_race',
    }, {
      recipientAgentId: second.agent.agent_id,
      kind: 'info',
      content: 'A routine update claimed by another supervisor instance.',
    })
    const rootRaceClaim = await agentTeamService.repository.claimMailboxMessages({
      teamId: team.team_id,
      userId,
      agentId: root.agent_id,
      claimId: 'root_race_claim',
    })
    assert.equal(rootRaceClaim.messages.some(item => (
      item.message_id === claimedByAnotherSupervisor.message.message_id
    )), true)
    const supervisionDueAt = new Date(Date.now() + team.policy.supervision_interval_ms + 1_000)
    await runAgentTeamMaintenanceSweep(supervisionDueAt)
    const cursorWhileClaimed = await agentTeamService.getTeam({ teamId: team.team_id, userId })
    assert.equal(
      cursorWhileClaimed.supervision_cursor,
      cursorBeforeClaimRace,
      'a second supervisor must not skip a mailbox event claimed by another process',
    )
    await AgentMailboxMessageModel.updateOne(
      { message_id: claimedByAnotherSupervisor.message.message_id },
      { $set: { 'deliveries.$[delivery].claimed_at': new Date(0) } },
      { arrayFilters: [{
        'delivery.agent_id': root.agent_id,
        'delivery.status': 'claimed',
        'delivery.claim_id': 'root_race_claim',
      }] },
    )
    const recoveredRootClaim = await agentTeamService.repository.claimMailboxMessages({
      teamId: team.team_id,
      userId,
      agentId: root.agent_id,
      claimId: 'root_recovered_claim',
    })
    assert.equal(recoveredRootClaim.messages.some(item => (
      item.message_id === claimedByAnotherSupervisor.message.message_id
    )), true, 'stale mailbox claims must become claimable again')
    await agentTeamService.repository.acknowledgeMailboxClaim({
      teamId: team.team_id,
      userId,
      agentId: root.agent_id,
      claimId: 'root_recovered_claim',
    })
    await runAgentTeamMaintenanceSweep(supervisionDueAt)
    const cursorAfterAcknowledgement = await agentTeamService.getTeam({ teamId: team.team_id, userId })
    assert.ok(cursorAfterAcknowledgement.supervision_cursor > cursorBeforeClaimRace)

    const observerFullBody = 'Root must not receive this complete peer body in its automatic observer preview.'
    const summarizedPeerMessage = await agentTeamService.sendMessage({
      team_id: team.team_id,
      user_id: userId,
      caller_agent_id: first.agent.agent_id,
      run_id: 'run_summarized_root_observer',
      tool_use_id: 'tool_summarized_root_observer',
    }, {
      recipientAgentId: second.agent.agent_id,
      kind: 'info',
      summary: 'Peer observer preview',
      content: observerFullBody,
    })
    const summarizedObserverDelivery = await deliverRootMailbox(team)
    assert.equal(summarizedObserverDelivery.delivered, 1)
    const observerDeliveryKey = `root-mailbox:${team.team_id}:${summarizedPeerMessage.message.message_id}`
    const observerQueueReceipt = await QueuedMessage.findOne({
      conversation_id: conversationId,
      idempotency_key: observerDeliveryKey,
    }).lean()
    assert.ok(observerQueueReceipt)
    assert.match(observerQueueReceipt!.content, /summary: Peer observer preview/)
    assert.equal(
      observerQueueReceipt!.content.split(observerFullBody).length - 1,
      0,
      'a peer observer notification must not duplicate its authoritative durable body into Root context',
    )
    assert.match(observerQueueReceipt!.content, new RegExp(summarizedPeerMessage.message.message_id))

    const exactRootDelivery = await agentTeamService.sendMessage({
      team_id: team.team_id,
      user_id: userId,
      caller_agent_id: first.agent.agent_id,
      run_id: 'run_exact_root_delivery',
      tool_use_id: 'tool_exact_root_delivery',
    }, {
      recipientAgentId: root.agent_id,
      kind: 'info',
      content: 'This Root delivery must survive an ack crash without duplicate injection.',
    })
    const firstRootDelivery = await deliverRootMailbox(team)
    assert.equal(firstRootDelivery.delivered, 1)
    const exactDeliveryKey = `root-mailbox:${team.team_id}:${exactRootDelivery.message.message_id}`
    const exactQueueReceipt = await QueuedMessage.findOne({
      conversation_id: conversationId,
      idempotency_key: exactDeliveryKey,
    }).lean()
    assert.ok(exactQueueReceipt)
    await AgentMailboxMessageModel.updateOne(
      { message_id: exactRootDelivery.message.message_id },
      {
        $set: {
          'deliveries.$[delivery].status': 'pending',
          'deliveries.$[delivery].claim_id': null,
          'deliveries.$[delivery].claimed_at': null,
          'deliveries.$[delivery].acknowledged_at': null,
        },
      },
      { arrayFilters: [{ 'delivery.agent_id': root.agent_id }] },
    )
    const replayedRootDelivery = await deliverRootMailbox(team)
    assert.equal(replayedRootDelivery.delivered, 1)
    assert.equal(replayedRootDelivery.run_id, firstRootDelivery.run_id)
    assert.equal(await QueuedMessage.countDocuments({
      conversation_id: conversationId,
      idempotency_key: exactDeliveryKey,
    }), 1, 'mailbox replay after downstream injection must reuse one durable queue receipt')

    const leaseOwnerA = 'supervisor_lease_owner_a'
    const leaseA = await agentTeamService.repository.claimSupervisionLease({
      teamId: team.team_id,
      userId,
      ownerId: leaseOwnerA,
    })
    assert.ok(leaseA)
    assert.equal(await agentTeamService.repository.claimSupervisionLease({
      teamId: team.team_id,
      userId,
      ownerId: 'supervisor_lease_owner_b',
    }), null, 'only one process may own a Team supervision lease')
    assert.equal(await agentTeamService.repository.releaseSupervisionLease({
      teamId: team.team_id,
      userId,
      ownerId: leaseOwnerA,
      leaseToken: leaseA!.lease.leaseToken,
    }), true)

    const beforeRoutineEvents = await agentTeamService.listEventsAfter({
      teamId: team.team_id,
      userId,
      afterSeq: 0,
      limit: 1_000,
    })
    const routineBaseline = beforeRoutineEvents.at(-1)!.seq
    await agentTeamService.repository.advanceSupervisionCursor({
      teamId: team.team_id,
      userId,
      throughSeq: routineBaseline,
    })
    await agentTeamService.repository.appendEvent({
      teamId: team.team_id,
      userId,
      type: 'agent_error',
      subjectAgentId: first.agent.agent_id,
      payload: { summary: 'routine supervision dedupe test' },
      dedupeKey: 'routine_supervision_dedupe_test',
    })
    const routineDueAt = new Date(Date.now() + team.policy.supervision_interval_ms + 5_000)
    await Promise.all([
      runAgentTeamMaintenanceSweep(routineDueAt),
      runAgentTeamMaintenanceSweep(routineDueAt),
    ])
    const frozenRoutineBatch = await TeamSupervisionBatchModel.findOne({
      team_id: team.team_id,
      after_seq: routineBaseline,
    }).lean()
    assert.ok(frozenRoutineBatch)
    const routineDeliveryKey = `root-supervision:${team.team_id}:${frozenRoutineBatch!.batch_id}`
    assert.equal(await QueuedMessage.countDocuments({
      conversation_id: conversationId,
      idempotency_key: routineDeliveryKey,
    }), 1, 'concurrent supervisors must inject one deterministic routine reminder')
    await Promise.all([
      AgentTeamModel.updateOne(
        { team_id: team.team_id },
        { $set: { supervision_cursor: routineBaseline } },
      ),
      TeamSupervisionBatchModel.updateOne(
        { batch_id: frozenRoutineBatch!.batch_id },
        { $set: { delivered_at: null, delivered_run_id: null } },
      ),
    ])
    await runAgentTeamMaintenanceSweep(routineDueAt)
    assert.equal(await QueuedMessage.countDocuments({
      conversation_id: conversationId,
      idempotency_key: routineDeliveryKey,
    }), 1, 'takeover after injection but before cursor CAS must replay without duplication')
    assert.ok((await agentTeamService.getTeam({ teamId: team.team_id, userId })).supervision_cursor
      >= frozenRoutineBatch!.through_seq)

    // A Root supervision Run emits execution-slot lifecycle events plus Root's
    // own running/idle transitions. They are audit data, not new information
    // for another model turn. A batch containing only those events must be
    // acknowledged by advancing the cursor without creating/injecting a Run.
    const eventsBeforeFeedbackGuard = await agentTeamService.listEventsAfter({
      teamId: team.team_id,
      userId,
      afterSeq: 0,
      limit: 1_000,
    })
    const feedbackGuardBaseline = eventsBeforeFeedbackGuard.at(-1)!.seq
    await agentTeamService.repository.advanceSupervisionCursor({
      teamId: team.team_id,
      userId,
      throughSeq: feedbackGuardBaseline,
    })
    for (const [index, lifecycle] of ([
      ['execution_slot_claimed', root.agent_id, { execution_slot: 0 }],
      ['agent_status_changed', root.agent_id, { status: 'running' }],
      ['agent_status_changed', root.agent_id, { status: 'idle' }],
      ['execution_slot_released', root.agent_id, { execution_slot: 0 }],
    ] as const).entries()) {
      await agentTeamService.repository.appendEvent({
        teamId: team.team_id,
        userId,
        type: lifecycle[0],
        subjectAgentId: lifecycle[1],
        payload: lifecycle[2],
        dedupeKey: `root_feedback_guard_lifecycle_${index}`,
      })
    }
    const feedbackGuardEvents = await agentTeamService.listEventsAfter({
      teamId: team.team_id,
      userId,
      afterSeq: feedbackGuardBaseline,
    })
    const feedbackGuardBatchId = `team_supervision_batch_${createHash('sha256')
      .update(`${team.team_id}\u0000${feedbackGuardBaseline}`)
      .digest('hex')
      .slice(0, 40)}`
    const feedbackGuardBatchKey = `root-supervision:${team.team_id}:${feedbackGuardBatchId}`
    const feedbackGuardSweep = await runAgentTeamMaintenanceSweep(
      new Date(Date.now() + team.policy.supervision_interval_ms + 10_000),
    )
    assert.equal(feedbackGuardSweep.supervision_runs, 0)
    assert.equal(await QueuedMessage.countDocuments({
      conversation_id: conversationId,
      idempotency_key: feedbackGuardBatchKey,
    }), 0, 'Root runtime lifecycle events must not enqueue another supervision turn')
    assert.ok((await agentTeamService.getTeam({ teamId: team.team_id, userId })).supervision_cursor
      >= feedbackGuardEvents.at(-1)!.seq, 'an ignored-only batch must still advance the cursor')

    // The guard is scoped to Root self-effects. A member status change remains
    // meaningful team state and must still produce one routine supervision
    // delivery.
    const memberStatusBaseline = feedbackGuardEvents.at(-1)!.seq
    await agentTeamService.repository.appendEvent({
      teamId: team.team_id,
      userId,
      type: 'agent_status_changed',
      subjectAgentId: first.agent.agent_id,
      payload: { status: 'failed', reason: 'member regression test' },
      dedupeKey: 'member_status_supervision_feedback_guard',
    })
    const memberStatusBatchId = `team_supervision_batch_${createHash('sha256')
      .update(`${team.team_id}\u0000${memberStatusBaseline}`)
      .digest('hex')
      .slice(0, 40)}`
    const memberStatusBatchKey = `root-supervision:${team.team_id}:${memberStatusBatchId}`
    const memberStatusSweep = await runAgentTeamMaintenanceSweep(
      new Date(Date.now() + team.policy.supervision_interval_ms + 10_000),
    )
    assert.equal(memberStatusSweep.supervision_runs, 1)
    assert.equal(await QueuedMessage.countDocuments({
      conversation_id: conversationId,
      idempotency_key: memberStatusBatchKey,
    }), 1, 'a member status change must still reach Root supervision exactly once')

    const submitted = await agentTeamService.submitResult({
      team_id: team.team_id,
      user_id: userId,
      caller_agent_id: first.agent.agent_id,
      run_id: 'run_submit_first',
      tool_use_id: 'tool_submit_first',
    }, {
      taskId: first.task!.task_id,
      finalResponse: 'The evidence map is complete.',
      summary: { converged: 3, contradicted: 1 },
      files: [{
        source_path: `${first.agent.private_workspace_prefix}evidence.md`,
        suggested_target_path: 'analysis/evidence.md',
        sha256: 'abc123',
      }],
    })
    assert.equal(submitted.result.implicit, false)
    assert.equal(submitted.result.outcome, 'completed')
    assert.equal(submitted.proposals.length, 1)
    assert.equal(submitted.proposals[0].status, 'pending')

    await assert.rejects(
      agentTeamService.reviewResult({
        team_id: team.team_id,
        user_id: userId,
        caller_agent_id: second.agent.agent_id,
        run_id: 'run_illegal_review',
        tool_use_id: 'tool_illegal_review',
      }, {
        resultId: submitted.result.result_id,
        items: [],
        taskDecision: 'rework',
      }),
      (error: unknown) => error instanceof AgentPermissionError,
    )

    const review = await agentTeamService.reviewResult(rootContext('run_review', 'tool_review'), {
      resultId: submitted.result.result_id,
      items: [{
        proposalId: submitted.proposals[0].proposal_id,
        action: 'accept',
        expectedTargetRevision: 0,
      }],
      taskDecision: 'accepted',
    })
    assert.ok(review.task)
    assert.equal(review.task.status, 'submitted', 'task remains unaccepted until approved files publish')
    assert.equal(review.accepted_intents.length, 1)
    assert.equal(review.accepted_intents[0].target_path, 'analysis/evidence.md')
    assert.ok(await agentTeamService.recordWorkspaceProposalOutcome({
      teamId: team.team_id,
      userId,
      proposalId: review.accepted_intents[0].proposal_id,
      status: 'published',
      publishedRevision: 1,
    }))
    const acceptedTask = (await agentTeamService.inspectTeam({ conversationId, userId }))
      .tasks.find(task => task.task_id === first.task!.task_id)
    assert.equal(acceptedTask?.status, 'accepted')

    const tasklessContext = {
      team_id: team.team_id,
      user_id: userId,
      caller_agent_id: second.agent.agent_id,
      run_id: 'run_taskless_turn_result',
      tool_use_id: 'natural_turn_result_v2',
    }
    const tasklessResult = await agentTeamService.submitResult(tasklessContext, {
      finalResponse: 'A conversational follow-up has no formal Task.',
      summary: { automatic_turn_result: true },
      files: [{
        source_path: `${second.agent.private_workspace_prefix}follow-up.md`,
        suggested_target_path: 'output/follow-up.md',
        sha256: 'taskless-sha',
      }],
      implicit: true,
    })
    assert.equal(tasklessResult.result.task_id ?? null, null)
    assert.equal(tasklessResult.proposals[0].task_id ?? null, null)
    const replayedTasklessResult = await agentTeamService.submitResult(tasklessContext, {
      finalResponse: 'A replay payload is ignored by the idempotent command receipt.',
      implicit: true,
    })
    assert.equal(replayedTasklessResult.result.result_id, tasklessResult.result.result_id)
    assert.equal(replayedTasklessResult.proposals[0].proposal_id, tasklessResult.proposals[0].proposal_id)
    const tasklessWorkspaceReview = await agentTeamService.reviewResult(
      rootContext('run_review_taskless_workspace', 'tool_review_taskless_workspace'),
      {
        resultId: tasklessResult.result.result_id,
        items: [{
          proposalId: tasklessResult.proposals[0].proposal_id,
          action: 'reject',
          note: 'Keep this turn private.',
        }],
      },
    )
    assert.equal(tasklessWorkspaceReview.task, undefined)
    assert.equal(tasklessWorkspaceReview.proposals[0].status, 'rejected')

    await assert.rejects(
      agentTeamService.submitResult({
        ...tasklessContext,
        caller_agent_id: first.agent.agent_id,
        run_id: 'run_terminal_followup_rejected',
        tool_use_id: 'terminal_followup_rejected',
      }, {
        taskId: first.task!.task_id,
        finalResponse: 'A legacy explicit submission cannot mutate an accepted Task.',
      }),
      (error: unknown) => error instanceof InvalidAgentTeamOperationError,
    )
    const terminalFollowup = await agentTeamService.submitResult({
      ...tasklessContext,
      caller_agent_id: first.agent.agent_id,
      run_id: 'run_terminal_followup_natural',
      tool_use_id: 'natural_turn_result_v2',
    }, {
      taskId: first.task!.task_id,
      finalResponse: 'The accepted Task remains accepted; this is a taskless follow-up result.',
      implicit: true,
      allowTerminalTaskFallback: true,
    })
    assert.equal(terminalFollowup.result.task_id ?? null, null)
    assert.equal(
      (await AgentTaskModel.findOne({ task_id: first.task!.task_id }).lean())?.status,
      'accepted',
    )

    const reworkTask = await agentTeamService.assignTask(
      rootContext('run_assign_request_changes', 'tool_assign_request_changes'),
      {
        assignedAgentId: first.agent.agent_id,
        title: 'Revise a proposed file',
        objective: 'Exercise request_changes review semantics.',
      },
    )
    const reworkSubmission = await agentTeamService.submitResult({
      team_id: team.team_id,
      user_id: userId,
      caller_agent_id: first.agent.agent_id,
      run_id: 'run_submit_request_changes',
      tool_use_id: 'tool_submit_request_changes',
    }, {
      taskId: reworkTask.task_id,
      finalResponse: 'Draft ready for review.',
      files: [{
        source_path: `${first.agent.private_workspace_prefix}revise-me.md`,
        suggested_target_path: 'analysis/revise-me.md',
      }, {
        source_path: `${first.agent.private_workspace_prefix}late-workspace-review.md`,
        suggested_target_path: 'analysis/late-workspace-review.md',
      }],
    })
    await assert.rejects(
      agentTeamService.reviewResult(
        rootContext('run_invalid_request_changes', 'tool_invalid_request_changes'),
        {
          resultId: reworkSubmission.result.result_id,
          items: [{
            proposalId: reworkSubmission.proposals[0].proposal_id,
            action: 'request_changes',
            note: 'Add provenance.',
          }],
          taskDecision: 'accepted',
        },
      ),
      (error: unknown) => error instanceof InvalidAgentTeamOperationError,
    )
    const requestedChanges = await agentTeamService.reviewResult(
      rootContext('run_request_changes', 'tool_request_changes'),
      {
        resultId: reworkSubmission.result.result_id,
        items: [{
          proposalId: reworkSubmission.proposals[0].proposal_id,
          action: 'request_changes',
          note: 'Add provenance.',
        }],
        taskDecision: 'rework',
      },
    )
    assert.equal(requestedChanges.proposals[0].status, 'rejected')
    assert.ok(requestedChanges.task)
    assert.equal(requestedChanges.task.status, 'rework')
    assert.equal(requestedChanges.accepted_intents.length, 0)

    const replacementSubmission = await agentTeamService.submitResult({
      team_id: team.team_id,
      user_id: userId,
      caller_agent_id: first.agent.agent_id,
      run_id: 'run_submit_replacement_result',
      tool_use_id: 'tool_submit_replacement_result',
    }, {
      taskId: reworkTask.task_id,
      finalResponse: 'Replacement result is now the active submission.',
    })
    const lateWorkspaceOnlyReview = await agentTeamService.reviewResult(
      rootContext('run_late_workspace_only_review', 'tool_late_workspace_only_review'),
      {
        resultId: reworkSubmission.result.result_id,
        items: [{
          proposalId: reworkSubmission.proposals[1].proposal_id,
          action: 'reject',
          note: 'Old result file can be reviewed independently.',
        }],
      },
    )
    assert.equal(lateWorkspaceOnlyReview.proposals[1].status, 'rejected')
    const taskAfterLateWorkspaceReview = await AgentTaskModel.findOne({
      task_id: reworkTask.task_id,
    }).lean()
    assert.equal(taskAfterLateWorkspaceReview?.status, 'submitted')
    assert.equal(taskAfterLateWorkspaceReview?.active_result_id, replacementSubmission.result.result_id)
    await assert.rejects(
      agentTeamService.reviewResult(
        rootContext('run_stale_task_review', 'tool_stale_task_review'),
        {
          resultId: reworkSubmission.result.result_id,
          items: [],
          taskDecision: 'accepted',
        },
      ),
      (error: unknown) => error instanceof InvalidAgentTeamOperationError
        && /stale/i.test(error.message),
    )
    const taskAfterStaleDecision = await AgentTaskModel.findOne({
      task_id: reworkTask.task_id,
    }).lean()
    assert.equal(taskAfterStaleDecision?.status, 'submitted')
    assert.equal(taskAfterStaleDecision?.active_result_id, replacementSubmission.result.result_id)

    const failedTask = await agentTeamService.assignTask(
      rootContext('run_assign_failed_result', 'tool_assign_failed_result'),
      {
        assignedAgentId: second.agent.agent_id,
        title: 'Exercise failed result semantics',
        objective: 'Submit a durable failed outcome for Root review.',
      },
    )
    const failedSubmission = await agentTeamService.submitResult({
      team_id: team.team_id,
      user_id: userId,
      caller_agent_id: second.agent.agent_id,
      run_id: 'run_submit_failed_result',
      tool_use_id: 'tool_submit_failed_result',
    }, {
      taskId: failedTask.task_id,
      outcome: 'failed',
      finalResponse: 'The assigned method cannot satisfy the acceptance criteria.',
    })
    assert.equal(failedSubmission.result.outcome, 'failed')
    const durableFailedTask = (await agentTeamService.inspectTeam({ conversationId, userId }))
      .tasks.find(task => task.task_id === failedTask.task_id)
    assert.equal(durableFailedTask?.status, 'failed')
    await assert.rejects(
      agentTeamService.reviewResult(
        rootContext('run_review_failed_result', 'tool_review_failed_result'),
        {
          resultId: failedSubmission.result.result_id,
          items: [],
          taskDecision: 'rework',
          taskNote: 'Try a different method.',
        },
      ),
      (error: unknown) => error instanceof InvalidAgentTeamOperationError
        && /stale/i.test(error.message),
    )
    assert.equal((await AgentTaskModel.findOne({ task_id: failedTask.task_id }).lean())?.status, 'failed')

    const waitCrashRunId = 'run_wait_crash_after_boundary'
    await agentRunRepository.createAgentRun({
      runId: waitCrashRunId,
      conversationId,
      userId,
      request: { message: 'simulate a resolved wait whose executor crashed after storing the boundary' },
      startedMessageId: 'message_wait_crash_after_boundary',
      teamId: team.team_id,
      agentId: second.agent.agent_id,
      agentSessionId: second.session.session_id,
      rootVisible: false,
      executionMode: 'agent_session',
    })
    await AgentRun.updateOne(
      { run_id: waitCrashRunId },
      { $set: { status: 'waiting_agents' } },
    )
    const crashWindowWait = await agentTeamService.createWaitSubscription({
      team_id: team.team_id,
      user_id: userId,
      caller_agent_id: second.agent.agent_id,
      run_id: waitCrashRunId,
      tool_use_id: 'tool_wait_crash_after_boundary',
    }, {
      taskIds: [first.task!.task_id],
      mode: 'all',
      timeoutMs: 60_000,
    })
    assert.equal(crashWindowWait.subscription.status, 'triggered')
    assert.equal(crashWindowWait.subscription.wake_delivered_at, null)
    await runAgentTeamMaintenanceSweep()
    const resumedAfterCrash = await agentRunRepository.getAgentRun(waitCrashRunId, userId)
    assert.equal(resumedAfterCrash?.status, 'queued')
    assert.equal(
      resumedAfterCrash?.pending_inputs.filter(input => (
        input.message_id === `agent_wait_resolved_${crashWindowWait.subscription.wait_id}`
      )).length,
      1,
    )
    const deliveredWait = await AgentWaitSubscriptionModel.findOne({
      wait_id: crashWindowWait.subscription.wait_id,
    }).lean()
    assert.ok(deliveredWait?.wake_delivered_at)
    await runAgentTeamMaintenanceSweep()
    const repeatedSweepRun = await agentRunRepository.getAgentRun(waitCrashRunId, userId)
    assert.equal(
      repeatedSweepRun?.pending_inputs.filter(input => (
        input.message_id === `agent_wait_resolved_${crashWindowWait.subscription.wait_id}`
      )).length,
      1,
      'repeated maintenance sweeps must not inject the same wait reminder twice',
    )
    await AgentRun.deleteOne({ run_id: waitCrashRunId })

    const fencedControlRunId = 'run_control_fence'
    const fencedControlOwner = 'runner_control_fence'
    await agentRunRepository.createAgentRun({
      runId: fencedControlRunId,
      conversationId,
      userId,
      request: { message: 'exercise control command execution fences' },
      startedMessageId: 'message_control_fence',
      teamId: team.team_id,
      agentId: second.agent.agent_id,
      agentSessionId: second.session.session_id,
      rootVisible: false,
      executionMode: 'agent_session',
    })
    assert.ok(await agentRunRepository.claimAgentRun(fencedControlRunId, fencedControlOwner))
    const controlSlot = await claimExecutionSlot({
      teamId: team.team_id,
      userId,
      agentId: second.agent.agent_id,
      sessionId: second.session.session_id,
      runId: fencedControlRunId,
      ownerId: fencedControlOwner,
    })
    assert.ok(controlSlot)
    const controlSession = await claimAgentSessionRun({
      teamId: team.team_id,
      userId,
      sessionId: second.session.session_id,
      runId: fencedControlRunId,
      ownerId: fencedControlOwner,
    })
    assert.ok(controlSession?.run_lease)
    const fencedMessage = await agentTeamService.sendMessage({
      team_id: team.team_id,
      user_id: userId,
      caller_agent_id: second.agent.agent_id,
      run_id: fencedControlRunId,
      tool_use_id: 'tool_control_fence_valid',
      execution_owner_id: fencedControlOwner,
      agent_session_id: second.session.session_id,
      team_fence_required: true,
      require_execution_fence: true,
    }, {
      recipientAgentId: first.agent.agent_id,
      kind: 'info',
      content: 'This command owns all three required execution fences.',
    })
    assert.equal(fencedMessage.message.sender_agent_id, second.agent.agent_id)
    await assert.rejects(
      agentTeamService.sendMessage({
        team_id: team.team_id,
        user_id: userId,
        caller_agent_id: second.agent.agent_id,
        run_id: fencedControlRunId,
        tool_use_id: 'tool_control_fence_stale',
        execution_owner_id: 'stale_runner_control_fence',
        agent_session_id: second.session.session_id,
        team_fence_required: true,
        require_execution_fence: true,
      }, {
        recipientAgentId: first.agent.agent_id,
        kind: 'info',
        content: 'A stale executor must not create this message.',
      }),
      (error: unknown) => error instanceof AgentControlFenceLostError,
    )

    // Deterministically revoke the parent Run exactly after the command child
    // lease renews but before the final write barrier's second sample. The
    // message mutation must never start under that stale executor.
    const originalRenewCommandLease = agentTeamService.repository.renewCommandLease.bind(
      agentTeamService.repository,
    )
    let revokedAtFinalBarrier = false
    agentTeamService.repository.renewCommandLease = async (lease, leaseMs) => {
      const renewed = await originalRenewCommandLease(lease, leaseMs)
      if (
        renewed
        && !revokedAtFinalBarrier
        && lease.receipt.tool_use_id === 'tool_control_fence_revoked_at_final_barrier'
      ) {
        revokedAtFinalBarrier = true
        assert.equal(await agentRunRepository.setRunStatus(fencedControlRunId, 'completed', {
          terminationReason: 'model_finished',
          releaseActive: true,
          leaseOwnerId: fencedControlOwner,
        }), true)
      }
      return renewed
    }
    try {
      await assert.rejects(
        agentTeamService.sendMessage({
          team_id: team.team_id,
          user_id: userId,
          caller_agent_id: second.agent.agent_id,
          run_id: fencedControlRunId,
          tool_use_id: 'tool_control_fence_revoked_at_final_barrier',
          execution_owner_id: fencedControlOwner,
          agent_session_id: second.session.session_id,
          team_fence_required: true,
          require_execution_fence: true,
        }, {
          recipientAgentId: first.agent.agent_id,
          kind: 'info',
          content: 'This message must not survive final write-fence revocation.',
        }),
        (error: unknown) => error instanceof AgentControlFenceLostError,
      )
    } finally {
      agentTeamService.repository.renewCommandLease = originalRenewCommandLease
    }
    assert.equal(revokedAtFinalBarrier, true)
    assert.equal(await AgentMailboxMessageModel.exists({
      content: 'This message must not survive final write-fence revocation.',
    }), null)
    assert.equal(await releaseAgentSessionRun({
      sessionId: second.session.session_id,
      runId: fencedControlRunId,
      ownerId: fencedControlOwner,
      fenceToken: controlSession!.run_lease!.fence_token,
    }), true)
    assert.equal(await releaseExecutionSlot({
      runId: fencedControlRunId,
      ownerId: fencedControlOwner,
      fenceToken: controlSlot!.fence_token,
    }), true)

    const slot = await claimExecutionSlot({
      teamId: team.team_id,
      userId,
      agentId: second.agent.agent_id,
      sessionId: second.session.session_id,
      runId: 'run_slot',
      ownerId: 'runner_1',
    })
    assert.ok(slot)
    const session = await claimAgentSessionRun({
      teamId: team.team_id,
      userId,
      sessionId: second.session.session_id,
      runId: 'run_slot',
      ownerId: 'runner_1',
    })
    assert.ok(session?.run_lease)
    assert.equal(await claimAgentSessionRun({
      teamId: team.team_id,
      userId,
      sessionId: second.session.session_id,
      runId: 'run_competing',
      ownerId: 'runner_2',
    }), null)
    assert.equal(await heartbeatExecutionSlot({
      runId: 'run_slot',
      ownerId: 'runner_1',
      fenceToken: slot.fence_token,
    }), true)
    assert.equal(await heartbeatAgentSessionRun({
      sessionId: second.session.session_id,
      runId: 'run_slot',
      ownerId: 'runner_1',
      fenceToken: session!.run_lease!.fence_token,
    }), true)
    assert.equal(await releaseAgentSessionRun({
      sessionId: second.session.session_id,
      runId: 'run_slot',
      ownerId: 'runner_1',
      fenceToken: session!.run_lease!.fence_token,
    }), true)
    assert.equal(await releaseExecutionSlot({
      runId: 'run_slot',
      ownerId: 'runner_1',
      fenceToken: slot.fence_token,
    }), true)

    const createdAgents = [first, second, third]
    for (let index = 4; index <= 31; index += 1) {
      createdAgents.push(await agentTeamService.createAgent(
        rootContext(`run_create_${index}`, `tool_create_${index}`),
        { displayName: `Member ${index}`, role: 'Capacity test member' },
      ))
    }
    const snapshot = await agentTeamService.inspectTeam({ conversationId, userId })
    assert.equal(snapshot.counts.total_agents, 32)
    await assert.rejects(
      agentTeamService.createAgent(rootContext('run_create_32', 'tool_create_32'), {
        displayName: 'Member 32',
        role: 'Must exceed identity capacity',
      }),
      (error: unknown) => error instanceof AgentTeamCapacityError,
    )

    const executionLeases = []
    for (let index = 0; index < 8; index += 1) {
      const candidate = createdAgents[index]
      const lease = await claimExecutionSlot({
        teamId: team.team_id,
        userId,
        agentId: candidate.agent.agent_id,
        sessionId: candidate.session.session_id,
        runId: `run_parallel_${index}`,
        ownerId: `runner_parallel_${index}`,
      })
      assert.ok(lease)
      executionLeases.push(lease)
    }
    assert.equal(await claimExecutionSlot({
      teamId: team.team_id,
      userId,
      agentId: createdAgents[8].agent.agent_id,
      sessionId: createdAgents[8].session.session_id,
      runId: 'run_parallel_9',
      ownerId: 'runner_parallel_9',
    }), null)
    for (const lease of executionLeases) {
      await releaseExecutionSlot({
        runId: lease.run_id,
        ownerId: lease.owner_id,
        fenceToken: lease.fence_token,
      })
    }

    await assert.rejects(
      agentTeamService.manageAgent(rootContext('run_root_self_close', 'tool_root_self_close'), {
        agentId: root.agent_id,
        action: 'close',
      }),
      (error: unknown) => error instanceof InvalidAgentTeamOperationError,
    )

    const interruptTask = await agentTeamService.assignTask(
      rootContext('run_assign_interrupt', 'tool_assign_interrupt'),
      {
        assignedAgentId: second.agent.agent_id,
        title: 'Interrupt recovery task',
        objective: 'Verify that an interrupted running task remains schedulable.',
      },
    )
    await AgentTaskModel.updateOne(
      { task_id: interruptTask.task_id },
      { $set: { status: 'running', started_at: new Date() } },
    )
    await agentRunRepository.createAgentRun({
      runId: 'run_interrupt_fence',
      conversationId,
      userId,
      request: { message: 'simulate an actively executing member Run' },
      startedMessageId: 'message_interrupt_fence',
      teamId: team.team_id,
      agentId: second.agent.agent_id,
      agentSessionId: second.session.session_id,
      taskId: interruptTask.task_id,
      rootVisible: false,
      executionMode: 'agent_session',
    })
    assert.ok(await agentRunRepository.claimAgentRun('run_interrupt_fence', 'runner_interrupt_fence'))

    const interruptSlot = await claimExecutionSlot({
      teamId: team.team_id,
      userId,
      agentId: second.agent.agent_id,
      sessionId: second.session.session_id,
      runId: 'run_interrupt_fence',
      ownerId: 'runner_interrupt_fence',
    })
    assert.ok(interruptSlot)
    const interruptSession = await claimAgentSessionRun({
      teamId: team.team_id,
      userId,
      sessionId: second.session.session_id,
      runId: 'run_interrupt_fence',
      ownerId: 'runner_interrupt_fence',
    })
    assert.ok(interruptSession?.run_lease)
    const interrupted = await agentTeamService.manageAgent(rootContext('run_interrupt', 'tool_interrupt'), {
      agentId: second.agent.agent_id,
      action: 'interrupt',
    })
    assert.equal(interrupted.agent.status, 'paused')
    const interruptedTask = (await agentTeamService.inspectTeam({ conversationId, userId }))
      .tasks.find(task => task.task_id === interruptTask.task_id)
    assert.equal(interruptedTask?.status, 'rework')
    const cancelledActiveRun = await agentRunRepository.getAgentRun('run_interrupt_fence', userId)
    assert.equal(cancelledActiveRun?.status, 'running')
    assert.equal(cancelledActiveRun?.cancellation_requested, true)
    assert.equal(await heartbeatExecutionSlot({
      runId: 'run_interrupt_fence',
      ownerId: 'runner_interrupt_fence',
      fenceToken: interruptSlot!.fence_token,
    }), false)
    assert.equal(await heartbeatAgentSessionRun({
      sessionId: second.session.session_id,
      runId: 'run_interrupt_fence',
      ownerId: 'runner_interrupt_fence',
      fenceToken: interruptSession!.run_lease!.fence_token,
    }), false)
    assert.equal(await validateExecutionFence({
      teamId: team.team_id,
      userId,
      agentId: second.agent.agent_id,
      sessionId: second.session.session_id,
      runId: 'run_interrupt_fence',
      ownerId: 'runner_interrupt_fence',
    }), false)
    assert.equal(await claimExecutionSlot({
      teamId: team.team_id,
      userId,
      agentId: second.agent.agent_id,
      sessionId: second.session.session_id,
      runId: 'run_paused_must_not_claim',
      ownerId: 'runner_paused',
    }), null)
    assert.equal(await claimAgentSessionRun({
      teamId: team.team_id,
      userId,
      sessionId: second.session.session_id,
      runId: 'run_paused_must_not_claim',
      ownerId: 'runner_paused',
    }), null)

    const resumed = await agentTeamService.manageAgent(rootContext('run_reopen_paused', 'tool_reopen_paused'), {
      agentId: second.agent.agent_id,
      action: 'reopen',
    })
    assert.equal(resumed.agent.status, 'idle')
    assert.equal(resumed.agent.generation, 2)
    assert.ok(resumed.session)
    await agentRunRepository.createAgentRun({
      runId: 'run_close_fence',
      conversationId,
      userId,
      request: { message: 'simulate a queued member Run closed before execution' },
      startedMessageId: 'message_close_fence',
      teamId: team.team_id,
      agentId: resumed.agent.agent_id,
      agentSessionId: resumed.agent.current_session_id,
      rootVisible: false,
      executionMode: 'agent_session',
    })
    const closeSlot = await claimExecutionSlot({
      teamId: team.team_id,
      userId,
      agentId: resumed.agent.agent_id,
      sessionId: resumed.agent.current_session_id,
      runId: 'run_close_fence',
      ownerId: 'runner_close_fence',
    })
    assert.ok(closeSlot)
    const closeSession = await claimAgentSessionRun({
      teamId: team.team_id,
      userId,
      sessionId: resumed.agent.current_session_id,
      runId: 'run_close_fence',
      ownerId: 'runner_close_fence',
    })
    assert.ok(closeSession?.run_lease)
    const closed = await agentTeamService.manageAgent(rootContext('run_close', 'tool_close'), {
      agentId: second.agent.agent_id,
      action: 'close',
    })
    assert.equal(closed.agent.status, 'completed')
    const cancelledQueuedRun = await agentRunRepository.getAgentRun('run_close_fence', userId)
    assert.equal(cancelledQueuedRun?.status, 'cancelled')
    assert.equal(cancelledQueuedRun?.cancellation_requested, true)
    assert.equal(cancelledQueuedRun?.active_key, undefined)
    assert.equal(await heartbeatExecutionSlot({
      runId: 'run_close_fence',
      ownerId: 'runner_close_fence',
      fenceToken: closeSlot!.fence_token,
    }), false)
    assert.equal(await heartbeatAgentSessionRun({
      sessionId: resumed.agent.current_session_id,
      runId: 'run_close_fence',
      ownerId: 'runner_close_fence',
      fenceToken: closeSession!.run_lease!.fence_token,
    }), false)
    assert.equal(await claimExecutionSlot({
      teamId: team.team_id,
      userId,
      agentId: resumed.agent.agent_id,
      sessionId: resumed.agent.current_session_id,
      runId: 'run_closed_must_not_claim',
      ownerId: 'runner_closed',
    }), null)

    const reopenContext = rootContext('run_reopen', 'tool_reopen')
    const reopened = await agentTeamService.manageAgent(reopenContext, {
      agentId: second.agent.agent_id,
      action: 'reopen',
    })
    assert.equal(reopened.agent.status, 'idle')
    assert.equal(reopened.agent.generation, 3)
    assert.ok(reopened.session)
    await AgentCommandReceiptModel.updateOne(
      {
        team_id: team.team_id,
        user_id: userId,
        run_id: reopenContext.run_id,
        tool_use_id: reopenContext.tool_use_id,
        command_name: 'ManageAgent',
      },
      {
        $set: {
          status: 'processing',
          response: null,
          completed_at: null,
          lease_owner_id: 'crashed_command_owner',
          lease_expires_at: new Date(0),
        },
      },
    )
    const replayedReopen = await agentTeamService.manageAgent(reopenContext, {
      agentId: second.agent.agent_id,
      action: 'reopen',
    })
    assert.equal(replayedReopen.agent.status, 'idle')
    assert.equal(replayedReopen.agent.generation, 3)
    assert.equal(replayedReopen.agent.current_session_id, reopened.agent.current_session_id)

    const expiredCommandLease = await agentTeamService.repository.beginCommand({
      teamId: team.team_id,
      userId,
      actorAgentId: root.agent_id,
      runId: 'run_expired_command_lease',
      toolUseId: 'tool_expired_command_lease',
      commandName: 'ExpiredCommandLeaseTest',
      commandKey: 'expired-command-lease-test',
      reservations: {},
      leaseMs: 1_000,
    })
    await AgentCommandReceiptModel.updateOne(
      { receipt_id: expiredCommandLease.receipt.receipt_id },
      { $set: { lease_expires_at: new Date(0) } },
    )
    assert.equal(
      await agentTeamService.repository.renewCommandLease(expiredCommandLease),
      false,
    )
    await assert.rejects(
      agentTeamService.repository.completeCommand(expiredCommandLease, { should_not_commit: true }),
      (error: unknown) => error instanceof AgentCommandFenceLostError,
    )

    const events = await agentTeamService.listEventsAfter({ conversationId, userId, afterSeq: 0 })
    assert.ok(events.length > 0)
    assert.deepEqual(events.map(event => event.seq), [...events.map(event => event.seq)].sort((a, b) => a - b))
    const cursor = await agentTeamService.repository.advanceSupervisionCursor({
      teamId: team.team_id,
      userId,
      throughSeq: events.at(-1)!.seq,
    })
    assert.equal(cursor?.supervision_cursor, events.at(-1)!.seq)
    const cursorCannotRegress = await agentTeamService.repository.advanceSupervisionCursor({
      teamId: team.team_id,
      userId,
      throughSeq: 1,
    })
    assert.equal(cursorCannotRegress?.supervision_cursor, events.at(-1)!.seq)
    console.log('Agent Team Mongo integration verification passed.')
  } finally {
    await database.dropDatabase()
    await mongoose.disconnect()
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
