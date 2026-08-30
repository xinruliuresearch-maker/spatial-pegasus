import type { WorkspaceArtifact } from '@/hooks/useWorkspaceArtifacts'

export type LiteratureSource = 'sciverse' | 'arxiv'

export type LiteratureArtifactRole =
  | 'source-fulltext'
  | 'parsed-fulltext'
  | 'original-pdf'
  | 'metadata'
  | 'provenance'
  | 'blocks'
  | 'parser-provenance'
  | 'other'

export interface LiteratureArtifactIdentity {
  directory: string
  source: LiteratureSource
  sourceId: string
  shortId: string
  role: LiteratureArtifactRole
}

export interface LiteraturePaperRef {
  source?: string
  sourceId?: string
  version?: string
  uniqueId?: string
  documentId?: string
}

export interface LiteraturePaperMetadata {
  title?: string
  authors: string[]
  abstract?: string
  publishedAt?: string
  updatedAt?: string
  publishedYear?: number
  venue?: string
  doi?: string
  landingUrl?: string
  documentUrl?: string
  license?: string
  licenseUrl?: string
  citationCount?: number
  influentialCitationCount?: number
  categories: string[]
  ref?: LiteraturePaperRef
  storedContent?: {
    path?: string
    kind?: string
    mimeType?: string
  }
}

export interface LiteratureProvenance {
  provider?: string
  externalId?: string
  retrievedAt?: string
  providerVersion?: string
  version?: string
  canonicalUrl?: string
  landingUrl?: string
  license?: string
  licenseUrl?: string
  searchRecordPath?: string
  content?: {
    path?: string
    kind?: string
    mimeType?: string
    sizeBytes?: number
    sha256?: string
  }
}

export interface LiteratureBundleArtifacts {
  sourceFulltext?: WorkspaceArtifact
  parsedFulltext?: WorkspaceArtifact
  originalPdf?: WorkspaceArtifact
  metadata?: WorkspaceArtifact
  provenance?: WorkspaceArtifact
  blocks?: WorkspaceArtifact
  parserProvenance?: WorkspaceArtifact
}

export interface ScientificDocumentSections {
  /** Publisher-supplied byline, affiliations, dates, and other masthead text. */
  frontMatter?: string
  /** The complete readable body. No source text is discarded by this split. */
  body: string
}

export type ScientificImageSource =
  | { kind: 'proxy'; url: string }
  | { kind: 'external'; url: string }
  | { kind: 'blocked' }

const PAPER_PATH = /^references\/papers\/(sciverse|arxiv)-(.+)-([a-f0-9]{10})(?:\/(.+))?$/
const SCIVERSE_SOURCE_PATH = /^references\/papers\/sciverse-[a-f0-9]{64}-[a-f0-9]{10}\/source-fulltext\.md$/
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized || undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const direct = stringValue(item)
    if (direct) return [direct]
    const record = objectValue(item)
    const name = stringValue(record?.name)
      ?? stringValue(record?.fullName)
      ?? stringValue(record?.displayName)
    return name ? [name] : []
  })
}

function roleFor(relativePath: string | undefined): LiteratureArtifactRole {
  if (!relativePath) return 'other'
  if (relativePath === 'source-fulltext.md') return 'source-fulltext'
  if (relativePath === 'parsed/fulltext.md') return 'parsed-fulltext'
  if (relativePath === 'original.pdf') return 'original-pdf'
  if (relativePath === 'metadata.json') return 'metadata'
  if (relativePath === 'provenance.json') return 'provenance'
  if (relativePath === 'parsed/blocks.jsonl') return 'blocks'
  if (relativePath === 'parsed/parser-provenance.json') return 'parser-provenance'
  return 'other'
}

function shortSourceId(source: LiteratureSource, sourceId: string): string {
  if (source === 'arxiv') return sourceId
  return sourceId.length > 12 ? `${sourceId.slice(0, 12)}…` : sourceId
}

/** Parse only immutable literature bundles under references/papers. */
export function parseLiteratureArtifactPath(path: string): LiteratureArtifactIdentity | null {
  const normalized = path.replace(/^\/+/, '')
  const match = normalized.match(PAPER_PATH)
  if (!match) return null
  const [, sourceRaw, sourceId, bundleHash, relativePath] = match
  const source = sourceRaw as LiteratureSource
  const directory = `references/papers/${source}-${sourceId}-${bundleHash}`
  return {
    directory,
    source,
    sourceId,
    shortId: shortSourceId(source, sourceId),
    role: roleFor(relativePath),
  }
}

