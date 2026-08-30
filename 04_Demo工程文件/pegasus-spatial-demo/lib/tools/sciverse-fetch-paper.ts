import type { ToolResult } from '../types'
import type { LiteratureToolRuntime } from '../literature/types'
import { executeFetchPaper } from './fetch-paper'

export interface SciverseFetchPaperInput {
  doc_id: string
  search_record_path?: string
}

/** Source-bound Agent facade over the shared durable paper materializer. */
export function executeSciverseFetchPaper(
  input: SciverseFetchPaperInput,
  runtime: LiteratureToolRuntime,
): Promise<ToolResult> {
  return executeFetchPaper({
    source: 'sciverse',
    source_id: input.doc_id,
    search_record_path: input.search_record_path,
  }, runtime, { idField: 'doc_id' })
}
