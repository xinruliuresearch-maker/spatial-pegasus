import type { ParseParameters } from 'pdf-parse'
import {
  DEFAULT_PDF_PARSER_LIMITS,
  PDF_PARSE_IMPLEMENTATION_NAME,
  PDF_PARSE_IMPLEMENTATION_VERSION,
  PdfParserError,
  type ParsedPdfBlock,
  type ParsedPdfPage,
  type PdfPageRange,
  type PdfParserLimits,
  type PdfParserOptions,
  type PdfParserPort,
  type PdfParserResult,
} from './types'

interface PdfBackendInfo {
  total: number
}

interface PdfBackendTextPage {
  num: number
  text: string
}

interface PdfBackendTextResult {
  pages: PdfBackendTextPage[]
  text: string
  total: number
}

/** Minimal pdf-parse surface kept private from the rest of the application. */
export interface PdfParserBackend {
  getInfo(): Promise<PdfBackendInfo>
  getText(params?: ParseParameters): Promise<PdfBackendTextResult>
  destroy(): Promise<void>
}

export type PdfParserBackendFactory = (data: Uint8Array) => Promise<PdfParserBackend>

export interface LocalPdfParserOptions {
  backendFactory?: PdfParserBackendFactory
  limits?: Partial<PdfParserLimits>
}

async function defaultBackendFactory(data: Uint8Array): Promise<PdfParserBackend> {
  const { PDFParse } = await import('pdf-parse')
  return new PDFParse({
    data,
    isEvalSupported: false,
    stopAtErrors: false,
    useSystemFonts: false,
    verbosity: 0,
  })
}

/**
 * In-process PDF text extraction backed by pdf-parse/PDF.js.
 *
 * Extraction is deliberately page-at-a-time. This provides useful abort and
 * output-limit checkpoints and avoids constructing a second unbounded
 * document-wide string inside this adapter.
 */
export class LocalPdfParser implements PdfParserPort {
  private readonly backendFactory: PdfParserBackendFactory
  private readonly limits: PdfParserLimits

  constructor(options: LocalPdfParserOptions = {}) {
    this.backendFactory = options.backendFactory ?? defaultBackendFactory
    this.limits = validateLimits({ ...DEFAULT_PDF_PARSER_LIMITS, ...options.limits })
  }

  async parse(buffer: Buffer, options: PdfParserOptions = {}): Promise<PdfParserResult> {
    validateInput(buffer, this.limits.maxInputBytes)
    throwIfAborted(options.signal)

    // Copy the caller-owned Buffer so PDF.js cannot detach or mutate it.
    const input = Uint8Array.from(buffer)
    let backend: PdfParserBackend | undefined
    let failed = false
    try {
      backend = await raceWithAbort(this.backendFactory(input), options.signal)
      throwIfAborted(options.signal)

      const info = await raceWithAbort(backend.getInfo(), options.signal)
      const totalPages = validateTotalPages(info.total)
      const pageNumbers = resolvePageNumbers(totalPages, options.pageRange, this.limits)
      const pages: ParsedPdfPage[] = []
      const blocks: ParsedPdfBlock[] = []
      const warnings: string[] = []
      let outputBytes = 0

      for (const pageNumber of pageNumbers) {
        throwIfAborted(options.signal)
        const result = await raceWithAbort(
          backend.getText({ partial: [pageNumber], parseHyperlinks: false }),
          options.signal,
        )
        const pageText = normalizePageText(extractPageText(result, pageNumber))
        const pageBytes = byteLength(pageText)
        if (pageBytes > this.limits.maxPageTextBytes) {
          throw new PdfParserError(
            `Extracted text for page ${pageNumber} exceeds ${this.limits.maxPageTextBytes} bytes`,
            'PAGE_TEXT_TOO_LARGE',
          )
        }
        outputBytes += pageBytes
        if (outputBytes > this.limits.maxOutputBytes) {
          throw new PdfParserError(
            `Extracted PDF text exceeds ${this.limits.maxOutputBytes} bytes`,
            'OUTPUT_TOO_LARGE',
          )
        }

        pages.push({ page: pageNumber, text: pageText })
        if (!pageText) warnings.push(`Page ${pageNumber} contains no extractable text.`)
        blocks.push(...makeBlocks(pageNumber, pageText, this.limits))
        if (blocks.length > this.limits.maxBlocks) {
          throw new PdfParserError(
            `Parsed PDF exceeds ${this.limits.maxBlocks} text blocks`,
            'TOO_MANY_BLOCKS',
          )
        }
      }

      const markdown = renderPageMarkdown(pages)
      if (byteLength(markdown) > this.limits.maxOutputBytes) {
        throw new PdfParserError(
          `Parsed PDF Markdown exceeds ${this.limits.maxOutputBytes} bytes`,
          'OUTPUT_TOO_LARGE',
        )
      }

      return {
        markdown,
        pages,
        blocks,
        totalPages,
        parsedPages: pageNumbers,
        parser: {
          name: PDF_PARSE_IMPLEMENTATION_NAME,
          version: PDF_PARSE_IMPLEMENTATION_VERSION,
        },
        warnings,
      }
    } catch (error) {
      failed = true
      throw normalizeParserError(error)
    } finally {
      // PDF.js may transfer (and therefore detach) the copied ArrayBuffer.
      // A detached buffer no longer contains caller data and cannot be filled.
      try {
        input.fill(0)
      } catch {
        // Already detached by the parser worker.
      }
      if (backend) {
        try {
          await backend.destroy()
        } catch (error) {
          if (!failed) {
            throw new PdfParserError('Failed to release local PDF parser resources', 'CLEANUP_FAILED', {
              cause: error,
            })
          }
        }
      }
    }
  }
}

