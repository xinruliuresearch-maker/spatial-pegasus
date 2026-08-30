import { WorkspaceDefinition, FileDeclaration, type RasterAssetRef } from '../types'
import { createHash } from 'crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  type WorkspaceInstance,
  type WorkspaceInstanceOptions,
  type FileEntry,
  type ManifestEntry,
  type WorkspaceFileMutation,
  type WorkspaceDocumentRef,
  type WorkspaceDocumentWrite,
  type WorkspaceRasterWrite,
  isDocumentFileEntry,
  isGridFSFileEntry,
  isRasterFileEntry,
} from './types'
import {
  readFileFromGridFS,
  readFileFromGridFSAsBuffer,
  writeDocumentToGridFS,
  writeFileToGridFS,
} from '../db/gridfs'
import { getImageAsset, readImageAsset, writeImageAsset } from '../media/storage'
import { toRasterAssetRef } from '../media/reference'
import {
  assertWorkspaceWritePath,
  buildVersionArchivePath,
  canonicalWorkspaceWritePath,
  resolveExistingWorkspacePath,
  WORKSPACE_MAX_FILES,
} from './path-policy'
import { workspaceGlobToRegex } from './glob'

const RASTER_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

const TEXT_MIME_BY_EXTENSION: Record<string, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/tsx',
  jsx: 'text/jsx',
  csv: 'text/csv',
}

export const WORKSPACE_DOCUMENT_MAX_BYTES = 200 * 1024 * 1024
const PDF_MIME_TYPE = 'application/pdf'
const PDF_MAGIC = Buffer.from('%PDF-', 'ascii')
const GLB_MIME_TYPE = 'model/gltf-binary'
const GLB_MAGIC = Buffer.from('glTF', 'ascii')
const PLY_MIME_TYPE = 'application/ply'
const SPZ_MIME_TYPE = 'application/vnd.aholo.spz'
const DOCUMENT_MIME_EXTENSIONS = new Map<string, string>([
  [PDF_MIME_TYPE, 'pdf'],
  [GLB_MIME_TYPE, 'glb'],
  [PLY_MIME_TYPE, 'ply'],
  [SPZ_MIME_TYPE, 'spz'],
])
const DOCUMENT_EXTENSIONS = new Set(DOCUMENT_MIME_EXTENSIONS.values())

/** Persistence seam used by focused workspace atomicity tests. */
export interface WorkspaceInstancePersistence {
  writeTextFile: typeof writeFileToGridFS
  writeDocumentFile: typeof writeDocumentToGridFS
  readTextFile?: typeof readFileFromGridFS
  readBufferFile?: typeof readFileFromGridFSAsBuffer
}

function extension(path: string): string {
  return path.split('.').pop()?.toLowerCase() || ''
}

function isDocumentPath(path: string): boolean {
  return DOCUMENT_EXTENSIONS.has(extension(path))
}

function assertSafeHttpUrl(value: string | undefined, field: string): void {
  if (!value) return
  if (value.length > 4096) throw new Error(`${field} is too long`)
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${field} must be a valid URL`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${field} must use http or https`)
  }
  if (parsed.username || parsed.password) throw new Error(`${field} cannot contain credentials`)
}

function assertBoundedString(value: string | undefined, field: string, maximum: number): void {
  if (value !== undefined && value.length > maximum) throw new Error(`${field} is too long`)
}

