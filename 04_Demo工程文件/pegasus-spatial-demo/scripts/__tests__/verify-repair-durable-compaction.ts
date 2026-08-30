import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { ConversationMessage } from '../../lib/types'
import type { FrozenModelResolutionSnapshot } from '../../lib/llm-registry'
import type {
  DurableCompactionJobRecord,
  EnqueueCompactionInput,
} from '../../lib/agent-compaction/types'
import {
  estimateRepairCompactionRequestTokens,
  executeRepairDurableCompactionCommand,
  isSafeRepairPrefixBoundary,
  parseRepairDurableCompactionArgs,
  type RepairDurableCompactionDependencies,
  REPAIR_COMPACTION_SAFETY_MARGIN_TOKENS,
  selectSafeRepairCompactionPrefix,
} from '../repair-durable-compaction-operator'

const fixedNow = new Date('2026-08-10T12:00:00.000Z')

function modelSnapshot(
  overrides: Partial<FrozenModelResolutionSnapshot> = {},
): FrozenModelResolutionSnapshot {
  return {
    snapshot_version: 1,
    alias: 'main_operator_test',
    real_model: 'operator-real-model',
    key_channel: 'orchestrator',
    supports_vision: false,
    context_window: 100_000,
    max_output_tokens: 16_000,
    compaction_max_output_tokens: 4_000,
    prompt_cache_ttl: '5m',
    used_compatibility_defaults: false,
    registry_source: 'db',
    registry_revision: '2026-08-10T00:00:00.000Z',
    registry_hash: 'a'.repeat(64),
    resolved_at: fixedNow,
    ...overrides,
  }
}

function textMessage(
  id: string,
  role: ConversationMessage['role'],
  text: string,
): ConversationMessage {
  return {
    role,
    content: [{ type: 'text', text }],
    message_id: id,
    timestamp: new Date('2026-08-10T00:00:00.000Z'),
  }
}

const closedToolHistory: ConversationMessage[] = [
  textMessage('m01', 'user', 'initial question'),
  textMessage('m02', 'assistant', 'initial answer'),
  textMessage('m03', 'user', 'continue'),
  {
    role: 'assistant',
    message_id: 'm04',
    content: [{ type: 'tool_use', id: 'tool_1', name: 'Read', input: { path: '/safe' } }],
  },
  {
    role: 'user',
    message_id: 'm05',
    content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'result'.repeat(400) }],
  },
  textMessage('m06', 'assistant', 'post-tool reasoning'.repeat(200)),
  textMessage('m07', 'user', 'latest user input must remain verbatim'),
]

function fakeJob(input: {
  idempotencyKey: string
  prefix: ConversationMessage[]
  prefixHash: string
  availableAt: Date
  modelResolutionSnapshot?: FrozenModelResolutionSnapshot
}): DurableCompactionJobRecord {
  return {
    job_id: `cmpjob_${createHash('sha256')
      .update(input.idempotencyKey)
      .digest('hex')
      .slice(0, 24)}`,
    owner_key: 'conversation:conversation_operator_test',
    owner_kind: 'conversation',
    conversation_id: 'conversation_operator_test',
    user_id: 'user_operator_test',
    agent_session_id: null,
    team_id: null,
    agent_id: null,
    source_run_id: null,
    idempotency_key: input.idempotencyKey,
    idempotency_keys: [input.idempotencyKey],
    model_alias_snapshot: 'main_operator_test',
    model_resolution_snapshot: structuredClone(
      input.modelResolutionSnapshot ?? modelSnapshot(),
    ),
    status: 'queued',
    status_revision: 1,
    active_key: 'conversation:conversation_operator_test',
    frozen_prefix: {
      context_revision: 7,
      prefix_length: input.prefix.length,
      prefix_hash: input.prefixHash,
      boundary_message_id: input.prefix.at(-1)?.message_id,
      messages: structuredClone(input.prefix),
    },
    summary: 'SECRET SUMMARY MUST NOT APPEAR',
    last_error: 'SECRET ERROR MUST NOT APPEAR',
    attempt: 0,
    lease: null,
    available_at: input.availableAt,
    created_at: fixedNow,
    updated_at: fixedNow,
    finished_at: null,
  }
}

