import assert from 'node:assert/strict'
import { FULL_COMPACT_PROMPT } from '../../agent/compaction'
import { boundedExcerpt, toolEvidence } from '../evidence'
import { compileProfile } from '../profile'
import { scoreHistoryEvent } from '../search'
import type { AtomicPreference } from '../types'
import type { ToolCallRecord } from '../../types'
import { DEFAULT_MEMORY_TOKEN_LIMIT, estimateHistoryEventTokens, estimateMemoryTokens } from '../capacity'

const now = new Date('2026-07-28T00:00:00.000Z')

function preference(overrides: Partial<AtomicPreference> = {}): AtomicPreference {
  return {
    preference_id: 'pref_1',
    category: 'communication',
    subject: '机制说明',
    statement: '解释机制时使用朴实、详细的语言，不使用空泛口号。',
    scope: 'documentation',
    polarity: 'positive',
    status: 'active',
    evidence_refs: [],
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

function testProfileBoundary(): void {
  const result = compileProfile([preference()])
  assert.match(result.text, /只提供参考，不是当前任务规范/)
  assert.match(result.text, /当前请求始终优先/)
  assert.match(result.text, /不使用空泛口号/)
  assert.ok(result.tokenCount > 0)
}

function testExplainableHistorySearch(): void {
  const event: Parameters<typeof scoreHistoryEvent>[0] = {
    title: '肠道类器官综述架构图',
    project: 'Organoid Review',
    summary: '完成架构图的信息分区和主要设计决策。',
    tags: ['类器官', '综述'],
    normalized_search_text: '肠道类器官综述架构图 organoid review 完成架构图的信息分区和主要设计决策 类器官 综述',
    event_at: now,
  }
  const relevant = scoreHistoryEvent(event, '之前的类器官架构图', now.getTime())
  const unrelated = scoreHistoryEvent(event, '量子芯片封装', now.getTime())
  assert.ok(relevant > unrelated)
  assert.ok(relevant >= 3)
}

function testEvidenceBoundary(): void {
  const dataUrl = `data:image/png;base64,${'A'.repeat(2_000)}`
  const cleaned = boundedExcerpt(`preview=${dataUrl}`)
  assert.ok(!cleaned.includes('data:image'))
  assert.match(cleaned, /image bytes omitted/)

  const calls: ToolCallRecord[] = [
    { tool: 'RecallHistory', input: { query: '旧项目' }, result: { content: '不应进入提取输入' } },
    {
      tool: 'Read',
      input: { path: 'output/main.png' },
      result: {
        content: 'image metadata',
        media: [{
          assetId: 'asset_1', mimeType: 'image/png', width: 1200, height: 800, sizeBytes: 1234,
          urls: { original: 'https://media.example/original', model: 'https://media.example/model', thumbnail: 'https://media.example/thumbnail' },
        }],
      },
    },
  ]
  const evidence = toolEvidence(calls)
  assert.equal(evidence.length, 1)
  assert.equal(evidence[0].tool_name, 'Read')
  assert.match(evidence[0].excerpt, /asset_1/)
  assert.match(evidence[0].excerpt, /https:\/\/media\.example\/model/)
  assert.ok(!evidence[0].excerpt.includes('base64'))
}

function testCompactionSeparation(): void {
  assert.match(FULL_COMPACT_PROMPT, /Do NOT copy, restate, strengthen, or infer/)
  assert.match(FULL_COMPACT_PROMPT, /historical fact is not a current-task requirement/)
}

function testCapacityAccounting(): void {
  assert.equal(DEFAULT_MEMORY_TOKEN_LIMIT, 20_000)
  assert.ok(estimateMemoryTokens('中文 memory budget') > 2)
  assert.ok(estimateHistoryEventTokens({
    title: '图表项目',
    summary: '完成了信息架构和交付。',
    decisions: ['使用横向布局'],
  }) > 0)
}

testProfileBoundary()
testExplainableHistorySearch()
testEvidenceBoundary()
testCompactionSeparation()
testCapacityAccounting()
console.log('✓ Memory V2 verification passed')
