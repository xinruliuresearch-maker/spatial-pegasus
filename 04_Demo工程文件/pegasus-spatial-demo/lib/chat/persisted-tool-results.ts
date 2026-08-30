import type { DisplayPart, ToolResultBlock } from '../types'

function persistedToolResultText(content: ToolResultBlock['content']): string | undefined {
  if (typeof content === 'string') return content
  const text = content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
  return text || undefined
}

/**
 * Reattach a persisted tool_result to its exact historical tool_use row.
 * Live SSE already supplies `content` in tool_done; Mongo hydration must do
 * the same or SpatialJobCard loses its durable envelope after refresh/restart.
 */
export function attachPersistedToolResult(
  parts: DisplayPart[],
  result: ToolResultBlock,
): boolean {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (
      part.type !== 'tool_call'
      || part.tool_use_id !== result.tool_use_id
    ) continue
    const content = persistedToolResultText(result.content)
    parts[index] = {
      ...part,
      pending: false,
      ...(result.is_error ? { is_error: true } : {}),
      ...(content !== undefined
        ? { content }
        : {}),
    }
    return true
  }
  return false
}
