import assert from 'node:assert/strict'
import {
  HippocampusRuntime,
  HippocampusTelemetry,
  resolveHippocampusBudget,
} from '../hippocampus-runtime'
import type { ConversationMessage } from '../../types'
import type { AgentProvider } from '../loop'
import { agentLoop } from '../loop'
import type { WorkspaceInstance } from '../../workspace/types'
import {
  isPromptTooLongLLMError,
  isRetryableLLMTransportFailure,
  LLMAPIError,
} from '../llm-api'

function verifyPromptTooLongClassification(): void {
  assert.equal(isPromptTooLongLLMError(new LLMAPIError(413, 'payload too large', 'model')), true)
  assert.equal(isPromptTooLongLLMError(new LLMAPIError(400, 'prompt exceeds maximum context length', 'model')), true)
  assert.equal(isPromptTooLongLLMError(new Error('413 prompt too long')), true)

  const incident = new LLMAPIError(
    400,
    '{"error":{"message":"Provider returned error (request id: 202608280441397227011608268d9d65ajvd21Q)"}}',
    'Claude-opus-4.6',
  )
  assert.equal(
    isPromptTooLongLLMError(incident),
    false,
    'digits inside an opaque request id must never be interpreted as HTTP 413',
  )
}

function verifyTransportRetryClassification(): void {
  assert.equal(isRetryableLLMTransportFailure(500, ''), true)
  assert.equal(isRetryableLLMTransportFailure(503, 'unavailable'), true)
  assert.equal(isRetryableLLMTransportFailure(422, 'Upstream request error'), true)
  assert.equal(isRetryableLLMTransportFailure(422, 'Provider returned error'), true)
  assert.equal(
    isRetryableLLMTransportFailure(400, 'Provider returned error'),
    false,
    'opaque HTTP 400 may be a deterministic payload failure and must not be replayed',
  )
}

function verifySecondRequestColdCompactionProfile(): void {
  const firstLoop = new HippocampusTelemetry()
  firstLoop.recordMain(8_618, 7_178, 127, 4_300)
  const secondLoop = new HippocampusTelemetry(firstLoop.snapshot())

  const budget = resolveHippocampusBudget(
    {
      contextWindow: 200_000,
      staticOverheadTokens: 7_177,
      mainMaxOutputTokens: 32_768,
      summaryMaxTokens: 8_000,
      forkInstructionTokens: 588,
    },
    // Reproduces the report across POSTs: first response emitted 127 tokens
    // in ~4.3s, while no real compaction-duration sample exists yet.
    secondLoop.profile(),
  )

  assert.equal(budget.mainInputLimitTokens, 167_232)
  assert.equal(budget.observationGateTokens, 83_616)
  assert.equal(budget.triggerTokens, 83_616)
  assert.equal(budget.swapTokens, 167_232)
  assert.ok(budget.rawTriggerTokens < 0)
  assert.equal(budget.observationGateConstrained, true)
  assert.ok(budget.maxContextGrowthTokensAtGate > 0)
}

function verifyStableConversationGrowthTelemetry(): void {
  const telemetry = new HippocampusTelemetry()

  telemetry.recordMain(1_000, 900, 200, 2_000)
  telemetry.recordMain(1_240, 1_100, 180, 2_000)

  const state = telemetry.snapshot()
  const profile = telemetry.profile()
  assert.deepEqual(state.inputGrowth, [240])
  assert.equal(profile.mainContextGrowthTokensPerTurn, 240)
}

function verifyApiAnchorPlusLocalDeltaAcrossRequests(): void {
  const firstLoop = new HippocampusTelemetry()
  firstLoop.recordMain(8_618, 7_178, 127, 4_300)

  assert.equal(firstLoop.inputTokenCorrection(), 1_440)
  assert.equal(firstLoop.estimateCurrentInput(7_400), 8_840)

  // A new human message creates a new agent-loop instance. The persisted pair
  // must reproduce the same correction instead of falling back to raw local.
  const secondLoop = new HippocampusTelemetry(firstLoop.snapshot())
  assert.equal(secondLoop.inputTokenCorrection(), 1_440)
  assert.equal(secondLoop.estimateCurrentInput(7_400), 8_840)
}

function verifyNormalBudgetInvariants(): void {
  const budget = resolveHippocampusBudget(
    {
      contextWindow: 200_000,
      staticOverheadTokens: 8_000,
      mainMaxOutputTokens: 32_768,
      summaryMaxTokens: 8_000,
      forkInstructionTokens: 600,
    },
    {
      mainTps: 80,
      compactionDurationSeconds: 25,
      mainOutputTokensPerTurn: 1_000,
      mainContextGrowthTokensPerTurn: 2_000,
      mainContextGrowthPeakTokensPerTurn: 2_500,
    },
  )

  assert.ok(budget.triggerTokens >= budget.observationGateTokens)
  assert.ok(budget.triggerTokens < budget.swapTokens)
  assert.equal(
    budget.mainInputLimitTokens + budget.mainMaxOutputTokens,
    budget.contextWindow,
  )
  assert.ok(budget.swapTokens <= budget.mainInputLimitTokens)
  assert.ok(budget.forkPrefixLimitTokens > budget.staticTokens)
}

function countTextTokens(messages: readonly ConversationMessage[]): number {
  return messages.reduce((total, message) => total + message.content.reduce((sum, block) => (
    block.type === 'text' ? sum + block.text.length : sum
  ), 0), 0)
}

function largeMessage(): ConversationMessage[] {
  return [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(890) }] }]
}

function runtimeConfig(
  compact: ConstructorParameters<typeof HippocampusRuntime>[0]['compact'],
  events: ConstructorParameters<typeof HippocampusRuntime>[0]['events'],
  overrides: Partial<ConstructorParameters<typeof HippocampusRuntime>[0]> = {},
): ConstructorParameters<typeof HippocampusRuntime>[0] {
  return {
    contextWindow: 1_000,
    staticOverheadTokens: 0,
    mainMaxOutputTokens: 100,
    summaryMaxTokens: 50,
    forkInstructionTokens: 10,
    compact,
    events,
    estimateInputTokens: countTextTokens,
    timing: () => ({
      mainTps: 100,
      compactionTps: 100,
      compactionDurationSeconds: 1,
      mainOutputTokensPerTurn: 100,
      mainContextGrowthTokensPerTurn: 10,
      mainContextGrowthPeakTokensPerTurn: 10,
    }),
    ...overrides,
  }
}

