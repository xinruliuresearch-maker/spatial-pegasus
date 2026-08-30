import { randomUUID } from 'node:crypto'
import type { WorkspaceDocumentWrite, WorkspaceInstance } from '../workspace/types'
import { LocalPdfParser } from '../document-parsers/local-pdf'
import type { ParsedPdfDocument, PdfParserPort } from '../document-parsers/types'
import { safeError, sha256Hex } from './http'
import { searchWorkspaceDocuments } from './document-search'
import { normalizeArxivId } from './providers/arxiv'
import { createDefaultLiteratureProviderRegistry } from './providers/registry'
import { getLiteratureProvider } from './providers/registry'
import { normalizeSciverseDocumentId } from './providers/sciverse'
import type {
  FetchPaperReceipt,
  FetchPaperRequest,
  LiteratureAuditOperation,
  LiteratureAuditedRequest,
  LiteratureAuditedResult,
  LiteraturePaperSearchRequest,
  LiteratureProviderRegistry,
  LiteraturePaper,
  LiteratureSearchAuditRecord,
  LiteratureSearchReceipt,
  SciverseEvidenceSearchReceipt,
  SciverseEvidenceSearchRequest,
  SciversePaperRelationsReceipt,
  SciversePaperRelationsRequest,
  SearchDocumentRequest,
} from './types'

const SEARCH_RECORD_VERSION = 2 as const

/**
 * Coalesce concurrent materialization of the same paper inside one live
 * workspace. A future distributed Agent runtime can replace this in-process
 * coordinator with a database lease without changing the Agent tool contract.
 */
const FETCH_PAPER_FLIGHTS = new WeakMap<
  WorkspaceInstance,
  Map<string, Promise<FetchPaperReceipt>>
>()

export interface LiteratureServiceOptions {
  signal?: AbortSignal
  now?: () => Date
  randomId?: () => string
  pdfParser?: PdfParserPort
}

export interface FetchPaperPartialArtifact {
  source: FetchPaperRequest['source']
  sourceId: string
  directory: string
  sourceContentPath: string
  metadataPath: string
  provenancePath: string
  /** Source bytes downloaded before local materialization failed. */
  downloadBytes: number
  /** True only after the provider PDF/full text is durably present. */
  sourceArtifactSaved: boolean
}

/** The provider artifact is durable, but its PDF could not yet be materialized as text. */
export class FetchPaperMaterializationError extends Error {
  readonly partial: FetchPaperPartialArtifact

  constructor(message: string, partial: FetchPaperPartialArtifact, cause?: unknown) {
    super(message, { cause })
    this.name = 'FetchPaperMaterializationError'
    this.partial = partial
  }
}

export class LiteratureService {
  private readonly providers: LiteratureProviderRegistry
  private readonly signal?: AbortSignal
  private readonly now: () => Date
  private readonly randomId: () => string
  private readonly pdfParser: PdfParserPort

  constructor(
    private readonly workspace: WorkspaceInstance,
    providers?: LiteratureProviderRegistry,
    options: LiteratureServiceOptions = {},
  ) {
    this.providers = providers ?? createDefaultLiteratureProviderRegistry()
    this.signal = options.signal
    this.now = options.now ?? (() => new Date())
    this.randomId = options.randomId ?? (() => randomUUID())
    this.pdfParser = options.pdfParser ?? new LocalPdfParser()
  }

  async searchPapers(request: LiteraturePaperSearchRequest): Promise<LiteratureSearchReceipt> {
    validatePaperSearchRequest(request)
    const receipt = await this.runAuditedOperation(
      'search_papers',
      request,
      async () => {
        const provider = getLiteratureProvider(this.providers, request.source)
        const page = await provider.searchPapers(request, { signal: this.signal })
        if (page.source !== request.source) {
          throw new Error(`Provider returned mismatched source: ${page.source}`)
        }
        return page
      },
    )
    return { searchId: receipt.searchId, recordPath: receipt.recordPath, page: receipt.result }
  }

  async searchEvidence(
    request: SciverseEvidenceSearchRequest,
  ): Promise<SciverseEvidenceSearchReceipt> {
    validateSciverseEvidenceSearchRequest(request)
    const receipt = await this.runAuditedOperation(
      'search_evidence',
      request,
      async () => {
        const provider = getLiteratureProvider(this.providers, 'sciverse')
        if (!provider.searchEvidence) throw new Error('Sciverse evidence search is unavailable')
        const result = await provider.searchEvidence(request, { signal: this.signal })
        if (result.source !== 'sciverse') throw new Error(`Provider returned mismatched source: ${result.source}`)
        return result
      },
    )
    return receipt
  }

  async listPaperRelations(
    request: SciversePaperRelationsRequest,
  ): Promise<SciversePaperRelationsReceipt> {
    validateSciversePaperRelationsRequest(request)
    const receipt = await this.runAuditedOperation(
      'list_relations',
      request,
      async () => {
        const provider = getLiteratureProvider(this.providers, 'sciverse')
        if (!provider.listPaperRelations) throw new Error('Sciverse paper relations are unavailable')
        const result = await provider.listPaperRelations(request, { signal: this.signal })
        if (result.source !== 'sciverse') throw new Error(`Provider returned mismatched source: ${result.source}`)
        return result
      },
    )
    return receipt
  }

