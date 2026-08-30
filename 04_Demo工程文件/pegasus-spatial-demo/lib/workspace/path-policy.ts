const DEFAULT_ALLOWED_ROOTS = ['output', 'analysis', 'notes', 'references', '.sci-pegasus'] as const
const DEFAULT_ALLOWED_ROOT_FILES = ['MAP.md'] as const

export const WORKSPACE_MAX_FILES = 500
export const WORKSPACE_MAX_DEPTH = 8
export const WORKSPACE_MAX_PATH_LENGTH = 512
export const WORKSPACE_MAX_SEGMENT_LENGTH = 128

const SUPPORTED_EXTENSIONS = new Set([
  'md', 'txt', 'json', 'jsonl', 'xml', 'svg', 'html', 'css', 'js', 'jsx', 'ts', 'tsx', 'csv',
  'png', 'jpg', 'jpeg', 'webp', 'gif',
  'pdf', 'glb', 'gltf', 'ply', 'spz',
])

export const LEGACY_INTERNAL_PATH_ALIASES: Readonly<Record<string, string>> = Object.freeze({})

const LEGACY_INTERNAL_PATHS = new Set(Object.keys(LEGACY_INTERNAL_PATH_ALIASES))
const CANONICAL_TO_LEGACY_INTERNAL_PATH = new Map(
  Object.entries(LEGACY_INTERNAL_PATH_ALIASES).map(([legacy, canonical]) => [canonical, legacy]),
)

/** Normalize a path without weakening traversal checks. */
export function normalizeWorkspacePath(input: string): string {
  if (typeof input !== 'string') throw new Error('Workspace path must be a string')
  let path = input.normalize('NFC')
  if (path.startsWith('/workspace/')) path = path.slice('/workspace/'.length)
  else if (path.startsWith('workspace/')) path = path.slice('workspace/'.length)

  if (!path || path.length > WORKSPACE_MAX_PATH_LENGTH) {
    throw new Error(`Workspace path must be 1-${WORKSPACE_MAX_PATH_LENGTH} characters`)
  }
  if (path.startsWith('/') || path.includes('\\')) {
    throw new Error('Workspace paths must be relative and use forward slashes')
  }
  if (/\p{Cc}/u.test(path)) throw new Error('Workspace paths cannot contain control characters')

  const segments = path.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error('Workspace path contains an empty or unsafe segment')
  }
  if (segments.length > WORKSPACE_MAX_DEPTH) {
    throw new Error(`Workspace paths may contain at most ${WORKSPACE_MAX_DEPTH} segments`)
  }
  if (segments.some(segment => segment.length > WORKSPACE_MAX_SEGMENT_LENGTH)) {
    throw new Error(`Workspace path segments may contain at most ${WORKSPACE_MAX_SEGMENT_LENGTH} characters`)
  }
  return segments.join('/')
}

export function canonicalWorkspaceWritePath(input: string): string {
  const normalized = normalizeWorkspacePath(input)
  return LEGACY_INTERNAL_PATH_ALIASES[normalized] ?? normalized
}

