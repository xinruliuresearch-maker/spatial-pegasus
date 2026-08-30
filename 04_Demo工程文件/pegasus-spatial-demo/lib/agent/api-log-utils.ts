// ============================================================
// API Log Utilities — helpers for request/response sanitization
// ============================================================

import type { LLMResponse } from '../types'

/**
 * Deep-clone a request body and replace all base64 image data with
 * size placeholders to save storage space in api_call_logs.
 *
 * Targets: `{ source: { type: 'base64', data: '<base64>' } }` blocks
 * in messages content arrays.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function stripBase64Images(requestBody: any): any {
  if (!requestBody) return requestBody

  const clone = JSON.parse(JSON.stringify(requestBody))

  if (Array.isArray(clone.messages)) {
    for (const msg of clone.messages) {
      if (!Array.isArray(msg.content)) continue
      for (const block of msg.content) {
        if (block.type === 'image' && block.source?.type === 'base64' && block.source.data) {
          const byteSize = Math.round(block.source.data.length * 0.75)
          block.source.data = `[BASE64_IMAGE:${byteSize}bytes]`
        }
        // tool_result with array content (may contain images)
        if (block.type === 'tool_result' && Array.isArray(block.content)) {
          for (const sub of block.content) {
            if (sub.type === 'image' && sub.source?.type === 'base64' && sub.source.data) {
              const byteSize = Math.round(sub.source.data.length * 0.75)
              sub.source.data = `[BASE64_IMAGE:${byteSize}bytes]`
            }
          }
        }
      }
    }
  }

  return clone
}

/**
 * Extract tool names from an LLM response's content blocks.
 */
export function extractToolNames(response: LLMResponse): string[] {
  return response.content
    .filter(b => b.type === 'tool_use')
    .map(b => (b as { name: string }).name)
}
