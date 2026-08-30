/**
 * In-memory WorkspaceInstance for tests and dev endpoints. Implements the same
 * read/write/list/exists interface as the GridFS-backed real workspace, but
 * stores everything in a plain Map<path, content>.
 *
 * Use cases:
 *   - unit tests that need to feed a tool a workspace without DB setup
 *
 * Limitations: no version history, no FileDeclaration resolvers, no archive
 * semantics (the `archive` option is silently ignored — writes always
 * overwrite). Don't use this in production paths.
 */

import {
  type WorkspaceDocumentRef,
  type WorkspaceDocumentWrite,
  type WorkspaceInstance,
} from '../../workspace/types'
import { FileDeclaration, type RasterAssetRef } from '../../types'
import { readImageAsset } from '../../media/storage'
import { inspectWorkspaceDocument } from '../../workspace/instance'
import {
  assertWorkspaceWritePath,
  resolveExistingWorkspacePath,
} from '../../workspace/path-policy'
import { workspaceGlobToRegex } from '../../workspace/glob'

const TEST_POLICY = {
  allowedRoots: ['output', 'analysis', 'notes', 'references', '.sci-pegasus'],
  internalRoot: '.sci-pegasus',
  reservedPaths: [],
  allowedRootFiles: ['MAP.md'],
  maxFiles: 500,
  maxDepth: 8,
  maxPathLength: 512,
  maxSegmentLength: 128,
}

const DOCUMENT_EXTENSIONS = new Set(['pdf', 'glb', 'ply', 'spz'])

function isDocumentPath(path: string): boolean {
  return DOCUMENT_EXTENSIONS.has(path.split('.').pop()?.toLowerCase() || '')
}

export interface InMemoryWorkspace extends WorkspaceInstance {
  /** Return all stored files as a plain object. Useful for assertion in tests
   *  and for returning the full workspace state from dev endpoints. */
  dump(): Record<string, string>
  /** URL-backed rasters written during a dev/test run. */
  dumpRasters(): Record<string, RasterAssetRef>
  /** Byte-free document refs written during a dev/test run. */
  dumpDocuments(): Record<string, WorkspaceDocumentRef>
}

