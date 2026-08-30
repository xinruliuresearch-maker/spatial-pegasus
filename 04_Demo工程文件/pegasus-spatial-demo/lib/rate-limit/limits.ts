// ============================================================
// User rate limit thresholds — central source of truth.
// Plan-keyed limits live in the `plan_limits` collection (owned and edited
// by deployment administration); Sci-Pegasus reads them here with a 30s in-memory
// cache so the rate-limit hot path doesn't hit Mongo on every request.
// `DEFAULT_LIMITS` is the fallback whenever the DB read fails or the plan
// has no row yet, so a Mongo blip never takes rate-limiting offline.
// ============================================================

import { connectDB } from '@/lib/db/mongodb'
import { PlanLimit } from '@/lib/db/plan-limit-models'
import { getUserPlan } from '@/lib/demo-access-policy'
import type { UserPlan } from '@/lib/llm-registry'

export interface UserLimits {
  messagesPerMinute: number
  messagesPerDay: number
  concurrentLoops: number
}

export const DEFAULT_LIMITS: UserLimits = {
  messagesPerMinute: 10,
  messagesPerDay: 200,
  // Public Root conversations are admitted independently from private Team
  // members. Team-level slot fencing and budgets enforce member concurrency.
  concurrentLoops: 8,
}

const CACHE_TTL_MS = 30_000

interface CacheEntry {
  limits: UserLimits
  fetchedAt: number
}

// Plan → limits cache. Keyed by plan (not user_id) because every user on
// the same plan reads the same thresholds — caching per user_id would
// 100x the memory footprint with no benefit.
const cache = new Map<string, CacheEntry>()

function mapDocToLimits(doc: {
  messages_per_minute?: number
  messages_per_day?: number
  concurrent_loops?: number
}): UserLimits {
  return {
    messagesPerMinute: doc.messages_per_minute ?? DEFAULT_LIMITS.messagesPerMinute,
    messagesPerDay: doc.messages_per_day ?? DEFAULT_LIMITS.messagesPerDay,
    concurrentLoops: doc.concurrent_loops ?? DEFAULT_LIMITS.concurrentLoops,
  }
}

async function loadLimitsForPlan(plan: string): Promise<UserLimits> {
  const cached = cache.get(plan)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.limits
  }

  try {
    await connectDB()
    const doc = await PlanLimit.findOne({ plan }).lean()
    if (doc) {
      const limits = mapDocToLimits(doc)
      cache.set(plan, { limits, fetchedAt: Date.now() })
      return limits
    }
    // Plan has no row yet — admin hasn't configured it. Cache the default
    // briefly so we don't hammer Mongo with the same miss for 30s.
    cache.set(plan, { limits: DEFAULT_LIMITS, fetchedAt: Date.now() })
    return DEFAULT_LIMITS
  } catch (err) {
    console.warn(
      `[rate-limit] getUserLimits DB read failed for plan=${plan}, using DEFAULT_LIMITS:`,
      err
    )
    // Don't poison the cache with a failed read — let the next call retry.
    return DEFAULT_LIMITS
  }
}

export async function getUserLimits(userId: string): Promise<UserLimits> {
  let plan: UserPlan = 'free'
  try {
    plan = await getUserPlan(userId)
  } catch (err) {
    console.warn(
      `[rate-limit] getUserPlan failed for ${userId}, treating as 'free':`,
      err
    )
  }
  return loadLimitsForPlan(plan)
}
