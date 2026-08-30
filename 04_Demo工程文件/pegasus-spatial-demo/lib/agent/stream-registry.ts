// ============================================================
// Per-conversation SSE broadcast registry (process-level)
// Decouples the agent loop lifecycle from client fetch lifecycle.
// Multiple clients (tabs / refreshed page / late joiners) can
// subscribe to the same conversation's event stream.
// ============================================================

type SSEEvent = Record<string, unknown>

type Writer = WritableStreamDefaultWriter<Uint8Array>

interface Broadcast {
  runId?: string
  subscribers: Set<Writer>
  events: SSEEvent[]
  done: boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const channels: Map<string, Broadcast> = (globalThis as any).__sci_pegasus_broadcast_channels ??= new Map()
const encoder = new TextEncoder()

const GC_DELAY_MS = 30_000

function encode(event: SSEEvent): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
}

/** Create a fresh broadcast channel. Throws only if an ACTIVE channel already exists
 *  (real concurrent-request collision). A previous channel in its post-close 30s GC
 *  window is replaced transparently — otherwise back-to-back user messages within
 *  the GC window throw spuriously. */
export function createBroadcast(conversationId: string): Broadcast {
  const existing = channels.get(conversationId)
  if (existing && !existing.done) {
    throw new Error(`Broadcast channel already exists for conversation ${conversationId}`)
  }
  // Previous channel completed and is just lingering for late replay — evict it so
  // the new loop can take over the slot.
  const channel: Broadcast = { subscribers: new Set(), events: [], done: false }
  channels.set(conversationId, channel)
  return channel
}

export function getBroadcast(conversationId: string): Broadcast | undefined {
  return channels.get(conversationId)
}

export function bindBroadcastRun(conversationId: string, runId: string): void {
  const channel = channels.get(conversationId)
  if (!channel) return
  channel.runId = runId
}

export function getBroadcastRunId(conversationId: string): string | undefined {
  return channels.get(conversationId)?.runId
}

export function hasActiveBroadcast(conversationId: string): boolean {
  const ch = channels.get(conversationId)
  return !!ch && !ch.done
}

/** Push an event to the buffer and write to all current subscribers. */
export function broadcast(conversationId: string, event: SSEEvent): void {
  const channel = channels.get(conversationId)
  if (!channel) return
  channel.events.push(event)
  const payload = encode(event)
  for (const writer of channel.subscribers) {
    writer.write(payload).catch(() => {
      channel.subscribers.delete(writer)
    })
  }
}

/**
 * Attach a new subscriber. Replays buffered events synchronously, then streams live.
 * If the channel is already `done`, replays buffer and closes immediately.
 * Returns a detach function the caller should invoke on client disconnect.
 */
export function attachSubscriber(conversationId: string, writer: Writer): () => void {
  const channel = channels.get(conversationId)
  if (!channel) {
    writer.close().catch(() => {})
    return () => {}
  }

  // Replay buffered events
  for (const event of channel.events) {
    writer.write(encode(event)).catch(() => {})
  }

  if (channel.done) {
    writer.close().catch(() => {})
    return () => {}
  }

  channel.subscribers.add(writer)
  return () => { channel.subscribers.delete(writer) }
}

/**
 * Drop buffered events without affecting live subscribers.
 * Called after incremental DB persistence — those events are now reflected in the DB,
 * so reconnecting clients will pick them up via loadConversation instead of stream replay.
 */
export function clearBroadcastBuffer(conversationId: string): void {
  const channel = channels.get(conversationId)
  if (!channel) return
  channel.events.length = 0
}

/** Broadcast an event to every active channel and close them all.
 *  Used by the SIGTERM handler so connected clients see a shutdown signal
 *  instead of a mysterious dropped connection. */
export function shutdownAllBroadcasts(event: SSEEvent): number {
  let count = 0
  for (const convId of Array.from(channels.keys())) {
    const channel = channels.get(convId)
    if (!channel || channel.done) continue
    broadcast(convId, event)
    closeBroadcast(convId)
    count++
  }
  return count
}

/**
 * Mark the broadcast done, close all subscriber writers, and schedule GC.
 * Idempotent. New subscribers arriving before GC will receive buffer replay + close.
 */
export function closeBroadcast(conversationId: string): void {
  const channel = channels.get(conversationId)
  if (!channel || channel.done) return
  channel.done = true
  for (const writer of channel.subscribers) {
    writer.close().catch(() => {})
  }
  channel.subscribers.clear()
  setTimeout(() => {
    // Only GC if still the same channel (protect against a new run reusing the id)
    if (channels.get(conversationId) === channel) {
      channels.delete(conversationId)
    }
  }, GC_DELAY_MS)
}

/**
 * Close and remove a short-lived transport channel immediately.
 *
 * The browser submission channel ends at `run_detached`; it must not linger
 * as a replay candidate because the durable Runner creates a second channel
 * for the same Run containing the full thinking/tool event stream. Keeping the
 * hand-off channel for the normal GC window lets an eager reconnect attach to
 * the wrong (already completed) stream and permanently miss Root activity.
 */
export function discardBroadcast(conversationId: string): void {
  const channel = channels.get(conversationId)
  if (!channel) return
  channel.done = true
  for (const writer of channel.subscribers) {
    writer.close().catch(() => {})
  }
  channel.subscribers.clear()
  if (channels.get(conversationId) === channel) {
    channels.delete(conversationId)
  }
}
