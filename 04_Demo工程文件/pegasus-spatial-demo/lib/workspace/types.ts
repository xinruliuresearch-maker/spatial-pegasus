import { WorkspaceDefinition, FileDeclaration, type RasterAssetRef } from '../types'

/**
 * WorkspaceInstance provides file-system-like operations backed by GridFS.
 */
export interface WorkspaceInstanceOptions {
  /** Called to update the GridFS files map and manifest in the conversation document. */
  onFilesUpdate?: (files: Record<string, FileEntry>, manifest: Record<string, ManifestEntry>) => Promise<void>
  /**
   * Path-level publication boundary used by the multi-Agent Workspace bridge.
   * Blob storage has completed when this callback runs, but the in-memory and
   * legacy Conversation projections have not been advanced yet. Throwing keeps
   * the WorkspaceInstance on its previous snapshot.
   */
  onFileMutations?: (
    mutations: readonly WorkspaceFileMutation[],
    context?: WorkspaceFileMutationContext,
  ) => Promise<void>
  /**
   * Durable, whole-set capacity boundary used by FetchPaper. The begin hook
   * runs before any provider I/O and may wait for another process that already
   * owns the same idempotent materialization. Returned entries hydrate this
   * live WorkspaceInstance before the operation inspects its cache.
   */
  onFileSetBegin?: (
    paths: readonly string[],
    idempotencyKey: string,
  ) => Promise<WorkspaceFileSetLease>
  /** Publish every staged member after a successful operation. */
  onFileSetFinalize?: (reservationId: string) => Promise<Record<string, FileEntry>>
  /** Publish only the durable subset after a failed operation, releasing unused slots. */
  onFileSetAbort?: (reservationId: string) => Promise<Record<string, FileEntry>>
  /** Conversation ID — required for GridFS storage */
  conversationId?: string
  /** Required to lazily externalize legacy GridFS raster entries. */
  ownerUserId?: string
  /** Observability hook for migration-window fallback reads. */
  onLegacyRasterFallback?: (path: string) => void
}

/** A staged, byte-safe path update. Buffers never cross a JSON/SSE boundary. */
export interface WorkspaceFileMutation {
  path: string
  entry: FileEntry
  previousEntry?: FileEntry
  /** Exact newly-written bytes when they are already available to the caller. */
  contentBytes?: Buffer
}

export interface WorkspaceFileMutationContext {
  /** Existing whole-set reservation. Individual mutations must not finalize it. */
  reservationId?: string
}

export interface WorkspaceFileSetLease {
  /** Undefined means every requested path is already canonical and published. */
  reservationId?: string
  /** Authoritative entries made visible while joining or recovering a flight. */
  projectedFiles?: Record<string, FileEntry>
}

/** A file entry in the conversation's output.files map */
export interface GridFSTextFileEntry {
  /** Missing storage/kind means a legacy GridFS entry. */
  storage?: 'gridfs'
  kind?: 'text'
  gridfs_id: string
  mime_type?: string
  note?: string
  version?: number
  created_at?: string
  updated_at?: string
}

/** Stable public locator for an original document. Never store signed URLs or credentials here. */
export interface WorkspaceDocumentSource {
  provider: string
  canonical_url?: string
  external_id?: string
}

/** Bounded retrieval provenance kept alongside an immutable document artifact. */
export interface WorkspaceDocumentProvenance {
  retrieved_at: string
  version?: string
  license?: string
  license_url?: string
  /** Immutable schema-v2 literature operation audit id; this is not orchestration/session state. */
  search_record_id?: string
  provenance_path?: string
}

export interface GridFSDocumentFileEntry {
  storage: 'gridfs'
  kind: 'document'
  gridfs_id: string
  filename: string
  mime_type: string
  size_bytes: number
  sha256: string
  source: WorkspaceDocumentSource
  provenance: WorkspaceDocumentProvenance
  note?: string
  version?: number
  created_at?: string
  updated_at?: string
}

export interface RasterAssetFileEntry {
  storage: 'asset'
  kind: 'raster'
  asset_id: string
  mime_type: string
  width: number
  height: number
  size_bytes: number
  note?: string
  version?: number
  created_at?: string
  updated_at?: string
}

export type FileEntry = GridFSTextFileEntry | GridFSDocumentFileEntry | RasterAssetFileEntry

