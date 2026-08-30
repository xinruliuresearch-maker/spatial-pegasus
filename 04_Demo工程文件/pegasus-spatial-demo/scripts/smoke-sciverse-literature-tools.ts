import assert from 'node:assert/strict'
import { createInMemoryWorkspace } from '../lib/tools/__test-utils__/in-memory-workspace'
import { executeSciverseFetchPaper } from '../lib/tools/sciverse-fetch-paper'
import { executeSciverseListRelations } from '../lib/tools/sciverse-list-relations'
import { executeSciverseSearchEvidence } from '../lib/tools/sciverse-search-evidence'
import { executeSciverseSearchPapers } from '../lib/tools/sciverse-search-papers'
import { executeSearchDocument } from '../lib/tools/search-document'

/**
 * Opt-in live smoke for the complete Agent-facing Sciverse chain. It exercises
 * every currently exposed Sciverse capability and keeps artifacts in memory.
 */
async function main(): Promise<void> {
  if (process.env.RUN_LIVE_SCIVERSE_SMOKE !== '1') {
    throw new Error('Set RUN_LIVE_SCIVERSE_SMOKE=1 to run the live Sciverse smoke test')
  }
  if (!process.env.SCIVERSE_API_TOKEN?.trim()) {
    throw new Error('Set SCIVERSE_API_TOKEN before running the live Sciverse smoke test')
  }

  const workspace = createInMemoryWorkspace()
  const runtime = { workspace }
  const query = 'solid-state electrolyte ionic conductivity'

  const paperSearch = await executeSciverseSearchPapers({
    query,
    sort_by_year: 'desc',
    page_size: 5,
  }, runtime)
  assert.equal(paperSearch.is_error, undefined, paperSearch.content)
  const paperResult = JSON.parse(paperSearch.content) as {
    record_path: string
    papers: Array<{
      title: string
      ref: { uniqueId?: string; documentId?: string }
      contentAccessible?: boolean
    }>
  }
  const relationPaper = paperResult.papers.find(paper => paper.ref.uniqueId)
  assert.ok(relationPaper?.ref.uniqueId, 'Sciverse paper search returned no unique_id')

  const relations = await executeSciverseListRelations({
    unique_id: relationPaper.ref.uniqueId,
    relation: 'REFERENCES',
    page_size: 5,
  }, runtime)
  assert.equal(relations.is_error, undefined, relations.content)
  const relationResult = JSON.parse(relations.content) as { total: number; items: unknown[] }

  const evidence = await executeSciverseSearchEvidence({
    query: 'What measured ionic conductivity is reported for solid-state electrolytes?',
    top_k: 5,
    mode: 'balanced',
    source_types: ['pdf'],
  }, runtime)
  assert.equal(evidence.is_error, undefined, evidence.content)
  const evidenceResult = JSON.parse(evidence.content) as {
    record_path: string
    hits: Array<{ documentId: string; chunk: string; title: string }>
  }
  const hit = evidenceResult.hits[0]
  assert.ok(hit?.documentId, 'Sciverse evidence search returned no fetchable doc_id')

  const fetched = await executeSciverseFetchPaper({
    doc_id: hit.documentId,
    search_record_path: evidenceResult.record_path,
  }, runtime)
  assert.equal(fetched.is_error, undefined, fetched.content)
  const receipt = JSON.parse(fetched.content) as {
    status: string
    doc_id: string
    source_content_path: string
    full_text_path: string
    full_text: string
    full_text_chars: number
    full_text_truncated: boolean
  }
  assert.equal(receipt.status, 'ready')
  assert.equal(receipt.doc_id, hit.documentId)
  assert.equal(receipt.source_content_path, receipt.full_text_path)
  assert.ok(workspace.exists(receipt.full_text_path), 'Sciverse full text was not saved')
  assert.ok(receipt.full_text_chars > 0, 'SciverseFetchPaper returned empty full text')

  const probe = receipt.full_text.match(/[A-Za-z][A-Za-z-]{7,}/)?.[0]
    ?? hit.chunk.match(/[A-Za-z][A-Za-z-]{7,}/)?.[0]
  assert.ok(probe, 'Could not choose a probe term from Sciverse text')
  const located = await executeSearchDocument({
    query: probe,
    document_paths: [receipt.full_text_path],
    max_results: 3,
  }, runtime)
  assert.equal(located.is_error, undefined, located.content)
  const locatedResult = JSON.parse(located.content) as { hits: unknown[] }
  assert.ok(locatedResult.hits.length > 0, 'SearchDocument did not locate Sciverse text')

  process.stdout.write(`${JSON.stringify({
    ok: true,
    source: 'sciverse',
    paper_search_record: paperResult.record_path,
    relation_unique_id: relationPaper.ref.uniqueId,
    relation_total: relationResult.total,
    relation_items_returned: relationResult.items.length,
    evidence_record: evidenceResult.record_path,
    fetched_doc_id: hit.documentId,
    fetched_title: hit.title,
    full_text_path: receipt.full_text_path,
    full_text_chars: receipt.full_text_chars,
    inline_text_truncated: receipt.full_text_truncated,
    located_hits: locatedResult.hits.length,
  }, null, 2)}\n`)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