function durableSourceTurnGuardHooks() {
  return {
    async onBackgroundCompactionAcquireSourceTurnGuard() {
      return {
        guardToken: 'source-turn-guard',
        expiresAt: new Date(Date.now() + 60_000),
      }
    },
    async onBackgroundCompactionHeartbeatSourceTurnGuard() {
      return { expiresAt: new Date(Date.now() + 60_000) }
    },
    async onBackgroundCompactionReleaseSourceTurnGuard() {
      return true
    },
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function verifyShadowPreparePrecedesLocalProviderAndIgnoresParentAbort(): Promise<void> {
  const parent = new AbortController()
  const order: string[] = []
  let resolveCompaction!: (value: {
    summary: string
    wrappedMessage: ConversationMessage
  }) => void
  const compacted = new Promise<{
    summary: string
    wrappedMessage: ConversationMessage
  }>(resolve => { resolveCompaction = resolve })
  let preparedAvailableAt: Date | undefined
  const runtime = new HippocampusRuntime(runtimeConfig(
    async () => {
      order.push('provider')
      return compacted
    },
    {
      async onStart(info) {
        order.push('prepare')
        preparedAvailableAt = info.initialAvailableAt
        assert.equal(info.prefixMessages.length, 1)
        await Promise.resolve()
      },
    },
    {
      parentSignal: parent.signal,
      backgroundTimeoutMs: 5_000,
    },
  ))
  const messages = largeMessage()
  assert.equal((await runtime.beforeRequest(messages)).action, 'started')
  assert.deepEqual(order, ['prepare', 'provider'])
  assert.ok(preparedAvailableAt instanceof Date)

  parent.abort('parent Run stopped')
  resolveCompaction({
    summary: 'short',
    wrappedMessage: { role: 'user', content: [{ type: 'text', text: 'short' }] },
  })
  const exit = await runtime.onLoopExit(messages)
  assert.equal(exit.status, 'merged', 'parent Run abort must not cancel background ownership')
}

async function verifyExpiredShadowDeadlineNeverStartsLocalProvider(): Promise<void> {
  let localProviderCalls = 0
  const runtime = new HippocampusRuntime(runtimeConfig(
    async () => {
      localProviderCalls += 1
      return {
        summary: 'must not run',
        wrappedMessage: { role: 'user', content: [{ type: 'text', text: 'must not run' }] },
      }
    },
    {
      async onStart() {
        await new Promise(resolve => setTimeout(resolve, 5))
      },
    },
    { backgroundTimeoutMs: 1 },
  ))
  const messages = largeMessage()
  assert.equal(
    (await runtime.beforeRequest(messages)).action,
    'sync-fallback',
    'an expired shadow-preparation deadline must block the next main-provider request',
  )
  assert.equal(localProviderCalls, 0)
  assert.equal((await runtime.onLoopExit(messages)).status, 'failed')
}

async function verifyNormalExitDrainsAndMerges(): Promise<void> {
  let resolveCompaction!: (value: {
    summary: string
    wrappedMessage: ConversationMessage
  }) => void
  const compacted = new Promise<{
    summary: string
    wrappedMessage: ConversationMessage
  }>(resolve => { resolveCompaction = resolve })
  const terminal: string[] = []
  const runtime = new HippocampusRuntime(runtimeConfig(
    () => compacted,
    { onDone: info => terminal.push(info.status) },
  ))
  const messages = largeMessage()
  assert.equal((await runtime.beforeRequest(messages)).action, 'started')

  let exited = false
  const exitPromise = runtime.onLoopExit(messages).then(result => {
    exited = true
    return result
  })
  await Promise.resolve()
  assert.equal(exited, false, 'normal loop exit must not cancel an unfinished summary')

  resolveCompaction({
    summary: 'short',
    wrappedMessage: { role: 'user', content: [{ type: 'text', text: 'short' }] },
  })
  const exit = await exitPromise
  assert.equal(exit.status, 'merged')
  assert.equal(exit.merged, true)
  assert.equal(countTextTokens(messages), 5)
  assert.deepEqual(terminal, ['merged'])
}

async function verifyDurableHandoffIsNotCancellation(): Promise<void> {
  const terminal: string[] = []
  let handedOff = 0
  const runtime = new HippocampusRuntime(runtimeConfig(
    (_prefix, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('local worker stopped')), { once: true })
    }),
    {
      onDone: info => terminal.push(info.status),
      onHandoff: () => { handedOff += 1 },
    },
  ))
  const messages = largeMessage()
  assert.equal((await runtime.beforeRequest(messages)).action, 'started')
  const exit = await runtime.onLoopExit(messages, snapshot => {
    assert.equal(snapshot.prefixTokens, 890)
    assert.equal(snapshot.prefixLength, 1)
    return true
  })

  assert.equal(exit.status, 'handed_off')
  assert.equal(exit.merged, false)
  assert.equal(countTextTokens(messages), 890)
  assert.equal(handedOff, 1)
  assert.deepEqual(terminal, [], 'handoff keeps logical compaction alive in the durable owner')
}

async function verifyFailedAndCancelledAreDistinct(): Promise<void> {
  const failed: string[] = []
  const failingRuntime = new HippocampusRuntime(runtimeConfig(
    async () => { throw new Error('summary provider failed') },
    { onDone: info => failed.push(info.status) },
  ))
  const failedMessages = largeMessage()
  assert.equal((await failingRuntime.beforeRequest(failedMessages)).action, 'sync-fallback')
  assert.equal((await failingRuntime.onLoopExit(failedMessages)).status, 'failed')
  assert.deepEqual(failed, ['failed'])

  const cancelled: string[] = []
  const cancelledRuntime = new HippocampusRuntime(runtimeConfig(
    (_prefix, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }),
    { onDone: info => cancelled.push(info.status) },
  ))
  const cancelledMessages = largeMessage()
  assert.equal((await cancelledRuntime.beforeRequest(cancelledMessages)).action, 'started')
  cancelledRuntime.abort('interrupt')
  assert.deepEqual(cancelled, ['cancelled'])
}