function createInMemoryDependencies(options: {
  rootStatus?: 'running' | 'idle' | 'paused' | 'completed' | 'failed'
  runtimeActiveRunId?: string | null
  runtimeActiveLeaseOwnerId?: string | null
  sessionActiveRunId?: string | null
  sessionActiveLeaseOwnerId?: string | null
  sessionRunLease?: unknown
  rootStatusAfterEnqueue?: 'running' | 'idle' | 'paused' | 'completed' | 'failed'
  claimBeforeRollback?: boolean
  claimBeforeActivate?: boolean
  returnDifferentJoinedWinner?: boolean
  returnExactCancelledPrior?: boolean
  returnExactLeasedQueuedWinner?: boolean
} = {}) {
  let activeJob: DurableCompactionJobRecord | null = null
  const historicalJobs: DurableCompactionJobRecord[] = []
  let enqueueCalls = 0
  let activateCalls = 0
  let cancelCalls = 0
  let rootStatus = options.rootStatus ?? 'idle'
  let rootStatusAfterEnqueueApplied = false
  const conversationMessages = closedToolHistory.concat([
    textMessage('m08', 'assistant', 'tail response'),
  ])

  const dependencies: RepairDurableCompactionDependencies = {
    now: () => new Date(fixedNow),
    async loadConversation(conversationId) {
      if (conversationId !== 'conversation_operator_test') return null
      return {
        conversationId,
        userId: 'user_operator_test',
        requestedAlias: 'main_operator_test',
        messages: [],
        compactedMessages: structuredClone(conversationMessages),
        contextRevision: 7,
        contextFence: null,
      }
    },
    async loadRuntime() {
      return {
        activeRunId: options.runtimeActiveRunId ?? null,
        activeLeaseOwnerId: options.runtimeActiveLeaseOwnerId ?? null,
        projectContextSnapshot: null,
      }
    },
    async loadTeam(conversationId, userId) {
      return {
        teamId: 'team_operator_test',
        conversationId,
        userId,
        rootAgentId: 'agent_root_operator_test',
        workspaceId: 'workspace_operator_test',
        status: 'active',
      }
    },
    async loadRootAgent(team) {
      return {
        agentId: team.rootAgentId,
        teamId: team.teamId,
        conversationId: team.conversationId,
        userId: team.userId,
        isRoot: true,
        status: rootStatus,
        generation: 1,
        currentSessionId: 'session_root_operator_test',
      }
    },
    async loadRootSession(team, root) {
      return {
        sessionId: root.currentSessionId,
        teamId: team.teamId,
        conversationId: team.conversationId,
        userId: team.userId,
        agentId: root.agentId,
        generation: root.generation,
        activeRunId: options.sessionActiveRunId ?? null,
        activeLeaseOwnerId: options.sessionActiveLeaseOwnerId ?? null,
        runLease: options.sessionRunLease ?? null,
      }
    },
    async resolveAlias() {
      return {
        alias: 'main_operator_test',
        modelResolutionSnapshot: modelSnapshot(),
      }
    },
    async getActiveRun() { return null },
    async getActiveJob() { return activeJob?.active_key ? activeJob : null },
    async getJob(jobId) {
      if (activeJob?.job_id === jobId) return activeJob
      return historicalJobs.find(job => job.job_id === jobId) ?? null
    },
    async enqueue(input: EnqueueCompactionInput) {
      enqueueCalls += 1
      const prior = [activeJob, ...historicalJobs].find(
        job => job?.idempotency_keys.includes(input.idempotencyKey),
      )
      if (prior) return prior
      if (activeJob?.active_key) {
        activeJob = {
          ...activeJob,
          idempotency_keys: Array.from(new Set([
            ...activeJob.idempotency_keys,
            input.idempotencyKey,
          ])),
        }
        return activeJob
      }
      if (activeJob) {
        historicalJobs.push(activeJob)
        activeJob = null
      }
      const prefix = Array.from(input.prefixMessages ?? [], message => structuredClone(message))
      // The operator verifies the repository's canonical prefix hash. Reuse
      // the selected report value through the stable command key suffix.
      const hash = input.idempotencyKey.split(':').at(-1)!
      activeJob = fakeJob({
        idempotencyKey: input.idempotencyKey,
        prefix,
        prefixHash: hash,
        availableAt: input.initialAvailableAt!,
        modelResolutionSnapshot: input.modelResolutionSnapshot,
      })
      if (options.returnDifferentJoinedWinner) {
        const competingPrefix = prefix.slice(0, Math.max(1, prefix.length - 1))
        activeJob = {
          ...activeJob,
          job_id: 'cmpjob_competing_winner',
          idempotency_key: 'competing-trigger-key',
          idempotency_keys: ['competing-trigger-key', input.idempotencyKey],
          frozen_prefix: {
            ...activeJob.frozen_prefix,
            prefix_length: competingPrefix.length,
            prefix_hash: createHash('sha256')
              .update(JSON.stringify(competingPrefix))
              .digest('hex'),
            boundary_message_id: competingPrefix.at(-1)?.message_id,
            messages: competingPrefix,
          },
        }
      }
      if (options.returnExactCancelledPrior) {
        activeJob = {
          ...activeJob,
          status: 'cancelled',
          active_key: null,
          finished_at: fixedNow,
        }
      }
      if (options.returnExactLeasedQueuedWinner) {
        activeJob = {
          ...activeJob,
          lease: {
            owner_id: 'worker_exact_winner',
            fence_token: 'fence_exact_winner',
            heartbeat_at: fixedNow,
            expires_at: new Date(fixedNow.getTime() + 60_000),
          },
        }
      }
      if (options.rootStatusAfterEnqueue && !rootStatusAfterEnqueueApplied) {
        rootStatus = options.rootStatusAfterEnqueue
        rootStatusAfterEnqueueApplied = true
      }
      if (options.claimBeforeRollback) {
        activeJob = {
          ...activeJob,
          status: 'summarizing',
          lease: {
            owner_id: 'worker_race',
            fence_token: 'fence_race',
            heartbeat_at: fixedNow,
            expires_at: new Date(fixedNow.getTime() + 60_000),
          },
        }
      }
      return activeJob
    },
    async activate(input) {
      activateCalls += 1
      if (!activeJob || !activeJob.idempotency_keys.includes(input.idempotencyKey)) {
        throw new Error('Compaction Job command rejected.')
      }
      if (options.claimBeforeActivate) {
        activeJob = {
          ...activeJob,
          status: 'summarizing',
          lease: {
            owner_id: 'worker_activate_race',
            fence_token: 'fence_activate_race',
            heartbeat_at: fixedNow,
            expires_at: new Date(fixedNow.getTime() + 60_000),
          },
        }
        throw new Error('Compaction Job is no longer an active, unclaimed queued barrier.')
      }
      const wasFuture = (activeJob.available_at?.getTime() ?? 0) > fixedNow.getTime()
      activeJob = { ...activeJob, available_at: new Date(fixedNow) }
      return { job: activeJob, changed: wasFuture }
    },
    async cancelPrepared(input) {
      cancelCalls += 1
      if (!activeJob || !activeJob.idempotency_keys.includes(input.idempotencyKey)) {
        throw new Error('Compaction Job command rejected.')
      }
      if (activeJob.status !== 'queued' || activeJob.lease) {
        return { job: activeJob, changed: false }
      }
      activeJob = {
        ...activeJob,
        status: 'cancelled',
        active_key: null,
        last_error: input.reason,
        finished_at: fixedNow,
      }
      return { job: activeJob, changed: true }
    },
  }
  return {
    dependencies,
    get enqueueCalls() { return enqueueCalls },
    get activateCalls() { return activateCalls },
    get cancelCalls() { return cancelCalls },
    get activeJob() { return activeJob },
    get jobs() {
      return [...historicalJobs, ...(activeJob ? [activeJob] : [])]
    },
    setRootStatus(status: 'running' | 'idle' | 'paused' | 'completed' | 'failed') {
      rootStatus = status
    },
  }
}

