import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type {
  WorkspaceActor,
  WorkspaceWriterProvenance,
} from '../../workspace/multi-agent/types'

const TEST_DATABASE_SUFFIX = '_test'
const mongoUri = process.env.AGENT_TEAM_TEST_MONGODB_URI?.trim()
  || 'mongodb://127.0.0.1:27018/sci_pegasus_agent_team_test'
const databaseName = mongoUri.match(/\/([^/?]+)(?:\?|$)/)?.[1]

if (!databaseName?.endsWith(TEST_DATABASE_SUFFIX)) {
  throw new Error(
    `Refusing to run approved-publication recovery tests outside an isolated *${TEST_DATABASE_SUFFIX} database.`,
  )
}
process.env.MONGODB_URI = mongoUri

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function publicationKey(proposalId: string, targetPath: string): string {
  return `workspace-proposal:${proposalId}:${digest(targetPath).slice(0, 32)}`
}

async function main(): Promise<void> {
  const mongoose = (await import('mongoose')).default
  const { connectDB } = await import('../../db/mongodb')
  const { AgentRun } = await import('../../agent-runtime/models')
  const {
    claimAgentRun,
    createAgentRun,
    setRunStatus,
  } = await import('../../agent-runtime/repository')
  const { QueuedMessage } = await import('../../db/queue-model')
  const {
    AGENT_TEAM_MODELS,
    AgentMailboxMessageModel,
    AgentTaskModel,
    WorkspaceProposalModel,
  } = await import('../models')
  const { agentTeamService } = await import('../service')
  const { executeAgentTeamTool } = await import('../tool-adapter')
  const {
    remindStaleApprovedWorkspacePublications,
  } = await import('../orchestrator')
  const { InvalidAgentTeamOperationError } = await import('../errors')
  const {
    MultiAgentWorkspaceRepository,
    WorkspaceCanonicalArtifact,
    WorkspaceCapacity,
    WorkspaceFile,
    WorkspaceFileRevision,
  } = await import('../../workspace/multi-agent')
  await connectDB()
  const database = mongoose.connection.db
  assert.ok(database)
  await database.dropDatabase()
  await Promise.all([
    ...AGENT_TEAM_MODELS.map(model => model.syncIndexes()),
    AgentRun.syncIndexes(),
    QueuedMessage.syncIndexes(),
    WorkspaceFile.syncIndexes(),
    WorkspaceFileRevision.syncIndexes(),
    WorkspaceCapacity.syncIndexes(),
    WorkspaceCanonicalArtifact.syncIndexes(),
  ])

  const conversationId = 'conversation_approved_publication_recovery'
  const userId = 'user_approved_publication_recovery'
  const workspaceId = conversationId
  const team = await agentTeamService.ensureTeam({
    conversationId,
    userId,
    workspaceId,
  })
  const rootAgent = await agentTeamService.getAgent({
    teamId: team.team_id,
    userId,
    agentId: team.root_agent_id,
  })
  const rootContext = (runId: string, toolUseId: string) => ({
    team_id: team.team_id,
    user_id: userId,
    caller_agent_id: rootAgent.agent_id,
    run_id: runId,
    tool_use_id: toolUseId,
  })

  try {
    const author = await agentTeamService.createAgent(
      rootContext('run_create_publication_author', 'tool_create_publication_author'),
      {
        displayName: 'Publication Recovery Author',
        role: 'Produce private publication drafts',
      },
    )
    const authorContext = (runId: string, toolUseId: string) => ({
      team_id: team.team_id,
      user_id: userId,
      caller_agent_id: author.agent.agent_id,
      run_id: runId,
      tool_use_id: toolUseId,
    })
    const workspace = new MultiAgentWorkspaceRepository()
    const rootActor: WorkspaceActor = {
      teamId: team.team_id,
      agentId: rootAgent.agent_id,
      rootAgentId: rootAgent.agent_id,
      role: 'root',
    }
    const authorActor: WorkspaceActor = {
      teamId: team.team_id,
      agentId: author.agent.agent_id,
      rootAgentId: rootAgent.agent_id,
      role: 'member',
    }
    const writer = (
      agentId: string,
      runId: string,
      taskId?: string | null,
    ): WorkspaceWriterProvenance => ({
      team_id: team.team_id,
      agent_id: agentId,
      ...(taskId ? { task_id: taskId } : {}),
      run_id: runId,
      execution_fence_token: `test_fence_${runId}`,
    })

    let serial = 0
    const createPendingProposal = async (label: string, taskId?: string) => {
      serial += 1
      const sourcePath = `${author.agent.private_workspace_prefix}${label}.md`
      const targetPath = `output/${label}.md`
      const content = `approved publication recovery ${label}`
      await workspace.commitFile(authorActor, {
        workspaceId,
        path: sourcePath,
        expectedRevision: null,
        visibility: 'agent_private',
        ownerAgentId: author.agent.agent_id,
        storageRef: { driver: 'gridfs', object_id: `gridfs_${label}` },
        metadata: {
          kind: 'text',
          mime_type: 'text/markdown',
          size_bytes: Buffer.byteLength(content),
          sha256: digest(content),
        },
        writer: writer(author.agent.agent_id, `run_source_${label}`, taskId),
      })
      const submitted = await agentTeamService.submitResult(
        authorContext(`run_submit_${label}`, `tool_submit_${label}_${serial}`),
        {
          ...(taskId ? { taskId } : {}),
          finalResponse: `Draft ${label} is ready.`,
          files: [{
            source_path: sourcePath,
            suggested_target_path: targetPath,
            sha256: digest(content),
          }],
          implicit: true,
        },
      )
      const proposal = submitted.proposals[0]
      assert.ok(proposal)
      return {
        sourcePath,
        targetPath,
        resultId: submitted.result.result_id,
        proposalId: proposal.proposal_id,
      }
    }

    const createApprovedProposal = async (label: string) => {
      const pending = await createPendingProposal(label)
      const originalReview = await agentTeamService.reviewResult(
        rootContext(`run_review_original_${label}`, `tool_review_original_${label}`),
        {
          resultId: pending.resultId,
          items: [{ proposalId: pending.proposalId, action: 'accept' }],
        },
      )
      assert.equal(originalReview.accepted_intents.length, 1)
      assert.equal(originalReview.proposals.find(item => item.proposal_id === pending.proposalId)?.status, 'approved')
      return {
        ...pending,
        originalIntent: originalReview.accepted_intents[0],
      }
    }

    const publishIntent = async (
      intent: Awaited<ReturnType<typeof createApprovedProposal>>['originalIntent'],
      runId: string,
    ) => workspace.acceptProposalItem({
      workspaceId,
      sourcePath: intent.source_path,
      targetPath: intent.target_path,
      publicationKey: publicationKey(intent.proposal_id, intent.target_path),
      expectedSourceSha256: intent.source_sha256,
      expectedTargetRevision: intent.expected_target_revision ?? null,
      actor: rootActor,
      writer: writer(rootAgent.agent_id, runId, intent.task_id),
    })

    // Crash A: review receipt is durable, but the process dies before the
    // public Workspace CAS. A new tool_use_id takes over the identical accept.
    const beforePublish = await createApprovedProposal('crash-before-publish')
    const beforePublishTakeover = await agentTeamService.reviewResult(
      rootContext('run_review_takeover_before_publish', 'tool_review_takeover_before_publish'),
      {
        resultId: beforePublish.resultId,
        items: [{ proposalId: beforePublish.proposalId, action: 'accept' }],
      },
    )
    assert.equal(beforePublishTakeover.accepted_intents.length, 1)
    const beforePublishOutcome = await publishIntent(
      beforePublishTakeover.accepted_intents[0],
      'run_publish_takeover_before_publish',
    )
    assert.equal(beforePublishOutcome.status, 'accepted')
    await agentTeamService.recordWorkspaceProposalOutcome({
      teamId: team.team_id,
      userId,
      proposalId: beforePublish.proposalId,
      status: 'published',
      publishedRevision: beforePublishOutcome.status === 'accepted'
        ? beforePublishOutcome.file.revision
        : undefined,
    })
    assert.equal((await WorkspaceProposalModel.findOne({
      proposal_id: beforePublish.proposalId,
    }).lean())?.status, 'published')

    // Crash B: the public head committed, but the proposal outcome marker did
    // not. Re-accepting with a new command returns the same immutable version.
    const afterPublish = await createApprovedProposal('crash-after-publish')
    const firstPublication = await publishIntent(
      afterPublish.originalIntent,
      'run_publish_before_outcome_crash',
    )
    assert.equal(firstPublication.status, 'accepted')
    const revisionsBeforeTakeover = await WorkspaceFileRevision.countDocuments({
      workspace_id: workspaceId,
      path: afterPublish.targetPath,
    })
    const afterPublishTakeover = await agentTeamService.reviewResult(
      rootContext('run_review_takeover_after_publish', 'tool_review_takeover_after_publish'),
      {
        resultId: afterPublish.resultId,
        items: [{ proposalId: afterPublish.proposalId, action: 'accept' }],
      },
    )
    assert.equal(afterPublishTakeover.accepted_intents.length, 1)
    const replayedPublication = await publishIntent(
      afterPublishTakeover.accepted_intents[0],
      'run_publish_after_outcome_crash_takeover',
    )
    assert.equal(replayedPublication.status, 'accepted')
    if (firstPublication.status === 'accepted' && replayedPublication.status === 'accepted') {
      assert.equal(replayedPublication.file.version_id, firstPublication.file.version_id)
      assert.equal(replayedPublication.file.revision, firstPublication.file.revision)
    }
    assert.equal(await WorkspaceFileRevision.countDocuments({
      workspace_id: workspaceId,
      path: afterPublish.targetPath,
    }), revisionsBeforeTakeover, 'publish→outcome repair must not append a revision')
    await agentTeamService.recordWorkspaceProposalOutcome({
      teamId: team.team_id,
      userId,
      proposalId: afterPublish.proposalId,
      status: 'published',
      publishedRevision: replayedPublication.status === 'accepted'
        ? replayedPublication.file.revision
        : undefined,
    })

    // Crash C: two replacement commands race to take over one approved outbox
    // item. The review-command CAS selects one intent; publication is single.
    const concurrent = await createApprovedProposal('concurrent-takeover')
    const concurrentReviews = await Promise.all([
      agentTeamService.reviewResult(
        rootContext('run_review_takeover_left', 'tool_review_takeover_left'),
        {
          resultId: concurrent.resultId,
          items: [{ proposalId: concurrent.proposalId, action: 'accept' }],
        },
      ),
      agentTeamService.reviewResult(
        rootContext('run_review_takeover_right', 'tool_review_takeover_right'),
        {
          resultId: concurrent.resultId,
          items: [{ proposalId: concurrent.proposalId, action: 'accept' }],
        },
      ),
    ])
    const concurrentIntents = concurrentReviews.flatMap(review => review.accepted_intents)
    assert.equal(concurrentIntents.length, 1, 'one approved outbox item has one takeover owner')
    const concurrentPublication = await publishIntent(
      concurrentIntents[0],
      'run_publish_concurrent_takeover',
    )
    assert.equal(concurrentPublication.status, 'accepted')
    assert.equal(await WorkspaceFileRevision.countDocuments({
      workspace_id: workspaceId,
      path: concurrent.targetPath,
    }), 1)

    // Crash D: an already-approved authorization cannot be retargeted,
    // rejected, or CAS-mutated while publication outcome is unknown.
    const immutableApproval = await createApprovedProposal('immutable-approval')
    const forbidden = [
      {
        action: 'retarget' as const,
        targetPath: 'output/retargeted-after-approval.md',
      },
      { action: 'reject' as const },
      { action: 'request_changes' as const, taskDecision: 'rework' as const },
      { action: 'accept' as const, expectedTargetRevision: 7 },
    ]
    for (const [index, candidate] of forbidden.entries()) {
      await assert.rejects(
        agentTeamService.reviewResult(
          rootContext(`run_forbidden_approved_${index}`, `tool_forbidden_approved_${index}`),
          {
            resultId: immutableApproval.resultId,
            items: [{
              proposalId: immutableApproval.proposalId,
              action: candidate.action,
              ...('targetPath' in candidate ? { targetPath: candidate.targetPath } : {}),
              ...('expectedTargetRevision' in candidate
                ? { expectedTargetRevision: candidate.expectedTargetRevision }
                : {}),
            }],
            ...('taskDecision' in candidate ? { taskDecision: candidate.taskDecision } : {}),
          },
        ),
        (error: unknown) => error instanceof InvalidAgentTeamOperationError,
      )
    }

    // A deterministic publication precondition failure must leave `approved`
    // as `conflict`, otherwise the immutable-approval takeover rule would
    // force Root into an endless accept-only repair loop. Once conflicted, the
    // same proposal is reviewable again (including request_changes).
    const changedSource = await createApprovedProposal('source-changed-after-submit')
    const originalSource = await workspace.getFile(
      workspaceId,
      changedSource.sourcePath,
      authorActor,
    )
    assert.ok(originalSource)
    const changedContent = 'the author changed this source after submitting its immutable proposal'
    await workspace.commitFile(authorActor, {
      workspaceId,
      path: changedSource.sourcePath,
      expectedRevision: originalSource.revision,
      visibility: 'agent_private',
      ownerAgentId: author.agent.agent_id,
      storageRef: { driver: 'gridfs', object_id: 'gridfs_source_changed_after_submit_v2' },
      metadata: {
        kind: 'text',
        mime_type: 'text/markdown',
        size_bytes: Buffer.byteLength(changedContent),
        sha256: digest(changedContent),
      },
      writer: writer(author.agent.agent_id, 'run_change_source_after_submit'),
    })
    const reviewRunId = 'run_review_deterministic_publication_conflict'
    const reviewOwner = 'runner_review_deterministic_publication_conflict'
    await createAgentRun({
      runId: reviewRunId,
      conversationId,
      userId,
      request: { message: 'Exercise deterministic publication conflict recovery.' },
      startedMessageId: 'msg_review_deterministic_publication_conflict',
      teamId: team.team_id,
      agentId: rootAgent.agent_id,
      agentSessionId: rootAgent.current_session_id,
      trigger: 'supervision',
      rootVisible: true,
      executionMode: 'conversation',
    })
    assert.ok(await claimAgentRun(reviewRunId, reviewOwner, 30_000))
    const adapterReview = await executeAgentTeamTool(
      'ReviewWorkspaceChanges',
      {
        result_id: changedSource.resultId,
        file_reviews: [{
          proposal_item_id: changedSource.proposalId,
          action: 'accept',
        }],
      },
      {
        userId,
        conversationId,
        runId: reviewRunId,
        teamId: team.team_id,
        agentId: rootAgent.agent_id,
        agentSessionId: rootAgent.current_session_id,
        isRoot: true,
        workspaceId,
        executionFenceToken: reviewOwner,
        teamFenceRequired: false,
      },
      {
        toolUseId: 'tool_review_deterministic_publication_conflict',
        actionId: 'action_review_deterministic_publication_conflict',
        turn: 1,
      },
    )
    assert.equal(adapterReview.is_error, undefined)
    assert.equal((await WorkspaceProposalModel.findOne({
      proposal_id: changedSource.proposalId,
    }).lean())?.status, 'conflict')
    const reReviewedConflict = await agentTeamService.reviewResult(
      rootContext('run_rereview_source_conflict', 'tool_rereview_source_conflict'),
      {
        resultId: changedSource.resultId,
        items: [{
          proposalId: changedSource.proposalId,
          action: 'request_changes',
          note: 'Regenerate the proposal from the current private revision.',
        }],
        taskDecision: 'rework',
        taskNote: 'The submitted source changed before publication.',
      },
    )
    assert.equal(reReviewedConflict.proposals.find(
      proposal => proposal.proposal_id === changedSource.proposalId,
    )?.status, 'rejected')
    assert.equal(await setRunStatus(reviewRunId, 'completed', {
      terminationReason: 'model_finished',
      releaseActive: true,
      leaseOwnerId: reviewOwner,
    }), true)

    // Maintenance only emits one deterministic Root wake for a stale approved
    // outbox item; it never writes the public Workspace itself.
    const staleApproval = await createApprovedProposal('stale-approved-reminder')
    await WorkspaceProposalModel.updateOne(
      { proposal_id: staleApproval.proposalId },
      { $set: { reviewed_at: new Date('2026-08-01T00:00:00.000Z') } },
    )
    const repairNow = new Date('2026-08-09T00:00:00.000Z')
    assert.equal(await remindStaleApprovedWorkspacePublications(team, repairNow, 1_000), 1)
    assert.equal(await remindStaleApprovedWorkspacePublications(team, repairNow, 1_000), 1)
    const staleProposal = await WorkspaceProposalModel.findOne({
      proposal_id: staleApproval.proposalId,
    }).lean()
    const repairDeliveryKey = `workspace-proposal-repair:${team.team_id}:${staleApproval.proposalId}:${staleProposal?.review_command_key ?? 'unkeyed'}`
    assert.equal(await QueuedMessage.countDocuments({
      conversation_id: conversationId,
      idempotency_key: repairDeliveryKey,
    }), 1, 'repeated maintenance sweeps must reuse one repair delivery')
    assert.equal(await WorkspaceFile.countDocuments({
      workspace_id: workspaceId,
      path: staleApproval.targetPath,
    }), 0, 'maintenance must not publish without a fenced Root review')

    // A formal Task rework persists the complete feedback in the author's
    // mailbox under a derived command key. Replaying the review command does
    // not duplicate either the Task transition or the message.
    const formalTask = await agentTeamService.assignTask(
      rootContext('run_assign_formal_feedback', 'tool_assign_formal_feedback'),
      {
        assignedAgentId: author.agent.agent_id,
        title: 'Revise a formal Workspace result',
        objective: 'Submit a draft that Root can return for concrete changes.',
      },
    )
    const formalFeedback = await createPendingProposal(
      'formal-review-feedback',
      formalTask.task_id,
    )
    const formalReviewContext = rootContext(
      'run_formal_review_feedback',
      'tool_formal_review_feedback',
    )
    const formalReviewInput = {
      resultId: formalFeedback.resultId,
      items: [{
        proposalId: formalFeedback.proposalId,
        action: 'request_changes' as const,
        note: 'Add the missing uncertainty discussion and cite the supporting source.',
      }],
      taskDecision: 'rework' as const,
      taskNote: 'The scientific claim needs a bounded confidence statement.',
    }
    const formalReview = await agentTeamService.reviewResult(
      formalReviewContext,
      formalReviewInput,
    )
    assert.equal(formalReview.task?.status, 'rework')
    assert.ok(formalReview.feedback_delivery)
    assert.equal(formalReview.feedback_delivery.message.task_id, formalTask.task_id)
    assert.equal(formalReview.feedback_delivery.message.kind, 'review')
    assert.match(
      formalReview.feedback_delivery.message.content,
      /bounded confidence statement/,
    )
    assert.match(
      formalReview.feedback_delivery.message.content,
      /missing uncertainty discussion/,
    )
    assert.match(formalReview.feedback_delivery.message.content, new RegExp(
      formalFeedback.sourcePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    ))
    assert.match(formalReview.feedback_delivery.message.content, new RegExp(
      formalFeedback.targetPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    ))
    assert.equal(
      formalReview.feedback_delivery.message.deliveries.find(delivery => (
        delivery.agent_id === author.agent.agent_id && delivery.kind === 'primary'
      ))?.status,
      'pending',
    )
    const replayedFormalReview = await agentTeamService.reviewResult(
      formalReviewContext,
      formalReviewInput,
    )
    assert.equal(
      replayedFormalReview.feedback_delivery?.message.message_id,
      formalReview.feedback_delivery.message.message_id,
    )
    assert.equal(await AgentMailboxMessageModel.countDocuments({
      team_id: team.team_id,
      correlation_id: formalFeedback.resultId,
      recipient_agent_id: author.agent.agent_id,
      kind: 'review',
    }), 1, 'formal review retry must not duplicate feedback')
    assert.equal((await AgentTaskModel.findOne({
      task_id: formalTask.task_id,
    }).lean())?.status, 'rework')

    // Conversational/taskless results receive the same durable review
    // feedback with no fabricated Task association. The adapter can therefore
    // wake a fresh author Run directly from this pending mailbox delivery.
    const tasklessFeedback = await createPendingProposal('taskless-review-feedback')
    const tasklessReview = await agentTeamService.reviewResult(
      rootContext('run_taskless_review_feedback', 'tool_taskless_review_feedback'),
      {
        resultId: tasklessFeedback.resultId,
        items: [{
          proposalId: tasklessFeedback.proposalId,
          action: 'request_changes',
          note: 'Replace the placeholder table with the extracted measurements.',
        }],
        taskDecision: 'rework',
        taskNote: 'Continue this conversational turn without creating a Task.',
      },
    )
    assert.equal(tasklessReview.task, undefined)
    assert.ok(tasklessReview.feedback_delivery)
    assert.equal(tasklessReview.feedback_delivery.message.task_id ?? null, null)
    assert.equal(tasklessReview.feedback_delivery.message.correlation_id, tasklessFeedback.resultId)
    assert.match(tasklessReview.feedback_delivery.message.content, /placeholder table/)
    assert.match(tasklessReview.feedback_delivery.message.content, /without creating a Task/)
    assert.equal(await AgentMailboxMessageModel.countDocuments({
      team_id: team.team_id,
      correlation_id: tasklessFeedback.resultId,
      recipient_agent_id: author.agent.agent_id,
      kind: 'review',
    }), 1)

    console.log('Approved Workspace publication recovery and review feedback verification passed.')
  } finally {
    await database.dropDatabase()
    await mongoose.disconnect()
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
