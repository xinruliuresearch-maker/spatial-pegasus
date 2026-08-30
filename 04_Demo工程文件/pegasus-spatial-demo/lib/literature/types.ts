import type { WorkspaceInstance } from '../workspace/types'
import type { PdfParserPort } from '../document-parsers/types'

export type LiteratureSource = 'arxiv' | 'sciverse'

export type LiteratureSort = 'relevance' | 'newest' | 'oldest'

export type SciverseSearchMode = 'fast' | 'balanced' | 'quality'

export type SciversePaperRelationKind = 'CITATIONS' | 'REFERENCES' | 'RELATED_WORKS'

export type SciverseFilterOperator =
  | 'FILTER_OP_EQ'
  | 'FILTER_OP_NE'
  | 'FILTER_OP_GT'
  | 'FILTER_OP_GTE'
  | 'FILTER_OP_LT'
  | 'FILTER_OP_LTE'
  | 'FILTER_OP_IN'
  | 'FILTER_OP_NIN'
  | 'FILTER_OP_CONTAINS'
  | 'FILTER_OP_MATCH'
  | 'FILTER_OP_MATCH_PHRASE'

export type SciverseSortOrder = 'SORT_ORDER_DESC' | 'SORT_ORDER_ASC'

export type SciverseRankingBoost = 'NONE' | 'MILD' | 'STRONG'

export interface LiteratureSearchFilters {
  authors?: string[]
  categories?: string[]
  publishedFrom?: string
  publishedTo?: string
}

export interface ArxivPaperSearchRequest {
  source: 'arxiv'
  query: string
  limit: number
  cursor?: string
  sort?: LiteratureSort
  filters?: LiteratureSearchFilters
}

export interface SciverseAdvancedFilter {
  field: string
  operator?: SciverseFilterOperator
  value: unknown
}

export interface SciverseAdvancedSort {
  field: string
  order: SciverseSortOrder
}

export interface SciversePaperSearchRequest {
  source: 'sciverse'
  query?: string
  titleContains?: string
  abstractContains?: string
  authors?: string[]
  yearFrom?: number
  yearTo?: number
  journals?: string[]
  subjects?: string[]
  filtersAdvanced?: SciverseAdvancedFilter[]
  sortAdvanced?: SciverseAdvancedSort[]
  sortByYear?: 'desc' | 'asc' | 'none'
  freshnessBoost?: SciverseRankingBoost
  impactBoost?: SciverseRankingBoost
  languageAffinity?: SciverseRankingBoost
  page: number
  pageSize: number
  cursor?: string
}

export type LiteraturePaperSearchRequest = ArxivPaperSearchRequest | SciversePaperSearchRequest

export interface SciverseEvidenceFilters {
  lang?: unknown
  metadata_type?: unknown
  author?: unknown
  publication_venue_name_unified?: unknown
  publication_venue_type?: unknown
  publication_published_year?: unknown
  publication_published_date?: unknown
  citation_count?: unknown
  influential_citation_count?: unknown
  title?: unknown
  topics?: unknown
  doc_id?: unknown
}

export interface SciverseEvidenceSearchRequest {
  source: 'sciverse'
  query: string
  topK: number
  mode: SciverseSearchMode
  sourceTypes?: Array<'web' | 'pdf'>
  filters?: SciverseEvidenceFilters
}

export interface SciversePaperRelationsRequest {
  source: 'sciverse'
  uniqueId: string
  relation: SciversePaperRelationKind
  page: number
  pageSize: number
}

export interface LiteraturePaperRef {
  source: LiteratureSource
  sourceId: string
  version?: string
  /** Sciverse metadata identity, present even when no full text exists. */
  uniqueId?: string
  /** Sciverse full-text artifact id. Required by SciverseFetchPaper. */
  documentId?: string
}

export interface LiteratureSourceLocation {
  page?: number
  section?: string
  paragraph?: string
  quote?: string
  score?: number
  locator?: string
}

export interface LiteraturePaper {
  ref: LiteraturePaperRef
  title: string
  authors: string[]
  abstract?: string
  publishedAt?: string
  updatedAt?: string
  categories?: string[]
  doi?: string
  landingUrl?: string
  documentUrl?: string
  license?: string
  licenseUrl?: string
  contentAccessible?: boolean
  venue?: string
  publishedYear?: number
  citationCount?: number
  influentialCitationCount?: number
  sourceLocations?: LiteratureSourceLocation[]
}

export interface LiteratureSearchPage {
  source: LiteratureSource
  papers: LiteraturePaper[]
  nextCursor?: string
  total?: number
  providerRequestId?: string
  providerVersion?: string
}

export interface SciverseEvidenceHit {
  source: 'sciverse'
  documentId: string
  chunkId: string
  uniqueId?: string
  title: string
  authors: string[]
  abstract?: string
  chunk: string
  score: number
  offset: number
  offsetUnit: 'utf8_byte'
  page?: number
  sourceType?: string
  venue?: string
  publishedYear?: number
}

