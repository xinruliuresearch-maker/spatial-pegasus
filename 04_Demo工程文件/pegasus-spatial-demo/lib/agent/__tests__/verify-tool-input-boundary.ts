import assert from 'node:assert/strict'
import { agentLoop, type AgentProvider } from '../loop'
import {
  enforceToolInputBoundary,
  enforceVisibleToolInputBoundary,
  type ToolInputRejectionCode,
} from '../tool-input-boundary'
import type {
  ConversationMessage,
  LLMResponse,
  ToolSchema,
  ToolResult,
} from '../../types'
import { getToolSchemasForCapabilities } from '../../tools/schemas'
import { buildOrphanedToolRecoveryMessage } from '../../agent-runtime/tool-recovery'

const EMPTY_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

function response(content: LLMResponse['content']): LLMResponse {
  return {
    content,
    stop_reason: content.some(block => block.type === 'tool_use')
      ? 'tool_use'
      : 'end_turn',
    usage: { ...EMPTY_USAGE },
  }
}

class ScriptedProvider implements AgentProvider {
  readonly executed: Array<{ name: string; input: Record<string, unknown> }> = []
  readonly started: Array<{ name: string; input: Record<string, unknown> }> = []
  readonly completed: Array<{ name: string; input: Record<string, unknown>; result: ToolResult }> = []
  readonly requests: ConversationMessage[][] = []

  constructor(
    private readonly responses: LLMResponse[],
    readonly toolSchemas: readonly ToolSchema[] = getToolSchemasForCapabilities({
      supportsVision: true,
      includeRecallHistory: true,
    }),
  ) {}

  buildRequest(messages: ConversationMessage[]): Record<string, never> {
    // Exercise the same JSON boundary used by a real Provider request.
    JSON.stringify(messages)
    this.requests.push(messages)
    return {}
  }

  buildCompactionRequest(): Record<string, never> {
    return {}
  }

  async callLLM(): Promise<LLMResponse> {
    const next = this.responses.shift()
    assert.ok(next, 'scripted provider ran out of responses')
    return next
  }

  async callLLMSilent(): Promise<LLMResponse> {
    throw new Error('compaction is not expected in this focused test')
  }

  async executeTool(
    name: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    this.executed.push({ name, input })
    return { content: 'executed' }
  }

  onToolStart(name: string, input: Record<string, unknown>): void {
    this.started.push({ name, input })
  }

  onToolExecuted(name: string, input: Record<string, unknown>, result: ToolResult): void {
    this.completed.push({ name, input, result })
  }
}

function rejectionCode(input: unknown): ToolInputRejectionCode | undefined {
  const result = enforceToolInputBoundary(input)
  return result.ok ? undefined : result.rejection.code
}

function testPureBoundary(): void {
  const legal = {
    z: 'preserve insertion order',
    a: [null, true, 1, { nested: 'value' }],
    toJSON: 'ordinary JSON key',
  }
  const accepted = enforceToolInputBoundary(legal)
  assert.equal(accepted.ok, true)
  if (accepted.ok) {
    assert.equal(accepted.input, legal, 'valid input must retain exact object identity')
    assert.equal(accepted.serialized, JSON.stringify(legal), 'valid key/byte ordering must not be rewritten')
  }

  assert.equal(rejectionCode(undefined), 'not_object')
  assert.equal(rejectionCode(null), 'not_object')
  assert.equal(rejectionCode([]), 'array_root')
  assert.equal(rejectionCode({ bad: undefined }), 'unsupported_value')
  assert.equal(rejectionCode({ bad: () => true }), 'unsupported_value')
  assert.equal(rejectionCode({ bad: Symbol('bad') }), 'unsupported_value')
  assert.equal(rejectionCode({ bad: BigInt(1) }), 'unsupported_value')
  assert.equal(rejectionCode({ bad: Number.NaN }), 'non_finite_number')
  assert.equal(rejectionCode({ bad: Number.POSITIVE_INFINITY }), 'non_finite_number')
  assert.equal(rejectionCode({ bad: new Date() }), 'non_plain_object')

  const circular: Record<string, unknown> = {}
  circular.self = circular
  assert.equal(rejectionCode(circular), 'circular_reference')

  const symbolKey = { value: 1 } as Record<PropertyKey, unknown>
  symbolKey[Symbol('hidden')] = 'not JSON'
  assert.equal(rejectionCode(symbolKey), 'symbol_key')

  let getterCalled = false
  const accessor: Record<string, unknown> = {}
  Object.defineProperty(accessor, 'danger', {
    enumerable: true,
    get() {
      getterCalled = true
      throw new Error('must never run')
    },
  })
  assert.equal(rejectionCode(accessor), 'accessor_property')
  assert.equal(getterCalled, false, 'validation must inspect descriptors without invoking getters')

  const throwingToJson = {
    value: 1,
    toJSON() {
      throw new Error('must never run')
    },
  }
  assert.equal(rejectionCode(throwingToJson), 'unsupported_value')

  let alternating = false
  const unstable = new Proxy({ value: 1 }, {
    get(target, property, receiver) {
      if (property === 'value') {
        alternating = !alternating
        return alternating ? 1 : 2
      }
      return Reflect.get(target, property, receiver)
    },
  })
  assert.equal(rejectionCode(unstable), 'unstable_serialization')
}

