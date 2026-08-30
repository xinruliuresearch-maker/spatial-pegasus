import assert from 'node:assert/strict'
import { createInMemoryWorkspace } from '../__test-utils__/in-memory-workspace'
import type {
  FetchedLiteraturePaper,
  LiteratureProvider,
  LiteratureProviderRegistry,
  LiteratureSearchPage,
  LiteratureSource,
  SciverseEvidenceSearchResult,
  SciversePaperRelationsResult,
} from '../../literature/types'
import { executeArxivFetchPaper } from '../arxiv-fetch-paper'
import { executeArxivSearchPapers } from '../arxiv-search-papers'
import { executeSciverseFetchPaper } from '../sciverse-fetch-paper'
import { executeSciverseListRelations } from '../sciverse-list-relations'
import { executeSciverseSearchEvidence } from '../sciverse-search-evidence'
import { executeSciverseSearchPapers } from '../sciverse-search-papers'
import { executeSearchDocument } from '../search-document'
import { boundedToolJson } from '../../literature/tool-output'
import type { PdfParserPort } from '../../document-parsers/types'

const SCIVERSE_DOC_ID = 'a'.repeat(64)
const ARXIV_PDF_FIXTURE = Buffer.from('%PDF-1.7\nfixture')
const SCIVERSE_FULL_TEXT_FIXTURE = '# Full text\nionic conductivity was measured'

function fixturePage(source: LiteratureSource): LiteratureSearchPage {
  return {
    source,
    papers: [{
      ref: source === 'arxiv'
        ? { source, sourceId: '2401.01234v2', version: 'v2' }
        : {
            source,
            sourceId: SCIVERSE_DOC_ID,
            uniqueId: 'uid:paper-1',
            documentId: SCIVERSE_DOC_ID,
          },
      title: 'Fixture material paper',
      authors: ['Researcher'],
      abstract: 'Measured transport properties.',
      landingUrl: source === 'arxiv'
        ? 'https://arxiv.org/abs/2401.01234v2'
        : `https://example.invalid/${SCIVERSE_DOC_ID}`,
      license: 'CC-BY-4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
      contentAccessible: true,
    }],
    total: 1,
    providerVersion: 'fixture-v1',
  }
}

function fixtureEvidence(): SciverseEvidenceSearchResult {
  return {
    source: 'sciverse',
    hits: [{
      source: 'sciverse',
      documentId: SCIVERSE_DOC_ID,
      chunkId: 'chunk-1',
      uniqueId: 'uid:paper-1',
      title: 'Fixture material paper',
      authors: ['Researcher'],
      abstract: 'Measured transport properties.',
      chunk: 'The measured ionic conductivity was 10 mS cm-1.',
      score: 0.94,
      offset: 128,
      offsetUnit: 'utf8_byte',
      page: 7,
      sourceType: 'pdf',
      venue: 'Fixture Journal',
      publishedYear: 2025,
    }],
    providerVersion: 'fixture-v1',
  }
}

function fixtureRelations(): SciversePaperRelationsResult {
  return {
    source: 'sciverse',
    uniqueId: 'uid:paper-1',
    relation: 'REFERENCES',
    items: [{ id: 'uid:reference-1', idType: 'unique_id', title: 'Earlier material paper' }],
    totalCount: 1,
    page: 1,
    pageSize: 25,
    totalPages: 1,
    providerVersion: 'fixture-v1',
  }
}