export function collectLiteratureBundleArtifacts(
  activePath: string,
  artifacts: readonly WorkspaceArtifact[],
): LiteratureBundleArtifacts {
  const active = parseLiteratureArtifactPath(activePath)
  if (!active) return {}
  const result: LiteratureBundleArtifacts = {}
  for (const artifact of artifacts) {
    const identity = parseLiteratureArtifactPath(artifact.path)
    if (!identity || identity.directory !== active.directory) continue
    if (identity.role === 'source-fulltext') result.sourceFulltext = artifact
    if (identity.role === 'parsed-fulltext') result.parsedFulltext = artifact
    if (identity.role === 'original-pdf') result.originalPdf = artifact
    if (identity.role === 'metadata') result.metadata = artifact
    if (identity.role === 'provenance') result.provenance = artifact
    if (identity.role === 'blocks') result.blocks = artifact
    if (identity.role === 'parser-provenance') result.parserProvenance = artifact
  }
  return result
}

/** Parse the public, bounded literature metadata envelope without trusting its shape. */
export function parseLiteratureMetadata(raw: string): LiteraturePaperMetadata | null {
  if (!raw.trim()) return null
  try {
    const root = objectValue(JSON.parse(raw))
    const paper = objectValue(root?.paper)
    if (!root || !paper) return null
    const refRaw = objectValue(paper.ref)
    const storedRaw = objectValue(root.storedContent)
    return {
      title: stringValue(paper.title),
      authors: normalizeAuthors(stringList(paper.authors)),
      abstract: stringValue(paper.abstract),
      publishedAt: stringValue(paper.publishedAt),
      updatedAt: stringValue(paper.updatedAt),
      publishedYear: numberValue(paper.publishedYear),
      venue: stringValue(paper.venue),
      doi: stringValue(paper.doi),
      landingUrl: safeHttpUrl(stringValue(paper.landingUrl)),
      documentUrl: safeHttpUrl(stringValue(paper.documentUrl)),
      license: stringValue(paper.license),
      licenseUrl: safeHttpUrl(stringValue(paper.licenseUrl)),
      citationCount: numberValue(paper.citationCount),
      influentialCitationCount: numberValue(paper.influentialCitationCount),
      categories: normalizeAuthors(stringList(paper.categories)),
      ref: refRaw ? {
        source: stringValue(refRaw.source),
        sourceId: stringValue(refRaw.sourceId),
        version: stringValue(refRaw.version),
        uniqueId: stringValue(refRaw.uniqueId),
        documentId: stringValue(refRaw.documentId),
      } : undefined,
      storedContent: storedRaw ? {
        path: stringValue(storedRaw.path),
        kind: stringValue(storedRaw.kind),
        mimeType: stringValue(storedRaw.mimeType),
      } : undefined,
    }
  } catch {
    return null
  }
}

export function parseLiteratureProvenance(raw: string): LiteratureProvenance | null {
  if (!raw.trim()) return null
  try {
    const root = objectValue(JSON.parse(raw))
    if (!root) return null
    const content = objectValue(root.content)
    return {
      provider: stringValue(root.provider),
      externalId: stringValue(root.externalId),
      retrievedAt: stringValue(root.retrievedAt),
      providerVersion: stringValue(root.providerVersion),
      version: stringValue(root.version),
      canonicalUrl: safeHttpUrl(stringValue(root.canonicalUrl)),
      landingUrl: safeHttpUrl(stringValue(root.landingUrl)),
      license: stringValue(root.license),
      licenseUrl: safeHttpUrl(stringValue(root.licenseUrl)),
      searchRecordPath: stringValue(root.searchRecordPath),
      content: content ? {
        path: stringValue(content.path),
        kind: stringValue(content.kind),
        mimeType: stringValue(content.mimeType),
        sizeBytes: numberValue(content.sizeBytes),
        sha256: stringValue(content.sha256),
      } : undefined,
    }
  } catch {
    return null
  }
}

/** De-duplicate case/diacritic and `last, first` aliases, keeping the best display spelling. */
export function normalizeAuthors(authors: readonly string[]): string[] {
  const result: Array<{ identity: string; display: string; score: number }> = []
  const positions = new Map<string, number>()
  for (const author of authors) {
    const normalized = author.normalize('NFKC').replace(/\s+/g, ' ').trim()
    if (!normalized) continue
    const identity = authorIdentity(normalized)
    const score = authorDisplayScore(normalized)
    const existingIndex = positions.get(identity)
    if (existingIndex === undefined) {
      positions.set(identity, result.length)
      result.push({ identity, display: normalized, score })
    } else if (score > result[existingIndex].score) {
      result[existingIndex] = { identity, display: normalized, score }
    }
  }
  return result.map(item => item.display)
}