function testVisibleSchemaBoundary(): void {
  const visible = getToolSchemasForCapabilities({ supportsVision: true })
  const valid = { file_path: 'analysis/schema.md', content: 'unchanged bytes' }
  const accepted = enforceVisibleToolInputBoundary('Write', valid, visible)
  assert.equal(accepted.ok, true)
  if (accepted.ok) {
    assert.equal(accepted.input, valid, 'schema validation must preserve valid input identity')
    assert.equal(accepted.serialized, JSON.stringify(valid), 'schema validation must preserve valid input bytes')
  }

  const cases: Array<{
    name: string
    input: Record<string, unknown>
    code: ToolInputRejectionCode
    path: string
  }> = [
    { name: 'Write', input: { file_path: 'analysis/x.md' }, code: 'schema_required', path: '$.content' },
    { name: 'Write', input: { file_path: 'analysis/x.md', content: 7 }, code: 'schema_type', path: '$.content' },
    { name: 'Glob', input: { pattern: '*.md', root: 'private' }, code: 'schema_enum', path: '$.root' },
    {
      name: 'Agent',
      input: { name: 'Scout', description: 'Scout', prompt: 'Work', budget: { max_tokens: 'many' } },
      code: 'schema_type',
      path: '$.budget.max_tokens',
    },
    {
      name: 'Agent',
      input: { name: 'Scout', description: 'Scout', prompt: 'Work', budget: { surprise: 1 } },
      code: 'schema_constraint',
      path: '$.budget.surprise',
    },
    { name: 'InvisibleTool', input: {}, code: 'unknown_tool', path: '$' },
  ]
  for (const testCase of cases) {
    const rejected = enforceVisibleToolInputBoundary(testCase.name, testCase.input, visible)
    assert.equal(rejected.ok, false, `${testCase.name} input should be rejected`)
    if (!rejected.ok) {
      assert.equal(rejected.rejection.code, testCase.code)
      assert.equal(rejected.rejection.path, testCase.path)
    }
  }

  const directObject = enforceVisibleToolInputBoundary('CreateObject3D', {
    prompt: '一把由磨砂铝和深蓝织物构成的模块化座椅',
    output_path_prefix: 'output/spatial/objects/chair-a',
  }, visible)
  assert.equal(directObject.ok, true, 'direct text-to-object must remain available')

  const referencedWorld = enforceVisibleToolInputBoundary('CreateWorld3D', {
    source_image_path: 'output/spatial/images/room-reference.png',
    output_path_prefix: 'output/spatial/worlds/room-a',
  }, visible)
  assert.equal(referencedWorld.ok, true, 'image-conditioned world creation must remain available')

  const positiveSceneScale = enforceVisibleToolInputBoundary('AddSceneObject', {
    scene_id: 'scene_scale_boundary',
    object_job_id: 'spjob_scale_boundary',
    scale: [0.5, 1, 2],
  }, visible)
  assert.equal(positiveSceneScale.ok, true, 'positive Scene scale must satisfy exclusiveMinimum')

  const zeroSceneScale = enforceVisibleToolInputBoundary('AddSceneObject', {
    scene_id: 'scene_scale_boundary',
    object_job_id: 'spjob_scale_boundary',
    scale: [0, 1, 1],
  }, visible)
  assert.equal(zeroSceneScale.ok, false, 'zero Scene scale must remain invalid')
  if (!zeroSceneScale.ok) {
    assert.equal(zeroSceneScale.rejection.code, 'schema_constraint')
    assert.equal(zeroSceneScale.rejection.path, '$.scale[0]')
  }

  const missingObjectIntent = enforceVisibleToolInputBoundary('CreateObject3D', {
    output_path_prefix: 'output/spatial/objects/missing-intent',
  }, visible)
  assert.equal(
    missingObjectIntent.ok,
    true,
    'relay-compatible schema leaves the prompt/reference cross-field rule to the runtime validator',
  )

  const missingWorldIntent = enforceVisibleToolInputBoundary('CreateWorld3D', {
    output_path_prefix: 'output/spatial/worlds/missing-intent',
  }, visible)
  assert.equal(
    missingWorldIntent.ok,
    true,
    'relay-compatible schema leaves the prompt/source-image cross-field rule to the runtime validator',
  )
}

