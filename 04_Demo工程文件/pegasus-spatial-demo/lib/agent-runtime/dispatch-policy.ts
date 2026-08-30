const DISPATCH_RETRY_BASE_MS = 2_000
const DISPATCH_RETRY_MAX_MS = 60_000

export const MAX_DISPATCH_ATTEMPTS = 5

export function dispatchRetryDelayMs(attempt: number): number {
  const normalizedAttempt = Math.max(1, Math.floor(attempt))
  return Math.min(
    DISPATCH_RETRY_MAX_MS,
    DISPATCH_RETRY_BASE_MS * (2 ** (normalizedAttempt - 1)),
  )
}
