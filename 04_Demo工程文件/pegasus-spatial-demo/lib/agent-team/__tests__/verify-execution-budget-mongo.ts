import assert from 'node:assert/strict'

const TEST_DATABASE_SUFFIX = '_test'
const mongoUri = process.env.AGENT_BUDGET_TEST_MONGODB_URI?.trim()
  || 'mongodb://127.0.0.1:27018/sci_pegasus_agent_budget_test'
const databaseName = mongoUri.match(/\/([^/?]+)(?:\?|$)/)?.[1]

if (!databaseName?.endsWith(TEST_DATABASE_SUFFIX)) {
  throw new Error(
    `Refusing to run execution-budget integration tests outside an isolated *${TEST_DATABASE_SUFFIX} database.`,
  )
}
process.env.MONGODB_URI = mongoUri

async function main(): Promise<void> {
  const mongoose = (await import('mongoose')).default
  const { connectDB } = await import('../../db/mongodb')
  const { AgentRun } = await import('../../agent-runtime/models')
  const {
    AgentExecutionBudgetExceededError,
  } = await import('../errors')
  const {
    MongoAgentExecutionBudgetLedger,
  } = await import('../execution-budget')
  const {
    AGENT_TEAM_MODELS,
    AgentBudgetAdmissionModel,
    AgentExecutionBudgetStateModel,
    AgentExecutionTelemetryModel,
  } = await import('../models')
  const { agentTeamService } = await import('../service')
  const { deleteAgentTeamState } = await import('../cleanup')
  type AgentBudget = import('../types').AgentBudget
  type AgentExecutionBudgetContext = import('../execution-budget').AgentExecutionBudgetContext
  type AgentExecutionFenceValidator = import('../execution-budget').AgentExecutionFenceValidator

  class MutableFences implements AgentExecutionFenceValidator {
    private readonly run = new Map<string, boolean>()
    private readonly team = new Map<string, boolean>()

    set(context: AgentExecutionBudgetContext, runValid: boolean, teamValid = runValid): void {
      const key = `${context.runId}\u0000${context.executionOwnerId}`
      this.run.set(key, runValid)
      this.team.set(key, teamValid)
    }

    validateRun(runId: string, ownerId: string): Promise<boolean> {
      return Promise.resolve(this.run.get(`${runId}\u0000${ownerId}`) === true)
    }

    validateTeam(input: { runId: string; ownerId: string }): Promise<boolean> {
      return Promise.resolve(this.team.get(`${input.runId}\u0000${input.ownerId}`) === true)
    }
  }

  let fixtureSequence = 0
  async function fixture(input: {
    teamBudget: AgentBudget
    agentBudget?: AgentBudget
    taskBudget?: AgentBudget
  }) {
    fixtureSequence += 1
    const suffix = String(fixtureSequence)
    const conversationId = `conversation_budget_mongo_${suffix}`
    const userId = `user_budget_mongo_${suffix}`
    const team = await agentTeamService.ensureTeam({
      conversationId,
      userId,
      policy: { global_budget: input.teamBudget },
    })
    const root = await agentTeamService.getAgent({
      teamId: team.team_id,
      userId,
      agentId: team.root_agent_id,
    })
    const created = await agentTeamService.createAgent({
      team_id: team.team_id,
      user_id: userId,
      caller_agent_id: root.agent_id,
      run_id: `run_create_budget_fixture_${suffix}`,
      tool_use_id: `tool_create_budget_fixture_${suffix}`,
    }, {
      displayName: `Budget Agent ${suffix}`,
      role: 'Exercise atomic budget admission',
      grant: { budget: input.agentBudget },
      initialTask: {
        title: `Budget task ${suffix}`,
        objective: 'Verify strict and observed budget semantics.',
        budget: input.taskBudget,
      },
    })
    assert.ok(created.task)
    const context = (index: number): AgentExecutionBudgetContext => ({
      teamId: team.team_id,
      conversationId,
      userId,
      agentId: created.agent.agent_id,
      taskId: created.task!.task_id,
      runId: `run_budget_${suffix}_${index}`,
      executionOwnerId: `owner_budget_${suffix}_${index}`,
      agentSessionId: created.agent.current_session_id,
      teamFenceRequired: true,
    })
    return { team, root, created, context, conversationId, userId }
  }

  await connectDB()
  const database = mongoose.connection.db
  assert.ok(database)
  await database.dropDatabase()
  await Promise.all([
    ...AGENT_TEAM_MODELS.map(model => model.syncIndexes()),
    AgentRun.syncIndexes(),
  ])

  try {
    // One Team document checks and advances Team → Agent → Task counters in a
    // single Mongo CAS. Eight contenders may never admit more than the narrowest
    // max_tool_calls scope.
    const strict = await fixture({
      teamBudget: { max_tool_calls: 5 },
      agentBudget: { max_tool_calls: 4 },
      taskBudget: { max_tool_calls: 3 },
    })
    const strictFences = new MutableFences()
    const strictLedger = new MongoAgentExecutionBudgetLedger(strictFences)
    const contexts = Array.from({ length: 8 }, (_, index) => strict.context(index))
    contexts.forEach(context => strictFences.set(context, true, true))
    const contenders = await Promise.allSettled(contexts.map((context, index) => (
      strictLedger.reserveCall(context, 'tool', 'Read', `strict_tool_${index}`)
    )))
    const admitted = contenders.flatMap((result, index) => (
      result.status === 'fulfilled' ? [{ context: contexts[index], admission: result.value }] : []
    ))
    const rejected = contenders.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    assert.equal(admitted.length, 3)
    assert.equal(rejected.length, 5)
    assert.ok(rejected.every(result => result.reason instanceof AgentExecutionBudgetExceededError))
    assert.ok(rejected.every(result => result.reason.details?.scope === 'task'))
    const strictState = await AgentExecutionBudgetStateModel.findOne({
      team_id: strict.team.team_id,
    }).lean()
    assert.equal(strictState?.team_usage.tool_calls, 3)
    assert.equal(Object.values(strictState?.agent_usage ?? {})[0]?.tool_calls, 3)
    assert.equal(Object.values(strictState?.task_usage ?? {})[0]?.tool_calls, 3)

    // Started calls count even on a concrete tool failure. Completing the first
    // attempt also establishes the replay-at-the-ceiling regression case.
    await Promise.all(admitted.map(async ({ context, admission }, index) => {
      await strictLedger.markCallStarted(context, admission)
      await strictLedger.completeCall(context, admission, {}, index !== 1)
    }))
    const first = admitted[0]
    const replay = await strictLedger.reserveCall(
      first.context,
      'tool',
      'Read',
      first.admission.admissionKey,
    )
    assert.equal(replay.reservedToolCalls, 0)
    assert.equal(replay.attempt, 2)
    await strictLedger.markCallStarted(first.context, replay)
    await strictLedger.completeCall(first.context, replay, {}, true)
    const replayedState = await AgentExecutionBudgetStateModel.findOne({
      team_id: strict.team.team_id,
    }).lean()
    assert.equal(replayedState?.team_usage.tool_calls, 3)
    const replayReceipt = await AgentBudgetAdmissionModel.findOne({
      admission_id: replay.admissionId,
    }).lean()
    assert.equal(replayReceipt?.attempt, 2)
    assert.equal(replayReceipt?.attempt_history?.length, 1)
    assert.equal(replayReceipt?.attempt_history?.[0].status, 'completed')
    const strictTelemetry = await AgentExecutionTelemetryModel.aggregate<{ calls: number }>([
      { $match: { team_id: strict.team.team_id } },
      { $group: { _id: null, calls: { $sum: '$tool_calls' } } },
    ])
    assert.equal(strictTelemetry[0]?.calls, 3, 'logical replay must not be charged twice')

    // A reservation that never crosses start is recoverable after both Run and
    // Team fences are lost, restoring the strict slot.
    const releasable = await fixture({
      teamBudget: { max_tool_calls: 1 },
      agentBudget: { max_tool_calls: 1 },
      taskBudget: { max_tool_calls: 1 },
    })
    const releaseFences = new MutableFences()
    const releaseLedger = new MongoAgentExecutionBudgetLedger(releaseFences)
    const staleReservedContext = releasable.context(0)
    releaseFences.set(staleReservedContext, true, true)
    await releaseLedger.reserveCall(staleReservedContext, 'tool', 'Read', 'reserved_crash')
    releaseFences.set(staleReservedContext, false, false)
    assert.deepEqual(
      await releaseLedger.recoverStaleAdmissions({
        teamId: releasable.team.team_id,
        userId: releasable.userId,
      }),
      { released: 1, abandoned: 0 },
    )
    const replacementContext = releasable.context(1)
    releaseFences.set(replacementContext, true, true)
    const replacement = await releaseLedger.reserveCall(
      replacementContext,
      'tool',
      'Read',
      'replacement_after_release',
    )
    assert.equal(replacement.reservedToolCalls, 1)

    // Once start is durable, a crash cannot refund max_tool_calls. Unknown
    // token/cost/download usage is recorded as unobserved rather than fabricated.
    const abandoned = await fixture({
      teamBudget: { max_tool_calls: 1 },
      agentBudget: { max_tool_calls: 1 },
      taskBudget: { max_tool_calls: 1 },
    })
    const abandonFences = new MutableFences()
    const abandonLedger = new MongoAgentExecutionBudgetLedger(abandonFences)
    const staleStartedContext = abandoned.context(0)
    abandonFences.set(staleStartedContext, true, true)
    const started = await abandonLedger.reserveCall(
      staleStartedContext,
      'tool',
      'ArxivFetchPaper',
      'started_crash',
    )
    await abandonLedger.markCallStarted(staleStartedContext, started)
    abandonFences.set(staleStartedContext, false, false)
    assert.deepEqual(
      await abandonLedger.recoverStaleAdmissions({
        teamId: abandoned.team.team_id,
        userId: abandoned.userId,
      }),
      { released: 0, abandoned: 1 },
    )
    const abandonedReceipt = await AgentBudgetAdmissionModel.findOne({
      admission_id: started.admissionId,
    }).lean()
    assert.equal(abandonedReceipt?.status, 'abandoned')
    assert.equal(abandonedReceipt?.usage_observed, false)
    const afterCrash = abandoned.context(1)
    abandonFences.set(afterCrash, true, true)
    await assert.rejects(
      abandonLedger.reserveCall(afterCrash, 'tool', 'Read', 'must_remain_exhausted'),
      (error: unknown) => error instanceof AgentExecutionBudgetExceededError
        && error.details?.dimension === 'tool_calls',
    )

    // Download/token/cost limits are intentionally observed stop limits. Eight
    // in-flight fetches can cross 100 bytes; the exact 160-byte observation is
    // retained and every later fetch is rejected. No hard-ceiling claim is made.
    const observed = await fixture({
      teamBudget: { max_tool_calls: 20, max_download_bytes: 100 },
      agentBudget: { max_tool_calls: 20, max_download_bytes: 100 },
      taskBudget: { max_tool_calls: 20, max_download_bytes: 100 },
    })
    const observedFences = new MutableFences()
    const observedLedger = new MongoAgentExecutionBudgetLedger(observedFences)
    const observedContexts = Array.from({ length: 8 }, (_, index) => observed.context(index))
    observedContexts.forEach(context => observedFences.set(context, true, true))
    const observedAdmissions = await Promise.all(observedContexts.map((context, index) => (
      observedLedger.reserveCall(context, 'tool', 'ArxivFetchPaper', `fetch_${index}`)
    )))
    await Promise.all(observedAdmissions.map((admission, index) => (
      observedLedger.markCallStarted(observedContexts[index], admission)
    )))
    await Promise.all(observedAdmissions.map((admission, index) => (
      observedLedger.completeCall(
        observedContexts[index],
        admission,
        { download_bytes: 20 },
        true,
      )
    )))
    const observedState = await AgentExecutionBudgetStateModel.findOne({
      team_id: observed.team.team_id,
    }).lean()
    assert.equal(observedState?.team_usage.download_bytes, 160)
    const laterFetchContext = observed.context(9)
    observedFences.set(laterFetchContext, true, true)
    await assert.rejects(
      observedLedger.reserveCall(laterFetchContext, 'tool', 'ArxivFetchPaper', 'fetch_later'),
      (error: unknown) => error instanceof AgentExecutionBudgetExceededError
        && error.details?.dimension === 'download_bytes'
        && error.details?.used === 160,
    )

    // A valid Run fence cannot substitute for a missing Team slot/session fence.
    const fenced = await fixture({ teamBudget: { max_tool_calls: 1 } })
    const fencedChecks = new MutableFences()
    const fencedLedger = new MongoAgentExecutionBudgetLedger(fencedChecks)
    const noTeamFence = fenced.context(0)
    fencedChecks.set(noTeamFence, true, false)
    await assert.rejects(
      fencedLedger.reserveCall(noTeamFence, 'tool', 'Read', 'no_team_slot'),
      (error: unknown) => (error as { code?: string }).code === 'AGENT_CONTROL_FENCE_LOST',
    )
    assert.equal(
      await AgentExecutionBudgetStateModel.countDocuments({ team_id: fenced.team.team_id }),
      0,
    )

    // Conversation deletion includes both authoritative counters and receipts.
    assert.ok(await AgentExecutionBudgetStateModel.exists({ team_id: strict.team.team_id }))
    assert.ok(await AgentBudgetAdmissionModel.exists({ team_id: strict.team.team_id }))
    await deleteAgentTeamState(strict.conversationId, strict.userId)
    assert.equal(await AgentExecutionBudgetStateModel.countDocuments({
      team_id: strict.team.team_id,
    }), 0)
    assert.equal(await AgentBudgetAdmissionModel.countDocuments({
      team_id: strict.team.team_id,
    }), 0)

    console.log('Agent execution budget Mongo verification passed.')
  } finally {
    await database.dropDatabase()
    await mongoose.disconnect()
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