async function testInvalidNewToolUseProducesRepairResult(): Promise<void> {
  const invalidInput = undefined as unknown as Record<string, unknown>
  const provider = new ScriptedProvider([
    response([{
      type: 'tool_use',
      id: 'tool_invalid_input',
      name: 'Write',
      input: invalidInput,
    }]),
    response([{ type: 'text', text: 'I corrected the malformed call.' }]),
  ])
  const persisted: ConversationMessage[] = []
  const warnings: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => warnings.push(args)
  const result = await (async () => {
    try {
      return await agentLoop(provider, [], {
        runId: 'run_invalid_tool_input',
        maxTurns: 2,
        onTurnComplete(messages) {
          persisted.push(...messages)
          JSON.stringify(messages)
        },
      })
    } finally {
      console.warn = originalWarn
    }
  })()

  assert.deepEqual(provider.executed, [], 'invalid input must never reach executeTool')
  assert.equal(provider.started.length, 1, 'the rejected call remains visible as a started tool card')
  assert.deepEqual(
    Object.keys(provider.started[0].input),
    ['_sci_pegasus_rejected_tool_input'],
    'tool UI callbacks must receive only the sanitized placeholder',
  )
  assert.equal(provider.completed.length, 1)
  assert.equal(provider.completed[0].result.is_error, true)
  const diagnostic = warnings.find(args => args[0] === '[agent-loop] tool-input-boundary rejection')
  assert.ok(diagnostic, 'rejections must leave a structured metadata-only diagnostic')
  assert.deepEqual(JSON.parse(String(diagnostic[1])), {
    source: 'llm_response',
    turn: 1,
    block_index: 0,
    tool_use_id: 'tool_invalid_input',
    tool_name: 'Write',
    code: 'not_object',
    path: '$',
  })
  assert.equal(result.text, 'I corrected the malformed call.')
  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].result.is_error, true)
  assert.match(result.toolCalls[0].result.content, /rejected before execution/)
  assert.match(result.toolCalls[0].result.content, /The tool was not run/)

  const assistantToolUse = persisted
    .flatMap(message => message.content)
    .find(block => block.type === 'tool_use')
  assert.ok(assistantToolUse && assistantToolUse.type === 'tool_use')
  assert.deepEqual(Object.keys(assistantToolUse.input), ['_sci_pegasus_rejected_tool_input'])
  assert.doesNotThrow(() => JSON.stringify(assistantToolUse.input))

  const repairResult = persisted
    .flatMap(message => message.content)
    .find(block => block.type === 'tool_result' && block.tool_use_id === 'tool_invalid_input')
  assert.ok(repairResult && repairResult.type === 'tool_result')
  assert.equal(repairResult.is_error, true)
}

