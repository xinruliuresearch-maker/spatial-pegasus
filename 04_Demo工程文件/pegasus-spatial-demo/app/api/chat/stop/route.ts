import { NextRequest, NextResponse } from 'next/server'
import { interruptConversation } from '@/lib/agent/abort-registry'
import { resolveLocalOwner } from '@/lib/local-owner'
import {
  cancelInactiveAgentRun,
  requestRunCancellation,
} from '@/lib/agent-runtime/repository'

export const dynamic = 'force-dynamic'

/**
 * Explicit stop endpoint — aborts a running agent loop.
 * The agent loop is detached from client fetch lifecycle; this is the only way to stop it.
 */
export async function POST(req: NextRequest) {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId

  const { conversation_id, run_id } = await req.json() as {
    conversation_id?: string
    run_id?: string
  }
  if (!conversation_id) {
    return NextResponse.json({ error: 'conversation_id is required' }, { status: 400 })
  }

  const run = await requestRunCancellation(conversation_id, userId, run_id)
  if (!run) {
    return NextResponse.json({ stopped: false, reason: 'no_active_run' })
  }

  const interruptedLocally = interruptConversation(conversation_id)
  const cancelledWithoutRunner = interruptedLocally
    ? false
    : await cancelInactiveAgentRun(run.run_id, userId)

  return NextResponse.json({
    stopped: interruptedLocally || cancelledWithoutRunner || !!run,
    run_id: run.run_id,
    persisted: true,
  })
}
