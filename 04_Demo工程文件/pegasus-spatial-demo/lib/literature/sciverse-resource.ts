import sharp from 'sharp'
import {
  fetchWithTimeout,
  readResponseBuffer,
  type FetchImplementation,
} from './http'

const DEFAULT_BASE_URL = 'https://api.sciverse.space'
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_MAX_BYTES = 12 * 1024 * 1024
const MAX_REF_CHARS = 1_024
const MAX_IMAGE_PIXELS = 100_000_000
const SAFE_RASTER_MIME_BY_FORMAT: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
}

const SCIVERSE_SOURCE_PATH = /^references\/papers\/sciverse-[a-f0-9]{64}-[a-f0-9]{10}\/source-fulltext\.md$/
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i

export type SciverseResourceErrorCode =
  | 'invalid_source_path'
  | 'invalid_ref'
  | 'not_configured'
  | 'upstream_timeout'
  | 'upstream_failure'
  | 'invalid_image'

export class SciverseResourceError extends Error {
  readonly code: SciverseResourceErrorCode
  readonly status: number

  constructor(code: SciverseResourceErrorCode, message: string, status: number) {
    super(message)
    this.name = 'SciverseResourceError'
    this.code = code
    this.status = status
  }
}

export interface SciverseImageResource {
  bytes: Buffer
  contentType: string
  format: string
  width: number
  height: number
}

export interface FetchSciverseImageResourceOptions {
  token?: string
  baseUrl?: string
  fetchImpl?: FetchImplementation
  timeoutMs?: number
  maxBytes?: number
  signal?: AbortSignal
}

/** Only immutable Sciverse provider-fulltext artifacts may authorize a resource request. */
export function assertSciverseSourceFulltextPath(sourcePath: string): string {
  if (!SCIVERSE_SOURCE_PATH.test(sourcePath)) {
    throw new SciverseResourceError(
      'invalid_source_path',
      'source_path must identify a saved Sciverse source-fulltext.md artifact',
      400,
    )
  }
  return sourcePath
}

/**
 * Accept a provider-owned relative filename/path, never a caller-selected URL.
 * Validation is repeated after percent decoding so encoded traversal and host
 * escapes cannot be smuggled into the fixed Sciverse resource endpoint.
 */
export function assertSciverseProviderResourceRef(ref: string): string {
  if (!ref || ref.length > MAX_REF_CHARS || ref !== ref.trim()) {
    throw invalidRef()
  }

  let candidate = ref
  for (let pass = 0; pass < 8; pass += 1) {
    assertRelativeRefLayer(candidate)
    let decoded: string
    try {
      decoded = decodeURIComponent(candidate)
    } catch {
      throw invalidRef()
    }
    if (decoded === candidate) break
    candidate = decoded
  }
  assertRelativeRefLayer(candidate)
  return ref
}

/**
 * Confirm that the exact destination occurs in Markdown image syntax. This is
 * deliberately not a substring check: the owned source document is the
 * capability that authorizes fetching one provider resource.
 */
export function markdownHasExactImageReference(markdown: string, ref: string): boolean {
  assertSciverseProviderResourceRef(ref)
  return extractMarkdownImageReferences(markdown).has(ref)
}

/** Parse the provider refs once so a paper with many figures need not rescan its full text per image. */
export function extractMarkdownImageReferences(markdown: string): Set<string> {
  const references = new Set<string>()
  for (let cursor = 0; cursor < markdown.length;) {
    const marker = markdown.indexOf('![', cursor)
    if (marker < 0) break
    cursor = marker + 2
    if (isEscaped(markdown, marker)) continue

    const altEnd = findUnescaped(markdown, ']', cursor)
    if (altEnd < 0 || markdown[altEnd + 1] !== '(') continue
    const destination = readMarkdownDestination(markdown, altEnd + 2)
    if (!destination) continue
    cursor = Math.max(cursor, destination.end + 1)
    try {
      references.add(assertSciverseProviderResourceRef(destination.value))
    } catch {
      // Malicious or malformed source references never become capabilities.
    }
  }
  return references
}