function fixtureFetch(source: LiteratureSource): FetchedLiteraturePaper {
  const paper = fixturePage(source).papers[0]
  return source === 'arxiv'
    ? {
        source,
        paper,
        content: {
          kind: 'pdf',
          buffer: Buffer.from(ARXIV_PDF_FIXTURE),
          mimeType: 'application/pdf',
          filename: '2401.01234v2.pdf',
          canonicalUrl: 'https://arxiv.org/pdf/2401.01234v2',
        },
        retrievedAt: '2026-08-07T00:00:00.000Z',
        providerVersion: 'fixture-v1',
      }
    : {
        source,
        paper: {
          ref: {
            source,
            sourceId: SCIVERSE_DOC_ID,
            uniqueId: 'uid:paper-1',
            documentId: SCIVERSE_DOC_ID,
          },
          title: `Sciverse document ${SCIVERSE_DOC_ID}`,
          authors: [],
        },
        content: {
          kind: 'fulltext',
          text: SCIVERSE_FULL_TEXT_FIXTURE,
          mimeType: 'text/markdown',
          filename: 'source-fulltext.md',
          canonicalUrl: `https://example.invalid/${SCIVERSE_DOC_ID}`,
        },
        retrievedAt: '2026-08-07T00:00:00.000Z',
        providerVersion: 'fixture-v1',
      }
}

function fakeProviders(counters: Record<string, number>): LiteratureProviderRegistry {
  const arxiv: LiteratureProvider = {
    source: 'arxiv',
    async searchPapers(request) {
      assert.equal(request.source, 'arxiv')
      counters['arxiv:search_papers'] = (counters['arxiv:search_papers'] ?? 0) + 1
      return fixturePage('arxiv')
    },
    async fetchPaper() {
      counters['arxiv:fetch'] = (counters['arxiv:fetch'] ?? 0) + 1
      return fixtureFetch('arxiv')
    },
  }
  const sciverse: LiteratureProvider = {
    source: 'sciverse',
    async searchPapers(request) {
      assert.equal(request.source, 'sciverse')
      counters['sciverse:search_papers'] = (counters['sciverse:search_papers'] ?? 0) + 1
      return fixturePage('sciverse')
    },
    async searchEvidence(request) {
      assert.equal(request.source, 'sciverse')
      counters['sciverse:search_evidence'] = (counters['sciverse:search_evidence'] ?? 0) + 1
      return fixtureEvidence()
    },
    async listPaperRelations(request) {
      assert.equal(request.source, 'sciverse')
      counters['sciverse:list_relations'] = (counters['sciverse:list_relations'] ?? 0) + 1
      return fixtureRelations()
    },
    async fetchPaper() {
      counters['sciverse:fetch'] = (counters['sciverse:fetch'] ?? 0) + 1
      return fixtureFetch('sciverse')
    },
  }
  return new Map([
    ['arxiv', arxiv],
    ['sciverse', sciverse],
  ])
}

function fakePdfParser(
  counters: Record<string, number>,
  markdown = '<!-- page: 1 -->\n\n## Page 1\n\nLocally parsed ionic conductivity evidence.\n',
): PdfParserPort {
  return {
    async parse() {
      counters['pdf:parse'] = (counters['pdf:parse'] ?? 0) + 1
      return {
        markdown,
        pages: [{ page: 1, text: markdown }],
        blocks: [{
          blockId: 'page-1-block-1',
          page: 1,
          index: 1,
          type: 'text',
          text: markdown,
        }],
        totalPages: 1,
        parsedPages: [1],
        parser: { name: 'pdf-parse', version: '2.4.5' },
        warnings: [],
      }
    },
  }
}

interface SearchAuditFixture {
  recordPath: string
  record: string
}

async function verifyArxivSearchAuditAndSourceBinding(): Promise<SearchAuditFixture> {
  const workspace = createInMemoryWorkspace()
  const counters: Record<string, number> = {}
  const result = await executeArxivSearchPapers({
    query: 'solid electrolyte',
    limit: 5,
  }, {
    workspace,
    providers: fakeProviders(counters),
    randomId: () => 'fixed-id',
    now: () => new Date('2026-08-07T00:00:00.000Z'),
  })
  assert.equal(result.is_error, undefined, result.content)
  assert.equal(counters['arxiv:search_papers'], 1)
  assert.equal(counters['sciverse:search_papers'] ?? 0, 0)
  const recordPath = 'references/searches/search-fixed-id.json'
  const record = workspace.dump()[recordPath]
  assert.ok(record)
  const parsed = JSON.parse(record)
  assert.equal(parsed.schemaVersion, 2)
  assert.equal(parsed.operation, 'search_papers')
  assert.equal(parsed.source, 'arxiv')
  assert.equal(parsed.status, 'success')
  assert.equal(parsed.request.source, 'arxiv')
  assert.equal(parsed.request.query, 'solid electrolyte')
  assert.doesNotMatch(record, /frontier|support|contradict|gap|next_query/i)
  return { recordPath, record }
}

