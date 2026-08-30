import assert from 'node:assert/strict'
import type { ConversationMessage } from '../../types'

const mongoUri = process.env.AGENT_COMPACTION_TEST_MONGODB_URI?.trim()
  || 'mongodb://127.0.0.1:27018/sci_pegasus_agent_compaction_shadow_test'
const databaseName = mongoUri.match(/\/([^/?]+)(?:\?|$)/)?.[1]
if (!databaseName?.endsWith('_test')) {
  throw new Error('Refusing to run shadow-intent verification outside an isolated *_test database.')
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

async function main(): Promise<void> {
  const mongoose = (await import('mongoose')).default
  const { connectDB } = await import('../../db/mongodb')
  const { Conversation } = await import('../../db/models')
  const { AgentTeamModel, TeamEventModel } = await import('../../agent-team/models')
  const { DurableCompactionJobModel } = await import('../models')
  const repository = await import('../repository')
  const {
    buildDefaultDurableReplacement,
    processClaimedCompactionJob,
  } = await import('../service')

  await connectDB()
  const database = mongoose.connection.db
  assert.ok(database)
  await database.dropDatabase()
  await Promise.all([
    Conversation.syncIndexes(),
    AgentTeamModel.syncIndexes(),
    TeamEventModel.syncIndexes(),
    DurableCompactionJobModel.syncIndexes(),
  ])

  const userId = 'shadow_user'
  const conversationId = 'shadow_conversation'
  const owner = { kind: 'conversation' as const, conversationId, userId }
  await Conversation.create({
    conversation_id: conversationId,
    user_id: userId,
    settings: { orchestrator_model: 'main_pro' },
    messages: [message('shadow_01', 'persist me before the local request')],
    compacted_messages: [],
  })
  await AgentTeamModel.create({
    team_id: 'shadow_team',
    conversation_id: conversationId,
    user_id: userId,
    root_agent_id: 'shadow_root',
    workspace_id: 'shadow_workspace',
    status: 'active',
    policy: {},
    next_event_seq: 0,
    supervision_cursor: 0,
  })

  const deadline = new Date(Date.now() + 120_000)
  const shadow = await repository.enqueueDurableCompaction({
    owner,
    idempotencyKey: 'shadow_trigger',
    modelAliasSnapshot: 'main_pro',
    initialAvailableAt: deadline,
  })
  assert.equal(shadow.status, 'queued')
  assert.equal(shadow.available_at?.getTime(), deadline.getTime())
  assert.equal(shadow.active_key, `conversation:${conversationId}`)
  assert.equal(await repository.claimNextCompactionJob('too_early'), null)

  const joined = await repository.enqueueDurableCompaction({
    owner,
    idempotencyKey: 'shadow_exit_join',
    modelAliasSnapshot: 'main_pro',
  })
  assert.equal(joined.job_id, shadow.job_id)
  await assert.rejects(
    repository.activateDurableCompactionJob({
      jobId: shadow.job_id,
      owner,
      idempotencyKey: 'not_a_joined_key',
    }),
    (error: unknown) => (
      error instanceof repository.CompactionJobCommandRejectedError
    ),
  )

  const activation = await repository.activateDurableCompactionJob({
    jobId: shadow.job_id,
    owner,
    idempotencyKey: 'shadow_exit_join',
  })
  assert.equal(activation.changed, true)
  assert.ok((activation.job.available_at?.getTime() ?? Infinity) <= Date.now())
  const activationReplay = await repository.activateDurableCompactionJob({
    jobId: shadow.job_id,
    owner,
    idempotencyKey: 'shadow_exit_join',
  })
  assert.equal(activationReplay.changed, false)

  const superseded = await repository.supersedeDurableCompactionJob({
    jobId: shadow.job_id,
    owner,
    idempotencyKey: 'shadow_trigger',
    reason: 'local_merge_won',
  })
  assert.equal(superseded.changed, true)
  assert.equal(superseded.job.status, 'superseded')
  assert.equal(superseded.job.active_key, undefined)
  assert.equal(await repository.claimNextCompactionJob('after_local_merge'), null)
  const supersedeReplay = await repository.supersedeDurableCompactionJob({
    jobId: shadow.job_id,
    owner,
    idempotencyKey: 'shadow_trigger',
    reason: 'local_merge_won',
  })
  assert.equal(supersedeReplay.changed, false)
  assert.equal(supersedeReplay.job.status, 'superseded')
  assert.equal(await repository.flushDurableCompactionStatusOutbox(), 2)
  assert.equal(await repository.flushDurableCompactionStatusOutbox(), 0)
  const statusEvents = await TeamEventModel.find({
    team_id: 'shadow_team',
    type: 'compaction_status',
  }).sort({ seq: 1 }).lean()
  assert.deepEqual(statusEvents.map(event => event.payload.status), ['queued', 'superseded'])
  assert.deepEqual(statusEvents.map(event => event.seq), [1, 2])
  assert.ok(statusEvents.every(event => (
    Object.keys(event.payload).sort().join(',')
      === 'attempt,job,owner,reason,revision,status'
  )))
  // Crash after appendEvent but before outbox acknowledgement: dedupe repairs
  // the acknowledgement without creating a second public event.
  await DurableCompactionJobModel.updateOne(
    { job_id: shadow.job_id },
    { $set: { 'status_outbox.0.delivered_at': null } },
  )
  assert.equal(await repository.flushDurableCompactionStatusOutbox(), 1)
  assert.equal(await TeamEventModel.countDocuments({
    team_id: 'shadow_team',
    type: 'compaction_status',
  }), 2)
  const deliveredShadow = await repository.getDurableCompactionJob(shadow.job_id)
  assert.ok(deliveredShadow?.status_outbox?.every(entry => entry.delivered_at))

  // A prepared durable replacement owns the merge boundary. A late local
  // result must not supersede it.
  const preparedConversationId = 'prepared_shadow_conversation'
  const preparedOwner = {
    kind: 'conversation' as const,
    conversationId: preparedConversationId,
    userId,
  }
  await Conversation.create({
    conversation_id: preparedConversationId,
    user_id: userId,
    settings: { orchestrator_model: 'main_pro' },
    messages: [message('prepared_01', 'durable replacement wins')],
    compacted_messages: [],
  })
  const prepared = await repository.enqueueDurableCompaction({
    owner: preparedOwner,
    idempotencyKey: 'prepared_trigger',
    modelAliasSnapshot: 'main_pro',
  })
  const preparedClaim = await repository.claimNextCompactionJob('prepared_worker', 120_000)
  assert.equal(preparedClaim?.job.job_id, prepared.job_id)
  assert.ok(preparedClaim)
  const claimedRefused = await repository.supersedeDurableCompactionJob({
    jobId: prepared.job_id,
    owner: preparedOwner,
    idempotencyKey: 'prepared_trigger',
    reason: 'worker_already_claimed',
  })
  assert.equal(claimedRefused.changed, false)
  assert.equal(claimedRefused.job.status, 'queued')
  assert.ok(claimedRefused.job.lease)
  assert.equal(await repository.establishContextCompactionFence(preparedClaim), true)
  assert.equal(await repository.beginCompactionSummary(preparedClaim), true)
  assert.equal(await repository.saveCompactionSummary(
    preparedClaim,
    'prepared durable summary',
  ), true)
  const ready = await repository.getDurableCompactionJob(prepared.job_id)
  assert.ok(ready)
  const replacement = await buildDefaultDurableReplacement(ready, ready.summary!)
  assert.equal(await repository.prepareCompactionMerge(preparedClaim, replacement), true)
  const refused = await repository.supersedeDurableCompactionJob({
    jobId: prepared.job_id,
    owner: preparedOwner,
    idempotencyKey: 'prepared_trigger',
    reason: 'late_local_merge',
  })
  assert.equal(refused.changed, false)
  assert.equal(refused.job.status, 'merge_prepared')
  assert.equal(refused.job.active_key, `conversation:${preparedConversationId}`)
  assert.equal(await repository.failCompactionJob(preparedClaim, 'fixture cleanup'), true)

  // A process may die after prepare and before either activate or local
  // supersede. Once the frozen deadline passes, the normal worker claim path
  // must recover that exact delayed Job without a second enqueue.
  const crashedConversationId = 'hard_crash_shadow_conversation'
  const crashedOwner = {
    kind: 'conversation' as const,
    conversationId: crashedConversationId,
    userId,
  }
  await Conversation.create({
    conversation_id: crashedConversationId,
    user_id: userId,
    settings: { orchestrator_model: 'main_pro' },
    messages: [message('crashed_01', 'worker recovers expired shadow')],
    compacted_messages: [],
  })
  const crashedShadow = await repository.enqueueDurableCompaction({
    owner: crashedOwner,
    idempotencyKey: 'hard_crash_trigger',
    modelAliasSnapshot: 'main_pro',
    initialAvailableAt: new Date(Date.now() - 1),
  })
  const crashRecoveryClaim = await repository.claimNextCompactionJob(
    'hard_crash_recovery_worker',
    120_000,
  )
  assert.equal(crashRecoveryClaim?.job.job_id, crashedShadow.job_id)
  assert.ok(crashRecoveryClaim?.fenceToken)
  assert.equal(
    await DurableCompactionJobModel.countDocuments({
      owner_key: `conversation:${crashedConversationId}`,
    }),
    1,
  )
  assert.equal(
    await repository.failCompactionJob(crashRecoveryClaim!, 'fixture cleanup'),
    true,
  )

  // A completed local provider request may publish only its exact summary to
  // the still-unclaimed shadow. The durable worker then skips provider I/O and
  // remains the single writer for replacement/owner state.
  const offeredConversationId = 'offered_summary_conversation'
  const offeredOwner = {
    kind: 'conversation' as const,
    conversationId: offeredConversationId,
    userId,
  }
  await Conversation.create({
    conversation_id: offeredConversationId,
    user_id: userId,
    settings: { orchestrator_model: 'main_pro' },
    messages: [message('offered_01', 'persisted local summary')],
    compacted_messages: [],
  })
  const offeredShadow = await repository.enqueueDurableCompaction({
    owner: offeredOwner,
    idempotencyKey: 'offered_trigger',
    initialAvailableAt: new Date(Date.now() + 120_000),
  })
  await assert.rejects(
    repository.offerPreparedCompactionSummary({
      jobId: offeredShadow.job_id,
      owner: offeredOwner,
      idempotencyKey: 'offered_trigger',
      expectedPrefixHash: 'not-the-frozen-prefix',
      summary: 'wrong prefix must fail',
    }),
    repository.CompactionPrefixConflictError,
  )
  const offered = await repository.offerPreparedCompactionSummary({
    jobId: offeredShadow.job_id,
    owner: offeredOwner,
    idempotencyKey: 'offered_trigger',
    expectedPrefixHash: offeredShadow.frozen_prefix.prefix_hash,
    summary: 'locally generated but durably merged summary',
    usage: {
      input_tokens: 12,
      output_tokens: 7,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  })
  assert.equal(offered.outcome, 'accepted')
  assert.equal(offered.job.status, 'summary_ready')
  assert.ok((offered.job.available_at?.getTime() ?? Infinity) <= Date.now())
  const offeredReplay = await repository.offerPreparedCompactionSummary({
    jobId: offeredShadow.job_id,
    owner: offeredOwner,
    idempotencyKey: 'offered_trigger',
    expectedPrefixHash: offeredShadow.frozen_prefix.prefix_hash,
    summary: 'locally generated but durably merged summary',
  })
  assert.equal(offeredReplay.outcome, 'already_offered')
  const offeredClaim = await repository.claimNextCompactionJob('offered_worker', 120_000)
  assert.equal(offeredClaim?.job.job_id, offeredShadow.job_id)
  assert.ok(offeredClaim)
  let duplicateProviderCall = false
  const offeredResult = await processClaimedCompactionJob(offeredClaim, {
    async summarize() {
      duplicateProviderCall = true
      return { summary: 'must never run' }
    },
  })
  assert.equal(offeredResult.outcome, 'merged')
  assert.equal(duplicateProviderCall, false)

  const claimedOffer = await repository.enqueueDurableCompaction({
    owner: offeredOwner,
    idempotencyKey: 'claimed_offer_trigger',
    initialAvailableAt: new Date(),
  })
  const claimedOfferLease = await repository.claimNextCompactionJob('claimed_offer_worker', 120_000)
  assert.equal(claimedOfferLease?.job.job_id, claimedOffer.job_id)
  assert.ok(claimedOfferLease)
  const durableOwned = await repository.offerPreparedCompactionSummary({
    jobId: claimedOffer.job_id,
    owner: offeredOwner,
    idempotencyKey: 'claimed_offer_trigger',
    expectedPrefixHash: claimedOffer.frozen_prefix.prefix_hash,
    summary: 'too late for a local writer',
  })
  assert.equal(durableOwned.outcome, 'durable_owned')
  assert.equal(await repository.failCompactionJob(claimedOfferLease, 'fixture cleanup'), true)

  // Explicit cancellation is also replay-safe and leaves no claimable Job.
  const cancelledConversationId = 'cancelled_shadow_conversation'
  const cancelledOwner = {
    kind: 'conversation' as const,
    conversationId: cancelledConversationId,
    userId,
  }
  await Conversation.create({
    conversation_id: cancelledConversationId,
    user_id: userId,
    settings: { orchestrator_model: 'main_pro' },
    messages: [message('cancelled_01', 'cancel shadow')],
    compacted_messages: [],
  })
  const cancellable = await repository.enqueueDurableCompaction({
    owner: cancelledOwner,
    idempotencyKey: 'cancel_trigger',
    initialAvailableAt: new Date(Date.now() + 120_000),
  })
  const cancelled = await repository.cancelDurableCompactionJob({
    jobId: cancellable.job_id,
    owner: cancelledOwner,
    idempotencyKey: 'cancel_trigger',
    reason: 'request_cancelled',
  })
  assert.equal(cancelled.changed, true)
  assert.equal(cancelled.job.status, 'cancelled')
  const cancelledReplay = await repository.cancelDurableCompactionJob({
    jobId: cancellable.job_id,
    owner: cancelledOwner,
    idempotencyKey: 'cancel_trigger',
    reason: 'request_cancelled',
  })
  assert.equal(cancelledReplay.changed, false)
  assert.equal(await repository.claimNextCompactionJob('after_cancel'), null)

  // A verified synchronous repair retires only the exact latest failed Job.
  const repairConversationId = 'failed_sync_repair_conversation'
  const repairOwner = {
    kind: 'conversation' as const,
    conversationId: repairConversationId,
    userId,
  }
  await Conversation.create({
    conversation_id: repairConversationId,
    user_id: userId,
    settings: { orchestrator_model: 'main_pro' },
    messages: [message('repair_01', 'failed durable attempt')],
    compacted_messages: [],
    context_revision: 0,
  })
  const repairJob = await repository.enqueueDurableCompaction({
    owner: repairOwner,
    idempotencyKey: 'failed_repair_trigger',
  })
  const repairClaim = await repository.claimNextCompactionJob('failed_repair_worker', 120_000)
  assert.equal(repairClaim?.job.job_id, repairJob.job_id)
  assert.ok(repairClaim)
  assert.equal(await repository.failCompactionJob(repairClaim, 'provider fatal'), true)
  const repairHead: ConversationMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: 'synchronously repaired summary' }],
    message_id: 'sync_repair_head',
    timestamp: new Date(),
  }
  await Conversation.updateOne(
    { conversation_id: repairConversationId, user_id: userId },
    {
      $set: { compacted_messages: [repairHead] },
      $inc: { context_revision: 1, compaction_count: 1 },
    },
  )
  const repaired = await repository.closeFailedCompactionAfterSynchronousRepair({
    jobId: repairJob.job_id,
    owner: repairOwner,
    idempotencyKey: 'failed_repair_trigger',
    replacementMessageId: repairHead.message_id!,
  })
  assert.equal(repaired.changed, true)
  assert.equal(repaired.job.status, 'superseded')
  assert.equal(repaired.job.last_error, 'sync_repair')
  const repairReplay = await repository.closeFailedCompactionAfterSynchronousRepair({
    jobId: repairJob.job_id,
    owner: repairOwner,
    idempotencyKey: 'failed_repair_trigger',
    replacementMessageId: repairHead.message_id!,
  })
  assert.equal(repairReplay.changed, false)

  // More than one fixed query page of deleted/legacy teams cannot starve a
  // later live status event. The first page is deferred entry-by-entry; the
  // next flush advances to the live Job.
  await repository.flushDurableCompactionStatusOutbox({ limit: 500 })
  const old = new Date('2026-08-01T00:00:00.000Z')
  const missingTeamJobs = Array.from({ length: 101 }, (_, index) => ({
    job_id: `cmpjob_missing_team_${index}`,
    owner_key: `conversation:missing_team_${index}`,
    owner_kind: 'conversation',
    conversation_id: `missing_team_${index}`,
    user_id: userId,
    idempotency_key: `missing_team_${index}`,
    idempotency_keys: [`missing_team_${index}`],
    status: 'superseded',
    status_revision: 1,
    status_outbox: [{
      transition_id: `missing_transition_${index}`,
      revision: 1,
      status: 'superseded',
      attempt: 0,
      reason: 'legacy_fixture',
      created_at: old,
      delivered_at: null,
      delivery_attempt: 0,
      next_attempt_at: old,
      undeliverable_at: null,
      delivery_error: null,
    }],
    frozen_prefix: {
      context_revision: 0,
      prefix_length: 1,
      prefix_hash: `missing_hash_${index}`,
      messages: [message(`missing_${index}`, 'legacy status')],
    },
    attempt: 0,
    lease: null,
    available_at: old,
    created_at: new Date(old.getTime() + index),
    updated_at: new Date(old.getTime() + index),
  }))
  await DurableCompactionJobModel.collection.insertMany(missingTeamJobs)
  const liveStatusJob = await DurableCompactionJobModel.create({
    job_id: 'cmpjob_live_after_missing_teams',
    owner_key: `conversation:${conversationId}`,
    owner_kind: 'conversation',
    conversation_id: conversationId,
    user_id: userId,
    idempotency_key: 'live_after_missing_teams',
    idempotency_keys: ['live_after_missing_teams'],
    status: 'superseded',
    status_revision: 1,
    status_outbox: [{
      transition_id: 'live_after_missing_transition',
      revision: 1,
      status: 'superseded',
      attempt: 0,
      reason: 'live_fixture',
      created_at: new Date(),
      delivered_at: null,
      delivery_attempt: 0,
      next_attempt_at: new Date(),
      undeliverable_at: null,
      delivery_error: null,
    }],
    frozen_prefix: {
      context_revision: 0,
      prefix_length: 1,
      prefix_hash: 'live_after_missing_hash',
      messages: [message('live_after_missing', 'live status')],
    },
    attempt: 0,
    lease: null,
    available_at: new Date(),
  })
  assert.ok(liveStatusJob)
  assert.equal(await repository.flushDurableCompactionStatusOutbox({ limit: 100 }), 0)
  assert.equal(await repository.flushDurableCompactionStatusOutbox({ limit: 100 }), 1)
  assert.equal(await TeamEventModel.countDocuments({
    team_id: 'shadow_team',
    type: 'compaction_status',
    'payload.job': 'cmpjob_live_after_missing_teams',
  }), 1)
  const deferred = await DurableCompactionJobModel.findOne({
    job_id: 'cmpjob_missing_team_0',
  }).lean()
  assert.equal(deferred?.status_outbox?.[0]?.delivery_attempt, 1)
  assert.ok(deferred?.status_outbox?.[0]?.next_attempt_at)

  console.log('durable compaction shadow-intent verification passed')
  await mongoose.disconnect()
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
