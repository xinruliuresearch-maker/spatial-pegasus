import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import {
  isManagedLiteratureArtifactPath,
  normalizeWorkspacePath,
} from './path-policy'
import {
  isDocumentFileEntry,
  isRasterFileEntry,
  type FileEntry,
} from './types'
import type {
  WorkspaceFileSnapshot,
  WorkspaceFileVisibility,
} from './multi-agent/types'

const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/
const PRIVATE_PATH = /^\.sci-pegasus\/agents\/([^/]+)\/(.+)$/
const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.jsonl', '.xml', '.svg', '.html', '.css',
  '.js', '.jsx', '.ts', '.tsx', '.csv',
])
const TEXT_APPLICATION_MIMES = new Set([
  'application/json',
  'application/ld+json',
  'application/x-ndjson',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'image/svg+xml',
])

export type ConversationWorkspaceExportSource = 'authoritative' | 'legacy'
export type ConversationWorkspaceExportStatus =
  | 'exported'
  | 'manifest_only_managed_reference'
  | 'manifest_only_binary'
  | 'manifest_only_unsupported_storage'
  | 'missing_content'
  | 'invalid_utf8'
  | 'integrity_mismatch'

export interface ConversationWorkspaceMarkdownExportInput {
  conversationId: string
  userId: string
  title: string
  workspaceId: string
  teamId?: string
  authoritativeFiles: readonly WorkspaceFileSnapshot[]
  legacyFiles?: Readonly<Record<string, FileEntry>>
  exportedAt?: Date
}

export interface ConversationWorkspaceGridFSReadRequest {
  objectId: string
  sourcePath: string
  source: ConversationWorkspaceExportSource
}

export type ConversationWorkspaceGridFSReader = (
  request: ConversationWorkspaceGridFSReadRequest,
) => Promise<Buffer | null>

export interface ConversationWorkspaceMarkdownExportRecord {
  source_path: string
  source: ConversationWorkspaceExportSource
  visibility: WorkspaceFileVisibility
  owner_agent_id: string | null
  writer_agent_id: string | null
  revision: number | null
  version_id: string | null
  kind: string
  storage_driver: string
  mime_type: string
  declared_size_bytes: number | null
  observed_size_bytes: number | null
  declared_sha256: string | null
  observed_sha256: string | null
  output_path: string | null
  status: ConversationWorkspaceExportStatus
}

export interface ConversationWorkspaceMarkdownExportFile {
  path: string
  content: string
}

export interface ConversationWorkspaceMarkdownExportPlan {
  conversation_id: string
  workspace_id: string
  exported_at: Date
  files: ConversationWorkspaceMarkdownExportFile[]
  records: ConversationWorkspaceMarkdownExportRecord[]
  manifest: string
  issue_count: number
}

