const BASE_RETRY_MS = 1_000
const MAX_RETRY_MS = 30_000
const JITTER_RATIO = 0.2

/**
 * Backoff used by background MongoDB pollers while the database is unavailable.
 * A successful query must reset the caller's failure count to zero.
 */
export function databaseRetryDelayMs(
  failureCount: number,
  random = Math.random,
): number {
  const exponent = Math.max(0, Math.min(5, Math.floor(failureCount) - 1))
  const base = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * (2 ** exponent))
  const sample = Math.max(0, Math.min(1, random()))
  const jitter = 1 - JITTER_RATIO + sample * JITTER_RATIO * 2
  return Math.round(base * jitter)
}

export function shouldLogDatabaseFailure(
  failureCount: number,
  lastLoggedAt: number | null,
  now = Date.now(),
  repeatIntervalMs = 60_000,
): boolean {
  return failureCount === 1
    || lastLoggedAt === null
    || now - lastLoggedAt >= repeatIntervalMs
}