export function createInMemoryWorkspace(): InMemoryWorkspace {
  const store = new Map<string, string>()
  const rasters = new Map<string, RasterAssetRef>()
  const documents = new Map<string, { ref: WorkspaceDocumentRef; buffer: Buffer }>()
  const existingPath = (path: string): string => resolveExistingWorkspacePath(
    path,
    candidate => store.has(candidate) || rasters.has(candidate) || documents.has(candidate),
  )
  const readText = async (path: string): Promise<string | null> => store.get(existingPath(path)) ?? null
  const writeText = async (path: string, content: string): Promise<void> => {
    path = assertWorkspaceWritePath(path, TEST_POLICY)
    if (isDocumentPath(path) || documents.has(path)) {
      throw new Error('Binary documents must be written with writeDocument')
    }
    rasters.delete(path)
    store.set(path, content)
  }
  return {
    read: readText,
    readText,
    write: writeText,
    writeText,
    async readRaster(path) { return rasters.get(existingPath(path)) ?? null },
    async readRasterBuffer(path, variant = 'original') {
      const raster = rasters.get(existingPath(path))
      if (!raster) return null
      return (await readImageAsset(raster.assetId, variant))?.buffer ?? null
    },
    async writeRaster(path, asset) {
      path = assertWorkspaceWritePath(path, TEST_POLICY)
      if (isDocumentPath(path) || documents.has(path)) {
        throw new Error('Binary documents must be written with writeDocument')
      }
      store.delete(path)
      rasters.set(path, asset)
    },
    async writeRasters(entries) {
      const normalized = entries.map(entry => ({
        ...entry,
        path: assertWorkspaceWritePath(entry.path, TEST_POLICY),
      }))
      if (normalized.some(entry => isDocumentPath(entry.path) || documents.has(entry.path))) {
        throw new Error('Binary documents must be written with writeDocument')
      }
      for (const entry of normalized) {
        store.delete(entry.path)
        rasters.set(entry.path, entry.asset)
      }
    },
    async writeDocument(input: WorkspaceDocumentWrite) {
      const path = assertWorkspaceWritePath(input.path, TEST_POLICY)
      const inspected = inspectWorkspaceDocument(input)
      const expectedExtension = new Map([
        ['application/pdf', 'pdf'],
        ['model/gltf-binary', 'glb'],
        ['application/ply', 'ply'],
        ['application/vnd.aholo.spz', 'spz'],
      ]).get(inspected.mimeType)
      if (!isDocumentPath(path)) {
        throw new Error('Document workspace path must end in .pdf, .glb, .ply, or .spz')
      }
      if (path.split('.').pop()?.toLowerCase() !== expectedExtension) {
        throw new Error('Document workspace path extension does not match its MIME type')
      }
      const existing = documents.get(path)
      if (existing?.ref.sha256 === inspected.sha256) return existing.ref
      if (existing || store.has(path) || rasters.has(path)) {
        throw new Error(`Workspace document path already exists with different content: ${path}`)
      }
      const ref: WorkspaceDocumentRef = {
        path,
        filename: input.filename.trim(),
        mimeType: inspected.mimeType,
        sizeBytes: inspected.sizeBytes,
        sha256: inspected.sha256,
        source: { ...input.source, provider: input.source.provider.trim() },
        provenance: { ...input.provenance },
      }
      documents.set(path, { ref, buffer: Buffer.from(input.buffer) })
      return ref
    },
    async readDocument(path) {
      return documents.get(existingPath(path))?.ref ?? null
    },
    async readDocumentBuffer(path) {
      const buffer = documents.get(existingPath(path))?.buffer
      return buffer ? Buffer.from(buffer) : null
    },
    async stat(path) {
      path = existingPath(path)
      const raster = rasters.get(path)
      if (raster) return {
        path,
        kind: 'raster' as const,
        storage: 'asset' as const,
        mimeType: raster.mimeType,
        sizeBytes: raster.sizeBytes,
        width: raster.width,
        height: raster.height,
      }
      const document = documents.get(path)
      if (document) return {
        path,
        kind: 'document' as const,
        storage: 'gridfs' as const,
        mimeType: document.ref.mimeType,
        sizeBytes: document.ref.sizeBytes,
        filename: document.ref.filename,
        sha256: document.ref.sha256,
        source: document.ref.source,
        provenance: document.ref.provenance,
      }
      if (store.has(path)) return {
        path,
        kind: 'text' as const,
        storage: 'gridfs' as const,
        mimeType: 'text/plain',
      }
      return null
    },
    list(pattern?: string): string[] {
      const all = [...new Set([...store.keys(), ...rasters.keys(), ...documents.keys()])]
      if (!pattern) return all
      const re = workspaceGlobToRegex(pattern)
      return all.filter(p => re.test(p))
    },
    exists(path: string): boolean {
      path = existingPath(path)
      return store.has(path) || rasters.has(path) || documents.has(path)
    },
    async withFileSetReservation(paths, _idempotencyKey, operation) {
      const projected = new Set([...store.keys(), ...rasters.keys(), ...documents.keys()])
      for (const path of paths) projected.add(assertWorkspaceWritePath(path, TEST_POLICY))
      if (projected.size > TEST_POLICY.maxFiles) {
        throw new Error(`Workspace file limit reached (${TEST_POLICY.maxFiles})`)
      }
      return operation()
    },
    getFileDeclaration(): FileDeclaration | undefined {
      return undefined
    },
    definition: {
      name: 'in-memory-test',
      description: 'In-memory workspace used by focused tool tests',
      policy: TEST_POLICY,
    },
    dump(): Record<string, string> {
      return Object.fromEntries(store.entries())
    },
    dumpRasters(): Record<string, RasterAssetRef> {
      return Object.fromEntries(rasters.entries())
    },
    dumpDocuments(): Record<string, WorkspaceDocumentRef> {
      return Object.fromEntries([...documents.entries()].map(([path, value]) => [path, value.ref]))
    },
  }
}
