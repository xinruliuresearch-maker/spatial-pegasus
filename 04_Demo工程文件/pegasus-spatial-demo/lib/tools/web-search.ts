import { ToolResult } from '../types'
import { tokenTracker } from '../agent/token-tracker'
import { logAPICall } from '../db/api-log-repository'
import { LLM_BASE_URL } from '../llm-config'
import { resolveAlias } from '../llm-registry'

interface WebSearchInput {
  query: string
}

/**
 * Search the web through the configured grounded-search gateway alias.
 */
export async function executeWebSearch(
  input: WebSearchInput
): Promise<ToolResult> {
  if (typeof input.query !== 'string' || !input.query.trim()) {
    return { content: 'Search query cannot be empty', is_error: true }
  }
  const query = input.query.trim()
  // Web search uses a fixed tool alias (no plan-based variation for search).
  let resolved: { model: string; apiKey: string }
  try {
    resolved = resolveAlias('tool_websearch')
  } catch (err) {
    return { content: `Web search model unavailable: ${(err as Error).message}`, is_error: true }
  }
  const SEARCH_MODEL = resolved.model
  const apiKey = resolved.apiKey
  if (!LLM_BASE_URL) {
    return { content: 'Web search unavailable: LLM_BASE_URL is not configured', is_error: true }
  }

  console.log(`[web-search] Query: "${query.slice(0, 80)}"`)

  try {
    const startTime = Date.now()
    // Provider-agnostic request — whatever mechanism enables web grounding
    // (OpenRouter `plugins`, Google native `tools: [{google_search:{}}]`, Perplexity
    // built-in, etc.) must be configured on the NewAPI channel via "parameter override".
    // Pegasus Spatial sends a vanilla chat/completions payload; the gateway injects the right
    // provider-specific fields before calling upstream. This keeps our code decoupled
    // from upstream-specific syntax.
    const requestBody = {
      model: SEARCH_MODEL,
      messages: [{ role: 'user', content: query }],
      temperature: 0.5,
      max_tokens: 4096,
    }
    const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': process.env.APP_PUBLIC_URL || 'http://localhost:3200',
        'X-Title': 'Pegasus Spatial',
      },
      body: JSON.stringify(requestBody),
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`NewAPI error ${res.status} (model=${SEARCH_MODEL}): ${errText}`)
    }

    const data = await res.json()
    const body = data.choices?.[0]?.message?.content

    // Extract citations from `annotations` (Gemini grounding / OpenRouter web plugin)
    // and append to the text the AI sees so it can quote sources back to the user.
    interface UrlCitation { type?: string; url_citation?: { url?: string; title?: string } }
    const annotations: UrlCitation[] = data.choices?.[0]?.message?.annotations ?? []
    const citations = annotations
      .filter(a => a.type === 'url_citation' && a.url_citation?.url)
      .map((a, i) => `[${i + 1}] ${a.url_citation?.title ?? '(no title)'} — ${a.url_citation?.url}`)
    const text = citations.length > 0 && body
      ? `${body}\n\n来源：\n${citations.join('\n')}`
      : body

    const duration = Date.now() - startTime

    // Record token usage
    if (data.usage) {
      tokenTracker.record({
        source: 'web-search',
        model: SEARCH_MODEL,
        input_tokens: data.usage.prompt_tokens || 0,
        output_tokens: data.usage.completion_tokens || 0,
      })
    }

    // Persist to database (fire-and-forget)
    if (tokenTracker.userId) {
      const usage = {
        input_tokens: data.usage?.prompt_tokens || 0,
        output_tokens: data.usage?.completion_tokens || 0,
      }
      logAPICall({
        user_id: tokenTracker.userId,
        conversation_id: tokenTracker.conversationId,
        source: 'web-search',
        model: SEARCH_MODEL,
        usage,
        duration_ms: duration,
        status: 'success',
        turn_number: 0,
        request_body: requestBody,
        response: { content: [{ type: 'text', text: data.choices?.[0]?.message?.content || '' }], stop_reason: 'end_turn', usage },
      }).catch(err => console.error('[api-log] web-search log failed:', (err as Error).message))
    }

    if (!text) {
      return { content: 'No search results returned', is_error: true }
    }

    console.log(`[web-search] Result: ${text.length} chars`)
    return { content: text }
  } catch (err) {
    const errMsg = (err as Error).message
    console.error('[web-search] Error:', errMsg)
    return {
      content: `Web search error: ${errMsg}`,
      is_error: true,
    }
  }
}
