import { NextRequest, NextResponse } from 'next/server'
import sharp from 'sharp'
import { getConversation } from '@/lib/db/repository'
import { getGridFSFileInfo, readFileFromGridFSAsBuffer } from '@/lib/db/gridfs'
import { resolveLocalOwner } from '@/lib/local-owner'
import { getOwnedImageAsset, readImageAsset } from '@/lib/media/storage'
import { toRasterAssetRef } from '@/lib/media/reference'
import { isInternalWorkspacePath } from '@/lib/workspace/path-policy'
import {
  type FileEntry,
  isDocumentFileEntry,
  isRasterFileEntry,
} from '@/lib/workspace/types'
import { agentTeamService } from '@/lib/agent-team'
import {
  MultiAgentWorkspaceRepository,
  workspaceFileSnapshotToFileEntry,
} from '@/lib/workspace/multi-agent'

/**
 * GET /api/conversations/[id]/files/binary?path=<workspace-path>&w=<width>
 *
 * Serves a workspace file's raw binary content. Immutable documents use a
 * checksum-versioned URL and support a single HTTP byte range; raster assets
 * retain their existing optimized redirect/resize behavior.
 *
 * Optional `w` query (1-4096, image types only) triggers an on-the-fly sharp
 * resize-to-webp. Used for thumbnails (e.g. `?w=128` for the gallery rail,
 * `?w=320` for project cards, `?w=1024` for the main viewer). Omit `w` to
 * download the unmodified original.
 *
 * Sibling of /files which returns base64 JSON; that route is kept as fallback.
 */
const RESIZABLE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const MAX_WIDTH = 4096

type ParsedRange = { start: number; endExclusive: number }

function parseRangeHeader(value: string | null, size: number): ParsedRange | null | 'invalid' {
  if (!value) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match || size <= 0) return 'invalid'
  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) return 'invalid'

  if (!rawStart) {
    const suffixLength = Number(rawEnd)
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'invalid'
    return { start: Math.max(0, size - suffixLength), endExclusive: size }
  }

  const start = Number(rawStart)
  const inclusiveEnd = rawEnd ? Number(rawEnd) : size - 1
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(inclusiveEnd)
    || start < 0
    || start >= size
    || inclusiveEnd < start
  ) return 'invalid'
  return { start, endExclusive: Math.min(size, inclusiveEnd + 1) }
}