async function verifySciverseIntentToolsAndAudits(): Promise<void> {
  const workspace = createInMemoryWorkspace()
  const counters: Record<string, number> = {}
  const ids = ['sciverse-papers', 'sciverse-evidence', 'sciverse-relations']
  let idIndex = 0
  const runtime = {
    workspace,
    providers: fakeProviders(counters),
    randomId: () => ids[idIndex++],
    now: () => new Date('2026-08-07T00:00:00.000Z'),
  }

  const papers = await executeSciverseSearchPapers({
    title_contains: 'ceramic electrolyte',
    year_from: 2020,
    page_size: 5,
  }, runtime)
  assert.equal(papers.is_error, undefined, papers.content)
  assert.equal(counters['sciverse:search_papers'], 1)
  assert.equal(counters['arxiv:search_papers'] ?? 0, 0)
  const papersResult = JSON.parse(papers.content)
  assert.equal(papersResult.papers[0].ref.documentId, SCIVERSE_DOC_ID)

  const evidence = await executeSciverseSearchEvidence({
    query: 'measured ionic conductivity',
    top_k: 7,
    mode: 'quality',
    filters: { doc_id: [SCIVERSE_DOC_ID] },
  }, runtime)
  assert.equal(evidence.is_error, undefined, evidence.content)
  assert.equal(counters['sciverse:search_evidence'], 1)
  const evidenceResult = JSON.parse(evidence.content)
  assert.equal(evidenceResult.hits[0].chunk_id, undefined)
  assert.equal(evidenceResult.hits[0].chunkId, 'chunk-1')
  assert.equal(evidenceResult.hits[0].offsetUnit, 'utf8_byte')

  const relations = await executeSciverseListRelations({
    unique_id: 'uid:paper-1',
    relation: 'REFERENCES',
  }, runtime)
  assert.equal(relations.is_error, undefined, relations.content)
  assert.equal(counters['sciverse:list_relations'], 1)
  assert.equal(JSON.parse(relations.content).items[0].id, 'uid:reference-1')

  const records = workspace.dump()
  const paperAudit = JSON.parse(records['references/searches/search-sciverse-papers.json'])
  const evidenceAudit = JSON.parse(records['references/searches/search-sciverse-evidence.json'])
  const relationAudit = JSON.parse(records['references/searches/search-sciverse-relations.json'])
  assert.equal(paperAudit.operation, 'search_papers')
  assert.equal(paperAudit.request.source, 'sciverse')
  assert.equal(paperAudit.request.titleContains, 'ceramic electrolyte')
  assert.equal(evidenceAudit.operation, 'search_evidence')
  assert.equal(evidenceAudit.request.source, 'sciverse')
  assert.deepEqual(evidenceAudit.request.filters.doc_id, [SCIVERSE_DOC_ID])
  assert.equal(relationAudit.operation, 'list_relations')
  assert.equal(relationAudit.request.source, 'sciverse')
  assert.equal(relationAudit.request.uniqueId, 'uid:paper-1')
}

async function verifyFailedSearchIsAudited(): Promise<void> {
  const workspace = createInMemoryWorkspace()
  const failing: LiteratureProvider = {
    source: 'arxiv',
    async searchPapers() { throw new Error('upstream unavailable') },
    async fetchPaper() { throw new Error('not used') },
  }
  const result = await executeArxivSearchPapers({ query: 'x' }, {
    workspace,
    providers: new Map([['arxiv', failing]]),
    randomId: () => 'failure-id',
  })
  assert.equal(result.is_error, true)
  const record = workspace.dump()['references/searches/search-failure-id.json']
  const parsed = JSON.parse(record)
  assert.equal(parsed.status, 'error')
  assert.equal(parsed.operation, 'search_papers')
  assert.equal(parsed.request.source, 'arxiv')
}

