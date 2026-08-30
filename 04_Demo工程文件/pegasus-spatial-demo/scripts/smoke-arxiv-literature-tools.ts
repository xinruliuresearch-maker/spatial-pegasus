import assert from 'node:assert/strict'
import { createInMemoryWorkspace } from '../lib/tools/__test-utils__/in-memory-workspace'
import { executeArxivFetchPaper } from '../lib/tools/arxiv-fetch-paper'
import { executeArxivSearchPapers } from '../lib/tools/arxiv-search-papers'
import { executeSearchDocument } from '../lib/tools/search-document'

/**
 * Opt-in live smoke test for the public Agent-facing literature tool chain.
 *
 * This intentionally uses the tools, rather than provider/parser internals:
 * ArxivSearchPapers -> ArxivFetchPaper -> SearchDocument. It needs internet access
 * but no API key and leaves no persistent application data behind.
 */
async function main(): Promise<void> {
  if (process.env.RUN_LIVE_LITERATURE_SMOKE !== '1') {
    throw new Error('Set RUN_LIVE_LITERATURE_SMOKE=1 to run the live arXiv smoke test')
  }

  const workspace = createInMemoryWorkspace()
  const runtime = { workspace }
  const search = await executeArxivSearchPapers({
    query: 'solid-state electrolyte',
    filters: { categories: ['cond-mat.mtrl-sci'] },
    sort: 'relevance',
    limit: 1,
  }, runtime)
  assert.equal(search.is_error, undefined, search.content)

  const searchResult = JSON.parse(search.content) as {
    record_path: string
    papers: Array<{ ref: { sourceId: string }; title: string }>
  }
  const paper = searchResult.papers[0]
  assert.ok(paper, 'arXiv search returned no papers')

  const fetched = await executeArxivFetchPaper({
    arxiv_id: paper.ref.sourceId,
    search_record_path: searchResult.record_path,
  }, runtime)
  assert.equal(fetched.is_error, undefined, fetched.content)

  const receipt = JSON.parse(fetched.content) as {
    status: string
    source_content_path: string
    full_text_path: string
    full_text: string
    full_text_chars: number
    full_text_truncated: boolean
    parser?: { name: string; version: string }
  }
  assert.equal(receipt.status, 'ready')
  assert.match(receipt.source_content_path, /\/original\.pdf$/)
  assert.match(receipt.full_text_path, /\/parsed\/fulltext\.md$/)
  assert.ok(workspace.exists(receipt.source_content_path), 'original PDF was not saved')
  assert.ok(workspace.exists(receipt.full_text_path), 'parsed full text was not saved')
  assert.ok(receipt.full_text_chars > 0, 'ArxivFetchPaper returned empty full text')

  const probe = receipt.full_text
    .match(/[A-Za-z][A-Za-z-]{7,}/)?.[0]
  assert.ok(probe, 'Could not choose a probe term from parsed text')
  const located = await executeSearchDocument({
    query: probe,
    document_paths: [receipt.full_text_path],
    max_results: 3,
  }, runtime)
  assert.equal(located.is_error, undefined, located.content)
  const searchDocumentResult = JSON.parse(located.content) as { hits: unknown[] }
  assert.ok(searchDocumentResult.hits.length > 0, 'SearchDocument did not locate parsed text')

  process.stdout.write(`${JSON.stringify({
    ok: true,
    source: 'arxiv',
    arxiv_id: paper.ref.sourceId,
    title: paper.title,
    parser: receipt.parser,
    original_pdf_path: receipt.source_content_path,
    full_text_path: receipt.full_text_path,
    full_text_chars: receipt.full_text_chars,
    inline_text_truncated: receipt.full_text_truncated,
    located_hits: searchDocumentResult.hits.length,
  }, null, 2)}\n`)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
