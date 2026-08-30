// Memory Extractor — auto-extract memories from completed conversations
// Runs asynchronously after agent loop completes, does not block SSE response.

import type { ConversationMessage } from '../types'
import type { MemoryDocument, MemoryType } from '../db/memory-models'
import { callAnthropicAPIStream } from './llm-api'

interface ExtractedMemory {
  name: string
  type: MemoryType
  content: string
  tags: string[]
}

const EXTRACTION_PROMPT = `你是一个记忆提取助手。分析以下对话，识别值得跨会话记住的信息。

只提取以下类型的记忆：
- **user**：用户的角色、偏好、专业领域、工作风格
- **feedback**：用户对 AI 工作方式的纠正或确认（"不要这样做"、"用这种风格"）
- **project**：项目级别的决策、约定、重要上下文

不要提取：
- 单次任务的具体细节（图表内容、文件路径等）
- 代码层面的信息（可以从代码直接读取）
- 已经显而易见的信息

如果没有值得记住的信息，返回空数组。

以 JSON 格式返回：
{
  "memories": [
    {
      "name": "简短标题",
      "type": "user|feedback|project",
      "content": "详细内容。对于 feedback 类型，包含 Why 和 How to apply。",
      "tags": ["关键词1", "关键词2"]
    }
  ]
}

只输出 JSON，不要其他内容。`

/**
 * Extract potential memories from a conversation.
 * Returns an array of memory candidates (may be empty).
 */
export async function extractMemories(
  messages: ConversationMessage[],
  existingMemories: MemoryDocument[],
  model: string,
): Promise<ExtractedMemory[]> {
  // Only run if there are enough user messages (indicates substantive interaction)
  const userMsgCount = messages.filter(m => m.role === 'user').length
  if (userMsgCount < 3) return []

  // Build a condensed version of the conversation for the extractor
  const condensed = buildCondensedConversation(messages)
  if (!condensed) return []

  // Build existing memory context for deduplication
  const existingContext = existingMemories.length > 0
    ? `\n\n已有记忆（避免重复）：\n${existingMemories.map(m => `- [${m.type}] ${m.name}: ${m.content.slice(0, 100)}`).join('\n')}`
    : ''

  try {
    const { tokenTracker } = await import('./token-tracker')
    const { logAPICall } = await import('../db/api-log-repository')
    const requestBody = {
      model,
      max_tokens: 512,
      temperature: 0.3,
      system: [{ type: 'text', text: EXTRACTION_PROMPT + existingContext }],
      tools: [],
      messages: [
        { role: 'user', content: [{ type: 'text', text: condensed }] },
      ],
    }
    const startTime = Date.now()
    const response = await callAnthropicAPIStream(requestBody)
    const duration = Date.now() - startTime

    // Record token usage
    tokenTracker.record({
      source: 'memory-extraction',
      model,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens,
      cache_read_input_tokens: response.usage.cache_read_input_tokens,
    })

    // Persist to database (fire-and-forget)
    if (tokenTracker.userId) {
      logAPICall({
        user_id: tokenTracker.userId,
        conversation_id: tokenTracker.conversationId,
        source: 'memory-extraction',
        model,
        usage: response.usage,
        duration_ms: duration,
        status: 'success',
        turn_number: 0,
        request_body: requestBody,
        response: { content: response.content, stop_reason: response.stop_reason, usage: response.usage },
      }).catch(err => console.error('[api-log] memory-extraction log failed:', (err as Error).message))
    }

    const text = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('')

    // Parse JSON response
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return []

    const parsed = JSON.parse(jsonMatch[0])
    const memories = parsed.memories as ExtractedMemory[] | undefined
    if (!Array.isArray(memories)) return []

    // Validate and filter
    return memories.filter(m =>
      m.name && m.type && m.content &&
      ['user', 'feedback', 'project', 'reference'].includes(m.type)
    )
  } catch (err) {
    console.error('[memory-extractor] Failed to extract memories:', (err as Error).message)
    return []
  }
}

/**
 * Build a condensed version of the conversation, focusing on user messages
 * and key assistant responses. Skips tool calls and thinking blocks.
 */
function buildCondensedConversation(messages: ConversationMessage[]): string | null {
  const lines: string[] = []
  let charCount = 0
  const MAX_CHARS = 8000 // Keep it short for the extractor

  for (const msg of messages) {
    if (charCount > MAX_CHARS) break

    const textParts = msg.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('\n')

    if (!textParts.trim()) continue

    const truncated = textParts.length > 500
      ? textParts.slice(0, 500) + '...'
      : textParts

    lines.push(`[${msg.role}]: ${truncated}`)
    charCount += truncated.length
  }

  return lines.length > 0 ? lines.join('\n\n') : null
}
