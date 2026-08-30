import { NextRequest } from 'next/server'
import { resolveLocalOwner } from '@/lib/local-owner'
import { getConversation } from '@/lib/db/repository'
import { agentTeamService } from '@/lib/agent-team'
import type { TeamEventRecord } from '@/lib/agent-team/types'
import {
  InvalidTeamCursorError,
  resolveTeamEventCursor,
  serializePublicTeamEvent,
} from '@/lib/agent-team/public-contract'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const encoder = new TextEncoder()
const EVENT_BATCH_SIZE = 200
const POLL_INTERVAL_MS = 750
const HEARTBEAT_INTERVAL_MS = 15_000

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId

  try {
    const { id } = await params
    const conversation = await getConversation(id, userId)
    if (!conversation) {
      return Response.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const afterSeq = resolveTeamEventCursor(
      req.nextUrl.searchParams.get('after_seq'),
      req.headers.get('last-event-id'),
    )
    const team = await agentTeamService.ensureTeam({ conversationId: id, userId })
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()

    void streamTeamEvents({
      writer,
      signal: req.signal,
      userId,
      conversationId: id,
      teamId: team.team_id,
      initialAfterSeq: afterSeq,
    })

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  } catch (error) {
    if (error instanceof InvalidTeamCursorError) {
      return Response.json({ error: error.message }, { status: 400 })
    }
    console.error('[agent-team] Failed to establish public team stream:', error)
    return Response.json({ error: 'Team status stream is temporarily unavailable' }, { status: 500 })
  }
}

async function streamTeamEvents(input: {
  writer: WritableStreamDefaultWriter<Uint8Array>
  signal: AbortSignal
  userId: string
  conversationId: string
  teamId: string
  initialAfterSeq: number
}): Promise<void> {
  let cursor = input.initialAfterSeq
  let lastHeartbeatAt = 0
  try {
    await input.writer.write(encoder.encode('retry: 2000\n\n'))
    while (!input.signal.aborted) {
      const events = await agentTeamService.listEventsAfter({
        conversationId: input.conversationId,
        teamId: input.teamId,
        userId: input.userId,
        afterSeq: cursor,
        limit: EVENT_BATCH_SIZE,
      })

      for (const event of events) {
        if (event.seq <= cursor) continue
        await input.writer.write(encodeTeamEvent(event))
        cursor = event.seq
      }

      const now = Date.now()
      if (events.length === 0 && now - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
        await input.writer.write(encoder.encode(`: keep-alive ${now}\n\n`))
        lastHeartbeatAt = now
      }
      if (events.length < EVENT_BATCH_SIZE) {
        await waitForPoll(input.signal)
      }
    }
  } catch (error) {
    if (!input.signal.aborted) {
      console.error('[agent-team] Public team stream detached:', error)
      await input.writer.write(encodeNamedEvent('team_stream_error', {
        message: 'Team 实时状态流暂时中断，客户端将自动重连。',
      })).catch(() => undefined)
    }
  } finally {
    await input.writer.close().catch(() => undefined)
  }
}

function encodeTeamEvent(event: TeamEventRecord): Uint8Array {
  return encoder.encode(serializePublicTeamEvent(event))
}

function encodeNamedEvent(name: string, data: Record<string, unknown>): Uint8Array {
  return encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(finish, POLL_INTERVAL_MS)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    function finish() {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
