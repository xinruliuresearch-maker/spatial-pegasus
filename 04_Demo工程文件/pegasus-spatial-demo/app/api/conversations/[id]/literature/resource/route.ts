import { createHash } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { resolveLocalOwner } from '@/lib/local-owner'
import { getConversation } from '@/lib/db/repository'
import { readFileFromGridFS } from '@/lib/db/gridfs'
import {
  assertSciverseProviderResourceRef,
  assertSciverseSourceFulltextPath,
  extractMarkdownImageReferences,
  fetchSciverseImageResource,
  SciverseResourceError,
} from '@/lib/literature/sciverse-resource'
import type { FileEntry } from '@/lib/workspace/types'
import { isDocumentFileEntry, isRasterFileEntry } from '@/lib/workspace/types'
import { agentTeamService } from '@/lib/agent-team'
import {
  MultiAgentWorkspaceRepository,
  workspaceFileSnapshotToFileEntry,
} from '@/lib/workspace/multi-agent'

const PRIVATE_CACHE = 'private, max-age=3600, stale-while-revalidate=86400'
const MAX_REFERENCE_CACHE_ENTRIES = 128
const referenceCache = new Map<string, ReadonlySet<string>>()

function cachedReferences(key: string): ReadonlySet<string> | undefined {
  const value = referenceCache.get(key)
  if (!value) return undefined
  referenceCache.delete(key)
  referenceCache.set(key, value)
  return value
}

function storeReferences(key: string, value: ReadonlySet<string>): void {
  referenceCache.set(key, value)
  while (referenceCache.size > MAX_REFERENCE_CACHE_ENTRIES) {
    const oldest = referenceCache.keys().next().value
    if (typeof oldest !== 'string') break
    referenceCache.delete(oldest)
  }
}

/**
 * GET /api/conversations/:id/literature/resource?source_path=...&ref=...
 *
 * Authenticated, document-bound proxy for images referenced by a saved
 * Sciverse source-fulltext.md. The caller never controls an upstream host.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId

  try {
    const { id } = await params
    const sourcePath = assertSciverseSourceFulltextPath(
      req.nextUrl.searchParams.get('source_path') ?? '',
    )
    const ref = assertSciverseProviderResourceRef(
      req.nextUrl.searchParams.get('ref') ?? '',
    )

    const conversation = await getConversation(id, userId)
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const filesMap = (conversation.output as Record<string, unknown> | undefined)?.files as
      | Record<string, FileEntry>
      | undefined
    let entry = filesMap?.[sourcePath]
    const team = await agentTeamService.ensureTeam({
      conversationId: id,
      userId,
      workspaceId: id,
    })
    const authoritative = await new MultiAgentWorkspaceRepository().getFile(
      team.workspace_id,
      sourcePath,
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
    if (!entry || isDocumentFileEntry(entry) || isRasterFileEntry(entry) || !entry.gridfs_id) {
      return NextResponse.json({ error: 'Source document not found' }, { status: 404 })
    }

    let references = cachedReferences(entry.gridfs_id)
    if (!references) {
      const markdown = await readFileFromGridFS(entry.gridfs_id)
      if (markdown === null) {
        return NextResponse.json({ error: 'Source document not found' }, { status: 404 })
      }
      references = extractMarkdownImageReferences(markdown)
      storeReferences(entry.gridfs_id, references)
    }
    if (!references.has(ref)) {
      return NextResponse.json({ error: 'Image reference not found in source document' }, { status: 404 })
    }

    const resource = await fetchSciverseImageResource(ref, { signal: req.signal })
    const etag = `"${createHash('sha256').update(resource.bytes).digest('hex')}"`
    const headers: Record<string, string> = {
      'Content-Type': resource.contentType,
      'Content-Length': String(resource.bytes.length),
      'Cache-Control': PRIVATE_CACHE,
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      ETag: etag,
    }
    if (req.headers.get('if-none-match') === etag) {
      return new NextResponse(null, { status: 304, headers })
    }
    return new NextResponse(new Uint8Array(resource.bytes), { status: 200, headers })
  } catch (error) {
    if (error instanceof SciverseResourceError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    }
    return NextResponse.json({ error: 'Unable to load Sciverse image resource' }, { status: 500 })
  }
}
