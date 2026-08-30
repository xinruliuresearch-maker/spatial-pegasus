import { NextResponse } from 'next/server'
import { listConversations } from '@/lib/db/repository'
import { resolveLocalOwner } from '@/lib/local-owner'
import { listLatestAgentRunStatesForUser } from '@/lib/agent-runtime/repository'
import { isActiveAgentRunStatus } from '@/lib/agent-runtime/types'

export async function GET() {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId

  try {
    const conversations = await listConversations(userId)
    const latestRunStates = await listLatestAgentRunStatesForUser(userId)
    // AgentRun is authoritative. Legacy Conversation flags are retained only
    // for conversations that have never created a V2 Run.
    const enriched = conversations.map(c => {
      const obj = c.toObject() as Record<string, unknown>
      const runState = latestRunStates.get(obj.conversation_id as string)
      if (runState) {
        obj.is_running = isActiveAgentRunStatus(runState.status)
        obj._waiting_for_user = runState.status === 'waiting_user'
        obj._last_interrupted = runState.status === 'cancelled'
          || runState.status === 'recoverable'
      } else {
        obj.is_running = false
      }
      return obj
    })
    return NextResponse.json(enriched)
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    )
  }
}
