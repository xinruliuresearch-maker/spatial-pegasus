import { NextRequest } from 'next/server'
import {
  executeMemberAgentRun,
  type MemberAgentExecutionOutcome,
} from '@/lib/agent-runtime/member-executor'
import {
  getAgentRun,
  validateAgentRunLeaseFence,
} from '@/lib/agent-runtime/repository'
import { validateMemberExecutionFences } from '@/lib/agent-runtime/member-session'
import { isInternalAgentRunnerRequest } from '@/lib/agent-runtime/runner'
import {
  AGENT_RUNNER_LEASE_OWNER_HEADER,
  AGENT_RUNNER_RUN_ID_HEADER,
  AGENT_RUNNER_SIGNATURE_HEADER,
} from '@/lib/agent-runtime/internal-dispatch-envelope'
import { tokenTracker } from '@/lib/agent/token-tracker'

export const dynamic = 'force-dynamic'

interface MemberDispatchBody {
  run_id?: unknown
  lease_owner_id?: unknown
  team_execution_fence_token?: unknown
  agent_session_fence_token?: unknown
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function conflict(message: string): Response {
  return Response.json({ error: message, code: 'member_dispatch_conflict' }, { status: 409 })
}

/**
 * Private JSON execution endpoint for member Agent Runs. It intentionally has
 * no user-auth fallback and never opens a public/SSE transcript: the durable
 * Runner envelope is the only authority accepted here.
 */
export async function POST(request: NextRequest): Promise<Response> {
  let body: MemberDispatchBody
  try {
    body = await request.json() as MemberDispatchBody
  } catch {
    return Response.json({ error: 'Malformed Runner dispatch body' }, { status: 400 })
  }

  const runId = nonEmptyString(body.run_id)
  const ownerId = nonEmptyString(body.lease_owner_id)
  const executionFenceToken = nonEmptyString(body.team_execution_fence_token)
  const sessionFenceToken = nonEmptyString(body.agent_session_fence_token)
  if (!runId || !ownerId || !executionFenceToken || !sessionFenceToken) {
    return Response.json({ error: 'Incomplete member Agent dispatch envelope' }, { status: 400 })
  }

  const headerRunId = request.headers.get(AGENT_RUNNER_RUN_ID_HEADER) ?? ''
  const headerOwnerId = request.headers.get(AGENT_RUNNER_LEASE_OWNER_HEADER) ?? ''
  const authorized = headerRunId === runId
    && headerOwnerId === ownerId
    && isInternalAgentRunnerRequest(
      request.headers.get(AGENT_RUNNER_SIGNATURE_HEADER),
      runId,
      ownerId,
    )
  if (!authorized) {
    return Response.json({ error: 'Unauthorized Agent Runner dispatch' }, { status: 401 })
  }

  try {
    const run = await getAgentRun(runId)
    if (!run
      || run.status !== 'running'
      || run.lease?.owner_id !== ownerId
      || run.execution_mode !== 'agent_session'
      || !run.team_id
      || !run.agent_id
      || !run.agent_session_id
      || run.root_visible !== false) {
      return conflict('Agent Runner no longer owns a valid private member Run')
    }

    const [runFenceAlive, teamFencesAlive] = await Promise.all([
      validateAgentRunLeaseFence(run.run_id, ownerId),
      validateMemberExecutionFences({
        teamId: run.team_id,
        userId: run.user_id,
        agentId: run.agent_id,
        sessionId: run.agent_session_id,
        runId: run.run_id,
        ownerId,
        executionFenceToken,
        sessionFenceToken,
      }),
    ])
    if (!runFenceAlive || !teamFencesAlive) {
      return conflict('Member Agent execution fences are no longer valid')
    }

    const outcome = await tokenTracker.runWithContext<Promise<MemberAgentExecutionOutcome>>(
      {
        userId: run.user_id,
        conversationId: run.conversation_id,
        teamId: run.team_id,
        agentId: run.agent_id,
        taskId: run.task_id,
        runId: run.run_id,
      },
      () => executeMemberAgentRun({
        run,
        ownerId,
        executionFenceToken,
        sessionFenceToken,
      }),
    )
    return Response.json(outcome)
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught))
    console.error(`[member-agent] dispatch ${runId} failed before execution ownership:`, error.message)
    return Response.json({
      error: 'Member Agent executor could not accept the dispatch',
      code: 'member_executor_unavailable',
    }, { status: 503 })
  }
}
