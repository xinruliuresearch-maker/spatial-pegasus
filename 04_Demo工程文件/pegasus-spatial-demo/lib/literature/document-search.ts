import type { WorkspaceInstance } from '../workspace/types'
import type {
  DocumentSearchHit,
  DocumentSearchResult,
  SearchDocumentRequest,
} from './types'

const MAX_DOCUMENTS = 50
const MAX_SINGLE_FILE_CHARS = 12_000_000
const MAX_TOTAL_SCAN_CHARS = 30_000_000
const DEFAULT_MAX_RESULTS = 20
const MAX_RESULTS = 50
const DEFAULT_CONTEXT_CHARS = 260
const MAX_CONTEXT_CHARS = 1_000

const SEARCHABLE_SUFFIXES = [
  '/parsed/blocks.jsonl',
  '/parsed/content-list.json',
  '/parsed/fulltext.md',
  '/source-fulltext.md',
] as const

export async function searchWorkspaceDocuments(
  workspace: WorkspaceInstance,
  request: SearchDocumentRequest,
): Promise<DocumentSearchResult> {
  if (!request || typeof request.query !== 'string') {
    throw new Error('Document search query must be a string')
  }
  const query = request.query.trim()
  if (!query) throw new Error('Document search query cannot be empty')
  if (query.length > 2_000) throw new Error('Document search query exceeds 2000 characters')
  if (request.caseSensitive !== undefined && typeof request.caseSensitive !== 'boolean') {
    throw new Error('case_sensitive must be a boolean')
  }
  if (request.documentPaths !== undefined && (
    !Array.isArray(request.documentPaths)
    || request.documentPaths.length > MAX_DOCUMENTS
    || request.documentPaths.some(path => (
      typeof path !== 'string' || !path.trim() || path.length > 512
    ))
  )) {
    throw new Error(`document_paths must contain at most ${MAX_DOCUMENTS} bounded workspace paths`)
  }
  const maxResults = boundedInteger(request.maxResults, DEFAULT_MAX_RESULTS, 1, MAX_RESULTS, 'max_results')
  const contextChars = boundedInteger(
    request.contextChars,
    DEFAULT_CONTEXT_CHARS,
    40,
    MAX_CONTEXT_CHARS,
    'context_chars',
  )
  const resolved = resolveSearchPaths(workspace, request.documentPaths)
  if (resolved.length === 0) {
    throw new Error('No parsed or source full-text documents are available to search')
  }

  const paths = resolved.slice(0, MAX_DOCUMENTS)
  const hits: DocumentSearchHit[] = []
  let scannedChars = 0
  let truncated = resolved.length > paths.length

  for (const path of paths) {
    if (hits.length >= maxResults || scannedChars >= MAX_TOTAL_SCAN_CHARS) {
      truncated = true
      break
    }
    const stat = await workspace.stat(path)
    if (!stat || stat.kind !== 'text') continue
    if (stat.sizeBytes && stat.sizeBytes > MAX_SINGLE_FILE_CHARS * 4) {
      truncated = true
      continue
    }
    const raw = await workspace.readText(path)
    if (raw === null) continue
    const remaining = MAX_TOTAL_SCAN_CHARS - scannedChars
    const content = raw.slice(0, Math.min(MAX_SINGLE_FILE_CHARS, remaining))
    if (content.length < raw.length) truncated = true
    scannedChars += content.length

    const fileHits = path.endsWith('.jsonl')
      ? searchJsonLines(path, content, query, !!request.caseSensitive, contextChars)
      : path.endsWith('.json')
        ? searchJsonDocument(path, content, query, !!request.caseSensitive, contextChars)
        : searchMarkdown(path, content, query, !!request.caseSensitive, contextChars)

    const slots = maxResults - hits.length
    hits.push(...fileHits.slice(0, slots))
    if (fileHits.length > slots) truncated = true
  }

  return { query, searchedPaths: paths, hits, truncated }
}

export function resolveSearchPaths(
  workspace: Pick<WorkspaceInstance, 'list' | 'exists'>,
  requested?: string[],
): string[] {
  const searchable = new Set(workspace.list().filter(isSearchablePath))
  if (!requested || requested.length === 0) return [...searchable].sort()

  const selected = new Set<string>()
  for (const rawPath of requested) {
    const path = normalizeInputPath(rawPath)
    if (searchable.has(path)) {
      selected.add(path)
      continue
    }
    const base = paperDirectory(path)
    for (const candidate of searchable) {
      if (candidate === base || candidate.startsWith(`${base}/`)) selected.add(candidate)
    }
  }
  return [...selected].sort()
}

