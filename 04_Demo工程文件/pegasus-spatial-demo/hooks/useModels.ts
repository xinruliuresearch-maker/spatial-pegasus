'use client'

import { useState, useEffect } from 'react'

/**
 * `id` is the alias (e.g. "main_pro"), not the real upstream model ID. The
 * frontend treats these as opaque tokens — display name/description to the user,
 * round-trip the alias unchanged back to /api/chat.
 */
export interface ModelOption {
  id: string
  name: string
  description?: string
  alias?: string
  supportsVision: boolean
}

export function useModels() {
  const [models, setModels] = useState<ModelOption[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    fetch('/api/models')
      .then(res => res.json())
      .then((data: ModelOption[]) => {
        setModels(data)
        setIsLoading(false)
      })
      .catch(() => {
        setIsLoading(false)
      })
  }, [])

  return { models, isLoading }
}