async function verifyAgentLoopHandsOffWithoutFalseDone(): Promise<void> {
  const provider: AgentProvider = {
    toolSchemas: [],
    buildRequest: () => ({}),
    buildCompactionRequest: () => ({}),
    async callLLM() {
      return {
        content: [{ type: 'text', text: 'main response is complete' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5_000, output_tokens: 20 },
      }
    },
    async callLLMSilent(_request, signal) {
      return await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('local compaction stopped')), {
          once: true,
        })
      })
    },
    async executeTool() {
      return { content: '' }
    },
  }
  const workspace = {
    list: () => [],
    stat: async () => null,
  } as unknown as WorkspaceInstance
  let doneEvents = 0
  let settledEvents = 0
  let prepares = 0
  let activations = 0
  const actionKinds: string[] = []
  const lifecycleOrder: string[] = []

  const result = await agentLoop(provider, [{
    role: 'user',
    content: [{ type: 'text', text: 'x'.repeat(18_000) }],
    message_id: 'boundary-message',
  }], {
    runId: 'run-handoff',
    model: 'resolved-model-snapshot',
    modelAlias: 'model-alias-snapshot',
    workspace,
    contextWindow: 10_000,
    mainMaxOutputTokens: 1_000,
    summaryMaxTokens: 500,
    ...durableSourceTurnGuardHooks(),
    onCompactionDone: () => { doneEvents += 1 },
    onCompactionSettled: () => { settledEvents += 1 },
    onCompactionCheckpoint: checkpoint => {
      lifecycleOrder.push(`checkpoint:${checkpoint.status}`)
    },
    onActionStart: action => { actionKinds.push(action.kind) },
    async onBackgroundCompactionPrepare(descriptor) {
      prepares += 1
      lifecycleOrder.push('prepare')
      assert.match(descriptor.idempotencyKey, /^cmp_/)
      assert.equal(descriptor.sourceRunId, 'run-handoff')
      assert.equal(descriptor.modelAliasSnapshot, 'model-alias-snapshot')
      assert.equal(descriptor.modelIdSnapshot, 'resolved-model-snapshot')
      assert.equal(descriptor.prefixLength, 1)
      assert.equal(descriptor.boundaryMessageId, 'boundary-message')
      assert.ok(descriptor.initialAvailableAt instanceof Date)
      return { jobId: 'durable-job' }
    },
    async onBackgroundCompactionActivate(input) {
      activations += 1
      assert.equal(input.jobId, 'durable-job')
      assert.match(input.idempotencyKey, /^cmp_/)
      return true
    },
    async onBackgroundCompactionOfferSummary() {
      throw new Error('unfinished local summary must not be offered')
    },
    async onBackgroundCompactionPause() {
      throw new Error('completed Root turn does not need to be paused')
    },
  })

  assert.equal(result.text, 'main response is complete')
  assert.equal(result.compacted, false)
  assert.equal(prepares, 1)
  assert.equal(activations, 1)
  assert.ok(
    lifecycleOrder.indexOf('prepare') < lifecycleOrder.indexOf('checkpoint:started'),
    'durable shadow must exist before the transient Run checkpoint',
  )
  assert.equal(doneEvents, 0)
  assert.equal(settledEvents, 0)
  assert.deepEqual(actionKinds, ['model_request'])
}

async function verifyCancellationFlushesToolPairThenActivatesShadow(): Promise<void> {
  const provider: AgentProvider = {
    toolSchemas: [{
      name: 'Read',
      description: 'read',
      input_schema: { type: 'object', properties: {} },
    }],
    buildRequest: () => ({}),
    buildCompactionRequest: () => ({}),
    async callLLM() {
      return {
        content: [{ type: 'tool_use', id: 'tool-after-abort', name: 'Read', input: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 5_000, output_tokens: 20 },
      }
    },
    async callLLMSilent(_request, signal) {
      return await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('local stopped after handoff')), {
          once: true,
        })
      })
    },
    async executeTool() {
      throw new Error('cancelled tool must not execute')
    },
  }
  const workspace = {
    list: () => [],
    stat: async () => null,
  } as unknown as WorkspaceInstance
  let cancellationChecks = 0
  let prepareCount = 0
  let activateCount = 0
  let guardReleaseCount = 0
  const persisted: ConversationMessage[] = []
  const result = await agentLoop(provider, [{
    role: 'user',
    content: [{ type: 'text', text: 'x'.repeat(18_000) }],
    message_id: 'cancel-boundary',
  }], {
    runId: 'run-cancel-shadow',
    model: 'resolved-model',
    modelAlias: 'alias-model',
    workspace,
    contextWindow: 10_000,
    mainMaxOutputTokens: 1_000,
    summaryMaxTokens: 500,
    ...durableSourceTurnGuardHooks(),
    async onBackgroundCompactionReleaseSourceTurnGuard() {
      guardReleaseCount += 1
      return true
    },
    isCancellationRequested: () => {
      cancellationChecks += 1
      return cancellationChecks >= 2
    },
    onTurnComplete: batch => { persisted.push(...structuredClone(batch)) },
    async onBackgroundCompactionPrepare() {
      prepareCount += 1
      return { jobId: 'cancel-shadow-job' }
    },
    async onBackgroundCompactionActivate(input) {
      activateCount += 1
      assert.equal(input.jobId, 'cancel-shadow-job')
      return true
    },
    async onBackgroundCompactionOfferSummary() {
      throw new Error('cancelled local summary must not be offered')
    },
    async onBackgroundCompactionPause() {
      throw new Error('cancelled Run finalizes through activate')
    },
  })

  assert.equal(result.aborted, true)
  assert.equal(prepareCount, 1)
  assert.equal(activateCount, 1)
  assert.equal(guardReleaseCount, 1)
  assert.equal(persisted.length, 2)
  assert.equal(persisted[0].role, 'assistant')
  assert.equal(persisted[1].role, 'user')
  assert.equal(persisted[1].content[0]?.type, 'tool_result')
}

