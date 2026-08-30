import {
  abortableDelay,
  boundedText,
  fetchWithTimeout,
  readResponseBuffer,
  readResponseText,
  retryAfterMilliseconds,
  type FetchImplementation,
} from '../http'
import type {
  ArxivPaperSearchRequest,
  FetchedLiteraturePaper,
  LiteraturePaper,
  LiteraturePaperSearchRequest,
  LiteratureProvider,
  LiteratureProviderContext,
  LiteratureSearchPage,
  LiteratureFetchRequest,
} from '../types'

const DEFAULT_API_BASE = 'https://export.arxiv.org/api/query'
const DEFAULT_PDF_BASE = 'https://arxiv.org/pdf/'
const DEFAULT_SEARCH_RESPONSE_LIMIT = 5 * 1024 * 1024
const DEFAULT_PDF_LIMIT = 64 * 1024 * 1024
const DEFAULT_INTERVAL_MS = 3_000
const DEFAULT_TIMEOUT_MS = 45_000
const MAX_RETRY_AFTER_MS = 30_000

const ARXIV_ID = /^(?:\d{4}\.\d{4,5}|[a-z][a-z0-9.-]*\/\d{7})(?:v\d+)?$/i

class RequestGate {
  private tail: Promise<void> = Promise.resolve()
  private nextRequestAt = 0

  constructor(private readonly intervalMs: number) {}

  async wait(signal?: AbortSignal): Promise<void> {
    let release!: () => void
    const previous = this.tail
    this.tail = new Promise(resolve => { release = resolve })
    await previous
    try {
      await abortableDelay(Math.max(0, this.nextRequestAt - Date.now()), signal)
      this.nextRequestAt = Date.now() + this.intervalMs
    } finally {
      release()
    }
  }
}

const sharedGate = new RequestGate(DEFAULT_INTERVAL_MS)

export interface ArxivProviderOptions {
  fetchImpl?: FetchImplementation
  apiBase?: string
  pdfBase?: string
  userAgent?: string
  requestIntervalMs?: number
  searchResponseLimitBytes?: number
  pdfLimitBytes?: number
  timeoutMs?: number
  gate?: { wait(signal?: AbortSignal): Promise<void> }
  now?: () => Date
}

export class ArxivLiteratureProvider implements LiteratureProvider {
  readonly source = 'arxiv' as const
  private readonly fetchImpl: FetchImplementation
  private readonly apiBase: string
  private readonly pdfBase: string
  private readonly userAgent: string
  private readonly searchResponseLimitBytes: number
  private readonly pdfLimitBytes: number
  private readonly timeoutMs: number
  private readonly gate: { wait(signal?: AbortSignal): Promise<void> }
  private readonly now: () => Date

  constructor(options: ArxivProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.apiBase = firstNonEmpty(options.apiBase, process.env.ARXIV_API_BASE_URL, DEFAULT_API_BASE)
    this.pdfBase = firstNonEmpty(options.pdfBase, process.env.ARXIV_PDF_BASE_URL, DEFAULT_PDF_BASE)
    this.userAgent = firstNonEmpty(
      options.userAgent,
      process.env.ARXIV_USER_AGENT,
      'Pegasus-Spatial/0.1 (materials-literature compatibility tool)',
    )
    this.searchResponseLimitBytes = options.searchResponseLimitBytes ?? DEFAULT_SEARCH_RESPONSE_LIMIT
    this.pdfLimitBytes = options.pdfLimitBytes ?? DEFAULT_PDF_LIMIT
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.gate = options.gate
      ?? (options.requestIntervalMs === undefined || options.requestIntervalMs === DEFAULT_INTERVAL_MS
        ? sharedGate
        : new RequestGate(options.requestIntervalMs))
    this.now = options.now ?? (() => new Date())
  }

