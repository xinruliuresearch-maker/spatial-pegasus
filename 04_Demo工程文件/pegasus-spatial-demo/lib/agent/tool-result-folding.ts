import type {
  ContentBlock,
  ConversationMessage,
  TextBlock,
  ToolResultBlock,
  ToolResultContent,
} from '../types'

const CHARS_PER_TOKEN = 3.5
const IMAGE_TOKEN_BUDGET = 2_000
const DEFAULT_MIN_FOLD_TOKENS = 2_000

const NEVER_FOLD = new Set(['Skill', 'AskUserQuestion'])
const REFETCHABLE = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'ArxivSearchPapers',
  'SciverseSearchPapers',
  'SciverseSearchEvidence',
  'SciverseListRelations',
  'SearchDocument',
])
const DURABLE_MUTATIONS = new Set([
  'Write',
  'Edit',
  'ArxivFetchPaper',
  'SciverseFetchPaper',
])

interface ToolUseInfo {
  name: string
  input: unknown
}

export type ToolResultFoldingDiagnosticCode =
  | 'message_content_not_array'
  | 'content_block_invalid'
  | 'tool_use_invalid'
  | 'tool_result_content_invalid'

export interface ToolResultFoldingDiagnostic {
  code: ToolResultFoldingDiagnosticCode
  message_index: number
  block_index?: number
}

export interface ToolResultFoldingOptions {
  /** Provider context window W. The fold floor is max(2K, 1% × W). */
  contextWindow: number
  /** Last request that may have created or read the active prompt prefix cache. */
  cacheLastActivityAt?: Date | string | number | null
  /** Configured cache TTL. Default Anthropic ephemeral cache is 5 minutes. */
  cacheTtlMs: number
  nowMs?: number
  /** Receives structural metadata only; result text and tool inputs are omitted. */
  onDiagnostic?: (diagnostic: ToolResultFoldingDiagnostic) => void
}

export interface ToolResultFoldingResult {
  messages: ConversationMessage[]
  cacheExpired: boolean
  foldedResults: number
  tokensFreed: number
}

function timestampMs(value: ToolResultFoldingOptions['cacheLastActivityAt']): number | null {
  if (value === undefined || value === null) return null
  try {
    const ms = value instanceof Date ? value.getTime() : new Date(value).getTime()
    return Number.isFinite(ms) ? ms : null
  } catch {
    return null
  }
}

function estimateContentTokens(content: unknown): { tokens: number; valid: boolean } {
  if (typeof content === 'string') {
    return { tokens: Math.ceil(content.length / CHARS_PER_TOKEN), valid: true }
  }
  if (!Array.isArray(content)) return { tokens: 0, valid: false }
  let tokens = 0
  for (const part of content) {
    if (part === null || typeof part !== 'object') return { tokens, valid: false }
    try {
      const runtimePart = part as Record<string, unknown>
      if (runtimePart.type === 'text') {
        if (typeof runtimePart.text !== 'string') return { tokens, valid: false }
        tokens += Math.ceil(runtimePart.text.length / CHARS_PER_TOKEN)
      } else if (runtimePart.type === 'image') {
        tokens += IMAGE_TOKEN_BUDGET
      } else {
        return { tokens, valid: false }
      }
    } catch {
      return { tokens, valid: false }
    }
  }
  return { tokens, valid: true }
}

function collectToolUses(
  messages: ConversationMessage[],
  diagnose: (diagnostic: ToolResultFoldingDiagnostic) => void,
): Map<string, ToolUseInfo> {
  const result = new Map<string, ToolUseInfo>()
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex] as ConversationMessage | null | undefined
    let content: unknown
    try {
      content = message?.content
    } catch {
      content = undefined
    }
    if (!Array.isArray(content)) {
      diagnose({ code: 'message_content_not_array', message_index: messageIndex })
      continue
    }
    for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
      const block = content[blockIndex]
      if (block === null || typeof block !== 'object') {
        diagnose({ code: 'content_block_invalid', message_index: messageIndex, block_index: blockIndex })
        continue
      }
      try {
        const runtimeBlock = block as Record<string, unknown>
        if (runtimeBlock.type !== 'tool_use') continue
        if (typeof runtimeBlock.id !== 'string' || typeof runtimeBlock.name !== 'string') {
          diagnose({ code: 'tool_use_invalid', message_index: messageIndex, block_index: blockIndex })
          continue
        }
        result.set(runtimeBlock.id, {
          name: runtimeBlock.name,
          input: runtimeBlock.input,
        })
      } catch {
        diagnose({ code: 'tool_use_invalid', message_index: messageIndex, block_index: blockIndex })
      }
    }
  }
  return result
}

