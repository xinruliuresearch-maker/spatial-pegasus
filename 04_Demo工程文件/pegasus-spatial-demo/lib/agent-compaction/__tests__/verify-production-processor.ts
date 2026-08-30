import assert from 'node:assert/strict'
import type { AgentProvider } from '../../agent/loop'
import type { AgentExecutionBudgetGate } from '../../agent-team/execution-budget'
import type { AgentExecutionTelemetry } from '../../agent-team/types'
import type { ConversationMessage, ToolResult } from '../../types'
import type { DurableCompactionJobRecord } from '../types'
import type { FrozenModelResolutionSnapshot } from '../../llm-registry'
import {
  buildProductionCompactionRequest,
  createProductionDurableCompactionProcessor,
  DurableCompactionProcessorError,
} from '../processor'

const prefix: ConversationMessage[] = [{
  role: 'user',
  content: [{ type: 'text', text: 'preserve this frozen research context' }],
  message_id: 'message_1',
  timestamp: new Date('2026-08-10T00:00:00.000Z'),
}]

function modelSnapshot(
  overrides: Partial<FrozenModelResolutionSnapshot> = {},
): FrozenModelResolutionSnapshot {
  return {
    snapshot_version: 1,
    alias: 'main_test',
    real_model: 'real-test-model',
    key_channel: 'orchestrator',
    supports_vision: false,
    context_window: 10_000,
    max_output_tokens: 1_000,
    compaction_max_output_tokens: 321,
    prompt_cache_ttl: '5m',
    used_compatibility_defaults: false,
    registry_source: 'db',
    registry_revision: '2026-08-10T00:00:00.000Z',
    registry_hash: 'a'.repeat(64),
    resolved_at: new Date('2026-08-10T00:00:00.000Z'),
    ...overrides,
  }
}

function job(overrides: Partial<DurableCompactionJobRecord> = {}): DurableCompactionJobRecord {
  return {
    job_id: 'cmpjob_processor_test',
    owner_key: 'conversation:conversation_processor_test',
    owner_kind: 'conversation',
    conversation_id: 'conversation_processor_test',
    user_id: 'user_processor_test',
    source_run_id: 'run_processor_test',
    idempotency_key: 'handoff_processor_test',
    idempotency_keys: ['handoff_processor_test'],
    model_alias_snapshot: 'main_test',
    model_resolution_snapshot: modelSnapshot(),
    status: 'summarizing',
    active_key: 'conversation:conversation_processor_test',
    frozen_prefix: {
      context_revision: 3,
      prefix_length: 1,
      prefix_hash: 'prefix_hash',
      boundary_message_id: 'message_1',
      messages: prefix,
    },
    attempt: 1,
    lease: {
      owner_id: 'worker_processor_test',
      fence_token: 'fence_processor_test',
      heartbeat_at: new Date(),
      expires_at: new Date(Date.now() + 60_000),
    },
    available_at: new Date(),
    created_at: new Date('2026-08-10T00:00:00.000Z'),
    updated_at: new Date('2026-08-10T00:00:00.000Z'),
    ...overrides,
  }
}

function telemetry(): AgentExecutionTelemetry {
  return {
    telemetry_id: 'telemetry_processor_test',
    team_id: 'team_processor_test',
    conversation_id: 'conversation_processor_test',
    user_id: 'user_processor_test',
    agent_id: 'agent_processor_test',
    run_id: 'run_processor_test',
    input_tokens: 13,
    output_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cost_usd: 0,
    tool_calls: 0,
    download_bytes: 0,
    created_at: new Date(),
    updated_at: new Date(),
  }
}