  async searchPapers(
    request: LiteraturePaperSearchRequest,
    context: LiteratureProviderContext = {},
  ): Promise<LiteratureSearchPage> {
    if (request.source !== this.source) {
      throw new Error(`arXiv provider cannot search source: ${request.source}`)
    }
    const start = parseCursor(request.cursor)
    const url = new URL(this.apiBase)
    url.searchParams.set('search_query', buildArxivQuery(request.query, request.filters))
    url.searchParams.set('start', String(start))
    url.searchParams.set('max_results', String(request.limit))
    const { sortBy, sortOrder } = arxivSort(request.sort)
    url.searchParams.set('sortBy', sortBy)
    url.searchParams.set('sortOrder', sortOrder)

    const response = await this.request(url, { method: 'GET' }, context.signal)
    if (!response.ok) throw new Error(`arXiv search failed with HTTP ${response.status}`)
    const xml = await readResponseText(response, this.searchResponseLimitBytes, context.signal)
    const parsed = parseArxivAtomFeed(xml)
    return {
      source: this.source,
      papers: parsed.papers,
      total: parsed.total,
      nextCursor: start + parsed.papers.length < parsed.total
        ? String(start + parsed.papers.length)
        : undefined,
      providerRequestId: response.headers.get('x-request-id') ?? undefined,
      providerVersion: 'arxiv-atom-v1',
    }
  }

  async fetchPaper(
    request: LiteratureFetchRequest,
    context: LiteratureProviderContext = {},
  ): Promise<FetchedLiteraturePaper> {
    const sourceId = normalizeArxivId(request.version
      ? `${stripArxivVersion(request.sourceId)}${request.version.startsWith('v') ? request.version : `v${request.version}`}`
      : request.sourceId)
    const metadata = await this.fetchMetadata(sourceId, context.signal)
    const resolvedSourceId = normalizeArxivId(metadata.ref.sourceId)
    const pdfUrl = new URL(encodeURI(resolvedSourceId), ensureTrailingSlash(this.pdfBase))
    const response = await this.requestPdfFollowingTrustedRedirects(pdfUrl, context.signal)
    if (!response.ok) throw new Error(`arXiv PDF fetch failed with HTTP ${response.status}`)
    assertAllowedPdfUrl(response.url || pdfUrl.toString(), this.pdfBase)
    const buffer = await readResponseBuffer(response, this.pdfLimitBytes, context.signal)
    if (!isPdf(buffer)) throw new Error('arXiv response is not a valid PDF payload')

    return {
      source: this.source,
      paper: {
        ...metadata,
        documentUrl: response.url || pdfUrl.toString(),
      },
      content: {
        kind: 'pdf',
        buffer,
        mimeType: 'application/pdf',
        filename: `${safeArxivFilename(resolvedSourceId)}.pdf`,
        canonicalUrl: response.url || pdfUrl.toString(),
      },
      retrievedAt: this.now().toISOString(),
      providerVersion: 'arxiv-atom-v1',
    }
  }

  private async fetchMetadata(sourceId: string, signal?: AbortSignal): Promise<LiteraturePaper> {
    const url = new URL(this.apiBase)
    url.searchParams.set('id_list', sourceId)
    url.searchParams.set('start', '0')
    url.searchParams.set('max_results', '1')
    const response = await this.request(url, { method: 'GET' }, signal)
    if (!response.ok) throw new Error(`arXiv metadata fetch failed with HTTP ${response.status}`)
    const parsed = parseArxivAtomFeed(
      await readResponseText(response, this.searchResponseLimitBytes, signal),
    )
    const paper = parsed.papers[0]
    if (!paper) throw new Error(`arXiv paper not found: ${sourceId}`)
    const returnedId = normalizeArxivId(paper.ref.sourceId)
    if (!matchesRequestedArxivId(sourceId, returnedId)) {
      throw new Error(
        `arXiv metadata identifier mismatch: requested ${sourceId}, received ${returnedId}`,
      )
    }
    return paper
  }

  private async request(url: URL, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.gate.wait(signal)
      const response = await fetchWithTimeout(
        this.fetchImpl,
        url,
        {
          ...init,
          headers: {
            Accept: init.method === 'GET' && url.pathname.endsWith('/query')
              ? 'application/atom+xml'
              : 'application/pdf',
            'User-Agent': this.userAgent,
            ...(init.headers ?? {}),
          },
        },
        this.timeoutMs,
        signal,
      )
      if (response.status !== 429 || attempt > 0) return response
      const retry = Math.min(
        MAX_RETRY_AFTER_MS,
        retryAfterMilliseconds(response) ?? DEFAULT_INTERVAL_MS,
      )
      await response.body?.cancel().catch(() => undefined)
      await abortableDelay(retry, signal)
    }
    throw new Error('arXiv request retry exhausted')
  }

  private async requestPdfFollowingTrustedRedirects(
    initialUrl: URL,
    signal?: AbortSignal,
  ): Promise<Response> {
    let current = initialUrl
    for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
      assertAllowedPdfUrl(current.toString(), this.pdfBase)
      const response = await this.request(current, { method: 'GET', redirect: 'manual' }, signal)
      if (response.status < 300 || response.status >= 400) return response
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => undefined)
      if (!location) throw new Error('arXiv PDF redirect omitted Location header')
      current = new URL(location, current)
    }
    throw new Error('arXiv PDF exceeded trusted redirect limit')
  }
}

