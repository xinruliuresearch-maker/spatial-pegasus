// ============================================================
// Process-level sliding-window counter.
// Stores event timestamps per key; on each call, prunes expired
// timestamps and decides whether adding a new one would exceed limit.
//
// Uses globalThis singleton so Next.js dev-mode module reloads
// don't wipe counts (same pattern as abort-registry / stream-registry).
// ============================================================

export interface CheckResult {
  allowed: boolean
  /** Ms until the oldest in-window event expires — client can retry after this */
  retryAfterMs: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const store: Map<string, number[]> = (globalThis as any).__sci_pegasus_rate_window ??= new Map()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const gcStarted: { value: boolean } = (globalThis as any).__sci_pegasus_rate_window_gc ??= { value: false }

function startGC(): void {
  if (gcStarted.value) return
  gcStarted.value = true
  setInterval(() => {
    const now = Date.now()
    for (const [key, ts] of store.entries()) {
      // Keep only the max possible window (24h) worth of events; older = safe to drop.
      // Specific checks prune more aggressively per call.
      const cutoff = now - 24 * 60 * 60 * 1000
      const pruned = ts.filter(t => t > cutoff)
      if (pruned.length === 0) store.delete(key)
      else if (pruned.length !== ts.length) store.set(key, pruned)
    }
  }, 60_000).unref?.()
}
startGC()

/**
 * Record a new event and check whether count is within limit.
 * Sliding window: always prunes timestamps older than `windowMs`.
 * Returns allowed=true and records the event, or allowed=false WITHOUT recording.
 */
export function recordAndCheck(key: string, windowMs: number, limit: number): CheckResult {
  const now = Date.now()
  const cutoff = now - windowMs
  const existing = store.get(key) ?? []
  // Prune expired entries in-place
  const pruned: number[] = []
  for (const t of existing) {
    if (t > cutoff) pruned.push(t)
  }
  if (pruned.length >= limit) {
    // Would exceed — compute when oldest in-window entry will fall out
    const oldest = pruned[0]
    const retryAfterMs = Math.max(1, oldest + windowMs - now)
    store.set(key, pruned)
    return { allowed: false, retryAfterMs }
  }
  pruned.push(now)
  store.set(key, pruned)
  return { allowed: true, retryAfterMs: 0 }
}

/**
 * Check without recording — used for composite checks where multiple
 * windows must all pass before the event is "recorded" on every key.
 */
export function peek(key: string, windowMs: number, limit: number): CheckResult {
  const now = Date.now()
  const cutoff = now - windowMs
  const existing = store.get(key) ?? []
  const pruned = existing.filter(t => t > cutoff)
  if (pruned.length !== existing.length) store.set(key, pruned)
  if (pruned.length >= limit) {
    const oldest = pruned[0]
    const retryAfterMs = Math.max(1, oldest + windowMs - now)
    return { allowed: false, retryAfterMs }
  }
  return { allowed: true, retryAfterMs: 0 }
}

/** Record an event on a key (always succeeds) — used after peek passed composite check. */
export function record(key: string): void {
  const existing = store.get(key) ?? []
  existing.push(Date.now())
  store.set(key, existing)
}
