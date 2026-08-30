// ============================================================
// GridFS — Text/XML/SVG and immutable document storage for workspace files,
// plus migration-window legacy binary compatibility. New raster assets live in OSS.
// ============================================================

import mongoose from 'mongoose'
import { connectDB } from './mongodb'
import type {
  WorkspaceDocumentProvenance,
  WorkspaceDocumentSource,
} from '../workspace/types'

// Use mongoose's bundled mongodb types
type GridFSBucket = ReturnType<typeof createBucket>
function createBucket(db: mongoose.mongo.Db) {
  return new mongoose.mongo.GridFSBucket(db, { bucketName: 'workspace_files' })
}

let bucket: GridFSBucket | null = null

export interface GridFSFileInfo {
  id: string
  filename: string
  length: number
  uploadDate: Date
  metadata?: Record<string, unknown>
}

async function getBucket() {
  if (bucket) return bucket
  await connectDB()
  const db = mongoose.connection.db
  if (!db) throw new Error('MongoDB not connected')
  bucket = createBucket(db)
  return bucket
}

async function uploadBuffer(
  conversationId: string,
  path: string,
  buffer: Buffer,
  metadata: Record<string, unknown>,
): Promise<string> {
  const b = await getBucket()
  const uploadStream = b.openUploadStream(`${conversationId}/${path}`, { metadata })

  return new Promise((resolve, reject) => {
    uploadStream.on('finish', () => resolve(uploadStream.id.toString()))
    uploadStream.on('error', reject)
    uploadStream.end(buffer)
  })
}

/**
 * Write text or a legacy binary payload to GridFS. New raster callers must use
 * lib/media/storage and should never select base64 here.
 * Returns the GridFS file ObjectId as a string.
 */
export async function writeFileToGridFS(
  conversationId: string,
  path: string,
  content: string,
  options?: {
    encoding?: 'utf8' | 'base64'
    mimeType?: string
    capacityReservationId?: string
  },
): Promise<string> {
  // New callers specify the encoding. The heuristic remains only for old call
  // sites during the migration window and must not be used for new raster data.
  const encoding = options?.encoding || (
    content.match(/^[A-Za-z0-9+/=\s]{100,}$/) ? 'base64' : 'utf8'
  )
  const contentToStore = Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8')

  return uploadBuffer(conversationId, path, contentToStore, {
    conversationId,
    path,
    isBase64: encoding === 'base64',
    encoding,
    mimeType: options?.mimeType,
    workspaceId: conversationId,
    workspacePath: path,
    capacityReservationId: options?.capacityReservationId,
    fileSetState: options?.capacityReservationId ? 'staged' : undefined,
    size: contentToStore.length,
    uploadedAt: new Date(),
  })
}

/** Write already-validated immutable document bytes to GridFS. */
export async function writeDocumentToGridFS(
  conversationId: string,
  path: string,
  buffer: Buffer,
  options: {
    filename: string
    mimeType: string
    sha256: string
    source: WorkspaceDocumentSource
    provenance: WorkspaceDocumentProvenance
    capacityReservationId?: string
  },
): Promise<string> {
  return uploadBuffer(conversationId, path, buffer, {
    conversationId,
    path,
    kind: 'document',
    encoding: 'binary',
    isBase64: false,
    filename: options.filename,
    mimeType: options.mimeType,
    size: buffer.length,
    sha256: options.sha256,
    source: options.source,
    provenance: options.provenance,
    workspaceId: conversationId,
    workspacePath: path,
    capacityReservationId: options.capacityReservationId,
    fileSetState: options.capacityReservationId ? 'staged' : undefined,
    uploadedAt: new Date(),
  })
}

/** Read GridFS metadata without loading file bytes. */
export async function getGridFSFileInfo(fileId: string): Promise<GridFSFileInfo | null> {
  const b = await getBucket()
  try {
    const objectId = new mongoose.Types.ObjectId(fileId)
    const file = (await b.find({ _id: objectId }).limit(1).toArray())[0]
    if (!file) return null
    return {
      id: file._id.toString(),
      filename: file.filename,
      length: file.length,
      uploadDate: file.uploadDate,
      metadata: file.metadata as Record<string, unknown> | undefined,
    }
  } catch {
    return null
  }
}

/**
 * Read file content from GridFS by file ID.
 * Returns base64 string (for images) or utf-8 string (for text).
 */
export async function readFileFromGridFS(fileId: string): Promise<string | null> {
  const b = await getBucket()

  try {
    const objectId = new mongoose.Types.ObjectId(fileId)

    // Get file metadata to determine encoding
    const files = await b.find({ _id: objectId }).toArray()
    if (files.length === 0) return null

    const isBase64 = files[0].metadata?.isBase64 !== false

    const downloadStream = b.openDownloadStream(objectId)
    const chunks: Buffer[] = []

    return new Promise((resolve, reject) => {
      downloadStream.on('data', (chunk: Buffer) => chunks.push(chunk))
      downloadStream.on('end', () => {
        const buffer = Buffer.concat(chunks)
        resolve(isBase64 ? buffer.toString('base64') : buffer.toString('utf-8'))
      })
      downloadStream.on('error', (err: Error) => {
        if (err.message.includes('FileNotFound')) resolve(null)
        else reject(err)
      })
    })
  } catch {
    return null
  }
}

/**
 * Read file content from GridFS by file ID, returning the raw Buffer.
 * Used by the binary route which serves images directly with Content-Type +
 * Cache-Control headers, letting the browser cache to disk for 1 year.
 *
 * Caller is responsible for setting MIME type and cache headers.
 */
export async function readFileFromGridFSAsBuffer(
  fileId: string,
  range?: { start: number; endExclusive: number },
): Promise<Buffer | null> {
  const b = await getBucket()

  try {
    const objectId = new mongoose.Types.ObjectId(fileId)
    const files = await b.find({ _id: objectId }).toArray()
    if (files.length === 0) return null

    if (range && (
      !Number.isSafeInteger(range.start)
      || !Number.isSafeInteger(range.endExclusive)
      || range.start < 0
      || range.endExclusive <= range.start
    )) return null

    const downloadStream = b.openDownloadStream(objectId, range
      ? { start: range.start, end: range.endExclusive }
      : undefined)
    const chunks: Buffer[] = []

    return new Promise((resolve, reject) => {
      downloadStream.on('data', (chunk: Buffer) => chunks.push(chunk))
      downloadStream.on('end', () => resolve(Buffer.concat(chunks)))
      downloadStream.on('error', (err: Error) => {
        if (err.message.includes('FileNotFound')) resolve(null)
        else reject(err)
      })
    })
  } catch {
    return null
  }
}

/**
 * Delete a file from GridFS by file ID.
 */
export async function deleteFileFromGridFS(fileId: string): Promise<void> {
  const b = await getBucket()
  try {
    await b.delete(new mongoose.Types.ObjectId(fileId))
  } catch {
    // Ignore if file doesn't exist
  }
}

/**
 * Delete all files for a conversation.
 */
export async function deleteConversationFiles(conversationId: string): Promise<number> {
  const b = await getBucket()
  const files = await b.find({ 'metadata.conversationId': conversationId }).toArray()
  let count = 0
  for (const file of files) {
    await b.delete(file._id)
    count++
  }
  return count
}
