import { NextRequest, NextResponse } from 'next/server'
import { resolveLocalOwner } from '@/lib/local-owner'
import {
  getAgentRun,
  queueRecoverableAgentRun,
} from '@/lib/agent-runtime/repository'
import {
  isAgentRunnerEnabled,
  wakeAgentRunner,
} from '@/lib/agent-runtime/runner'
import { isPublicRootAgentRun } from '@/lib/agent-runtime/types'

export const dynamic = 'force-dynamic'

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId

  const { runId } = await params
  let run = await getAgentRun(runId, userId)
  if (!run || !isPublicRootAgentRun(run)) {
    return NextResponse.json({ error: 'Agent Run not found' }, { status: 404 })
  }

  if (run.status === 'recoverable') {
    if (!isAgentRunnerEnabled()) {
      return NextResponse.json({
        error: '后台 Agent Runner 尚未启用；请在该对话中继续发送消息以安全恢复此 Run。',
        code: 'background_runner_disabled',
        run_id: run.run_id,
        conversation_id: run.conversation_id,
        status: run.status,
      }, { status: 409 })
    }
    run = await queueRecoverableAgentRun(runId, userId)
    if (!run) {
      // A concurrent resume or runner claim may already have advanced it.
      run = await getAgentRun(runId, userId)
      if (run && !isPublicRootAgentRun(run)) run = null
    }
  }

  if (!run) {
    return NextResponse.json({ error: 'Agent Run state changed' }, { status: 409 })
  }
  if (run.status === 'waiting_user' || run.status === 'waiting_agents') {
    return NextResponse.json(
      { error: `This Run is waiting at a durable ${run.status === 'waiting_user' ? 'user' : 'team'} boundary, not an execution retry.` },
      { status: 409 },
    )
  }
  if (['completed', 'cancelled', 'failed'].includes(run.status)) {
    return NextResponse.json(
      { error: `Cannot resume a terminal Agent Run (${run.status})` },
      { status: 409 },
    )
  }

  wakeAgentRunner()
  return NextResponse.json({
    accepted: true,
    run_id: run.run_id,
    conversation_id: run.conversation_id,
    status: run.status,
  }, { status: 202 })
}