function valueArg(input: unknown, key: string): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined
  try {
    return (input as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

function stringArg(input: unknown, key: string): string | undefined {
  const value = valueArg(input, key)
  return typeof value === 'string' && value.trim() ? value : undefined
}

function durableReferences(tool: ToolUseInfo): string[] {
  const input = tool.input
  switch (tool.name) {
    case 'Write':
    case 'Edit':
      return [stringArg(input, 'file_path')].filter((v): v is string => !!v)
    case 'ArxivFetchPaper': {
      const arxivId = stringArg(input, 'arxiv_id')
      return arxivId ? [`references/papers (arxiv:${arxivId})`] : []
    }
    case 'SciverseFetchPaper': {
      const documentId = stringArg(input, 'doc_id')
      return documentId ? [`references/papers (sciverse:${documentId})`] : []
    }
    default:
      return []
  }
}

function recoveryReference(tool: ToolUseInfo): string {
  const input = tool.input
  const refs = durableReferences(tool)
  if (refs.length > 0) return `workspace: ${refs.join(', ')}`

  switch (tool.name) {
    case 'Read': {
      const path = stringArg(input, 'file_path') ?? '(unknown)'
      const offsetValue = valueArg(input, 'offset')
      const limitValue = valueArg(input, 'limit')
      const offset = typeof offsetValue === 'number' ? `, offset=${offsetValue}` : ''
      const limit = typeof limitValue === 'number' ? `, limit=${limitValue}` : ''
      return `重新调用 Read(file_path=${path}${offset}${limit})`
    }
    case 'Glob':
      return `重新调用 Glob(pattern=${stringArg(input, 'pattern') ?? '(unknown)'})`
    case 'Grep':
      return `重新调用 Grep(pattern=${stringArg(input, 'pattern') ?? '(unknown)'})`
    case 'WebSearch':
      return `重新调用 WebSearch(query=${stringArg(input, 'query') ?? '(unknown)'})`
    case 'ArxivSearchPapers':
      return `重新调用 ArxivSearchPapers(query=${stringArg(input, 'query') ?? '(unknown)'})`
    case 'SciverseSearchPapers':
      return `重新调用 SciverseSearchPapers(query=${stringArg(input, 'query') ?? '结构化条件'})`
    case 'SciverseSearchEvidence':
      return `重新调用 SciverseSearchEvidence(query=${stringArg(input, 'query') ?? '(unknown)'})`
    case 'SciverseListRelations':
      return `重新调用 SciverseListRelations(unique_id=${stringArg(input, 'unique_id') ?? '(unknown)'}, relation=${stringArg(input, 'relation') ?? '(unknown)'})`
    case 'SearchDocument':
      return `重新调用 SearchDocument(query=${stringArg(input, 'query') ?? '(unknown)'})`
    default:
      return '原始结果仍保存在完整会话审计记录中'
  }
}

function previewText(text: string, keepPreview: boolean): string {
  if (!keepPreview || text.length <= 1_200) return ''
  const head = text.slice(0, 800).trim()
  const tail = text.slice(-400).trim()
  return `\npreview_head:\n${head}\n\npreview_tail:\n${tail}`
}

function receipt(
  tool: ToolUseInfo,
  originalTokens: number,
  isError: boolean,
  preview = '',
): string {
  return [
    '[Prompt Cache 过期后已折叠大型工具载荷]',
    `tool: ${tool.name}`,
    `status: ${isError ? 'error' : 'success'}`,
    `original_payload: ~${originalTokens.toLocaleString()} tokens`,
    `recovery: ${recoveryReference(tool)}`,
    preview,
  ].filter(Boolean).join('\n')
}

function flattenText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is TextBlock => (
      part !== null
      && typeof part === 'object'
      && (part as Record<string, unknown>).type === 'text'
      && typeof (part as Record<string, unknown>).text === 'string'
    ))
    .map(part => part.text)
    .join('\n')
}