async function main(): Promise<void> {
  const calls: string[] = []
  let sentRequest: Record<string, unknown> | null = null
  const provider: AgentProvider = {
    toolSchemas: [],
    buildRequest: () => ({ messages: [] }),
    buildCompactionRequest(messages, instruction, maxTokens) {
      assert.equal(messages, prefix)
      assert.match(instruction, /Research Scope and Method/)
      return {
        model: 'real-test-model',
        max_tokens: maxTokens,
        system: [],
        tools: [{ name: 'must-be-removed' }],
        messages: [{ role: 'user', content: [{ type: 'text', text: instruction }] }],
      }
    },
    async callLLM() {
      throw new Error('main model call must not be used')
    },
    async callLLMSilent(request) {
      sentRequest = request
      assert.deepEqual(request.tools, [])
      assert.equal(request.max_tokens, 321)
      return {
        content: [{ type: 'text', text: '<summary>durable summary</summary>' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 13, output_tokens: 5 },
      }
    },
    async executeTool(): Promise<ToolResult> {
      throw new Error('tools must not execute')
    },
  }
  const budget: AgentExecutionBudgetGate = {
    async reserveCall(_context, kind) {
      calls.push(`reserve:${kind}`)
      return {
        admissionId: 'admission_processor_test',
        admissionKey: 'admission_key_processor_test',
        reservationKey: 'reservation_key_processor_test',
        kind,
        attempt: 1,
        reservedToolCalls: 0,
      }
    },
    async markCallStarted() { calls.push('started') },
    async completeCall(_context, _admission, delta, observed) {
      calls.push(`complete:${delta.input_tokens}:${observed}`)
      return telemetry()
    },
    async releaseCall() { throw new Error('not expected') },
    async assertCanCall() { /* not used by the provider wrapper */ },
    async recordUsage() { return telemetry() },
    async recordModelUsage() { return telemetry() },
  }
  const apiLogs: Array<Record<string, unknown>> = []
  const processor = createProductionDurableCompactionProcessor({
    async resolveAuthoritativeModel() {
      throw new Error('persisted snapshot must win over a drifted registry')
    },
    resolveApiKeyChannel(_channel, alias) {
      assert.equal(alias, 'main_test')
      return 'super-secret-key'
    },
    createProvider: ((_workspace, _skills, config) => {
      assert.equal(config.model, 'real-test-model')
      assert.equal(config.maxTokens, 1_000)
      assert.equal(config.supportsVision, false)
      return provider
    }) as ProductionProviderFactory,
    resolveIdentity: async () => ({
      teamId: 'team_processor_test',
      agentId: 'agent_processor_test',
      runId: 'run_processor_test',
    }),
    createBudgetGate: () => budget,
    logAPICall: async input => { apiLogs.push(input as unknown as Record<string, unknown>) },
  })
  const result = await processor.summarize(job(), new AbortController().signal)
  assert.equal(result.summary, 'durable summary')
  assert.deepEqual(result.usage, { input_tokens: 13, output_tokens: 5 })
  assert.deepEqual(calls, ['reserve:compaction', 'started', 'complete:13:true'])
  assert.equal(apiLogs.length, 1)
  assert.equal(apiLogs[0].status, 'success')
  assert.ok(sentRequest)
  assert.equal(JSON.stringify(sentRequest).includes('super-secret-key'), false)

  const defensive = buildProductionCompactionRequest(provider, job(), 99)
  assert.deepEqual(defensive.tools, [])
  assert.equal(defensive.max_tokens, 99)

  await assert.rejects(
    processor.summarize(
      job({ model_alias_snapshot: null }),
      new AbortController().signal,
    ),
    error => error instanceof DurableCompactionProcessorError
      && error.recoverability === 'fatal',
  )

  const fatalProcessor = createProductionDurableCompactionProcessor({
    resolveApiKeyChannel() { throw new Error('Unknown model alias: removed') },
  })
  await assert.rejects(
    fatalProcessor.summarize(job(), new AbortController().signal),
    error => error instanceof DurableCompactionProcessorError
      && error.recoverability === 'fatal',
  )

  let legacyFrozen = false
  const legacyProcessor = createProductionDurableCompactionProcessor({
    resolveAuthoritativeModel: async () => modelSnapshot(),
    async freezeModelResolution(legacyJob, snapshot) {
      legacyFrozen = true
      return { ...legacyJob, model_resolution_snapshot: snapshot }
    },
    resolveApiKeyChannel: () => 'super-secret-key',
    createProvider: (() => provider) as ProductionProviderFactory,
    resolveIdentity: async () => ({
      teamId: 'team_processor_test',
      agentId: 'agent_processor_test',
      runId: 'run_processor_test',
    }),
    createBudgetGate: () => budget,
    logAPICall: async () => undefined,
  })
  await legacyProcessor.summarize(
    job({ model_resolution_snapshot: null }),
    new AbortController().signal,
  )
  assert.equal(legacyFrozen, true)

  console.log('production durable compaction processor verification passed')
}

type ProductionProviderFactory = NonNullable<
  Parameters<typeof createProductionDurableCompactionProcessor>[0]
>['createProvider']

void main()
