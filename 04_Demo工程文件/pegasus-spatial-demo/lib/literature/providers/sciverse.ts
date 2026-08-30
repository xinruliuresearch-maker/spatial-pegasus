import { randomUUID } from 'node:crypto'
import {
  boundedText,
  fetchWithTimeout,
  readResponseText,
  type FetchImplementation,
} from '../http'
import type {
  FetchedLiteraturePaper,
  LiteratureFetchRequest,
  LiteraturePaper,
  LiteraturePaperSearchRequest,
  LiteratureProvider,
  LiteratureProviderContext,
  LiteratureSearchPage,
  SciverseEvidenceHit,
  SciverseEvidenceSearchRequest,
  SciverseEvidenceSearchResult,
  SciversePaperRelation,
  SciversePaperRelationsRequest,
  SciversePaperRelationsResult,
} from '../types'

const DEFAULT_BASE_URL = 'https://api.sciverse.space'
const DEFAULT_RESPONSE_LIMIT = 8 * 1024 * 1024
const DEFAULT_FULLTEXT_LIMIT_CHARS = 8_000_000
const DEFAULT_PAGE_SIZE = 8_192
const DEFAULT_MAX_PAGES = 200
const DEFAULT_TIMEOUT_MS = 60_000
const PROVIDER_VERSION = 'sciverse-rest-v1'

export interface SciverseProviderOptions {
  token?: string
  fetchImpl?: FetchImplementation
  baseUrl?: string
  responseLimitBytes?: number
  fullTextLimitChars?: number
  contentPageSize?: number
  maxContentPages?: number
  timeoutMs?: number
  now?: () => Date
  requestId?: () => string
}

export class SciverseLiteratureProvider implements LiteratureProvider {
  readonly source = 'sciverse' as const
  private readonly token?: string
  private readonly fetchImpl: FetchImplementation
  private readonly baseUrl: string
  private readonly responseLimitBytes: number
  private readonly fullTextLimitChars: number
  private readonly contentPageSize: number
  private readonly maxContentPages: number
  private readonly timeoutMs: number
  private readonly now: () => Date
  private readonly requestId: () => string

  constructor(options: SciverseProviderOptions = {}) {
    this.token = options.token === undefined
      ? process.env.SCIVERSE_API_TOKEN?.trim() || undefined
      : options.token.trim() || undefined
    this.fetchImpl = options.fetchImpl ?? fetch
    this.baseUrl = (
      options.baseUrl?.trim()
      || process.env.SCIVERSE_API_BASE_URL?.trim()
      || process.env.SCIVERSE_BASE_URL?.trim()
      || DEFAULT_BASE_URL
    ).replace(/\/+$/, '')
    this.responseLimitBytes = options.responseLimitBytes ?? DEFAULT_RESPONSE_LIMIT
    this.fullTextLimitChars = options.fullTextLimitChars ?? DEFAULT_FULLTEXT_LIMIT_CHARS
    this.contentPageSize = options.contentPageSize ?? DEFAULT_PAGE_SIZE
    this.maxContentPages = options.maxContentPages ?? DEFAULT_MAX_PAGES
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.now = options.now ?? (() => new Date())
    this.requestId = options.requestId ?? (() => randomUUID())
  }

  async searchPapers(
    request: LiteraturePaperSearchRequest,
    context: LiteratureProviderContext = {},
  ): Promise<LiteratureSearchPage> {
    this.assertConfigured()
    if (request.source !== 'sciverse') {
      throw new Error(`Sciverse provider cannot search source: ${request.source}`)
    }

    const response = await this.request('/meta-search', {
      method: 'POST',
      body: JSON.stringify(buildSciversePaperSearchPayload(request)),
    }, context.signal)
    const payload = await this.readJsonResponse(response, 'Sciverse paper search', context.signal)
    const body = responseBody(payload)

    return {
      source: this.source,
      papers: normalizeSciversePaperResults(body),
      total: nonNegativeInteger(body.total_count) ?? undefined,
      nextCursor: stringValue(body.next_cursor),
      providerRequestId: providerRequestId(response, payload),
      providerVersion: response.headers.get('x-api-version') ?? PROVIDER_VERSION,
    }
  }

