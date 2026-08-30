// ============================================================
// High-level rate-limit check functions.
// Callers: API route handlers for message rate and concurrency.
// ============================================================

import { getUserLimits } from './limits'
import { peek, record } from './sliding-window'
import { getUserActiveLoopCount } from '../agent/abort-registry'
import { countActiveAgentRunsForUser } from '../agent-runtime/repository'

export type RateLimitCode =
  | 'messages_per_minute_exceeded'
  | 'messages_per_day_exceeded'
  | 'concurrent_loops_exceeded'

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; code: RateLimitCode; reason: string; retryAfterMs: number }

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Check per-minute AND per-day message rate atomically.
 * Records on both keys only if both pass, so a failed check doesn't
 * "burn" quota on the passing window.
 */
export async function checkMessageRate(userId: string): Promise<RateLimitResult> {
  const limits = await getUserLimits(userId)
  const minuteKey = `msg:${userId}:minute`
  const dayKey = `msg:${userId}:day`

  const minutePeek = peek(minuteKey, MINUTE_MS, limits.messagesPerMinute)
  if (!minutePeek.allowed) {
    return {
      allowed: false,
      code: 'messages_per_minute_exceeded',
      reason: `发送过于频繁，请 ${Math.ceil(minutePeek.retryAfterMs / 1000)} 秒后再试`,
      retryAfterMs: minutePeek.retryAfterMs,
    }
  }

  const dayPeek = peek(dayKey, DAY_MS, limits.messagesPerDay)
  if (!dayPeek.allowed) {
    const hours = Math.ceil(dayPeek.retryAfterMs / (60 * 60 * 1000))
    return {
      allowed: false,
      code: 'messages_per_day_exceeded',
      reason: `今日消息额度已用完，请 ${hours} 小时后再试`,
      retryAfterMs: dayPeek.retryAfterMs,
    }
  }

  // Both passed — record on both keys
  record(minuteKey)
  record(dayKey)
  return { allowed: true }
}

/** Check whether the user can start another concurrent agent loop. */
export async function checkConcurrency(
  userId: string,
  options?: { excludeRunId?: string },
): Promise<RateLimitResult> {
  const limits = await getUserLimits(userId)
  // Mongo is the cross-instance source of truth for public Root conversations.
  // Private member Runs are governed by their Team execution slots and budget,
  // so a queue of persistent members must not block a user's Root correction.
  // The process-local registry is retained as a low-latency fallback during
  // rollout and for the narrow window before a newly accepted request persists.
  const [persistedActive, localActive] = await Promise.all([
    countActiveAgentRunsForUser(userId, options?.excludeRunId),
    Promise.resolve(getUserActiveLoopCount(userId)),
  ])
  // A waiting/recoverable Run resumes in place and therefore must not consume
  // a second slot. It has no live process-local loop, so the local guard is
  // relevant only for genuinely new Runs.
  const active = options?.excludeRunId
    ? persistedActive
    : Math.max(persistedActive, localActive)
  if (active >= limits.concurrentLoops) {
    return {
      allowed: false,
      code: 'concurrent_loops_exceeded',
      reason: `同时进行的对话已达上限（${limits.concurrentLoops} 个），请等待其他对话完成后再发起`,
      retryAfterMs: 30_000,
    }
  }
  return { allowed: true }
}

/**
 * Build a 429 Response body from a denied RateLimitResult.
 * Use only when `result.allowed === false`.
 */
export function rateLimitResponse(result: Extract<RateLimitResult, { allowed: false }>): Response {
  const retryAfterSec = Math.ceil(result.retryAfterMs / 1000)
  return new Response(
    JSON.stringify({
      error: result.reason,
      code: result.code,
      retry_after_ms: result.retryAfterMs,
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfterSec),
      },
    }
  )
}