export function normalizeArxivId(value: string): string {
  let candidate = value.trim()
  candidate = candidate.replace(/^arxiv:/i, '')
  const urlMatch = candidate.match(/^https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf)\/(.+?)(?:\.pdf)?$/i)
  if (urlMatch) candidate = decodeURIComponent(urlMatch[1])
  candidate = candidate.replace(/\.pdf$/i, '')
  if (!ARXIV_ID.test(candidate)) throw new Error(`Invalid arXiv identifier: ${value}`)
  return candidate
}

export function stripArxivVersion(value: string): string {
  return normalizeArxivId(value).replace(/v\d+$/i, '')
}

export function parseArxivAtomFeed(xml: string): { papers: LiteraturePaper[]; total: number } {
  const totalText = tagText(xml, 'opensearch:totalResults') ?? tagText(xml, 'totalResults')
  const papers: LiteraturePaper[] = []
  const entryPattern = /<(?:[A-Za-z0-9_-]+:)?entry\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?entry>/gi
  for (const match of xml.matchAll(entryPattern)) {
    const entry = match[1]
    const rawId = tagText(entry, 'id')
    const rawTitle = tagText(entry, 'title')
    if (!rawId || !rawTitle) continue
    let sourceId: string
    try {
      sourceId = normalizeArxivId(rawId)
    } catch {
      continue
    }
    const links = parseLinks(entry)
    const authors = [...entry.matchAll(/<(?:[A-Za-z0-9_-]+:)?author\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?author>/gi)]
      .map(author => tagText(author[1], 'name'))
      .filter((author): author is string => !!author)
    const categories = [...entry.matchAll(/<(?:[A-Za-z0-9_-]+:)?category\b([^>]*)\/?\s*>/gi)]
      .map(category => attribute(category[1], 'term'))
      .filter((category): category is string => !!category)
    const doi = tagText(entry, 'arxiv:doi') ?? tagText(entry, 'doi')
    const licenseUrl = tagText(entry, 'arxiv:license') ?? tagText(entry, 'license')
    papers.push({
      ref: {
        source: 'arxiv',
        sourceId,
        version: sourceId.match(/v\d+$/i)?.[0],
      },
      title: normalizeXmlText(rawTitle),
      authors,
      abstract: boundedText(normalizeXmlText(tagText(entry, 'summary') ?? ''), 12_000),
      publishedAt: normalizeIsoDate(tagText(entry, 'published')),
      updatedAt: normalizeIsoDate(tagText(entry, 'updated')),
      categories: categories.length > 0 ? [...new Set(categories)] : undefined,
      doi: doi ? normalizeXmlText(doi) : undefined,
      landingUrl: links.alternate ?? `https://arxiv.org/abs/${sourceId}`,
      documentUrl: links.pdf ?? `https://arxiv.org/pdf/${sourceId}`,
      license: licenseUrl ? licenseLabel(licenseUrl) : undefined,
      licenseUrl,
    })
  }
  const total = totalText === undefined ? papers.length : Number(totalText)
  return { papers, total: Number.isFinite(total) && total >= 0 ? total : papers.length }
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    const normalized = value?.trim()
    if (normalized) return normalized
  }
  throw new Error('Expected at least one non-empty value')
}

