import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { ConversationMessage } from '../../types'

const TEST_DATABASE_SUFFIX = '_test'
const mongoUri = process.env.AGENT_MEMBER_RECOVERY_TEST_MONGODB_URI?.trim()
  || 'mongodb://127.0.0.1:27018/sci_pegasus_member_recovery_test'
const databaseName = mongoUri.match(/\/([^/?]+)(?:\?|$)/)?.[1]

function deterministicInternalId(prefix: string, ...parts: string[]): string {
  const digest = createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 40)
  return `${prefix}_${digest}`
}

if (!databaseName?.endsWith(TEST_DATABASE_SUFFIX)) {
  throw new Error(
    `Refusing to run member recovery tests outside an isolated *${TEST_DATABASE_SUFFIX} database.`,
  )
}
process.env.MONGODB_URI = mongoUri
process.env.AGENT_RUNTIME_BACKGROUND_RUNNER = '1'

async function main(): Promise<void> {
  const mongoose = (await import('mongoose')).default
  const { connectDB } = await import('../../db/mongodb')
  const { AgentRun } = await import('../models')
  const runRepository = await import('../repository')
  const { MAX_DISPATCH_ATTEMPTS } = await import('../dispatch-policy')
  const { repairRunnableMemberWork } = await import('../team-recovery')
  const {
    executeMemberAgentRun,
    loadMemberRuntime,
  } = await import('../member-executor')
  const { wakeMemberForMailbox } = await import('../../agent-team/orchestrator')
  const { enqueueMessage } = await import('../../agent/message-queue')
  const { QueuedMessage } = await import('../../db/queue-model')
  const {
    AGENT_TEAM_MODELS,
    AgentCommandReceiptModel,
    AgentMailboxMessageModel,
    AgentResultModel,
    AgentSessionRuntimeModel,
    AgentTaskModel,
    TeamAgentModel,
  } = await import('../../agent-team/models')
  const {
    claimAgentSessionRun,
    claimExecutionSlot,
    releaseAgentSessionRun,
    releaseExecutionSlot,
  } = await import('../../agent-team/repository')
  const { agentTeamService } = await import('../../agent-team/service')

  await connectDB()
  const database = mongoose.connection.db
  assert.ok(database)
  await database.dropDatabase()
  await Promise.all([
    AgentRun.syncIndexes(),
    QueuedMessage.syncIndexes(),
    ...AGENT_TEAM_MODELS.map(model => model.syncIndexes()),
  ])

  const conversationId = 'conversation_member_recovery'
  const userId = 'user_member_recovery'
  try {
    const team = await agentTeamService.ensureTeam({ conversationId, userId })
    const root = await agentTeamService.getAgent({
      teamId: team.team_id,
      userId,
      agentId: team.root_agent_id,
    })
    let command = 0
    const rootContext = () => ({
      team_id: team.team_id,
      user_id: userId,
      caller_agent_id: root.agent_id,
      run_id: `setup_run_${command}`,
      tool_use_id: `setup_tool_${command++}`,
    })

    // A private member Run whose process died is first marked recoverable by
    // the AgentRun sweep and has its Team session released by the lease sweep.
    // The bridge must put that exact Run back on the queue, retaining history
    // identity and its one-active-run key.
    const recovering = await agentTeamService.createAgent(rootContext(), {
      displayName: 'Recovering member',
      role: 'Recover after a lease loss',
      initialTask: {
        title: 'Continue durable task',
        objective: 'Continue from the persisted checkpoint.',
      },
    })
    assert.ok(recovering.task)
    await AgentTaskModel.updateOne(
      { task_id: recovering.task.task_id },
      { $set: { status: 'running' } },
    )
    const recoverableRun = await runRepository.createAgentRun({
      runId: 'run_member_recoverable',
      conversationId,
      userId,
      request: { message: 'resume exact member history' },
      startedMessageId: 'message_member_recoverable',
      teamId: team.team_id,
      agentId: recovering.agent.agent_id,
      agentSessionId: recovering.agent.current_session_id,
      taskId: recovering.task.task_id,
      rootVisible: false,
      executionMode: 'agent_session',
    })
    assert.equal(await runRepository.setRunStatus(
      recoverableRun.run_id,
      'recoverable',
      { onlyIfUnleased: true },
    ), true)

    // A second idle member has a durable queued task but no Run because a
    // process stopped between session release and scheduleNextAgentTask.
    const stranded = await agentTeamService.createAgent(rootContext(), {
      displayName: 'Stranded member',
      role: 'Pick up queued work',
      initialTask: {
        title: 'Queued durable task',
        objective: 'Start after the repair sweep.',
      },
    })
    assert.ok(stranded.task)

    const exhaustedMember = await agentTeamService.createAgent(rootContext(), {
      displayName: 'Dispatch exhausted member',
      role: 'Remain recoverable after bounded dispatch failures',
    })
    const exhaustedRun = await runRepository.createAgentRun({
      runId: 'run_member_dispatch_exhausted',
      conversationId,
      userId,
      request: { message: 'do not hot-loop a rejected dispatch' },
      startedMessageId: 'message_member_dispatch_exhausted',
      teamId: team.team_id,
      agentId: exhaustedMember.agent.agent_id,
      agentSessionId: exhaustedMember.agent.current_session_id,
      rootVisible: false,
      executionMode: 'agent_session',
    })
    assert.equal(await runRepository.setRunStatus(
      exhaustedRun.run_id,
      'recoverable',
      { onlyIfUnleased: true },
    ), true)
    await AgentRun.updateOne(
      { run_id: exhaustedRun.run_id },
      { $set: { dispatch_attempts: MAX_DISPATCH_ATTEMPTS } },
    )

    const mailboxMember = await agentTeamService.createAgent(rootContext(), {
      displayName: 'Mailbox member',
      role: 'Wake from durable request mail',
    })
    const terminalMailboxRun = await runRepository.createAgentRun({
      runId: 'run_member_terminal_mailbox_race',
      conversationId,
      userId,
      request: { message: 'old member Run about to finish' },
      startedMessageId: 'message_member_terminal_mailbox_race',
      teamId: team.team_id,
      agentId: mailboxMember.agent.agent_id,
      agentSessionId: mailboxMember.agent.current_session_id,
      rootVisible: false,
      executionMode: 'agent_session',
    })
    const pendingRequest = await agentTeamService.sendMessage(rootContext(), {
      recipientAgentId: mailboxMember.agent.agent_id,
      kind: 'request',
      content: 'Handle this request after the terminal-race repair sweep.',
    })
    const terminalWakeMessageId = deterministicInternalId(
      'agent_mail_wake',
      team.team_id,
      mailboxMember.agent.agent_id,
      pendingRequest.message.message_id,
    )
    await enqueueMessage(
      conversationId,
      `New request ${pendingRequest.message.message_id}`,
      undefined,
      terminalMailboxRun.run_id,
      {
        visibility: 'internal',
        sourceKind: 'agent',
        idempotencyKey: `member-mail-wake:${team.team_id}:${pendingRequest.message.message_id}:${terminalMailboxRun.run_id}`,
        messageId: terminalWakeMessageId,
      },
    )
    assert.equal(await runRepository.setRunStatus(
      terminalMailboxRun.run_id,
      'completed',
      { releaseActive: true, onlyIfUnleased: true },
    ), true)

    const rootRun = await runRepository.createAgentRun({
      runId: 'run_public_root_recoverable',
      conversationId,
      userId,
      request: { message: 'public Root history' },
      startedMessageId: 'message_public_root_history',
      teamId: team.team_id,
      agentId: root.agent_id,
      agentSessionId: root.current_session_id,
      rootVisible: true,
      executionMode: 'conversation',
    })
    assert.equal(await runRepository.setRunStatus(
      rootRun.run_id,
      'recoverable',
      { onlyIfUnleased: true, incrementRecovery: true },
    ), true)

    const repaired = await repairRunnableMemberWork()
    assert.equal(repaired.root_runs_queued, 1)
    assert.equal(repaired.recoverable_runs_queued, 1)
    assert.equal(repaired.mailbox_agents_woken, 1)
    assert.equal((await runRepository.getAgentRun(recoverableRun.run_id, userId))?.status, 'queued')
    assert.equal(
      (await runRepository.getAgentRun(exhaustedRun.run_id, userId))?.status,
      'recoverable',
      'dispatch exhaustion must not become an automatic hot retry loop',
    )

    const strandedTask = await AgentTaskModel.findOne({ task_id: stranded.task.task_id }).lean()
    assert.equal(strandedTask?.status, 'running')
    const strandedRun = await runRepository.getActiveAgentRunForSession(
      stranded.agent.current_session_id,
      userId,
    )
    assert.equal(strandedRun?.status, 'queued')
    assert.equal(strandedRun?.task_id, stranded.task.task_id)
    const mailboxRun = await runRepository.getActiveAgentRunForSession(
      mailboxMember.agent.current_session_id,
      userId,
    )
    assert.equal(mailboxRun?.status, 'queued')
    assert.equal(mailboxRun?.trigger, 'message')
    assert.equal(mailboxRun?.request.internal?.source_ids?.[0], pendingRequest.message.message_id)
    const supersededTerminalReminder = await QueuedMessage.findOne({
      conversation_id: conversationId,
      message_id: terminalWakeMessageId,
    }).lean()
    assert.equal(supersededTerminalReminder?.status, 'acknowledged')
    assert.equal(supersededTerminalReminder?.target_run_id, mailboxRun?.run_id)
    assert.notEqual(
      supersededTerminalReminder?.target_run_id,
      null,
      'member-only terminal reminders must never become an untargeted Root queue item',
    )
    assert.equal(await QueuedMessage.countDocuments({
      conversation_id: conversationId,
      target_run_id: terminalMailboxRun.run_id,
      status: { $in: ['pending', 'claimed'] },
    }), 0, 'terminal member Runs must not retain a pending targeted reminder after takeover')
    assert.equal((await runRepository.getAgentRun(rootRun.run_id, userId))?.status, 'queued')

    // Replaying the same mailbox wake while a Run is queued/running must use
    // one retained queue receipt rather than append duplicate notices.
    const queuedRequest = await agentTeamService.sendMessage(rootContext(), {
      recipientAgentId: mailboxMember.agent.agent_id,
      kind: 'request',
      content: 'Exercise deterministic queued Run delivery.',
    })
    const queuedDeliveryKey = `member-mail-wake:${team.team_id}:${queuedRequest.message.message_id}:${mailboxRun?.run_id}`
    await Promise.all([
      wakeMemberForMailbox({
        teamId: team.team_id,
        userId,
        agentId: mailboxMember.agent.agent_id,
        messageId: queuedRequest.message.message_id,
        kind: 'request',
      }),
      wakeMemberForMailbox({
        teamId: team.team_id,
        userId,
        agentId: mailboxMember.agent.agent_id,
        messageId: queuedRequest.message.message_id,
        kind: 'request',
      }),
    ])
    assert.equal(await QueuedMessage.countDocuments({ idempotency_key: queuedDeliveryKey }), 1)

    // Waiting-Run wakeups use the same stable downstream message id. A
    // concurrent retry can resume the Run only once and cannot duplicate its
    // pending input.
    assert.equal(await runRepository.setRunStatus(
      mailboxRun!.run_id,
      'waiting_agents',
      { onlyIfUnleased: true },
    ), true)
    const waitingRequest = await agentTeamService.sendMessage(rootContext(), {
      recipientAgentId: mailboxMember.agent.agent_id,
      kind: 'review',
      content: 'Exercise deterministic waiting Run delivery.',
    })
    await Promise.all([
      wakeMemberForMailbox({
        teamId: team.team_id,
        userId,
        agentId: mailboxMember.agent.agent_id,
        messageId: waitingRequest.message.message_id,
        kind: 'review',
      }),
      wakeMemberForMailbox({
        teamId: team.team_id,
        userId,
        agentId: mailboxMember.agent.agent_id,
        messageId: waitingRequest.message.message_id,
        kind: 'review',
      }),
    ])
    await wakeMemberForMailbox({
      teamId: team.team_id,
      userId,
      agentId: mailboxMember.agent.agent_id,
      messageId: waitingRequest.message.message_id,
      kind: 'review',
    })
    const resumedMailboxRun = await runRepository.getAgentRun(mailboxRun!.run_id, userId)
    assert.equal(resumedMailboxRun?.status, 'queued')
    const matchingPendingInputs = resumedMailboxRun?.pending_inputs.filter(input => (
      input.message.includes(waitingRequest.message.message_id)
    )) ?? []
    assert.equal(matchingPendingInputs.length, 1)

    // Private member sequences must never contaminate public Conversation
    // lifecycle or reconnect state.
    assert.equal((await runRepository.getLatestAgentRun(conversationId, userId))?.run_id, rootRun.run_id)
    assert.equal(
      (await runRepository.listLatestAgentRunStatesForUser(userId)).get(conversationId)?.run_id,
      rootRun.run_id,
    )

    // User-facing concurrent-conversation admission counts Root Runs, not the
    // private member queue. A maximal 31-member team must still let its user
    // enqueue a Root correction; the Team slot/budget fences decide when that
    // Root can execute. A second public Root Run remains countable.
    const admissionUserId = 'user_root_admission_isolation'
    await Promise.all(Array.from({ length: 31 }, (_, index) => (
      runRepository.createAgentRun({
        runId: `run_admission_member_${index}`,
        conversationId: 'conversation_root_admission_primary',
        userId: admissionUserId,
        request: { message: `private member ${index}` },
        startedMessageId: `message_admission_member_${index}`,
        teamId: 'team_root_admission',
        agentId: `agent_admission_member_${index}`,
        agentSessionId: `session_admission_member_${index}`,
        rootVisible: false,
        executionMode: 'agent_session',
      })
    )))
    const admissionRoot = await runRepository.createAgentRun({
      runId: 'run_admission_root_primary',
      conversationId: 'conversation_root_admission_primary',
      userId: admissionUserId,
      request: { message: 'Root correction while every member is queued.' },
      startedMessageId: 'message_admission_root_primary',
      rootVisible: true,
      executionMode: 'conversation',
    })
    assert.equal(await runRepository.countActiveAgentRunsForUser(admissionUserId), 1)
    await runRepository.createAgentRun({
      runId: 'run_admission_root_secondary',
      conversationId: 'conversation_root_admission_secondary',
      userId: admissionUserId,
      request: { message: 'A second public Root conversation.' },
      startedMessageId: 'message_admission_root_secondary',
      rootVisible: true,
      executionMode: 'conversation',
    })
    assert.equal(await runRepository.countActiveAgentRunsForUser(admissionUserId), 2)
    assert.equal(
      await runRepository.countActiveAgentRunsForUser(admissionUserId, admissionRoot.run_id),
      1,
    )

    // A scheduler must win queued/rework -> running before its Run is allowed
    // to reach the model. If a process created a stale Run despite losing that
    // Task CAS, the member executor rejects it at runtime hydration.
    const staleTaskMember = await agentTeamService.createAgent(rootContext(), {
      displayName: 'Stale task fence member',
      role: 'Must not execute a task whose scheduler CAS failed',
      initialTask: {
        title: 'Remain queued',
        objective: 'This task deliberately never enters running.',
      },
    })
    assert.ok(staleTaskMember.task)
    assert.equal(staleTaskMember.task.status, 'queued')
    const staleTaskRun = await runRepository.createAgentRun({
      runId: 'run_member_stale_task_fence',
      conversationId,
      userId,
      request: { message: 'This stale Run must stop before any model call.' },
      startedMessageId: 'message_member_stale_task_fence',
      teamId: team.team_id,
      agentId: staleTaskMember.agent.agent_id,
      agentSessionId: staleTaskMember.agent.current_session_id,
      taskId: staleTaskMember.task.task_id,
      rootVisible: false,
      executionMode: 'agent_session',
    })
    await assert.rejects(
      () => loadMemberRuntime(staleTaskRun),
      /stale or cancelled: task .* is not running for this Agent/,
    )

    // Crash window: TaskUpdate(waiting) committed its command receipt and
    // Task state, but the member process stopped before persisting the matching
    // tool_result/checkpoint. Recovery must replay that exact durable tool_use
    // once, preserve manual waiting, and finish cleanly without a model call.
    const waitingRecoveryMember = await agentTeamService.createAgent(rootContext(), {
      displayName: 'Waiting recovery member',
      role: 'Recover a committed TaskUpdate waiting boundary',
      initialTask: {
        title: 'Pause durably',
        objective: 'Enter manual waiting and recover the interrupted result boundary.',
      },
    })
    assert.ok(waitingRecoveryMember.task)
    await AgentTaskModel.updateOne(
      { task_id: waitingRecoveryMember.task.task_id },
      { $set: { status: 'running', waiting_kind: null, started_at: new Date() } },
    )
    const waitingRecoveryRunId = 'run_member_task_update_waiting_recovery'
    const waitingRecoveryToolUseId = 'tool_member_task_update_waiting_recovery'
    const waitingRecoveryInput = {
      task_id: waitingRecoveryMember.task.task_id,
      status: 'waiting',
    }
    const waitingRecoveryRun = await runRepository.createAgentRun({
      runId: waitingRecoveryRunId,
      conversationId,
      userId,
      request: { message: 'Pause this formal Task until a coordinator replies.' },
      startedMessageId: 'message_member_task_update_waiting_recovery',
      teamId: team.team_id,
      agentId: waitingRecoveryMember.agent.agent_id,
      agentSessionId: waitingRecoveryMember.agent.current_session_id,
      taskId: waitingRecoveryMember.task.task_id,
      rootVisible: false,
      executionMode: 'agent_session',
    })
    await AgentSessionRuntimeModel.updateOne(
      { session_id: waitingRecoveryMember.agent.current_session_id },
      {
        $set: {
          messages: [{
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: waitingRecoveryToolUseId,
              name: 'TaskUpdate',
              input: waitingRecoveryInput,
            }],
            timestamp: new Date(),
            message_id: 'message_member_task_update_waiting_tool_use',
            run_id: waitingRecoveryRunId,
            sequence: 0,
            visibility: 'internal',
          }],
          compacted_messages: [],
        },
      },
    )
    await runRepository.setRunCurrentAction(waitingRecoveryRunId, {
      kind: 'tool_call',
      action_id: 'action_member_task_update_waiting_recovery',
      tool_use_id: waitingRecoveryToolUseId,
      tool_name: 'TaskUpdate',
      input_hash: createHash('sha256')
        .update(JSON.stringify(waitingRecoveryInput))
        .digest('hex'),
      attempt: 1,
      started_at: new Date(),
    })
    const committedWaiting = await agentTeamService.updateTask({
      team_id: team.team_id,
      user_id: userId,
      caller_agent_id: waitingRecoveryMember.agent.agent_id,
      run_id: waitingRecoveryRunId,
      tool_use_id: waitingRecoveryToolUseId,
    }, {
      taskId: waitingRecoveryMember.task.task_id,
      status: 'waiting',
    })
    assert.equal(committedWaiting.status, 'waiting')
    assert.equal(committedWaiting.waiting_kind, 'manual')
    assert.equal(await AgentCommandReceiptModel.countDocuments({
      team_id: team.team_id,
      user_id: userId,
      run_id: waitingRecoveryRunId,
      tool_use_id: waitingRecoveryToolUseId,
      command_name: 'TaskUpdate',
      status: 'completed',
    }), 1)

    const waitingRecoveryOwner = 'runner_member_task_update_waiting_recovery'
    const claimedWaitingRecoveryRun = await runRepository.claimAgentRun(
      waitingRecoveryRun.run_id,
      waitingRecoveryOwner,
    )
    assert.ok(claimedWaitingRecoveryRun)
    const waitingRecoverySlot = await claimExecutionSlot({
      teamId: team.team_id,
      userId,
      agentId: waitingRecoveryMember.agent.agent_id,
      sessionId: waitingRecoveryMember.agent.current_session_id,
      runId: waitingRecoveryRunId,
      ownerId: waitingRecoveryOwner,
    })
    assert.ok(waitingRecoverySlot)
    const waitingRecoverySession = await claimAgentSessionRun({
      teamId: team.team_id,
      userId,
      sessionId: waitingRecoveryMember.agent.current_session_id,
      runId: waitingRecoveryRunId,
      ownerId: waitingRecoveryOwner,
    })
    assert.ok(waitingRecoverySession?.run_lease?.fence_token)

    const originalUpdateTask = agentTeamService.updateTask.bind(agentTeamService)
    let recoveryUpdateTaskCalls = 0
    agentTeamService.updateTask = async (...args: Parameters<typeof originalUpdateTask>) => {
      recoveryUpdateTaskCalls += 1
      return originalUpdateTask(...args)
    }
    let waitingRecoveryOutcome
    try {
      waitingRecoveryOutcome = await executeMemberAgentRun({
        run: claimedWaitingRecoveryRun!,
        ownerId: waitingRecoveryOwner,
        executionFenceToken: waitingRecoverySlot!.fence_token,
        sessionFenceToken: waitingRecoverySession!.run_lease!.fence_token,
      })
    } finally {
      agentTeamService.updateTask = originalUpdateTask
    }
    assert.equal(recoveryUpdateTaskCalls, 1, 'the interrupted TaskUpdate must replay exactly once')
    assert.equal(waitingRecoveryOutcome.state, 'completed')
    const recoveredWaitingRun = await runRepository.getAgentRun(waitingRecoveryRunId, userId)
    assert.equal(recoveredWaitingRun?.status, 'completed')
    assert.equal(recoveredWaitingRun?.current_action ?? null, null)
    assert.notEqual(recoveredWaitingRun?.status, 'failed')
    const recoveredWaitingTask = await AgentTaskModel.findOne({
      task_id: waitingRecoveryMember.task.task_id,
    }).lean()
    assert.equal(recoveredWaitingTask?.status, 'waiting')
    assert.equal(recoveredWaitingTask?.waiting_kind, 'manual')
    const recoveredWaitingSession = await AgentSessionRuntimeModel.findOne({
      session_id: waitingRecoveryMember.agent.current_session_id,
    }).lean<{ messages: ConversationMessage[] }>()
    const waitingToolResults = (recoveredWaitingSession?.messages ?? []).flatMap(message => (
      message.content.filter(block => (
        block.type === 'tool_result' && block.tool_use_id === waitingRecoveryToolUseId
      ))
    ))
    assert.equal(waitingToolResults.length, 1)
    await releaseAgentSessionRun({
      sessionId: waitingRecoveryMember.agent.current_session_id,
      runId: waitingRecoveryRunId,
      ownerId: waitingRecoveryOwner,
      fenceToken: waitingRecoverySession!.run_lease!.fence_token,
      nextAgentStatus: 'idle',
    })
    await releaseExecutionSlot({
      runId: waitingRecoveryRunId,
      ownerId: waitingRecoveryOwner,
      fenceToken: waitingRecoverySlot!.fence_token,
    })
    const recoveredWaitingAgent = await TeamAgentModel.findOne({
      agent_id: waitingRecoveryMember.agent.agent_id,
    }).lean()
    assert.equal(recoveredWaitingAgent?.status, 'idle')
    assert.notEqual(recoveredWaitingAgent?.status, 'failed')

    // Upgrade crash window: the retired SubmitAgentResult tool committed its
    // command receipt and moved the Task to submitted, then the process died
    // before its tool_result/checkpoint was durable.  The alias is no longer
    // model-visible, but recovery must validate its historical input contract,
    // authorize it through the member's current canonical TaskUpdate grant,
    // and replay the existing receipt without another result side effect.
    const legacySubmitMember = await agentTeamService.createAgent(rootContext(), {
      displayName: 'Legacy submit recovery member',
      role: 'Recover a retired SubmitAgentResult boundary',
      initialTask: {
        title: 'Submit one legacy result',
        objective: 'Prove a non-running Task can close its exact legacy command boundary.',
      },
    })
    assert.ok(legacySubmitMember.task)
    await AgentTaskModel.updateOne(
      { task_id: legacySubmitMember.task.task_id },
      { $set: { status: 'running', waiting_kind: null, started_at: new Date() } },
    )
    const legacySubmitRunId = 'run_member_legacy_submit_recovery'
    const legacySubmitToolUseId = 'tool_member_legacy_submit_recovery'
    const legacySubmitInput = {
      task_id: legacySubmitMember.task.task_id,
      outcome: 'completed',
      summary: 'Legacy result already committed before restart.',
      findings: [{ finding: 'receipt replay is idempotent' }],
      refs: [],
      proposed_files: [],
    }
    const legacySubmitRun = await runRepository.createAgentRun({
      runId: legacySubmitRunId,
      conversationId,
      userId,
      request: { message: 'Recover the retired result submission boundary.' },
      startedMessageId: 'message_member_legacy_submit_recovery',
      teamId: team.team_id,
      agentId: legacySubmitMember.agent.agent_id,
      agentSessionId: legacySubmitMember.agent.current_session_id,
      taskId: legacySubmitMember.task.task_id,
      rootVisible: false,
      executionMode: 'agent_session',
    })
    await AgentSessionRuntimeModel.updateOne(
      { session_id: legacySubmitMember.agent.current_session_id },
      {
        $set: {
          messages: [{
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: legacySubmitToolUseId,
              name: 'SubmitAgentResult',
              input: legacySubmitInput,
            }],
            timestamp: new Date(),
            message_id: 'message_member_legacy_submit_tool_use',
            run_id: legacySubmitRunId,
            sequence: 0,
            visibility: 'internal',
          }],
          compacted_messages: [],
        },
      },
    )
    await runRepository.setRunCurrentAction(legacySubmitRunId, {
      kind: 'tool_call',
      action_id: 'action_member_legacy_submit_recovery',
      tool_use_id: legacySubmitToolUseId,
      tool_name: 'SubmitAgentResult',
      input_hash: createHash('sha256')
        .update(JSON.stringify(legacySubmitInput))
        .digest('hex'),
      attempt: 1,
      started_at: new Date(),
    })
    const committedLegacySubmit = await agentTeamService.submitResult({
      team_id: team.team_id,
      user_id: userId,
      caller_agent_id: legacySubmitMember.agent.agent_id,
      run_id: legacySubmitRunId,
      tool_use_id: legacySubmitToolUseId,
    }, {
      taskId: legacySubmitMember.task.task_id,
      outcome: 'completed',
      finalResponse: legacySubmitInput.summary,
      summary: {
        outcome: legacySubmitInput.outcome,
        summary: legacySubmitInput.summary,
        findings: legacySubmitInput.findings,
      },
      evidenceRefs: [],
      files: [],
    })
    assert.equal((await AgentTaskModel.findOne({
      task_id: legacySubmitMember.task.task_id,
    }).lean())?.status, 'submitted')
    assert.equal(await AgentResultModel.countDocuments({
      team_id: team.team_id,
      run_id: legacySubmitRunId,
    }), 1)
    assert.equal(await AgentCommandReceiptModel.countDocuments({
      team_id: team.team_id,
      user_id: userId,
      run_id: legacySubmitRunId,
      tool_use_id: legacySubmitToolUseId,
      command_name: 'SubmitAgentResult',
      status: 'completed',
    }), 1)

    const legacySubmitOwner = 'runner_member_legacy_submit_recovery'
    const claimedLegacySubmitRun = await runRepository.claimAgentRun(
      legacySubmitRun.run_id,
      legacySubmitOwner,
    )
    assert.ok(claimedLegacySubmitRun)
    const legacySubmitSlot = await claimExecutionSlot({
      teamId: team.team_id,
      userId,
      agentId: legacySubmitMember.agent.agent_id,
      sessionId: legacySubmitMember.agent.current_session_id,
      runId: legacySubmitRunId,
      ownerId: legacySubmitOwner,
    })
    assert.ok(legacySubmitSlot)
    const legacySubmitSession = await claimAgentSessionRun({
      teamId: team.team_id,
      userId,
      sessionId: legacySubmitMember.agent.current_session_id,
      runId: legacySubmitRunId,
      ownerId: legacySubmitOwner,
    })
    assert.ok(legacySubmitSession?.run_lease?.fence_token)

    const originalSubmitResult = agentTeamService.submitResult.bind(agentTeamService)
    let legacySubmitRecoveryCalls = 0
    agentTeamService.submitResult = async (...args: Parameters<typeof originalSubmitResult>) => {
      legacySubmitRecoveryCalls += 1
      return originalSubmitResult(...args)
    }
    let legacySubmitOutcome
    try {
      legacySubmitOutcome = await executeMemberAgentRun({
        run: claimedLegacySubmitRun!,
        ownerId: legacySubmitOwner,
        executionFenceToken: legacySubmitSlot!.fence_token,
        sessionFenceToken: legacySubmitSession!.run_lease!.fence_token,
      })
    } finally {
      agentTeamService.submitResult = originalSubmitResult
    }
    assert.equal(legacySubmitRecoveryCalls, 1, 'the exact legacy command must enter receipt replay once')
    assert.equal(legacySubmitOutcome.state, 'completed')
    assert.equal((await runRepository.getAgentRun(legacySubmitRunId, userId))?.status, 'completed')
    assert.equal(await AgentResultModel.countDocuments({
      team_id: team.team_id,
      run_id: legacySubmitRunId,
    }), 1, 'legacy receipt replay must not duplicate the immutable result')
    assert.equal(await AgentCommandReceiptModel.countDocuments({
      team_id: team.team_id,
      run_id: legacySubmitRunId,
      tool_use_id: legacySubmitToolUseId,
      command_name: 'SubmitAgentResult',
    }), 1, 'legacy receipt replay must reuse the original command receipt')
    const recoveredLegacySubmitSession = await AgentSessionRuntimeModel.findOne({
      session_id: legacySubmitMember.agent.current_session_id,
    }).lean<{ messages: ConversationMessage[] }>()
    assert.equal((recoveredLegacySubmitSession?.messages ?? []).flatMap(message => (
      message.content.filter(block => (
        block.type === 'tool_result' && block.tool_use_id === legacySubmitToolUseId
      ))
    )).length, 1)
    assert.equal(committedLegacySubmit.result.result_id, (
      await AgentResultModel.findOne({ run_id: legacySubmitRunId }).lean()
    )?.result_id)
    await releaseAgentSessionRun({
      sessionId: legacySubmitMember.agent.current_session_id,
      runId: legacySubmitRunId,
      ownerId: legacySubmitOwner,
      fenceToken: legacySubmitSession!.run_lease!.fence_token,
      nextAgentStatus: 'idle',
    })
    await releaseExecutionSlot({
      runId: legacySubmitRunId,
      ownerId: legacySubmitOwner,
      fenceToken: legacySubmitSlot!.fence_token,
    })

    // Merely finding an old assistant Team tool_use on a cancelled Task is
    // insufficient authority to execute it for the first time. Without the
    // base command receipt, stale recovery must retain the strict rejection
    // path and produce no new mailbox side effect.
    const cancelledToolMember = await agentTeamService.createAgent(rootContext(), {
      displayName: 'Cancelled tool fence member',
      role: 'Must not execute an unstarted tool after cancellation',
      initialTask: {
        title: 'Cancelled before tool start',
        objective: 'Prove a stale persisted tool_use alone is not replay authority.',
      },
    })
    assert.ok(cancelledToolMember.task)
    await AgentTaskModel.updateOne(
      { task_id: cancelledToolMember.task.task_id },
      { $set: { status: 'cancelled', waiting_kind: null, completed_at: new Date() } },
    )
    const cancelledToolRunId = 'run_member_cancelled_unstarted_team_tool'
    const cancelledToolUseId = 'tool_member_cancelled_unstarted_team_tool'
    const cancelledToolInput = {
      to: root.display_name,
      message: 'This stale message must never be sent.',
      summary: 'Forbidden stale side effect',
    }
    const cancelledToolRun = await runRepository.createAgentRun({
      runId: cancelledToolRunId,
      conversationId,
      userId,
      request: { message: 'This cancelled Run must not execute its old tool_use.' },
      startedMessageId: 'message_member_cancelled_unstarted_team_tool',
      teamId: team.team_id,
      agentId: cancelledToolMember.agent.agent_id,
      agentSessionId: cancelledToolMember.agent.current_session_id,
      taskId: cancelledToolMember.task.task_id,
      rootVisible: false,
      executionMode: 'agent_session',
    })
    await AgentSessionRuntimeModel.updateOne(
      { session_id: cancelledToolMember.agent.current_session_id },
      {
        $set: {
          messages: [{
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: cancelledToolUseId,
              name: 'SendMessage',
              input: cancelledToolInput,
            }],
            timestamp: new Date(),
            message_id: 'message_member_cancelled_unstarted_tool_use',
            run_id: cancelledToolRunId,
            sequence: 0,
            visibility: 'internal',
          }],
          compacted_messages: [],
        },
      },
    )
    await runRepository.setRunCurrentAction(cancelledToolRunId, {
      kind: 'tool_call',
      action_id: 'action_member_cancelled_unstarted_team_tool',
      tool_use_id: cancelledToolUseId,
      tool_name: 'SendMessage',
      input_hash: createHash('sha256')
        .update(JSON.stringify(cancelledToolInput))
        .digest('hex'),
      attempt: 1,
      started_at: new Date(),
    })
    const cancelledToolOwner = 'runner_member_cancelled_unstarted_team_tool'
    const claimedCancelledToolRun = await runRepository.claimAgentRun(
      cancelledToolRun.run_id,
      cancelledToolOwner,
    )
    assert.ok(claimedCancelledToolRun)
    const cancelledToolSlot = await claimExecutionSlot({
      teamId: team.team_id,
      userId,
      agentId: cancelledToolMember.agent.agent_id,
      sessionId: cancelledToolMember.agent.current_session_id,
      runId: cancelledToolRunId,
      ownerId: cancelledToolOwner,
    })
    assert.ok(cancelledToolSlot)
    const cancelledToolSession = await claimAgentSessionRun({
      teamId: team.team_id,
      userId,
      sessionId: cancelledToolMember.agent.current_session_id,
      runId: cancelledToolRunId,
      ownerId: cancelledToolOwner,
    })
    assert.ok(cancelledToolSession?.run_lease?.fence_token)
    const staleMessagesBefore = await AgentMailboxMessageModel.countDocuments({
      team_id: team.team_id,
      sender_agent_id: cancelledToolMember.agent.agent_id,
    })
    const cancelledToolOutcome = await executeMemberAgentRun({
      run: claimedCancelledToolRun!,
      ownerId: cancelledToolOwner,
      executionFenceToken: cancelledToolSlot!.fence_token,
      sessionFenceToken: cancelledToolSession!.run_lease!.fence_token,
    })
    assert.equal(cancelledToolOutcome.state, 'failed')
    assert.equal(await AgentMailboxMessageModel.countDocuments({
      team_id: team.team_id,
      sender_agent_id: cancelledToolMember.agent.agent_id,
    }), staleMessagesBefore)
    assert.equal(await AgentCommandReceiptModel.countDocuments({
      team_id: team.team_id,
      run_id: cancelledToolRunId,
      tool_use_id: cancelledToolUseId,
    }), 0)
    await releaseAgentSessionRun({
      sessionId: cancelledToolMember.agent.current_session_id,
      runId: cancelledToolRunId,
      ownerId: cancelledToolOwner,
      fenceToken: cancelledToolSession!.run_lease!.fence_token,
      nextAgentStatus: 'failed',
    })
    await releaseExecutionSlot({
      runId: cancelledToolRunId,
      ownerId: cancelledToolOwner,
      fenceToken: cancelledToolSlot!.fence_token,
    })

    console.log('✓ Member Run recovery and public lifecycle isolation verification passed')
  } finally {
    await database.dropDatabase()
    await mongoose.disconnect()
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
