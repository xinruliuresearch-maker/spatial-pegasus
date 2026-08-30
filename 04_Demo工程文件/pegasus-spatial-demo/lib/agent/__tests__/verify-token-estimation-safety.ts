import assert from 'node:assert/strict'
import {
  estimateJsonCharsSafely,
  estimateTokens,
  reactiveCompact,
  type TokenEstimationDiagnostic,
} from '../compaction'
import {
  foldExpiredToolResults,
  type ToolResultFoldingDiagnostic,
} from '../tool-result-folding'
import type { ConversationMessage } from '../../types'
import type { AgentProvider } from '../loop'
import type { WorkspaceInstance } from '../../workspace/types'

const CHARS_PER_TOKEN = 3.5

function asMessages(value: unknown): ConversationMessage[] {
  return value as ConversationMessage[]
}

function verifyLegalEstimateIsUnchanged(): void {
  const input = { file_path: 'analysis/research-scope.md', offset: 3 }
  const messages: ConversationMessage[] = [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'normal text' },
        { type: 'thinking', thinking: 'thinking' },
        { type: 'tool_use', id: 'tool-1', name: 'Read', input },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tool-1', content: 'result body' },
        {
          type: 'tool_result',
          tool_use_id: 'tool-2',
          content: [
            { type: 'text', text: 'nested result' },
            { type: 'image', source: { type: 'url', url: 'https://example.invalid/a.png' } },
          ],
        },
        { type: 'image', source: { type: 'url', url: 'https://example.invalid/b.png' } },
        { type: 'redacted_thinking', data: 'opaque' },
      ],
    },
  ]

  const textChars = 'normal text'.length
    + 'thinking'.length
    + 'Read'.length
    + JSON.stringify(input).length
    + 'result body'.length
    + 'nested result'.length
  const oldFormula = Math.round(textChars / CHARS_PER_TOKEN) + 4_000
  const diagnostics: TokenEstimationDiagnostic[] = []

  assert.equal(estimateTokens(messages, { onDiagnostic: item => diagnostics.push(item) }), oldFormula)
  assert.deepEqual(diagnostics, [])
  assert.deepEqual(estimateJsonCharsSafely(input), {
    chars: JSON.stringify(input).length,
    usedFallback: false,
  })
}

function verifyMalformedToolInputsUseSafeBudget(): void {
  const circular: Record<string, unknown> = { secret: 'secret-tool-input' }
  circular.self = circular
  const toJsonUndefined = {
    secret: 'secret-tool-input',
    toJSON: () => undefined,
  }
  const values: unknown[] = [
    undefined,
    () => 'secret-tool-input',
    Symbol('secret-tool-input'),
    BigInt(42),
    circular,
    toJsonUndefined,
  ]

  for (const value of values) {
    const diagnostics: TokenEstimationDiagnostic[] = []
    const tokens = estimateTokens(asMessages([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-unsafe', name: 'Read', input: value }],
      },
    ]), { onDiagnostic: item => diagnostics.push(item) })

    assert.ok(Number.isFinite(tokens))
    assert.ok(tokens >= Math.round((16_384 + 'Read'.length) / CHARS_PER_TOKEN))
    assert.equal(diagnostics.length, 1)
    assert.equal(diagnostics[0].code, 'tool_input_not_serializable')
    assert.ok(diagnostics[0].fallback_chars >= 16_384)
    assert.doesNotMatch(JSON.stringify(diagnostics), /secret-tool-input/)
  }

  assert.doesNotThrow(() => estimateTokens(asMessages([
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tool-unsafe', name: 'Read', input: circular }],
    },
  ]), {
    onDiagnostic: () => {
      throw new Error('diagnostic sink is unavailable')
    },
  }))
}

function verifyPartialBlocksNeverCrashEstimator(): void {
  const diagnostics: TokenEstimationDiagnostic[] = []
  const messages = asMessages([
    { role: 'assistant' },
    {
      role: 'assistant',
      content: [
        null,
        { type: 'text' },
        { type: 'thinking' },
        { type: 'tool_use', id: 'missing-fields' },
        { type: 'tool_result', tool_use_id: 'missing-content' },
        {
          type: 'tool_result',
          tool_use_id: 'partial-parts',
          content: [{ type: 'text' }, null, { type: 'unknown' }],
        },
        { type: 'unknown' },
      ],
    },
  ])

  const tokens = estimateTokens(messages, { onDiagnostic: item => diagnostics.push(item) })
  assert.ok(Number.isFinite(tokens))
  assert.ok(tokens > 0)
  assert.deepEqual(new Set(diagnostics.map(item => item.code)), new Set([
    'message_content_not_array',
    'content_block_not_object',
    'text_missing',
    'thinking_missing',
    'tool_name_missing',
    'tool_input_not_serializable',
    'tool_result_content_invalid',
    'tool_result_text_missing',
    'tool_result_part_invalid',
    'tool_result_unknown_part',
    'unknown_content_block',
  ]))

  const topLevelDiagnostics: TokenEstimationDiagnostic[] = []
  const topLevelTokens = estimateTokens(undefined as unknown as ConversationMessage[], {
    onDiagnostic: item => topLevelDiagnostics.push(item),
  })
  assert.ok(topLevelTokens > 0)
  assert.equal(topLevelDiagnostics[0].code, 'messages_not_array')
}

