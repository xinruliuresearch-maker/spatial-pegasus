import type { ToolResult } from '../types'
import { safeError } from '../literature/http'
import { LiteratureService } from '../literature/service'
import { boundedToolJson } from '../literature/tool-output'
import type {
  LiteratureToolRuntime,
  SciverseAdvancedFilter,
  SciverseAdvancedSort,
  SciverseRankingBoost,
} from '../literature/types'

export interface SciverseSearchPapersInput {
  query?: string
  title_contains?: string
  abstract_contains?: string
  authors?: string[]
  year_from?: number
  year_to?: number
  journals?: string[]
  subjects?: string[]
  filters_advanced?: SciverseAdvancedFilter[]
  sort_advanced?: SciverseAdvancedSort[]
  sort_by_year?: 'desc' | 'asc' | 'none'
  freshness_boost?: SciverseRankingBoost
  impact_boost?: SciverseRankingBoost
  language_affinity?: SciverseRankingBoost
  page?: number
  page_size?: number
  cursor?: string
}

export async function executeSciverseSearchPapers(
  input: SciverseSearchPapersInput,
  runtime: LiteratureToolRuntime,
): Promise<ToolResult> {
  try {
    const service = new LiteratureService(runtime.workspace, runtime.providers, {
      signal: runtime.signal,
      now: runtime.now,
      randomId: runtime.randomId,
    })
    const receipt = await service.searchPapers({
      source: 'sciverse',
      query: input.query,
      titleContains: input.title_contains,
      abstractContains: input.abstract_contains,
      authors: input.authors,
      yearFrom: input.year_from,
      yearTo: input.year_to,
      journals: input.journals,
      subjects: input.subjects,
      filtersAdvanced: input.filters_advanced,
      sortAdvanced: input.sort_advanced,
      sortByYear: input.sort_by_year ?? 'desc',
      freshnessBoost: input.freshness_boost ?? 'NONE',
      impactBoost: input.impact_boost ?? 'NONE',
      languageAffinity: input.language_affinity ?? 'NONE',
      page: input.page ?? 1,
      pageSize: input.page_size ?? 10,
      cursor: input.cursor,
    })
    return {
      content: boundedToolJson({
        search_id: receipt.searchId,
        record_path: receipt.recordPath,
        source: 'sciverse',
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