function searchJsonLines(
  path: string,
  content: string,
  query: string,
  caseSensitive: boolean,
  contextChars: number,
): DocumentSearchHit[] {
  const hits: DocumentSearchHit[] = []
  const lines = content.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line) continue
    let record: Record<string, unknown>
    try {
      const parsed = JSON.parse(line)
      if (!isRecord(parsed)) continue
      record = parsed
    } catch {
      continue
    }
    const text = recordText(record)
    const matchIndex = indexOf(text, query, caseSensitive)
    if (matchIndex < 0) continue
    hits.push(blockHit(path, record, text, matchIndex, query.length, contextChars, index + 1))
  }
  return hits
}

function searchJsonDocument(
  path: string,
  content: string,
  query: string,
  caseSensitive: boolean,
  contextChars: number,
): DocumentSearchHit[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return []
  }
  const records = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.blocks)
      ? parsed.blocks
      : isRecord(parsed) && Array.isArray(parsed.items)
        ? parsed.items
        : []
  return records.flatMap((value, index) => {
    if (!isRecord(value)) return []
    const text = recordText(value)
    const matchIndex = indexOf(text, query, caseSensitive)
    return matchIndex < 0
      ? []
      : [blockHit(path, value, text, matchIndex, query.length, contextChars, index + 1)]
  })
}

function searchMarkdown(
  path: string,
  content: string,
  query: string,
  caseSensitive: boolean,
  contextChars: number,
): DocumentSearchHit[] {
  const lines = content.split('\n')
  const hits: DocumentSearchHit[] = []
  let section: string | undefined
  let page: number | undefined
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/)
    if (heading) section = heading[1].trim()
    const pageMarker = line.match(/(?:<!--\s*)?page(?:_idx)?\s*[:=]\s*(\d+)/i)
    if (pageMarker) page = Number(pageMarker[1])
    const matchIndex = indexOf(line, query, caseSensitive)
    if (matchIndex < 0) continue
    hits.push({
      path,
      line: index + 1,
      page,
      section,
      quote: excerpt(line, matchIndex, query.length, contextChars),
    })
  }
  return hits
}

function blockHit(
  path: string,
  record: Record<string, unknown>,
  text: string,
  matchIndex: number,
  matchLength: number,
  contextChars: number,
  fallbackLine: number,
): DocumentSearchHit {
  return {
    path,
    blockId: stringField(record, ['block_id', 'blockId', 'id']),
    page: numberField(record, ['page', 'page_idx', 'pageIndex', 'page_number']),
    section: sectionField(record),
    bbox: numberArray(record.bbox ?? record.bounding_box),
    line: fallbackLine,
    quote: excerpt(text, matchIndex, matchLength, contextChars),
  }
}

function recordText(record: Record<string, unknown>): string {
  return stringField(record, ['text', 'content', 'markdown', 'value']) ?? ''
}

function sectionField(record: Record<string, unknown>): string | undefined {
  const direct = stringField(record, ['section', 'section_title', 'heading'])
  if (direct) return direct
  const path = record.heading_path
  return Array.isArray(path)
    ? path.filter(item => typeof item === 'string').join(' > ') || undefined
    : undefined
}

function stringField(record: Record<string, unknown>, fields: string[]): string | undefined {
  for (const field of fields) {
    const value = record[field]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function numberField(record: Record<string, unknown>, fields: string[]): number | undefined {
  for (const field of fields) {
    const value = record[field]
    const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
    if (Number.isFinite(numeric)) return numeric
  }
  return undefined
}

function numberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  const numbers = value.map(item => Number(item))
  return numbers.length > 0 && numbers.every(Number.isFinite) ? numbers : undefined
}

function indexOf(text: string, query: string, caseSensitive: boolean): number {
  return caseSensitive
    ? text.indexOf(query)
    : text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
}

function excerpt(text: string, index: number, length: number, contextChars: number): string {
  const before = Math.max(0, index - Math.floor(contextChars / 2))
  const after = Math.min(text.length, index + length + Math.ceil(contextChars / 2))
  return `${before > 0 ? '…' : ''}${text.slice(before, after).replace(/\s+/g, ' ').trim()}${after < text.length ? '…' : ''}`
}

function normalizeInputPath(value: string): string {
  const normalized = value.trim()
    .replace(/^\/workspace\//, '')
    .replace(/^workspace\//, '')
    .replace(/^\//, '')
    .replace(/\/+$/, '')
  if (!normalized || normalized.includes('..') || normalized.includes('\\')) {
    throw new Error(`Unsafe document path: ${value}`)
  }
  return normalized
}

function paperDirectory(path: string): string {
  const marker = path.indexOf('/parsed/')
  if (marker >= 0) return path.slice(0, marker)
  if (path.endsWith('/source-fulltext.md')) return path.slice(0, -'/source-fulltext.md'.length)
  if (/\/[^/]+\.[A-Za-z0-9]+$/.test(path)) return path.slice(0, path.lastIndexOf('/'))
  return path
}

function isSearchablePath(path: string): boolean {
  return SEARCHABLE_SUFFIXES.some(suffix => path.endsWith(suffix))
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