function buildArxivQuery(
  query: string,
  filters?: ArxivPaperSearchRequest['filters'],
): string {
  const normalized = query.replace(/[\r\n]+/g, ' ').trim()
  if (!normalized) throw new Error('arXiv query cannot be empty')
  const parts = [`all:"${normalized.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim()}"`]
  const authors = (filters?.authors ?? [])
    .map(author => author.replace(/["\\]/g, ' ').trim())
    .filter(Boolean)
    .map(author => `au:"${author}"`)
  if (authors.length > 0) parts.push(`(${authors.join(' OR ')})`)

  const categories = (filters?.categories ?? [])
    .map(category => category.replace(/[^A-Za-z0-9.-]/g, ''))
    .filter(Boolean)
    .map(category => `cat:${category}`)
  if (categories.length > 0) parts.push(`(${categories.join(' OR ')})`)
  if (filters?.publishedFrom || filters?.publishedTo) {
    const from = arxivDate(filters.publishedFrom, '000001010000')
    const to = arxivDate(filters.publishedTo, '999912312359')
    parts.push(`submittedDate:[${from} TO ${to}]`)
  }
  return parts.join(' AND ')
}

function arxivDate(value: string | undefined, fallback: string): string {
  if (!value) return fallback
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid date filter: ${value}`)
  return date.toISOString().replace(/[-:TZ.]/g, '').slice(0, 12)
}

function parseCursor(cursor?: string): number {
  if (!cursor) return 0
  if (!/^\d+$/.test(cursor)) throw new Error('arXiv cursor must be a non-negative integer offset')
  const value = Number(cursor)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid arXiv cursor')
  return value
}

function arxivSort(sort?: ArxivPaperSearchRequest['sort']): {
  sortBy: 'relevance' | 'submittedDate'
  sortOrder: 'ascending' | 'descending'
} {
  if (sort === 'oldest') return { sortBy: 'submittedDate', sortOrder: 'ascending' }
  if (sort === 'newest') return { sortBy: 'submittedDate', sortOrder: 'descending' }
  return { sortBy: 'relevance', sortOrder: 'descending' }
}

function parseLinks(entry: string): { alternate?: string; pdf?: string } {
  const result: { alternate?: string; pdf?: string } = {}
  for (const match of entry.matchAll(/<(?:[A-Za-z0-9_-]+:)?link\b([^>]*)\/?\s*>/gi)) {
    const rel = attribute(match[1], 'rel')
    const type = attribute(match[1], 'type')
    const title = attribute(match[1], 'title')
    const href = attribute(match[1], 'href')
    if (!href) continue
    if (rel === 'alternate') result.alternate = href
    if (title === 'pdf' || type === 'application/pdf') result.pdf = href
  }
  return result
}

function tagText(xml: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const local = name.includes(':') ? escaped : `(?:[A-Za-z0-9_-]+:)?${escaped}`
  const match = xml.match(new RegExp(`<${local}\\b[^>]*>([\\s\\S]*?)<\\/${local}>`, 'i'))
  return match ? decodeXml(match[1].trim()) : undefined
}

function attribute(source: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'))
  return match ? decodeXml(match[1] ?? match[2] ?? '') : undefined
}

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    if (entity[0] === '#') {
      const codePoint = entity[1].toLowerCase() === 'x'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : ''
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[entity.toLowerCase()] ?? ''
  })
}

function normalizeXmlText(value: string): string {
  return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function normalizeIsoDate(value?: string): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}

function safeArxivFilename(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 100)
}

function matchesRequestedArxivId(requestedId: string, returnedId: string): boolean {
  const requested = normalizeArxivId(requestedId)
  const returned = normalizeArxivId(returnedId)
  const requestedVersion = requested.match(/v\d+$/i)?.[0]?.toLowerCase()
  const requestedBase = requested.replace(/v\d+$/i, '')
  const returnedVersion = returned.match(/v\d+$/i)?.[0]?.toLowerCase()
  const returnedBase = returned.replace(/v\d+$/i, '')
  return requestedBase === returnedBase
    && (requestedVersion === undefined || requestedVersion === returnedVersion)
}

function isPdf(buffer: Buffer): boolean {
  return buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-'
}

function assertAllowedPdfUrl(value: string, configuredPdfBase: string): void {
  const actual = new URL(value)
  const configured = new URL(configuredPdfBase)
  const allowedHosts = new Set([configured.hostname, 'arxiv.org', 'export.arxiv.org'])
  if (actual.protocol !== 'https:' || !allowedHosts.has(actual.hostname)) {
    throw new Error(`arXiv PDF redirected to an untrusted origin: ${actual.origin}`)
  }
}

function licenseLabel(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.pathname.replace(/^\/+|\/+$/g, '') || parsed.hostname
  } catch {
    return url
  }
}