async function verifyFetchAndIdempotency(audit: SearchAuditFixture): Promise<void> {
  const workspace = createInMemoryWorkspace()
  const counters: Record<string, number> = {}
  const runtime = {
    workspace,
    providers: fakeProviders(counters),
    pdfParser: fakePdfParser(counters),
  }

  const foreignWorkspacePath = await executeArxivFetchPaper({
    arxiv_id: '2401.01234v2',
    search_record_path: audit.recordPath,
  }, runtime)
  assert.equal(foreignWorkspacePath.is_error, true)
  assert.match(foreignWorkspacePath.content, /does not exist in the current workspace/)
  assert.equal(counters['arxiv:fetch'] ?? 0, 0)

  const wrongSourcePath = 'references/searches/search-wrong-source.json'
  const wrongSource = JSON.parse(audit.record)
  wrongSource.searchId = 'search-wrong-source'
  wrongSource.source = 'sciverse'
  wrongSource.request.source = 'sciverse'
  wrongSource.result.source = 'sciverse'
  wrongSource.result.papers[0].ref = {
    source: 'sciverse',
    sourceId: SCIVERSE_DOC_ID,
    uniqueId: 'uid:paper-1',
    documentId: SCIVERSE_DOC_ID,
  }
  await workspace.writeText(wrongSourcePath, JSON.stringify(wrongSource))
  const wrongSourceResult = await executeArxivFetchPaper({
    arxiv_id: '2401.01234v2',
    search_record_path: wrongSourcePath,
  }, runtime)
  assert.equal(wrongSourceResult.is_error, true)
  assert.match(wrongSourceResult.content, /source does not match/)

  const wrongIdPath = 'references/searches/search-wrong-id.json'
  const wrongId = JSON.parse(audit.record)
  wrongId.searchId = 'search-wrong-id'
  wrongId.result.papers[0].ref.sourceId = '2401.99999v2'
  await workspace.writeText(wrongIdPath, JSON.stringify(wrongId))
  const wrongIdResult = await executeArxivFetchPaper({
    arxiv_id: '2401.01234v2',
    search_record_path: wrongIdPath,
  }, runtime)
  assert.equal(wrongIdResult.is_error, true)
  assert.match(wrongIdResult.content, /does not contain requested paper/)

  const failedPath = 'references/searches/search-failed-binding.json'
  const failed = JSON.parse(audit.record)
  failed.searchId = 'search-failed-binding'
  failed.status = 'error'
  delete failed.result
  await workspace.writeText(failedPath, JSON.stringify(failed))
  const failedResult = await executeArxivFetchPaper({
    arxiv_id: '2401.01234v2',
    search_record_path: failedPath,
  }, runtime)
  assert.equal(failedResult.is_error, true)
  assert.match(failedResult.content, /not a successful literature audit record/)
  assert.equal(counters['arxiv:fetch'] ?? 0, 0)

  await workspace.writeText(audit.recordPath, audit.record)
  const first = await executeArxivFetchPaper({
    arxiv_id: '2401.01234',
    version: 'v2',
    search_record_path: audit.recordPath,
  }, runtime)
  assert.equal(first.is_error, undefined, first.content)
  assert.equal(first.telemetry?.download_bytes, ARXIV_PDF_FIXTURE.byteLength)
  assert.equal(counters['arxiv:fetch'], 1)
  assert.equal(counters['pdf:parse'], 1)
  const receipt = JSON.parse(first.content)
  assert.equal(receipt.status, 'ready')
  assert.equal(receipt.download_bytes, undefined, 'telemetry must not change the Agent-facing receipt JSON')
  assert.equal(receipt.arxiv_id, '2401.01234v2')
  assert.equal(receipt.source_id, undefined)
  assert.equal(receipt.text_origin, 'local_parser')
  assert.match(receipt.source_content_path, /\/original\.pdf$/)
  assert.match(receipt.full_text_path, /\/parsed\/fulltext\.md$/)
  assert.match(receipt.full_text, /Locally parsed ionic conductivity evidence/)
  assert.equal(receipt.full_text_truncated, false)
  const document = workspace.dumpDocuments()[receipt.source_content_path]
  assert.ok(document)
  assert.equal(document.provenance.search_record_id, 'search-fixed-id')
  assert.ok(workspace.dump()[receipt.metadata_path])
  assert.ok(workspace.dump()[receipt.provenance_path])
  assert.ok(workspace.dump()[receipt.full_text_path])
  assert.ok(workspace.dump()[receipt.blocks_path])
  assert.ok(workspace.dump()[receipt.parser_provenance_path])

  const second = await executeArxivFetchPaper({
    arxiv_id: 'https://arxiv.org/abs/2401.01234v2',
    search_record_path: audit.recordPath,
  }, runtime)
  const secondReceipt = JSON.parse(second.content)
  assert.equal(second.telemetry?.download_bytes, 0)
  assert.equal(secondReceipt.already_present, true)
  assert.equal(secondReceipt.directory, receipt.directory)
  assert.equal(counters['arxiv:fetch'], 1)
  assert.equal(counters['pdf:parse'], 1)

  const invalidAuditAfterCache = await executeArxivFetchPaper({
    arxiv_id: '2401.01234v2',
    search_record_path: 'references/searches/search-missing-after-cache.json',
  }, runtime)
  assert.equal(invalidAuditAfterCache.is_error, true)
  assert.match(invalidAuditAfterCache.content, /does not exist in the current workspace/)
  assert.equal(counters['arxiv:fetch'], 1)

  const sciverseSearch = await executeSciverseSearchPapers({
    query: 'ceramic electrolyte',
  }, {
    ...runtime,
    randomId: () => 'sciverse-binding',
  })
  assert.equal(sciverseSearch.is_error, undefined, sciverseSearch.content)
  const sciverseSearchRecord = JSON.parse(sciverseSearch.content).record_path
  const sciverse = await executeSciverseFetchPaper({
    doc_id: SCIVERSE_DOC_ID,
    search_record_path: sciverseSearchRecord,
  }, runtime)
  assert.equal(sciverse.is_error, undefined, sciverse.content)
  assert.equal(
    sciverse.telemetry?.download_bytes,
    Buffer.byteLength(SCIVERSE_FULL_TEXT_FIXTURE, 'utf8'),
  )
  const sciverseReceipt = JSON.parse(sciverse.content)
  assert.equal(sciverseReceipt.doc_id, SCIVERSE_DOC_ID)
  assert.equal(sciverseReceipt.source_id, undefined)
  assert.equal(sciverseReceipt.text_origin, 'provider')
  assert.equal(sciverseReceipt.source_content_path, sciverseReceipt.full_text_path)
  assert.match(workspace.dump()[sciverseReceipt.full_text_path], /ionic conductivity/)
  assert.match(sciverseReceipt.full_text, /ionic conductivity/)
  assert.equal(counters['pdf:parse'], 1)
  const sciverseMetadata = JSON.parse(workspace.dump()[sciverseReceipt.metadata_path])
  assert.equal(sciverseMetadata.paper.title, 'Fixture material paper')
  assert.deepEqual(sciverseMetadata.paper.authors, ['Researcher'])

  const cachedSciverse = await executeSciverseFetchPaper({
    doc_id: SCIVERSE_DOC_ID,
    search_record_path: sciverseSearchRecord,
  }, runtime)
  assert.equal(cachedSciverse.is_error, undefined, cachedSciverse.content)
  assert.equal(cachedSciverse.telemetry?.download_bytes, 0)
  assert.equal(counters['sciverse:fetch'], 1)

  const invalidVersion = await executeArxivFetchPaper({
    arxiv_id: '2401.01234',
    version: 'v0',
  }, runtime)
  assert.equal(invalidVersion.is_error, true)
  assert.match(invalidVersion.content, /positive integer/)

  const conflictingVersion = await executeArxivFetchPaper({
    arxiv_id: '2401.01234v2',
    version: 'v3',
  }, runtime)
  assert.equal(conflictingVersion.is_error, true)
  assert.match(conflictingVersion.content, /version mismatch/)
}