interface ExportCandidate {
  path: string
  source: ConversationWorkspaceExportSource
  visibility: WorkspaceFileVisibility
  ownerAgentId: string | null
  writerAgentId: string | null
  revision: number | null
  versionId: string | null
  kind: string
  storageDriver: string
  gridfsObjectId: string | null
  mimeType: string
  declaredSizeBytes: number | null
  declaredSha256: string | null
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function optionalNonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

function optionalSha256(value: unknown): string | null {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null
}

function legacyVisibility(path: string): {
  visibility: WorkspaceFileVisibility
  ownerAgentId: string | null
} {
  const privateMatch = PRIVATE_PATH.exec(path)
  if (privateMatch) {
    if (!AGENT_ID.test(privateMatch[1])) throw new Error(`Unsafe private Agent id in ${path}`)
    return { visibility: 'agent_private', ownerAgentId: privateMatch[1] }
  }
  if (isManagedLiteratureArtifactPath(path)) {
    return { visibility: 'managed_reference', ownerAgentId: null }
  }
  return { visibility: 'public', ownerAgentId: null }
}

function legacyMimeType(path: string, entry: FileEntry): string {
  if ('mime_type' in entry && entry.mime_type?.trim()) return entry.mime_type.trim()
  const extension = extname(path).toLowerCase()
  if (extension === '.md') return 'text/markdown'
  if (extension === '.txt') return 'text/plain'
  if (extension === '.json') return 'application/json'
  if (extension === '.jsonl') return 'application/x-ndjson'
  if (extension === '.xml') return 'application/xml'
  if (extension === '.svg') return 'image/svg+xml'
  if (extension === '.csv') return 'text/csv'
  if (extension === '.pdf') return 'application/pdf'
  return 'application/octet-stream'
}

function legacyKind(path: string, entry: FileEntry, mimeType: string): string {
  if (isRasterFileEntry(entry)) return 'raster'
  if (isDocumentFileEntry(entry)) return 'document'
  if (mimeType.startsWith('image/') && mimeType !== 'image/svg+xml') return 'raster'
  if (extname(path).toLowerCase() === '.pdf') return 'document'
  return 'text'
}

function authoritativeCandidate(file: WorkspaceFileSnapshot): ExportCandidate {
  const path = normalizeWorkspacePath(file.path)
  const declaredSizeBytes = optionalNonNegativeInteger(file.metadata.size_bytes)
  const declaredSha256 = optionalSha256(file.metadata.sha256)
  if (
    !Number.isSafeInteger(file.revision)
    || file.revision < 1
    || !file.version_id?.trim()
    || !file.metadata.mime_type?.trim()
    || declaredSizeBytes === null
    || declaredSha256 === null
  ) {
    throw new Error(`Authoritative head has invalid immutable metadata: ${path}`)
  }
  if (file.storage_ref.driver === 'gridfs' && !file.storage_ref.object_id?.trim()) {
    throw new Error(`Authoritative GridFS head has no object id: ${path}`)
  }
  if (file.visibility === 'agent_private') {
    const privateMatch = PRIVATE_PATH.exec(path)
    if (
      !file.owner_agent_id
      || !AGENT_ID.test(file.owner_agent_id)
      || privateMatch?.[1] !== file.owner_agent_id
    ) {
      throw new Error(`Agent-private head has inconsistent ownership: ${path}`)
    }
  } else if (file.owner_agent_id) {
    throw new Error(`Non-private head unexpectedly has an owner: ${path}`)
  }
  return {
    path,
    source: 'authoritative',
    visibility: file.visibility,
    ownerAgentId: file.owner_agent_id ?? null,
    writerAgentId: file.writer.agent_id,
    revision: file.revision,
    versionId: file.version_id,
    kind: file.metadata.kind,
    storageDriver: file.storage_ref.driver,
    gridfsObjectId: file.storage_ref.driver === 'gridfs'
      ? file.storage_ref.object_id
      : null,
    mimeType: file.metadata.mime_type.trim(),
    declaredSizeBytes,
    declaredSha256,
  }
}

function legacyCandidate(pathInput: string, entry: FileEntry): ExportCandidate {
  const path = normalizeWorkspacePath(pathInput)
  const { visibility, ownerAgentId } = legacyVisibility(path)
  const mimeType = legacyMimeType(path, entry)
  const kind = legacyKind(path, entry, mimeType)
  return {
    path,
    source: 'legacy',
    visibility,
    ownerAgentId,
    writerAgentId: null,
    revision: optionalNonNegativeInteger(entry.version),
    versionId: null,
    kind,
    storageDriver: isRasterFileEntry(entry) ? 'asset' : 'gridfs',
    gridfsObjectId: isRasterFileEntry(entry) ? null : entry.gridfs_id,
    mimeType,
    declaredSizeBytes: isDocumentFileEntry(entry)
      ? optionalNonNegativeInteger(entry.size_bytes)
      : isRasterFileEntry(entry)
        ? optionalNonNegativeInteger(entry.size_bytes)
        : null,
    declaredSha256: isDocumentFileEntry(entry) ? optionalSha256(entry.sha256) : null,
  }
}

function candidates(input: ConversationWorkspaceMarkdownExportInput): ExportCandidate[] {
  const byPath = new Map<string, ExportCandidate>()
  for (const file of input.authoritativeFiles) {
    const candidate = authoritativeCandidate(file)
    if (byPath.has(candidate.path)) {
      throw new Error(`Duplicate authoritative WorkspaceFile head: ${candidate.path}`)
    }
    byPath.set(candidate.path, candidate)
  }
  for (const [path, entry] of Object.entries(input.legacyFiles ?? {})) {
    const candidate = legacyCandidate(path, entry)
    // A WorkspaceFile head is the sole authority for a migrated path,
    // including when that head is binary or managed-reference metadata only.
    if (!byPath.has(candidate.path)) byPath.set(candidate.path, candidate)
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path, 'en'))
}