export function inspectWorkspaceDocument(input: WorkspaceDocumentWrite): {
  mimeType: string
  sizeBytes: number
  sha256: string
} {
  if (!Buffer.isBuffer(input.buffer)) throw new Error('Document buffer must be a Buffer')
  if (input.buffer.length === 0) throw new Error('Document cannot be empty')
  if (input.buffer.length > WORKSPACE_DOCUMENT_MAX_BYTES) {
    throw new Error(`Document exceeds ${WORKSPACE_DOCUMENT_MAX_BYTES} byte limit`)
  }

  const mimeType = input.mimeType.split(';', 1)[0].trim().toLowerCase()
  if (!DOCUMENT_MIME_EXTENSIONS.has(mimeType)) {
    throw new Error(`Unsupported document MIME type: ${mimeType || '(empty)'}`)
  }
  if (mimeType === PDF_MIME_TYPE) {
    if (input.buffer.length < PDF_MAGIC.length || !input.buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
      throw new Error('Document bytes do not start with the PDF magic header')
    }
  } else if (mimeType === GLB_MIME_TYPE) {
    if (
      input.buffer.length < 12
      || !input.buffer.subarray(0, GLB_MAGIC.length).equals(GLB_MAGIC)
      || input.buffer.readUInt32LE(4) !== 2
      || input.buffer.readUInt32LE(8) !== input.buffer.length
    ) {
      throw new Error('3D model bytes are not a valid GLB 2.0 container')
    }
  } else if (mimeType === PLY_MIME_TYPE) {
    const header = input.buffer.subarray(0, 160).toString('ascii')
    if (!/^ply\r?\nformat\s+(ascii|binary_little_endian|binary_big_endian)\s+1\.0\r?\n/.test(header)) {
      throw new Error('3D model bytes do not start with a valid PLY 1.0 header')
    }
  } else if (input.buffer.length < 2 || input.buffer[0] !== 0x1f || input.buffer[1] !== 0x8b) {
    throw new Error('3D splat bytes do not start with the SPZ gzip header')
  }

  const filename = input.filename.trim()
  if (!filename || filename.length > 255 || /[\\/\p{Cc}]/u.test(filename)) {
    throw new Error('Document filename is invalid')
  }
  const requiredExtension = `.${DOCUMENT_MIME_EXTENSIONS.get(mimeType)!}`
  if (!filename.toLowerCase().endsWith(requiredExtension)) {
    throw new Error(`Document filename must end in ${requiredExtension}`)
  }
  if (!input.source?.provider?.trim() || input.source.provider.length > 100) {
    throw new Error('Document source provider is required and must be at most 100 characters')
  }
  assertSafeHttpUrl(input.source.canonical_url, 'source.canonical_url')
  assertSafeHttpUrl(input.provenance?.license_url, 'provenance.license_url')
  assertBoundedString(input.source.external_id, 'source.external_id', 512)
  assertBoundedString(input.provenance?.version, 'provenance.version', 128)
  assertBoundedString(input.provenance?.license, 'provenance.license', 1024)
  assertBoundedString(input.provenance?.search_record_id, 'provenance.search_record_id', 256)
  assertBoundedString(input.provenance?.provenance_path, 'provenance.provenance_path', 512)
  if (!input.provenance?.retrieved_at || Number.isNaN(Date.parse(input.provenance.retrieved_at))) {
    throw new Error('Document provenance.retrieved_at must be a valid timestamp')
  }

  return {
    mimeType,
    sizeBytes: input.buffer.length,
    sha256: createHash('sha256').update(input.buffer).digest('hex'),
  }
}

function documentRef(path: string, entry: Extract<FileEntry, { kind: 'document' }>): WorkspaceDocumentRef {
  return {
    path,
    filename: entry.filename,
    mimeType: entry.mime_type,
    sizeBytes: entry.size_bytes,
    sha256: entry.sha256,
    source: { ...entry.source },
    provenance: { ...entry.provenance },
  }
}

function rasterMime(path: string, entry?: FileEntry): string | null {
  if (isRasterFileEntry(entry)) return entry.mime_type
  const declared = isGridFSFileEntry(entry) ? entry.mime_type : undefined
  if (declared?.startsWith('image/') && declared !== 'image/svg+xml') return declared
  return RASTER_MIME_BY_EXTENSION[extension(path)] || null
}

function textMime(path: string, entry?: FileEntry): string {
  if (isGridFSFileEntry(entry) && entry.mime_type) return entry.mime_type
  return TEXT_MIME_BY_EXTENSION[extension(path)] || 'text/plain'
}

