import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { ConversationMessage } from '../../types'

const TEST_DATABASE_SUFFIX = '_test'
const mongoUri = process.env.AGENT_COMPACTION_TEST_MONGODB_URI?.trim()
  || 'mongodb://127.0.0.1:27018/sci_pegasus_agent_compaction_test'
const databaseName = mongoUri.match(/\/([^/?]+)(?:\?|$)/)?.[1]
if (!databaseName?.endsWith(TEST_DATABASE_SUFFIX)) {
  throw new Error(`Refusing to run compaction tests outside an isolated *${TEST_DATABASE_SUFFIX} database.`)
}
process.env.MONGODB_URI = mongoUri

function message(id: string, text: string): ConversationMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    message_id: id,
    timestamp: new Date(`2026-08-10T00:00:${id.slice(-2).padStart(2, '0')}.000Z`),
  }
}

async function main(): Promise<void> {
  const mongoose = (await import('mongoose')).default
  const { connectDB } = await import('../../db/mongodb')
  const { Conversation } = await import('../../db/models')
  const { appendConversationMessages } = await import('../../db/repository')
  const { ConversationRuntime } = await import('../../agent-runtime/models')
  const { AgentSessionRuntimeModel, AgentTeamModel } = await import('../../agent-team/models')
  const {
    MultiAgentWorkspaceRepository,
    WorkspaceCapacity,
    WorkspaceFile,
    WorkspaceFileRevision,
  } = await import('../../workspace/multi-agent')
  const { DurableCompactionJobModel } = await import('../models')
  const repository = await import('../repository')
  const { buildDefaultDurableReplacement, processClaimedCompactionJob } = await import('../service')

  await connectDB()
  const database = mongoose.connection.db
  assert.ok(database)
  await database.dropDatabase()
  await Promise.all([
    Conversation.syncIndexes(),
    ConversationRuntime.syncIndexes(),
    AgentSessionRuntimeModel.syncIndexes(),
    AgentTeamModel.syncIndexes(),
    DurableCompactionJobModel.syncIndexes(),
    WorkspaceCapacity.syncIndexes(),
    WorkspaceFile.syncIndexes(),
    WorkspaceFileRevision.syncIndexes(),
  ])

  const userId = 'user_compaction'
  const conversationId = 'conversation_compaction'
  const initial = [message('msg_01', 'one'), message('msg_02', 'two'), message('msg_03', 'three')]
  await Conversation.create({
    conversation_id: conversationId,
    user_id: userId,
    title: 'durable compaction test',
    settings: { orchestrator_model: 'test-model' },
    messages: initial,
    compacted_messages: [],
    context_revision: 0,
  })
  const snapshotAt = (epoch: number) => ({
    epoch,
    template_id: 'materials-discovery',
    version: 1,
    guide_title: `Guide ${epoch}`,
    compiled_guide: `guide epoch ${epoch}`,
    guide_hash: `guide_hash_${epoch}`,
    workspace_projection: {
      version: 1,
      content: `workspace epoch ${epoch}`,
      files_hash: `files_hash_${epoch}`,
      generated_at: new Date(),
    },
  })
  await ConversationRuntime.create({
    conversation_id: conversationId,
    user_id: userId,
    revision: 0,
    hippocampus: {
      snapshot_version: 1,
      telemetry: null,
      breaker_state: {
        consecutiveFailures: 2,
        rapidRefills: 2,
        turnsSinceMerge: 5,
        breaker: 'consecutive_failures',
      },
      rapid_refills: 2,
      turns_since_merge: 5,
      active_compaction: { compaction_id: 'legacy_checkpoint' },
    },
    project_context_snapshot: snapshotAt(7),
  })
  const teamId = 'team_compaction'
  const rootAgentId = 'root_compaction'
  const workspaceId = 'workspace_compaction'
  await AgentTeamModel.create({
    team_id: teamId,
    conversation_id: conversationId,
    user_id: userId,
    root_agent_id: rootAgentId,
    workspace_id: workspaceId,
    status: 'active',
    policy: {},
    next_event_seq: 0,
    supervision_cursor: 0,
  })
  const workspaceRepository = new MultiAgentWorkspaceRepository({
    fenceValidator: () => true,
  })
  const rootActor = {
    teamId,
    agentId: rootAgentId,
    rootAgentId,
    role: 'root' as const,
  }
  const commitPublic = async (path: string, content: string, runId: string) => (
    workspaceRepository.commitFile(rootActor, {
      workspaceId,
      path,
      expectedRevision: null,
      visibility: 'public',
      storageRef: { driver: 'gridfs', object_id: `gridfs_${runId}` },
      metadata: {
        kind: 'text',
        mime_type: 'text/markdown',
        size_bytes: Buffer.byteLength(content),
        sha256: createHash('sha256').update(content).digest('hex'),
      },
      writer: {
        team_id: teamId,
        agent_id: rootAgentId,
        run_id: runId,
        execution_fence_token: `fence_${runId}`,
      },
    })
  )
  const owner = { kind: 'conversation' as const, conversationId, userId }

  // Same command replay and different concurrent triggers converge on exactly
  // one active context Job.
  const enqueued = await Promise.all(Array.from({ length: 12 }, (_, index) => (
    repository.enqueueDurableCompaction({
      owner,
      idempotencyKey: index < 6 ? 'root_handoff' : `racing_trigger_${index}`,
      sourceRunId: 'run_root',
      prefixMessages: initial,
      projectContextSnapshot: snapshotAt(7),
    })
  )))
  assert.equal(new Set(enqueued.map(job => job.job_id)).size, 1)
  assert.equal(await DurableCompactionJobModel.countDocuments({ active_key: `conversation:${conversationId}` }), 1)

  const alpha = await repository.claimNextCompactionJob('worker_alpha', 120_000)
  assert.ok(alpha)
  assert.equal(await repository.establishContextCompactionFence(alpha), true)
  assert.equal(await repository.beginCompactionSummary(alpha), true)
  assert.equal(await repository.saveCompactionSummary(alpha, 'the durable root summary'), true)
  // This file was published after the trigger snapshot. The durable worker
  // must capture canonical heads at merge preparation, not permanently reuse
  // the old projection handed off by the Run.
  await commitPublic(
    'analysis/root-merge-time.md',
    'published after summary trigger',
    'root_merge_time',
  )
  const ready = await repository.prepareDurableMergeContext(alpha)
  assert.ok(ready)
  assert.equal(ready.merge_project_context_snapshot?.epoch, 8)
  assert.match(ready.merge_workspace_projection?.content ?? '', /root-merge-time\.md/)
  assert.notEqual(
    ready.merge_workspace_projection?.files_hash,
    ready.workspace_projection?.files_hash,
  )
  const replacement = await buildDefaultDurableReplacement(ready, ready.summary!)
  assert.match(JSON.stringify(replacement), /root-merge-time\.md/)
  assert.equal(await repository.prepareCompactionMerge(alpha, replacement), true)

  // A later file is intentionally outside this frozen merge epoch. Crash
  // retries must reuse the persisted projection/replacement rather than drift.
  await commitPublic(
    'analysis/after-merge-freeze.md',
    'must appear only in a later prompt epoch',
    'after_merge_freeze',
  )
  const frozenMergeContext = await repository.prepareDurableMergeContext(alpha)
  assert.equal(
    frozenMergeContext?.merge_workspace_projection?.files_hash,
    ready.merge_workspace_projection?.files_hash,
  )
  assert.doesNotMatch(
    frozenMergeContext?.merge_workspace_projection?.content ?? '',
    /after-merge-freeze/,
  )

  // A user/team message arriving while summary generation is in flight remains
  // verbatim after the replacement.
  const tail = message('msg_04', 'arrived while compaction continued after loop exit')
  await appendConversationMessages(conversationId, userId, [tail], false)
  const phaseOne = await repository.applyPreparedMergeToOwner(alpha)
  assert.equal(phaseOne.outcome, 'merged')
  const afterOwnerSwap = await Conversation.findOne({ conversation_id: conversationId }).lean<{
    messages: ConversationMessage[]
    compacted_messages: ConversationMessage[]
    context_revision: number
    last_applied_compaction_id: string
    compaction_count: number
  }>()
  assert.ok(afterOwnerSwap)
  assert.deepEqual(afterOwnerSwap.messages.map(item => item.message_id), ['msg_01', 'msg_02', 'msg_03', 'msg_04'])
  assert.equal(afterOwnerSwap.compacted_messages.length, 2)
  assert.equal(afterOwnerSwap.compacted_messages[0].message_id, replacement.message_id)
  assert.equal(afterOwnerSwap.compacted_messages[1].message_id, tail.message_id)
  assert.equal(afterOwnerSwap.last_applied_compaction_id, alpha.job.job_id)
  assert.equal(afterOwnerSwap.compaction_count, 1)
  // Simulate a newer prompt epoch appearing before runtime settlement. The
  // compaction replacement retains its frozen epoch, but settlement must not
  // roll the Runtime itself backwards.
  await ConversationRuntime.updateOne(
    { conversation_id: conversationId },
    { $set: { project_context_snapshot: snapshotAt(8) } },
  )

  // Crash window 1: owner CAS committed, runtime settlement did not.
  await DurableCompactionJobModel.updateOne(
    { job_id: alpha.job.job_id },
    { $set: { 'lease.expires_at': new Date(0) } },
  )
  const beta = await repository.claimNextCompactionJob('worker_beta', 120_000)
  assert.ok(beta)
  assert.equal(beta.job.job_id, alpha.job.job_id)
  assert.equal(await repository.establishContextCompactionFence(beta), true)
  const staleFinalize = await repository.finalizeAppliedCompactionJob(alpha)
  assert.equal(staleFinalize.outcome, 'lost_lease', 'expired executor must not finalize takeover work')
  assert.equal(await repository.settleAppliedCompactionRuntime(beta), true)
  const settledJob = await repository.getDurableCompactionJob(alpha.job.job_id)
  assert.ok(settledJob?.runtime_settled_at)
  assert.equal(settledJob?.status, 'merge_prepared')
  const settledRuntime = await ConversationRuntime.findOne({
    conversation_id: conversationId,
  }).lean<{
    project_context_snapshot: { epoch: number }
    hippocampus: {
      active_compaction?: unknown
      last_settled_compaction_id?: string
      rapid_refills: number
      turns_since_merge: number
      breaker_state: { consecutiveFailures: number; rapidRefills: number; turnsSinceMerge: number }
    }
  }>()
  assert.equal(settledRuntime?.project_context_snapshot.epoch, 8)
  assert.equal(settledRuntime?.hippocampus.last_settled_compaction_id, alpha.job.job_id)
  assert.equal(settledRuntime?.hippocampus.active_compaction, undefined)
  assert.equal(settledRuntime?.hippocampus.rapid_refills, 0)
  assert.equal(settledRuntime?.hippocampus.turns_since_merge, 0)
  assert.equal(settledRuntime?.hippocampus.breaker_state.consecutiveFailures, 0)

  // Crash window 2: runtime settlement committed, Job finalization did not.
  await DurableCompactionJobModel.updateOne(
    { job_id: alpha.job.job_id },
    { $set: { 'lease.expires_at': new Date(0) } },
  )
  await Conversation.updateOne(
    { conversation_id: conversationId },
    { $set: { 'context_compaction_fence.expires_at': new Date(0) } },
  )
  const gamma = await repository.claimNextCompactionJob('worker_gamma', 120_000)
  assert.ok(gamma)
  assert.equal(gamma.job.job_id, alpha.job.job_id)
  assert.equal(await repository.establishContextCompactionFence(gamma), true)
  assert.equal(await repository.settleAppliedCompactionRuntime(gamma), true)
  const staleBetaFinalize = await repository.finalizeAppliedCompactionJob(beta)
  assert.equal(staleBetaFinalize.outcome, 'lost_lease')
  const recovered = await repository.finalizeAppliedCompactionJob(gamma)
  assert.equal(recovered.outcome, 'merged')
  const mergedJob = await repository.getDurableCompactionJob(alpha.job.job_id)
  assert.equal(mergedJob?.status, 'merged')
  assert.equal(mergedJob?.active_key, undefined)
  const recoveredOwner = await Conversation.findOne({ conversation_id: conversationId }).lean<{
    context_compaction_fence?: unknown
    compacted_messages: ConversationMessage[]
    compaction_count: number
  }>()
  assert.equal(recoveredOwner?.context_compaction_fence, null)
  assert.equal(recoveredOwner?.compaction_count, 1, 'crash convergence must not apply twice')
  assert.equal(recoveredOwner?.compacted_messages[1].message_id, 'msg_04')

  const replay = await repository.enqueueDurableCompaction({
    owner,
    idempotencyKey: 'root_handoff',
    sourceRunId: 'run_root',
  })
  assert.equal(replay.job_id, mergedJob?.job_id)
  assert.equal(replay.status, 'merged')

  // Lease takeover fences stale summary writers before an owner mutation.
  const staleConversationId = 'conversation_stale_fence'
  await Conversation.create({
    conversation_id: staleConversationId,
    user_id: userId,
    settings: { orchestrator_model: 'test-model' },
    messages: [message('stale_01', 'stale fence')],
    compacted_messages: [],
  })
  const staleJob = await repository.enqueueDurableCompaction({
    owner: { kind: 'conversation', conversationId: staleConversationId, userId },
    idempotencyKey: 'stale_fence',
  })
  const staleAlpha = await repository.claimNextCompactionJob('stale_alpha', 120_000)
  assert.equal(staleAlpha?.job.job_id, staleJob.job_id)
  assert.ok(staleAlpha)
  assert.equal(await repository.establishContextCompactionFence(staleAlpha), true)
  await DurableCompactionJobModel.updateOne(
    { job_id: staleJob.job_id },
    { $set: { 'lease.expires_at': new Date(0) } },
  )
  await Conversation.updateOne(
    { conversation_id: staleConversationId },
    { $set: { 'context_compaction_fence.expires_at': new Date(0) } },
  )
  const staleBeta = await repository.claimNextCompactionJob('stale_beta', 120_000)
  assert.ok(staleBeta)
  assert.equal(await repository.establishContextCompactionFence(staleBeta), true)
  assert.equal(await repository.beginCompactionSummary(staleAlpha), false)
  assert.equal(await repository.beginCompactionSummary(staleBeta), true)
  assert.equal(await repository.failCompactionJob(staleBeta, 'end stale-fence fixture'), true)

  // A retry released after merge preparation resumes that exact persisted
  // replacement instead of re-summarizing or getting stuck in retryable.
  const retryConversationId = 'conversation_prepared_retry'
  await Conversation.create({
    conversation_id: retryConversationId,
    user_id: userId,
    settings: { orchestrator_model: 'test-model' },
    messages: [message('retry_01', 'prepared retry')],
    compacted_messages: [],
  })
  const retryJob = await repository.enqueueDurableCompaction({
    owner: { kind: 'conversation', conversationId: retryConversationId, userId },
    idempotencyKey: 'prepared_retry',
  })
  const retryAlpha = await repository.claimNextCompactionJob('retry_alpha', 120_000)
  assert.equal(retryAlpha?.job.job_id, retryJob.job_id)
  assert.ok(retryAlpha)
  assert.equal(await repository.establishContextCompactionFence(retryAlpha), true)
  assert.equal(await repository.beginCompactionSummary(retryAlpha), true)
  assert.equal(await repository.saveCompactionSummary(retryAlpha, 'prepared retry summary'), true)
  const retryReady = await repository.getDurableCompactionJob(retryJob.job_id)
  assert.ok(retryReady)
  const retryReplacement = await buildDefaultDurableReplacement(retryReady, retryReady.summary!)
  assert.equal(await repository.prepareCompactionMerge(retryAlpha, retryReplacement), true)
  assert.equal(await repository.releaseCompactionForRetry(retryAlpha, 'simulated post-prepare crash', 0), true)
  const retryBeta = await repository.claimNextCompactionJob('retry_beta', 120_000)
  assert.ok(retryBeta)
  let unexpectedSummaryCall = false
  const retryResult = await processClaimedCompactionJob(retryBeta, {
    async summarize() {
      unexpectedSummaryCall = true
      return { summary: 'must not run' }
    },
  })
  assert.equal(retryResult.outcome, 'merged')
  assert.equal(unexpectedSummaryCall, false)
  const retryAfter = await Conversation.findOne({ conversation_id: retryConversationId }).lean<{
    compacted_messages: ConversationMessage[]
  }>()
  assert.equal(retryAfter?.compacted_messages[0].message_id, retryReplacement.message_id)

  // Member AgentSession uses the same Job/merge protocol and preserves a
  // mailbox/task tail appended while its source Run is already over.
  const sessionId = 'agent_session_compaction'
  const memberInitial = [message('member_01', 'member one'), message('member_02', 'member two')]
  await AgentSessionRuntimeModel.create({
    session_id: sessionId,
    team_id: teamId,
    conversation_id: conversationId,
    user_id: userId,
    agent_id: 'agent_compaction',
    generation: 1,
    revision: 0,
    context_revision: 0,
    messages: memberInitial,
    compacted_messages: [],
    hippocampus: { project_context_snapshot: snapshotAt(3) },
  })
  const memberJob = await repository.enqueueDurableCompaction({
    owner: {
      kind: 'agent_session',
      sessionId,
      conversationId,
      userId,
      teamId,
      agentId: 'agent_compaction',
    },
    idempotencyKey: 'member_handoff',
    prefixMessages: memberInitial,
  })
  const memberClaim = await repository.claimNextCompactionJob('member_worker', 120_000)
  assert.equal(memberClaim?.job.job_id, memberJob.job_id)
  assert.ok(memberClaim)
  const memberTail = message('member_03', 'member mailbox tail')
  const memberResult = await processClaimedCompactionJob(memberClaim, {
    async summarize() {
      await AgentSessionRuntimeModel.updateOne(
        { session_id: sessionId },
        {
          $push: { messages: memberTail },
          $inc: { context_revision: 1, revision: 1 },
        },
      )
      await commitPublic(
        'analysis/member-merge-time.md',
        'published while member summary was running',
        'member_merge_time',
      )
      return { summary: 'durable member summary' }
    },
  }, { heartbeatMs: 5_000 })
  assert.equal(memberResult.outcome, 'merged')
  const memberAfter = await AgentSessionRuntimeModel.findOne({ session_id: sessionId }).lean<{
    messages: ConversationMessage[]
    compacted_messages: ConversationMessage[]
    last_applied_compaction_id: string
    context_compaction_fence?: unknown
    hippocampus: {
      last_settled_compaction_id?: string
      turns_since_merge?: number
      rapid_refills?: number
    }
  }>()
  assert.ok(memberAfter)
  assert.deepEqual(memberAfter.messages.map(item => item.message_id), ['member_01', 'member_02', 'member_03'])
  assert.equal(memberAfter.compacted_messages.length, 2)
  assert.equal(memberAfter.compacted_messages[1].message_id, 'member_03')
  assert.equal(memberAfter.last_applied_compaction_id, memberJob.job_id)
  assert.equal(memberAfter.context_compaction_fence, null)
  assert.equal(memberAfter.hippocampus.last_settled_compaction_id, memberJob.job_id)
  assert.equal(memberAfter.hippocampus.turns_since_merge, 0)
  assert.equal(memberAfter.hippocampus.rapid_refills, 0)
  const mergedMemberJob = await repository.getDurableCompactionJob(memberJob.job_id)
  assert.equal(mergedMemberJob?.merge_project_context_snapshot?.epoch, 4)
  assert.match(
    mergedMemberJob?.merge_workspace_projection?.content ?? '',
    /member-merge-time\.md/,
  )

  // If the canonical owner disappears after the worker has prepared its
  // replacement, owner_missing is terminal: the Job fence and active key are
  // cleared instead of retrying forever.
  const missingConversationId = 'conversation_deleted_during_merge'
  const missingOwner = {
    kind: 'conversation' as const,
    conversationId: missingConversationId,
    userId,
  }
  await Conversation.create({
    conversation_id: missingConversationId,
    user_id: userId,
    settings: { orchestrator_model: 'test-model' },
    messages: [message('missing_01', 'owner deleted during merge')],
    compacted_messages: [],
  })
  const missingJob = await repository.enqueueDurableCompaction({
    owner: missingOwner,
    idempotencyKey: 'missing_owner_trigger',
  })
  const missingClaim = await repository.claimNextCompactionJob('missing_owner_worker', 120_000)
  assert.equal(missingClaim?.job.job_id, missingJob.job_id)
  assert.ok(missingClaim)
  const missingResult = await processClaimedCompactionJob(missingClaim, {
    async summarize() {
      return { summary: 'prepared before owner deletion' }
    },
    async buildReplacement(job, summary) {
      const value = await buildDefaultDurableReplacement(job, summary)
      await Conversation.deleteOne({
        conversation_id: missingConversationId,
        user_id: userId,
      })
      return value
    },
  })
  assert.equal(missingResult.outcome, 'owner_missing')
  const terminalMissingJob = await repository.getDurableCompactionJob(missingJob.job_id)
  assert.equal(terminalMissingJob?.status, 'failed')
  assert.equal(terminalMissingJob?.active_key, undefined)
  assert.equal(terminalMissingJob?.lease, null)

  // The real Conversation deletion cleanup calls the shared compaction helper
  // and removes both active barriers and frozen summaries for that project.
  const deletionConversationId = 'conversation_project_deletion'
  const deletionOwner = {
    kind: 'conversation' as const,
    conversationId: deletionConversationId,
    userId,
  }
  await Conversation.create({
    conversation_id: deletionConversationId,
    user_id: userId,
    settings: { orchestrator_model: 'test-model' },
    messages: [message('deletion_01', 'delete the whole project')],
    compacted_messages: [],
  })
  await ConversationRuntime.create({
    conversation_id: deletionConversationId,
    user_id: userId,
    revision: 0,
    hippocampus: {},
  })
  const deletionJob = await repository.enqueueDurableCompaction({
    owner: deletionOwner,
    idempotencyKey: 'project_deletion_trigger',
    initialAvailableAt: new Date(Date.now() + 120_000),
  })
  assert.ok(deletionJob.active_key)
  await Conversation.deleteOne({
    conversation_id: deletionConversationId,
    user_id: userId,
  })
  const { deleteConversationRuntimeState } = await import('../../agent-runtime/repository')
  const deletedRuntime = await deleteConversationRuntimeState(deletionConversationId, userId)
  assert.equal(deletedRuntime.compactions, 1)
  assert.equal(await DurableCompactionJobModel.countDocuments({
    conversation_id: deletionConversationId,
    user_id: userId,
  }), 0)

  console.log('durable compaction Mongo verification passed')
  await mongoose.disconnect()
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