function isTextCandidate(candidate: ExportCandidate): boolean {
  if (candidate.visibility === 'managed_reference') return false
  if (candidate.storageDriver !== 'gridfs' || !candidate.gridfsObjectId) return false
  if (candidate.kind === 'document' || candidate.kind === 'raster') return false
  const mime = candidate.mimeType.split(';', 1)[0].trim().toLowerCase()
  return mime.startsWith('text/')
    || TEXT_APPLICATION_MIMES.has(mime)
    || TEXT_EXTENSIONS.has(extname(candidate.path).toLowerCase())
}

function markdownOutputPath(candidate: ExportCandidate): string {
  let sourceRelativePath = candidate.path
  let partition = 'public'
  if (candidate.visibility === 'agent_private') {
    const owner = candidate.ownerAgentId
    const privateMatch = PRIVATE_PATH.exec(candidate.path)
    if (!owner || !privateMatch || privateMatch[1] !== owner) {
      throw new Error(`Cannot partition malformed private path: ${candidate.path}`)
    }
    partition = `agent-private/${owner}`
    sourceRelativePath = privateMatch[2]
  }
  const markdownPath = sourceRelativePath.toLowerCase().endsWith('.md')
    ? sourceRelativePath
    : `${sourceRelativePath}.md`
  return normalizeExportRelativePath(`${partition}/${markdownPath}`)
}

function normalizeExportRelativePath(pathInput: string): string {
  const normalized = pathInput.normalize('NFC')
  if (!normalized || normalized.startsWith('/') || normalized.includes('\\')) {
    throw new Error(`Export path must be a safe relative path: ${pathInput}`)
  }
  const segments = normalized.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || /\p{Cc}/u.test(segment))) {
    throw new Error(`Export path contains an unsafe segment: ${pathInput}`)
  }
  return segments.join('/')
}

function fenceFor(content: string): string {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map(run => run.length))
  return '`'.repeat(Math.max(3, longest + 1))
}

function languageFor(path: string, mimeType: string): string {
  const extension = extname(path).slice(1).toLowerCase()
  if (extension === 'jsonl') return 'jsonl'
  if (extension === 'tsx' || extension === 'jsx') return extension
  if (extension) return extension
  const mime = mimeType.toLowerCase()
  if (mime.includes('json')) return 'json'
  if (mime.includes('xml')) return 'xml'
  return 'text'
}

function renderTextAsMarkdown(path: string, mimeType: string, content: string): string {
  const extension = extname(path).toLowerCase()
  const baseMime = mimeType.split(';', 1)[0].trim().toLowerCase()
  if (extension === '.md' || baseMime === 'text/markdown') return content
  if (extension === '.txt' || baseMime === 'text/plain') return content
  const fence = fenceFor(content)
  const suffix = content.endsWith('\n') ? '' : '\n'
  return `${fence}${languageFor(path, mimeType)}\n${content}${suffix}${fence}\n`
}

function manifestOnlyStatus(candidate: ExportCandidate): ConversationWorkspaceExportStatus {
  if (candidate.visibility === 'managed_reference') return 'manifest_only_managed_reference'
  if (candidate.storageDriver !== 'gridfs') return 'manifest_only_unsupported_storage'
  return 'manifest_only_binary'
}

