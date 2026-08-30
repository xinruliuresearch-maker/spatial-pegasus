import assert from 'node:assert/strict'
import type { ConversationMessage } from '../../types'

const mongoUri = process.env.AGENT_COMPACTION_TEST_MONGODB_URI?.trim()
  || 'mongodb://127.0.0.1:27018/sci_pegasus_source_turn_guard_test'
const databaseName = mongoUri.match(/\/([^/?]+)(?:\?|$)/)?.[1]
if (!databaseName?.endsWith('_test')) {
  throw new Error('Refusing to run source-turn guard verification outside an isolated *_test database.')
}
process.env.MONGODB_URI = mongoUri

function message(id: string): ConversationMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: `guard fixture ${id}` }],
    message_id: id,
    timestamp: new Date('2026-08-10T00:00:00.000Z'),
  }
}

async function main(): Promise<void> {
  const mongoose = (await import('mongoose')).default
  const { connectDB } = await import('../../db/mongodb')
  const { Conversation } = await import('../../db/models')
  const { DurableCompactionJobModel } = await import('../models')
  const repository = await import('../repository')

  await connectDB()
  const database = mongoose.connection.db
  assert.ok(database)
  await database.dropDatabase()
  await Promise.all([
    Conversation.syncIndexes(),
    DurableCompactionJobModel.syncIndexes(),
  ])

  const userId = 'source_turn_guard_user'
  const createShadow = async (suffix: string) => {
    const conversationId = `source_turn_guard_${suffix}`
    const owner = { kind: 'conversation' as const, conversationId, userId }
    const sourceRunId = `run_${suffix}`
    const idempotencyKey = `trigger_${suffix}`
    await Conversation.create({
      conversation_id: conversationId,
      user_id: userId,
      messages: [message(`message_${suffix}`)],
      compacted_messages: [],
    })
    const job = await repository.enqueueDurableCompaction({
      owner,
      sourceRunId,
      idempotencyKey,
      initialAvailableAt: new Date(Date.now() + 120_000),
    })
    return { owner, sourceRunId, idempotencyKey, job }
  }

  const guarded = await createShadow('claim')
  const firstGuard = await repository.acquireSourceTurnCompactionGuard({
    jobId: guarded.job.job_id,
    owner: guarded.owner,
    idempotencyKey: guarded.idempotencyKey,
    sourceRunId: guarded.sourceRunId,
    guardOwnerId: 'source_turn_a',
    ttlMs: 6_000,
  })
  assert.equal(firstGuard.changed, true)
  assert.equal(firstGuard.job.source_turn_guard?.token, firstGuard.guardToken)
  assert.equal(firstGuard.job.source_turn_guard?.owner_id, 'source_turn_a')

  const replay = await repository.acquireSourceTurnCompactionGuard({
    jobId: guarded.job.job_id,
    owner: guarded.owner,
    idempotencyKey: guarded.idempotencyKey,
    sourceRunId: guarded.sourceRunId,
    guardOwnerId: 'source_turn_a',
    ttlMs: 6_000,
  })
  assert.equal(replay.changed, false)
  assert.equal(replay.guardToken, firstGuard.guardToken)

  await repository.enqueueDurableCompaction({
    owner: guarded.owner,
    sourceRunId: guarded.sourceRunId,
    idempotencyKey: 'joined_but_not_source_trigger',
  })
  await assert.rejects(repository.acquireSourceTurnCompactionGuard({
    jobId: guarded.job.job_id,
    owner: guarded.owner,
    idempotencyKey: 'joined_but_not_source_trigger',
    sourceRunId: guarded.sourceRunId,
    guardOwnerId: 'joined_turn',
  }), repository.CompactionJobCommandRejectedError)

  const blockedActivation = await repository.activateDurableCompactionJob({
    jobId: guarded.job.job_id,
    owner: guarded.owner,
    idempotencyKey: guarded.idempotencyKey,
  })
  assert.equal(blockedActivation.changed, false)
  await assert.rejects(repository.activateUnclaimedQueuedDurableCompactionJob({
    jobId: guarded.job.job_id,
    owner: guarded.owner,
    idempotencyKey: guarded.idempotencyKey,
  }), repository.CompactionJobNotUnclaimedQueuedError)

  await DurableCompactionJobModel.updateOne(
    { job_id: guarded.job.job_id },
    { $set: { available_at: new Date(Date.now() - 1) } },
  )
  assert.equal(
    await repository.claimNextCompactionJob('blocked_worker', 120_000),
    null,
    'a live source-turn guard must win even after the shadow deadline',
  )

  const heartbeatExpiry = await repository.heartbeatSourceTurnCompactionGuard({
    jobId: guarded.job.job_id,
    owner: guarded.owner,
    idempotencyKey: guarded.idempotencyKey,
    sourceRunId: guarded.sourceRunId,
    guardOwnerId: 'source_turn_a',
    guardToken: firstGuard.guardToken,
    ttlMs: 120_000,
  })
  assert.ok(heartbeatExpiry)
  assert.ok(heartbeatExpiry.getTime() > firstGuard.expiresAt.getTime())
  assert.equal(await repository.heartbeatSourceTurnCompactionGuard({
    jobId: guarded.job.job_id,
    owner: guarded.owner,
    idempotencyKey: guarded.idempotencyKey,
    sourceRunId: guarded.sourceRunId,
    guardOwnerId: 'source_turn_a',
    guardToken: 'stale_token',
  }), null)
  assert.equal(await repository.releaseSourceTurnCompactionGuard({
    jobId: guarded.job.job_id,
    owner: guarded.owner,
    idempotencyKey: guarded.idempotencyKey,
    sourceRunId: guarded.sourceRunId,
    guardOwnerId: 'source_turn_a',
    guardToken: 'stale_token',
  }), false)

  await DurableCompactionJobModel.updateOne(
    { job_id: guarded.job.job_id },
    {
      $set: {
        available_at: new Date(Date.now() + 120_000),
        'source_turn_guard.expires_at': new Date(Date.now() - 1),
      },
    },
  )
  const replacementGuard = await repository.acquireSourceTurnCompactionGuard({
    jobId: guarded.job.job_id,
    owner: guarded.owner,
    idempotencyKey: guarded.idempotencyKey,
    sourceRunId: guarded.sourceRunId,
    guardOwnerId: 'source_turn_b',
    ttlMs: 120_000,
  })
  assert.equal(replacementGuard.changed, true)
  assert.notEqual(replacementGuard.guardToken, firstGuard.guardToken)
  assert.equal(await repository.releaseSourceTurnCompactionGuard({
    jobId: guarded.job.job_id,
    owner: guarded.owner,
    idempotencyKey: guarded.idempotencyKey,
    sourceRunId: guarded.sourceRunId,
    guardOwnerId: 'source_turn_a',
    guardToken: firstGuard.guardToken,
  }), false, 'an old token must not release a replacement guard')

  await DurableCompactionJobModel.updateOne(
    { job_id: guarded.job.job_id },
    {
      $set: {
        available_at: new Date(Date.now() - 1),
        'source_turn_guard.expires_at': new Date(Date.now() - 1),
      },
    },
  )
  const takeover = await repository.claimNextCompactionJob('takeover_worker', 120_000)
  assert.equal(takeover?.job.job_id, guarded.job.job_id)
  assert.equal(takeover?.job.source_turn_guard, undefined)
  assert.equal(await repository.heartbeatSourceTurnCompactionGuard({
    jobId: guarded.job.job_id,
    owner: guarded.owner,
    idempotencyKey: guarded.idempotencyKey,
    sourceRunId: guarded.sourceRunId,
    guardOwnerId: 'source_turn_b',
    guardToken: replacementGuard.guardToken,
  }), null, 'takeover must permanently fence the stale source turn')
  assert.ok(takeover)
  assert.equal(await repository.failCompactionJob(takeover, 'fixture cleanup'), true)

  const offered = await createShadow('offer')
  const offerGuard = await repository.acquireSourceTurnCompactionGuard({
    jobId: offered.job.job_id,
    owner: offered.owner,
    idempotencyKey: offered.idempotencyKey,
    sourceRunId: offered.sourceRunId,
    guardOwnerId: 'offer_turn',
  })
  const offerInput = {
    jobId: offered.job.job_id,
    owner: offered.owner,
    idempotencyKey: offered.idempotencyKey,
    expectedPrefixHash: offered.job.frozen_prefix.prefix_hash,
    summary: 'source turn summary',
  }
  assert.equal(
    (await repository.offerPreparedCompactionSummary(offerInput)).outcome,
    'durable_owned',
  )
  assert.equal((await repository.offerPreparedCompactionSummary({
    ...offerInput,
    guardToken: 'wrong_guard',
  })).outcome, 'durable_owned')
  const accepted = await repository.offerPreparedCompactionSummary({
    ...offerInput,
    guardToken: offerGuard.guardToken,
  })
  assert.equal(accepted.outcome, 'accepted')
  assert.equal(accepted.job.status, 'summary_ready')
  assert.equal(accepted.job.source_turn_guard, undefined)
  const offeredClaim = await repository.claimNextCompactionJob('offered_worker', 120_000)
  assert.equal(offeredClaim?.job.job_id, offered.job.job_id)
  assert.ok(offeredClaim)
  assert.equal(await repository.failCompactionJob(offeredClaim, 'fixture cleanup'), true)

  const released = await createShadow('release')
  const releaseGuard = await repository.acquireSourceTurnCompactionGuard({
    jobId: released.job.job_id,
    owner: released.owner,
    idempotencyKey: released.idempotencyKey,
    sourceRunId: released.sourceRunId,
    guardOwnerId: 'release_turn',
  })
  const releaseInput = {
    jobId: released.job.job_id,
    owner: released.owner,
    idempotencyKey: released.idempotencyKey,
    sourceRunId: released.sourceRunId,
    guardOwnerId: 'release_turn',
    guardToken: releaseGuard.guardToken,
  }
  assert.equal(await repository.releaseSourceTurnCompactionGuard(releaseInput), true)
  assert.equal(await repository.releaseSourceTurnCompactionGuard(releaseInput), false)
  assert.equal((await repository.activateDurableCompactionJob({
    jobId: released.job.job_id,
    owner: released.owner,
    idempotencyKey: released.idempotencyKey,
  })).changed, true)
  const releasedClaim = await repository.claimNextCompactionJob('released_worker', 120_000)
  assert.equal(releasedClaim?.job.job_id, released.job.job_id)
  assert.ok(releasedClaim)
  assert.equal(await repository.failCompactionJob(releasedClaim, 'fixture cleanup'), true)

  const terminal = await createShadow('terminal')
  const terminalGuard = await repository.acquireSourceTurnCompactionGuard({
    jobId: terminal.job.job_id,
    owner: terminal.owner,
    idempotencyKey: terminal.idempotencyKey,
    sourceRunId: terminal.sourceRunId,
    guardOwnerId: 'terminal_turn',
  })
  assert.equal((await repository.cancelDurableCompactionJob({
    jobId: terminal.job.job_id,
    owner: terminal.owner,
    idempotencyKey: terminal.idempotencyKey,
    reason: 'missing guard token',
  })).changed, false)
  const terminated = await repository.cancelDurableCompactionJob({
    jobId: terminal.job.job_id,
    owner: terminal.owner,
    idempotencyKey: terminal.idempotencyKey,
    reason: 'source turn cancelled',
    guardToken: terminalGuard.guardToken,
  })
  assert.equal(terminated.changed, true)
  assert.equal(terminated.job.status, 'cancelled')
  assert.equal(terminated.job.source_turn_guard, undefined)

  console.log('source-turn durable compaction guard Mongo verification passed')
  await mongoose.disconnect()
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
