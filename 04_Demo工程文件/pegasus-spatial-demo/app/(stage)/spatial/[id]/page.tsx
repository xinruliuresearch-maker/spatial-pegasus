'use client'

import { useEffect, useRef } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { useChatContext } from '@/contexts/ChatContext'
import { useConversationTitle } from '@/hooks/useConversation'
import { SpatialStage } from '@/components/spatial-stage/SpatialStage'
import { isInternalWorkspacePath, normalizeWorkspacePath } from '@/lib/workspace/path-policy'

function safeManifestPath(value: string | null): string | null {
  if (!value) return null
  try {
    const normalized = normalizeWorkspacePath(value)
    return !isInternalWorkspacePath(normalized) && normalized.endsWith('/manifest.json') ? normalized : null
  } catch {
    return null
  }
}

function safeSceneId(value: string | null): string | null {
  if (!value) return null
  return /^[a-zA-Z0-9_-]{8,128}$/.test(value) ? value : null
}

export default function SpatialStagePage() {
  const { id } = useParams<{ id: string }>()
  const searchParams = useSearchParams()
  const { conversationId, artifacts, isLoadingConversation, loadConversation } = useChatContext()
  const { title } = useConversationTitle(id)
  const loadRef = useRef(loadConversation)

  useEffect(() => { loadRef.current = loadConversation })
  useEffect(() => {
    if (id && conversationId !== id) loadRef.current(id)
  }, [conversationId, id])

  return (
    <SpatialStage
      conversationId={id}
      projectTitle={title}
      artifacts={conversationId === id ? artifacts : []}
      isProjectLoading={conversationId !== id || isLoadingConversation}
      initialManifestPath={safeManifestPath(searchParams.get('manifest'))}
      sceneId={safeSceneId(searchParams.get('scene'))}
    />
  )
}
