import { NextRequest, NextResponse } from 'next/server'
import { resolveLocalOwner } from '@/lib/local-owner'
import { getConversation } from '@/lib/db/repository'
import { agentTeamService } from '@/lib/agent-team'
import { toPublicTeamSnapshot } from '@/lib/agent-team/public-contract'
import { getLatestAgentRun } from '@/lib/agent-runtime/repository'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(
  _req: NextRequest,
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

    await agentTeamService.ensureTeam({ conversationId: id, userId })
    const [snapshot, latestRootRun] = await Promise.all([
      agentTeamService.inspectTeam({
        conversationId: id,
        userId,
        includeMessages: false,
      }),
      getLatestAgentRun(id, userId),
    ])

    return NextResponse.json(toPublicTeamSnapshot(snapshot, {
      latestRootRun: latestRootRun
        ? { run_id: latestRootRun.run_id, status: latestRootRun.status }
        : null,
    }), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    console.error('[agent-team] Failed to load public team snapshot:', error)
    return NextResponse.json({ error: 'Team status is temporarily unavailable' }, { status: 500 })
  }
}
