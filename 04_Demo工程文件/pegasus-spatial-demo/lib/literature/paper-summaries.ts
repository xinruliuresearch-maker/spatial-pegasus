export const MAX_PAPER_SUMMARY_FILES = 500
export const MAX_PAPER_METADATA_BYTES = 64 * 1024
export const MAX_PAPER_HEADING_BYTES = 16 * 1024
export const PAPER_SUMMARY_READ_CONCURRENCY = 10

export type LiteraturePaperSummarySource = 'sciverse' | 'arxiv'

export interface LiteraturePaperSummary {
  directory: string
  title: string
  source: LiteraturePaperSummarySource
  primaryPath: string
}

export interface LiteraturePaperSummaryFile {
  path: string
  visibility: 'public' | 'managed_reference' | string
  sizeBytes: number
}

export type LiteraturePaperPrefixReader = (
  file: LiteraturePaperSummaryFile,
  maxBytes: number,
) => Promise<string | null>

export interface PaperDirectoryIdentity {
  directory: string
  source: LiteraturePaperSummarySource
  sourceId: string
  shortId: string
}

interface PaperBundle {
  identity: PaperDirectoryIdentity
  files: Map<string, LiteraturePaperSummaryFile>
}

const SCIVERSE_DIRECTORY = /^references\/papers\/(sciverse-([a-f0-9]{64})-[a-f0-9]{10})$/
const ARXIV_DIRECTORY = /^references\/papers\/(arxiv-([a-z0-9._-]{1,72})-[a-f0-9]{10})$/
const SUPPORTED_RELATIVE_PATHS = new Set([
  'metadata.json',
  'source-fulltext.md',
  'original.pdf',
  'parsed/fulltext.md',
])

