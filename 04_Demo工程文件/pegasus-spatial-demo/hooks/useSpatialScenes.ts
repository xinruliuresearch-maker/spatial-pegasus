'use client'

import { useCallback, useEffect, useState } from 'react'
import type { SceneViewpoint } from '@/lib/spatial/scene-types'

export interface SpatialSceneSummary {
  scene_id: string
  title: string
  current_version: number
  current_revision_id: string
  agent_viewpoint: SceneViewpoint | null
  updated_at?: string
}

export function useSpatialScenes(conversationId: string | null, enabled = true) {
  const [scenes, setScenes] = useState<SpatialSceneSummary[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!conversationId || !enabled) return
    const response = await fetch(
      `/api/conversations/${encodeURIComponent(conversationId)}/spatial/scenes`,
      { signal, cache: 'no-store' },
    )
    const body = await response.json().catch(() => null) as { scenes?: SpatialSceneSummary[]; error?: string } | null
    if (!response.ok) throw new Error(body?.error ?? `Scene 列表读取失败 (${response.status})`)
    setScenes(body?.scenes ?? [])
    setError(null)
    setHasLoaded(true)
  }, [conversationId, enabled])

  useEffect(() => {
    setScenes([])
    setError(null)
    setHasLoaded(false)
    if (!conversationId || !enabled) {
      setIsLoading(false)
      return
    }

    const controller = new AbortController()
    setIsLoading(true)
    void refresh(controller.signal)
      .catch(cause => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : 'Scene 列表读取失败')
          setHasLoaded(true)
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false)
      })
    const timer = window.setInterval(() => void refresh(controller.signal).catch(() => undefined), 2500)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [conversationId, enabled, refresh])

  return { scenes, isLoading, hasLoaded, error, refresh }
}