function contentDisposition(filename: string, attachment: boolean): string {
  const fallback = filename
    .replace(/[\r\n]/g, '_')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_')
    .slice(0, 180) || 'document.pdf'
  const encoded = encodeURIComponent(filename)
    .replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${attachment ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId

  try {
    const { id } = await params
    const path = req.nextUrl.searchParams.get('path')
    if (!path) {
      return NextResponse.json({ error: 'Missing path query parameter' }, { status: 400 })
    }
    if (isInternalWorkspacePath(path)) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 })
    }

    const widthParam = req.nextUrl.searchParams.get('w')
    let width: number | null = null
    if (widthParam) {
      const parsed = parseInt(widthParam, 10)
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_WIDTH) {
        width = parsed
      }
    }

    const conversation = await getConversation(id, userId)
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const filesMap = (conversation.output as Record<string, unknown> | undefined)?.files as
      | Record<string, FileEntry>
      | undefined
    let entry = filesMap?.[path]
    const team = await agentTeamService.ensureTeam({
      conversationId: id,
      userId,
      workspaceId: id,
    })
    const authoritative = await new MultiAgentWorkspaceRepository().getFile(
      team.workspace_id,
      path,
      {
        teamId: team.team_id,
        agentId: team.root_agent_id,
        rootAgentId: team.root_agent_id,
        role: 'root',
      },
    )
    if (authoritative) {
      entry = workspaceFileSnapshotToFileEntry(authoritative, entry)
    }
    if (isRasterFileEntry(entry)) {
      const asset = await getOwnedImageAsset(entry.asset_id, userId, id)
      if (!asset) return NextResponse.json({ error: `Asset not found: ${path}` }, { status: 404 })
      const variant = width == null ? 'original' : width <= 256 ? 'thumbnail' : 'model'
      if (req.nextUrl.searchParams.get('inline') === '1') {
        const found = await readImageAsset(entry.asset_id, variant)
        if (!found) return NextResponse.json({ error: `Asset bytes not found: ${path}` }, { status: 404 })
        const selected = found.asset.variants[variant]
        return new NextResponse(new Uint8Array(found.buffer), {
          headers: {
            'Content-Type': selected.mimeType,
            'Content-Length': String(found.buffer.length),
            'Content-Disposition': contentDisposition(path.split('/').at(-1) || 'image', req.nextUrl.searchParams.get('download') === '1'),
            'Cache-Control': 'private, max-age=3600',
            'Cross-Origin-Resource-Policy': 'same-origin',
            'X-Content-Type-Options': 'nosniff',
          },
        })
      }
      return NextResponse.redirect(toRasterAssetRef(asset).urls[variant], 307)
    }

    if (isDocumentFileEntry(entry)) {
      const requestedVersion = req.nextUrl.searchParams.get('v')
      if (requestedVersion && requestedVersion !== entry.sha256) {
        return NextResponse.json({ error: 'Document version no longer matches this path' }, { status: 412 })
      }

      const fileInfo = await getGridFSFileInfo(entry.gridfs_id)
      if (
        !fileInfo
        || fileInfo.length !== entry.size_bytes
        || fileInfo.metadata?.conversationId !== id
        || fileInfo.metadata?.path !== path
      ) {
        return NextResponse.json({ error: `GridFS entry missing for ${path}` }, { status: 404 })
      }

      const range = parseRangeHeader(req.headers.get('range'), entry.size_bytes)
      if (range === 'invalid') {
        return new NextResponse(null, {
          status: 416,
          headers: {
            'Content-Range': `bytes */${entry.size_bytes}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, no-cache',
          },
        })
      }

      const etag = `"${entry.sha256}"`
      if (!range && req.headers.get('if-none-match') === etag) {
        return new NextResponse(null, {
          status: 304,
          headers: { ETag: etag, 'Cache-Control': requestedVersion ? 'private, max-age=31536000, immutable' : 'private, no-cache' },
        })
      }

      const buffer = await readFileFromGridFSAsBuffer(entry.gridfs_id, range || undefined)
      if (buffer === null) {
        return NextResponse.json({ error: `GridFS entry missing for ${path}` }, { status: 404 })
      }
      const headers: Record<string, string> = {
        'Content-Type': entry.mime_type,
        'Content-Length': String(buffer.length),
        'Content-Disposition': contentDisposition(entry.filename, req.nextUrl.searchParams.get('download') === '1'),
        'Accept-Ranges': 'bytes',
        'Cache-Control': requestedVersion ? 'private, max-age=31536000, immutable' : 'private, no-cache',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff',
        ETag: etag,
      }
      if (range) {
        headers['Content-Range'] = `bytes ${range.start}-${range.endExclusive - 1}/${entry.size_bytes}`
      }
      return new NextResponse(new Uint8Array(buffer), { status: range ? 206 : 200, headers })
    }

    const gridfsId = entry?.gridfs_id
    if (!gridfsId) {
      return NextResponse.json({ error: `File not found: ${path}` }, { status: 404 })
    }

    const buffer = await readFileFromGridFSAsBuffer(gridfsId)
    if (buffer === null) {
      return NextResponse.json({ error: `GridFS entry missing for ${path}` }, { status: 404 })
    }

    const lower = path.toLowerCase()
    let contentType = entry?.mime_type || 'application/octet-stream'
    if (lower.endsWith('.png')) contentType = 'image/png'
    else if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) contentType = 'image/jpeg'
    else if (lower.endsWith('.webp')) contentType = 'image/webp'
    else if (lower.endsWith('.gif')) contentType = 'image/gif'
    else if (lower.endsWith('.svg')) contentType = 'image/svg+xml'
    else if (lower.endsWith('.xml')) contentType = 'application/xml; charset=utf-8'

    // Optional resize: only for raster image types, only if `w` was provided.
    let outBuffer: Buffer = buffer
    let outContentType = contentType
    if (width && RESIZABLE.has(contentType)) {
      try {
        outBuffer = await sharp(buffer)
          .resize(width, null, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 85 })
          .toBuffer()
        outContentType = 'image/webp'
      } catch {
        // sharp failed (corrupt source?) — fall through and serve the original.
      }
    }

    // Legacy GridFS paths are mutable lookup keys, not content-addressed URLs.
    // Require revalidation so an in-place workspace overwrite cannot remain
    // stale in the browser's immutable cache.
    return new NextResponse(new Uint8Array(outBuffer), {
      status: 200,
      headers: {
        'Content-Type': outContentType,
        'Content-Length': outBuffer.length.toString(),
        'Cache-Control': 'private, no-cache',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    )
  }
}