  private async runAuditedOperation<T extends LiteratureAuditedResult>(
    operation: LiteratureAuditOperation,
    request: LiteratureAuditedRequest,
    execute: () => Promise<T>,
  ): Promise<{ searchId: string; recordPath: string; result: T }> {
    const searchId = safeSearchId(this.randomId())
    const recordPath = `references/searches/${searchId}.json`
    const retrievedAt = this.now().toISOString()

    try {
      const result = await execute()
      const record: LiteratureSearchAuditRecord = {
        schemaVersion: SEARCH_RECORD_VERSION,
        searchId,
        operation,
        source: request.source,
        status: 'success',
        request,
        retrievedAt,
        completedAt: this.now().toISOString(),
        result,
      }
      await this.writeImmutableSearchRecord(recordPath, record)
      return { searchId, recordPath, result }
    } catch (error) {
      const record: LiteratureSearchAuditRecord = {
        schemaVersion: SEARCH_RECORD_VERSION,
        searchId,
        operation,
        source: request.source,
        status: 'error',
        request,
        retrievedAt,
        completedAt: this.now().toISOString(),
        error: safeError(error),
      }
      try {
        await this.writeImmutableSearchRecord(recordPath, record)
      } catch (auditError) {
        throw new Error(
          `${record.error?.message}; additionally failed to save audit record: ${safeError(auditError).message}`,
        )
      }
      const wrapped = new Error(`${record.error?.message} (audit: ${recordPath})`)
      wrapped.name = record.error?.name ?? 'Error'
      throw wrapped
    }
  }

  async fetchPaper(request: FetchPaperRequest): Promise<FetchPaperReceipt> {
    validateFetchRequest(request)
    const identity = normalizeFetchIdentity(request)
    const sourceId = identity.sourceId
    const auditedPaper = request.searchRecordPath
      ? await this.assertSearchRecordContainsPaper(
        request.searchRecordPath,
        request.source,
        sourceId,
      )
      : undefined
    if (request.source === 'sciverse' && auditedPaper?.contentAccessible === false) {
      throw new Error(`Sciverse full text is not accessible for document: ${sourceId}`)
    }

    return this.workspace.withFileSetReservation(
      paperMaterializationPaths(request.source, sourceId),
      `literature:${request.source}:${sourceId}`,
      async () => {
        const flightKey = `${request.source}:${sourceId}`
        let workspaceFlights = FETCH_PAPER_FLIGHTS.get(this.workspace)
        if (!workspaceFlights) {
          workspaceFlights = new Map()
          FETCH_PAPER_FLIGHTS.set(this.workspace, workspaceFlights)
        }
        const existingFlight = workspaceFlights.get(flightKey)
        if (existingFlight) {
          try {
            const receipt = await existingFlight
            // Only the invocation that actually started the provider flight owns
            // its transferred bytes. Joiners reuse the result without double-counting.
            return { ...receipt, downloadBytes: 0 }
          } catch (error) {
            if (error instanceof FetchPaperMaterializationError) {
              throw new FetchPaperMaterializationError(
                error.message,
                { ...error.partial, downloadBytes: 0 },
                error.cause,
              )
            }
            throw error
          }
        }

        const flight = this.fetchPaperUncoordinated(request, sourceId, auditedPaper)
        workspaceFlights.set(flightKey, flight)
        try {
          return await flight
        } finally {
          if (workspaceFlights.get(flightKey) === flight) workspaceFlights.delete(flightKey)
          if (workspaceFlights.size === 0) FETCH_PAPER_FLIGHTS.delete(this.workspace)
        }
      },
    )
  }