async function verifyProviderFailurePreservesPrimaryErrorAndActivatesShadow(): Promise<void> {
  const providerFailure = new Error('main provider exploded')
  const serviceShutdown = new AbortController()
  const provider: AgentProvider = {
    toolSchemas: [],
    buildRequest: () => ({}),
    buildCompactionRequest: () => ({}),
    async callLLM() {
      serviceShutdown.abort('service shutdown')
      throw providerFailure
    },
    async callLLMSilent(_request, signal) {
      return await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('local stopped after handoff')), {
          once: true,
        })
      })
    },
    async executeTool() {
      return { content: '' }
    },
  }
  const workspace = {
    list: () => [],
    stat: async () => null,
  } as unknown as WorkspaceInstance
  let prepareCount = 0
  let activateCount = 0
  let guardReleaseCount = 0

  await assert.rejects(
    agentLoop(provider, [{
      role: 'user',
      content: [{ type: 'text', text: 'x'.repeat(18_000) }],
      message_id: 'error-boundary',
    }], {
      runId: 'run-error-shadow',
      abortSignal: serviceShutdown.signal,
      workspace,
      contextWindow: 10_000,
      mainMaxOutputTokens: 1_000,
      summaryMaxTokens: 500,
      ...durableSourceTurnGuardHooks(),
      async onBackgroundCompactionReleaseSourceTurnGuard() {
        guardReleaseCount += 1
        return true
      },
      async onBackgroundCompactionPrepare() {
        prepareCount += 1
        return { jobId: 'error-shadow-job' }
      },
      async onBackgroundCompactionActivate(input) {
        activateCount += 1
        assert.equal(input.jobId, 'error-shadow-job')
        return true
      },
      async onBackgroundCompactionOfferSummary() {
        throw new Error('failed local summary must not be offered')
      },
      async onBackgroundCompactionPause() {
        throw new Error('failed Run finalizes through activate')
      },
    }),
    error => error === providerFailure,
  )
  assert.equal(prepareCount, 1)
  assert.equal(activateCount, 1)
  assert.equal(guardReleaseCount, 1)
}

async function verifyFlushFailureReleasesGuardAndPreservesPrimaryError(): Promise<void> {
  const flushFailure = new Error('assistant checkpoint failed')
  let guardReleaseCount = 0
  const provider: AgentProvider = {
    toolSchemas: [],
    buildRequest: () => ({}),
    buildCompactionRequest: () => ({}),
    async callLLM() {
      return {
        content: [{ type: 'text', text: 'must be checkpointed' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5_000, output_tokens: 20 },
      }
    },
    async callLLMSilent(_request, signal) {
      return await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('durable handoff')), {
          once: true,
        })
      })
    },
    async executeTool() {
      return { content: '' }
    },
  }
  const workspace = {
    list: () => [],
    stat: async () => null,
  } as unknown as WorkspaceInstance

  await assert.rejects(agentLoop(provider, [{
    role: 'user',
    content: [{ type: 'text', text: 'x'.repeat(18_000) }],
    message_id: 'flush-failure-boundary',
  }], {
    runId: 'run-flush-failure',
    workspace,
    contextWindow: 10_000,
    mainMaxOutputTokens: 1_000,
    summaryMaxTokens: 500,
    ...durableSourceTurnGuardHooks(),
    async onBackgroundCompactionPrepare() {
      return { jobId: 'flush-failure-shadow' }
    },
    async onBackgroundCompactionActivate() {
      return true
    },
    async onBackgroundCompactionOfferSummary() {
      throw new Error('failed flush must hand off the original shadow')
    },
    async onBackgroundCompactionPause() {
      throw new Error('flush failure controls this exit')
    },
    async onBackgroundCompactionReleaseSourceTurnGuard() {
      guardReleaseCount += 1
      return true
    },
    async onTurnComplete() {
      throw flushFailure
    },
  }), error => error === flushFailure)
  assert.equal(guardReleaseCount, 1, 'outer finally releases the guard exactly once')
}

async function verifyLostGuardDropsProviderResponseBeforePersistence(): Promise<void> {
  const pause = new Error('stale source turn reloaded')
  let providerCalls = 0
  let persistedCalls = 0
  let releaseCalls = 0
  const provider: AgentProvider = {
    toolSchemas: [],
    buildRequest: () => ({}),
    buildCompactionRequest: () => ({}),
    async callLLM() {
      providerCalls += 1
      return {
        content: [{ type: 'text', text: 'stale response must not persist' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5_000, output_tokens: 20 },
      }
    },
    async callLLMSilent(_request, signal) {
      return await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('durable takeover')), {
          once: true,
        })
      })
    },
    async executeTool() {
      return { content: '' }
    },
  }
  const workspace = {
    list: () => [],
    stat: async () => null,
  } as unknown as WorkspaceInstance

  await assert.rejects(agentLoop(provider, [{
    role: 'user',
    content: [{ type: 'text', text: 'x'.repeat(18_000) }],
    message_id: 'lost-guard-boundary',
  }], {
    runId: 'run-lost-guard',
    workspace,
    contextWindow: 10_000,
    mainMaxOutputTokens: 1_000,
    summaryMaxTokens: 500,
    async onBackgroundCompactionPrepare() {
      return { jobId: 'lost-guard-shadow' }
    },
    async onBackgroundCompactionActivate() {
      return true
    },
    async onBackgroundCompactionOfferSummary() {
      throw new Error('worker owns the lost-guard shadow')
    },
    async onBackgroundCompactionPause() {
      throw pause
    },
    async onBackgroundCompactionAcquireSourceTurnGuard() {
      return {
        guardToken: 'guard-that-will-expire',
        expiresAt: new Date(Date.now() + 60_000),
      }
    },
    async onBackgroundCompactionHeartbeatSourceTurnGuard() {
      return null
    },
    async onBackgroundCompactionReleaseSourceTurnGuard() {
      releaseCalls += 1
      return false
    },
    async onTurnComplete() {
      persistedCalls += 1
    },
  }), error => error === pause)

  assert.equal(providerCalls, 1)
  assert.equal(persistedCalls, 0, 'lost guard is detected before assistant append/flush')
  assert.equal(releaseCalls, 1)
}

async function verifyReactive413ReleasesGuardBeforeDurablePause(): Promise<void> {
  const pause = new Error('413 deferred to durable compaction')
  let releaseCalls = 0
  let providerCalls = 0
  const provider: AgentProvider = {
    toolSchemas: [],
    buildRequest: () => ({}),
    buildCompactionRequest: () => ({}),
    async callLLM() {
      providerCalls += 1
      throw new Error('413 prompt too long')
    },
    async callLLMSilent(_request, signal) {
      return await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('durable takeover')), {
          once: true,
        })
      })
    },
    async executeTool() {
      return { content: '' }
    },
  }
  const workspace = {
    list: () => [],
    stat: async () => null,
  } as unknown as WorkspaceInstance

  await assert.rejects(agentLoop(provider, [
    {
      role: 'user',
      content: [{ type: 'text', text: 'x'.repeat(18_000) }],
      message_id: 'reactive-guard-history',
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'historical response' }],
      message_id: 'reactive-guard-boundary',
    },
  ], {
    runId: 'run-reactive-guard',
    workspace,
    contextWindow: 10_000,
    mainMaxOutputTokens: 1_000,
    summaryMaxTokens: 500,
    ...durableSourceTurnGuardHooks(),
    async onBackgroundCompactionPrepare() {
      return { jobId: 'reactive-guard-shadow' }
    },
    async onBackgroundCompactionActivate() {
      assert.equal(releaseCalls, 1, 'activation cannot race a live source-turn guard')
      return true
    },
    async onBackgroundCompactionOfferSummary() {
      throw new Error('413 should activate the existing shadow')
    },
    async onBackgroundCompactionPause() {
      assert.equal(releaseCalls, 1)
      throw pause
    },
    async onBackgroundCompactionReleaseSourceTurnGuard() {
      releaseCalls += 1
      return true
    },
  }), error => error === pause)

  assert.equal(providerCalls, 1)
  assert.equal(releaseCalls, 1)
}