export function assertWorkspaceWritePath(
  input: string,
  policy?: {
    allowedRoots?: readonly string[]
    allowedRootFiles?: readonly string[]
    maxDepth?: number
    maxPathLength?: number
    maxSegmentLength?: number
  },
): string {
  const path = canonicalWorkspaceWritePath(input)
  const roots = policy?.allowedRoots ?? DEFAULT_ALLOWED_ROOTS
  const rootFiles = policy?.allowedRootFiles ?? DEFAULT_ALLOWED_ROOT_FILES
  const segments = path.split('/')
  if (segments.length === 1) {
    if (!rootFiles.includes(path)) throw new Error(`Root-level workspace file is not allowed: ${path}`)
  } else if (!roots.includes(segments[0])) {
    throw new Error(`Workspace root is not allowed: ${segments[0]}`)
  }

  const extension = segments[segments.length - 1].split('.').pop()?.toLowerCase() ?? ''
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported workspace file extension: .${extension || '(none)'}`)
  }
  if (policy?.maxDepth && segments.length > policy.maxDepth) {
    throw new Error(`Workspace paths may contain at most ${policy.maxDepth} segments`)
  }
  if (policy?.maxPathLength && path.length > policy.maxPathLength) {
    throw new Error(`Workspace paths may contain at most ${policy.maxPathLength} characters`)
  }
  if (policy?.maxSegmentLength && segments.some(segment => segment.length > policy.maxSegmentLength!)) {
    throw new Error(`Workspace path segments may contain at most ${policy.maxSegmentLength} characters`)
  }
  return path
}

export function resolveExistingWorkspacePath(
  input: string,
  exists: (path: string) => boolean,
): string {
  const normalized = normalizeWorkspacePath(input)
  if (exists(normalized)) return normalized
  const alias = LEGACY_INTERNAL_PATH_ALIASES[normalized]
  if (alias && exists(alias)) return alias
  const legacy = CANONICAL_TO_LEGACY_INTERNAL_PATH.get(normalized)
  return legacy && exists(legacy) ? legacy : normalized
}

export function isInternalWorkspacePath(input: string): boolean {
  let normalized: string
  try {
    normalized = normalizeWorkspacePath(input)
  } catch {
    return true
  }
  return normalized === '.sci-pegasus'
    || normalized.startsWith('.sci-pegasus/')
    || LEGACY_INTERNAL_PATHS.has(normalized)
}

/**
 * Artifacts whose bytes or metadata are produced by literature tools.
 * They remain visible to the user, but generic Write/Edit and UI text editing
 * must not rewrite them because that would break source provenance.
 */
export function isManagedLiteratureArtifactPath(input: string): boolean {
  let normalized: string
  try {
    normalized = normalizeWorkspacePath(input)
  } catch {
    return false
  }
  if (/^references\/searches\/search-[a-z0-9_-]+\.json$/.test(normalized)) return true
  if (!/^references\/papers\/[^/]+\//.test(normalized)) return false
  return /\/(?:metadata\.json|provenance\.json|source-fulltext\.md|original\.pdf)$/.test(normalized)
    || normalized.includes('/parsed/')
}

export function buildVersionArchivePath(path: string, version: number): string {
  const normalized = normalizeWorkspacePath(path)
  const privateMatch = /^\.sci-pegasus\/agents\/([^/]+)\/(.+)$/.exec(normalized)
  if (privateMatch) {
    const [, agentId, relativePath] = privateMatch
    const relativeSlash = relativePath.lastIndexOf('/')
    const relativeFilename = relativeSlash >= 0 ? relativePath.slice(relativeSlash + 1) : relativePath
    const relativeParent = relativeSlash >= 0 ? relativePath.slice(0, relativeSlash) : ''
    const relativeDot = relativeFilename.lastIndexOf('.')
    const relativeStem = relativeDot > 0 ? relativeFilename.slice(0, relativeDot) : relativeFilename
    const relativeExtension = relativeDot > 0 ? relativeFilename.slice(relativeDot) : ''
    const relativeLogical = relativeParent ? `${relativeParent}/${relativeStem}` : relativeStem
    return `.sci-pegasus/agents/${agentId}/.versions/${relativeLogical}/v${version}${relativeExtension}`
  }
  const slash = normalized.lastIndexOf('/')
  const filename = slash >= 0 ? normalized.slice(slash + 1) : normalized
  const parent = slash >= 0 ? normalized.slice(0, slash) : ''
  const dot = filename.lastIndexOf('.')
  const stem = dot > 0 ? filename.slice(0, dot) : filename
  const extension = dot > 0 ? filename.slice(dot) : ''
  const logical = parent ? `${parent}/${stem}` : stem
  return `.sci-pegasus/versions/${logical}/v${version}${extension}`
}
