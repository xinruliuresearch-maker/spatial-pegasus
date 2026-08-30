import type { ToolResult } from '../types'
import { safeError } from '../literature/http'
import { LiteratureService } from '../literature/service'
import { boundedToolJson } from '../literature/tool-output'
import type {
  LiteratureToolRuntime,
  SciverseEvidenceFilters,
  SciverseSearchMode,
} from '../literature/types'

export interface SciverseSearchEvidenceInput {
  query: string
  top_k?: number
  mode?: SciverseSearchMode
  source_types?: Array<'web' | 'pdf'>
  filters?: SciverseEvidenceFilters
}

export async function executeSciverseSearchEvidence(
  input: SciverseSearchEvidenceInput,
  runtime: LiteratureToolRuntime,
): Promise<ToolResult> {
  try {
    const service = new LiteratureService(runtime.workspace, runtime.providers, {
      signal: runtime.signal,
      now: runtime.now,
      randomId: runtime.randomId,
    })
    const receipt = await service.searchEvidence({
      source: 'sciverse',
      query: input.query,
      topK: input.top_k ?? 10,
      mode: input.mode ?? 'balanced',
      sourceTypes: input.source_types,
      filters: input.filters,
    })
    return {
      content: boundedToolJson({
        search_id: receipt.searchId,
        record_path: receipt.recordPath,
        source: 'sciverse',
        returned: receipt.result.hits.length,
        hits: receipt.result.hits,
      }, 'hits'),
    }
  } catch (error) {
    const detail = safeError(error)
    return { content: `${detail.name}: ${detail.message}`, is_error: true }
  }
}