function foldBlock(
  block: ToolResultBlock,
  tool: ToolUseInfo | undefined,
  thresholdTokens: number,
): { block: ToolResultBlock; tokensFreed: number; folded: boolean } {
  if (!tool || NEVER_FOLD.has(tool.name)) return { block, tokensFreed: 0, folded: false }

  const originalEstimate = estimateContentTokens(block.content)
  if (!originalEstimate.valid) return { block, tokensFreed: 0, folded: false }
  const originalTokens = originalEstimate.tokens
  const isLarge = originalTokens >= thresholdTokens

  let nextContent: ToolResultContent | null = null

  if (REFETCHABLE.has(tool.name) && isLarge) {
    const text = flattenText(block.content)
    // Search results are time-sensitive; retain a small local preview. File reads
    // are deterministic and cheaper to recover directly from the workspace.
    const keepPreview = tool.name !== 'Read'
    nextContent = receipt(tool, originalTokens, !!block.is_error, previewText(text, keepPreview))
  } else if (DURABLE_MUTATIONS.has(tool.name) && isLarge && durableReferences(tool).length > 0) {
    nextContent = receipt(
      tool,
      originalTokens,
      !!block.is_error,
      block.is_error ? previewText(flattenText(block.content), true) : '',
    )
  }

  if (nextContent === null) return { block, tokensFreed: 0, folded: false }
  const nextEstimate = estimateContentTokens(nextContent)
  const tokensFreed = Math.max(0, originalTokens - nextEstimate.tokens)
  if (tokensFreed === 0) return { block, tokensFreed: 0, folded: false }

  return {
    block: { ...block, content: nextContent },
    tokensFreed,
    folded: true,
  }
}

/**
 * Fold only reconstructible large payloads, and only after the configured
 * prompt-cache TTL is known to have elapsed. Tool call/result structure is
 * preserved byte-for-byte apart from the result payload itself.
 */
export function foldExpiredToolResults(
  messages: ConversationMessage[],
  options: ToolResultFoldingOptions,
): ToolResultFoldingResult {
  const diagnose = (diagnostic: ToolResultFoldingDiagnostic): void => {
    try {
      options.onDiagnostic?.(diagnostic)
    } catch {
      // Diagnostics must never become a new failure mode for prompt admission.
    }
  }
  const nowMs = options.nowMs ?? Date.now()
  const lastActivityMs = timestampMs(options.cacheLastActivityAt)
  const cacheExpired = lastActivityMs !== null && nowMs - lastActivityMs >= options.cacheTtlMs

  if (!cacheExpired || messages.length === 0) {
    return { messages, cacheExpired, foldedResults: 0, tokensFreed: 0 }
  }

  const toolUses = collectToolUses(messages, diagnose)
  const thresholdTokens = Math.max(
    DEFAULT_MIN_FOLD_TOKENS,
    Math.ceil(options.contextWindow * 0.01),
  )
  let foldedResults = 0
  let tokensFreed = 0

  const nextMessages = messages.map((message, messageIndex) => {
    let runtimeContent: unknown
    try {
      runtimeContent = message?.content
    } catch {
      runtimeContent = undefined
    }
    if (!Array.isArray(runtimeContent)) {
      diagnose({ code: 'message_content_not_array', message_index: messageIndex })
      return message
    }
    let changed = false
    const content = runtimeContent.map((block, blockIndex): ContentBlock => {
      if (block === null || typeof block !== 'object') {
        diagnose({ code: 'content_block_invalid', message_index: messageIndex, block_index: blockIndex })
        return block as ContentBlock
      }
      try {
        const runtimeBlock = block as Record<string, unknown>
        if (runtimeBlock.type !== 'tool_result') return block as ContentBlock
        if (typeof runtimeBlock.tool_use_id !== 'string') {
          diagnose({ code: 'tool_result_content_invalid', message_index: messageIndex, block_index: blockIndex })
          return block as ContentBlock
        }
        const resultBlock = block as ToolResultBlock
        const originalEstimate = estimateContentTokens(runtimeBlock.content)
        if (!originalEstimate.valid) {
          diagnose({ code: 'tool_result_content_invalid', message_index: messageIndex, block_index: blockIndex })
          return block as ContentBlock
        }
        const folded = foldBlock(
          resultBlock,
          toolUses.get(runtimeBlock.tool_use_id),
          thresholdTokens,
        )
        if (!folded.folded) return block as ContentBlock
        changed = true
        foldedResults += 1
        tokensFreed += folded.tokensFreed
        return folded.block
      } catch {
        diagnose({ code: 'tool_result_content_invalid', message_index: messageIndex, block_index: blockIndex })
        return block as ContentBlock
      }
    })
    return changed ? { ...message, content } : message
  })

  return {
    messages: foldedResults > 0 ? nextMessages : messages,
    cacheExpired,
    foldedResults,
    tokensFreed,
  }
}