function validateLimits(limits: PdfParserLimits): PdfParserLimits {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer`)
    }
  }
  if (limits.maxBlockBytes > limits.maxPageTextBytes) {
    throw new Error('maxBlockBytes must not exceed maxPageTextBytes')
  }
  return Object.freeze({ ...limits })
}

function validateInput(buffer: Buffer, maxInputBytes: number): void {
  if (!Buffer.isBuffer(buffer) || buffer.byteLength === 0) {
    throw new PdfParserError('PDF input must be a non-empty Buffer', 'EMPTY_INPUT')
  }
  if (buffer.byteLength > maxInputBytes) {
    throw new PdfParserError(`PDF input exceeds ${maxInputBytes} bytes`, 'INPUT_TOO_LARGE')
  }
  const header = buffer.subarray(0, Math.min(buffer.byteLength, 1024)).toString('latin1')
  if (!header.includes('%PDF-')) {
    throw new PdfParserError('Input does not contain a PDF header', 'NOT_PDF')
  }
}

function validateTotalPages(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new PdfParserError('PDF parser returned an invalid page count', 'INVALID_PARSER_OUTPUT')
  }
  return value
}

function resolvePageNumbers(
  totalPages: number,
  range: PdfPageRange | undefined,
  limits: PdfParserLimits,
): number[] {
  const start = range?.start ?? 1
  const end = range?.end ?? totalPages
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || start < 1
    || end < start
    || end > totalPages
  ) {
    throw new PdfParserError(
      `Requested page range ${start}-${end} is outside this ${totalPages}-page PDF`,
      'INVALID_PAGE_RANGE',
    )
  }
  const count = end - start + 1
  if (count > limits.maxSelectedPages) {
    throw new PdfParserError(
      `PDF parsing may select at most ${limits.maxSelectedPages} pages`,
      'TOO_MANY_PAGES',
    )
  }
  return Array.from({ length: count }, (_, index) => start + index)
}

function extractPageText(result: PdfBackendTextResult, pageNumber: number): string {
  if (!result || !Array.isArray(result.pages)) {
    throw new PdfParserError('PDF parser returned invalid page text', 'INVALID_PARSER_OUTPUT')
  }
  const page = result.pages.find(candidate => candidate?.num === pageNumber)
  const value = page?.text ?? (result.pages.length === 1 ? result.pages[0]?.text : undefined)
  if (typeof value !== 'string') {
    throw new PdfParserError(
      `PDF parser did not return text for page ${pageNumber}`,
      'INVALID_PARSER_OUTPUT',
    )
  }
  return value
}

function normalizePageText(value: string): string {
  return value
    .replace(/\0/g, '')
    .replace(/\r\n?/g, '\n')
    .normalize('NFC')
    .split('\n')
    .map(line => line.replace(/[\t ]+$/g, ''))
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

function renderPageMarkdown(pages: ParsedPdfPage[]): string {
  return `${pages.map(({ page, text }) => [
    `<!-- page: ${page} -->`,
    `## Page ${page}`,
    text,
  ].filter(Boolean).join('\n\n')).join('\n\n')}\n`
}

function makeBlocks(
  page: number,
  text: string,
  limits: PdfParserLimits,
): ParsedPdfBlock[] {
  if (!text) return []
  const paragraphs = text.split(/\n{2,}/).map(value => value.trim()).filter(Boolean)
  const chunks = paragraphs.flatMap(paragraph => splitByUtf8Bytes(paragraph, limits.maxBlockBytes))
  return chunks.map((chunk, offset) => ({
    blockId: `page-${page}-block-${offset + 1}`,
    page,
    index: offset + 1,
    type: 'text' as const,
    text: chunk,
  }))
}

/** Split without cutting a UTF-16 surrogate pair or exceeding the byte cap. */
function splitByUtf8Bytes(value: string, maxBytes: number): string[] {
  if (byteLength(value) <= maxBytes) return [value]
  const chunks: string[] = []
  let current = ''
  let currentBytes = 0

  for (const character of value) {
    const characterBytes = byteLength(character)
    if (current && currentBytes + characterBytes > maxBytes) {
      chunks.push(current.trim())
      current = ''
      currentBytes = 0
    }
    current += character
    currentBytes += characterBytes
  }
  if (current) chunks.push(current.trim())
  return chunks.filter(Boolean)
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new PdfParserError('Local PDF parsing was aborted', 'ABORTED', { cause: signal.reason })
  }
}

async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  throwIfAborted(signal)
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => finish(() => reject(
      new PdfParserError('Local PDF parsing was aborted', 'ABORTED', { cause: signal.reason }),
    ))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    )
  })
}

function normalizeParserError(error: unknown): PdfParserError {
  if (error instanceof PdfParserError) return error
  const message = error instanceof Error && error.message.trim()
    ? error.message.trim().slice(0, 1_000)
    : 'Unknown local PDF parser error'
  return new PdfParserError(`Unable to parse PDF locally: ${message}`, 'PARSE_FAILED', { cause: error })
}