  private async fetchPaperUncoordinated(
    request: FetchPaperRequest,
    sourceId: string,
    auditedPaper: LiteraturePaper | undefined,
  ): Promise<FetchPaperReceipt> {

    const directory = paperDirectory(request.source, sourceId)
    const metadataPath = `${directory}/metadata.json`
    const provenancePath = `${directory}/provenance.json`
    const pdfPath = `${directory}/original.pdf`
    const fullTextPath = `${directory}/source-fulltext.md`
    const expectedContentPath = request.source === 'arxiv' ? pdfPath : fullTextPath
    const partial: FetchPaperPartialArtifact = {
      source: request.source,
      sourceId,
      directory,
      sourceContentPath: expectedContentPath,
      metadataPath,
      provenancePath,
      downloadBytes: 0,
      sourceArtifactSaved: this.workspace.exists(expectedContentPath),
    }

    if (
      this.workspace.exists(metadataPath)
      && this.workspace.exists(provenancePath)
      && this.workspace.exists(expectedContentPath)
    ) {
      if (request.source === 'sciverse') {
        const fullText = await this.readRequiredText(fullTextPath, 'provider full text')
        return providerFullTextReceipt(partial, fullText, true, 0)
      }
      const pdfBuffer = await this.workspace.readDocumentBuffer(pdfPath)
      if (!pdfBuffer) {
        throw new FetchPaperMaterializationError(
          `The cached arXiv PDF cannot be read from ${pdfPath}`,
          partial,
        )
      }
      return this.materializeArxivFullText(partial, pdfBuffer, 0)
    }

    const provider = getLiteratureProvider(this.providers, request.source)
    const fetched = await provider.fetchPaper({ sourceId }, { signal: this.signal })
    const contentBytes = fetched.content.kind === 'pdf'
      ? fetched.content.buffer
      : Buffer.from(fetched.content.text, 'utf8')
    let downloadedPartial = {
      ...partial,
      downloadBytes: contentBytes.byteLength,
      sourceArtifactSaved: false,
    }
    try {
      if (fetched.source !== request.source || fetched.paper.ref.source !== request.source) {
        throw new Error(`Provider returned mismatched source: ${fetched.source}`)
      }
      const expectedContentKind = request.source === 'arxiv' ? 'pdf' : 'fulltext'
      if (fetched.content.kind !== expectedContentKind) {
        throw new Error(
          `${request.source} provider returned unexpected content kind: ${fetched.content.kind}`,
        )
      }
      assertFetchedPaperIdentity(request.source, sourceId, fetched.paper.ref.sourceId)
      const paper = request.source === 'sciverse' && auditedPaper
        ? mergeSciversePaperMetadata(fetched.paper, auditedPaper)
        : fetched.paper

      const contentPath = fetched.content.kind === 'pdf' ? pdfPath : fullTextPath
      let existingFullTextMatches = false
      if (fetched.content.kind === 'fulltext' && this.workspace.exists(contentPath)) {
        const existingFullText = await this.workspace.readText(contentPath)
        if (existingFullText === null) {
          throw new Error(`Existing provider full-text path is not readable text: ${contentPath}`)
        }
        if (sha256Hex(existingFullText) !== sha256Hex(contentBytes)) {
          throw new Error(`Existing provider full text has different content: ${contentPath}`)
        }
        existingFullTextMatches = true
      }
      const searchId = searchIdFromRecordPath(request.searchRecordPath)
      const provenance = {
      schemaVersion: 1,
      provider: fetched.source,
      externalId: paper.ref.sourceId,
      retrievedAt: fetched.retrievedAt,
      providerVersion: fetched.providerVersion,
      version: paper.ref.version,
      canonicalUrl: fetched.content.canonicalUrl ?? paper.landingUrl,
      landingUrl: paper.landingUrl,
      license: paper.license,
      licenseUrl: paper.licenseUrl,
      searchRecordPath: request.searchRecordPath,
      content: {
        path: contentPath,
        kind: fetched.content.kind,
        mimeType: fetched.content.mimeType,
        sizeBytes: contentBytes.byteLength,
        sha256: sha256Hex(contentBytes),
      },
    }
      const metadata = {
      schemaVersion: 1,
      paper,
      storedContent: {
        path: contentPath,
        kind: fetched.content.kind,
        mimeType: fetched.content.mimeType,
      },
    }

      await this.workspace.writeText(
      metadataPath,
      `${JSON.stringify(metadata, null, 2)}\n`,
      'literature metadata',
      { archive: false },
    )
      if (fetched.content.kind === 'pdf') {
        const document: WorkspaceDocumentWrite = {
        path: contentPath,
        buffer: fetched.content.buffer,
        filename: fetched.content.filename,
        mimeType: fetched.content.mimeType,
        source: {
          provider: fetched.source,
          canonical_url: fetched.content.canonicalUrl,
          external_id: paper.ref.sourceId,
        },
        provenance: {
          retrieved_at: fetched.retrievedAt,
          version: paper.ref.version ?? fetched.providerVersion,
          license: paper.license,
          license_url: paper.licenseUrl,
          search_record_id: searchId,
          provenance_path: provenancePath,
        },
        note: 'original literature document',
      }
        await this.workspace.writeDocument(document)
      } else if (!existingFullTextMatches) {
        await this.workspace.writeText(
        contentPath,
        fetched.content.text,
        'source full text from literature provider',
          { archive: false },
        )
      }
      downloadedPartial = { ...downloadedPartial, sourceArtifactSaved: true }
      await this.workspace.writeText(
      provenancePath,
      `${JSON.stringify(provenance, null, 2)}\n`,
      'literature retrieval provenance',
      { archive: false },
    )

      if (fetched.content.kind === 'fulltext') {
        return providerFullTextReceipt(
          partial,
          fetched.content.text,
          false,
          contentBytes.byteLength,
        )
      }
      return this.materializeArxivFullText(
        downloadedPartial,
        fetched.content.buffer,
        contentBytes.byteLength,
      )
    } catch (error) {
      if (error instanceof FetchPaperMaterializationError) throw error
      throw new FetchPaperMaterializationError(
        `The source was downloaded, but local materialization failed: ${safeError(error).message}`,
        downloadedPartial,
        error,
      )
    }
  }

