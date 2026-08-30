import type { WorkspaceDocumentRef } from '../workspace/types'
import {
  PDF_PARSER_MAX_INPUT_BYTES,
  type PdfPageRange,
} from './types'

const SHA256_RE = /^[a-f0-9]{64}$/i
const PAGE_RANGE_RE = /^(\d+)(?:-(\d+))?$/

/** Convert a tool-friendly `1` or `1-10` value into a structured page range. */
export function normalizePdfPageRange(value?: string): PdfPageRange | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('page_range must be a string')
  const match = PAGE_RANGE_RE.exec(value.trim())
  if (!match) throw new Error('page_range must be one page or a contiguous range such as 1-10')

  const start = Number(match[1])
  const end = Number(match[2] ?? match[1])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
    throw new Error('page_range must contain positive ascending page numbers')
  }
  return { start, end }
}

/** Validate the immutable workspace reference before loading its binary bytes. */
export function assertWorkspacePdfDocument(document: WorkspaceDocumentRef): void {
  if (document.mimeType.toLowerCase() !== 'application/pdf') {
    throw new Error('Local document parsing accepts workspace PDF documents only')
  }
  if (!document.filename.toLowerCase().endsWith('.pdf')) {
    throw new Error('Workspace document filename must end in .pdf')
  }
  if (!Number.isSafeInteger(document.sizeBytes) || document.sizeBytes <= 0) {
    throw new Error('Workspace document size is invalid')
  }
  if (document.sizeBytes > PDF_PARSER_MAX_INPUT_BYTES) {
    throw new Error(`Local PDF parsing accepts files up to ${PDF_PARSER_MAX_INPUT_BYTES} bytes`)
  }
  if (!SHA256_RE.test(document.sha256)) throw new Error('Workspace document sha256 is invalid')
}