async function verifyConcurrentFetchSingleflight(audit: SearchAuditFixture): Promise<void> {
  const workspace = createInMemoryWorkspace()
  const counters: Record<string, number> = {}
  await workspace.writeText(audit.recordPath, audit.record)
  const runtime = {
    workspace,
    providers: fakeProviders(counters),
    pdfParser: fakePdfParser(counters),
  }

  const input = {
    arxiv_id: '2401.01234v2',
    search_record_path: audit.recordPath,
  }
  const [first, second] = await Promise.all([
    executeArxivFetchPaper(input, runtime),
    executeArxivFetchPaper(input, runtime),
  ])

  assert.equal(first.is_error, undefined, first.content)
  assert.equal(second.is_error, undefined, second.content)
  assert.equal(counters['arxiv:fetch'], 1)
  assert.equal(counters['pdf:parse'], 1)
  assert.equal(JSON.parse(first.content).full_text_path, JSON.parse(second.content).full_text_path)
  assert.deepEqual(
    [first.telemetry?.download_bytes, second.telemetry?.download_bytes].sort((a, b) => (a ?? 0) - (b ?? 0)),
    [0, ARXIV_PDF_FIXTURE.byteLength],
    'singleflight joiners must not double-count one provider download',
  )
}

async function verifyParseRetryUsesSavedPdfAndBoundsInlineText(): Promise<void> {
  const workspace = createInMemoryWorkspace()
  const counters: Record<string, number> = {}
  const providers = fakeProviders(counters)
  const failingParser: PdfParserPort = {
    async parse() {
      counters['pdf:parse:failed'] = (counters['pdf:parse:failed'] ?? 0) + 1
      throw new Error('fixture parser unavailable')
    },
  }

  const partial = await executeArxivFetchPaper({
    arxiv_id: '2401.01234v2',
  }, { workspace, providers, pdfParser: failingParser })
  assert.equal(partial.is_error, true)
  assert.equal(partial.telemetry?.download_bytes, ARXIV_PDF_FIXTURE.byteLength)
  const partialReceipt = JSON.parse(partial.content)
  assert.equal(partialReceipt.status, 'partial')
  assert.equal(partialReceipt.arxiv_id, '2401.01234v2')
  assert.equal(partialReceipt.source_id, undefined)
  assert.match(partialReceipt.source_content_path, /\/original\.pdf$/)
  assert.match(partialReceipt.retry, /source-specific fetch tool/)
  assert.match(partialReceipt.retry, /same arxiv_id/)
  assert.ok(workspace.dumpDocuments()[partialReceipt.source_content_path])
  assert.equal(counters['arxiv:fetch'], 1)
  assert.equal(counters['pdf:parse:failed'], 1)

  // JSON escaping makes this text substantially larger when serialized. The
  // result budget must therefore be measured after JSON encoding.
  const longText = `${'material "evidence" \\ path\n\t'.repeat(2_000)}😀\n`
  const completed = await executeArxivFetchPaper({
    arxiv_id: '2401.01234v2',
  }, { workspace, providers, pdfParser: fakePdfParser(counters, longText) })
  assert.equal(completed.is_error, undefined, completed.content)
  assert.equal(completed.telemetry?.download_bytes, 0, 'parse retry reuses the saved PDF')
  const receipt = JSON.parse(completed.content)
  assert.equal(receipt.status, 'ready')
  assert.equal(receipt.full_text_truncated, true)
  assert.ok(completed.content.length <= 24_000)
  assert.ok(receipt.full_text.length > 0)
  assert.equal(receipt.full_text_returned_chars, receipt.full_text.length)
  assert.ok(receipt.full_text_chars > receipt.full_text_returned_chars)
  const lastCodeUnit = receipt.full_text.charCodeAt(receipt.full_text.length - 1)
  assert.ok(!(lastCodeUnit >= 0xD800 && lastCodeUnit <= 0xDBFF))
  assert.match(receipt.next_action, /SearchDocument/)
  assert.match(receipt.full_text_path, /\/parsed\/fulltext\.md$/)
  assert.equal(workspace.dump()[receipt.full_text_path].length, receipt.full_text_chars)
  assert.equal(counters['arxiv:fetch'], 1)
  assert.equal(counters['pdf:parse'], 1)
}