  /**
   * Hide PDF parsing behind FetchPaper. The Agent never sees parser jobs, task IDs,
   * polling, model selection, or any other backend-specific lifecycle.
   */
  private async materializeArxivFullText(
    partial: FetchPaperPartialArtifact,
    pdfBuffer: Buffer,
    downloadBytes: number,
  ): Promise<FetchPaperReceipt> {
    const parsedDirectory = `${partial.directory}/parsed`
    const parsedFullTextPath = `${parsedDirectory}/fulltext.md`
    const blocksPath = `${parsedDirectory}/blocks.jsonl`
    const parserProvenancePath = `${parsedDirectory}/parser-provenance.json`

    if (
      this.workspace.exists(parsedFullTextPath)
      && this.workspace.exists(blocksPath)
      && this.workspace.exists(parserProvenancePath)
    ) {
      const fullText = await this.readRequiredText(parsedFullTextPath, 'parsed full text')
      const parser = await this.readParserIdentity(parserProvenancePath)
      return {
        ...partial,
        fullTextPath: parsedFullTextPath,
        blocksPath,
        parserProvenancePath,
        textOrigin: 'local_parser',
        parser,
        fullText,
        fullTextChars: fullText.length,
        alreadyPresent: true,
        downloadBytes,
      }
    }

    let parsed: ParsedPdfDocument
    try {
      parsed = await this.pdfParser.parse(pdfBuffer, { signal: this.signal })
    } catch (error) {
      throw new FetchPaperMaterializationError(
        `The original PDF was saved, but local PDF parsing failed: ${safeError(error).message}`,
        { ...partial, downloadBytes },
        error,
      )
    }

    const markdown = ensureTrailingNewline(parsed.markdown)
    const blocks = `${parsed.blocks.map(block => JSON.stringify({
      schema_version: 1,
      block_id: block.blockId,
      page: block.page,
      text: block.text,
    })).join('\n')}\n`
    const sourceSha256 = sha256Hex(pdfBuffer)

    try {
      await this.writeDerivedText(
        parsedFullTextPath,
        markdown,
        'locally parsed literature full text',
      )
      await this.writeDerivedText(
        blocksPath,
        blocks,
        'page-addressable local PDF text blocks',
      )

      const parserProvenance = {
        schemaVersion: 1,
        parser: {
          ...parsed.parser,
          mode: 'local',
        },
        source: {
          path: partial.sourceContentPath,
          sha256: sourceSha256,
        },
        parsedAt: this.now().toISOString(),
        pages: parsed.pages.length,
        characters: markdown.length,
        outputs: {
          fullTextPath: parsedFullTextPath,
          blocksPath,
        },
        warnings: parsed.warnings,
      }
      if (this.workspace.exists(parserProvenancePath)) {
        await this.assertCompatibleParserProvenance(
          parserProvenancePath,
          parsed.parser,
          sourceSha256,
        )
      } else {
        await this.workspace.writeText(
          parserProvenancePath,
          `${JSON.stringify(parserProvenance, null, 2)}\n`,
          'local PDF parser provenance',
          { archive: false },
        )
      }
    } catch (error) {
      throw new FetchPaperMaterializationError(
        `The original PDF was saved, but parsed outputs could not be materialized: ${safeError(error).message}`,
        { ...partial, downloadBytes },
        error,
      )
    }

    return {
      ...partial,
      fullTextPath: parsedFullTextPath,
      blocksPath,
      parserProvenancePath,
      textOrigin: 'local_parser',
      parser: parsed.parser,
      fullText: markdown,
      fullTextChars: markdown.length,
      alreadyPresent: false,
      downloadBytes,
    }
  }

  private async readRequiredText(path: string, label: string): Promise<string> {
    const text = await this.workspace.readText(path)
    if (text === null || !text.trim()) throw new Error(`${label} is empty or unreadable: ${path}`)
    return text
  }

  private async readParserIdentity(path: string): Promise<{ name: string; version: string }> {
    const raw = await this.readRequiredText(path, 'parser provenance')
    try {
      const value = objectValue(JSON.parse(raw))
      const parser = objectValue(value?.parser)
      const name = optionalString(parser?.name)
      const version = optionalString(parser?.version)
      if (!name || !version) throw new Error('missing parser identity')
      return { name, version }
    } catch (error) {
      throw new Error(`Invalid parser provenance at ${path}: ${safeError(error).message}`)
    }
  }

  private async writeDerivedText(path: string, content: string, note: string): Promise<void> {
    if (this.workspace.exists(path)) {
      const existing = await this.workspace.readText(path)
      if (existing === null || sha256Hex(existing) !== sha256Hex(content)) {
        throw new Error(`Existing managed parser artifact has different content: ${path}`)
      }
      return
    }
    await this.workspace.writeText(path, content, note, { archive: false })
  }

  private async assertCompatibleParserProvenance(
    path: string,
    parserIdentity: { name: string; version: string },
    sourceSha256: string,
  ): Promise<void> {
    const raw = await this.readRequiredText(path, 'parser provenance')
    let value: Record<string, unknown> | null
    try {
      value = objectValue(JSON.parse(raw))
    } catch {
      value = null
    }
    const parser = objectValue(value?.parser)
    const source = objectValue(value?.source)
    if (
      optionalString(parser?.name) !== parserIdentity.name
      || optionalString(parser?.version) !== parserIdentity.version
      || optionalString(source?.sha256) !== sourceSha256
    ) {
      throw new Error(`Existing parser provenance is incompatible with the current PDF: ${path}`)
    }
  }

  searchDocument(request: SearchDocumentRequest) {
    return searchWorkspaceDocuments(this.workspace, request)
  }

  private async writeImmutableSearchRecord(
    path: string,
    record: LiteratureSearchAuditRecord,
  ): Promise<void> {
    if (this.workspace.exists(path)) throw new Error(`Search audit record already exists: ${path}`)
    await this.workspace.writeText(
      path,
      `${JSON.stringify(record, null, 2)}\n`,
      'immutable literature search audit',
      { archive: false },
    )
  }