function normalizeDisplayText(value: string, maxLength = 300): string {
  const normalized = value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`
}

/** Accept only directories produced by LiteratureService.paperDirectory(). */
export function parsePaperSummaryDirectory(path: string): PaperDirectoryIdentity | null {
  const normalized = path.replace(/^\/+/, '')
  const sciverse = SCIVERSE_DIRECTORY.exec(normalized)
  if (sciverse) {
    const sourceId = sciverse[2]
    return {
      directory: normalized,
      source: 'sciverse',
      sourceId,
      shortId: sourceId.length > 12 ? `${sourceId.slice(0, 12)}…` : sourceId,
    }
  }
  const arxiv = ARXIV_DIRECTORY.exec(normalized)
  if (!arxiv) return null
  return {
    directory: normalized,
    source: 'arxiv',
    sourceId: arxiv[2],
    shortId: arxiv[2],
  }
}

export function parsePaperSummaryFile(path: string): {
  identity: PaperDirectoryIdentity
  relativePath: string
} | null {
  const normalized = path.replace(/^\/+/, '')
  const splitAt = normalized.lastIndexOf('/')
  if (splitAt <= 0) return null

  // parsed/fulltext.md is the only supported nested summary candidate.
  const directory = normalized.endsWith('/parsed/fulltext.md')
    ? normalized.slice(0, -'/parsed/fulltext.md'.length)
    : normalized.slice(0, splitAt)
  const relativePath = normalized.slice(directory.length + 1)
  if (!SUPPORTED_RELATIVE_PATHS.has(relativePath)) return null
  const identity = parsePaperSummaryDirectory(directory)
  return identity ? { identity, relativePath } : null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? normalizeDisplayText(value) || undefined : undefined
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function isPlaceholderTitle(title: string, identity: PaperDirectoryIdentity, paper: Record<string, unknown>): boolean {
  const normalized = normalizeDisplayText(title).toLocaleLowerCase()
  if (/^(untitled|unknown(?: title)?|title unavailable|no title|n\/?a|未命名|未知标题|标题不可用)$/.test(normalized)) {
    return true
  }
  const ref = objectValue(paper.ref)
  const ids = [
    identity.sourceId,
    stringValue(ref?.sourceId),
    stringValue(ref?.documentId),
    stringValue(ref?.uniqueId),
  ].filter((value): value is string => Boolean(value)).map(value => value.toLocaleLowerCase())
  return ids.includes(normalized)
    || ids.some(id => normalized === `sciverse document ${id}`)
}

export function extractPaperTitleFromMetadata(
  raw: string,
  identity: PaperDirectoryIdentity,
): string | undefined {
  try {
    const root = objectValue(JSON.parse(raw))
    const paper = objectValue(root?.paper)
    const title = stringValue(paper?.title)
    if (!paper || !title || isPlaceholderTitle(title, identity, paper)) return undefined
    return title
  } catch {
    return undefined
  }
}

export function extractFirstPaperHeading(markdown: string): string | undefined {
  const match = markdown.match(/^[\t ]*#(?!#)[\t ]+(.+?)[\t ]*#*[\t ]*$/m)
  if (!match) return undefined
  const title = match[1]
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/<[^>]+>/g, '')
  return normalizeDisplayText(title) || undefined
}

function fallbackTitle(identity: PaperDirectoryIdentity): string {
  return `${identity.source === 'arxiv' ? 'arXiv' : 'Sciverse'} · ${identity.shortId}`
}

function preferredPrimaryPath(bundle: PaperBundle): string {
  const order = bundle.identity.source === 'arxiv'
    ? ['original.pdf', 'parsed/fulltext.md', 'metadata.json']
    : ['source-fulltext.md', 'metadata.json']
  for (const relativePath of order) {
    const file = bundle.files.get(relativePath)
    if (file) return file.path
  }
  return bundle.files.values().next().value?.path ?? `${bundle.identity.directory}/metadata.json`
}

/**
 * Build one bounded summary per public literature bundle. The caller owns byte
 * access, which keeps this pure helper independent from MongoDB and GridFS.
 */
export async function buildLiteraturePaperSummaries(
  files: readonly LiteraturePaperSummaryFile[],
  readPrefix: LiteraturePaperPrefixReader,
): Promise<LiteraturePaperSummary[]> {
  const bundles = new Map<string, PaperBundle>()
  for (const file of files.slice(0, MAX_PAPER_SUMMARY_FILES)) {
    if (!['public', 'managed_reference'].includes(file.visibility)) continue
    const parsed = parsePaperSummaryFile(file.path)
    if (!parsed) continue
    let bundle = bundles.get(parsed.identity.directory)
    if (!bundle) {
      bundle = { identity: parsed.identity, files: new Map() }
      bundles.set(parsed.identity.directory, bundle)
    }
    bundle.files.set(parsed.relativePath, file)
  }

  const summaries = await mapWithConcurrency(
    [...bundles.values()],
    PAPER_SUMMARY_READ_CONCURRENCY,
    async bundle => {
      let title: string | undefined
      const metadata = bundle.files.get('metadata.json')
      if (metadata && metadata.sizeBytes <= MAX_PAPER_METADATA_BYTES) {
        const raw = await readPrefix(metadata, MAX_PAPER_METADATA_BYTES)
        if (raw !== null) title = extractPaperTitleFromMetadata(raw, bundle.identity)
      }

    const fulltext = bundle.files.get('source-fulltext.md')
      ?? bundle.files.get('parsed/fulltext.md')
    if (fulltext && (!title || title === title.toLocaleLowerCase())) {
      const prefix = await readPrefix(fulltext, MAX_PAPER_HEADING_BYTES)
      const heading = prefix === null ? undefined : extractFirstPaperHeading(prefix)
      if (
        heading
        && (!title || title.toLocaleLowerCase() === heading.toLocaleLowerCase())
      ) title = heading
    }

      return {
        directory: bundle.identity.directory,
        title: title ?? fallbackTitle(bundle.identity),
        source: bundle.identity.source,
        primaryPath: preferredPrimaryPath(bundle),
      }
    },
  )

  return summaries.sort((left, right) => left.directory.localeCompare(right.directory))
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  if (values.length === 0) return []
  const results = new Array<R>(values.length)
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor
        cursor += 1
        results[index] = await mapper(values[index])
      }
    },
  )
  await Promise.all(workers)
  return results
}
