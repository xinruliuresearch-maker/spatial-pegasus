import type { ToolResult } from '../types'
import { safeError } from '../literature/http'
import { LiteratureService } from '../literature/service'
import { boundedToolJson } from '../literature/tool-output'
import type { LiteratureToolRuntime } from '../literature/types'

export interface SearchDocumentInput {
  query: string
  document_paths?: string[]
  case_sensitive?: boolean
  max_results?: number
  context_chars?: number
}

export async function executeSearchDocument(
  input: SearchDocumentInput,
  runtime: LiteratureToolRuntime,
): Promise<ToolResult> {
  try {
    const service = new LiteratureService(runtime.workspace, runtime.providers, {
      signal: runtime.signal,
      now: runtime.now,
      randomId: runtime.randomId,
    })
    const result = await service.searchDocument({
      query: input.query,
      documentPaths: input.document_paths,
      caseSensitive: input.case_sensitive,
      maxResults: input.max_results,
      contextChars: input.context_chars,
    })
    return {
      content: boundedToolJson({
        query: result.query,
        searched_paths: result.searchedPaths,
        hits: result.hits,
        truncated: result.truncated,
      }, 'hits'),
    }
  } catch (error) {
    const detail = safeError(error)
    return { content: `${detail.name}: ${detail.message}`, is_error: true }
  }
}