function cell(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/\|/g, '&#124;')
    .replace(/`/g, '&#96;')
    .replace(/[\r\n]+/g, ' ')
}

function renderManifest(
  input: ConversationWorkspaceMarkdownExportInput,
  exportedAt: Date,
  records: readonly ConversationWorkspaceMarkdownExportRecord[],
): string {
  const exported = records.filter(record => record.status === 'exported').length
  const manifestOnly = records.filter(record => record.status.startsWith('manifest_only_')).length
  const issues = records.length - exported - manifestOnly
  const lines = [
    '# Conversation Workspace Markdown Export',
    '',
    `- Conversation ID: ${cell(input.conversationId)}`,
    `- Workspace ID: ${cell(input.workspaceId)}`,
    `- Team ID: ${cell(input.teamId)}`,
    `- User ID: ${cell(input.userId)}`,
    `- Title: ${cell(input.title)}`,
    `- Exported at: ${exportedAt.toISOString()}`,
    '- Precedence: authoritative WorkspaceFile heads replace same-path legacy Conversation entries.',
    '- Scope: public and Agent-private UTF-8 text is exported; managed references and binary objects are inventory-only.',
    '',
    '## Summary',
    '',
    `- Source records: ${records.length}`,
    `- Markdown files: ${exported}`,
    `- Inventory-only records: ${manifestOnly}`,
    `- Read/integrity issues: ${issues}`,
    '',
    '## Files',
    '',
    '| Source path | Layer | Visibility | Owner | Writer | Revision | Version | Kind | Storage | MIME | Declared bytes | Observed bytes | Declared SHA-256 | Observed SHA-256 | Markdown output | Status |',
    '| --- | --- | --- | --- | --- | ---: | --- | --- | --- | --- | ---: | ---: | --- | --- | --- | --- |',
  ]
  for (const record of records) {
    lines.push(`| ${[
      record.source_path,
      record.source,
      record.visibility,
      record.owner_agent_id,
      record.writer_agent_id,
      record.revision,
      record.version_id,
      record.kind,
      record.storage_driver,
      record.mime_type,
      record.declared_size_bytes,
      record.observed_size_bytes,
      record.declared_sha256,
      record.observed_sha256,
      record.output_path,
      record.status,
    ].map(cell).join(' | ')} |`)
  }
  return `${lines.join('\n')}\n`
}

function recordFor(
  candidate: ExportCandidate,
  overrides: Pick<ConversationWorkspaceMarkdownExportRecord,
    'observed_size_bytes' | 'observed_sha256' | 'output_path' | 'status'>,
): ConversationWorkspaceMarkdownExportRecord {
  return {
    source_path: candidate.path,
    source: candidate.source,
    visibility: candidate.visibility,
    owner_agent_id: candidate.ownerAgentId,
    writer_agent_id: candidate.writerAgentId,
    revision: candidate.revision,
    version_id: candidate.versionId,
    kind: candidate.kind,
    storage_driver: candidate.storageDriver,
    mime_type: candidate.mimeType,
    declared_size_bytes: candidate.declaredSizeBytes,
    observed_size_bytes: overrides.observed_size_bytes,
    declared_sha256: candidate.declaredSha256,
    observed_sha256: overrides.observed_sha256,
    output_path: overrides.output_path,
    status: overrides.status,
  }
}

export async function buildConversationWorkspaceMarkdownExport(
  input: ConversationWorkspaceMarkdownExportInput,
  readGridFS: ConversationWorkspaceGridFSReader,
): Promise<ConversationWorkspaceMarkdownExportPlan> {
  if (!input.conversationId.trim() || !input.userId.trim() || !input.workspaceId.trim()) {
    throw new Error('conversationId, userId and workspaceId are required')
  }
  const exportedAt = input.exportedAt ? new Date(input.exportedAt) : new Date()
  if (!Number.isFinite(exportedAt.getTime())) throw new Error('exportedAt must be a valid Date')

  const files: ConversationWorkspaceMarkdownExportFile[] = []
  const records: ConversationWorkspaceMarkdownExportRecord[] = []
  const outputKeys = new Set<string>()
  for (const candidate of candidates(input)) {
    if (!isTextCandidate(candidate)) {
      records.push(recordFor(candidate, {
        observed_size_bytes: null,
        observed_sha256: null,
        output_path: null,
        status: manifestOnlyStatus(candidate),
      }))
      continue
    }
    const buffer = await readGridFS({
      objectId: candidate.gridfsObjectId!,
      sourcePath: candidate.path,
      source: candidate.source,
    })
    if (!buffer) {
      records.push(recordFor(candidate, {
        observed_size_bytes: null,
        observed_sha256: null,
        output_path: null,
        status: 'missing_content',
      }))
      continue
    }
    const observedSha256 = sha256(buffer)
    const integrityMatches = (
      (candidate.declaredSizeBytes === null || candidate.declaredSizeBytes === buffer.byteLength)
      && (candidate.declaredSha256 === null || candidate.declaredSha256 === observedSha256)
    )
    if (!integrityMatches) {
      records.push(recordFor(candidate, {
        observed_size_bytes: buffer.byteLength,
        observed_sha256: observedSha256,
        output_path: null,
        status: 'integrity_mismatch',
      }))
      continue
    }
    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    } catch {
      records.push(recordFor(candidate, {
        observed_size_bytes: buffer.byteLength,
        observed_sha256: observedSha256,
        output_path: null,
        status: 'invalid_utf8',
      }))
      continue
    }
    const outputPath = markdownOutputPath(candidate)
    const outputKey = outputPath.normalize('NFC').toLocaleLowerCase('en-US')
    if (outputKeys.has(outputKey)) throw new Error(`Markdown output path collision: ${outputPath}`)
    outputKeys.add(outputKey)
    files.push({
      path: outputPath,
      content: renderTextAsMarkdown(candidate.path, candidate.mimeType, content),
    })
    records.push(recordFor(candidate, {
      observed_size_bytes: buffer.byteLength,
      observed_sha256: observedSha256,
      output_path: outputPath,
      status: 'exported',
    }))
  }
  const issueCount = records.filter(record => (
    !record.status.startsWith('manifest_only_') && record.status !== 'exported'
  )).length
  return {
    conversation_id: input.conversationId,
    workspace_id: input.workspaceId,
    exported_at: exportedAt,
    files,
    records,
    manifest: renderManifest(input, exportedAt, records),
    issue_count: issueCount,
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function confinedTarget(root: string, relativePath: string): string {
  const normalized = normalizeExportRelativePath(relativePath)
  const target = resolve(root, ...normalized.split('/'))
  const fromRoot = relative(root, target)
  if (!fromRoot || fromRoot.startsWith(`..${sep}`) || fromRoot === '..' || resolve(target) === resolve(root)) {
    throw new Error(`Export target escapes its root: ${relativePath}`)
  }
  return target
}

/**
 * Materialize a completed plan into a fresh directory. The destination is
 * never overwritten. Files are staged in a sibling directory and the final
 * directory becomes visible through one rename after MANIFEST.md is written.
 */
export async function writeConversationWorkspaceMarkdownExport(
  plan: ConversationWorkspaceMarkdownExportPlan,
  destinationInput: string,
): Promise<string> {
  const destination = resolve(destinationInput)
  if (await exists(destination)) throw new Error(`Export destination already exists: ${destination}`)
  const parent = dirname(destination)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  if (await exists(destination)) throw new Error(`Export destination already exists: ${destination}`)

  const temporary = await mkdtemp(join(parent, `.${basename(destination)}.tmp-`))
  try {
    for (const file of plan.files) {
      if (!file.path.toLowerCase().endsWith('.md')) {
        throw new Error(`Every exported file must use the .md extension: ${file.path}`)
      }
      const target = confinedTarget(temporary, file.path)
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await writeFile(target, file.content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    }
    const manifestTarget = confinedTarget(temporary, 'MANIFEST.md')
    await writeFile(manifestTarget, plan.manifest, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    // Best-effort no-replace guard around Node's atomic directory rename.
    // Node does not expose renameat2(RENAME_NOREPLACE), so operators must use
    // a destination parent that is not concurrently modified by another job.
    if (await exists(destination)) throw new Error(`Export destination already exists: ${destination}`)
    await rename(temporary, destination)
    return destination
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}

export function defaultConversationWorkspaceExportDirectory(
  parentDirectory: string,
  conversationId: string,
): string {
  const safeConversationId = conversationId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 160)
  if (!safeConversationId) throw new Error('conversationId cannot form a safe export directory')
  return join(resolve(parentDirectory), `conversation-${safeConversationId}-${randomUUID()}`)
}