async function verifyDownloadedBytesSurviveWorkspaceFailure(): Promise<void> {
  const base = createInMemoryWorkspace()
  const counters: Record<string, number> = {}
  const workspace = {
    ...base,
    async writeText(
      path: string,
      content: string,
      note?: string,
      options?: { archive?: boolean },
    ): Promise<void> {
      if (path.endsWith('/metadata.json')) throw new Error('fixture workspace unavailable')
      return base.writeText(path, content, note, options)
    },
  }
  const result = await executeArxivFetchPaper({
    arxiv_id: '2401.01234v2',
  }, {
    workspace,
    providers: fakeProviders(counters),
    pdfParser: fakePdfParser(counters),
  })
  assert.equal(result.is_error, true)
  assert.equal(result.telemetry?.download_bytes, ARXIV_PDF_FIXTURE.byteLength)
  const receipt = JSON.parse(result.content)
  assert.equal(receipt.status, 'error')
  assert.match(receipt.retry, /will be downloaded again/)
  assert.equal(counters['arxiv:fetch'], 1)
  assert.equal(Object.keys(base.dumpDocuments()).length, 0)
}

async function verifyDocumentSearch(): Promise<void> {
  const workspace = createInMemoryWorkspace()
  const blocksPath = 'references/papers/arxiv-fixture/parsed/content-list.json'
  await workspace.writeText(blocksPath, JSON.stringify([
    {
      block_id: 'b-1',
      page_idx: 4,
      heading_path: ['Results', 'Transport'],
      bbox: [10, 20, 30, 40],
      text: 'The ionic conductivity reached 10 mS cm-1 at room temperature.',
    },
  ]))
  const result = await executeSearchDocument({
    query: 'ionic conductivity',
    document_paths: ['references/papers/arxiv-fixture'],
  }, { workspace, providers: new Map() })
  assert.equal(result.is_error, undefined, result.content)
  const parsed = JSON.parse(result.content)
  assert.equal(parsed.hits.length, 1)
  assert.equal(parsed.hits[0].page, 4)
  assert.equal(parsed.hits[0].section, 'Results > Transport')
  assert.deepEqual(parsed.hits[0].bbox, [10, 20, 30, 40])

  const invalid = await executeSearchDocument({
    query: 'ionic conductivity',
    document_paths: 'not-an-array' as unknown as string[],
  }, { workspace, providers: new Map() })
  assert.equal(invalid.is_error, true)
}

function verifyHardOutputBoundary(): void {
  const rendered = boundedToolJson({
    record_path: 'references/searches/search-output-boundary.json',
    papers: Array.from({ length: 100 }, (_, index) => ({
      id: index,
      abstract: 'x'.repeat(500),
    })),
  }, 'papers', 1_000)
  assert.ok(rendered.length <= 1_000)
  const parsed = JSON.parse(rendered)
  assert.equal(parsed.tool_result_truncated, true)
  assert.equal(parsed.record_path, 'references/searches/search-output-boundary.json')
}

async function main(): Promise<void> {
  const audit = await verifyArxivSearchAuditAndSourceBinding()
  await verifySciverseIntentToolsAndAudits()
  await verifyFailedSearchIsAudited()
  await verifyFetchAndIdempotency(audit)
  await verifyConcurrentFetchSingleflight(audit)
  await verifyParseRetryUsesSavedPdfAndBoundsInlineText()
  await verifyDownloadedBytesSurviveWorkspaceFailure()
  await verifyDocumentSearch()
  verifyHardOutputBoundary()
  console.log('literature-tools:verify passed')
}

void main()
