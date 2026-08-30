'use client'

import { useCallback, useEffect, useState } from 'react'

export interface MemoryEvidence {
  evidence_id: string
  role: 'user' | 'assistant' | 'tool' | 'workspace' | 'completion'
  excerpt: string
  created_at: string
}

export interface MemoryPreference {
  preference_id: string
  category: string
  subject: string
  statement: string
  scope: string
  polarity: 'positive' | 'negative' | 'neutral'
  status: 'active' | 'conflict'
  evidence_refs: MemoryEvidence[]
  updated_at: string
}

export interface MemoryProfile {
  version: number
  compiled_text: string
  token_count: number
  preferences: MemoryPreference[]
  updated_at: string
}

export interface MemoryCapacity {
  used_tokens: number
  limit_tokens: number
  remaining_tokens: number
  usage_ratio: number
  profile_tokens: number
  history_tokens: number
  history_events: number
  is_full: boolean
}

export interface HistoryArtifact {
  path?: string
  asset_id?: string
  url?: string
  mime_type?: string
  label?: string
}

export interface MemoryHistoryEvent {
  event_id: string
  title: string
  summary: string
  detail: string
  project: string
  decisions: string[]
  artifacts: HistoryArtifact[]
  tags: string[]
  event_at: string
  updated_at: string
}

export interface MemoryCandidate {
  candidate_id: string
  category: string
  subject: string
  statement: string
  scope: string
  status: 'pending' | 'claimed' | 'promoted' | 'ignored' | 'conflict' | 'quota_blocked' | 'legacy_review'
  evidence_refs: MemoryEvidence[]
  resolution_note: string
  updated_at: string
}

export interface MemoryRun {
  run_id: string
  conversation_id: string
  status: 'recording' | 'awaiting_user' | 'queued' | 'processing' | 'completed' | 'discarded' | 'failed'
  attempts: number
  error: string
  updated_at: string
}

export interface MemoryActivity {
  pendingCount: number
  conflicts: MemoryCandidate[]
  candidates: MemoryCandidate[]
  runs: MemoryRun[]
}

const request = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.error || `请求失败 (${response.status})`)
  }
  return response.json()
}

const EMPTY_ACTIVITY: MemoryActivity = { pendingCount: 0, conflicts: [], candidates: [], runs: [] }

export function useMemoryV2() {
  const [profile, setProfile] = useState<MemoryProfile | null>(null)
  const [capacity, setCapacity] = useState<MemoryCapacity | null>(null)
  const [history, setHistory] = useState<MemoryHistoryEvent[]>([])
  const [activity, setActivity] = useState<MemoryActivity>(EMPTY_ACTIVITY)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')

  const refresh = useCallback(async (query = '') => {
    setIsLoading(true)
    setError('')
    try {
      const suffix = query.trim() ? `?query=${encodeURIComponent(query.trim())}` : ''
      const [nextProfile, nextCapacity, nextHistory, nextActivity] = await Promise.all([
        request<MemoryProfile>('/api/memory/profile'),
        request<MemoryCapacity>('/api/memory/stats'),
        request<MemoryHistoryEvent[]>(`/api/memory/history${suffix}`),
        request<MemoryActivity>('/api/memory/activity'),
      ])
      setProfile(nextProfile)
      setCapacity(nextCapacity)
      setHistory(nextHistory)
      setActivity(nextActivity)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '记忆数据加载失败')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const refreshCapacity = async () => {
    setCapacity(await request<MemoryCapacity>('/api/memory/stats'))
  }

  const createPreference = async (input: Pick<MemoryPreference, 'category' | 'subject' | 'statement' | 'scope' | 'polarity'>) => {
    try {
      const next = await request<MemoryProfile>('/api/memory/preferences', { method: 'POST', body: JSON.stringify(input) })
      setProfile(next)
      await refreshCapacity()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '偏好保存失败')
      throw nextError
    }
  }

  const updatePreference = async (id: string, updates: Partial<MemoryPreference>) => {
    try {
      const next = await request<MemoryProfile>(`/api/memory/preferences/${id}`, { method: 'PATCH', body: JSON.stringify(updates) })
      setProfile(next)
      await refreshCapacity()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '偏好更新失败')
      throw nextError
    }
  }

  const deletePreference = async (id: string) => {
    const next = await request<MemoryProfile>(`/api/memory/preferences/${id}`, { method: 'DELETE' })
    setProfile(next)
    await refreshCapacity()
  }

  const updateHistory = async (id: string, updates: Partial<MemoryHistoryEvent>) => {
    const next = await request<MemoryHistoryEvent>(`/api/memory/history/${id}`, { method: 'PATCH', body: JSON.stringify(updates) })
    setHistory(items => items.map(item => item.event_id === id ? next : item))
    await refreshCapacity()
  }

  const deleteHistory = async (id: string) => {
    await request<{ success: boolean }>(`/api/memory/history/${id}`, { method: 'DELETE' })
    setHistory(items => items.filter(item => item.event_id !== id))
    await refreshCapacity()
  }

  const resolveConflict = async (id: string, resolution: 'accept' | 'ignore') => {
    await request(`/api/memory/conflicts/${id}/resolve`, { method: 'POST', body: JSON.stringify({ resolution }) })
    await refresh()
  }

  return {
    profile,
    capacity,
    history,
    activity,
    isLoading,
    error,
    refresh,
    createPreference,
    updatePreference,
    deletePreference,
    updateHistory,
    deleteHistory,
    resolveConflict,
  }
}
