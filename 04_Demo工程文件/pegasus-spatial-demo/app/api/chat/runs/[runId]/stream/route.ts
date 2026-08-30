import { NextRequest } from 'next/server'
import { resolveLocalOwner } from '@/lib/local-owner'
import {
  attachSubscriber,
  getBroadcast,
  getBroadcastRunId,
} from '@/lib/agent/stream-registry'
import { getAgentRun } from '@/lib/agent-runtime/repository'
import type { AgentRunDocument } from '@/lib/agent-runtime/models'
import { isPublicRootAgentRun } from '@/lib/agent-runtime/types'
import { DurableCompactionJobModel } from '@/lib/agent-compaction/models'
import type { DurableCompactionStatus } from '@/lib/agent-compaction/types'
import { resolvePublicCompactionCapacity } from '@/lib/agent-compaction/public-capacity'
import { getAliasCapabilities, type FrozenModelResolutionSnapshot } from '@/lib/llm-registry'

export const dynamic = 'force-dynamic'

const encoder = new TextEncoder()
const POLL_MS = 600
const HEARTBEAT_MS = 15_000
// A same-process Runner normally creates its rich event channel within one
// poll. Give it a bounded window before falling back to text-only Mongo live
// snapshots used for true cross-process recovery.
const RICH_STREAM_GRACE_MS = 5_000

function encode(event: Record<string, unknown>): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
}

function publicRunState(run: AgentRunDocument): Record<string, unknown> {
  return {
    type: 'run_state',
    run_id: run.run_id,
    conversation_id: run.conversation_id,
    status: run.status,
    checkpoint_seq: run.checkpoint_seq,
    current_action: run.current_action
      ? {
          kind: run.current_action.kind,
          action_id: run.current_action.action_id,
          tool_name: run.current_action.tool_name,
          attempt: run.current_action.attempt,
          started_at: run.current_action.started_at,
        }
      : null,
    cancellation_requested: run.cancellation_requested,
    updated_at: run.updated_at,
  }
}

function terminalEvent(run: AgentRunDocument): Record<string, unknown> | null {
  switch (run.status) {
    case 'completed':
      return {
        type: 'done',
        run_id: run.run_id,
        conversation_id: run.conversation_id,
        termination_reason: run.termination_reason,
      }
    case 'waiting_user':
      if (run.pending_interaction) {
        return {
          type: 'ask_user',
          run_id: run.run_id,
          conversation_id: run.conversation_id,
          interaction_id: run.pending_interaction.interaction_id,
          questions: run.pending_interaction.questions,
        }
      }
      return {
        type: 'waiting_for_user',
        run_id: run.run_id,
        conversation_id: run.conversation_id,
      }
    case 'waiting_agents':
      return {
        type: 'waiting_for_agents',
        run_id: run.run_id,
        conversation_id: run.conversation_id,
      }
    case 'recoverable':
      return {
        type: 'run_recoverable',
        run_id: run.run_id,
        conversation_id: run.conversation_id,
        message: run.last_error ?? '执行已中断，可以安全恢复。',
      }
    case 'cancelled':
      return {
        type: 'interrupted',
        run_id: run.run_id,
        conversation_id: run.conversation_id,
      }
    case 'failed':
      return {
        type: 'error',
        run_id: run.run_id,
        conversation_id: run.conversation_id,
        message: run.last_error ?? 'Agent Run 执行失败',
      }
    default:
      return null
  }
}

interface StreamCompactionSnapshot {
  job_id: string
  status: DurableCompactionStatus
  attempt: number
  model_alias_snapshot?: string | null
  model_resolution_snapshot?: FrozenModelResolutionSnapshot | null
  available_at?: Date | null
  last_error?: string | null
  updated_at: Date
  finished_at?: Date | null
}