function verifyFoldingHandlesMalformedHistory(): void {
  const circular: Record<string, unknown> = { secret: 'secret-tool-input' }
  circular.self = circular
  const diagnostics: ToolResultFoldingDiagnostic[] = []
  const messages = asMessages([
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'read-1', name: 'Read', input: circular },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'read-1', content: 'x'.repeat(10_000) },
        { type: 'tool_result', tool_use_id: 'broken-result', content: [{ type: 'text' }, null] },
      ],
    },
    { role: 'assistant' },
  ])

  const folded = foldExpiredToolResults(messages, {
    contextWindow: 100_000,
    cacheLastActivityAt: 0,
    cacheTtlMs: 1,
    nowMs: 10,
    onDiagnostic: item => diagnostics.push(item),
  })
  assert.equal(folded.foldedResults, 1)
  assert.ok(folded.tokensFreed > 0)
  assert.ok(diagnostics.some(item => item.code === 'tool_result_content_invalid'))
  assert.ok(diagnostics.some(item => item.code === 'message_content_not_array'))
  assert.doesNotMatch(JSON.stringify(diagnostics), /secret-tool-input/)

  const foldedReceipt = folded.messages[1].content[0]
  assert.equal(foldedReceipt.type, 'tool_result')
  if (foldedReceipt.type === 'tool_result') {
    assert.equal(typeof foldedReceipt.content, 'string')
    assert.doesNotMatch(String(foldedReceipt.content), /secret-tool-input/)
  }

  assert.doesNotThrow(() => foldExpiredToolResults(messages, {
    contextWindow: 100_000,
    cacheLastActivityAt: 0,
    cacheTtlMs: 1,
    nowMs: 10,
    onDiagnostic: () => {
      throw new Error('diagnostic sink is unavailable')
    },
  }))
}

function compactionProvider(counter: { calls: number }, summary = 'bounded summary'): AgentProvider {
  return {
    toolSchemas: [],
    buildRequest: () => ({}),
    buildCompactionRequest: () => ({}),
    async callLLM() {
      throw new Error('main LLM is not expected')
    },
    async callLLMSilent() {
      counter.calls += 1
      return {
        content: [{ type: 'text', text: `<summary>${summary}</summary>` }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 10 },
      }
    },
    async executeTool() {
      return { content: '' }
    },
  }
}

const emptyWorkspace = {
  list: () => [],
  stat: async () => null,
} as unknown as WorkspaceInstance

async function verifyReactiveCompactionNeverClaimsZeroMediaRewrite(): Promise<void> {
  const counter = { calls: 0 }
  const messages: ConversationMessage[] = [{
    role: 'user',
    content: [{ type: 'text', text: 'text-only history' }],
  }]
  const result = await reactiveCompact(
    compactionProvider(counter),
    messages,
    emptyWorkspace,
    1_000,
    {
      contextWindow: 2_000,
      outputHeadroomTokens: 500,
      estimateInputTokens: candidate => candidate[0]?._context_replacement ? 100 : 1_000,
    },
  )

  assert.equal(counter.calls, 1, 'text-only history must fall through to a real summary')
  assert.notEqual(result.summary, '[Reactive compact: media stripped to reduce context size]')
  assert.equal(result.preCompactionTokens, 1_000)
  assert.equal(result.postCompactionTokens, 100)
}

async function verifyLegacyApiCorrectionUsesOneTokenBasis(): Promise<void> {
  const counter = { calls: 0 }
  const messages: ConversationMessage[] = [{
    role: 'user',
    content: [{ type: 'text', text: 'x'.repeat(500_000) }],
  }]
  const result = await reactiveCompact(
    compactionProvider(counter),
    messages,
    emptyWorkspace,
    200_235,
    {
      contextWindow: 250_000,
      outputHeadroomTokens: 30_000,
    },
  )

  assert.equal(counter.calls, 1)
  assert.equal(result.preCompactionTokens, 200_235)
  assert.ok(result.postCompactionTokens < result.preCompactionTokens)
  assert.ok(result.postCompactionTokens < 220_000)
}

async function verifyReactiveCompactionUsesRealMediaReduction(): Promise<void> {
  const counter = { calls: 0 }
  const messages: ConversationMessage[] = [{
    role: 'user',
    content: [{
      type: 'image',
      source: { type: 'url', url: 'https://example.invalid/large.png' },
    }],
  }]
  const result = await reactiveCompact(
    compactionProvider(counter),
    messages,
    emptyWorkspace,
    1_000,
    {
      contextWindow: 2_000,
      outputHeadroomTokens: 500,
      estimateInputTokens: candidate => candidate.some(message => (
        message.content.some(block => block.type === 'image')
      )) ? 1_000 : 100,
    },
  )

  assert.equal(counter.calls, 0)
  assert.equal(result.summary, '[Reactive compact: media stripped to reduce context size]')
  assert.equal(result.postCompactionTokens, 100)
}

async function verifyReactiveCompactionRejectsRewriteWithoutHeadroom(): Promise<void> {
  const counter = { calls: 0 }
  const messages: ConversationMessage[] = [{
    role: 'user',
    content: [{ type: 'text', text: 'large history' }],
  }]

  await assert.rejects(
    reactiveCompact(
      compactionProvider(counter),
      messages,
      emptyWorkspace,
      1_800,
      {
        contextWindow: 2_000,
        outputHeadroomTokens: 500,
        estimateInputTokens: candidate => candidate[0]?._context_replacement ? 1_600 : 1_800,
      },
    ),
    /did not restore admission headroom/,
  )
  assert.equal(counter.calls, 1)
}

async function main(): Promise<void> {
  verifyLegalEstimateIsUnchanged()
  verifyMalformedToolInputsUseSafeBudget()
  verifyPartialBlocksNeverCrashEstimator()
  verifyFoldingHandlesMalformedHistory()
  await verifyReactiveCompactionNeverClaimsZeroMediaRewrite()
  await verifyLegacyApiCorrectionUsesOneTokenBasis()
  await verifyReactiveCompactionUsesRealMediaReduction()
  await verifyReactiveCompactionRejectsRewriteWithoutHeadroom()
  console.log('token estimation safety verification passed')
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