export interface SciverseEvidenceSearchResult {
  source: 'sciverse'
  hits: SciverseEvidenceHit[]
  providerRequestId?: string
  providerVersion?: string
}

export interface SciversePaperRelation {
  id: string
  idType?: string
  title: string
}

export interface SciversePaperRelationsResult {
  source: 'sciverse'
  uniqueId: string
  relation: SciversePaperRelationKind
  items: SciversePaperRelation[]
  totalCount: number
  page: number
  pageSize: number
  totalPages?: number
  providerRequestId?: string
  providerVersion?: string
}

export interface LiteratureFetchRequest {
  sourceId: string
  version?: string
}

export interface FetchedPdfContent {
  kind: 'pdf'
  buffer: Buffer
  mimeType: 'application/pdf'
  filename: string
  canonicalUrl: string
}

export interface FetchedFullTextContent {
  kind: 'fulltext'
  text: string
  mimeType: 'text/markdown'
  filename: string
  canonicalUrl?: string
}

export type FetchedLiteratureContent = FetchedPdfContent | FetchedFullTextContent

export interface FetchedLiteraturePaper {
  source: LiteratureSource
  paper: LiteraturePaper
  content: FetchedLiteratureContent
  retrievedAt: string
  providerVersion?: string
}

export interface LiteratureProviderContext {
  signal?: AbortSignal
}

/**
 * Pure source adapter. Providers perform remote I/O and normalization only;
 * they never write a Workspace or mutate research/orchestration state.
 */
export interface LiteratureProvider {
  readonly source: LiteratureSource
  searchPapers(
    request: LiteraturePaperSearchRequest,
    context?: LiteratureProviderContext,
  ): Promise<LiteratureSearchPage>
  searchEvidence?(
    request: SciverseEvidenceSearchRequest,
    context?: LiteratureProviderContext,
  ): Promise<SciverseEvidenceSearchResult>
  listPaperRelations?(
    request: SciversePaperRelationsRequest,
    context?: LiteratureProviderContext,
  ): Promise<SciversePaperRelationsResult>
  fetchPaper(
    request: LiteratureFetchRequest,
    context?: LiteratureProviderContext,
  ): Promise<FetchedLiteraturePaper>
}

export type LiteratureProviderRegistry = ReadonlyMap<LiteratureSource, LiteratureProvider>

export type LiteratureAuditOperation = 'search_papers' | 'search_evidence' | 'list_relations'

export type LiteratureAuditedRequest =
  | LiteraturePaperSearchRequest
  | SciverseEvidenceSearchRequest
  | SciversePaperRelationsRequest

export type LiteratureAuditedResult =
  | LiteratureSearchPage
  | SciverseEvidenceSearchResult
  | SciversePaperRelationsResult

export interface LiteratureSearchAuditRecord {
  schemaVersion: 2
  searchId: string
  operation: LiteratureAuditOperation
  source: LiteratureSource
  status: 'success' | 'error'
  request: LiteratureAuditedRequest
  retrievedAt: string
  completedAt: string
  result?: LiteratureAuditedResult
  error?: { name: string; message: string }
}

export interface LiteratureSearchReceipt {
  searchId: string
  recordPath: string
  page: LiteratureSearchPage
}

export interface SciverseEvidenceSearchReceipt {
  searchId: string
  recordPath: string
  result: SciverseEvidenceSearchResult
}

export interface SciversePaperRelationsReceipt {
  searchId: string
  recordPath: string
  result: SciversePaperRelationsResult
}

export interface FetchPaperRequest {
  source: LiteratureSource
  sourceId: string
  version?: string
  searchRecordPath?: string
}

export interface FetchPaperReceipt {
  source: LiteratureSource
  sourceId: string
  directory: string
  metadataPath: string
  provenancePath: string
  /** Immutable provider artifact: original.pdf for arXiv, provider Markdown for Sciverse. */
  sourceContentPath: string
  /** Agent-readable full text. For Sciverse this is the provider artifact itself. */
  fullTextPath: string
  blocksPath?: string
  parserProvenancePath?: string
  textOrigin: 'provider' | 'local_parser'
  parser?: {
    name: string
    version: string
  }
  fullText: string
  fullTextChars: number
  alreadyPresent: boolean
  /** Source PDF/full-text bytes transferred by this invocation; cache reuse is zero. */
  downloadBytes: number
}

export interface SearchDocumentRequest {
  query: string
  documentPaths?: string[]
  caseSensitive?: boolean
  maxResults?: number
  contextChars?: number
}

export interface DocumentSearchHit {
  path: string
  blockId?: string
  page?: number
  section?: string
  bbox?: number[]
  line?: number
  quote: string
}

export interface DocumentSearchResult {
  query: string
  searchedPaths: string[]
  hits: DocumentSearchHit[]
  truncated: boolean
}

export interface LiteratureToolRuntime {
  workspace: WorkspaceInstance
  providers?: LiteratureProviderRegistry
  /** Internal implementation detail used by source-specific fetch tools. */
  pdfParser?: PdfParserPort
  signal?: AbortSignal
  now?: () => Date
  randomId?: () => string
}