/** Fetch and decode-check one image through Sciverse's fixed resource API. */
export async function fetchSciverseImageResource(
  refInput: string,
  options: FetchSciverseImageResourceOptions = {},
): Promise<SciverseImageResource> {
  const ref = assertSciverseProviderResourceRef(refInput)
  const token = options.token === undefined
    ? process.env.SCIVERSE_API_TOKEN?.trim()
    : options.token.trim()
  if (!token) {
    throw new SciverseResourceError(
      'not_configured',
      'Sciverse image resources are unavailable',
      503,
    )
  }

  const endpoint = buildSciverseResourceUrl(
    ref,
    options.baseUrl
      ?? process.env.SCIVERSE_API_BASE_URL
      ?? process.env.SCIVERSE_BASE_URL
      ?? DEFAULT_BASE_URL,
  )
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES

  let response: Response
  try {
    response = await fetchWithTimeout(
      fetchImpl,
      endpoint,
      {
        method: 'GET',
        headers: {
          Accept: 'image/*',
          Authorization: `Bearer ${token}`,
        },
        redirect: 'manual',
        cache: 'no-store',
      },
      timeoutMs,
      options.signal,
    )
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new SciverseResourceError('upstream_timeout', 'Sciverse image request timed out', 504)
    }
    throw new SciverseResourceError('upstream_failure', 'Sciverse image request failed', 502)
  }

  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined)
    throw new SciverseResourceError('upstream_failure', 'Sciverse image redirects are not allowed', 502)
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new SciverseResourceError('upstream_failure', 'Sciverse image request was rejected', 502)
  }

  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (!contentType?.startsWith('image/')) {
    await response.body?.cancel().catch(() => undefined)
    throw new SciverseResourceError('invalid_image', 'Sciverse resource is not an image', 502)
  }

  let bytes: Buffer
  try {
    bytes = await readResponseBuffer(response, maxBytes, options.signal)
  } catch {
    throw new SciverseResourceError('invalid_image', 'Sciverse image exceeds the size limit', 502)
  }
  if (bytes.length === 0) {
    throw new SciverseResourceError('invalid_image', 'Sciverse returned an empty image', 502)
  }

  try {
    const metadata = await sharp(bytes, {
      animated: true,
      failOn: 'error',
      limitInputPixels: MAX_IMAGE_PIXELS,
    }).metadata()
    if (
      !metadata.format
      || !Number.isSafeInteger(metadata.width)
      || !Number.isSafeInteger(metadata.height)
      || (metadata.width ?? 0) <= 0
      || (metadata.height ?? 0) <= 0
    ) {
      throw new Error('Image dimensions are unavailable')
    }
    const decodedContentType = SAFE_RASTER_MIME_BY_FORMAT[metadata.format]
    const normalizedHeaderType = contentType === 'image/jpg' ? 'image/jpeg' : contentType
    if (!decodedContentType || decodedContentType !== normalizedHeaderType) {
      throw new Error('Image type does not match a supported decoded raster format')
    }
    return {
      bytes,
      contentType: decodedContentType,
      format: metadata.format,
      width: metadata.width as number,
      height: metadata.height as number,
    }
  } catch {
    throw new SciverseResourceError('invalid_image', 'Sciverse returned an invalid image', 502)
  }
}