  private async assertSearchRecordContainsPaper(
    path: string,
    source: FetchPaperRequest['source'],
    sourceId: string,
  ): Promise<LiteraturePaper> {
    validateSearchRecordPath(path)
    if (!this.workspace.exists(path)) {
      throw new Error(`search_record_path does not exist in the current workspace: ${path}`)
    }
    const raw = await this.workspace.readText(path)
    if (raw === null) {
      throw new Error(`search_record_path is not a readable literature audit record: ${path}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`search_record_path contains invalid JSON: ${path}`)
    }
    const record = objectValue(parsed)
    const request = objectValue(record?.request)
    const result = objectValue(record?.result)
    const expectedSearchId = searchIdFromRecordPath(path)
    if (
      record?.schemaVersion !== SEARCH_RECORD_VERSION
      || record.searchId !== expectedSearchId
      || record.status !== 'success'
      || !request
      || !result
    ) {
      throw new Error(`search_record_path is not a successful literature audit record: ${path}`)
    }
    if (record.source !== source || request.source !== source || result.source !== source) {
      throw new Error(`search_record_path source does not match requested source: ${source}`)
    }
    const operation = optionalString(record.operation)
    if (!['search_papers', 'search_evidence'].includes(operation ?? '')) {
      throw new Error(`search_record_path does not contain fetchable paper results: ${path}`)
    }
    const candidates = Array.isArray(result.papers)
      ? result.papers
      : Array.isArray(result.hits)
        ? result.hits.map(hit => auditPaperFromEvidenceHit(hit))
        : []
    let matchedPaper: LiteraturePaper | undefined
    for (const value of candidates) {
      const paper = objectValue(value)
      const ref = objectValue(paper?.ref)
      if (!paper || !ref || ref.source !== source || typeof ref.sourceId !== 'string') continue
      try {
        const matches = source === 'arxiv'
          ? normalizeArxivPaperIdentity(ref.sourceId, ref.version).sourceId === sourceId
          : normalizeSciverseDocumentId(
              optionalString(ref.documentId) ?? ref.sourceId,
            ) === sourceId
        if (matches) {
          matchedPaper = normalizeAuditPaper(paper, source, sourceId)
          if (matchedPaper) break
        }
      } catch {
        continue
      }
    }
    if (!matchedPaper) {
      throw new Error(`search_record_path does not contain requested paper: ${source}:${sourceId}`)
    }
    return matchedPaper
  }
}

function providerFullTextReceipt(
  partial: FetchPaperPartialArtifact,
  fullText: string,
  alreadyPresent: boolean,
  downloadBytes: number,
): FetchPaperReceipt {
  if (!fullText.trim()) throw new Error(`Provider full text is empty: ${partial.sourceContentPath}`)
  return {
    ...partial,
    fullTextPath: partial.sourceContentPath,
    textOrigin: 'provider',
    fullText,
    fullTextChars: fullText.length,
    alreadyPresent,
    downloadBytes,
  }
}

function ensureTrailingNewline(value: string): string {
  const normalized = value.replace(/\r\n?/g, '\n').trimEnd()
  if (!normalized.trim()) throw new Error('Local PDF parser returned empty text')
  return `${normalized}\n`
}

export function validatePaperSearchRequest(request: LiteraturePaperSearchRequest): void {
  if (request.source === 'arxiv') {
    if (typeof request.query !== 'string' || !request.query.trim()) {
      throw new Error('query must be a non-empty string')
    }
    if (request.query.length > 2_000) throw new Error('query exceeds 2000 character limit')
    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 50) {
      throw new Error('limit must be an integer between 1 and 50')
    }
    validateCursor(request.cursor)
    if (request.sort !== undefined && !['relevance', 'newest', 'oldest'].includes(request.sort)) {
      throw new Error('sort must be relevance, newest, or oldest')
    }
    for (const values of [request.filters?.authors, request.filters?.categories]) {
      validateBoundedStringList(values, 'authors/categories filters')
    }
    return
  }

  if (request.source !== 'sciverse') throw new Error('source must be arxiv or sciverse')
  if (request.query !== undefined && (
    typeof request.query !== 'string'
    || !request.query.trim()
    || request.query.length > 4_096
  )) {
    throw new Error('query must be a non-empty string no longer than 4096 characters when provided')
  }
  for (const [value, label] of [
    [request.titleContains, 'title_contains'],
    [request.abstractContains, 'abstract_contains'],
  ] as const) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 2_000)) {
      throw new Error(`${label} must be a non-empty bounded string`)
    }
  }
  for (const [values, label] of [
    [request.authors, 'authors'],
    [request.journals, 'journals'],
    [request.subjects, 'subjects'],
  ] as const) {
    validateBoundedStringList(values, label)
  }
  for (const [year, label] of [
    [request.yearFrom, 'year_from'],
    [request.yearTo, 'year_to'],
  ] as const) {
    if (year !== undefined && (!Number.isInteger(year) || year < 0 || year > 9_999)) {
      throw new Error(`${label} must be an integer between 0 and 9999`)
    }
  }
  if (
    request.yearFrom !== undefined
    && request.yearTo !== undefined
    && request.yearFrom > request.yearTo
  ) {
    throw new Error('year_from must not exceed year_to')
  }
  if (!Number.isInteger(request.page) || request.page < 1) throw new Error('page must be a positive integer')
  if (!Number.isInteger(request.pageSize) || request.pageSize < 1 || request.pageSize > 50) {
    throw new Error('page_size must be an integer between 1 and 50')
  }
  validateCursor(request.cursor)
  const hasAdvancedFilters = Array.isArray(request.filtersAdvanced) && request.filtersAdvanced.length > 0
  const hasDiscoveryInput = !!request.query?.trim()
    || !!request.titleContains?.trim()
    || !!request.abstractContains?.trim()
    || !!request.authors?.length
    || !!request.journals?.length
    || !!request.subjects?.length
    || request.yearFrom !== undefined
    || request.yearTo !== undefined
    || hasAdvancedFilters
  if (!hasDiscoveryInput) {
    throw new Error('Sciverse paper search requires query or at least one structured filter')
  }
  if (request.filtersAdvanced !== undefined) {
    if (!Array.isArray(request.filtersAdvanced) || request.filtersAdvanced.length > 50) {
      throw new Error('filters_advanced must contain at most 50 filters')
    }
    for (const filter of request.filtersAdvanced) {
      if (!filter || typeof filter.field !== 'string' || !filter.field.trim() || filter.field.length > 200) {
        throw new Error('each advanced filter requires a bounded field name')
      }
      if (
        filter.operator !== undefined
        && ![
          'FILTER_OP_EQ',
          'FILTER_OP_NE',
          'FILTER_OP_GT',
          'FILTER_OP_GTE',
          'FILTER_OP_LT',
          'FILTER_OP_LTE',
          'FILTER_OP_IN',
          'FILTER_OP_NIN',
          'FILTER_OP_CONTAINS',
          'FILTER_OP_MATCH',
          'FILTER_OP_MATCH_PHRASE',
        ].includes(filter.operator)
      ) {
        throw new Error('advanced filter contains an unsupported operator')
      }
      if (!Object.hasOwn(filter, 'value')) {
        throw new Error('each advanced filter requires a value')
      }
    }
  }
  if (request.sortAdvanced !== undefined) {
    if (!Array.isArray(request.sortAdvanced) || request.sortAdvanced.length > 10) {
      throw new Error('sort_advanced must contain at most 10 sort fields')
    }
    for (const sort of request.sortAdvanced) {
      if (!sort || typeof sort.field !== 'string' || !sort.field.trim()) {
        throw new Error('each advanced sort requires a field')
      }
      if (!['SORT_ORDER_DESC', 'SORT_ORDER_ASC'].includes(sort.order)) {
        throw new Error('advanced sort order must be SORT_ORDER_DESC or SORT_ORDER_ASC')
      }
    }
  }
  if (
    request.sortByYear !== undefined
    && !['desc', 'asc', 'none'].includes(request.sortByYear)
  ) {
    throw new Error('sort_by_year must be desc, asc, or none')
  }
  for (const [boost, label] of [
    [request.freshnessBoost, 'freshness_boost'],
    [request.impactBoost, 'impact_boost'],
    [request.languageAffinity, 'language_affinity'],
  ] as const) {
    if (boost !== undefined && !['NONE', 'MILD', 'STRONG'].includes(boost)) {
      throw new Error(`${label} must be NONE, MILD, or STRONG`)
    }
  }
  if (
    request.cursor
    && [request.freshnessBoost, request.impactBoost, request.languageAffinity]
      .some(value => value !== undefined && value !== 'NONE')
  ) {
    throw new Error('Sciverse relevance boosts do not support cursor pagination')
  }
}

export function validateSciverseEvidenceSearchRequest(
  request: SciverseEvidenceSearchRequest,
): void {
  if (request.source !== 'sciverse') throw new Error('Sciverse evidence search requires source=sciverse')
  if (typeof request.query !== 'string' || !request.query.trim() || request.query.length > 4_096) {
    throw new Error('query must be a non-empty string no longer than 4096 characters')
  }
  if (!Number.isInteger(request.topK) || request.topK < 1 || request.topK > 100) {
    throw new Error('top_k must be an integer between 1 and 100')
  }
  if (!['fast', 'balanced', 'quality'].includes(request.mode)) {
    throw new Error('mode must be fast, balanced, or quality')
  }
  if (request.sourceTypes !== undefined && (
    !Array.isArray(request.sourceTypes)
    || request.sourceTypes.length > 2
    || request.sourceTypes.some(value => !['web', 'pdf'].includes(value))
    || new Set(request.sourceTypes).size !== request.sourceTypes.length
  )) {
    throw new Error('source_types may contain only web and pdf')
  }
  const docIds = request.filters?.doc_id
  if (docIds !== undefined) {
    const values = Array.isArray(docIds) ? docIds : [docIds]
    if (values.length > 1_000) {
      throw new Error('filters.doc_id may contain at most 1000 document ids')
    }
    if (values.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) {
      throw new Error('filters.doc_id must be a 64-character lowercase SHA-256 id or list of ids')
    }
  }
}

export function validateSciversePaperRelationsRequest(
  request: SciversePaperRelationsRequest,
): void {
  if (request.source !== 'sciverse') throw new Error('Sciverse relations require source=sciverse')
  if (typeof request.uniqueId !== 'string' || !request.uniqueId.trim() || request.uniqueId.length > 1_024) {
    throw new Error('unique_id must be a non-empty bounded string')
  }
  if (!['CITATIONS', 'REFERENCES', 'RELATED_WORKS'].includes(request.relation)) {
    throw new Error('relation must be CITATIONS, REFERENCES, or RELATED_WORKS')
  }
  if (!Number.isInteger(request.page) || request.page < 1) throw new Error('page must be a positive integer')
  if (!Number.isInteger(request.pageSize) || request.pageSize < 1 || request.pageSize > 200) {
    throw new Error('page_size must be an integer between 1 and 200')
  }
}

function validateCursor(cursor: string | undefined): void {
  if (cursor !== undefined && (typeof cursor !== 'string' || !cursor.trim() || cursor.length > 2_000)) {
    throw new Error('cursor must be a non-empty string no longer than 2000 characters')
  }
}

function validateBoundedStringList(values: string[] | undefined, label: string): void {
  if (values !== undefined && (
    !Array.isArray(values)
    || values.length > 20
    || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 200)
  )) {
    throw new Error(`${label} must contain at most 20 bounded strings`)
  }
}

export function validateFetchRequest(request: FetchPaperRequest): void {
  if (!['arxiv', 'sciverse'].includes(request.source)) {
    throw new Error('source must be arxiv or sciverse')
  }
  if (typeof request.sourceId !== 'string' || !request.sourceId.trim() || request.sourceId.length > 500) {
    throw new Error('source_id must be a non-empty bounded string')
  }
  if (request.version !== undefined) {
    if (request.source === 'sciverse') {
      throw new Error('Sciverse fetch does not support a version parameter')
    }
    normalizeArxivVersion(request.version)
  }
  if (request.source === 'sciverse' && !/^[a-f0-9]{64}$/.test(request.sourceId)) {
    throw new Error('doc_id must be a 64-character lowercase SHA-256 identifier')
  }
  if (request.searchRecordPath !== undefined) validateSearchRecordPath(request.searchRecordPath)
}

export function paperDirectory(source: string, sourceId: string, version?: string): string {
  if (source === 'arxiv') {
    sourceId = normalizeArxivPaperIdentity(sourceId, version).sourceId
    version = undefined
  } else if (source === 'sciverse') {
    if (version !== undefined) throw new Error('Sciverse fetch does not support a version parameter')
    sourceId = normalizeSciverseDocumentId(sourceId)
  }
  const identity = `${source}:${sourceId}:${version ?? ''}`
  const slug = sourceId
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'paper'
  return `references/papers/${source}-${slug}-${sha256Hex(identity).slice(0, 10)}`
}

export function paperMaterializationPaths(
  source: FetchPaperRequest['source'],
  sourceId: string,
): string[] {
  const directory = paperDirectory(source, sourceId)
  const common = [
    `${directory}/metadata.json`,
    `${directory}/provenance.json`,
  ]
  return source === 'sciverse'
    ? [...common, `${directory}/source-fulltext.md`]
    : [
        ...common,
        `${directory}/original.pdf`,
        `${directory}/parsed/fulltext.md`,
        `${directory}/parsed/blocks.jsonl`,
        `${directory}/parsed/parser-provenance.json`,
      ]
}

function safeSearchId(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
  if (!safe) throw new Error('Could not generate a safe search record identifier')
  return `search-${safe}`
}

function validateSearchRecordPath(value: string): void {
  if (!/^references\/searches\/search-[a-z0-9_-]+\.json$/.test(value)) {
    throw new Error('search_record_path must reference an immutable literature search record')
  }
}

function searchIdFromRecordPath(path?: string): string | undefined {
  if (!path) return undefined
  validateSearchRecordPath(path)
  return path.slice('references/searches/'.length, -'.json'.length)
}

function normalizeFetchIdentity(request: FetchPaperRequest): { sourceId: string; version?: string } {
  return request.source === 'arxiv'
    ? normalizeArxivPaperIdentity(request.sourceId, request.version)
    : { sourceId: normalizeSciverseDocumentId(request.sourceId) }
}

function normalizeArxivPaperIdentity(
  sourceId: string,
  explicitVersion?: unknown,
): { sourceId: string; version?: string } {
  const normalizedId = normalizeArxivId(sourceId)
  const embedded = normalizedId.match(/v(\d+)$/i)
  const baseId = embedded ? normalizedId.slice(0, -embedded[0].length) : normalizedId
  const embeddedVersion = embedded ? normalizeArxivVersion(embedded[0]) : undefined
  const requestedVersion = explicitVersion === undefined
    ? undefined
    : normalizeArxivVersion(explicitVersion)
  if (embeddedVersion && requestedVersion && embeddedVersion !== requestedVersion) {
    throw new Error(
      `arXiv version mismatch between source_id (${embeddedVersion}) and version (${requestedVersion})`,
    )
  }
  const version = requestedVersion ?? embeddedVersion
  return { sourceId: `${baseId}${version ?? ''}`, version }
}

function normalizeArxivVersion(value: unknown): string {
  if (typeof value !== 'string') throw new Error('version must be an arXiv version string such as v2')
  const match = value.trim().match(/^v?([0-9]{1,20})$/i)
  if (!match) throw new Error('version must be an arXiv version string such as v2')
  const digits = match[1].replace(/^0+/, '')
  if (!digits) throw new Error('arXiv version must be a positive integer')
  return `v${digits}`
}

function assertFetchedPaperIdentity(
  source: FetchPaperRequest['source'],
  requestedSourceId: string,
  fetchedSourceId: string,
): void {
  if (source === 'sciverse') {
    if (normalizeSciverseDocumentId(fetchedSourceId) !== requestedSourceId) {
      throw new Error(`Provider returned mismatched paper identifier: ${fetchedSourceId}`)
    }
    return
  }
  const requested = normalizeArxivPaperIdentity(requestedSourceId)
  const fetched = normalizeArxivPaperIdentity(fetchedSourceId)
  const requestedBase = requested.sourceId.replace(/v\d+$/i, '')
  const fetchedBase = fetched.sourceId.replace(/v\d+$/i, '')
  if (
    requestedBase !== fetchedBase
    || (requested.version !== undefined && requested.sourceId !== fetched.sourceId)
  ) {
    throw new Error(`Provider returned mismatched paper identifier: ${fetchedSourceId}`)
  }
}

function normalizeAuditPaper(
  paper: Record<string, unknown>,
  source: FetchPaperRequest['source'],
  sourceId: string,
): LiteraturePaper | undefined {
  const ref = objectValue(paper.ref)
  const title = optionalString(paper.title)
  if (!ref || !title || !Array.isArray(paper.authors)) return undefined
  const authors = paper.authors
    .filter((value): value is string => typeof value === 'string' && !!value.trim())
    .map(value => value.trim().slice(0, 500))
  if (authors.length !== paper.authors.length) return undefined
  const categories = Array.isArray(paper.categories)
    ? paper.categories.filter((value): value is string => typeof value === 'string' && !!value.trim())
    : undefined
  return {
    ref: {
      source,
      sourceId,
      version: optionalString(ref.version),
      uniqueId: optionalString(ref.uniqueId),
      documentId: optionalString(ref.documentId),
    },
    title: title.slice(0, 2_000),
    authors,
    abstract: optionalString(paper.abstract)?.slice(0, 12_000),
    publishedAt: optionalString(paper.publishedAt),
    updatedAt: optionalString(paper.updatedAt),
    categories,
    doi: optionalString(paper.doi),
    landingUrl: optionalString(paper.landingUrl),
    documentUrl: optionalString(paper.documentUrl),
    license: optionalString(paper.license),
    licenseUrl: optionalString(paper.licenseUrl),
    contentAccessible: typeof paper.contentAccessible === 'boolean'
      ? paper.contentAccessible
      : undefined,
    venue: optionalString(paper.venue),
    publishedYear: typeof paper.publishedYear === 'number' ? paper.publishedYear : undefined,
    citationCount: typeof paper.citationCount === 'number' ? paper.citationCount : undefined,
    influentialCitationCount: typeof paper.influentialCitationCount === 'number'
      ? paper.influentialCitationCount
      : undefined,
    sourceLocations: Array.isArray(paper.sourceLocations)
      ? paper.sourceLocations.filter(value => objectValue(value) !== null) as LiteraturePaper['sourceLocations']
      : undefined,
  }
}

function mergeSciversePaperMetadata(
  fetched: LiteraturePaper,
  audited: LiteraturePaper,
): LiteraturePaper {
  const genericTitle = fetched.title === `Sciverse document ${fetched.ref.sourceId}`
  return {
    ref: {
      ...fetched.ref,
      version: fetched.ref.version ?? audited.ref.version,
      uniqueId: fetched.ref.uniqueId ?? audited.ref.uniqueId,
      documentId: fetched.ref.documentId ?? audited.ref.documentId,
    },
    title: genericTitle ? audited.title : fetched.title,
    authors: fetched.authors.length > 0 ? fetched.authors : audited.authors,
    abstract: fetched.abstract ?? audited.abstract,
    publishedAt: fetched.publishedAt ?? audited.publishedAt,
    updatedAt: fetched.updatedAt ?? audited.updatedAt,
    categories: fetched.categories ?? audited.categories,
    doi: fetched.doi ?? audited.doi,
    landingUrl: fetched.landingUrl ?? audited.landingUrl,
    documentUrl: fetched.documentUrl ?? audited.documentUrl,
    license: fetched.license ?? audited.license,
    licenseUrl: fetched.licenseUrl ?? audited.licenseUrl,
    contentAccessible: fetched.contentAccessible ?? audited.contentAccessible,
    venue: fetched.venue ?? audited.venue,
    publishedYear: fetched.publishedYear ?? audited.publishedYear,
    citationCount: fetched.citationCount ?? audited.citationCount,
    influentialCitationCount: fetched.influentialCitationCount ?? audited.influentialCitationCount,
    sourceLocations: fetched.sourceLocations ?? audited.sourceLocations,
  }
}

function auditPaperFromEvidenceHit(value: unknown): Record<string, unknown> {
  const hit = objectValue(value)
  if (!hit) return {}
  const documentId = optionalString(hit.documentId)
  const chunk = optionalString(hit.chunk)
  const offset = typeof hit.offset === 'number' ? hit.offset : undefined
  return {
    ref: {
      source: 'sciverse',
      sourceId: documentId ?? '',
      documentId,
      uniqueId: optionalString(hit.uniqueId),
    },
    title: optionalString(hit.title),
    authors: Array.isArray(hit.authors) ? hit.authors : [],
    abstract: optionalString(hit.abstract),
    venue: optionalString(hit.venue),
    publishedYear: typeof hit.publishedYear === 'number' ? hit.publishedYear : undefined,
    sourceLocations: chunk
      ? [{
          quote: chunk,
          score: typeof hit.score === 'number' ? hit.score : undefined,
          locator: offset === undefined ? undefined : `byte-offset:${offset}`,
          page: typeof hit.page === 'number' ? hit.page : undefined,
        }]
      : undefined,
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
