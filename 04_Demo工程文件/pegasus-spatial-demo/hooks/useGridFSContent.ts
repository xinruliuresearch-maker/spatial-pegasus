'use client'

import { useEffect, useState } from 'react'

/**
 * Module-level cache shared across all workspace file viewers.
 * Key: `${conversationId}::${path}` → content string (base64 for images, utf-8 for text).
 *
 * Exported so artifact viewers can share pending file content.
 */
export const gridFSContentCache = new Map<string, string>()

/**
 * Drop cached GridFS content. Call after mutations that invalidate the cached value
 * (artifact PATCH, etc.) so the next view re-fetches the new content.
 *
 * - invalidateGridFSCache(id, path) → drop one entry
 * - invalidateGridFSCache(id)       → drop every entry for that conversation
 */
export function invalidateGridFSCache(conversationId: string, path?: string) {
  if (path) {
    gridFSContentCache.delete(`${conversationId}::${path}`)
    return
  }
  const prefix = `${conversationId}::`
  for (const key of Array.from(gridFSContentCache.keys())) {
    if (key.startsWith(prefix)) gridFSContentCache.delete(key)
  }
}

interface UseGridFSContentResult {
  content: string
  isLoading: boolean
  error: string | null
}

/**
 * Lazily fetches a GridFS-backed workspace file via /api/conversations/[id]/files.
 *
 * When `enabled` is false the hook is a no-op — used by artifacts that already have
 * inline content (non-pending) to avoid a useless fetch.
 *
 * `isLoading` and `content` are derived from inputs + the module-level cache during render
 * so there's no setState in the effect body — only the fetch callbacks call setState to
 * bump a version counter after writing into the cache, which triggers a re-render and
 * re-reads the cache.
 *
 * Requests are aborted on unmount / parameter change.
 */
export function useGridFSContent(
  conversationId: string | null,
  path: string,
  enabled: boolean,
): UseGridFSContentResult {
  const cacheKey = conversationId ? `${conversationId}::${path}` : null

  // Version counter exists solely to force a re-render after the fetch populates the
  // module-level cache. We never read this value — content is read from the cache below.
  const [, bumpVersion] = useState(0)
  // Error state is scoped to the cache key, so switching to a different conversation/path
  // automatically "resets" the error without needing a reset effect (which would be a
  // setState-in-effect anti-pattern).
  const [errorState, setErrorState] = useState<{ key: string; message: string } | null>(null)
  const error = errorState && errorState.key === cacheKey ? errorState.message : null

  const cached = cacheKey ? gridFSContentCache.get(cacheKey) : undefined
  const needsFetch = enabled && !!conversationId && !!cacheKey && cached === undefined && !error

  useEffect(() => {
    if (!needsFetch || !cacheKey || !conversationId) return

    const controller = new AbortController()

    fetch(
      `/api/conversations/${conversationId}/files?path=${encodeURIComponent(path)}`,
      { signal: controller.signal },
    )
      .then(async res => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error ?? `HTTP ${res.status}`)
        }
        return res.json() as Promise<{ content: string; isBase64: boolean }>
      })
      .then(data => {
        if (controller.signal.aborted) return
        gridFSContentCache.set(cacheKey, data.content)
        bumpVersion(v => v + 1)
      })
      .catch(err => {
        if (controller.signal.aborted || (err as Error).name === 'AbortError') return
        setErrorState({ key: cacheKey, message: (err as Error).message })
      })

    return () => controller.abort()
  }, [needsFetch, cacheKey, conversationId, path])

  return {
    content: cached ?? '',
    isLoading: needsFetch,
    error,
  }
}