export function buildSciverseResourceUrl(refInput: string, baseUrlInput: string): URL {
  const ref = assertSciverseProviderResourceRef(refInput)
  let baseUrl: URL
  try {
    baseUrl = new URL(baseUrlInput.trim())
  } catch {
    throw new SciverseResourceError('not_configured', 'Sciverse API base URL is invalid', 503)
  }
  if (
    !['https:', 'http:'].includes(baseUrl.protocol)
    || baseUrl.username
    || baseUrl.password
    || baseUrl.search
    || baseUrl.hash
  ) {
    throw new SciverseResourceError('not_configured', 'Sciverse API base URL is invalid', 503)
  }

  baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, '')}/resource`
  baseUrl.searchParams.set('file_name', ref)
  return baseUrl
}

function invalidRef(): SciverseResourceError {
  return new SciverseResourceError(
    'invalid_ref',
    'ref must be a bounded provider-relative image reference',
    400,
  )
}

function assertRelativeRefLayer(value: string): void {
  if (
    !value
    || value.length > MAX_REF_CHARS
    || CONTROL_CHARACTERS.test(value)
    || value.includes('\\')
    || value.startsWith('/')
    || value.startsWith('//')
    || URI_SCHEME.test(value)
  ) {
    throw invalidRef()
  }
  const path = value.split(/[?#]/, 1)[0]
  if (path.split('/').some(segment => segment === '.' || segment === '..')) {
    throw invalidRef()
  }
}

function isEscaped(value: string, index: number): boolean {
  let slashes = 0
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) slashes += 1
  return slashes % 2 === 1
}

function findUnescaped(value: string, target: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    if (value[index] === target && !isEscaped(value, index)) return index
    if (value[index] === '\n') return -1
  }
  return -1
}

function readMarkdownDestination(
  markdown: string,
  start: number,
): { value: string; end: number } | null {
  let cursor = start
  while (markdown[cursor] === ' ' || markdown[cursor] === '\t') cursor += 1
  if (markdown[cursor] === '<') {
    const end = findUnescaped(markdown, '>', cursor + 1)
    if (end < 0) return null
    const imageEnd = findMarkdownImageEnd(markdown, end + 1)
    if (imageEnd < 0) return null
    return { value: unescapeMarkdown(markdown.slice(cursor + 1, end)), end: imageEnd }
  }

  const destinationStart = cursor
  let nestedParentheses = 0
  for (; cursor < markdown.length; cursor += 1) {
    const character = markdown[cursor]
    if (character === '\n' || character === '\r') return null
    if (isEscaped(markdown, cursor)) continue
    if (character === '(') {
      nestedParentheses += 1
      continue
    }
    if (character === ')') {
      if (nestedParentheses === 0) {
        if (cursor === destinationStart) return null
        return {
          value: unescapeMarkdown(markdown.slice(destinationStart, cursor)),
          end: cursor,
        }
      }
      nestedParentheses -= 1
      continue
    }
    if ((character === ' ' || character === '\t') && nestedParentheses === 0) {
      if (cursor === destinationStart) return null
      const imageEnd = findMarkdownImageEnd(markdown, cursor)
      if (imageEnd < 0) return null
      return {
        value: unescapeMarkdown(markdown.slice(destinationStart, cursor)),
        end: imageEnd,
      }
    }
  }
  return null
}

function findMarkdownImageEnd(markdown: string, start: number): number {
  let cursor = start
  while (markdown[cursor] === ' ' || markdown[cursor] === '\t') cursor += 1
  if (markdown[cursor] === ')') return cursor

  const opener = markdown[cursor]
  const closer = opener === '"' ? '"' : opener === "'" ? "'" : opener === '(' ? ')' : null
  if (!closer) return -1
  cursor += 1
  for (; cursor < markdown.length; cursor += 1) {
    if (markdown[cursor] === '\n' || markdown[cursor] === '\r') return -1
    if (markdown[cursor] === closer && !isEscaped(markdown, cursor)) break
  }
  if (cursor >= markdown.length) return -1
  cursor += 1
  while (markdown[cursor] === ' ' || markdown[cursor] === '\t') cursor += 1
  return markdown[cursor] === ')' ? cursor : -1
}

function unescapeMarkdown(value: string): string {
  return value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~\\])/g, '$1')
}
