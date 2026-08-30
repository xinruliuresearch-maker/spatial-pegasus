import assert from 'node:assert/strict'
import type { AgentProvider } from '../../agent/loop'
import type { LLMResponse, ToolResult } from '../../types'
import {
  budgetCostUsdFromCents,
  budgetToolAttemptKey,
  agentBudgetCnyPerUsd,
  exhaustedBudget,
  exhaustedBudgetScope,
  instrumentAgentProviderForBudget,
  MongoAgentExecutionBudgetLedger,
  normalizedExecutionUsage,
  totalExecutionTokens,
  type AgentExecutionBudgetContext,
  type AgentExecutionBudgetGate,
  type AgentExecutionUsageDelta,
  type AgentExternalCallAdmission,
} from '../execution-budget'
import {
  AgentBudgetAdmissionModel,
  AgentExecutionBudgetStateModel,
  AgentExecutionTelemetryModel,
} from '../models'
import type { AgentExecutionTelemetry } from '../types'

const CONTEXT: AgentExecutionBudgetContext = {
  teamId: 'team_budget',
  conversationId: 'conversation_budget',
  userId: 'user_budget',
  agentId: 'agent_budget',
  taskId: 'task_budget',
  runId: 'run_budget',
  executionOwnerId: 'owner_budget',
  agentSessionId: 'session_budget',
  teamFenceRequired: true,
}

const EMPTY_TELEMETRY: AgentExecutionTelemetry = {
  telemetry_id: 'execution_telemetry_run_budget',
  team_id: CONTEXT.teamId,
  conversation_id: CONTEXT.conversationId,
  user_id: CONTEXT.userId,
  agent_id: CONTEXT.agentId,
  task_id: CONTEXT.taskId,
  run_id: CONTEXT.runId,
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cost_usd: 0,
  tool_calls: 0,
  download_bytes: 0,
  created_at: new Date(0),
  updated_at: new Date(0),
}