async function latestCompactionEvent(
  run: AgentRunDocument,
): Promise<Record<string, unknown> | null> {
  const job = await DurableCompactionJobModel.findOne({
    owner_kind: 'conversation',
    owner_key: `conversation:${run.conversation_id}`,
    conversation_id: run.conversation_id,
    user_id: run.user_id,
  }).sort({ created_at: -1, _id: -1 }).select(
    'job_id status attempt model_alias_snapshot model_resolution_snapshot available_at last_error updated_at finished_at',
  ).lean<StreamCompactionSnapshot>()
  if (!job) return null

  const capacity = resolvePublicCompactionCapacity(job, getAliasCapabilities)
  return {
    type: 'compaction_status',
    run_id: run.run_id,
    conversation_id: run.conversation_id,
    job_id: job.job_id,
    status: job.status,
    attempt: job.attempt,
    available_at: job.available_at ?? null,
    last_error: job.last_error ?? null,
    updated_at: job.updated_at,
    finished_at: job.finished_at ?? null,
    ...(capacity ?? {}),
  }
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, POLL_MS)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId

  const { runId } = await params
  const initialRun = await getAgentRun(runId, userId)
  if (!initialRun || !isPublicRootAgentRun(initialRun)) {
    return Response.json({ error: 'Agent Run not found' }, { status: 404 })
  }

  // Same-process execution keeps the richer buffered event stream. This may
  // also be a just-finished channel retained for replay.
  if (
    initialRun.status === 'running'
    &&
    getBroadcast(initialRun.conversation_id)
    && getBroadcastRunId(initialRun.conversation_id) === runId
  ) {
    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const detach = attachSubscriber(initialRun.conversation_id, writer)
    req.signal.addEventListener('abort', () => {
      detach()
      writer.close().catch(() => {})
    }, { once: true })
    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  }

  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()

  ;(async () => {
    let lastLiveRevision = -1
    let lastStateKey = ''
    let lastCompactionKey = ''
    let lastHeartbeatAt = 0
    let runningWithoutRichStreamSince: number | null = null
    let mongoContentFallback = false
    let handedOffToBroadcast = false
    let detachBroadcast: (() => void) | null = null
    let observedRunStatus = initialRun.status
    const tryRichStreamHandoff = (): boolean => {
      if (mongoContentFallback) return false
      // A barrier-deferred Run may still have a retained, already-closed rich
      // channel from its prior dispatch. Stay on Mongo polling until Runner
      // has reclaimed it as running, otherwise background compaction becomes
      // invisible and this stream closes on stale replay.
      if (observedRunStatus !== 'running') return false
      if (
        !getBroadcast(initialRun.conversation_id)
        || getBroadcastRunId(initialRun.conversation_id) !== runId
      ) return false
      handedOffToBroadcast = true
      detachBroadcast = attachSubscriber(initialRun.conversation_id, writer)
      req.signal.addEventListener('abort', () => {
        detachBroadcast?.()
        writer.close().catch(() => {})
      }, { once: true })
      return true
    }
    try {
      while (!req.signal.aborted) {
        // The browser often reconnects a few milliseconds before the Runner's
        // internal request creates its channel. Re-check on every poll and
        // transfer this same response writer once the rich channel appears;
        // attachSubscriber replays all buffered thinking/tool events first.
        if (tryRichStreamHandoff()) return

        const run = await getAgentRun(runId, userId)
        if (!run || !isPublicRootAgentRun(run)) {
          await writer.write(encode({ type: 'error', run_id: runId, message: 'Agent Run no longer exists' }))
          break
        }
        observedRunStatus = run.status

        const stateKey = [
          run.status,
          run.checkpoint_seq,
          run.current_action?.action_id ?? '',
          run.cancellation_requested ? '1' : '0',
        ].join(':')
        const now = Date.now()
        if (run.status === 'running') {
          runningWithoutRichStreamSince ??= now
          if (now - runningWithoutRichStreamSince >= RICH_STREAM_GRACE_MS) {
            mongoContentFallback = true
          }
        } else {
          runningWithoutRichStreamSince = null
        }
        if (stateKey !== lastStateKey || now - lastHeartbeatAt >= HEARTBEAT_MS) {
          await writer.write(encode(publicRunState(run)))
          lastStateKey = stateKey
          lastHeartbeatAt = now
        }

        const liveRevision = run.live?.revision ?? -1
        if (mongoContentFallback && run.live && liveRevision !== lastLiveRevision) {
          await writer.write(encode({
            type: 'live_snapshot',
            run_id: run.run_id,
            revision: liveRevision,
            text: run.live.assistant_text,
            updated_at: run.live.updated_at,
          }))
          lastLiveRevision = liveRevision
        }

        const compaction = await latestCompactionEvent(run)
        if (compaction) {
          const compactionKey = `${String(compaction.job_id)}:${String(compaction.status)}`
          if (compactionKey !== lastCompactionKey) {
            await writer.write(encode(compaction))
            lastCompactionKey = compactionKey
          }
        }

        const terminal = terminalEvent(run)
        if (terminal) {
          await writer.write(encode(terminal))
          break
        }
        await waitForPoll(req.signal)
      }
    } catch (error) {
      if (!req.signal.aborted) {
        await writer.write(encode({
          type: 'run_detached',
          run_id: runId,
          message: `运行状态订阅暂时中断：${(error as Error).message}`,
        })).catch(() => {})
      }
    } finally {
      // Once attached, the broadcast owns the writer and closes it at the Run
      // boundary. Closing here would sever the live Root event stream.
      if (!handedOffToBroadcast) await writer.close().catch(() => {})
    }
  })()

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
