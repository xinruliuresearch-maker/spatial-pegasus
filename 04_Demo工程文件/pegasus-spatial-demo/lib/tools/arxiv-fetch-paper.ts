import type { ToolResult } from '../types'
import type { LiteratureToolRuntime } from '../literature/types'
import { executeFetchPaper } from './fetch-paper'

/** Agent-facing arXiv acquisition input. The provider is fixed by the tool. */
export interface ArxivFetchPaperInput {
  arxiv_id: string
  version?: string
  search_record_path?: string
}

/**
 * Keep acquisition, audit reuse, PDF materialization, and bounded full-text
 * output in the shared implementation while exposing a source-safe façade.
 */
export async function executeArxivFetchPaper(
  input: ArxivFetchPaperInput,
  runtime: LiteratureToolRuntime,
): Promise<ToolResult> {
  const result = await executeFetchPaper({
    source: 'arxiv',
    source_id: input.arxiv_id,
    version: input.version,
    search_record_path: input.search_record_path,
  }, runtime, { idField: 'arxiv_id' })
  return result
}
