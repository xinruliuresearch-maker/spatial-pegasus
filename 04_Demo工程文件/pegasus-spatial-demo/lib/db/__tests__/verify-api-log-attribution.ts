import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { tokenTracker } from '../../agent/token-tracker'

interface CapturedUsageUpdate {
  filter: Record<string, unknown>
  update: { $inc?: Record<string, number> }
  options: Record<string, unknown>
}

async function main(): Promise<void> {
  const previousUri = process.env.MONGODB_URI
  const originalConnect = mongoose.connect
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/sci_pegasus_api_log_attribution_test'
  mongoose.connect = (async () => mongoose) as typeof mongoose.connect

  const { APICallLog, DailyUsage } = await import('../api-log-models')
  const { ModelConfig } = await import('../model-config-models')
  const originalCreate = APICallLog.create
  const originalUpdateOne = DailyUsage.updateOne
  const originalFindOne = ModelConfig.findOne
  const created: Array<Record<string, unknown>> = []
  const usageUpdates: CapturedUsageUpdate[] = []

  Reflect.set(APICallLog, 'create', async (document: Record<string, unknown>) => {
    await Promise.resolve()
    created.push({ ...document })
    return document
  })
  Reflect.set(DailyUsage, 'updateOne', async (
    filter: Record<string, unknown>,
    update: { $inc?: Record<string, number> },
    options: Record<string, unknown>,
  ) => {
    usageUpdates.push({ filter: { ...filter }, update, options: { ...options } })
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }
  })
  // Pricing uses a stale-while-revalidate lookup. Keep this focused test
  // network-free while retaining the real RMB fallback price calculation.
  Reflect.set(ModelConfig, 'findOne', () => ({ lean: async () => null }))

  try {
    const {
      logAPICall,
      resolveAPICallAttribution,
    } = await import('../api-log-repository')

    assert.deepEqual(resolveAPICallAttribution({}, {}), {})
    assert.deepEqual(resolveAPICallAttribution({
      team_id: ' team_fallback ',
      agent_id: 'agent_fallback',
      task_id: '',
      run_id: 'run_fallback',
    }, {}), {
      team_id: 'team_fallback',
      agent_id: 'agent_fallback',
      run_id: 'run_fallback',
    })
    assert.deepEqual(resolveAPICallAttribution({
      team_id: 'team_wrong',
      agent_id: 'agent_wrong',
      task_id: 'task_wrong',
      run_id: 'run_wrong',
    }, {
      teamId: 'team_context',
      agentId: 'agent_context',
      taskId: 'task_context',
      runId: 'run_context',
    }), {
      team_id: 'team_context',
      agent_id: 'agent_context',
      task_id: 'task_context',
      run_id: 'run_context',
    }, 'the execution scope must be authoritative over explicit fallbacks')

    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const common = {
      user_id: 'user_attribution',
      conversation_id: 'conversation_shared',
      source: 'agent-loop',
      duration_ms: 25,
      status: 'success' as const,
      turn_number: 1,
      request_body: { messages: [] },
      response: {
        content: [{ type: 'text' as const, text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }
    const executionA = tokenTracker.runWithContext({
      userId: common.user_id,
      conversationId: common.conversation_id,
      teamId: 'team_a',
      agentId: 'agent_a',
      taskId: 'task_a',
      runId: 'run_a',
    }, async () => {
      await gate
      await logAPICall({
        ...common,
        team_id: 'team_must_not_override_a',
        model: 'Claude-opus-4.6',
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
      })
    })
    const executionB = tokenTracker.runWithContext({
      userId: common.user_id,
      conversationId: common.conversation_id,
      teamId: 'team_b',
      agentId: 'agent_b',
      taskId: 'task_b',
      runId: 'run_b',
    }, async () => {
      await gate
      await logAPICall({
        ...common,
        model: 'Claude-opus-4.6',
        usage: { input_tokens: 0, output_tokens: 1_000_000 },
      })
    })
    release()
    await Promise.all([executionA, executionB])

    await logAPICall({
      ...common,
      source: 'legacy-background',
      model: 'unknown-legacy-model',
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    await logAPICall({
      ...common,
      source: 'explicit-background',
      model: 'unknown-background-model',
      usage: { input_tokens: 10, output_tokens: 5 },
      team_id: 'team_explicit',
      agent_id: 'agent_explicit',
      task_id: 'task_explicit',
      run_id: 'run_explicit',
    })

    assert.equal(created.length, 4)
    const callA = created.find(document => document.run_id === 'run_a')
    const callB = created.find(document => document.run_id === 'run_b')
    assert.deepEqual({
      team: callA?.team_id,
      agent: callA?.agent_id,
      task: callA?.task_id,
      run: callA?.run_id,
    }, {
      team: 'team_a',
      agent: 'agent_a',
      task: 'task_a',
      run: 'run_a',
    })
    assert.deepEqual({
      team: callB?.team_id,
      agent: callB?.agent_id,
      task: callB?.task_id,
      run: callB?.run_id,
    }, {
      team: 'team_b',
      agent: 'agent_b',
      task: 'task_b',
      run: 'run_b',
    }, 'concurrent Agents sharing one Conversation must keep distinct attribution')
    assert.equal(callA?.estimated_cost_cents, 10_800, 'cost is RMB 分 using the existing pricing table')
    assert.equal(callB?.estimated_cost_cents, 54_000, 'output cost is RMB 分, not USD cents')
    assert.ok(!Object.hasOwn(callA ?? {}, 'cost_usd'))
    assert.ok(!Object.hasOwn(callA ?? {}, 'estimated_cost_usd'))

    const legacy = created.find(document => document.source === 'legacy-background')
    for (const key of ['team_id', 'agent_id', 'task_id', 'run_id']) {
      assert.ok(!Object.hasOwn(legacy ?? {}, key), `legacy call unexpectedly gained ${key}`)
    }
    const explicit = created.find(document => document.source === 'explicit-background')
    assert.equal(explicit?.team_id, 'team_explicit')
    assert.equal(explicit?.agent_id, 'agent_explicit')
    assert.equal(explicit?.task_id, 'task_explicit')
    assert.equal(explicit?.run_id, 'run_explicit')

    assert.equal(usageUpdates.length, 4)
    assert.equal(usageUpdates[0].update.$inc?.estimated_cost_cents, 10_800)
    assert.equal(usageUpdates[1].update.$inc?.estimated_cost_cents, 54_000)
    assert.equal(usageUpdates[0].options.upsert, true)

    for (const path of [
      'team_id',
      'agent_id',
      'task_id',
      'run_id',
      'estimated_cost_cents',
    ]) {
      assert.ok(APICallLog.schema.path(path), `API call log schema missing ${path}`)
    }
    assert.equal(APICallLog.schema.path('cost_usd'), undefined)
    const indexKeys = (APICallLog.schema.indexes() as Array<[
      Record<string, unknown>,
      Record<string, unknown>,
    ]>).map(([keys]) => Object.keys(keys).join(','))
    for (const key of ['team_id,timestamp', 'agent_id,timestamp', 'task_id,timestamp', 'run_id,timestamp']) {
      assert.ok(indexKeys.includes(key), `API call log schema missing attribution index ${key}`)
    }

    const historical = new APICallLog({
      api_call_log_id: 'historical_without_agent_attribution',
      user_id: 'legacy_user',
      conversation_id: 'legacy_conversation',
      source: 'agent-loop',
      model: 'legacy-model',
    })
    await historical.validate()
    assert.equal(historical.team_id, undefined)
    assert.equal(historical.agent_id, undefined)
    assert.equal(historical.task_id, undefined)
    assert.equal(historical.run_id, undefined)
  } finally {
    Reflect.set(APICallLog, 'create', originalCreate)
    Reflect.set(DailyUsage, 'updateOne', originalUpdateOne)
    Reflect.set(ModelConfig, 'findOne', originalFindOne)
    mongoose.connect = originalConnect
    if (previousUri === undefined) delete process.env.MONGODB_URI
    else process.env.MONGODB_URI = previousUri
  }

  console.log('API call log attribution verification passed.')
}

void main()