async function verifyFirstTurn413PreservesTheOnlyUserRequest(): Promise<void> {
  const providerError = new LLMAPIError(413, 'prompt too large', 'test-model')
  let silentCalls = 0
  const provider: AgentProvider = {
    toolSchemas: [],
    buildRequest: () => ({}),
    buildCompactionRequest: () => ({}),
    async callLLM() {
      throw providerError
    },
    async callLLMSilent() {
      silentCalls += 1
      throw new Error('the only user request must not be summarized')
    },
    async executeTool() {
      return { content: '' }
    },
  }
  const workspace = {
    list: () => [],
    stat: async () => null,
  } as unknown as WorkspaceInstance

  await assert.rejects(agentLoop(provider, [{
    role: 'user',
    content: [{ type: 'text', text: 'preserve this exact request' }],
  }], {
    workspace,
    contextWindow: 10_000,
    mainMaxOutputTokens: 1_000,
    summaryMaxTokens: 500,
  }), error => error === providerError)

  assert.equal(silentCalls, 0)
}

async function verifyWorkerWinsGuardAcquireWithoutMainProviderCall(): Promise<void> {
  const pause = new Error('worker already owns delayed shadow')
  let providerCalls = 0
  const provider: AgentProvider = {
    toolSchemas: [],
    buildRequest: () => ({}),
    buildCompactionRequest: () => ({}),
    async callLLM() {
      providerCalls += 1
      throw new Error('provider must remain fenced')
    },
    async callLLMSilent(_request, signal) {
      return await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('worker takeover')), {
          once: true,
        })
      })
    },
    async executeTool() {
      return { content: '' }
    },
  }
  const workspace = {
    list: () => [],
    stat: async () => null,
  } as unknown as WorkspaceInstance

  await assert.rejects(agentLoop(provider, [{
    role: 'user',
    content: [{ type: 'text', text: 'x'.repeat(18_000) }],
    message_id: 'guard-loser-boundary',
  }], {
    runId: 'run-guard-loser',
    workspace,
    contextWindow: 10_000,
    mainMaxOutputTokens: 1_000,
    summaryMaxTokens: 500,
    async onBackgroundCompactionPrepare() {
      return { jobId: 'guard-loser-shadow' }
    },
    async onBackgroundCompactionActivate() {
      return true
    },
    async onBackgroundCompactionOfferSummary() {
      return false
    },
    async onBackgroundCompactionPause() {
      throw pause
    },
    async onBackgroundCompactionAcquireSourceTurnGuard() {
      return null
    },
    async onBackgroundCompactionHeartbeatSourceTurnGuard() {
      throw new Error('no guard was acquired')
    },
    async onBackgroundCompactionReleaseSourceTurnGuard() {
      throw new Error('no guard was acquired')
    },
  }), error => error === pause)

  assert.equal(providerCalls, 0)
}

async function verifyPrepareConflictFailsClosedBeforeLocalProvider(): Promise<void> {
  const conflict = new Error('exact durable prefix is already owned')
  let silentCalls = 0
  const provider: AgentProvider = {
    toolSchemas: [],
    buildRequest: () => ({}),
    buildCompactionRequest: () => ({}),
    async callLLM() {
      throw new Error('main provider must not run after prepare conflict')
    },
    async callLLMSilent() {
      silentCalls += 1
      throw new Error('local summary must not run after prepare conflict')
    },
    async executeTool() {
      return { content: '' }
    },
  }
  const workspace = {
    list: () => [],
    stat: async () => null,
  } as unknown as WorkspaceInstance

  await assert.rejects(agentLoop(provider, [{
    role: 'user',
    content: [{ type: 'text', text: 'x'.repeat(18_000) }],
  }], {
    workspace,
    contextWindow: 10_000,
    mainMaxOutputTokens: 1_000,
    summaryMaxTokens: 500,
    ...durableSourceTurnGuardHooks(),
    async onBackgroundCompactionPrepare() {
      throw conflict
    },
    async onBackgroundCompactionActivate() {
      return true
    },
    async onBackgroundCompactionOfferSummary() {
      return true
    },
    async onBackgroundCompactionPause() {
      throw new Error('prepare conflict controls the defer path')
    },
  }), error => error === conflict)
  assert.equal(silentCalls, 0)
}