async function testValidToolInputStillExecutesUnchanged(): Promise<void> {
  const validInput = { file_path: 'analysis/test.md', content: 'hello' }
  const provider = new ScriptedProvider([
    response([{
      type: 'tool_use',
      id: 'tool_valid_input',
      name: 'Write',
      input: validInput,
    }]),
    response([{ type: 'text', text: 'done' }]),
  ])
  await agentLoop(provider, [], { maxTurns: 2 })

  assert.equal(provider.executed.length, 1)
  assert.equal(provider.executed[0].input, validInput, 'valid calls must keep exact input identity')
  assert.equal(provider.started[0].input, validInput)
  assert.equal(provider.completed[0].input, validInput)
}

async function testSchemaInvalidAndUnknownToolsNeverExecute(): Promise<void> {
  const provider = new ScriptedProvider([
    response([
      { type: 'tool_use', id: 'tool_missing_required', name: 'Write', input: { file_path: 'analysis/x.md' } },
      { type: 'tool_use', id: 'tool_unknown', name: 'InvisibleTool', input: {} },
    ]),
    response([{ type: 'text', text: 'reissued safely' }]),
  ])
  const persisted: ConversationMessage[] = []
  const result = await agentLoop(provider, [], {
    maxTurns: 2,
    onTurnComplete(messages) {
      persisted.push(...messages)
    },
  })

  assert.equal(result.text, 'reissued safely')
  assert.equal(provider.executed.length, 0)
  assert.equal(result.toolCalls.length, 2)
  assert.ok(result.toolCalls.every(call => call.result.is_error === true))
  const results = persisted.flatMap(message => message.content).filter(block => block.type === 'tool_result')
  assert.deepEqual(results.map(block => block.type === 'tool_result' ? block.tool_use_id : ''), [
    'tool_missing_required',
    'tool_unknown',
  ])
}

async function testMixedAskUserBatchFailsClosedWithCompleteAudit(): Promise<void> {
  const provider = new ScriptedProvider([
    response([
      {
        type: 'tool_use',
        id: 'tool_ask_mixed',
        name: 'AskUserQuestion',
        input: {
          questions: [{
            id: 'scope',
            header: 'Scope',
            question: 'Which scope?',
            options: [{ label: 'A' }, { label: 'B' }],
            multi_select: false,
          }],
        },
      },
      {
        type: 'tool_use',
        id: 'tool_write_mixed',
        name: 'Write',
        input: { file_path: 'analysis/should-not-exist.md', content: 'must not execute' },
      },
    ]),
    response([{ type: 'text', text: 'separated the calls' }]),
  ])
  const persisted: ConversationMessage[] = []
  let asked = 0
  let durableToolAuthorities = 0
  const result = await agentLoop(provider, [], {
    maxTurns: 2,
    onAskUser() {
      asked += 1
    },
    onActionStart(action) {
      if (action.kind === 'tool_call') durableToolAuthorities += 1
    },
    onTurnComplete(messages) {
      persisted.push(...messages)
    },
  })

  assert.equal(asked, 0, 'mixed AskUserQuestion must not trigger the interaction boundary')
  assert.equal(durableToolAuthorities, 0, 'fail-closed calls must not create replay authority')
  assert.equal(provider.executed.length, 0, 'the entire mixed batch must fail closed')
  assert.equal(result.toolCalls.length, 2)
  assert.ok(result.toolCalls.every(call => call.result.is_error === true))
  const auditedUses = persisted.flatMap(message => message.content).filter(block => block.type === 'tool_use')
  const auditedResults = persisted.flatMap(message => message.content).filter(block => block.type === 'tool_result')
  assert.deepEqual(auditedUses.map(block => block.type === 'tool_use' ? block.id : ''), [
    'tool_ask_mixed',
    'tool_write_mixed',
  ])
  assert.deepEqual(auditedResults.map(block => block.type === 'tool_result' ? block.tool_use_id : ''), [
    'tool_ask_mixed',
    'tool_write_mixed',
  ])
}