/** Create a workspace where text stays in GridFS and raster paths reference assets. */
export function createWorkspaceInstance(
  definition: WorkspaceDefinition,
  outputFiles?: Record<string, FileEntry>,
  outputManifest?: Record<string, ManifestEntry>,
  options?: WorkspaceInstanceOptions,
  persistence?: Partial<WorkspaceInstancePersistence>,
): WorkspaceInstance {
  const writeCache: Record<string, string> = {}
  const filesMap: Record<string, FileEntry> = { ...(outputFiles || {}) }
  const manifestMap: Record<string, ManifestEntry> = { ...(outputManifest || {}) }
  const fileMap = new Map<string, FileDeclaration>()
  const policy = definition.policy
  const declarations = policy?.reservedPaths ?? definition.files ?? []
  for (const file of declarations) fileMap.set(canonicalWorkspaceWritePath(file.path), file)
  const convId = options?.conversationId
  const persistTextFile = persistence?.writeTextFile ?? writeFileToGridFS
  const persistDocumentFile = persistence?.writeDocumentFile ?? writeDocumentToGridFS
  const persistReadTextFile = persistence?.readTextFile ?? readFileFromGridFS
  const persistReadBufferFile = persistence?.readBufferFile ?? readFileFromGridFSAsBuffer
  let textWriteTail: Promise<void> = Promise.resolve()
  const fileSetScope = new AsyncLocalStorage<{ reservationId: string }>()

  function assetBelongsToWorkspace(asset: Awaited<ReturnType<typeof getImageAsset>>): boolean {
    if (!asset || asset.state === 'deleted') return false
    if (options?.ownerUserId && asset.ownerUserId !== options.ownerUserId) return false
    if (convId && asset.conversationId !== convId) return false
    return true
  }

  async function persistIndex(
    files: Record<string, FileEntry> = filesMap,
    manifest: Record<string, ManifestEntry> = manifestMap,
    mutations: readonly WorkspaceFileMutation[] = [],
  ): Promise<void> {
    const reservationId = fileSetScope.getStore()?.reservationId
    if (mutations.length > 0 && options?.onFileMutations) {
      await options.onFileMutations(mutations, { reservationId })
    }
    // A whole-set operation becomes visible in the legacy Conversation
    // projection only after its durable reservation is finalized (or its
    // explicitly recoverable partial set is finalized on abort).
    if (options?.onFilesUpdate && !reservationId) await options.onFilesUpdate(files, manifest)
  }

  function hydrateProjectedFiles(entries: Record<string, FileEntry> | undefined): void {
    for (const [rawPath, entry] of Object.entries(entries ?? {})) {
      const path = assertWorkspaceWritePath(rawPath, policy)
      filesMap[path] = structuredClone(entry)
      delete writeCache[path]
    }
  }

  async function withFileSetReservation<T>(
    paths: readonly string[],
    idempotencyKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const requestedPaths = [...new Set(paths.map(path => assertWorkspaceWritePath(path, policy)))].sort()
    if (requestedPaths.length === 0) throw new Error('A Workspace file-set reservation requires at least one path')
    if (!idempotencyKey || idempotencyKey.length > 512) {
      throw new Error('Workspace file-set idempotency key is invalid')
    }

    const projected = new Set(Object.keys(filesMap))
    for (const path of requestedPaths) projected.add(path)
    const maxFiles = policy?.maxFiles ?? WORKSPACE_MAX_FILES
    if (projected.size > maxFiles) throw new Error(`Workspace file limit reached (${maxFiles})`)

    const coordinated = options?.onFileSetBegin
      && options.onFileSetFinalize
      && options.onFileSetAbort
    if (!coordinated) return operation()

    const lease = await options.onFileSetBegin!(requestedPaths, idempotencyKey)
    hydrateProjectedFiles(lease.projectedFiles)
    if (!lease.reservationId) return operation()

    try {
      const result = await fileSetScope.run(
        { reservationId: lease.reservationId },
        operation,
      )
      hydrateProjectedFiles(await options.onFileSetFinalize!(lease.reservationId))
      if (options.onFilesUpdate) await options.onFilesUpdate(filesMap, manifestMap)
      return result
    } catch (error) {
      try {
        hydrateProjectedFiles(await options.onFileSetAbort!(lease.reservationId))
        if (options.onFilesUpdate) await options.onFilesUpdate(filesMap, manifestMap)
      } catch (abortError) {
        throw new AggregateError(
          [error, abortError],
          'Workspace file-set operation and durable reservation recovery both failed',
        )
      }
      throw error
    }
  }

  function enqueueTextWrite(operation: () => Promise<void>): Promise<void> {
    const pending = textWriteTail.then(operation)
    textWriteTail = pending.catch(() => undefined)
    return pending
  }

  function cloneManifest(source: Record<string, ManifestEntry>): Record<string, ManifestEntry> {
    return Object.fromEntries(Object.entries(source).map(([path, entry]) => [path, {
      current_version: entry.current_version,
      versions: entry.versions.map(version => ({ ...version })),
    }]))
  }

  function assertWritable(normalized: string, originalPath: string): void {
    if (fileMap.get(normalized)?.readOnly) throw new Error(`File is read-only: ${originalPath}`)
  }

  function writePath(path: string): string {
    const normalized = assertWorkspaceWritePath(path, policy)
    if (!filesMap[normalized] && Object.keys(filesMap).length >= (policy?.maxFiles ?? WORKSPACE_MAX_FILES)) {
      throw new Error(`Workspace file limit reached (${policy?.maxFiles ?? WORKSPACE_MAX_FILES})`)
    }
    return normalized
  }

  function existingPath(path: string): string {
    return resolveExistingWorkspacePath(path, candidate => Boolean(filesMap[candidate]) || writeCache[candidate] !== undefined)
  }

  function currentLogicalVersion(
    normalized: string,
    targetFiles: Record<string, FileEntry> = filesMap,
    targetManifest: Record<string, ManifestEntry> = manifestMap,
  ): number {
    const entryVersion = targetFiles[normalized]?.version
    const manifestVersion = targetManifest[normalized]?.current_version
    return Math.max(
      Number.isSafeInteger(entryVersion) && entryVersion! > 0 ? entryVersion! : 1,
      Number.isSafeInteger(manifestVersion) && manifestVersion! > 0 ? manifestVersion! : 1,
    )
  }

  function archiveCurrent(
    normalized: string,
    shouldArchive: boolean,
    targetFiles: Record<string, FileEntry> = filesMap,
    targetManifest: Record<string, ManifestEntry> = manifestMap,
  ): { version: number; archivedPath: string | null } {
    const oldVersion = currentLogicalVersion(normalized, targetFiles, targetManifest)
    if (!shouldArchive || !targetFiles[normalized]) {
      return { version: oldVersion, archivedPath: null }
    }
    const manifest = targetManifest[normalized] || { current_version: 1, versions: [] }
    const versionedPath = buildVersionArchivePath(normalized, oldVersion)
    if (!targetFiles[versionedPath] && Object.keys(targetFiles).length >= (policy?.maxFiles ?? WORKSPACE_MAX_FILES)) {
      throw new Error(`Workspace file limit reached (${policy?.maxFiles ?? WORKSPACE_MAX_FILES})`)
    }
    targetFiles[versionedPath] = { ...targetFiles[normalized] }
    manifest.versions.push({
      v: oldVersion,
      path: versionedPath,
      note: targetFiles[normalized].note || '',
      created_at: targetFiles[normalized].created_at || new Date().toISOString(),
    })
    manifest.current_version = oldVersion + 1
    targetManifest[normalized] = manifest
    return { version: manifest.current_version, archivedPath: versionedPath }
  }

  async function readText(path: string): Promise<string | null> {
    const normalized = existingPath(path)
    if (writeCache[normalized] !== undefined) return writeCache[normalized]
    const entry = filesMap[normalized]
    if (isDocumentFileEntry(entry) || isRasterFileEntry(entry) || rasterMime(normalized, entry)) return null
    if (isGridFSFileEntry(entry) && entry.gridfs_id) {
      return persistReadTextFile(entry.gridfs_id)
    }
    return null
  }

  async function writeText(
    path: string,
    content: string,
    note?: string,
    writeOptions?: { archive?: boolean },
  ): Promise<void> {
    return enqueueTextWrite(async () => {
      const normalized = writePath(path)
      assertWritable(normalized, path)
      if (isDocumentPath(normalized) || isDocumentFileEntry(filesMap[normalized])) {
        throw new Error('Binary documents must be written with writeDocument')
      }

      // A conversation-less instance is intentionally memory-only. Archive
      // first so a validation failure cannot leave an unindexed cache entry.
      if (!convId) {
        archiveCurrent(normalized, writeOptions?.archive !== false)
        writeCache[normalized] = content
        return
      }

      const gridfsId = await persistTextFile(convId, normalized, content, {
        encoding: 'utf8',
        mimeType: textMime(normalized),
        capacityReservationId: fileSetScope.getStore()?.reservationId,
      })

      // Take the candidate snapshot after the potentially slow upload so an
      // unrelated document/raster commit during that wait is included.
      writePath(path)
      assertWritable(normalized, path)
      if (isDocumentPath(normalized) || isDocumentFileEntry(filesMap[normalized])) {
        throw new Error('Binary documents must be written with writeDocument')
      }
      const stagedFiles: Record<string, FileEntry> = { ...filesMap }
      const stagedManifest = cloneManifest(manifestMap)
      const shouldArchive = writeOptions?.archive !== false && Boolean(stagedFiles[normalized])
      const archive = archiveCurrent(
        normalized,
        shouldArchive,
        stagedFiles,
        stagedManifest,
      )
      const now = new Date().toISOString()
      stagedFiles[normalized] = {
        storage: 'gridfs',
        kind: 'text',
        gridfs_id: gridfsId,
        mime_type: textMime(normalized),
        note: note || '',
        version: archive.version,
        created_at: now,
        updated_at: now,
      }
      if (!stagedManifest[normalized]) {
        stagedManifest[normalized] = { current_version: 1, versions: [] }
      }

      const mutations: WorkspaceFileMutation[] = []
      if (archive.archivedPath) {
        mutations.push({
          path: archive.archivedPath,
          entry: stagedFiles[archive.archivedPath],
        })
      }
      mutations.push({
        path: normalized,
        entry: stagedFiles[normalized],
        previousEntry: filesMap[normalized],
        contentBytes: Buffer.from(content, 'utf8'),
      })
      await persistIndex(stagedFiles, stagedManifest, mutations)

      // Commit only this transaction's paths. Never replay the whole staged
      // snapshot over unrelated document/raster changes made while the index
      // persistence callback was in flight.
      if (archive.archivedPath) {
        filesMap[archive.archivedPath] = stagedFiles[archive.archivedPath]
      }
      filesMap[normalized] = stagedFiles[normalized]
      manifestMap[normalized] = stagedManifest[normalized]
      writeCache[normalized] = content
    })
  }

  async function readDocument(path: string): Promise<WorkspaceDocumentRef | null> {
    const normalized = existingPath(path)
    const entry = filesMap[normalized]
    return isDocumentFileEntry(entry) ? documentRef(normalized, entry) : null
  }

  async function readDocumentBuffer(path: string): Promise<Buffer | null> {
    const normalized = existingPath(path)
    const entry = filesMap[normalized]
    if (!isDocumentFileEntry(entry)) return null
    return persistReadBufferFile(entry.gridfs_id)
  }

  async function writeDocument(input: WorkspaceDocumentWrite): Promise<WorkspaceDocumentRef> {
    const normalized = writePath(input.path)
    assertWritable(normalized, input.path)
    if (!isDocumentPath(normalized)) {
      throw new Error('Document workspace path must end in .pdf, .glb, .ply, or .spz')
    }

    const inspected = inspectWorkspaceDocument(input)
    if (extension(normalized) !== DOCUMENT_MIME_EXTENSIONS.get(inspected.mimeType)) {
      throw new Error('Document workspace path extension does not match its MIME type')
    }
    const existing = filesMap[normalized]
    if (isDocumentFileEntry(existing) && existing.sha256 === inspected.sha256) {
      return documentRef(normalized, existing)
    }
    if (existing) {
      throw new Error(`Workspace document path already exists with different content: ${normalized}`)
    }
    if (!convId) throw new Error('conversationId is required to persist a document')

    const gridfsId = await persistDocumentFile(convId, normalized, input.buffer, {
      filename: input.filename.trim(),
      mimeType: inspected.mimeType,
      sha256: inspected.sha256,
      source: input.source,
      provenance: input.provenance,
      capacityReservationId: fileSetScope.getStore()?.reservationId,
    })
    const now = new Date().toISOString()
    const entry: Extract<FileEntry, { kind: 'document' }> = {
      storage: 'gridfs',
      kind: 'document',
      gridfs_id: gridfsId,
      filename: input.filename.trim(),
      mime_type: inspected.mimeType,
      size_bytes: inspected.sizeBytes,
      sha256: inspected.sha256,
      source: { ...input.source, provider: input.source.provider.trim() },
      provenance: { ...input.provenance },
      note: input.note || '',
      version: 1,
      created_at: now,
      updated_at: now,
    }
    const stagedFiles = { ...filesMap, [normalized]: entry }
    const stagedManifest = cloneManifest(manifestMap)
    if (!stagedManifest[normalized]) stagedManifest[normalized] = { current_version: 1, versions: [] }
    await persistIndex(stagedFiles, stagedManifest, [{
      path: normalized,
      entry,
      previousEntry: filesMap[normalized],
      contentBytes: Buffer.from(input.buffer),
    }])
    delete writeCache[normalized]
    filesMap[normalized] = entry
    manifestMap[normalized] = stagedManifest[normalized]
    return documentRef(normalized, entry)
  }

  async function readRaster(path: string): Promise<RasterAssetRef | null> {
    const normalized = existingPath(path)
    const entry = filesMap[normalized]
    if (isRasterFileEntry(entry)) {
      const asset = await getImageAsset(entry.asset_id)
      return assetBelongsToWorkspace(asset) && asset ? toRasterAssetRef(asset) : null
    }
    if (!isGridFSFileEntry(entry) || !entry.gridfs_id || !rasterMime(normalized, entry)) return null
    if (!options?.ownerUserId || !convId) return null

    // Migration-window fallback: externalize once, atomically replace only the
    // workspace index, and retain the old GridFS object for the rollback window.
    options.onLegacyRasterFallback?.(normalized)
    const buffer = await readFileFromGridFSAsBuffer(entry.gridfs_id)
    if (!buffer) return null
    const asset = await writeImageAsset({
      ownerUserId: options.ownerUserId,
      conversationId: convId,
      buffer,
      mimeType: rasterMime(normalized, entry) || undefined,
      source: 'tool_output',
    })
    const ref = toRasterAssetRef(asset)
    const nextEntry: FileEntry = {
      storage: 'asset',
      kind: 'raster',
      asset_id: ref.assetId,
      mime_type: ref.mimeType,
      width: ref.width,
      height: ref.height,
      size_bytes: ref.sizeBytes,
      note: entry.note,
      version: entry.version,
      created_at: entry.created_at,
    }
    const stagedFiles = { ...filesMap, [normalized]: nextEntry }
    await persistIndex(stagedFiles, manifestMap, [{
      path: normalized,
      entry: nextEntry,
      previousEntry: entry,
      contentBytes: Buffer.from(buffer),
    }])
    filesMap[normalized] = nextEntry
    return ref
  }

  async function readRasterBuffer(
    path: string,
    variant: 'original' | 'model' | 'thumbnail' = 'original',
  ): Promise<Buffer | null> {
    const normalized = existingPath(path)
    const entry = filesMap[normalized]
    if (isRasterFileEntry(entry)) {
      const asset = await getImageAsset(entry.asset_id)
      if (!assetBelongsToWorkspace(asset)) return null
      return (await readImageAsset(entry.asset_id, variant))?.buffer || null
    }
    if (isGridFSFileEntry(entry) && entry.gridfs_id && rasterMime(normalized, entry)) {
      options?.onLegacyRasterFallback?.(normalized)
      return readFileFromGridFSAsBuffer(entry.gridfs_id)
    }
    return null
  }

  async function writeRaster(
    path: string,
    ref: RasterAssetRef,
    note?: string,
    writeOptions?: { archive?: boolean },
  ): Promise<void> {
    const normalized = writePath(path)
    assertWritable(normalized, path)
    if (isDocumentPath(normalized) || isDocumentFileEntry(filesMap[normalized])) {
      throw new Error('Binary documents must be written with writeDocument')
    }
    const asset = await getImageAsset(ref.assetId)
    if (!assetBelongsToWorkspace(asset)) throw new Error('Raster asset is not owned by this conversation')
    const stagedFiles = { ...filesMap }
    const stagedManifest = cloneManifest(manifestMap)
    const shouldArchive = writeOptions?.archive !== false && Boolean(stagedFiles[normalized])
    const archive = archiveCurrent(
      normalized,
      shouldArchive,
      stagedFiles,
      stagedManifest,
    )
    const nextEntry: FileEntry = {
      storage: 'asset',
      kind: 'raster',
      asset_id: ref.assetId,
      mime_type: ref.mimeType,
      width: ref.width,
      height: ref.height,
      size_bytes: ref.sizeBytes,
      note: note || '',
      version: archive.version,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    stagedFiles[normalized] = nextEntry
    if (!stagedManifest[normalized]) stagedManifest[normalized] = { current_version: 1, versions: [] }
    const mutations: WorkspaceFileMutation[] = []
    if (archive.archivedPath) {
      mutations.push({ path: archive.archivedPath, entry: stagedFiles[archive.archivedPath] })
    }
    mutations.push({ path: normalized, entry: nextEntry, previousEntry: filesMap[normalized] })
    await persistIndex(stagedFiles, stagedManifest, mutations)
    if (archive.archivedPath) {
      filesMap[archive.archivedPath] = stagedFiles[archive.archivedPath]
    }
    delete writeCache[normalized]
    filesMap[normalized] = nextEntry
    manifestMap[normalized] = stagedManifest[normalized]
  }

  async function writeRasters(entries: WorkspaceRasterWrite[]): Promise<void> {
    if (entries.length === 0) return

    const normalizedEntries = entries.map(entry => ({
      ...entry,
      normalized: writePath(entry.path),
    }))
    const duplicatePath = normalizedEntries.find((entry, index) =>
      normalizedEntries.findIndex(candidate => candidate.normalized === entry.normalized) !== index,
    )
    if (duplicatePath) {
      throw new Error(`Duplicate raster path in batch: ${duplicatePath.path}`)
    }
    if (normalizedEntries.some(entry => isDocumentPath(entry.normalized) || isDocumentFileEntry(filesMap[entry.normalized]))) {
      throw new Error('Binary documents must be written with writeDocument')
    }
    for (const entry of normalizedEntries) assertWritable(entry.normalized, entry.path)

    const projectedPaths = new Set(Object.keys(filesMap))
    for (const entry of normalizedEntries) {
      if (entry.options?.archive !== false && filesMap[entry.normalized]) {
        const currentVersion = currentLogicalVersion(entry.normalized)
        projectedPaths.add(buildVersionArchivePath(entry.normalized, currentVersion))
      }
      projectedPaths.add(entry.normalized)
    }
    const maxFiles = policy?.maxFiles ?? WORKSPACE_MAX_FILES
    if (projectedPaths.size > maxFiles) {
      throw new Error(`Workspace file limit reached (${maxFiles})`)
    }

    const assets = await Promise.all(normalizedEntries.map(entry => getImageAsset(entry.asset.assetId)))
    for (let index = 0; index < assets.length; index += 1) {
      if (!assetBelongsToWorkspace(assets[index])) {
        throw new Error(`Raster asset is not owned by this conversation: ${normalizedEntries[index].asset.assetId}`)
      }
    }

    const stagedFiles = { ...filesMap }
    const stagedManifest = cloneManifest(manifestMap)
    const mutations: WorkspaceFileMutation[] = []
    const now = new Date().toISOString()
    for (const entry of normalizedEntries) {
      const shouldArchive = entry.options?.archive !== false && Boolean(stagedFiles[entry.normalized])
      const archive = archiveCurrent(
        entry.normalized,
        shouldArchive,
        stagedFiles,
        stagedManifest,
      )
      const nextEntry: FileEntry = {
        storage: 'asset',
        kind: 'raster',
        asset_id: entry.asset.assetId,
        mime_type: entry.asset.mimeType,
        width: entry.asset.width,
        height: entry.asset.height,
        size_bytes: entry.asset.sizeBytes,
        note: entry.note || '',
        version: archive.version,
        created_at: now,
        updated_at: now,
      }
      stagedFiles[entry.normalized] = nextEntry
      if (!stagedManifest[entry.normalized]) {
        stagedManifest[entry.normalized] = { current_version: 1, versions: [] }
      }
      if (archive.archivedPath) {
        mutations.push({ path: archive.archivedPath, entry: stagedFiles[archive.archivedPath] })
      }
      mutations.push({
        path: entry.normalized,
        entry: nextEntry,
        previousEntry: filesMap[entry.normalized],
      })
    }
    await persistIndex(stagedFiles, stagedManifest, mutations)
    for (const mutation of mutations) filesMap[mutation.path] = mutation.entry
    for (const entry of normalizedEntries) {
      delete writeCache[entry.normalized]
      manifestMap[entry.normalized] = stagedManifest[entry.normalized]
    }
  }

  return {
    definition,
    read: readText,
    readText,
    write: writeText,
    writeText,
    readRaster,
    readRasterBuffer,
    writeRaster,
    writeRasters,
    writeDocument,
    readDocument,
    readDocumentBuffer,
    async stat(path) {
      const normalized = existingPath(path)
      const entry = filesMap[normalized]
      if (!entry) return null
      if (isRasterFileEntry(entry)) {
        return {
          path: normalized,
          kind: 'raster',
          storage: 'asset',
          mimeType: entry.mime_type,
          sizeBytes: entry.size_bytes,
          width: entry.width,
          height: entry.height,
          version: entry.version,
          createdAt: entry.created_at,
          updatedAt: entry.updated_at,
        }
      }
      if (isDocumentFileEntry(entry)) {
        return {
          path: normalized,
          kind: 'document',
          storage: 'gridfs',
          mimeType: entry.mime_type,
          sizeBytes: entry.size_bytes,
          filename: entry.filename,
          sha256: entry.sha256,
          source: entry.source,
          provenance: entry.provenance,
          version: entry.version,
          createdAt: entry.created_at,
          updatedAt: entry.updated_at,
        }
      }
      const legacyRasterMime = rasterMime(normalized, entry)
      if (legacyRasterMime) {
        return {
          path: normalized,
          kind: 'raster',
          storage: 'gridfs',
          mimeType: legacyRasterMime,
          version: entry.version,
          createdAt: entry.created_at,
          updatedAt: entry.updated_at,
        }
      }
      return {
        path: normalized,
        kind: 'text',
        storage: 'gridfs',
        mimeType: textMime(normalized, entry),
        version: entry.version,
        createdAt: entry.created_at,
        updatedAt: entry.updated_at,
      }
    },
    list(pattern?: string) {
      const paths = Object.keys(filesMap).sort()
      if (!pattern) return paths
      const regex = workspaceGlobToRegex(pattern)
      return paths.filter(path => regex.test(path))
    },
    exists(path: string) {
      const normalized = existingPath(path)
      return Boolean(filesMap[normalized]) || writeCache[normalized] !== undefined
    },
    withFileSetReservation,
    getFileDeclaration(path: string) {
      return fileMap.get(canonicalWorkspaceWritePath(path))
    },
  }
}