async function verifyOfferWinsGateBeforeMainProvider(): Promise<void> {
  const pause = new Error('Run durably deferred for summary merge')
  const offerAccepted = deferred()
  let mainCalls = 0
  let toolCalls = 0
  const provider: AgentProvider = {
    toolSchemas: [{
      name: 'Read',
      description: 'read',
      input_schema: { type: 'object', properties: {} },
    }],
    buildRequest: () => ({}),
    buildCompactionRequest: () => ({}),
    async callLLM() {
      mainCalls += 1
      await new Promise(resolve => setTimeout(resolve, 0))
      return {
        content: [{ type: 'tool_use', id: 'read-once', name: 'Read', input: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 5_000, output_tokens: 20 },
      }
    },
    async callLLMSilent() {
      return {
        content: [{ type: 'text', text: '<summary>durable only</summary>' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 4_000, output_tokens: 10 },
      }
    },
    async executeTool() {
      toolCalls += 1
      return { content: 'read result' }
    },
  }
  const workspace = {
    list: () => [],
    stat: async () => null,
  } as unknown as WorkspaceInstance
  let offerCount = 0

  await assert.rejects(agentLoop(provider, [{
    role: 'user',
    content: [{ type: 'text', text: 'x'.repeat(18_000) }],
  }], {
    workspace,
    runId: 'run-offer-first',
    contextWindow: 10_000,
    mainMaxOutputTokens: 1_000,
    summaryMaxTokens: 500,
    ...durableSourceTurnGuardHooks(),
    async onBackgroundCompactionPrepare() {
      return { jobId: 'offered-summary-job' }
    },
    async onBackgroundCompactionActivate() {
      return true
    },
    async onBackgroundCompactionOfferSummary() {
      offerCount += 1
      offerAccepted.resolve()
      return true
    },
    async onBackgroundCompactionPause(input) {
      assert.equal(input.jobId, 'offered-summary-job')
      throw pause
    },
    async onActionStart(action) {
      if (action.kind === 'model_request') await offerAccepted.promise
    },
  }), error => error === pause)

  assert.equal(offerCount, 1)
  assert.equal(mainCalls, 0, 'an accepted offer fences the first main provider request')
  assert.equal(toolCalls, 0)
}

async function verifyMainTurnGuardSerializesOfferUntilAssistantCheckpoint(): Promise<void> {
  const pause = new Error('Run reloaded after serialized summary offer')
  const mainProviderEntered = deferred()
  const allowMainResponse = deferred()
  const allowSummary = deferred()
  const offerAccepted = deferred()
  const lifecycle: string[] = []
  let mainCalls = 0
  let offerCount = 0
  let guardHeld = false
  const provider: AgentProvider = {
    toolSchemas: [{
      name: 'Read',
      description: 'read',
      input_schema: { type: 'object', properties: {} },
    }],
    buildRequest: () => ({}),
    buildCompactionRequest: () => ({}),
    async callLLM() {
      mainCalls += 1
      lifecycle.push('provider-enter')
      mainProviderEntered.resolve()
      await allowMainResponse.promise
      return {
        content: [{ type: 'tool_use', id: 'read-once', name: 'Read', input: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 5_000, output_tokens: 20 },
      }
    },
    async callLLMSilent() {
      await allowSummary.promise
      lifecycle.push('summary-ready')
      return {
        content: [{ type: 'text', text: '<summary>short durable summary</summary>' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 4_000, output_tokens: 10 },
      }
    },
    async executeTool() {
      await offerAccepted.promise
      lifecycle.push('tool')
      return { content: 'read result' }
    },
  }
  const workspace = {
    list: () => [],
    stat: async () => null,
  } as unknown as WorkspaceInstance
  let mergedCheckpoints = 0
  const loop = agentLoop(provider, [{
    role: 'user',
    content: [{ type: 'text', text: 'x'.repeat(18_000) }],
    message_id: 'serialized-offer-boundary',
  }], {
    runId: 'run-main-first',
    workspace,
    contextWindow: 10_000,
    mainMaxOutputTokens: 1_000,
    summaryMaxTokens: 500,
    async onBackgroundCompactionPrepare() {
      return { jobId: 'serialized-shadow-job' }
    },
    async onBackgroundCompactionActivate() {
      return true
    },
    async onBackgroundCompactionOfferSummary(input) {
      offerCount += 1
      assert.equal(guardHeld, false, 'offer CAS must wait for the source-turn guard release')
      assert.equal(input.jobId, 'serialized-shadow-job')
      assert.equal(input.summary, 'short durable summary')
      lifecycle.push('offer')
      offerAccepted.resolve()
      return true
    },
    async onBackgroundCompactionPause() {
      throw pause
    },
    async onBackgroundCompactionAcquireSourceTurnGuard() {
      guardHeld = true
      lifecycle.push('guard-acquire')
      return {
        guardToken: 'serialized-source-turn',
        expiresAt: new Date(Date.now() + 60_000),
      }
    },
    async onBackgroundCompactionHeartbeatSourceTurnGuard() {
      assert.equal(guardHeld, true)
      return { expiresAt: new Date(Date.now() + 60_000) }
    },
    async onBackgroundCompactionReleaseSourceTurnGuard() {
      assert.equal(guardHeld, true)
      guardHeld = false
      lifecycle.push('guard-release')
      return true
    },
    async onTurnComplete() {
      lifecycle.push('flush')
    },
    async onActionComplete(action) {
      if (action.actionId) lifecycle.push('model-complete')
    },
    onCompactionCheckpoint(checkpoint) {
      if (checkpoint.status === 'merged') mergedCheckpoints += 1
    },
  })

  await mainProviderEntered.promise
  assert.equal(guardHeld, true)
  allowSummary.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(offerCount, 0, 'summary waits behind the live main-turn gate')

  allowMainResponse.resolve()
  await assert.rejects(loop, error => error === pause)

  assert.equal(mainCalls, 1)
  assert.equal(offerCount, 1)
  assert.equal(mergedCheckpoints, 0, 'durable mode has no local merge/persist window')
  assert.ok(lifecycle.indexOf('flush') < lifecycle.indexOf('model-complete'))
  assert.ok(lifecycle.indexOf('model-complete') < lifecycle.indexOf('guard-release'))
  assert.ok(lifecycle.indexOf('guard-release') < lifecycle.indexOf('offer'))
}

async function verifyDurableModelCheckpointSurvivesGuardTakeover(
  responseKind: 'text' | 'tool_use',
): Promise<void> {
  const reload = new Error('reload after paired tool checkpoint')
  const appendEntered = deferred()
  const allowAppend = deferred()
  const lifecycle: string[] = []
  const actionKinds = new Map<string, 'model_request' | 'tool_call' | 'compaction'>()
  const completedActions: Array<'model_request' | 'tool_call' | 'compaction'> = []
  const persistedBatches: ConversationMessage[][] = []
  let activeContext: ConversationMessage[] = []
  let frozenPrefixLength = 0
  let workerTookOver = false
  let providerCalls = 0
  let toolExecutions = 0
  let heartbeatCalls = 0
  let releaseCalls = 0
  let pauseCalls = 0

  const provider: AgentProvider = {
    toolSchemas: responseKind === 'tool_use'
      ? [{
          name: 'Read',
          description: 'read once',
          input_schema: { type: 'object', properties: {} },
        }]
      : [],
    buildRequest: () => ({}),
    buildCompactionRequest: () => ({}),
    async callLLM() {
      providerCalls += 1
      lifecycle.push('provider')
      return {
        content: responseKind === 'tool_use'
          ? [{ type: 'tool_use' as const, id: 'takeover-read', name: 'Read', input: {} }]
          : [{ type: 'text' as const, text: 'committed exactly once' }],
        stop_reason: responseKind === 'tool_use' ? 'tool_use' as const : 'end_turn' as const,
        usage: { input_tokens: 5_000, output_tokens: 20 },
      }
    },
    async callLLMSilent(_request, signal) {
      return await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('worker owns compaction')), {
          once: true,
        })
      })
    },
    async executeTool() {
      toolExecutions += 1
      lifecycle.push('tool-execute')
      return { content: 'read result exactly once' }
    },
  }
  const workspace = {
    list: () => [],
    stat: async () => null,
  } as unknown as WorkspaceInstance
  const initialMessages: ConversationMessage[] = [{
    role: 'user',
    content: [{ type: 'text', text: 'x'.repeat(18_000) }],
    message_id: `takeover-${responseKind}-prefix`,
  }]
  activeContext = structuredClone(initialMessages)

  const loop = agentLoop(provider, initialMessages, {
    runId: `run-takeover-${responseKind}`,
    workspace,
    contextWindow: 10_000,
    mainMaxOutputTokens: 1_000,
    summaryMaxTokens: 500,
    async onBackgroundCompactionPrepare(descriptor) {
      frozenPrefixLength = descriptor.prefixLength
      return { jobId: `takeover-${responseKind}-shadow` }
    },
    async onBackgroundCompactionActivate() {
      assert.equal(workerTookOver, true)
      return true
    },
    async onBackgroundCompactionOfferSummary() {
      throw new Error('taken-over worker must remain the only summary owner')
    },
    async onBackgroundCompactionPause() {
      pauseCalls += 1
      lifecycle.push('reload')
      throw reload
    },
    async onBackgroundCompactionAcquireSourceTurnGuard() {
      lifecycle.push('guard-acquire')
      return {
        guardToken: `takeover-${responseKind}-guard`,
        expiresAt: new Date(Date.now() + 60_000),
      }
    },
    async onBackgroundCompactionHeartbeatSourceTurnGuard() {
      heartbeatCalls += 1
      lifecycle.push('guard-heartbeat')
      return { expiresAt: new Date(Date.now() + 60_000) }
    },
    async onBackgroundCompactionReleaseSourceTurnGuard() {
      releaseCalls += 1
      lifecycle.push('guard-release-lost')
      assert.equal(workerTookOver, true)
      return false
    },
    async onActionStart(action) {
      actionKinds.set(action.actionId, action.kind)
    },
    async onActionComplete(action) {
      const kind = actionKinds.get(action.actionId)
      assert.ok(kind)
      completedActions.push(kind)
      lifecycle.push(`${kind}-complete`)
    },
    async onTurnComplete(batch) {
      persistedBatches.push(structuredClone(batch))
      if (persistedBatches.length === 1) {
        lifecycle.push('assistant-append-enter')
        appendEntered.resolve()
        await allowAppend.promise
      }
      // Model the same idempotent append-to-current-active-context contract as
      // Conversation and member-session repositories. The worker may already
      // have replaced the frozen prefix before this delayed append resumes.
      for (const message of batch) {
        activeContext = activeContext.filter(existing => (
          !message.message_id || existing.message_id !== message.message_id
        ))
        activeContext.push(structuredClone(message))
      }
      lifecycle.push(`persist-${batch[0]?.role ?? 'unknown'}`)
    },
  })

  await appendEntered.promise
  assert.ok(heartbeatCalls >= 2, 'the guard is live immediately before the blocked append')
  // Fault injection: the last heartbeat succeeded, append then stalls past the
  // lease, and the worker atomically swaps P -> R(P) before append resumes.
  activeContext = [{
    role: 'user',
    content: [{ type: 'text', text: 'durable compacted prefix' }],
    message_id: `takeover-${responseKind}-replacement`,
  }, ...activeContext.slice(frozenPrefixLength)]
  workerTookOver = true
  lifecycle.push('worker-merge')
  allowAppend.resolve()

  if (responseKind === 'text') {
    const result = await loop
    assert.equal(result.text, 'committed exactly once')
    assert.equal(pauseCalls, 0, 'a terminal committed response must not be requeued')
  } else {
    await assert.rejects(loop, error => error === reload)
    assert.equal(pauseCalls, 1, 'reload occurs only after the paired tool checkpoint')
  }

  assert.equal(providerCalls, 1, 'the completed model action is never replayed')
  assert.equal(releaseCalls, 1)
  assert.equal(
    completedActions.filter(kind => kind === 'model_request').length,
    1,
    'the model action completes once',
  )
  const assistantMessages = persistedBatches.flat().filter(message => message.role === 'assistant')
  assert.equal(assistantMessages.length, 1, 'the assistant checkpoint persists once')
  const activeTail = activeContext.slice(1)
  assert.equal(
    activeTail.filter(message => message.role === 'assistant').length,
    1,
    'worker merge preserves the delayed assistant tail',
  )
  assert.ok(lifecycle.indexOf('worker-merge') < lifecycle.indexOf('persist-assistant'))
  assert.ok(lifecycle.indexOf('persist-assistant') < lifecycle.indexOf('model_request-complete'))
  assert.ok(lifecycle.indexOf('model_request-complete') < lifecycle.indexOf('guard-release-lost'))

  if (responseKind === 'tool_use') {
    assert.equal(toolExecutions, 1, 'the durable tool_use executes exactly once')
    assert.equal(
      completedActions.filter(kind => kind === 'tool_call').length,
      1,
      'the tool side effect checkpoint completes once',
    )
    assert.ok(lifecycle.indexOf('guard-release-lost') < lifecycle.indexOf('tool-execute'))
    assert.ok(lifecycle.indexOf('tool_call-complete') < lifecycle.indexOf('reload'))
    const toolUse = activeTail
      .flatMap(message => message.content)
      .find(block => block.type === 'tool_use')
    const toolResult = activeTail
      .flatMap(message => message.content)
      .find(block => block.type === 'tool_result')
    assert.equal(toolUse?.type === 'tool_use' ? toolUse.id : undefined, 'takeover-read')
    assert.equal(
      toolResult?.type === 'tool_result' ? toolResult.tool_use_id : undefined,
      'takeover-read',
      'tool_use and tool_result remain paired in the post-merge tail',
    )
  } else {
    assert.equal(toolExecutions, 0)
  }
}

