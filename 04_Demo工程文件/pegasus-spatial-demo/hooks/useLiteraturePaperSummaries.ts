'use client'

import { useEffect, useState } from 'react'
import type { LiteraturePaperSummary } from '@/lib/literature/paper-summaries'

interface CachedSummaries {
  fingerprint: string
  papers: LiteraturePaperSummary[]
}

interface SummaryState extends CachedSummaries {
  conversationId: string
  error: string | null
}

const summaryCache = new Map<string, CachedSummaries>()
const SUMMARY_FETCH_DEBOUNCE_MS = 400

export function invalidateLiteraturePaperSummaryCache(conversationId?: string): void {
  if (conversationId) summaryCache.delete(conversationId)
  else summaryCache.clear()
}

/**
 * Fetch the paper directory projection once per Conversation + paper path set.
 * Source bytes stay server-side; switching projects aborts the obsolete request.
 */
export function useLiteraturePaperSummaries(
  conversationId: string | null,
  fingerprint: string,
  enabled = true,
): {
  papers: LiteraturePaperSummary[]
  isLoading: boolean
  error: string | null
} {
  const cached = conversationId ? summaryCache.get(conversationId) : undefined
  const cacheHit = cached?.fingerprint === fingerprint
  const [state, setState] = useState<SummaryState | null>(null)
  const stateHit = Boolean(
    state
    && state.conversationId === conversationId
    && state.fingerprint === fingerprint,
  )
  const shouldFetch = Boolean(enabled && conversationId && fingerprint && !cacheHit && !stateHit)

  useEffect(() => {
    if (!shouldFetch || !conversationId) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      fetch(`/api/conversations/${encodeURIComponent(conversationId)}/literature/papers`, {
        signal: controller.signal,
      })
        .then(async response => {
          if (!response.ok) {
            const body = await response.json().catch(() => ({})) as { error?: string }
            throw new Error(body.error ?? `HTTP ${response.status}`)
          }
          return response.json() as Promise<{ papers?: LiteraturePaperSummary[] }>
        })
        .then(body => {
          if (controller.signal.aborted) return
          const papers = Array.isArray(body.papers) ? body.papers : []
          const next = { fingerprint, papers }
          summaryCache.set(conversationId, next)
          setState({ conversationId, ...next, error: null })
        })
        .catch(error => {
          if (controller.signal.aborted || (error as Error).name === 'AbortError') return
          setState({
            conversationId,
            fingerprint,
            papers: [],
            error: (error as Error).message,
          })
        })
    }, SUMMARY_FETCH_DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [conversationId, fingerprint, shouldFetch])

  const papers = cacheHit
    ? cached.papers
    : stateHit
      ? state?.papers ?? []
      : []
  return {
    papers,
    isLoading: shouldFetch,
    error: stateHit ? state?.error ?? null : null,
  }
}
