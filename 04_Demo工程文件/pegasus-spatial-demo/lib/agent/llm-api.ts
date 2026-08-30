// Messages API streaming via NewAPI gateway (Anthropic-compatible request shape).

import type { ContentBlock, TokenUsage } from '../types'
import { LLM_BASE_URL, LLM_API_KEY_ORCHESTRATOR } from '../llm-config'

interface AnthropicRequest {
  model: string
  max_tokens: number
  temperature?: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  system: any[]
  tools: { name: string; description: string; input_schema: Record<string, unknown> }[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any[]
  thinking?: { type: 'enabled'; budget_tokens: number }
}

export interface StreamResult {
  content: ContentBlock[]
  stop_reason: string
  usage: TokenUsage
}

/** Structured transport error. Callers must inspect `status`, never search an
 * opaque provider message or request id for status-code digits. */
export class LLMAPIError extends Error {
  constructor(
    readonly status: number,
    readonly responseBody: string,
    readonly model: string,
  ) {
    super(`LLM API error ${status} (model=${model}): ${responseBody}`)
    this.name = 'LLMAPIError'
  }
}

export function isPromptTooLongLLMError(error: unknown): boolean {
  if (error instanceof LLMAPIError) {
    if (error.status === 413) return true
    if (![400, 422].includes(error.status)) return false
    return /(?:prompt|context|input|request)[^\n]{0,120}(?:too long|too large|exceeds?|maximum|max(?:imum)? tokens?|context length)/i
      .test(error.responseBody)
  }

  // Compatibility for custom providers and tests that do not construct the
  // transport error. Word boundaries prevent a request id containing "413"
  // (the incident that motivated this guard) from becoming a false positive.
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /(?:^|\b(?:http|status|error)\s*)413\b/i.test(message)
    || /(?:prompt|context|input|request)[^\n]{0,120}(?:too long|too large|exceeds?|maximum|max(?:imum)? tokens?|context length)/i.test(message)
}

export function isRetryableLLMTransportFailure(status: number, responseBody: string): boolean {
  if (status >= 500 && status < 600) return true
  // NewAPI uses 422 for a channel/upstream availability failure after its own
  // internal attempts. HTTP 400 is deliberately excluded: the same opaque
  // "Provider returned error" envelope is also used for deterministic payload
  // incompatibilities, so replaying it only burns latency and obscures the
  // request regression.
  return status === 422 && /Upstream request error|Provider returned error/i.test(responseBody)
}

export async function callAnthropicAPIStream(
  request: AnthropicRequest,
  baseUrl?: string,
  apiKey?: string,
  onTextDelta?: (text: string) => void,
  onToolUseStart?: (toolName: string) => void,
  onThinkingDelta?: (text: string) => void,
  onRedactedThinking?: () => void,
  abortSignal?: AbortSignal,
): Promise<StreamResult> {
  const endpoint = (baseUrl || LLM_BASE_URL).trim().replace(/\/+$/, '')
  const key = apiKey || LLM_API_KEY_ORCHESTRATOR
  if (!endpoint) throw new Error('LLM_BASE_URL is not configured')
  if (!key) throw new Error('LLM API key is not configured')
  const url = `${endpoint}/messages`
  const streamRequest = { ...request, stream: true }

  const bodyJson = JSON.stringify(streamRequest)
  console.log(`[llm-api] Sending request: model=${request.model}, messages=${request.messages.length}, bodySize=${(bodyJson.length / 1024).toFixed(0)}KB`)

  // Retry only status codes that unambiguously represent transport/upstream
  // availability. NewAPI's opaque HTTP 400 "Provider returned error" can also
  // mean an invalid or unsupported request shape and must not be replayed.
  const MAX_ATTEMPTS = 3
  const BACKOFF_MS = [2000, 5000]
  let res: Response | null = null
  let lastErrText = ''

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`,
          'HTTP-Referer': process.env.APP_PUBLIC_URL || 'http://localhost:3200',
          'X-Title': 'Pegasus Spatial',
        },
        body: bodyJson,
        signal: abortSignal,
      })
    } catch (fetchErr) {
      // AbortError: return empty result instead of throwing (caller handles gracefully)
      if ((fetchErr as Error).name === 'AbortError') {
        console.log('[llm-api] Request aborted')
        return { content: [], stop_reason: 'aborted', usage: { input_tokens: 0, output_tokens: 0 } }
      }
      const cause = (fetchErr as Error).cause
      console.error(`[llm-api] fetch failed (attempt ${attempt}/${MAX_ATTEMPTS}). Cause:`, cause ?? (fetchErr as Error).message)
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, BACKOFF_MS[attempt - 1]))
        continue
      }
      throw fetchErr
    }

    if (res.ok) break

    lastErrText = await res.text().catch(() => '')
    const isUpstreamTransient = isRetryableLLMTransportFailure(res.status, lastErrText)

    if (isUpstreamTransient && attempt < MAX_ATTEMPTS) {
      console.warn(`[llm-api] Upstream transient ${res.status} on attempt ${attempt}/${MAX_ATTEMPTS}, retrying in ${BACKOFF_MS[attempt - 1]}ms...`)
      await new Promise(r => setTimeout(r, BACKOFF_MS[attempt - 1]))
      continue
    }
    // Non-retryable or out of attempts
    break
  }

  if (!res || !res.ok) {
    const status = res?.status ?? 0
    throw new LLMAPIError(status, lastErrText, request.model)
  }

  // Parse SSE stream
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  // Accumulate state — index-based Map for interleaved blocks
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks = new Map<number, any>()
  const toolInputs = new Map<number, string>()
  let stopReason = 'end_turn'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let usage: any = {}

  while (true) {
    // Check abort before each read — return partial results instead of throwing
    if (abortSignal?.aborted) {
      console.log('[llm-api] Aborted during streaming, returning partial results')
      try { reader.cancel() } catch { /* ignore */ }
      break
    }

    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') continue

      let event
      try {
        event = JSON.parse(data)
      } catch {
        continue
      }

      const idx: number = event.index ?? -1

      switch (event.type) {
        case 'message_start':
          if (event.message?.usage) {
            usage = { ...usage, ...event.message.usage }
            console.log(`[llm-api] usage@message_start: input=${usage.input_tokens} cache_read=${usage.cache_read_input_tokens} cache_create=${usage.cache_creation_input_tokens}`)
          }
          break

        case 'content_block_start':
          if (event.content_block?.type === 'text') {
            blocks.set(idx, { type: 'text', text: '' })
          } else if (event.content_block?.type === 'tool_use') {
            blocks.set(idx, {
              type: 'tool_use',
              id: event.content_block.id,
              name: event.content_block.name,
              input: {},
            })
            toolInputs.set(idx, '')
            onToolUseStart?.(event.content_block.name)
          } else if (event.content_block?.type === 'thinking') {
            blocks.set(idx, { type: 'thinking', thinking: '', signature: '' })
          } else if (event.content_block?.type === 'redacted_thinking') {
            const blockData = event.content_block.data || ''
            // Skip OpenRouter-injected redacted_thinking (non-Anthropic native)
            if (typeof blockData === 'string' && blockData.startsWith('openrouter.reasoning:')) {
              blocks.set(idx, { type: 'redacted_thinking', data: blockData, _skip: true })
            } else {
              blocks.set(idx, { type: 'redacted_thinking', data: blockData })
              onRedactedThinking?.()
            }
          }
          break

        case 'content_block_delta': {
          const block = blocks.get(idx)
          if (!block) break

          if (event.delta?.type === 'text_delta' && block.type === 'text') {
            block.text += event.delta.text
            onTextDelta?.(event.delta.text)
          } else if (event.delta?.type === 'input_json_delta' && block.type === 'tool_use') {
            toolInputs.set(idx, (toolInputs.get(idx) || '') + event.delta.partial_json)
          } else if (event.delta?.type === 'thinking_delta' && block.type === 'thinking') {
            block.thinking += event.delta.thinking
            onThinkingDelta?.(event.delta.thinking)
          } else if (event.delta?.type === 'signature_delta') {
            if (block.type === 'thinking') {
              block.signature = (block.signature || '') + event.delta.signature
            } else if (block.type === 'redacted_thinking') {
              block.data = (block.data || '') + event.delta.signature
            }
          }
          break
        }

        case 'content_block_stop': {
          const block = blocks.get(idx)
          if (block?.type === 'tool_use') {
            const jsonStr = toolInputs.get(idx) || ''
            if (jsonStr) {
              try {
                block.input = JSON.parse(jsonStr)
              } catch {
                // Preserve parse failure as a runtime-invalid value. The Agent
                // Loop's tool-input boundary will replace it with a durable,
                // JSON-safe rejection block and emit an error tool_result.
                // Converting malformed JSON to {} here would silently execute
                // a different call than the model produced.
                block.input = undefined
              }
            }
          }
          break
        }

        case 'message_delta':
          if (event.delta?.stop_reason) {
            stopReason = event.delta.stop_reason
          }
          if (event.usage) {
            // Per Anthropic Messages API spec, `message_delta.usage` should only
            // update output/cache counters — `input_tokens` is finalized in
            // `message_start.usage` and must NOT be overwritten here. Some upstream
            // gateways (observed: NewAPI) incorrectly send an inflated / doubled
            // value in message_delta's input_tokens, which would mislead our
            // auto-compact trigger. We preserve message_start's input_tokens.
            const preservedInput = usage.input_tokens
            usage = { ...usage, ...event.usage, input_tokens: preservedInput }
          }
          break
      }
    }
  }

  // Assemble final content blocks sorted by index, filter OpenRouter-injected redacted_thinking
  const contentBlocks: ContentBlock[] = [...blocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, block]) => block)
    .filter((block: { _skip?: boolean }) => !block._skip)

  return {
    content: contentBlocks,
    stop_reason: stopReason,
    usage: {
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      cache_read_input_tokens: usage.cache_read_input_tokens || 0,
    },
  }
}
