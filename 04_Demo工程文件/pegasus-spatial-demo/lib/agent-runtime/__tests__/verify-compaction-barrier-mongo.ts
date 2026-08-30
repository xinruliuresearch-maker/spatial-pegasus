import assert from 'node:assert/strict'

const TEST_DATABASE_SUFFIX = '_test'
const mongoUri = process.env.AGENT_RUNTIME_TEST_MONGODB_URI?.trim()
  || 'mongodb://127.0.0.1:27018/sci_pegasus_compaction_barrier_test'
const databaseName = mongoUri.match(/\/([^/?]+)(?:\?|$)/)?.[1]

if (!databaseName?.endsWith(TEST_DATABASE_SUFFIX)) {
  throw new Error(
    `Refusing to run compaction barrier tests outside an isolated *${TEST_DATABASE_SUFFIX} database.`,
  )
}

process.env.MONGODB_URI = mongoUri

async function main(): Promise<void> {
  const mongoose = (await import('mongoose')).default
  const { connectDB } = await import('../../db/mongodb')
  const { DurableCompactionJobModel } = await import('../../agent-compaction/models')
  const { AgentRun, ConversationRuntime } = await import('../models')
  const repository = await import('../repository')
  const {
    enforceExecutorCompactionBarrier,
    ExecutorCompactionBarrierStoppedError,
    failClosedExecutorCompactionPrepare,
    inspectRunCompactionBarrier,
  } = await import('../compaction-barrier')

  await connectDB()
  const database = mongoose.connection.db
  assert.ok(database, 'MongoDB test connection must expose a database')
  await database.dropDatabase()
  await Promise.all([
    AgentRun.syncIndexes(),
    ConversationRuntime.syncIndexes(),
    DurableCompactionJobModel.syncIndexes(),
  ])

  const userId = 'user_compaction_barrier'

  async function createJob(input: {
    jobId: string
    ownerKey: string
    ownerKind: 'conversation' | 'agent_session'
    conversationId: string
    sessionId?: string
    status: 'queued' | 'retryable' | 'failed'
    active?: boolean
    lastError?: string
    availableAt?: Date
  }): Promise<void> {
    await DurableCompactionJobModel.create({
      job_id: input.jobId,
      owner_key: input.ownerKey,
      owner_kind: input.ownerKind,
      conversation_id: input.conversationId,
      user_id: userId,
      agent_session_id: input.sessionId ?? null,
      source_run_id: null,
      idempotency_key: `trigger_${input.jobId}`,
      idempotency_keys: [`trigger_${input.jobId}`],
      status: input.status,
      ...(input.active ? { active_key: input.ownerKey } : {}),
      frozen_prefix: {
        context_revision: 0,
        prefix_length: 1,
        prefix_hash: `hash_${input.jobId}`,
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: `prefix ${input.jobId}` }],
        }],
      },
      attempt: 0,
      lease: null,
      available_at: input.availableAt ?? null,
      last_error: input.lastError ?? null,
      finished_at: input.status === 'failed' ? new Date() : null,
    })
  }

  try {
    // A live executor may bypass only the exact delayed shadow it just
    // prepared, and only before that shadow's hard-crash deadline. The marker
    // is process-local: recovery calls the same barrier without it below.
    const selfConversationId = 'conv_barrier_self_shadow'
    const selfRun = await repository.createAgentRun({
      runId: 'run_barrier_self_shadow',
      conversationId: selfConversationId,
      userId,
      request: { message: 'continue while my delayed shadow is local' },
      startedMessageId: 'msg_barrier_self_shadow',
    })
    const selfDeadline = new Date(Date.now() + 60_000)
    await createJob({
      jobId: 'cmpjob_barrier_self_shadow',
      ownerKey: `conversation:${selfConversationId}`,
      ownerKind: 'conversation',
      conversationId: selfConversationId,
      status: 'queued',
      active: true,
      availableAt: selfDeadline,
    })
    const selfOwner = 'runner_barrier_self_shadow'
    const leasedSelf = await repository.leaseNextAgentRun(selfOwner, 30_000)
    assert.equal(leasedSelf?.run_id, selfRun.run_id)
    let selfProviderCalls = 0
    await enforceExecutorCompactionBarrier(leasedSelf!, selfOwner, {
      ignoreActiveJobId: 'cmpjob_barrier_self_shadow',
      ignoreActiveJobBefore: selfDeadline,
    })
    selfProviderCalls += 1
    assert.equal(selfProviderCalls, 1, 'the live source Run must not block on its own shadow')

    // Once the local summary has been durably offered, the Job is no longer a
    // delayed queued shadow. Even before the original deadline, the worker may
    // claim/merge it, so the source Run must reload instead of crossing that
    // owner-context swap with stale in-memory messages.
    await DurableCompactionJobModel.updateOne(
      { job_id: 'cmpjob_barrier_self_shadow' },
      { $set: { status: 'summary_ready' } },
    )
    await assert.rejects(
      enforceExecutorCompactionBarrier(leasedSelf!, selfOwner, {
        ignoreActiveJobId: 'cmpjob_barrier_self_shadow',
        ignoreActiveJobBefore: selfDeadline,
      }),
      error => (
        error instanceof ExecutorCompactionBarrierStoppedError
        && error.stop.kind === 'deferred'
      ),
      'a summary-ready Job must not be bypassed by its still-live shadow marker',
    )
    assert.equal(selfProviderCalls, 1, 'no provider call may cross a summary-ready owner barrier')
    assert.equal(
      (await repository.getAgentRun(selfRun.run_id, userId))?.status,
      'queued',
    )
    await DurableCompactionJobModel.updateOne(
      { job_id: 'cmpjob_barrier_self_shadow' },
      {
        $set: { status: 'cancelled', finished_at: new Date() },
        $unset: { active_key: 1 },
      },
    )
    await AgentRun.updateOne(
      { run_id: selfRun.run_id },
      { $set: { status: 'completed', available_at: null } },
    )

    // Root: an active Job returns the exact same Run to the durable queue. Its
    // request/pending input and dispatch retry budget are not duplicated.
    const rootConversationId = 'conv_barrier_root'
    const rootRun = await repository.createAgentRun({
      runId: 'run_barrier_root',
      conversationId: rootConversationId,
      userId,
      request: { message: 'root input must execute once' },
      startedMessageId: 'msg_barrier_root',
    })
    await AgentRun.updateOne({ run_id: rootRun.run_id }, {
      $set: {
        pending_inputs: [{
          message_id: 'msg_barrier_root_pending',
          message: 'persist this follow-up exactly once',
          visibility: 'public',
          source_kind: 'user',
          created_at: new Date('2026-08-10T00:00:00.000Z'),
        }],
      },
    })
    await createJob({
      jobId: 'cmpjob_barrier_root',
      ownerKey: `conversation:${rootConversationId}`,
      ownerKind: 'conversation',
      conversationId: rootConversationId,
      status: 'queued',
      active: true,
    })
    const rootOwner = 'runner_barrier_root'
    const leasedRoot = await repository.leaseNextAgentRun(rootOwner, 30_000)
    assert.equal(leasedRoot?.run_id, rootRun.run_id)
    const rootBarrier = await inspectRunCompactionBarrier(leasedRoot!)
    assert.equal(rootBarrier.kind, 'defer')
    let rootProviderCalls = 0
    await assert.rejects(async () => {
      await enforceExecutorCompactionBarrier(leasedRoot!, rootOwner)
      rootProviderCalls += 1
    }, error => (
      error instanceof ExecutorCompactionBarrierStoppedError
      && error.stop.kind === 'deferred'
      && error.stop.jobId === 'cmpjob_barrier_root'
    ))
    assert.equal(rootProviderCalls, 0, 'executor barrier must stop before the Root provider call')
    const deferredRoot = await repository.getAgentRun(rootRun.run_id, userId)
    assert.equal(deferredRoot?.status, 'queued')
    assert.equal(deferredRoot?.lease, null)
    assert.equal(deferredRoot?.dispatch_attempts, 0)
    assert.equal(deferredRoot?.request.message, 'root input must execute once')
    assert.deepEqual(
      deferredRoot?.pending_inputs.map(input => input.message_id),
      ['msg_barrier_root_pending'],
    )
    assert.ok((deferredRoot?.available_at?.getTime() ?? 0) > Date.now())
    assert.equal(
      (await repository.getConversationRuntime(rootConversationId, userId))
        ?.active_lease_owner_id,
      null,
    )
    assert.equal(
      await repository.leaseNextAgentRun('runner_must_not_hot_loop', 30_000),
      null,
      'future available_at must keep a blocked Run out of the hot lease loop',
    )

    await DurableCompactionJobModel.updateOne(
      { job_id: 'cmpjob_barrier_root' },
      {
        $set: { status: 'merged', finished_at: new Date() },
        $unset: { active_key: 1 },
      },
    )
    await AgentRun.updateOne(
      { run_id: rootRun.run_id },
      { $set: { available_at: new Date(0) } },
    )
    const resumedRoot = await repository.leaseNextAgentRun('runner_barrier_root_resume', 30_000)
    assert.equal(resumedRoot?.run_id, rootRun.run_id)
    assert.equal((await inspectRunCompactionBarrier(resumedRoot!)).kind, 'open')
    assert.equal(await AgentRun.countDocuments({ run_id: rootRun.run_id }), 1)
    assert.deepEqual(
      resumedRoot?.pending_inputs.map(input => input.message_id),
      ['msg_barrier_root_pending'],
      'automatic continuation must not append the saved input a second time',
    )
    assert.equal(await repository.setRunStatus(rootRun.run_id, 'completed', {
      terminationReason: 'model_finished',
      leaseOwnerId: 'runner_barrier_root_resume',
    }), true)

    // A mailbox/context append can win the race after the executor froze its
    // prefix but before it creates the delayed shadow. That stale snapshot is
    // recoverable without a Job: requeue the same Run and rebuild its context.
    const prefixRaceRun = await repository.createAgentRun({
      runId: 'run_barrier_prefix_race',
      conversationId: 'conv_barrier_prefix_race',
      userId,
      request: { message: 'reload after a stale compaction prefix' },
      startedMessageId: 'msg_barrier_prefix_race',
    })
    const prefixRaceOwner = 'runner_barrier_prefix_race'
    const leasedPrefixRace = await repository.leaseNextAgentRun(prefixRaceOwner, 30_000)
    assert.equal(leasedPrefixRace?.run_id, prefixRaceRun.run_id)
    await assert.rejects(
      failClosedExecutorCompactionPrepare(
        leasedPrefixRace!,
        prefixRaceOwner,
        { code: 'COMPACTION_PREFIX_CONFLICT' },
      ),
      error => (
        error instanceof ExecutorCompactionBarrierStoppedError
        && error.stop.kind === 'deferred'
        && error.stop.jobId.includes('prefix-conflict')
      ),
    )
    const deferredPrefixRace = await repository.getAgentRun(prefixRaceRun.run_id, userId)
    assert.equal(deferredPrefixRace?.status, 'queued')
    assert.equal(deferredPrefixRace?.lease, null)
    assert.equal(deferredPrefixRace?.dispatch_attempts, 0)
    assert.equal(await DurableCompactionJobModel.countDocuments({
      conversation_id: 'conv_barrier_prefix_race',
    }), 0, 'prefix-race recovery must not invent a fake durable compaction Job')
    await AgentRun.updateOne(
      { run_id: prefixRaceRun.run_id },
      { $set: { status: 'completed', available_at: null } },
    )

    // Member + merge race: the first read is open; a newly handed-off Job is
    // observed by the pre-dispatch second read, so no model request may start.
    const memberConversationId = 'conv_barrier_member'
    const memberSessionId = 'session_barrier_member'
    const memberRun = await repository.createAgentRun({
      runId: 'run_barrier_member',
      conversationId: memberConversationId,
      userId,
      request: { message: 'member input must wait for merge' },
      startedMessageId: 'msg_barrier_member',
      agentSessionId: memberSessionId,
      executionMode: 'agent_session',
      rootVisible: false,
    })
    const memberOwner = 'runner_barrier_member'
    const leasedMember = await repository.leaseNextAgentRun(memberOwner, 30_000)
    assert.equal(leasedMember?.run_id, memberRun.run_id)
    assert.equal((await inspectRunCompactionBarrier(leasedMember!)).kind, 'open')
    await createJob({
      jobId: 'cmpjob_barrier_member_race',
      ownerKey: `agent_session:${memberSessionId}`,
      ownerKind: 'agent_session',
      conversationId: memberConversationId,
      sessionId: memberSessionId,
      status: 'retryable',
      active: true,
      availableAt: new Date(Date.now() + 60_000),
    })
    const racedMemberBarrier = await inspectRunCompactionBarrier(leasedMember!)
    assert.equal(racedMemberBarrier.kind, 'defer')
    let memberProviderCalls = 0
    await assert.rejects(async () => {
      await enforceExecutorCompactionBarrier(leasedMember!, memberOwner)
      memberProviderCalls += 1
    }, error => (
      error instanceof ExecutorCompactionBarrierStoppedError
      && error.stop.kind === 'deferred'
      && error.stop.jobId === 'cmpjob_barrier_member_race'
    ))
    assert.equal(memberProviderCalls, 0, 'post-dispatch race must make zero member model calls')
    const deferredMember = await repository.getAgentRun(memberRun.run_id, userId)
    assert.equal(deferredMember?.status, 'queued')
    assert.equal(deferredMember?.lease, null)
    assert.equal(deferredMember?.dispatch_attempts, 0)
    await DurableCompactionJobModel.updateOne(
      { job_id: 'cmpjob_barrier_member_race' },
      {
        $set: { status: 'cancelled', finished_at: new Date() },
        $unset: { active_key: 1 },
      },
    )
    await AgentRun.updateOne(
      { run_id: memberRun.run_id },
      { $set: { available_at: new Date(0) } },
    )
    const resumedMember = await repository.leaseNextAgentRun(
      'runner_barrier_member_resume',
      30_000,
    )
    assert.equal(resumedMember?.run_id, memberRun.run_id)
    assert.equal((await inspectRunCompactionBarrier(resumedMember!)).kind, 'open')
    assert.equal(await repository.setRunStatus(memberRun.run_id, 'completed', {
      terminationReason: 'model_finished',
      leaseOwnerId: 'runner_barrier_member_resume',
    }), true)

    // A terminal compaction failure releases the durable barrier. The next
    // Run enters the normal loop admission path, whose W-O check may perform
    // a synchronous full compaction; it must not hot-loop or brick the owner.
    const failedConversationId = 'conv_barrier_failed'
    const failedRun = await repository.createAgentRun({
      runId: 'run_barrier_failed',
      conversationId: failedConversationId,
      userId,
      request: { message: 'do not execute against failed compaction' },
      startedMessageId: 'msg_barrier_failed',
    })
    await createJob({
      jobId: 'cmpjob_barrier_failed',
      ownerKey: `conversation:${failedConversationId}`,
      ownerKind: 'conversation',
      conversationId: failedConversationId,
      status: 'failed',
      lastError: 'merge CAS conflict exhausted',
    })
    const failedOwner = 'runner_barrier_failed'
    const leasedFailed = await repository.leaseNextAgentRun(failedOwner, 30_000)
    assert.equal(leasedFailed?.run_id, failedRun.run_id)
    const failedBarrier = await inspectRunCompactionBarrier(leasedFailed!)
    assert.equal(failedBarrier.kind, 'open')
    if (failedBarrier.kind === 'open') {
      assert.equal(failedBarrier.terminalStatus, 'failed')
      assert.equal(failedBarrier.repairRequired, true)
      assert.match(failedBarrier.terminalError ?? '', /merge CAS conflict exhausted/)
    }
    await enforceExecutorCompactionBarrier(leasedFailed!, failedOwner)
    assert.equal(await repository.setRunStatus(failedRun.run_id, 'completed', {
      terminationReason: 'model_finished',
      leaseOwnerId: failedOwner,
    }), true)
    const terminalFailedJobRun = await repository.getAgentRun(failedRun.run_id, userId)
    assert.equal(terminalFailedJobRun?.status, 'completed')
    assert.equal(
      terminalFailedJobRun?.request.message,
      'do not execute against failed compaction',
    )

    const repairRun = await repository.createAgentRun({
      runId: 'run_barrier_failed_repair',
      conversationId: failedConversationId,
      userId,
      request: { message: 'normal admission owns synchronous repair' },
      startedMessageId: 'msg_barrier_failed_repair',
    })
    const leasedRepair = await repository.leaseNextAgentRun(
      'runner_after_failed_compaction',
      30_000,
    )
    assert.equal(leasedRepair?.run_id, repairRun.run_id)
    const repairBarrier = await inspectRunCompactionBarrier(leasedRepair!)
    assert.equal(repairBarrier.kind, 'open')
    assert.equal(
      repairBarrier.kind === 'open' && repairBarrier.repairRequired,
      true,
      'terminal failure is reported but does not bypass/replace loop admission',
    )
    assert.equal(await repository.setRunStatus(repairRun.run_id, 'completed', {
      terminationReason: 'model_finished',
      leaseOwnerId: 'runner_after_failed_compaction',
    }), true)

    console.log('✓ Durable compaction Run barrier Mongo verification passed')
  } finally {
    await database.dropDatabase()
    await mongoose.disconnect()
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
