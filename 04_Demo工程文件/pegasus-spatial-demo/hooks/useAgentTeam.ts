'use client'

import { useEffect, useState } from 'react'

export type AgentTeamMemberStatus = 'running' | 'idle' | 'paused' | 'completed' | 'failed'

export interface AgentTeamMemberView {
  agent_id: string
  alias: string
  role: string
  is_root: boolean
  status: AgentTeamMemberStatus
  last_transition_at: string
}

export interface AgentTeamSnapshotView {
  team: {
    team_id: string
    status: 'active' | 'completed'
    created_at: string
    updated_at: string
  }
  agents: AgentTeamMemberView[]
  counts: {
    total: number
    running: number
    standby: number
    completed: number
    failed: number
  }
  latest_root_run: {
    run_id: string
    status: 'queued' | 'running' | 'waiting_user' | 'waiting_agents' | 'recoverable' | 'completed' | 'cancelled' | 'failed'
  } | null
  latest_event_seq: number
}

interface UseAgentTeamResult {
  snapshot: AgentTeamSnapshotView | null
  isLoading: boolean
  isLive: boolean
  error: string | null
}

const SNAPSHOT_RETRY_MS = 5_000
const EVENT_REFRESH_DELAY_MS = 80
export const ROOT_AGENT_RUN_EVENT = 'pegasus-spatial:root-agent-run'

export interface RootAgentRunEventDetail {
  conversationId: string
  runId: string
}

export function useAgentTeam(conversationId: string | null | undefined): UseAgentTeamResult {
  const [stateConversationId, setStateConversationId] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<AgentTeamSnapshotView | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isLive, setIsLive] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!conversationId) {
      setStateConversationId(null)
      setSnapshot(null)
      setIsLoading(false)
      setIsLive(false)
      setError(null)
      return
    }

    let disposed = false
    let source: EventSource | null = null
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let latestEventSeq = 0
    let announcedRootRunId: string | null = null
    const controller = new AbortController()
    const encodedConversationId = encodeURIComponent(conversationId)
    const snapshotUrl = `/api/conversations/${encodedConversationId}/team`

    const scheduleRetry = () => {
      if (disposed || retryTimer) return
      retryTimer = setTimeout(() => {
        retryTimer = null
        void loadSnapshot(false).then(next => {
          if (next && !disposed) connectStream(next.latest_event_seq)
        })
      }, SNAPSHOT_RETRY_MS)
    }

    const loadSnapshot = async (initial: boolean): Promise<AgentTeamSnapshotView | null> => {
      try {
        const response = await fetch(snapshotUrl, {
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: string } | null
          throw new Error(body?.error || `Team snapshot failed with HTTP ${response.status}`)
        }
        const next = await response.json() as AgentTeamSnapshotView
        if (disposed) return null
        latestEventSeq = Math.max(latestEventSeq, next.latest_event_seq)
        setSnapshot(next)
        setError(null)
        // The snapshot is also the durable reconnect half of the Team stream.
        // If supervision started and completed before EventSource attached,
        // refreshing the Conversation still reveals its public Root output.
        if (next.latest_root_run?.run_id
          && next.latest_root_run.run_id !== announcedRootRunId) {
          announcedRootRunId = next.latest_root_run.run_id
          window.dispatchEvent(new CustomEvent<RootAgentRunEventDetail>(ROOT_AGENT_RUN_EVENT, {
            detail: { conversationId, runId: next.latest_root_run.run_id },
          }))
        }
        return next
      } catch (reason) {
        if (disposed || controller.signal.aborted) return null
        setError((reason as Error).message || 'Team 状态暂时不可用')
        scheduleRetry()
        return null
      } finally {
        if (initial && !disposed) setIsLoading(false)
      }
    }

    const scheduleSnapshotRefresh = () => {
      if (disposed || refreshTimer) return
      refreshTimer = setTimeout(() => {
        refreshTimer = null
        void loadSnapshot(false)
      }, EVENT_REFRESH_DELAY_MS)
    }

    const connectStream = (afterSeq: number) => {
      if (disposed || source) return
      const streamUrl = `${snapshotUrl}/stream?after_seq=${encodeURIComponent(String(afterSeq))}`
      source = new EventSource(streamUrl)
      source.onopen = () => {
        if (!disposed) setIsLive(true)
      }
      source.onerror = () => {
        if (!disposed) setIsLive(false)
        // Native EventSource reconnects and sends Last-Event-ID automatically.
      }
      source.addEventListener('team_event', rawEvent => {
        const event = rawEvent as MessageEvent<string>
        let payloadSeq = 0
        let rootRunId: string | null = null
        try {
          const payload = JSON.parse(event.data) as {
            seq?: unknown
            type?: unknown
            run_id?: unknown
          }
          payloadSeq = typeof payload.seq === 'number' ? payload.seq : 0
          if (payload.type === 'supervision_due' && typeof payload.run_id === 'string') {
            rootRunId = payload.run_id
          }
        } catch {
          // The event id remains sufficient for recovery even if payload parsing fails.
        }
        if (rootRunId) {
          announcedRootRunId = rootRunId
          window.dispatchEvent(new CustomEvent<RootAgentRunEventDetail>(ROOT_AGENT_RUN_EVENT, {
            detail: { conversationId, runId: rootRunId },
          }))
        }
        const eventSeq = Number(event.lastEventId) || payloadSeq
        if (Number.isSafeInteger(eventSeq) && eventSeq > latestEventSeq) {
          latestEventSeq = eventSeq
          scheduleSnapshotRefresh()
        }
      })
      source.addEventListener('team_stream_error', rawEvent => {
        const event = rawEvent as MessageEvent<string>
        try {
          const payload = JSON.parse(event.data) as { message?: unknown }
          if (!disposed && typeof payload.message === 'string') setError(payload.message)
        } catch {
          if (!disposed) setError('Team 实时状态流暂时中断')
        }
      })
    }

    setStateConversationId(conversationId)
    setSnapshot(null)
    setIsLoading(true)
    setIsLive(false)
    setError(null)
    void loadSnapshot(true).then(initialSnapshot => {
      if (initialSnapshot && !disposed) connectStream(initialSnapshot.latest_event_seq)
    })

    return () => {
      disposed = true
      controller.abort()
      source?.close()
      if (refreshTimer) clearTimeout(refreshTimer)
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [conversationId])

  if (!conversationId || stateConversationId !== conversationId) {
    return {
      snapshot: null,
      isLoading: Boolean(conversationId),
      isLive: false,
      error: null,
    }
  }
  return { snapshot, isLoading, isLive, error }
}