async function verifyAskUserRepairReloadsAfterGuardTakeover(
  failureKind: 'normalize' | 'callback',
): Promise<void> {
  const reload = new Error(`reload after AskUser ${failureKind} repair`)
  const lifecycle: string[] = []
  const persisted: ConversationMessage[] = []
  let providerCalls = 0
  let askUserCalls = 0
  let pauseCalls = 0
  let modelCompletes = 0

  const askInput = failureKind === 'normalize'
    ? { questions: [] }
    : { question: 'Continue?', options: ['Yes', 'No'] }
  const provider: AgentProvider = {
    toolSchemas: [{
      name: 'AskUserQuestion',
      description: 'ask user',
      input_schema: { type: 'object', properties: {} },
    }],
    buildRequest: () => ({}),
    buildCompactionRequest: () => ({}),
    async callLLM() {
      providerCalls += 1
      return {
        content: [{
          type: 'tool_use',
          id: `ask-${failureKind}`,
          name: 'AskUserQuestion',
          input: askInput,
        }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 5_000, output_tokens: 20 },
      }
    },
    async callLLMSilent(_request, signal) {
      return await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('worker takeover')), {
          once: true,
        })
      })
    },
    async executeTool() {
      throw new Error('AskUserQuestion must not execute as a regular tool')
    },
  }
  const workspace = {
    list: () => [],
    stat: async () => null,
  } as unknown as WorkspaceInstance

  await assert.rejects(agentLoop(provider, [{
    role: 'user',
    content: [{ type: 'text', text: 'x'.repeat(18_000) }],
    message_id: `ask-${failureKind}-prefix`,
  }], {
    runId: `run-ask-${failureKind}-takeover`,
    workspace,
    contextWindow: 10_000,
    mainMaxOutputTokens: 1_000,
    summaryMaxTokens: 500,
    async onBackgroundCompactionPrepare() {
      return { jobId: `ask-${failureKind}-shadow` }
    },
    async onBackgroundCompactionActivate() {
      return true
    },
    async onBackgroundCompactionOfferSummary() {
      throw new Error('worker owns AskUser compaction')
    },
    async onBackgroundCompactionPause() {
      pauseCalls += 1
      lifecycle.push('reload')
      const reminder = persisted
        .flatMap(message => message.content)
        .find(block => block.type === 'text' && block.text.includes('AskUserQuestion input was invalid'))
      assert.ok(reminder, 'repair reminder must be durable before reload')
      throw reload
    },
    async onBackgroundCompactionAcquireSourceTurnGuard() {
      return {
        guardToken: `ask-${failureKind}-guard`,
        expiresAt: new Date(Date.now() + 60_000),
      }
    },
    async onBackgroundCompactionHeartbeatSourceTurnGuard() {
      return { expiresAt: new Date(Date.now() + 60_000) }
    },
    async onBackgroundCompactionReleaseSourceTurnGuard() {
      lifecycle.push('guard-release-lost')
      return false
    },
    async onActionComplete() {
      modelCompletes += 1
      lifecycle.push('model-complete')
    },
    async onAskUser() {
      askUserCalls += 1
      if (failureKind === 'callback') throw new Error('interaction persistence failed')
    },
    async onTurnComplete(batch) {
      persisted.push(...structuredClone(batch))
      const containsRepair = batch.some(message => message.content.some(block => (
        block.type === 'text' && block.text.includes('AskUserQuestion input was invalid')
      )))
      lifecycle.push(containsRepair ? 'repair-persisted' : 'assistant-persisted')
    },
  }), error => error === reload)

  assert.equal(providerCalls, 1, 'AskUser repair must not enter a stale second model turn')
  assert.equal(modelCompletes, 1)
  assert.equal(pauseCalls, 1)
  assert.equal(askUserCalls, failureKind === 'callback' ? 1 : 0)
  assert.equal(
    persisted.filter(message => message.role === 'assistant').length,
    1,
    'stripped AskUser assistant checkpoint persists once',
  )
  assert.equal(
    persisted.filter(message => message.content.some(block => (
      block.type === 'text' && block.text.includes('AskUserQuestion input was invalid')
    ))).length,
    1,
    'one repair reminder is persisted',
  )
  assert.ok(lifecycle.indexOf('assistant-persisted') < lifecycle.indexOf('model-complete'))
  assert.ok(lifecycle.indexOf('model-complete') < lifecycle.indexOf('guard-release-lost'))
  assert.ok(lifecycle.indexOf('guard-release-lost') < lifecycle.indexOf('repair-persisted'))
  assert.ok(lifecycle.indexOf('repair-persisted') < lifecycle.indexOf('reload'))
}