async function testCrashAfterModelCheckpointRepairsEveryOrphanWithoutReplay(): Promise<void> {
  const provider = new ScriptedProvider([
    response([
      { type: 'tool_use', id: 'crash_write', name: 'Write', input: { file_path: 'analysis/a.md', content: 'a' } },
      { type: 'tool_use', id: 'crash_read', name: 'Read', input: { file_path: 'analysis/a.md' } },
    ]),
  ])
  const persisted: ConversationMessage[] = []
  await assert.rejects(
    agentLoop(provider, [], {
      runId: 'run_model_checkpoint_crash',
      maxTurns: 1,
      onTurnComplete(messages) {
        persisted.push(...messages)
      },
      onActionStart(action) {
        if (action.kind === 'tool_call') {
          throw new Error('simulated crash before tool execution journal')
        }
      },
    }),
    /simulated crash/,
  )
  assert.equal(provider.executed.length, 0)
  assert.deepEqual(
    persisted.flatMap(message => message.content).filter(block => block.type === 'tool_use').map(block => (
      block.type === 'tool_use' ? block.id : ''
    )),
    ['crash_write', 'crash_read'],
    'assistant tool batch must already be durable at this crash point',
  )

  const repaired = buildOrphanedToolRecoveryMessage({
    messages: persisted,
    runId: 'run_model_checkpoint_crash',
    sequence: 1,
  })
  assert.ok(repaired)
  assert.deepEqual(repaired.content.map(block => block.type === 'tool_result' ? block.tool_use_id : ''), [
    'crash_write',
    'crash_read',
  ])
  assert.ok(repaired.content.every(block => block.type === 'tool_result' && block.is_error === true))
}

async function testInvalidHistoricalToolUseIsSafeBeforeProviderBuild(): Promise<void> {
  const circular: Record<string, unknown> = {}
  circular.self = circular
  const history: ConversationMessage[] = [
    {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'legacy_invalid_tool',
        name: 'Read',
        input: circular,
      }],
    },
    {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'legacy_invalid_tool',
        content: 'legacy failure',
        is_error: true,
      }],
    },
  ]
  const provider = new ScriptedProvider([
    response([{ type: 'text', text: 'history recovered' }]),
  ])

  const result = await agentLoop(provider, history, { maxTurns: 1 })
  assert.equal(result.text, 'history recovered')
  const guarded = provider.requests[0][0].content[0]
  assert.equal(guarded.type, 'tool_use')
  if (guarded.type === 'tool_use') {
    assert.deepEqual(Object.keys(guarded.input), ['_sci_pegasus_rejected_tool_input'])
    assert.doesNotThrow(() => JSON.stringify(guarded.input))
  }
}

async function testPersistedRejectionMarkerRemainsByteStable(): Promise<void> {
  const persistedInput = {
    _sci_pegasus_rejected_tool_input: {
      code: 'invalid_schema',
      path: '$.scale[0]',
      message: 'unsupported tool-schema keyword exclusiveMinimum',
    },
  }
  const history: ConversationMessage[] = [
    {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'persisted_rejection',
        name: 'AddSceneObject',
        input: persistedInput,
      }],
    },
    {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'persisted_rejection',
        content: 'Tool input rejected before execution.',
        is_error: true,
      }],
    },
  ]
  const before = JSON.stringify(history)
  const provider = new ScriptedProvider([
    response([{ type: 'text', text: 'history preserved' }]),
  ])

  const result = await agentLoop(provider, history, { maxTurns: 1 })

  assert.equal(result.text, 'history preserved')
  assert.equal(JSON.stringify(provider.requests[0].slice(0, history.length)), before)
  const replayed = provider.requests[0][0].content[0]
  assert.equal(replayed.type, 'tool_use')
  if (replayed.type === 'tool_use') {
    assert.deepEqual(replayed.input, persistedInput)
  }
}

async function main(): Promise<void> {
  testPureBoundary()
  testVisibleSchemaBoundary()
  await testInvalidNewToolUseProducesRepairResult()
  await testValidToolInputStillExecutesUnchanged()
  await testSchemaInvalidAndUnknownToolsNeverExecute()
  await testMixedAskUserBatchFailsClosedWithCompleteAudit()
  await testCrashAfterModelCheckpointRepairsEveryOrphanWithoutReplay()
  await testInvalidHistoricalToolUseIsSafeBeforeProviderBuild()
  await testPersistedRejectionMarkerRemainsByteStable()
  console.log('tool-input-boundary:verify passed')
}

void main()