async function main(): Promise<void> {
  const repairAttemptId = 'rpa_11111111111111111111111111111111'
  assert.deepEqual(
    parseRepairDurableCompactionArgs(['--conversation', 'conversation_operator_test']),
    { mode: 'dry-run', conversationId: 'conversation_operator_test', notBeforeMinutes: 10 },
  )
  assert.deepEqual(
    parseRepairDurableCompactionArgs([
      '--prepare', '--conversation', 'conversation_operator_test',
      '--not-before-minutes', '15', '--repair-attempt-id', repairAttemptId,
    ]),
    {
      mode: 'prepare',
      conversationId: 'conversation_operator_test',
      notBeforeMinutes: 15,
      repairAttemptId,
    },
  )
  assert.throws(
    () => parseRepairDurableCompactionArgs([
      '--prepare', '--conversation', 'conversation_operator_test',
    ]),
    /requires --repair-attempt-id from a fresh dry-run/,
  )
  assert.throws(
    () => parseRepairDurableCompactionArgs([
      '--prepare', '--conversation', 'conversation_operator_test',
      '--repair-attempt-id', 'rpa_NOT_HEX',
    ]),
    /32 lowercase hex/,
  )
  assert.deepEqual(parseRepairDurableCompactionArgs(['--help']), { mode: 'help' })
  assert.throws(
    () => parseRepairDurableCompactionArgs(['--activate', '--job', 'cmpjob']),
    /idempotency-key/,
  )

  assert.equal(isSafeRepairPrefixBoundary(closedToolHistory, 4), false)
  assert.equal(isSafeRepairPrefixBoundary(closedToolHistory, 5), true)
  assert.throws(() => selectSafeRepairCompactionPrefix({
    messages: [
      textMessage('orphan_01', 'user', 'question'),
      {
        role: 'user',
        message_id: 'orphan_02',
        content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'orphan' }],
      },
      textMessage('orphan_03', 'assistant', 'tail'),
    ],
    contextWindow: 100_000,
    compactionMaxOutputTokens: 4_000,
    staticOverheadTokens: 100,
  }), /Orphan/)
  const staticOverheadTokens = 100
  const fiveMessageEstimate = estimateRepairCompactionRequestTokens(
    closedToolHistory.slice(0, 5),
    staticOverheadTokens,
  ).total
  const selected = selectSafeRepairCompactionPrefix({
    messages: closedToolHistory,
    contextWindow: fiveMessageEstimate + 2_000 + REPAIR_COMPACTION_SAFETY_MARGIN_TOKENS,
    compactionMaxOutputTokens: 2_000,
    staticOverheadTokens,
  })
  assert.equal(selected.prefixLength, 5)
  assert.equal(selected.tailLength, 2)
  assert.equal(selected.boundaryMessageId, 'm05')
  assert.ok(selected.estimatedRequestTokens <= selected.requestLimitTokens)
  assert.ok(selected.messages[3].content.some(block => block.type === 'tool_use'))
  assert.ok(selected.messages[4].content.some(block => block.type === 'tool_result'))

  const dryRunState = createInMemoryDependencies()
  const dryRun = await executeRepairDurableCompactionCommand({
    mode: 'dry-run',
    conversationId: 'conversation_operator_test',
    notBeforeMinutes: 10,
  }, dryRunState.dependencies)
  assert.equal(dryRun.write_performed, false)
  assert.equal(dryRunState.enqueueCalls, 0)
  assert.match(String(dryRun.repair_attempt_id), /^rpa_[a-f0-9]{32}$/)
  assert.ok(String(dryRun.idempotency_key).includes(String(dryRun.repair_attempt_id)))

  for (const rootStatus of ['running', 'failed'] as const) {
    const unsafeRoot = createInMemoryDependencies({ rootStatus })
    await assert.rejects(
      executeRepairDurableCompactionCommand({
        mode: 'prepare',
        conversationId: 'conversation_operator_test',
        notBeforeMinutes: 10,
        repairAttemptId,
      }, unsafeRoot.dependencies),
      new RegExp(`Root TeamAgent is ${rootStatus}`),
    )
    assert.equal(unsafeRoot.enqueueCalls, 0)
  }

  const runtimeLease = createInMemoryDependencies({
    runtimeActiveLeaseOwnerId: 'runtime_owner_must_not_leak',
  })
  await assert.rejects(
    executeRepairDurableCompactionCommand({
      mode: 'prepare',
      conversationId: 'conversation_operator_test',
      notBeforeMinutes: 10,
      repairAttemptId,
    }, runtimeLease.dependencies),
    /ConversationRuntime has an active lease owner/,
  )
  assert.equal(runtimeLease.enqueueCalls, 0)

  for (const sessionState of [
    { sessionActiveRunId: 'run_live' },
    { sessionActiveLeaseOwnerId: 'session_owner_live' },
    {
      sessionRunLease: {
        owner_id: 'session_owner_live',
        fence_token: 'session_fence_live',
        expires_at: new Date(fixedNow.getTime() + 60_000),
      },
    },
  ]) {
    const activeSession = createInMemoryDependencies(sessionState)
    await assert.rejects(
      executeRepairDurableCompactionCommand({
        mode: 'prepare',
        conversationId: 'conversation_operator_test',
        notBeforeMinutes: 10,
        repairAttemptId,
      }, activeSession.dependencies),
      /Current Root AgentSession has an active Run or lease/,
    )
    assert.equal(activeSession.enqueueCalls, 0)
  }

  const revalidationRace = createInMemoryDependencies({ rootStatusAfterEnqueue: 'running' })
  const firstRepairDryRun = await executeRepairDurableCompactionCommand({
    mode: 'dry-run',
    conversationId: 'conversation_operator_test',
    notBeforeMinutes: 10,
  }, revalidationRace.dependencies)
  const firstRepairAttemptId = String(firstRepairDryRun.repair_attempt_id)
  await assert.rejects(
    executeRepairDurableCompactionCommand({
      mode: 'prepare',
      conversationId: 'conversation_operator_test',
      notBeforeMinutes: 10,
      repairAttemptId: firstRepairAttemptId,
    }, revalidationRace.dependencies),
    /safely cancelled/,
  )
  assert.equal(revalidationRace.enqueueCalls, 1)
  assert.equal(revalidationRace.cancelCalls, 1)
  assert.equal(revalidationRace.activeJob?.status, 'cancelled')
  assert.equal(Boolean(revalidationRace.activeJob?.active_key), false)
  const firstCancelledJobId = revalidationRace.activeJob?.job_id

  revalidationRace.setRootStatus('idle')
  const cancelCallsAfterFirstAttempt = revalidationRace.cancelCalls
  await assert.rejects(
    executeRepairDurableCompactionCommand({
      mode: 'prepare',
      conversationId: 'conversation_operator_test',
      notBeforeMinutes: 10,
      repairAttemptId: firstRepairAttemptId,
    }, revalidationRace.dependencies),
    /exact active, unclaimed queued CompactionJob intent.*manual intervention/,
  )
  assert.equal(revalidationRace.cancelCalls, cancelCallsAfterFirstAttempt)
  assert.equal(revalidationRace.activeJob?.status, 'cancelled')
  assert.equal(revalidationRace.activeJob?.active_key, null)
  assert.equal(revalidationRace.activeJob?.job_id, firstCancelledJobId)

  const secondDryRun = await executeRepairDurableCompactionCommand({
    mode: 'dry-run',
    conversationId: 'conversation_operator_test',
    notBeforeMinutes: 10,
  }, revalidationRace.dependencies)
  const secondAttemptId = String(secondDryRun.repair_attempt_id)
  assert.notEqual(secondAttemptId, firstRepairAttemptId)
  const retried = await executeRepairDurableCompactionCommand({
    mode: 'prepare',
    conversationId: 'conversation_operator_test',
    notBeforeMinutes: 10,
    repairAttemptId: secondAttemptId,
  }, revalidationRace.dependencies)
  const retriedJobId = String((retried.job as Record<string, unknown>).job_id)
  assert.equal(retried.write_performed, true)
  assert.equal(revalidationRace.activeJob?.status, 'queued')
  assert.ok(revalidationRace.activeJob?.active_key)
  assert.ok(String(retried.idempotency_key).includes(secondAttemptId))
  const cancelledFirstAttempt = revalidationRace.jobs.find(
    job => job.idempotency_keys.some(key => key.includes(firstRepairAttemptId)),
  )
  assert.equal(cancelledFirstAttempt?.status, 'cancelled')
  assert.equal(cancelledFirstAttempt?.active_key, null)
  assert.equal(cancelledFirstAttempt?.job_id, firstCancelledJobId)
  assert.notEqual(cancelledFirstAttempt?.job_id, retriedJobId)

  const retriedReplay = await executeRepairDurableCompactionCommand({
    mode: 'prepare',
    conversationId: 'conversation_operator_test',
    notBeforeMinutes: 10,
    repairAttemptId: secondAttemptId,
  }, revalidationRace.dependencies)
  assert.equal(retriedReplay.write_performed, false)
  assert.equal(
    (retriedReplay.job as Record<string, unknown>).job_id,
    retriedJobId,
  )
  assert.equal(revalidationRace.jobs.length, 2)

  const differentJoinedWinner = createInMemoryDependencies({
    returnDifferentJoinedWinner: true,
  })
  await assert.rejects(
    executeRepairDurableCompactionCommand({
      mode: 'prepare',
      conversationId: 'conversation_operator_test',
      notBeforeMinutes: 10,
      repairAttemptId,
    }, differentJoinedWinner.dependencies),
    /exact active, unclaimed queued CompactionJob intent.*manual intervention/,
  )
  assert.equal(differentJoinedWinner.enqueueCalls, 1)
  assert.equal(differentJoinedWinner.cancelCalls, 0)
  assert.equal(differentJoinedWinner.activeJob?.job_id, 'cmpjob_competing_winner')
  assert.equal(differentJoinedWinner.activeJob?.status, 'queued')
  assert.equal(
    differentJoinedWinner.activeJob?.active_key,
    'conversation:conversation_operator_test',
  )
  assert.match(
    differentJoinedWinner.activeJob?.idempotency_keys.at(-1) ?? '',
    /^operator-repair:/,
  )

  for (const priorOption of [
    { returnExactCancelledPrior: true },
    { returnExactLeasedQueuedWinner: true },
  ]) {
    const unsafeExactPrior = createInMemoryDependencies(priorOption)
    await assert.rejects(
      executeRepairDurableCompactionCommand({
        mode: 'prepare',
        conversationId: 'conversation_operator_test',
        notBeforeMinutes: 10,
        repairAttemptId: 'rpa_33333333333333333333333333333333',
      }, unsafeExactPrior.dependencies),
      /exact active, unclaimed queued CompactionJob intent.*manual intervention/,
    )
    assert.equal(unsafeExactPrior.cancelCalls, 0)
    if ('returnExactCancelledPrior' in priorOption) {
      assert.equal(unsafeExactPrior.activeJob?.status, 'cancelled')
      assert.equal(unsafeExactPrior.activeJob?.active_key, null)
    } else {
      assert.equal(unsafeExactPrior.activeJob?.status, 'queued')
      assert.ok(unsafeExactPrior.activeJob?.lease)
    }
  }

  const claimedRollbackRace = createInMemoryDependencies({
    rootStatusAfterEnqueue: 'running',
    claimBeforeRollback: true,
  })
  await assert.rejects(
    executeRepairDurableCompactionCommand({
      mode: 'prepare',
      conversationId: 'conversation_operator_test',
      notBeforeMinutes: 10,
      repairAttemptId,
    }, claimedRollbackRace.dependencies),
    /manual intervention is required/,
  )
  assert.equal(claimedRollbackRace.cancelCalls, 0)
  assert.equal(claimedRollbackRace.activeJob?.status, 'summarizing')

  const state = createInMemoryDependencies()
  const prepared = await executeRepairDurableCompactionCommand({
    mode: 'prepare',
    conversationId: 'conversation_operator_test',
    notBeforeMinutes: 10,
    repairAttemptId,
  }, state.dependencies)
  assert.equal(prepared.write_performed, true)
  assert.equal(state.enqueueCalls, 1)
  const preparedJob = prepared.job as Record<string, unknown>
  const jobId = String(preparedJob.job_id)
  const idempotencyKey = String(prepared.idempotency_key)
  assert.equal(
    state.activeJob?.model_resolution_snapshot?.registry_hash,
    modelSnapshot().registry_hash,
  )
  assert.equal(
    state.activeJob?.model_resolution_snapshot?.context_window,
    modelSnapshot().context_window,
  )
  const preparedOutput = JSON.stringify(prepared)
  assert.doesNotMatch(preparedOutput, /operator-real-model/)
  assert.equal(preparedOutput.includes(modelSnapshot().registry_hash), false)
  assert.doesNotMatch(preparedOutput, /key_channel|orchestrator/)

  const replay = await executeRepairDurableCompactionCommand({
    mode: 'prepare',
    conversationId: 'conversation_operator_test',
    notBeforeMinutes: 10,
    repairAttemptId,
  }, state.dependencies)
  assert.equal(replay.write_performed, false)
  assert.equal(state.enqueueCalls, 2)
  assert.equal((replay.job as Record<string, unknown>).job_id, jobId)

  await assert.rejects(
    executeRepairDurableCompactionCommand({
      mode: 'activate',
      jobId,
      idempotencyKey: 'wrong-key',
    }, state.dependencies),
    /rejected/,
  )
  assert.equal(state.activateCalls, 1)

  const status = await executeRepairDurableCompactionCommand({
    mode: 'status',
    jobId,
  }, state.dependencies)
  assert.equal(status.write_performed, false)
  assert.doesNotMatch(JSON.stringify(status), /SECRET SUMMARY|SECRET ERROR/)
  assert.doesNotMatch(JSON.stringify(status), /operator-real-model|key_channel/)
  assert.equal(JSON.stringify(status).includes(modelSnapshot().registry_hash), false)

  const activated = await executeRepairDurableCompactionCommand({
    mode: 'activate',
    jobId,
    idempotencyKey,
  }, state.dependencies)
  assert.equal(activated.write_performed, true)
  assert.equal(state.activateCalls, 2)

  const activationRace = createInMemoryDependencies({ claimBeforeActivate: true })
  const racePrepared = await executeRepairDurableCompactionCommand({
    mode: 'prepare',
    conversationId: 'conversation_operator_test',
    notBeforeMinutes: 10,
    repairAttemptId,
  }, activationRace.dependencies)
  await assert.rejects(
    executeRepairDurableCompactionCommand({
      mode: 'activate',
      jobId: String((racePrepared.job as Record<string, unknown>).job_id),
      idempotencyKey: String(racePrepared.idempotency_key),
    }, activationRace.dependencies),
    /no longer an active, unclaimed queued barrier/,
  )
  assert.equal(activationRace.activeJob?.status, 'summarizing')
  assert.ok(activationRace.activeJob?.lease)

  console.log('durable compaction operator repair verification passed')
}

void main()