async function main(): Promise<void> {
  verifyPromptTooLongClassification()
  verifyTransportRetryClassification()
  verifySecondRequestColdCompactionProfile()
  verifyStableConversationGrowthTelemetry()
  verifyApiAnchorPlusLocalDeltaAcrossRequests()
  verifyNormalBudgetInvariants()
  await verifyShadowPreparePrecedesLocalProviderAndIgnoresParentAbort()
  await verifyExpiredShadowDeadlineNeverStartsLocalProvider()
  await verifyNormalExitDrainsAndMerges()
  await verifyDurableHandoffIsNotCancellation()
  await verifyFailedAndCancelledAreDistinct()
  await verifyAgentLoopHandsOffWithoutFalseDone()
  await verifyCancellationFlushesToolPairThenActivatesShadow()
  await verifyProviderFailurePreservesPrimaryErrorAndActivatesShadow()
  await verifyFlushFailureReleasesGuardAndPreservesPrimaryError()
  await verifyLostGuardDropsProviderResponseBeforePersistence()
  await verifyReactive413ReleasesGuardBeforeDurablePause()
  await verifyFirstTurn413PreservesTheOnlyUserRequest()
  await verifyWorkerWinsGuardAcquireWithoutMainProviderCall()
  await verifyPrepareConflictFailsClosedBeforeLocalProvider()
  await verifyOfferWinsGateBeforeMainProvider()
  await verifyMainTurnGuardSerializesOfferUntilAssistantCheckpoint()
  await verifyDurableModelCheckpointSurvivesGuardTakeover('text')
  await verifyDurableModelCheckpointSurvivesGuardTakeover('tool_use')
  await verifyAskUserRepairReloadsAfterGuardTakeover('normalize')
  await verifyAskUserRepairReloadsAfterGuardTakeover('callback')
  console.log('hippocampus verification passed')
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
