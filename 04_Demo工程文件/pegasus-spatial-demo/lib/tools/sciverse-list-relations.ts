import type { ToolResult } from '../types'
import { safeError } from '../literature/http'
import { LiteratureService } from '../literature/service'
import { boundedToolJson } from '../literature/tool-output'
import type {
  LiteratureToolRuntime,
  SciversePaperRelationKind,
} from '../literature/types'

export interface SciverseListRelationsInput {
  unique_id: string
  relation: SciversePaperRelationKind
  page?: number
  page_size?: number
}

export async function executeSciverseListRelations(
  input: SciverseListRelationsInput,
  runtime: LiteratureToolRuntime,
): Promise<ToolResult> {
  try {
    const service = new LiteratureService(runtime.workspace, runtime.providers, {
      signal: runtime.signal,
      now: runtime.now,
      randomId: runtime.randomId,
    })
    const receipt = await service.listPaperRelations({
      source: 'sciverse',
      uniqueId: input.unique_id,
      relation: input.relation,
      page: input.page ?? 1,
      pageSize: input.page_size ?? 25,
    })
    return {
      content: boundedToolJson({
        search_id: receipt.searchId,
        record_path: receipt.recordPath,
        source: 'sciverse',
        unique_id: receipt.result.uniqueId,
        relation: receipt.result.relation,
        total: receipt.result.totalCount,
        page: receipt.result.page,
        page_size: receipt.result.pageSize,
        total_pages: receipt.result.totalPages,
        items: receipt.result.items,
      }, 'items'),
    }
  } catch (error) {
    const detail = safeError(error)
    return { content: `${detail.name}: ${detail.message}`, is_error: true }
  }
}