  async searchEvidence(
    request: SciverseEvidenceSearchRequest,
    context: LiteratureProviderContext = {},
  ): Promise<SciverseEvidenceSearchResult> {
    this.assertConfigured()
    if (request.source !== 'sciverse') {
      throw new Error(`Sciverse provider cannot search evidence for source: ${request.source}`)
    }

    const response = await this.request('/agentic-search', {
      method: 'POST',
      body: JSON.stringify(buildSciverseEvidenceSearchPayload(request)),
    }, context.signal)
    const payload = await this.readJsonResponse(response, 'Sciverse evidence search', context.signal)

    return {
      source: this.source,
      hits: normalizeSciverseEvidenceHits(responseBody(payload)),
      providerRequestId: providerRequestId(response, payload),
      providerVersion: response.headers.get('x-api-version') ?? PROVIDER_VERSION,
    }
  }

  async listPaperRelations(
    request: SciversePaperRelationsRequest,
    context: LiteratureProviderContext = {},
  ): Promise<SciversePaperRelationsResult> {
    this.assertConfigured()
    if (request.source !== 'sciverse') {
      throw new Error(`Sciverse provider cannot list relations for source: ${request.source}`)
    }
    const uniqueId = normalizeSciverseUniqueId(request.uniqueId)
    const response = await this.request('/meta-paper-relations', {
      method: 'POST',
      body: JSON.stringify({
        unique_id: uniqueId,
        relation: request.relation,
        page: request.page,
        page_size: request.pageSize,
      }),
    }, context.signal)
    const payload = await this.readJsonResponse(response, 'Sciverse paper relations', context.signal)
    const body = responseBody(payload)
    const items = normalizeSciversePaperRelations(body.items)

    return {
      source: this.source,
      uniqueId,
      relation: request.relation,
      items,
      totalCount: nonNegativeInteger(body.total_count) ?? items.length,
      page: positiveInteger(body.page) ?? request.page,
      pageSize: positiveInteger(body.page_size) ?? request.pageSize,
      totalPages: nonNegativeInteger(body.total_pages) ?? undefined,
      providerRequestId: providerRequestId(response, payload),
      providerVersion: response.headers.get('x-api-version') ?? PROVIDER_VERSION,
    }
  }

  async fetchPaper(
    request: LiteratureFetchRequest,
    context: LiteratureProviderContext = {},
  ): Promise<FetchedLiteraturePaper> {
    this.assertConfigured()
    const docId = normalizeSciverseDocumentId(request.sourceId)
    let offset = 0
    let pageCount = 0
    let text = ''
    let metadata: Record<string, unknown> | undefined
    let more = true
    let providerVersion = PROVIDER_VERSION

    while (pageCount < this.maxContentPages && more) {
      const url = new URL('/content', `${this.baseUrl}/`)
      url.searchParams.set('doc_id', docId)
      url.searchParams.set('offset', String(offset))
      url.searchParams.set('limit', String(this.contentPageSize))
      const response = await this.request(url.pathname + url.search, { method: 'GET' }, context.signal)
      const payload = await this.readJsonResponse(response, 'Sciverse content', context.signal)
      const page = normalizeSciverseContentPage(payload)
      providerVersion = response.headers.get('x-api-version') ?? providerVersion
      metadata ??= page.metadata

      // `offset` is a provider-owned UTF-8 byte offset. Preserve the provider
      // chunks byte-for-byte at the string level: inserting separators here
      // would invalidate evidence locators returned by agentic-search.
      text += page.text
      if (text.length > this.fullTextLimitChars) {
        throw new Error(`Sciverse full text exceeds ${this.fullTextLimitChars} character limit`)
      }

      pageCount += 1
      more = page.more
      if (!more) break
      if (page.nextOffset === undefined || page.nextOffset <= offset) {
        throw new Error('Sciverse content pagination did not advance')
      }
      // Never derive this value from bytes_returned, chars_returned, or text.length.
      offset = page.nextOffset
    }
    if (more) {
      throw new Error(`Sciverse content exceeded ${this.maxContentPages} page limit`)
    }
    if (!text.trim()) throw new Error(`Sciverse returned no full text for ${docId}`)

    const paper = normalizeSciversePaper(
      metadata ?? {},
      docId,
      stringValue(metadata?.unique_id),
      docId,
    )
    return {
      source: this.source,
      paper,
      content: {
        kind: 'fulltext',
        text,
        mimeType: 'text/markdown',
        filename: 'source-fulltext.md',
        canonicalUrl: paper.landingUrl,
      },
      retrievedAt: this.now().toISOString(),
      providerVersion,
    }
  }

