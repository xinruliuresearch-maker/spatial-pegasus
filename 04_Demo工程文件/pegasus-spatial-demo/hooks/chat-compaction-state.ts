import type { DisplayPart } from '@/lib/types'

export const COMPACTION_ACTIVE_STATUSES = [
  'queued',
  'summarizing',
  'summary_ready',
  'merge_prepared',
  'retryable',
] as const

export const COMPACTION_TERMINAL_STATUSES = [
  'merged',
  'failed',
  'cancelled',
  'superseded',
] as const

export type PublicCompactionStatus =
  | typeof COMPACTION_ACTIVE_STATUSES[number]
  | typeof COMPACTION_TERMINAL_STATUSES[number]

const ACTIVE_STATUS_SET = new Set<string>(COMPACTION_ACTIVE_STATUSES)
const TERMINAL_STATUS_SET = new Set<string>(COMPACTION_TERMINAL_STATUSES)

export interface ContextUsageState {
  compressible: number
  threshold: number
}

export interface CompactionPresentation {
  action: string
  pending: boolean
  isError?: boolean
}

export function isPublicCompactionStatus(value: unknown): value is PublicCompactionStatus {
  return typeof value === 'string'
    && (ACTIVE_STATUS_SET.has(value) || TERMINAL_STATUS_SET.has(value))
}

export function isActiveCompactionStatus(status: PublicCompactionStatus): boolean {
  return ACTIVE_STATUS_SET.has(status)
}

export function isTerminalCompactionStatus(status: PublicCompactionStatus): boolean {
  return TERMINAL_STATUS_SET.has(status)
}

/** Only the persisted merged state is allowed to claim completion. */
export function compactionPresentation(status: PublicCompactionStatus): CompactionPresentation {
  switch (status) {
    case 'queued':
      return { action: '上下文压缩已进入后台队列', pending: true }
    case 'summarizing':
      return { action: '正在生成上下文摘要…', pending: true }
    case 'summary_ready':
      return { action: '摘要已生成，等待安全合并…', pending: true }
    case 'merge_prepared':
      return { action: '正在安全替换上下文…', pending: true }
    case 'retryable':
      return { action: '上下文压缩暂时中断，后台将重试', pending: true, isError: true }
    case 'merged':
      return { action: '上下文压缩完成', pending: false }
    case 'failed':
      return { action: '后台上下文压缩失败；下一轮将重新检查', pending: false, isError: true }
    case 'cancelled':
      return { action: '后台上下文压缩已取消', pending: false, isError: true }
    case 'superseded':
      return { action: '后台压缩已由本地安全结果接管', pending: false }
  }
}

/**
 * The client must never invent a context window. Older token events without a
 * server-provided window/input limit intentionally hide the gauge.
 */
export function contextUsageFromTokenEvent(
  data: Record<string, unknown>,
): ContextUsageState | null {
  const total = Number(data.total_input_tokens)
  const overhead = Number(data.overhead_tokens)
  const serverInputLimit = Number(data.input_limit_tokens)
  const contextWindow = Number(data.context_window)
  const maxOutputTokens = Number(data.max_output_tokens)
  const threshold = Number.isFinite(serverInputLimit) && serverInputLimit > 0
    ? serverInputLimit
    : Number.isFinite(contextWindow) && contextWindow > 0
      ? contextWindow - (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
          ? maxOutputTokens
          : overhead)
      : Number.NaN
  if (
    !Number.isFinite(total)
    || !Number.isFinite(overhead)
    || !Number.isFinite(threshold)
    || threshold <= 0
  ) return null
  return {
    compressible: Math.max(0, total - overhead),
    threshold,
  }
}

/** Update one existing Compaction row instead of appending duplicate states. */
export function applyCompactionPresentationToParts(
  parts: DisplayPart[],
  status: PublicCompactionStatus,
): DisplayPart[] {
  const presentation = compactionPresentation(status)
  const next = [...parts]
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const part = next[index]
    if (part.type !== 'tool_call' || part.tool !== 'Compaction') continue
    next[index] = {
      ...part,
      action: presentation.action,
      pending: presentation.pending,
      is_error: presentation.isError,
    }
    return next
  }
  next.push({
    type: 'tool_call',
    tool: 'Compaction',
    action: presentation.action,
    pending: presentation.pending,
    is_error: presentation.isError,
  })
  return next
}
