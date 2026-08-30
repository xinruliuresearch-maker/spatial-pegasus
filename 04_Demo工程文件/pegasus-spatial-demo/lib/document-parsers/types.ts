export const PDF_PARSE_IMPLEMENTATION_NAME = 'pdf-parse'
export const PDF_PARSE_IMPLEMENTATION_VERSION = '2.4.5'

/**
 * The local parser is deliberately bounded because malformed or highly
 * compressed PDFs can expand to much larger text representations in memory.
 */
export const PDF_PARSER_MAX_INPUT_BYTES = 64 * 1024 * 1024
export const PDF_PARSER_MAX_SELECTED_PAGES = 512
export const PDF_PARSER_MAX_PAGE_TEXT_BYTES = 2 * 1024 * 1024
export const PDF_PARSER_MAX_OUTPUT_BYTES = 16 * 1024 * 1024
export const PDF_PARSER_MAX_BLOCK_BYTES = 16 * 1024
export const PDF_PARSER_MAX_BLOCKS = 100_000

export interface PdfPageRange {
  start: number
  end: number
}

export interface PdfParserOptions {
  signal?: AbortSignal
  pageRange?: PdfPageRange
}

export interface ParsedPdfPage {
  /** One-based page number in the source PDF. */
  page: number
  /** Normalized plain text extracted from this page. */
  text: string
}

export interface ParsedPdfBlock {
  /** Deterministic within one parse result. */
  blockId: string
  /** One-based page number in the source PDF. */
  page: number
  /** One-based block index within the page. */
  index: number
  type: 'text'
  text: string
}

export interface PdfParserDescriptor {
  name: typeof PDF_PARSE_IMPLEMENTATION_NAME
  version: typeof PDF_PARSE_IMPLEMENTATION_VERSION
}

export interface PdfParserResult {
  markdown: string
  pages: ParsedPdfPage[]
  blocks: ParsedPdfBlock[]
  /** Total pages in the source PDF, including pages outside pageRange. */
  totalPages: number
  parsedPages: number[]
  parser: PdfParserDescriptor
  warnings: string[]
}

/** Descriptive alias used by the literature materialization service. */
export type ParsedPdfDocument = PdfParserResult

/**
 * Internal implementation boundary. Agent-facing tools call a higher-level
 * capability and never need to know which PDF library is behind this port.
 */
export interface PdfParserPort {
  parse(buffer: Buffer, options?: PdfParserOptions): Promise<PdfParserResult>
}

export type PdfParserErrorCode =
  | 'ABORTED'
  | 'EMPTY_INPUT'
  | 'INPUT_TOO_LARGE'
  | 'NOT_PDF'
  | 'INVALID_PAGE_RANGE'
  | 'TOO_MANY_PAGES'
  | 'PAGE_TEXT_TOO_LARGE'
  | 'OUTPUT_TOO_LARGE'
  | 'TOO_MANY_BLOCKS'
  | 'INVALID_PARSER_OUTPUT'
  | 'PARSE_FAILED'
  | 'CLEANUP_FAILED'

export class PdfParserError extends Error {
  constructor(
    message: string,
    public readonly code: PdfParserErrorCode,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'PdfParserError'
  }
}

export interface PdfParserLimits {
  maxInputBytes: number
  maxSelectedPages: number
  maxPageTextBytes: number
  maxOutputBytes: number
  maxBlockBytes: number
  maxBlocks: number
}

export const DEFAULT_PDF_PARSER_LIMITS: Readonly<PdfParserLimits> = Object.freeze({
  maxInputBytes: PDF_PARSER_MAX_INPUT_BYTES,
  maxSelectedPages: PDF_PARSER_MAX_SELECTED_PAGES,
  maxPageTextBytes: PDF_PARSER_MAX_PAGE_TEXT_BYTES,
  maxOutputBytes: PDF_PARSER_MAX_OUTPUT_BYTES,
  maxBlockBytes: PDF_PARSER_MAX_BLOCK_BYTES,
  maxBlocks: PDF_PARSER_MAX_BLOCKS,
})