export interface WorkspaceDocumentWrite {
  path: string
  buffer: Buffer
  filename: string
  mimeType: string
  source: WorkspaceDocumentSource
  provenance: WorkspaceDocumentProvenance
  note?: string
}

/** Byte-free document metadata safe to return to tools and UI-facing adapters. */
export interface WorkspaceDocumentRef {
  path: string
  filename: string
  mimeType: string
  sizeBytes: number
  sha256: string
  source: WorkspaceDocumentSource
  provenance: WorkspaceDocumentProvenance
}

export interface WorkspaceFileStat {
  path: string
  kind: 'text' | 'raster' | 'document'
  storage: 'gridfs' | 'asset'
  mimeType: string
  sizeBytes?: number
  filename?: string
  sha256?: string
  source?: WorkspaceDocumentSource
  provenance?: WorkspaceDocumentProvenance
  width?: number
  height?: number
  version?: number
  createdAt?: string
  updatedAt?: string
}

export interface WorkspaceRasterWrite {
  path: string
  asset: RasterAssetRef
  note?: string
  options?: { archive?: boolean }
}

export function isRasterFileEntry(entry: FileEntry | undefined): entry is RasterAssetFileEntry {
  return entry?.storage === 'asset' && entry.kind === 'raster'
}

export function isDocumentFileEntry(entry: FileEntry | undefined): entry is GridFSDocumentFileEntry {
  return entry?.storage === 'gridfs' && entry.kind === 'document'
}

export function isGridFSFileEntry(entry: FileEntry | undefined): entry is GridFSTextFileEntry {
  return Boolean(entry) && !isRasterFileEntry(entry) && !isDocumentFileEntry(entry)
}

/** Manifest entry for version tracking */
export interface ManifestEntry {
  current_version: number
  versions: { v: number; path: string; note: string; created_at: string }[]
}

export interface WorkspaceInstance {
  /** Compatibility alias for readText. Raster files return null. */
  read(path: string): Promise<string | null>

  /** Read UTF-8 source such as Markdown, JSON, XML or SVG. */
  readText(path: string): Promise<string | null>

  /** Compatibility alias for writeText. `archive: false` skips version archival. */
  write(path: string, content: string, note?: string, options?: { archive?: boolean }): Promise<void>

  /** Write UTF-8 source to GridFS. */
  writeText(path: string, content: string, note?: string, options?: { archive?: boolean }): Promise<void>

  /** Return a byte-free reference for a raster file. */
  readRaster(path: string): Promise<RasterAssetRef | null>

  /** Server-side processing escape hatch. Never expose this Buffer over SSE/JSON. */
  readRasterBuffer(path: string, variant?: 'original' | 'model' | 'thumbnail'): Promise<Buffer | null>

  /** Map a virtual workspace path to an existing raster asset. */
  writeRaster(path: string, asset: RasterAssetRef, note?: string, options?: { archive?: boolean }): Promise<void>

  /**
   * Map multiple raster assets and persist the workspace index once. This is
   * intended for deterministic tool pipelines that create a related asset set
   * (for example document figures or microscopy crops); it has the same ownership and path
   * checks as writeRaster.
  */
  writeRasters(entries: WorkspaceRasterWrite[]): Promise<void>

  /** Persist an immutable original document after validating its bytes. */
  writeDocument(input: WorkspaceDocumentWrite): Promise<WorkspaceDocumentRef>

  /** Return byte-free metadata for an original document. */
  readDocument(path: string): Promise<WorkspaceDocumentRef | null>

  /** Server-side escape hatch for parser integrations. Never expose this Buffer over JSON/SSE. */
  readDocumentBuffer(path: string): Promise<Buffer | null>

  /** Inspect a path without reading its contents. */
  stat(path: string): Promise<WorkspaceFileStat | null>

  /** List all files in the workspace (optionally filtered by glob pattern) */
  list(pattern?: string): string[]

  /** Check if a file exists */
  exists(path: string): boolean

  /**
   * Reserve a complete deterministic output set before external I/O. This is
   * intentionally a high-level operation so callers never manage reservation
   * jobs or polling themselves.
   */
  withFileSetReservation<T>(
    paths: readonly string[],
    idempotencyKey: string,
    operation: () => Promise<T>,
  ): Promise<T>

  /** Get file declaration metadata */
  getFileDeclaration(path: string): FileDeclaration | undefined

  /** The underlying workspace definition */
  definition: WorkspaceDefinition
}