class ScriptedProvider implements AgentProvider {
  readonly toolSchemas = []
  buildRequest(): Record<string, never> { return {} }
  buildCompactionRequest(): Record<string, never> { return {} }
  async callLLM(): Promise<LLMResponse> {
    return {
      content: [{ type: 'text', text: 'main' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 4,
      },
    }
  }
  async callLLMSilent(): Promise<LLMResponse> {
    return {
      content: [{ type: 'text', text: 'compact' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 1 },
    }
  }
  async executeTool(name: string): Promise<ToolResult> {
    if (name === 'Throws') throw new Error('tool exploded')
    return {
      content: 'ok',
      telemetry: { download_bytes: name === 'ArxivFetchPaper' ? 4_096 : 0 },
    }
  }
}

class RecordingLedger implements AgentExecutionBudgetGate {
  readonly calls: string[] = []
  private sequence = 0
  async reserveCall(
    _context: AgentExecutionBudgetContext,
    kind: AgentExternalCallAdmission['kind'],
    label?: string,
    attemptKey?: string,
  ): Promise<AgentExternalCallAdmission> {
    this.sequence += 1
    this.calls.push(`reserve:${kind}:${label ?? ''}:${attemptKey ?? ''}`)
    return {
      admissionId: `admission_${this.sequence}`,
      admissionKey: attemptKey ?? `attempt_${this.sequence}`,
      reservationKey: `reservation_${this.sequence}`,
      kind,
      label,
      attempt: 1,
      reservedToolCalls: kind === 'tool' ? 1 : 0,
    }
  }
  async markCallStarted(
    _context: AgentExecutionBudgetContext,
    admission: AgentExternalCallAdmission,
  ): Promise<void> {
    this.calls.push(`start:${admission.kind}:${admission.admissionId}`)
  }
  async completeCall(
    _context: AgentExecutionBudgetContext,
    admission: AgentExternalCallAdmission,
    delta: AgentExecutionUsageDelta,
    usageObserved = true,
  ): Promise<AgentExecutionTelemetry> {
    this.calls.push(
      `complete:${admission.kind}:${delta.input_tokens ?? 0}:${delta.output_tokens ?? 0}:`
      + `${delta.download_bytes ?? 0}:${usageObserved}`,
    )
    return EMPTY_TELEMETRY
  }
  async releaseCall(
    _context: AgentExecutionBudgetContext,
    admission: AgentExternalCallAdmission,
    reason?: string,
  ): Promise<void> {
    this.calls.push(`release:${admission.kind}:${reason ?? ''}`)
  }
  async assertCanCall(_context: AgentExecutionBudgetContext, kind: string, label?: string): Promise<void> {
    this.calls.push(`gate:${kind}:${label ?? ''}`)
  }
  async recordUsage(
    _context: AgentExecutionBudgetContext,
    delta: AgentExecutionUsageDelta,
  ): Promise<AgentExecutionTelemetry> {
    this.calls.push(`usage:${delta.tool_calls ?? 0}:${delta.download_bytes ?? 0}`)
    return EMPTY_TELEMETRY
  }
  async recordModelUsage(
    _context: AgentExecutionBudgetContext,
    model: string,
    usage: LLMResponse['usage'],
  ): Promise<AgentExecutionTelemetry> {
    this.calls.push(`model:${model}:${usage.input_tokens}:${usage.output_tokens}`)
    return EMPTY_TELEMETRY
  }
}

function testCurrencyAndBudgetDimensions(): void {
  const previous = process.env.AGENT_BUDGET_CNY_PER_USD
  try {
    delete process.env.AGENT_BUDGET_CNY_PER_USD
  assert.equal(agentBudgetCnyPerUsd(), 7.2)
    process.env.AGENT_BUDGET_CNY_PER_USD = '7.2'
    assert.equal(budgetCostUsdFromCents(720), 1, '¥7.20 at 7.2 CNY/USD is exactly $1')
  } finally {
    if (previous === undefined) delete process.env.AGENT_BUDGET_CNY_PER_USD
    else process.env.AGENT_BUDGET_CNY_PER_USD = previous
  }
  assert.equal(
    budgetToolAttemptKey('run', 'tool', 'Read', { b: 2, a: 1 }),
    budgetToolAttemptKey('run', 'tool', 'Read', { a: 1, b: 2 }),
  )
  assert.notEqual(
    budgetToolAttemptKey('run', 'tool', 'Read', { a: 1 }),
    budgetToolAttemptKey('run', 'tool', 'Read', { a: 2 }),
  )
  const usage = {
    input_tokens: 5,
    output_tokens: 2,
    cache_creation_input_tokens: 1,
    cache_read_input_tokens: 2,
    cost_usd: 0.5,
    tool_calls: 3,
    download_bytes: 1_024,
  }
  assert.equal(totalExecutionTokens(usage), 10)
  assert.deepEqual(
    normalizedExecutionUsage(undefined),
    {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cost_usd: 0,
      tool_calls: 0,
      download_bytes: 0,
    },
    'a newly created member has no agent_usage bucket yet and must start from zero',
  )
  assert.deepEqual(exhaustedBudget({
    budget: { max_tokens: 10 },
    usage,
    kind: 'model',
  }), { dimension: 'tokens', limit: 10, used: 10 })
  assert.deepEqual(exhaustedBudget({
    budget: { max_tool_calls: 3 },
    usage,
    kind: 'tool',
  }), { dimension: 'tool_calls', limit: 3, used: 3 })
  assert.equal(exhaustedBudget({
    budget: { max_tool_calls: 3 },
    usage,
    kind: 'model',
  }), null, 'tool-call ceilings gate tools without preventing a final model response')
  assert.deepEqual(exhaustedBudget({
    budget: { max_download_bytes: 1_024 },
    usage,
    kind: 'tool',
  }), { dimension: 'download_bytes', limit: 1_024, used: 1_024 })
  assert.deepEqual(exhaustedBudgetScope({
    scopes: [
      { scope: 'team', budget: { max_tokens: 11 }, usage },
      { scope: 'agent', budget: { max_cost_usd: 0.5 }, usage },
      { scope: 'task', budget: { max_tool_calls: 3 }, usage },
    ],
    kind: 'tool',
  }), {
    scope: 'agent',
    dimension: 'cost_usd',
    limit: 0.5,
    used: 0.5,
  }, 'Team → Agent → Task ceilings are all evaluated and preserve scope attribution')
}

async function testProviderInstrumentation(): Promise<void> {
  const ledger = new RecordingLedger()
  const raw = new ScriptedProvider()
  const provider = instrumentAgentProviderForBudget(raw, {
    context: CONTEXT,
    model: 'Claude-opus-4.6',
    ledger,
  })
  assert.equal(instrumentAgentProviderForBudget(provider, {
    context: CONTEXT,
    model: 'Claude-opus-4.6',
    ledger,
  }), provider, 'one Provider must never be charged by two wrappers')
  await provider.callLLM({})
  await provider.callLLMSilent({})
  await provider.executeTool('ArxivFetchPaper', {}, {
    toolUseId: 'tool_use_fetch',
    actionId: 'action_fetch',
    turn: 1,
  })
  await assert.rejects(provider.executeTool('Throws', {}, {
    toolUseId: 'tool_use_throws',
    actionId: 'action_throws',
    turn: 1,
  }), /tool exploded/)
  assert.deepEqual(ledger.calls, [
    'reserve:model:Claude-opus-4.6:',
    'start:model:admission_1',
    'complete:model:10:2:0:true',
    'reserve:compaction:Claude-opus-4.6:',
    'start:compaction:admission_2',
    'complete:compaction:5:1:0:true',
    `reserve:tool:ArxivFetchPaper:${budgetToolAttemptKey(
      CONTEXT.runId,
      'tool_use_fetch',
      'ArxivFetchPaper',
      {},
    )}`,
    'start:tool:admission_3',
    'complete:tool:0:0:4096:true',
    `reserve:tool:Throws:${budgetToolAttemptKey(
      CONTEXT.runId,
      'tool_use_throws',
      'Throws',
      {},
    )}`,
    'start:tool:admission_4',
    'complete:tool:0:0:0:false',
  ])
}

async function testWriteFenceOrder(): Promise<void> {
  let teamFenceChecks = 0
  const runRejected = new MongoAgentExecutionBudgetLedger({
    validateRun: async () => false,
    validateTeam: async () => {
      teamFenceChecks += 1
      return true
    },
  })
  await assert.rejects(runRejected.recordUsage(CONTEXT, { tool_calls: 1 }), error => (
    (error as { code?: string }).code === 'AGENT_CONTROL_FENCE_LOST'
  ))
  assert.equal(teamFenceChecks, 0, 'Team fence must not be consulted after the Run fence fails')

  const teamRejected = new MongoAgentExecutionBudgetLedger({
    validateRun: async () => true,
    validateTeam: async () => {
      teamFenceChecks += 1
      return false
    },
  })
  await assert.rejects(teamRejected.recordUsage(CONTEXT, { tool_calls: 1 }), error => (
    (error as { code?: string }).code === 'AGENT_CONTROL_FENCE_LOST'
  ))
  assert.equal(teamFenceChecks, 1, 'background Team ledger writes require the Team fence')
}

function testTelemetrySchema(): void {
  for (const path of [
    'team_id',
    'conversation_id',
    'user_id',
    'agent_id',
    'task_id',
    'run_id',
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
    'cost_usd',
    'tool_calls',
    'download_bytes',
  ]) {
    assert.ok(AgentExecutionTelemetryModel.schema.path(path), `telemetry schema missing ${path}`)
  }
  assert.equal(AgentExecutionTelemetryModel.schema.path('run_id').options.unique, true)
  assert.ok(AgentExecutionTelemetryModel.schema.path('applied_admission_ids'))
  assert.ok(AgentExecutionBudgetStateModel.schema.path('active_reservations'))
  assert.equal(AgentExecutionBudgetStateModel.schema.path('team_id').options.unique, true)
  assert.ok(AgentBudgetAdmissionModel.schema.path('attempt'))
  assert.ok(AgentBudgetAdmissionModel.schema.path('usage_observed'))
}

async function main(): Promise<void> {
  testCurrencyAndBudgetDimensions()
  await testProviderInstrumentation()
  await testWriteFenceOrder()
  testTelemetrySchema()
  console.log('Agent execution budget verification passed.')
}

void main()
