import type { HistoryEventInput } from './types'

export const DEFAULT_MEMORY_TOKEN_LIMIT = 20_000

export interface MemoryCapacity {
  used_tokens: number
  limit_tokens: number
  remaining_tokens: number
  usage_ratio: number
  profile_tokens: number
  history_tokens: number
  history_events: number
  is_full: boolean
}

/**
 * Storage quota estimation is deliberately model-independent. API usage cannot
 * report tokens for Mongo records that are never sent in one request, so V2
 * uses a stable conservative estimator: one token per CJK character and one
 * token per four remaining non-whitespace characters.
 */
export function estimateMemoryTokens(value: string): number {
  const text = value.trim()
  if (!text) return 0
  const cjk = text.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g)?.length ?? 0
  const remainder = text.replace(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\s]/g, '').length
  return Math.max(1, cjk + Math.ceil(remainder / 4))
}

export function estimateHistoryEventTokens(input: HistoryEventInput): number {
  const artifactText = (input.artifacts ?? [])
    .map(item => [item.label, item.path, item.mime_type].filter(Boolean).join(' '))
    .join('\n')
  return estimateMemoryTokens([
    input.title,
    input.summary,
    input.detail,
    input.project,
    ...(input.decisions ?? []),
    ...(input.tags ?? []),
    ...(input.search_terms ?? []),
    artifactText,
  ].filter(Boolean).join('\n'))
}
