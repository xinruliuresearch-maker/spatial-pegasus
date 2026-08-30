import { randomUUID } from 'crypto'
import type { ConversationMessage, ContentBlock, ToolCallRecord } from '../types'
import type { MemoryEvidenceRef } from './types'

const MAX_EXCERPT = 2_400
const MAX_TOOL_EXCERPT = 800

function stripUnsafePayload(value: string): string {
  return value
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/gi, '[image bytes omitted]')
    .replace(/[A-Za-z0-9+/]{4,}={0,2}/g, match => (match.length > 1_000 ? '[binary payload omitted]' : match))
    .replace(/\s+/g, ' ')
    .trim()
}
export function boundedExcerpt(value: string, max = MAX_EXCERPT): string {
  const cleaned = stripUnsafePayload(value)
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max)}…`
}

function textFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

export function userEvidence(text: string, messageIndex?: number): MemoryEvidenceRef {
  return {
    evidence_id: `ev_${randomUUID().replace(/-/g, '')}`,
    role: 'user',
    excerpt: boundedExcerpt(text),
    message_index: messageIndex,
    created_at: new Date(),
  }
}

export function assistantEvidence(messages: ConversationMessage[], startIndex = 0): MemoryEvidenceRef[] {
  return messages.flatMap((message, index) => {
    if (message.role !== 'assistant') return []
    const excerpt = boundedExcerpt(textFromBlocks(message.content))
    if (!excerpt) return []
    return [{
      evidence_id: `ev_${randomUUID().replace(/-/g, '')}`,
      role: 'assistant' as const,
      excerpt,
      message_index: startIndex + index,
      created_at: new Date(),
    }]
  })
}

const ARTIFACT_TOOLS = new Set(['Write', 'Edit'])

export function toolEvidence(calls: ToolCallRecord[]): MemoryEvidenceRef[] {
  return calls.flatMap(call => {
    if (call.tool === 'RecallHistory') return []
    const assets = (call.result.media ?? []).map(item => ({
      assetId: item.assetId,
      mimeType: item.mimeType,
      width: item.width,
      height: item.height,
      url: item.urls.model,
    }))
    const path = typeof call.input.path === 'string'
      ? call.input.path
      : typeof call.input.file_path === 'string'
        ? call.input.file_path
        : undefined
    const compact = {
      tool: call.tool,
      success: !call.result.is_error,
      ...(path ? { path } : {}),
      ...(ARTIFACT_TOOLS.has(call.tool) ? { result: boundedExcerpt(call.result.content, MAX_TOOL_EXCERPT) } : {}),
      ...(assets.length ? { assets } : {}),
    }
    return [{
      evidence_id: `ev_${randomUUID().replace(/-/g, '')}`,
      role: ARTIFACT_TOOLS.has(call.tool) ? 'workspace' as const : 'tool' as const,
      excerpt: JSON.stringify(compact),
      tool_name: call.tool,
      created_at: new Date(),
    }]
  })
}

export function completionEvidence(status: 'completed' | 'waiting_user'): MemoryEvidenceRef {
  return {
    evidence_id: `ev_${randomUUID().replace(/-/g, '')}`,
    role: 'completion',
    excerpt: status,
    created_at: new Date(),
  }
}
