import { NextResponse } from 'next/server'
import { resolveLocalOwner } from '@/lib/local-owner'
import { agentTeamService } from '@/lib/agent-team'
import { getConversation } from '@/lib/db/repository'
import { readFileFromGridFSAsBuffer } from '@/lib/db/gridfs'
import {
  buildLiteraturePaperSummaries,
  MAX_PAPER_SUMMARY_FILES,
  type LiteraturePaperSummaryFile,
} from '@/lib/literature/paper-summaries'
import { MultiAgentWorkspaceRepository } from '@/lib/workspace/multi-agent'
import type { WorkspaceFileSnapshot } from '@/lib/workspace/multi-agent'

export const runtime = 'nodejs'

/**
 * GET /api/conversations/:id/literature/papers
 *
 * Returns one bounded, presentation-only summary for each published literature
 * bundle. It never projects private Agent paths and never sends source bytes to
 * the sidebar; metadata and a short Markdown prefix are read server-side once.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId

  try {
    const { id } = await params
    const conversation = await getConversation(id, userId)
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const team = await agentTeamService.ensureTeam({
      conversationId: id,
      userId,
      workspaceId: id,
    })
    const repository = new MultiAgentWorkspaceRepository()
    const authoritative = await repository.listFiles(team.workspace_id, {
      teamId: team.team_id,
      agentId: team.root_agent_id,
      rootAgentId: team.root_agent_id,
      role: 'root',
    })

    // Workspace capacity is 500, but keep an explicit route boundary so a
    // malformed/migrated store can never turn this into an unbounded read.
    const published = authoritative
      .filter(file => file.visibility === 'public' || file.visibility === 'managed_reference')
      .slice(0, MAX_PAPER_SUMMARY_FILES)
    const byPath = new Map(published.map(file => [file.path, file]))
    const descriptors: LiteraturePaperSummaryFile[] = published.map(file => ({
      path: file.path,
      visibility: file.visibility,
      sizeBytes: file.metadata.size_bytes,
    }))

    const papers = await buildLiteraturePaperSummaries(
      descriptors,
      (file, maxBytes) => readTextPrefix(byPath.get(file.path), maxBytes),
    )
    return NextResponse.json(
      { papers },
      { headers: { 'Cache-Control': 'private, max-age=30, stale-while-revalidate=120' } },
    )
  } catch (error) {
    console.error('[literature/papers] Failed to build paper summaries', error)
    return NextResponse.json({ error: 'Unable to load literature summaries' }, { status: 500 })
  }
}

async function readTextPrefix(
  file: WorkspaceFileSnapshot | undefined,
  maxBytes: number,
): Promise<string | null> {
  if (
    !file
    || file.storage_ref.driver !== 'gridfs'
    || file.metadata.kind !== 'text'
    || !file.metadata.mime_type.startsWith('text/') && file.metadata.mime_type !== 'application/json'
  ) return null

  const endExclusive = Math.min(file.metadata.size_bytes, maxBytes)
  if (endExclusive <= 0) return ''
  const bytes = await readFileFromGridFSAsBuffer(file.storage_ref.object_id, {
    start: 0,
    endExclusive,
  })
  return bytes?.toString('utf8') ?? null
}