function authorIdentity(value: string): string {
  const [left, ...rightParts] = value.split(',')
  const reordered = rightParts.length > 0
    ? `${rightParts.join(' ')} ${left}`
    : value
  return reordered
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

function authorDisplayScore(value: string): number {
  const uppercase = value.match(/\p{Lu}/gu)?.length ?? 0
  const diacritics = [...value].filter(character => (
    character.normalize('NFD').replace(/\p{M}+/gu, '') !== character
  )).length
  const expandedNames = value.match(/\p{L}{3,}/gu)?.length ?? 0
  const commaPenalty = value.includes(',') ? 1 : 0
  return uppercase * 5 + diacritics * 4 + expandedNames * 2 - commaPenalty
}

export function extractFirstMarkdownHeading(markdown: string): string | undefined {
  const match = markdown.slice(0, 2_048).match(/^[\t ]*#(?!#)[\t ]+(.+?)[\t ]*#*[\t ]*$/m)
  if (!match) return undefined
  const plain = match[1]
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain || undefined
}

export function stripFirstMarkdownHeading(markdown: string): string {
  const prefix = markdown.slice(0, 2_048)
  const match = /^[\t ]*#(?!#)[\t ]+.+?[\t ]*#*[\t ]*$/m.exec(prefix)
  if (!match) return markdown
  let end = match.index + match[0].length
  const followingLineBreak = markdown.slice(end).match(/^\r?\n/)
  if (followingLineBreak) end += followingLineBreak[0].length
  return `${markdown.slice(0, match.index)}${markdown.slice(end)}`
}

const FRONT_MATTER_SCAN_LINES = 120
const FRONT_MATTER_SCAN_CHARACTERS = 20_000
const ATX_HEADING = /^[\t ]{0,3}#{1,6}[\t ]+(.+?)[\t ]*#*[\t ]*$/
const INLINE_ABSTRACT = /^[\t ]*(?:\*\*|__)?(abstract|summary)(?:\*\*|__)?[\t ]*[:\u2014\u2013-][\t ]*(.*)$/i

function plainHeadingLabel(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isOpeningSectionHeading(value: string): boolean {
  const normalized = plainHeadingLabel(value)
    .replace(/^\d+(?:\.\d+)*[.)]?[\t ]*/, '')
    .toLocaleLowerCase()
  return /^(abstract|summary)(?:\b|$)/.test(normalized)
}

function isIntroductionHeading(value: string): boolean {
  const normalized = plainHeadingLabel(value)
    .replace(/^\d+(?:\.\d+)*[.)]?[\t ]*/, '')
    .toLocaleLowerCase()
  return /^(introduction|background)(?:\b|$)/.test(normalized)
}

function looksLikePublisherFrontMatter(value: string): boolean {
  if (!value.trim()) return false
  const lifecycle = /\b(received|accepted|revised|published|publication|available online|copyright)\b/i.test(value)
  const affiliation = /\b(department|university|institute|institution|hospital|laborator(?:y|ies)|school of|faculty of|centre|center)\b/i.test(value)
  const correspondence = /\b(correspond(?:ing|ence)|e-?mail|doi|issn)\b|\S+@\S+\.\S+/i.test(value)
  const firstNonEmpty = value.split(/\r?\n/).find(line => line.trim()) ?? ''
  const bylineLike = (firstNonEmpty.match(/[,;·]/g)?.length ?? 0) >= 2
    || (firstNonEmpty.match(/\b[A-Z]\./g)?.length ?? 0) >= 2
  return lifecycle || correspondence || (affiliation && bylineLike)
}

/**
 * Separate a provider masthead from the readable article body without losing
 * source text. Sciverse often emits author, affiliation, and publication-date
 * paragraphs between the document title and `SUMMARY` / `ABSTRACT`. Those
 * paragraphs remain available in a disclosure instead of masquerading as body
 * prose. Inline `Abstract: ...` is promoted to a section heading so the abstract
 * is never hidden with the masthead.
 */
export function splitScientificFrontMatter(markdownAfterTitle: string): ScientificDocumentSections {
  const lines = markdownAfterTitle.split(/\r?\n/)
  const scanLimit = Math.min(lines.length, FRONT_MATTER_SCAN_LINES)
  let scannedCharacters = 0

  for (let index = 0; index < scanLimit; index += 1) {
    const line = lines[index]
    scannedCharacters += line.length + 1
    if (scannedCharacters > FRONT_MATTER_SCAN_CHARACTERS) break

    const inlineAbstract = line.match(INLINE_ABSTRACT)
    if (inlineAbstract) {
      const frontMatter = lines.slice(0, index).join('\n').trim()
      const label = inlineAbstract[1].toLocaleLowerCase() === 'summary' ? 'Summary' : 'Abstract'
      const openingText = inlineAbstract[2].trim()
      const remainder = lines.slice(index + 1).join('\n').trimStart()
      const promoted = [`# ${label}`, openingText, remainder]
        .filter((part, partIndex) => partIndex === 0 || part.length > 0)
        .join('\n\n')
      return { frontMatter: frontMatter || undefined, body: promoted }
    }

    const heading = line.match(ATX_HEADING)
    if (!heading) continue
    const frontMatter = lines.slice(0, index).join('\n').trim()
    if (!frontMatter) return { body: markdownAfterTitle }
    if (
      isOpeningSectionHeading(heading[1])
      || (isIntroductionHeading(heading[1]) && looksLikePublisherFrontMatter(frontMatter))
    ) {
      return {
        frontMatter,
        body: lines.slice(index).join('\n').trimStart(),
      }
    }
  }

  return { body: markdownAfterTitle }
}

/** Conservative DOI fallback for provider metadata gaps; never invents a DOI. */
export function extractDoiFromMarkdown(markdown: string): string | undefined {
  const prefix = markdown.slice(0, 20_000)
  const match = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i.exec(prefix)
  return match?.[0].replace(/[.,;:]+$/, '')
}

export function resolvePaperTitle(
  metadata: LiteraturePaperMetadata | null,
  markdown: string,
  identity: LiteratureArtifactIdentity,
): string {
  const heading = extractFirstMarkdownHeading(markdown)
  if (metadata?.title && !isPlaceholderTitle(metadata.title, metadata.ref)) {
    const metadataTitle = metadata.title
    if (
      heading
      && metadataTitle.toLocaleLowerCase() === heading.toLocaleLowerCase()
      && metadataTitle === metadataTitle.toLocaleLowerCase()
      && heading !== heading.toLocaleLowerCase()
    ) return heading
    return metadataTitle
  }
  return heading ?? `${identity.source === 'sciverse' ? 'Sciverse' : 'arXiv'} ${identity.shortId}`
}

export function isPlaceholderTitle(title: string, ref?: LiteraturePaperRef): boolean {
  const normalized = title.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase()
  if (!normalized) return true
  if (/^(untitled|unknown(?: title)?|title unavailable|no title|n\/?a|未命名|未知标题|标题不可用)$/.test(normalized)) {
    return true
  }
  const sourceIds = [ref?.sourceId, ref?.documentId, ref?.uniqueId]
    .flatMap(value => value ? [value.trim().toLocaleLowerCase()] : [])
  if (sourceIds.includes(normalized)) return true
  return sourceIds.some(id => normalized === `sciverse document ${id}`)
}

export function safeHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

function assertSafeProviderRef(value: string): boolean {
  if (!value || value.length > 1_024 || value !== value.trim()) return false
  let candidate = value
  for (let pass = 0; pass < 3; pass += 1) {
    if (
      CONTROL_CHARACTERS.test(candidate)
      || candidate.startsWith('/')
      || candidate.startsWith('\\')
      || candidate.includes('\\')
      || URI_SCHEME.test(candidate)
      || candidate.split(/[/?#]/, 1)[0] === '..'
      || candidate.split('/').some(segment => segment === '..')
    ) return false
    let decoded: string
    try {
      decoded = decodeURIComponent(candidate)
    } catch {
      return false
    }
    if (decoded === candidate) break
    candidate = decoded
  }
  return !candidate.split('/').some(segment => segment === '..')
}

export function classifyScientificImageSource(
  rawSource: string | undefined,
  conversationId: string | null,
  sourcePath: string,
): ScientificImageSource {
  if (!rawSource) return { kind: 'blocked' }
  const external = safeHttpUrl(rawSource)
  if (external) return { kind: 'external', url: external }
  if (
    !conversationId
    || !SCIVERSE_SOURCE_PATH.test(sourcePath)
    || !assertSafeProviderRef(rawSource)
  ) return { kind: 'blocked' }
  const params = new URLSearchParams({ source_path: sourcePath, ref: rawSource })
  return {
    kind: 'proxy',
    url: `/api/conversations/${encodeURIComponent(conversationId)}/literature/resource?${params.toString()}`,
  }
}
