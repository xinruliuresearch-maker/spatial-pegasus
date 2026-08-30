'use client'

import { useState, useEffect, useCallback } from 'react'

interface ConversationSummary {
  conversation_id: string
  title: string
  updated_at: string
  pinned?: boolean
  is_running?: boolean
  _waiting_for_user?: boolean
}

export interface ConversationActionResult {
  ok: boolean
  error?: string
}

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown }
    if (typeof body.error === 'string' && body.error.trim()) return body.error
  } catch {
    // The status-specific fallback is clearer than a JSON parsing failure.
  }
  return fallback
}

async function waitForDeletionAfterStop(id: string): Promise<Response> {
  const deadline = Date.now() + 8_000
  let response: Response
  do {
    await new Promise(resolve => setTimeout(resolve, 200))
    response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (response.status !== 409) return response
  } while (Date.now() < deadline)
  return response
}

export function useConversations() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [isLoading, setIsLoading] = useState(false)

  const refresh = useCallback(async () => {
    setIsLoading(true)
    try {
      const res = await fetch('/api/conversations')
      if (res.ok) {
        const data = await res.json()
        setConversations(data)
      }
    } catch {
      // ignore
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Poll so sidebar picks up runs started / finished in other tabs.
  // is_running is a process-level flag that only refreshes via refetch.
  useEffect(() => {
    const interval = setInterval(refresh, 15_000)
    return () => clearInterval(interval)
  }, [refresh])

  const deleteConversation = useCallback(async (id: string): Promise<ConversationActionResult> => {
    try {
      let res = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' })

      // A recoverable, waiting, or currently executing Run owns an active_key
      // and deliberately blocks repository deletion. The user-facing Delete
      // action means stop that work first, then remove the conversation.
      if (res.status === 409) {
        let runId: string | undefined
        try {
          const conflict = await res.json() as { run_id?: unknown }
          if (typeof conflict.run_id === 'string') runId = conflict.run_id
        } catch {
          // The stop endpoint can resolve the current Run from conversation_id.
        }
        const stopRes = await fetch('/api/chat/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversation_id: id, ...(runId ? { run_id: runId } : {}) }),
        })
        if (!stopRes.ok) {
          return {
            ok: false,
            error: await responseError(stopRes, '无法停止当前任务，因此没有删除该对话。'),
          }
        }
        res = await waitForDeletionAfterStop(id)
      }

      if (res.ok) {
        setConversations(prev => prev.filter(c => c.conversation_id !== id))
        return { ok: true }
      }
      return {
        ok: false,
        error: await responseError(res, `删除失败（HTTP ${res.status}）。`),
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : '删除请求失败。',
      }
    }
  }, [])

  const renameConversation = useCallback(async (id: string, title: string) => {
    try {
      const res = await fetch(`/api/conversations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      })
      if (res.ok) {
        setConversations(prev =>
          prev.map(c => c.conversation_id === id ? { ...c, title } : c)
        )
      }
      return res.ok
    } catch {
      return false
    }
  }, [])

  const pinConversation = useCallback(async (id: string, pinned: boolean) => {
    try {
      const res = await fetch(`/api/conversations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned }),
      })
      if (res.ok) {
        setConversations(prev => {
          const updated = prev.map(c =>
            c.conversation_id === id ? { ...c, pinned } : c
          )
          // Re-sort: pinned first, then by updated_at desc (mirrors server sort)
          return [...updated].sort((a, b) => {
            if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
            return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
          })
        })
      }
      return res.ok
    } catch {
      return false
    }
  }, [])

  return { conversations, isLoading, refresh, deleteConversation, renameConversation, pinConversation }
}

/**
 * 单个 conversation 的标题读/改通道。
 * 约束：
 *   - 读走 GET /api/conversations/{id}（列表端点只取最近 50 条，旧会话会取不到名）；
 *   - 改走 PATCH {title}，与侧栏 renameConversation 同一端点（非空、≤200 服务端校验）；
 *   - 侧栏 useConversations 是独立实例，重命名后靠其 15s 轮询 / 切会话 refresh 收敛；
 *   - 读失败 / 未取到时 title 保持 null，调用方不得据兜底文案发起重命名。
 */
export function useConversationTitle(conversationId: string | null | undefined) {
  const [title, setTitle] = useState<string | null>(null)

  useEffect(() => {
    setTitle(null)
    if (!conversationId) return
    let cancelled = false
    fetch(`/api/conversations/${conversationId}`)
      .then(r => (r.ok ? r.json() : null))
      .then((data: { title?: unknown } | null) => {
        if (!cancelled && data && typeof data.title === 'string') setTitle(data.title)
      })
      .catch(() => { /* 保持 null */ })
    return () => { cancelled = true }
  }, [conversationId])

  const rename = useCallback(async (next: string) => {
    if (!conversationId) return false
    const trimmed = next.trim()
    if (!trimmed) return false
    try {
      const res = await fetch(`/api/conversations/${conversationId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed }),
      })
      if (res.ok) setTitle(trimmed)
      return res.ok
    } catch {
      return false
    }
  }, [conversationId])

  return { title, rename }
}
