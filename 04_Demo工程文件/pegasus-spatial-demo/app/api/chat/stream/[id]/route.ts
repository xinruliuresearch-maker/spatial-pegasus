import { NextRequest } from 'next/server'
import { getBroadcast, attachSubscriber } from '@/lib/agent/stream-registry'
import { getConversation } from '@/lib/db/repository'
import { resolveLocalOwner } from '@/lib/local-owner'
import { getActiveAgentRun } from '@/lib/agent-runtime/repository'

export const dynamic = 'force-dynamic'

/**
 * Reconnect endpoint — attach a late-joining client to an in-progress (or just-finished)
 * SSE broadcast. The client receives buffered events (replay) followed by live stream,
 * so page refreshes / tab switches do not lose in-flight agent loop progress.
 *
 * Responses:
 *   200 SSE stream — active or recently-finished broadcast
 *   204 No Content — no active broadcast for this conversation (client should fall back
 *                    to loadConversation via the DB)
 *   404 / 403     — conversation does not exist or does not belong to the user
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId

  const { id } = await params

  // Ownership check — prevent attaching to another user's conversation
  const conversation = await getConversation(id, userId)
  if (!conversation) {
    return new Response(JSON.stringify({ error: 'Conversation not found' }), { status: 404 })
  }

  const channel = getBroadcast(id)
  if (!channel) {
    const activeRun = await getActiveAgentRun(id, userId)
    if (activeRun) {
      return Response.redirect(
        new URL(`/api/chat/runs/${encodeURIComponent(activeRun.run_id)}/stream`, req.url),
        307,
      )
    }
    return new Response(null, { status: 204 })
  }

  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const detach = attachSubscriber(id, writer)

  // Detach (but do NOT stop the loop) when this client disconnects
  req.signal.addEventListener('abort', () => {
    detach()
    writer.close().catch(() => {})
  })

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
