import { NextRequest, NextResponse } from 'next/server'
import { getConversation } from '@/lib/db/repository'
import { readFileFromGridFS } from '@/lib/db/gridfs'
import { resolveLocalOwner } from '@/lib/local-owner'
import { getOwnedImageAsset } from '@/lib/media/storage'
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
 * GET /api/conversations/[id]/files?path=<workspace-path>
 *
 * Reads a workspace file's content from GridFS. The path is looked up in
 * `output.files[path].gridfs_id` of the conversation document; path is used as
 * a map key only, never touches disk, so no cross-directory validation needed.
 *
 * New raster entries return an asset ref; documents return metadata plus
 * checksum-versioned raw/download URLs. Text and migration-window GridFS
 * entries retain the legacy content response.
 */
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
    if (isDocumentFileEntry(entry)) {
      const encodedPath = encodeURIComponent(path)
      const version = encodeURIComponent(entry.sha256)
      const rawUrl = `/api/conversations/${encodeURIComponent(id)}/files/binary?path=${encodedPath}&v=${version}`
      return NextResponse.json({
        document: {
          path,
          filename: entry.filename,
          mimeType: entry.mime_type,
          sizeBytes: entry.size_bytes,
          sha256: entry.sha256,
          source: entry.source,
          provenance: entry.provenance,
          rawUrl,
          downloadUrl: `${rawUrl}&download=1`,
        },
        isBase64: false,
      })
    }
    if (isRasterFileEntry(entry)) {
      const asset = await getOwnedImageAsset(entry.asset_id, userId, id)
      if (!asset) return NextResponse.json({ error: `Asset not found: ${path}` }, { status: 404 })
      return NextResponse.json({ asset: toRasterAssetRef(asset), isBase64: false })
    }

    const gridfsId = entry?.gridfs_id
    if (!gridfsId) {
      return NextResponse.json({ error: `File not found: ${path}` }, { status: 404 })
    }

    const content = await readFileFromGridFS(gridfsId)
    if (content === null) {
      return NextResponse.json({ error: `GridFS entry missing for ${path}` }, { status: 404 })
    }

    // Migration fallback only: legacy GridFS images return base64, while all
    // new raster writes use asset entries and return above without bytes.
    // We don't have direct access to that flag here, but the frontend can infer by extension.
    const lower = path.toLowerCase()
    const isBase64 =
      lower.endsWith('.png') ||
      lower.endsWith('.jpg') ||
      lower.endsWith('.jpeg') ||
      lower.endsWith('.webp') ||
      lower.endsWith('.gif')

    return NextResponse.json({ content, isBase64 })
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    )
  }
}
