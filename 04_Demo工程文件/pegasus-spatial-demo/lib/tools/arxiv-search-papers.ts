import type { ToolResult } from '../types'
import { safeError } from '../literature/http'
import { LiteratureService } from '../literature/service'
import { boundedToolJson } from '../literature/tool-output'
import type {
  ArxivPaperSearchRequest,
  LiteratureSearchFilters,
  LiteratureSort,
  LiteratureToolRuntime,
} from '../literature/types'

/** Agent-facing arXiv paper-discovery input. The provider is fixed by the tool. */
export interface ArxivSearchPapersInput {
  query: string
  limit?: number
  cursor?: string
  sort?: LiteratureSort
  filters?: {
    authors?: string[]
    categories?: string[]
    published_from?: string
    published_to?: string
  }
}

export async function executeArxivSearchPapers(
  input: ArxivSearchPapersInput,
  runtime: LiteratureToolRuntime,
): Promise<ToolResult> {
  try {
    const request = normalizeArxivSearchPapersInput(input)
    const service = new LiteratureService(runtime.workspace, runtime.providers, {
      signal: runtime.signal,
      now: runtime.now,
      randomId: runtime.randomId,
    })
    const receipt = await service.searchPapers(request)
    return {
      content: boundedToolJson({
        search_id: receipt.searchId,
        record_path: receipt.recordPath,
        source: receipt.page.source,
        returned: receipt.page.papers.length,
        total: receipt.page.total,
        next_cursor: receipt.page.nextCursor,
        papers: receipt.page.papers,
      }, 'papers'),
    }
  } catch (error) {
    const detail = safeError(error)
    return { content: `${detail.name}: ${detail.message}`, is_error: true }
  }
}

export function normalizeArxivSearchPapersInput(
  input: ArxivSearchPapersInput,
): ArxivPaperSearchRequest {
  const filters: LiteratureSearchFilters | undefined = input.filters
    ? {
        authors: input.filters.authors,
        categories: input.filters.categories,
        publishedFrom: input.filters.published_from,
        publishedTo: input.filters.published_to,
      }
    : undefined
  return {
    source: 'arxiv',
    query: input.query,
    limit: input.limit ?? 10,
    cursor: input.cursor,
    sort: input.sort ?? 'relevance',
    filters,
  }
}
