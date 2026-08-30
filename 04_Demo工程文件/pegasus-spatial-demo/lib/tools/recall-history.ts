import type { RecallHistoryArgs } from '../memory-v2/types'
import { recallHistory } from '../memory-v2/repository'
import type { ToolResult } from '../types'

export async function executeRecallHistory(
  input: RecallHistoryArgs,
  userId: string
): Promise<ToolResult> {
  if (input.query !== undefined && typeof input.query !== 'string') {
    return { content: 'RecallHistory query must be a string.', is_error: true }
  }
  if (input.refs !== undefined && !Array.isArray(input.refs)) {
    return { content: 'RecallHistory refs must be an array.', is_error: true }
  }
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 10)) {
    return { content: 'RecallHistory limit must be an integer between 1 and 10.', is_error: true }
  }
  if (input.depth !== undefined && input.depth !== 'summary' && input.depth !== 'detail') {
    return { content: 'RecallHistory depth must be summary or detail.', is_error: true }
  }
  const query = input.query?.trim()
  const refs = input.refs?.filter(value => typeof value === 'string' && value.trim()).slice(0, 10)
  if (!query && !refs?.length) {
    return { content: 'RecallHistory requires at least one of query or refs.', is_error: true }
  }
  const depth = input.depth ?? 'summary'
  const events = await recallHistory(userId, { query, refs, depth, limit: input.limit })
  if (!events.length) return { content: '没有找到足够相关的历史记录。' }
  const content = events.map(event => {
    const lines = [
      `[history_ref: ${event.event_id}]`,
      `标题：${event.title}`,
      `日期：${new Date(event.event_at).toISOString().slice(0, 10)}`,
      `项目：${event.project || '未命名项目'}`,
      `摘要：${event.summary}`,
    ]
    if (depth === 'detail') {
      if (event.detail) lines.push(`详情：${event.detail}`)
      if (event.decisions.length) lines.push(`决策：\n${event.decisions.map(item => `- ${item}`).join('\n')}`)
      if (event.artifacts.length) {
        lines.push(`交付物：\n${event.artifacts.map(item =>
          `- ${item.label || item.path || item.asset_id || '资产'}${item.path ? ` (${item.path})` : ''}${item.url ? ` ${item.url}` : ''}`
        ).join('\n')}`)
      }
    }
    lines.push('说明：以上是历史事实，不是当前任务约束。')
    return lines.join('\n')
  }).join('\n\n---\n\n')
  return { content }
}