  private assertConfigured(): void {
    if (!this.token) {
      throw new Error('Sciverse is unavailable: SCIVERSE_API_TOKEN is not configured')
    }
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    return fetchWithTimeout(
      this.fetchImpl,
      `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`,
      {
        ...init,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
          'X-Request-Id': this.requestId(),
          'X-Sciverse-Source': 'pegasus-spatial-direct',
          ...(init.headers ?? {}),
        },
      },
      this.timeoutMs,
      signal,
    )
  }

  private async readJsonResponse(
    response: Response,
    label: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const text = await readResponseText(response, this.responseLimitBytes, signal)
    if (!response.ok) {
      const detail = errorDetail(text)
      throw new Error(`${label} failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
    }
    return parseJson(text, label)
  }
}

function buildSciversePaperSearchPayload(
  request: Extract<LiteraturePaperSearchRequest, { source: 'sciverse' }>,
): Record<string, unknown> {
  const filters: Array<{ field: string; operator: string; value: unknown }> = []
  const sort: Array<{ field: string; order: string }> = []
  const addFilter = (field: string, operator: string, value: unknown) => {
    filters.push({ field, operator, value })
  }

  if (request.titleContains !== undefined) {
    addFilter('title', 'FILTER_OP_CONTAINS', request.titleContains)
  }
  if (request.abstractContains !== undefined) {
    addFilter('abstract', 'FILTER_OP_CONTAINS', request.abstractContains)
  }
  if (request.authors?.length) {
    addFilter('author', 'FILTER_OP_IN', request.authors)
  }
  if (request.yearFrom !== undefined) {
    addFilter('publication_published_year', 'FILTER_OP_GTE', request.yearFrom)
  }
  if (request.yearTo !== undefined) {
    addFilter('publication_published_year', 'FILTER_OP_LTE', request.yearTo)
  }
  if (request.journals?.length) {
    addFilter('publication_venue_name_unified', 'FILTER_OP_IN', request.journals)
  }
  if (request.subjects?.length) {
    addFilter('subjects', 'FILTER_OP_IN', request.subjects)
  }
  for (const filter of request.filtersAdvanced ?? []) {
    addFilter(filter.field, filter.operator ?? 'FILTER_OP_EQ', filter.value)
  }

  if (request.sortByYear !== 'none') {
    sort.push({
      field: 'publication_published_year',
      order: request.sortByYear === 'asc' ? 'SORT_ORDER_ASC' : 'SORT_ORDER_DESC',
    })
  }
  for (const item of request.sortAdvanced ?? []) {
    sort.push({ field: item.field, order: item.order })
  }

  const query = request.query?.trim()
  return compactObject({
    query: query || undefined,
    page: request.page,
    page_size: request.pageSize,
    cursor: request.cursor,
    freshness_boost: request.freshnessBoost,
    impact_boost: request.impactBoost,
    language_affinity: request.languageAffinity,
    filters: filters.length > 0 ? filters : undefined,
    sort: sort.length > 0 ? sort : undefined,
  })
}

function buildSciverseEvidenceSearchPayload(
  request: SciverseEvidenceSearchRequest,
): Record<string, unknown> {
  const mode = request.mode === 'fast'
    ? { retrieval: 'es' }
    : request.mode === 'quality'
      ? { retrieval: 'hybrid', sub_queries: 3 }
      : { retrieval: 'hybrid' }

  return compactObject({
    ...mode,
    query: request.query,
    top_k: request.topK,
    source_types: request.sourceTypes,
    filters: request.filters,
  })
}

export function normalizeSciverseDocumentId(value: string): string {
  const normalized = value.trim()
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error('Invalid Sciverse doc_id: expected a 64-character lowercase SHA-256')
  }
  return normalized
}

export function normalizeSciverseUniqueId(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 1_024 || /\p{Cc}/u.test(normalized)) {
    throw new Error('Invalid Sciverse unique identifier')
  }
  return normalized
}

export function normalizeSciversePaperResults(payload: unknown): LiteraturePaper[] {
  const root = recordValue(payload)
  const results = Array.isArray(root?.results) ? root.results : []
  return results.flatMap(value => {
    const record = recordValue(value)
    if (!record) return []
    const uniqueId = stringValue(record.unique_id)
    if (!uniqueId) return []
    const rawDocId = stringValue(record.doc_id)
    try {
      const normalizedUniqueId = normalizeSciverseUniqueId(uniqueId)
      const docId = rawDocId ? normalizeSciverseDocumentId(rawDocId) : undefined
      return [normalizeSciversePaper(record, docId ?? normalizedUniqueId, normalizedUniqueId, docId)]
    } catch {
      return []
    }
  })
}

/** Compatibility export for callers that normalize semantic hit papers directly. */
export function normalizeSciverseHits(payload: unknown): LiteraturePaper[] {
  const root = recordValue(payload)
  const hits = Array.isArray(root?.hits) ? root.hits : []
  return hits.flatMap(value => {
    const record = recordValue(value)
    if (!record) return []
    const rawDocId = stringValue(record.doc_id)
    if (!rawDocId) return []
    try {
      const docId = normalizeSciverseDocumentId(rawDocId)
      const uniqueId = stringValue(record.unique_id)
      return [normalizeSciversePaper(record, docId, uniqueId, docId)]
    } catch {
      return []
    }
  })
}

export function normalizeSciverseEvidenceHits(payload: unknown): SciverseEvidenceHit[] {
  const root = recordValue(payload)
  const hits = Array.isArray(root?.hits) ? root.hits : []
  return hits.flatMap(value => {
    const record = recordValue(value)
    if (!record) return []
    const rawDocId = stringValue(record.doc_id)
    const chunkId = stringValue(record.chunk_id)
    const title = boundedText(record.title, 2_000)
    const chunk = typeof record.chunk === 'string' ? record.chunk : undefined
    const score = numberValue(record.score)
    const offset = nonNegativeInteger(record.offset)
    if (!rawDocId || !chunkId || !title || !chunk?.trim() || score === undefined || offset === undefined) {
      return []
    }
    try {
      return [{
        source: 'sciverse' as const,
        documentId: normalizeSciverseDocumentId(rawDocId),
        chunkId,
        uniqueId: stringValue(record.unique_id),
        title,
        authors: normalizeAuthors(record.author ?? record.authors),
        abstract: boundedText(record.abstract, 12_000),
        chunk,
        score,
        offset,
        offsetUnit: 'utf8_byte' as const,
        page: nonNegativeInteger(record.page_no) ?? undefined,
        sourceType: stringValue(record.source_type),
        venue: firstString(record, ['publication_venue_name_unified', 'venue']),
        publishedYear: nonNegativeInteger(record.publication_published_year) ?? undefined,
      }]
    } catch {
      return []
    }
  })
}

export function normalizeSciversePaperRelations(value: unknown): SciversePaperRelation[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const record = recordValue(item)
    if (!record) return []
    const id = boundedText(record.id, 1_024)
    const title = boundedText(record.title, 2_000)
    if (!id || !title) return []
    return [{ id, idType: boundedText(record.id_type, 100), title }]
  })
}

export function normalizeSciverseContentPage(payload: unknown): {
  text: string
  nextOffset?: number
  more: boolean
  returnedLength?: number
  metadata?: Record<string, unknown>
} {
  const root = recordValue(payload)
  if (!root) throw new Error('Sciverse content returned an invalid object')
  const body = responseBody(root)
  if (typeof body.text !== 'string') {
    throw new Error('Sciverse content response omitted text')
  }
  if (typeof body.more !== 'boolean') {
    throw new Error('Sciverse content response omitted pagination state')
  }

  const nextOffset = nonNegativeInteger(body.next_offset)
  if (body.more && nextOffset === undefined) {
    throw new Error('Sciverse content response omitted next_offset')
  }

  const hasBytesReturned = Object.hasOwn(body, 'bytes_returned')
  const hasCharsReturned = Object.hasOwn(body, 'chars_returned')
  const returnedLength = nonNegativeInteger(
    hasBytesReturned ? body.bytes_returned : body.chars_returned,
  )
  if ((hasBytesReturned || hasCharsReturned) && returnedLength === undefined) {
    throw new Error('Sciverse content returned an invalid byte/character count')
  }

  return {
    text: body.text,
    nextOffset,
    more: body.more,
    returnedLength,
    metadata: recordValue(body.metadata) ?? recordValue(root.metadata) ?? undefined,
  }
}

function normalizeSciversePaper(
  record: Record<string, unknown>,
  sourceId: string,
  uniqueId?: string,
  documentId?: string,
): LiteraturePaper {
  const publishedYear = nonNegativeInteger(record.publication_published_year)
  const publishedDate = firstString(record, [
    'publication_published_date',
    'published_at',
    'publication_date',
    'published',
    'date',
  ])
  const license = firstString(record, [
    'access_license',
    'license',
    'license_name',
    'license_type',
  ])
  const licenseUrl = firstString(record, [
    'access_license_url',
    'license_url',
    'licenseUrl',
  ])
  const categories = mergeStringArrays(record.subjects, record.categories, record.keywords)
  const contentAccessible = booleanValue(record.is_content_accessible)

  return {
    ref: {
      source: 'sciverse',
      sourceId,
      uniqueId,
      documentId,
      version: firstString(record, ['version', 'revision']),
    },
    title: boundedText(firstString(record, ['title', 'paper_title']) ?? `Sciverse document ${sourceId}`, 2_000)
      ?? `Sciverse document ${sourceId}`,
    authors: normalizeAuthors(record.author ?? record.authors),
    abstract: boundedText(firstString(record, ['abstract', 'summary']), 12_000),
    publishedAt: normalizeDate(publishedDate),
    updatedAt: normalizeDate(firstString(record, ['updated_at', 'updated'])),
    categories,
    doi: firstString(record, ['doi']),
    landingUrl: firstString(record, [
      'landing_url',
      'publication_landing_page_url',
      'primary_location_landing_page_url',
      'source_url',
      'url',
    ]),
    documentUrl: firstString(record, [
      'access_oa_url',
      'document_url',
      'pdf_url',
      'fulltext_url',
    ]),
    license,
    licenseUrl,
    contentAccessible,
    venue: firstString(record, ['publication_venue_name_unified', 'venue']),
    publishedYear,
    citationCount: nonNegativeInteger(record.citation_count) ?? undefined,
    influentialCitationCount: nonNegativeInteger(record.influential_citation_count) ?? undefined,
    sourceLocations: normalizeLocations(record),
  }
}

function normalizeLocations(record: Record<string, unknown>) {
  const chunk = typeof record.chunk === 'string' ? record.chunk : undefined
  if (!chunk?.trim()) return undefined
  const offset = nonNegativeInteger(record.offset)
  const page = nonNegativeInteger(record.page_no)
  return [{
    page: page ?? undefined,
    quote: boundedText(chunk, 4_000),
    score: numberValue(record.score),
    locator: offset === undefined ? undefined : `utf8-byte:${offset}`,
  }]
}

function normalizeAuthors(value: unknown): string[] {
  const authors = Array.isArray(value)
    ? value.map(authorName).filter((author): author is string => !!author)
    : typeof value === 'string'
      ? value.split(/\s*;\s*/).map(author => author.trim()).filter(Boolean)
      : []
  return [...new Set(authors)]
}

function mergeStringArrays(...values: unknown[]): string[] | undefined {
  const merged = values.flatMap(value => stringArray(value) ?? [])
  return merged.length > 0 ? [...new Set(merged)] : undefined
}

function responseBody(payload: unknown): Record<string, unknown> {
  const root = recordValue(payload)
  if (!root) throw new Error('Sciverse returned an invalid response object')
  return recordValue(root.data) ?? root
}

function providerRequestId(response: Response, payload: unknown): string | undefined {
  const root = recordValue(payload)
  const body = root ? recordValue(root.data) : null
  return response.headers.get('x-request-id')
    ?? stringValue(root?.request_id)
    ?? stringValue(body?.request_id)
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

function errorDetail(text: string): string | undefined {
  if (!text.trim()) return undefined
  try {
    const parsed = recordValue(JSON.parse(text))
    const body = parsed ? recordValue(parsed.data) ?? parsed : null
    return boundedText(
      firstString(body ?? {}, ['message', 'detail', 'error_description', 'error']) ?? text,
      1_000,
    )
  } catch {
    return boundedText(text, 1_000)
  }
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} returned invalid JSON`)
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function firstString(record: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const value = stringValue(record[name])
    if (value) return value
  }
  return undefined
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(number) ? number : undefined
}

function nonNegativeInteger(value: unknown): number | undefined {
  const number = numberValue(value)
  return number !== undefined && Number.isSafeInteger(number) && number >= 0 ? number : undefined
}

function positiveInteger(value: unknown): number | undefined {
  const number = nonNegativeInteger(value)
  return number !== undefined && number > 0 ? number : undefined
}

function stringArray(value: unknown): string[] | undefined {
  const values = Array.isArray(value)
    ? value.map(item => typeof item === 'string' ? item.trim() : '').filter(Boolean)
    : typeof value === 'string'
      ? value.split(/[,;]\s*/).map(item => item.trim()).filter(Boolean)
      : []
  return values.length > 0 ? [...new Set(values)] : undefined
}

function authorName(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  const record = recordValue(value)
  return record ? firstString(record, ['name', 'full_name', 'display_name']) : undefined
}

function normalizeDate(value?: string): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : value.slice(0, 100)
}
