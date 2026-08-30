'use client'

import { useState, useCallback, useRef } from 'react'
import { ModelProvider, DisplayPart, ImageAttachment } from '@/lib/types'
import { ConversationArtifactFields, MUTATOR_TOOLS } from './useWorkspaceArtifacts'
import { invalidateGridFSCache } from './useGridFSContent'
import {
  applyCompactionPresentationToParts,
  contextUsageFromTokenEvent,
  isActiveCompactionStatus,
  isPublicCompactionStatus,
  isTerminalCompactionStatus,
  type ContextUsageState,
  type PublicCompactionStatus,
} from './chat-compaction-state'
import { attachPersistedToolResult } from '@/lib/chat/persisted-tool-results'

const ACTIVE_CONVERSATION_KEY = 'sci_pegasus_active_conversation_id'

function workspaceFileRevision(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const entry = value as Record<string, unknown>
  return [
    entry.gridfs_id,
    entry.asset_id,
    entry.sha256,
    entry.version,
    entry.updated_at,
  ].map(part => String(part ?? '')).join('\u0000')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function summarizeToolAction(tool: string, input: any, displayPath: string): string {
  switch (tool) {
    case 'Read': return `读取了 ${displayPath}`
    case 'Edit': return `修改了 ${displayPath}`
    case 'Write': return `写入了 ${displayPath}`
    case 'Glob': return `搜索了文件模式 ${input?.pattern ?? ''}`
    case 'Grep': return `搜索了内容 ${input?.pattern ?? ''}`
    case 'Skill': return `加载了 Skill: ${input?.name ?? ''}`
    case 'WebSearch': return `搜索了 "${input?.query ?? ''}"`
    case 'ArxivSearchPapers': return `在 arXiv 检索了论文「${input?.query ?? ''}」`
    case 'ArxivFetchPaper': return `获取并解析了 arXiv 论文 ${input?.arxiv_id ?? ''}`
    case 'SciverseSearchPapers': return `在 Sciverse 检索了论文「${input?.query ?? '结构化条件'}」`
    case 'SciverseSearchEvidence': return `在 Sciverse 检索了证据「${input?.query ?? ''}」`
    case 'SciverseFetchPaper': return `获取了 Sciverse 全文 ${input?.doc_id ?? ''}`
    case 'SciverseListRelations': return `查询了 Sciverse 论文关系 ${input?.unique_id ?? ''} (${input?.relation ?? ''})`
    case 'SearchDocument': return `在文献正文中定位了「${input?.query ?? ''}」`
    default: return `调用了 ${tool}`
  }
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** User-uploaded images (for display in the chat) */
  images?: ImageAttachment[]
  parts?: DisplayPart[]
  isStreaming?: boolean
  timestamp: Date
}

interface UseChatOptions {
  model: ModelProvider
  researchDomain?: string
  /** Fired once after loadConversation hydrates state from /api/conversations/:id.
   *  Lets ChatContext sync the model/domain inputs to the loaded conversation
   *  so reopening an old project doesn't show stale defaults. Cache-hit path skips
   *  this — switching back to an already-loaded conv shouldn't reassert settings
   *  the user may have edited locally since.
   */
  onConversationLoaded?: (settings: { orchestrator_model?: string; research_domain?: string; memory_enabled?: boolean }) => void
}

/** Per-conversation cached state — lives in a ref so background SSE streams can update it */
interface CachedState {
  messages: ChatMessage[]
  dbArtifactFields: ConversationArtifactFields | null
  /** Runtime-only values must remain scoped to their Conversation cache. */
  contextUsage?: ContextUsageState | null
  compactionStatus?: { jobId: string; status: PublicCompactionStatus } | null
  /** Snapshot of conversation.settings at last DB load, replayed to ChatContext
   *  on every switch (incl. cache hits) so the picker tracks the active conv. */
  settings?: { orchestrator_model?: string; research_domain?: string; memory_enabled?: boolean }
}

export function useChat(options: UseChatOptions) {
  // === React state (what's currently displayed) ===
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  // True from the moment loadConversation is invoked for a cache-miss target
  // until its messages/artifacts arrive. Lets the UI render skeletons during
  // the fetch window instead of flashing TaskWorkbench (hero) or empty
  // workspace. Cache-hit path skips this since the switch is synchronous.
  const [isLoadingConversation, setIsLoadingConversation] = useState(false)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [dbArtifactFields, setDbArtifactFields] = useState<ConversationArtifactFields | null>(null)
  const [runningConversationIds, setRunningConversationIds] = useState<Set<string>>(new Set())
  const [waitingForUserIds, setWaitingForUserIds] = useState<Set<string>>(new Set())
  const [contextUsage, setContextUsage] = useState<ContextUsageState | null>(null)
  // True once the active conversation has fired tool_start for a MUTATOR_TOOLS
  // entry (workspace writes, literature retrieval, or parse materialization).
  // ChatContext's `showWorkspace` reads this so a casual greeting that AI
  // answers without any tool call never makes the workspace flash open.
  // Reset on resetChat; recomputed from loaded conversation history on
  // loadConversation (handles re-opening prior conversations correctly).
  const [hasMutatorStarted, setHasMutatorStarted] = useState(false)

  // === Refs (persistent, no re-renders) ===
  // Per-conversation message cache — THE source of truth for message data
  const cacheRef = useRef(new Map<string, CachedState>())
  // Per-conversation abort controllers
  const abortsRef = useRef(new Map<string, AbortController>())
  // Monotonic hydration generation per conversation. A Team event may start a
  // fresher reconnect/load while an older DB request is still in flight; only
  // the newest request may replace the cache reconstructed from persistence.
  const hydrationEpochRef = useRef(new Map<string, number>())
  // Durable Run identity for stop/reconnect. Conversation IDs remain the UI
  // navigation key, while this map identifies the exact execution instance.
  const activeRunIdsRef = useRef(new Map<string, string>())
  // Pending AskUserQuestion form identity per conversation. This survives
  // reconnects via `active_run.pending_interaction` and makes a form submit
  // idempotent without turning the answer into a tool_result.
  const pendingInteractionIdsRef = useRef(new Map<string, string>())
  // Independent polling survives the source Run stream closing after a
  // background handoff. It is stopped at terminal state or project switch.
  const compactionPollsRef = useRef(new Map<string, AbortController>())
  // Which conversation key is currently displayed
  const activeKeyRef = useRef<string>('_new')
  // Latest onConversationLoaded callback (kept in a ref so loadConversation's
  // useCallback([]) doesn't need to depend on it — depending would re-create
  // loadConversation every parent render and re-trigger restore-on-mount).
  const onLoadedRef = useRef(options.onConversationLoaded)
  onLoadedRef.current = options.onConversationLoaded

  // Cache key: real conversation ID or '_new' for unsaved conversations
  const getKey = (id: string | null) => id ?? '_new'

  /** Sync a cache entry's messages to React state (only if it's the active conversation) */
  const syncToReact = (key: string) => {
    if (activeKeyRef.current !== key) return
    const cached = cacheRef.current.get(key)
    if (cached) setMessages([...cached.messages])
  }

  const setScopedContextUsage = (key: string, usage: ContextUsageState | null) => {
    const cached = cacheRef.current.get(key)
    if (cached) cached.contextUsage = usage
    if (activeKeyRef.current === key) setContextUsage(usage)
  }

  const stopCompactionPolling = (key: string) => {
    compactionPollsRef.current.get(key)?.abort()
    compactionPollsRef.current.delete(key)
  }

  const waitForCompactionPoll = (signal: AbortSignal): Promise<void> => (
    new Promise(resolve => {
      if (signal.aborted) return resolve()
      const timer = setTimeout(resolve, 2_000)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    })
  )

  async function startCompactionPolling(key: string): Promise<void> {
    if (key === '_new' || compactionPollsRef.current.has(key)) return
    const controller = new AbortController()
    compactionPollsRef.current.set(key, controller)
    try {
      while (!controller.signal.aborted) {
        await waitForCompactionPoll(controller.signal)
        if (controller.signal.aborted) break
        try {
          const response = await fetch(
            `/api/conversations/${encodeURIComponent(key)}/compaction`,
            { cache: 'no-store', signal: controller.signal },
          )
          if (!response.ok) continue
          const payload = await response.json() as {
            compaction?: Record<string, unknown> | null
          }
          if (!payload.compaction) break
          applySSEEvent(key, payload.compaction, { trackTokenUsage: true })
          const status = payload.compaction.status
          if (isPublicCompactionStatus(status) && isTerminalCompactionStatus(status)) break
        } catch (error) {
          if ((error as Error).name === 'AbortError') break
          // A transient status-read failure is not a compaction failure. Keep
          // polling at the bounded cadence until terminal state/switch.
        }
      }
    } finally {
      if (compactionPollsRef.current.get(key) === controller) {
        compactionPollsRef.current.delete(key)
      }
    }
  }

  async function hydrateCompactionStatus(key: string): Promise<void> {
    if (key === '_new') return
    try {
      const response = await fetch(
        `/api/conversations/${encodeURIComponent(key)}/compaction`,
        { cache: 'no-store' },
      )
      if (!response.ok) return
      const payload = await response.json() as {
        compaction?: Record<string, unknown> | null
      }
      if (payload.compaction) {
        applySSEEvent(key, payload.compaction, { trackTokenUsage: true })
      }
    } catch {
      // Conversation hydration remains usable when the status endpoint is
      // temporarily unavailable; a live Run event may restart polling later.
    }
  }

  const refreshWorkspaceArtifacts = useCallback(async (conversationKey: string): Promise<void> => {
    if (!conversationKey || conversationKey === '_new') return
    try {
      const response = await fetch(
        `/api/conversations/${encodeURIComponent(conversationKey)}`,
        { cache: 'no-store' },
      )
      if (!response.ok) return
      const payload = await response.json() as ConversationArtifactFields
      const cached = cacheRef.current.get(conversationKey)
      if (!cached) return
      const previousFiles = cached.dbArtifactFields?.output?.files ?? {}
      const nextFiles = payload.output?.files ?? {}
      for (const [path, nextEntry] of Object.entries(nextFiles)) {
        if (workspaceFileRevision(previousFiles[path]) !== workspaceFileRevision(nextEntry)) {
          invalidateGridFSCache(conversationKey, path)
        }
      }
      const nextFields: ConversationArtifactFields = {
        output: {
          files: payload.output?.files,
          manifest: payload.output?.manifest,
        },
      }
      cached.dbArtifactFields = nextFields
      if (activeKeyRef.current === conversationKey) setDbArtifactFields(nextFields)
    } catch {
      // The status card keeps polling durable state; a later refresh can recover.
    }
  }, [])

  /**
   * Apply one parsed SSE event to the cached conversation state.
   * Shared by the POST /api/chat streaming path (sendMessage) and the GET /api/chat/stream/:id
   * reconnect path (consumeReconnectStream) — both emit identical SSE events.
   */
  const applySSEEvent = (
    myKey: string,
    data: Record<string, unknown>,
    handlers: {
      onConversationIdMigration?: (realId: string) => void
      trackTokenUsage?: boolean
    },
  ) => {
    const evtType = data.type as string
    if (!evtType) return

    if (
      (
        evtType === 'run_started'
        || evtType === 'run_state'
        || evtType === 'run_detached'
        || evtType === 'run_recoverable'
      )
      && typeof data.run_id === 'string'
    ) {
      activeRunIdsRef.current.set(myKey, data.run_id)
    }

    // Conversation ID migration (only needed for the POST path with a brand-new conversation)
    if ((evtType === 'conversation_started' || evtType === 'done' || evtType === 'waiting_for_user' || evtType === 'waiting_for_agents') && data.conversation_id) {
      handlers.onConversationIdMigration?.(data.conversation_id as string)
    }

    if (evtType === 'waiting_for_user') {
      setWaitingForUserIds(prev => new Set([...prev, myKey]))
      try { localStorage.removeItem(ACTIVE_CONVERSATION_KEY) } catch { /* ignore */ }
    }

    if (evtType === 'done') {
      try { localStorage.removeItem(ACTIVE_CONVERSATION_KEY) } catch { /* ignore */ }
      activeRunIdsRef.current.delete(myKey)
    }

    if (evtType === 'interrupted' || (evtType === 'error' && data.run_id)) {
      activeRunIdsRef.current.delete(myKey)
    }

    // A lease handoff is not a user-visible failure. The caller reconnects to
    // the Mongo-backed Run stream using the preserved run_id.
    if (evtType === 'run_detached') return

    if (handlers.trackTokenUsage && evtType === 'token_usage') {
      setScopedContextUsage(myKey, contextUsageFromTokenEvent(data))
    }
    if (handlers.trackTokenUsage && evtType === 'compaction_done') {
      setScopedContextUsage(myKey, null)
    }

    if (evtType === 'files_update') {
      const cached = cacheRef.current.get(myKey)
      if (cached) {
        const prevFields = cached.dbArtifactFields ?? {}
        const prevOutput = (prevFields.output ?? {}) as Record<string, unknown>
        const prevFiles = (prevOutput.files ?? {}) as Record<string, unknown>
        const newFiles = (data.files ?? {}) as Record<string, unknown>
        for (const [path, newEntry] of Object.entries(newFiles)) {
          const prevEntry = prevFiles[path]
          if (workspaceFileRevision(prevEntry) !== workspaceFileRevision(newEntry)) {
            invalidateGridFSCache(myKey, path)
          }
        }
        const nextFields: ConversationArtifactFields = {
          ...prevFields,
          output: {
            ...prevOutput,
            files: data.files,
            manifest: data.manifest,
          } as ConversationArtifactFields['output'],
        }
        cached.dbArtifactFields = nextFields
        if (activeKeyRef.current === myKey) {
          setDbArtifactFields(nextFields)
        }
      }
      return
    }

    if (evtType === 'workspace_refresh') {
      void refreshWorkspaceArtifacts(myKey)
      return
    }

    if (evtType === 'compaction_status') {
      const status = data.status
      const jobId = typeof data.job_id === 'string' ? data.job_id : ''
      if (!jobId || !isPublicCompactionStatus(status)) return
      const cached = cacheRef.current.get(myKey)
      const duplicate = cached?.compactionStatus?.jobId === jobId
        && cached.compactionStatus.status === status
      if (cached) {
        cached.compactionStatus = { jobId, status }
        if (!duplicate) {
          const updated = [...cached.messages]
          for (let index = updated.length - 1; index >= 0; index -= 1) {
            const message = updated[index]
            if (message.role !== 'assistant') continue
            updated[index] = {
              ...message,
              parts: applyCompactionPresentationToParts(message.parts ?? [], status),
            }
            cached.messages = updated
            syncToReact(myKey)
            break
          }
        }
      }
      if (status === 'merged') setScopedContextUsage(myKey, null)
      if (isActiveCompactionStatus(status)) {
        void startCompactionPolling(myKey)
      } else {
        stopCompactionPolling(myKey)
      }
      return
    }

    // Message-content events: mutate the cached conversation's last assistant message
    const cachedEntry = cacheRef.current.get(myKey)
    if (!cachedEntry) return
    const prev = cachedEntry.messages
    const last = prev[prev.length - 1]
    if (!last || last.role !== 'assistant') return
    const updated = [...prev]
    let parts = [...(last.parts ?? [])]
    let content = last.content

    // Mongo-backed reconnect streams expose a bounded snapshot instead of
    // replaying every transient delta. Replace the current streaming text
    // atomically so reconnects never duplicate already-rendered characters.
    if (evtType === 'live_snapshot') {
      const text = typeof data.text === 'string' ? data.text : ''
      let replaced = false
      for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i].type === 'text') {
          parts[i] = { type: 'text', text }
          replaced = true
          break
        }
      }
      if (!replaced && text) parts.push({ type: 'text', text })
      updated[updated.length - 1] = { ...last, content: text, parts }
      cachedEntry.messages = updated
      syncToReact(myKey)
      return
    }

    switch (evtType) {
      case 'text_delta': {
        const text = data.text as string
        content += text
        const lastPart = parts[parts.length - 1]
        if (lastPart && lastPart.type === 'text') {
          parts[parts.length - 1] = { ...lastPart, text: lastPart.text + text }
        } else {
          parts.push({ type: 'text', text })
        }
        break
      }
      case 'tool_start': {
        const toolName = data.tool as string
        parts.push({ type: 'tool_call', tool: toolName, pending: true })
        // Flip the workspace gate the moment a mutator tool starts — workspace
        // appears with its "Agent 正在工作中..." loading state before the
        // tool_done event lands (so user sees the transition crisply, not a
        // sudden snap from chat-only → workspace+artifact).
        if (activeKeyRef.current === myKey && MUTATOR_TOOLS.has(toolName)) {
          setHasMutatorStarted(true)
        }
        break
      }
      case 'tool_target': {
        // Server emits this right before tool execution to tag the target
        // file path on the latest pending tool_call. The workspace panel
        // uses this to flag the matching tab as "being edited by AI".
        const tool = data.tool as string
        const targetPath = data.target_path as string | undefined
        if (!targetPath) break
        let matched = false
        for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i]
          if (p.type === 'tool_call' && p.pending && p.tool === tool && !p.target_path) {
            parts[i] = { ...p, target_path: targetPath }
            matched = true
            break
          }
        }
        if (!matched) {
          // Defensive: tool_target arrived without a matching pending tool_call.
          // Shouldn't happen because tool_start is always emitted first by the
          // streaming path, but log if a future change introduces a silent path
          // (e.g. callLLMSilent dropping onToolUseStart) so we don't silently
          // miss in-flight loading state.
          console.warn(`[useChat] tool_target for "${tool}" target=${targetPath} found no matching pending tool_call`)
        }
        break
      }
      case 'tool_done': {
        for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i]
          if (p.type === 'tool_call' && p.pending && p.tool === data.tool) {
            parts[i] = {
              ...p,
              pending: false,
              file_path: data.file_path as string | undefined,
              action: data.action as string | undefined,
              is_error: data.is_error as boolean | undefined,
              content: data.content as string | undefined,
            }
            break
          }
        }
        break
      }
      case 'thinking_delta': {
        const text = data.text as string
        const lastPart = parts[parts.length - 1]
        if (lastPart && lastPart.type === 'thinking') {
          parts[parts.length - 1] = { ...lastPart, text: lastPart.text + text, pending: true }
        } else {
          parts.push({ type: 'thinking', text, pending: true })
        }
        break
      }
      case 'redacted_thinking': {
        parts.push({ type: 'redacted_thinking', pending: false })
        break
      }
      case 'ask_user': {
        const interactionId = typeof data.interaction_id === 'string'
          ? data.interaction_id
          : undefined
        if (interactionId) pendingInteractionIdsRef.current.set(myKey, interactionId)
        parts.push({
          type: 'ask_user',
          interaction_id: interactionId,
          questions: Array.isArray(data.questions)
            ? data.questions as Extract<DisplayPart, { type: 'ask_user' }>['questions']
            : undefined,
          question: data.question as string | undefined,
          options: data.options as string[] | undefined,
          answered: false,
        })
        break
      }
      case 'done':
      case 'waiting_for_user':
      case 'waiting_for_agents': {
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i]
          if (p.type === 'thinking' && p.pending) {
            parts[i] = { ...p, pending: false }
          }
        }
        break
      }
      case 'compaction_start': {
        parts = applyCompactionPresentationToParts(parts, 'summarizing')
        break
      }
      case 'compaction_done': {
        for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i]
          if (p.type === 'tool_call' && p.tool === 'Compaction' && p.pending) {
            // Legacy/local compaction has no durable Job state. Reserve the
            // exact “上下文压缩完成” claim for persisted status=merged.
            parts[i] = { ...p, pending: false, action: '上下文整理已应用' }
            break
          }
        }
        break
      }
      case 'error': {
        content += `\n\n**错误**: ${data.message}`
        break
      }
      case 'run_recoverable': {
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i]
          if (p.type === 'thinking' && p.pending) {
            parts[i] = { ...p, pending: false }
          }
          if (p.type === 'tool_call' && p.pending) {
            parts[i] = {
              ...p,
              pending: false,
              is_error: true,
              action: p.action || '执行在完整检查点处中断',
            }
          }
        }
        content += '\n\n执行已在完整检查点处暂停；下一条消息会继续当前 Run。'
        break
      }
      default:
        return
    }

    updated[updated.length - 1] = { ...last, content, parts }
    cachedEntry.messages = updated
    syncToReact(myKey)
  }

  /** Parse an SSE line buffer and dispatch each full event. Returns the remaining partial line. */
  const readSSE = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    onEvent: (data: Record<string, unknown>) => void,
  ) => {
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        try {
          onEvent(JSON.parse(line.slice(6)))
        } catch { /* ignore malformed event */ }
      }
    }
  }

  // ==================== sendMessage ====================

  const sendMessage = useCallback(
    async (
      text: string,
      images?: ImageAttachment[],
      interactionId?: string,
      researchDomainOverride?: string,
    ) => {
      if (!text.trim()) return

      const responseInteractionId = interactionId
        ?? pendingInteractionIdsRef.current.get(getKey(conversationId))
      const effectiveResearchDomain = researchDomainOverride ?? options.researchDomain

      // Mid-turn input: enqueue message instead of starting new request
      if (isLoading && conversationId) {
        try {
          // Optimistic UI: show user message immediately
          const key = activeKeyRef.current
          const cached = cacheRef.current.get(key)
          if (cached) {
            cached.messages = [...cached.messages, {
              id: `mid-${Date.now()}`,
              role: 'user' as const,
              content: text,
              parts: [{ type: 'text' as const, text }],
              timestamp: new Date(),
            }]
            syncToReact(key)
          }
          await fetch('/api/chat/interrupt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversation_id: conversationId, message: text, images }),
          })
        } catch (err) {
          console.error('[useChat] Failed to send mid-turn message:', err)
        }
        return
      }

      // Mutable key — migrates from '_new' to real ID when server responds
      let myKey = getKey(conversationId)

      // Clear waiting-for-user state (user is responding)
      setWaitingForUserIds(prev => {
        if (!prev.has(myKey)) return prev
        const next = new Set(prev)
        next.delete(myKey)
        return next
      })

      // Initialize cache entry if missing
      if (!cacheRef.current.has(myKey)) {
        cacheRef.current.set(myKey, {
          messages: [],
          dbArtifactFields: null,
          contextUsage: null,
          compactionStatus: null,
        })
      }

      // Helper: update messages in cache (source of truth), then sync to React if active
      const updateMsgs = (updater: (prev: ChatMessage[]) => ChatMessage[]) => {
        const cached = cacheRef.current.get(myKey)
        if (!cached) return
        cached.messages = updater(cached.messages)
        syncToReact(myKey)
      }

      const userMsg: ChatMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: text,
        images: images?.length ? images : undefined,
        timestamp: new Date(),
      }

      const assistantMsg: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: '',
        parts: [],
        isStreaming: true,
        timestamp: new Date(),
      }

      // Write initial messages directly to cache, then sync
      // IMPORTANT: Preserve dbArtifactFields from the previous turn — don't clear them.
      // They'll be overwritten when the new agent loop completes and refetches from DB.
      // This prevents the workspace panel from resetting to empty during streaming.
      const cached = cacheRef.current.get(myKey)!
      cached.messages = [...cached.messages, userMsg, assistantMsg]
      // Stamp the settings we're about to POST into the cache so the cache-hit
      // path on a later switch-back re-emits the user's actual choices. Without
      // this, brand-new conversations have no cache.settings (initialized as
      // `{ messages: [], dbArtifactFields: null }` above), the cache-hit re-emit
      // is skipped, and React state inherits whatever the other conversation's
      // load just set — most visibly: memory toggle flipping back to ON.
      cached.settings = {
        orchestrator_model: options.model,
        ...(effectiveResearchDomain ? { research_domain: effectiveResearchDomain } : {}),
        memory_enabled: false,
      }
      syncToReact(myKey)

      if (activeKeyRef.current === myKey) {
        setIsLoading(true)
      }

      const abortController = new AbortController()
      abortsRef.current.set(myKey, abortController)
      setRunningConversationIds(prev => new Set([...prev, myKey]))
      let detachedRunId: string | null = null

      // Mark active conversation for cross-refresh restore (existing conversations too, not just new)
      if (myKey !== '_new') {
        try { localStorage.setItem(ACTIVE_CONVERSATION_KEY, myKey) } catch { /* ignore */ }
      }

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            // A new project has no durable Conversation identity yet. Omit the
            // field entirely so the API can distinguish "create" from an
            // explicitly supplied (and therefore validated) identifier.
            ...(conversationId ? { conversation_id: conversationId } : {}),
            message: text,
            images: images?.length ? images : undefined,
            interaction_id: responseInteractionId,
            settings: {
              orchestrator_model: options.model,
              ...(effectiveResearchDomain ? { research_domain: effectiveResearchDomain } : {}),
              memory_enabled: false,
            },
          }),
          signal: abortController.signal,
        })

        if (!res.ok) {
          // Rate limit: server returns JSON { error, code, retry_after_ms }; surface the
          // localized `error` message verbatim so the user sees a friendly prompt.
          if (res.status === 429) {
            try {
              const payload = await res.json()
              throw new Error(payload?.error || '请求过于频繁，请稍后再试')
            } catch (parseErr) {
              if (parseErr instanceof Error && parseErr.message) throw parseErr
              throw new Error('请求过于频繁，请稍后再试')
            }
          }
          if (res.status === 401) {
            throw new Error('本地工作台请求失败，请刷新后重试')
          }
          const errorText = await res.text()
          throw new Error(`HTTP ${res.status}: ${errorText}`)
        }
        if (!res.body) throw new Error('No response body')

        const reader = res.body.getReader()
        await readSSE(reader, (data) => {
          if (data.type === 'run_detached' && typeof data.run_id === 'string') {
            detachedRunId = data.run_id
          }
          applySSEEvent(myKey, data, {
            trackTokenUsage: true,
            onConversationIdMigration(realId) {
              if (myKey === '_new' && realId) {
                const cachedEntry = cacheRef.current.get('_new')
                if (cachedEntry) {
                  cacheRef.current.set(realId, cachedEntry)
                  cacheRef.current.delete('_new')
                }
                const ac = abortsRef.current.get('_new')
                if (ac) {
                  abortsRef.current.set(realId, ac)
                  abortsRef.current.delete('_new')
                }
                const pendingRunId = activeRunIdsRef.current.get('_new')
                if (pendingRunId) {
                  activeRunIdsRef.current.set(realId, pendingRunId)
                  activeRunIdsRef.current.delete('_new')
                }
                const pendingInteractionId = pendingInteractionIdsRef.current.get('_new')
                if (pendingInteractionId) {
                  pendingInteractionIdsRef.current.set(realId, pendingInteractionId)
                  pendingInteractionIdsRef.current.delete('_new')
                }
                setRunningConversationIds(prev => {
                  const next = new Set(prev)
                  next.delete('_new')
                  next.add(realId)
                  return next
                })
                if (activeKeyRef.current === '_new') {
                  activeKeyRef.current = realId
                }
                myKey = realId
                // Persist the active conversation so refresh can restore it
                try { localStorage.setItem(ACTIVE_CONVERSATION_KEY, realId) } catch { /* ignore */ }
              }
              if (activeKeyRef.current === myKey) {
                setConversationId(realId)
              }
            },
          })
        })
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          // User clicked stop — mark all pending tool calls as interrupted + add truncation marker
          updateMsgs(prev => {
            const updated = [...prev]
            const last = updated[updated.length - 1]
            if (!last || last.role !== 'assistant') return prev
            const parts = [...(last.parts || [])]
            for (let i = 0; i < parts.length; i++) {
              const p = parts[i]
              if (p.type === 'tool_call' && p.pending) {
                parts[i] = { ...p, pending: false, action: (p.action || '') + ' (用户终止)', is_error: true }
              }
              if (p.type === 'thinking' && p.pending) {
                parts[i] = { ...p, pending: false }
              }
            }
            parts.push({ type: 'interrupted' })
            updated[updated.length - 1] = { ...last, parts }
            return updated
          })
        } else {
          updateMsgs(prev => {
            const updated = [...prev]
            const last = updated[updated.length - 1]
            if (!last || last.role !== 'assistant') return prev
            updated[updated.length - 1] = {
              ...last,
              content: last.content + `\n\n**错误**: ${(err as Error).message}`,
            }
            return updated
          })
        }
      } finally {
        // Mark stream as finished
        updateMsgs(prev => {
          const updated = [...prev]
          const last = updated[updated.length - 1]
          if (!last || last.role !== 'assistant') return prev
          updated[updated.length - 1] = { ...last, isStreaming: false }
          return updated
        })
        abortsRef.current.delete(myKey)
        setRunningConversationIds(prev => {
          const next = new Set(prev)
          next.delete(myKey)
          return next
        })
        if (activeKeyRef.current === myKey) {
          setIsLoading(false)
        }

        // Reattach to the durable Runner immediately. Artifact hydration is a
        // secondary request and must not delay the rich Root event stream long
        // enough for a completed turn buffer to be folded into Mongo.
        if (detachedRunId && myKey !== '_new') {
          void consumeReconnectStream(myKey, detachedRunId)
        }

        // Refetch conversation from DB to get complete artifact fields
        // (binary artifacts are not available during streaming).
        //
        // Defensive double-invalidation: in normal flow, the mid-loop
        // `files_update` SSE handler (above) already calls
        // invalidateGridFSCache for any in-place overwrite. This block is a
        // belt-and-suspenders catch for cases where SSE delivery was
        // interrupted (network hiccup, abort, browser tab backgrounded with
        // throttled timers etc.) — without it, the document viewer
        // would keep showing pre-edit content until the user manually
        // reloads the page. Idempotent in the common case where SSE
        // already invalidated the entries we re-check.
        if (myKey !== '_new') {
          try {
            const res = await fetch(`/api/conversations/${myKey}`)
            if (res.ok) {
              const data = await res.json()
              const newFiles = (data.output?.files ?? {}) as Record<string, unknown>
              const cached = cacheRef.current.get(myKey)
              const prevFields = cached?.dbArtifactFields ?? {}
              const prevOutput = (prevFields.output ?? {}) as Record<string, unknown>
              const prevFiles = (prevOutput.files ?? {}) as Record<string, unknown>
              for (const [path, newEntry] of Object.entries(newFiles)) {
                const prevEntry = prevFiles[path]
                if (workspaceFileRevision(prevEntry) !== workspaceFileRevision(newEntry)) {
                  invalidateGridFSCache(myKey, path)
                }
              }

              const fields: ConversationArtifactFields = {
                output: {
                  files: data.output?.files,
                  manifest: data.output?.manifest,
                },
              }
              if (cached) {
                cached.dbArtifactFields = fields
              }
              if (activeKeyRef.current === myKey) {
                setDbArtifactFields(fields)
              }
            }
          } catch {
            // Non-critical — artifacts will still show from streaming data
          }
        }
      }
    },
    // The shared SSE/reconnect handlers intentionally read mutable refs and
    // React setters only. Depending on their per-render function identities
    // would recreate sendMessage and can start duplicate reconnect attempts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversationId, isLoading, options.model, options.researchDomain]
  )

  // ==================== stopGeneration ====================

  const stopGeneration = useCallback(() => {
    const key = activeKeyRef.current
    // Abort the local fetch (POST /api/chat or GET /api/chat/stream/:id reconnect) so UI reacts immediately
    abortsRef.current.get(key)?.abort()
    stopCompactionPolling(key)
    // The server loop is decoupled from the fetch — send an explicit stop so it actually terminates
    if (key && key !== '_new') {
      fetch('/api/chat/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: key,
          run_id: activeRunIdsRef.current.get(key),
        }),
      }).catch(() => { /* ignore */ })
    }
  }, [])

  // ==================== answerQuestion ====================

  const answerQuestion = useCallback(
    (answer: string, interactionId?: string) => {
      // Mark the ask_user part as answered — cache-first
      const key = activeKeyRef.current
      const cached = cacheRef.current.get(key)
      if (cached) {
        const updated = [...cached.messages]
        for (let i = updated.length - 1; i >= 0; i--) {
          if (updated[i].role === 'assistant' && updated[i].parts) {
            const parts = [...updated[i].parts!]
            for (let j = parts.length - 1; j >= 0; j--) {
              const p = parts[j]
              if (p.type === 'ask_user' && !p.answered) {
                parts[j] = { ...p, answered: true }
                break
              }
            }
            updated[i] = { ...updated[i], parts }
            break
          }
        }
        cached.messages = updated
        syncToReact(key)
      }
      const activeInteractionId = interactionId ?? pendingInteractionIdsRef.current.get(key)
      if (activeInteractionId) pendingInteractionIdsRef.current.delete(key)
      sendMessage(answer, undefined, activeInteractionId)
    },
    [sendMessage]
  )

  // ==================== consumeReconnectStream ====================
  // Attach to an active server-side loop via GET /api/chat/stream/:id and pipe events through
  // the shared applySSEEvent handler. Used when loadConversation sees is_running=true.

  async function consumeReconnectStream(convId: string, runId?: string) {
    // If we're already subscribed locally, don't double-subscribe
    if (abortsRef.current.has(convId)) return

    const abortController = new AbortController()
    abortsRef.current.set(convId, abortController)
    setRunningConversationIds(prev => new Set([...prev, convId]))
    if (activeKeyRef.current === convId) setIsLoading(true)

    // Add a streaming placeholder assistant message so incoming deltas have a target to mutate
    const reconnectPlaceholderId = `assistant-reconnect-${Date.now()}`
    const cached = cacheRef.current.get(convId)
    if (cached) {
      cached.messages = [...cached.messages, {
        id: reconnectPlaceholderId,
        role: 'assistant',
        content: '',
        parts: [],
        isStreaming: true,
        timestamp: new Date(),
      }]
      syncToReact(convId)
    }

    try {
      if (runId) activeRunIdsRef.current.set(convId, runId)
      const streamUrl = runId
        ? `/api/chat/runs/${encodeURIComponent(runId)}/stream`
        : `/api/chat/stream/${convId}`
      const res = await fetch(streamUrl, { signal: abortController.signal })
      if (res.status === 204) {
        // Loop already ended between the /api/conversations fetch and the reconnect attempt — drop placeholder
        const c = cacheRef.current.get(convId)
        if (c && c.messages.length > 0) {
          const last = c.messages[c.messages.length - 1]
          if (last.role === 'assistant' && last.parts?.length === 0 && !last.content) {
            c.messages = c.messages.slice(0, -1)
            syncToReact(convId)
          }
        }
        return
      }
      if (!res.ok || !res.body) return

      const reader = res.body.getReader()
      await readSSE(reader, (data) => {
        applySSEEvent(convId, data, { trackTokenUsage: true })
      })
    } catch {
      // Stream ended / aborted — UI already updated by events or finally block
    } finally {
      const c = cacheRef.current.get(convId)
      if (c) {
        const last = c.messages[c.messages.length - 1]
        if (last?.id === reconnectPlaceholderId && last.isStreaming) {
          // If the Run completed between the conversation snapshot and this
          // subscription, no delta is produced. Never leave a blank assistant
          // bubble behind merely because a reconnect raced with completion.
          const hasVisibleContent = Boolean(last.content)
            || Boolean(last.parts && last.parts.length > 0)
          c.messages = hasVisibleContent
            ? [...c.messages.slice(0, -1), { ...last, isStreaming: false }]
            : c.messages.slice(0, -1)
          syncToReact(convId)
        }
      }
      abortsRef.current.delete(convId)
      setRunningConversationIds(prev => {
        const next = new Set(prev)
        next.delete(convId)
        return next
      })
      if (activeKeyRef.current === convId) setIsLoading(false)
    }
  }

  // ==================== loadConversation ====================

  const loadConversation = useCallback(async (id: string) => {
    const targetKey = id
    const hydrationEpoch = (hydrationEpochRef.current.get(targetKey) ?? 0) + 1
    hydrationEpochRef.current.set(targetKey, hydrationEpoch)

    // A background status poll belongs to the visible project. Stop the prior
    // one before switching; its cached final state remains conversation-local.
    const previousKey = activeKeyRef.current
    if (previousKey !== targetKey) stopCompactionPolling(previousKey)

    // Switch active key (cache already has current conversation's latest state — no need to save from closure)
    activeKeyRef.current = targetKey

    // Check if target has a cached state (e.g., a background-running conversation)
    const cached = cacheRef.current.get(targetKey)
    const hasCachedState = Boolean(cached && (
      cached.messages.length > 0
      || cached.dbArtifactFields !== null
    ))
    if (cached && hasCachedState) {
      setMessages([...cached.messages])
      setDbArtifactFields(cached.dbArtifactFields)
      setContextUsage(cached.contextUsage ?? null)
      setConversationId(id)
      setIsLoading(abortsRef.current.has(targetKey))
      // Cache hit is a synchronous switch — no fetch window, no skeleton.
      setIsLoadingConversation(false)
      // Recompute workspace gate from cached parts so switching back to a
      // conversation that had fired mutator tools restores the workspace
      // visibility immediately (same logic as the cache-miss branch below).
      const hadMutator = cached.messages.some(m =>
        m.parts?.some(p => p.type === 'tool_call' && MUTATOR_TOOLS.has(p.tool)),
      )
      setHasMutatorStarted(hadMutator)
      // Re-emit the cached settings so ChatContext rehydrates the picker on
      // every switch, even when no DB fetch happens.
      if (cached.settings) onLoadedRef.current?.(cached.settings)
      if (cached.compactionStatus && isActiveCompactionStatus(cached.compactionStatus.status)) {
        void startCompactionPolling(targetKey)
      }
      // A live subscriber already owns the freshest deltas. Otherwise fall
      // through to a full DB hydration: Root supervision can finish before a
      // reconnect stream is attached, and the former "is_running probe" left
      // that completed public reply invisible in this cache indefinitely.
      if (abortsRef.current.has(targetKey)) return
    }

    if (!hasCachedState) {
      // No cache — fetch from DB. Flip loading flag BEFORE clearing messages so
      // the page renders skeleton instead of TaskWorkbench (hero) during the
      // fetch window (page.tsx checks isLoadingConversation before falling
      // through to the messages.length === 0 hero branch).
      setIsLoadingConversation(true)
      setMessages([])
      setIsLoading(false)
      setDbArtifactFields(null)
      setContextUsage(null)
      setConversationId(id)
    }

    try {
      const res = await fetch(`/api/conversations/${id}`)
      if (!res.ok) {
        // 404 / 4xx / 5xx — clear the loading flag so the UI can recover
        // instead of staying stuck on the workspace skeleton forever.
        // Same active-key guard as the catch path: only clear if we're still
        // the active load (a faster subsequent loadConversation may have
        // taken over and set its own loading window).
        if (activeKeyRef.current === targetKey) setIsLoadingConversation(false)
        return
      }
      const data = await res.json()

      // A later load has already taken ownership of this conversation, or a
      // live reconnect began while this cache-hit refresh was in flight. Do
      // not let an older DB snapshot overwrite newer streamed deltas.
      if (hydrationEpochRef.current.get(targetKey) !== hydrationEpoch) return
      if (hasCachedState && abortsRef.current.has(targetKey)) return

      // Reconstruct chat messages from DB conversation messages
      const chatMessages: ChatMessage[] = []
      const dbMessages = data.messages ?? []

      let i = 0
      while (i < dbMessages.length) {
        const msg = dbMessages[i]

        if (msg.role === 'user') {
          const hasToolResult = msg.content?.some((c: { type: string }) => c.type === 'tool_result')
          if (!hasToolResult) {
            const textContent = msg.content
              ?.filter((c: { type: string }) => c.type === 'text')
              .map((c: { text: string }) => c.text)
              .join('')
            // Extract image blocks for display
            const imageBlocks = msg.content
              ?.filter((c: { type: string }) => c.type === 'image')
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .map((c: any): ImageAttachment | null => {
                if (c.source?.type === 'asset' && typeof c.source.asset_id === 'string') {
                  return {
                    assetId: c.source.asset_id,
                    mimeType: c.source.media_type || 'image/jpeg',
                    storageDriver: c.source.storage_driver,
                    width: c.source.width,
                    height: c.source.height,
                  }
                }
                if (c.source?.type === 'url' && typeof c.source.url === 'string') {
                  return { url: c.source.url, mimeType: c.source.media_type || 'image/jpeg' }
                }
                if (c.source?.type === 'base64' && typeof c.source.data === 'string') {
                  return {
                    url: `data:${c.source.media_type || 'image/jpeg'};base64,${c.source.data}`,
                    mimeType: c.source.media_type || 'image/jpeg',
                  }
                }
                return null
              })
              .filter((image: ImageAttachment | null): image is ImageAttachment => image !== null)
            if (textContent || imageBlocks?.length) {
              chatMessages.push({
                id: `user-${chatMessages.length}`,
                role: 'user',
                content: textContent || '',
                images: imageBlocks?.length ? imageBlocks : undefined,
                timestamp: msg.timestamp ? new Date(msg.timestamp) : new Date(),
              })
            }
            i++
            continue
          }
          i++
          continue
        }

        const parts: DisplayPart[] = []
        let fullText = ''
        const startTimestamp = msg.timestamp

        let msgInterrupted = false

        while (i < dbMessages.length) {
          const cur = dbMessages[i]

          if (cur.role === 'assistant') {
            if (cur._interrupted) msgInterrupted = true
            for (const block of cur.content ?? []) {
              if (block.type === 'text') {
                if (!block.text) continue // skip empty text blocks (partial stream artifacts)
                parts.push({ type: 'text', text: block.text })
                fullText += block.text
              } else if (block.type === 'thinking') {
                parts.push({ type: 'thinking', text: block.thinking, pending: false })
              } else if (block.type === 'redacted_thinking') {
                parts.push({ type: 'redacted_thinking', pending: false })
              } else if (block.type === 'tool_use') {
                const displayPath = (block.input?.file_path as string)?.replace(/^\/workspace\//, '') || ''
                parts.push({
                  type: 'tool_call',
                  tool: block.name,
                  tool_use_id: block.id,
                  file_path: block.input?.file_path as string | undefined,
                  action: summarizeToolAction(block.name, block.input, displayPath),
                  pending: false,
                })
              }
            }
            i++

            if (i < dbMessages.length && dbMessages[i].role === 'user') {
              const nextContent = dbMessages[i].content ?? []
              const isToolResult = nextContent.some((c: { type: string }) => c.type === 'tool_result')
              if (isToolResult) {
                let hasInterrupted = false
                for (const block of nextContent) {
                  if (block.type !== 'tool_result') continue
                  attachPersistedToolResult(parts, block)
                  if (block.is_error) {
                    const isInterrupt = block.content === 'Tool execution interrupted by user.'
                    if (isInterrupt) hasInterrupted = true
                    for (let j = parts.length - 1; j >= 0; j--) {
                      const p = parts[j]
                      if (p.type === 'tool_call' && p.tool_use_id === block.tool_use_id) {
                        parts[j] = {
                          ...p,
                          is_error: true,
                          action: isInterrupt ? (p.action || '') + ' (用户终止)' : p.action,
                        }
                        break
                      }
                    }
                  }
                }
                if (hasInterrupted) {
                  parts.push({ type: 'interrupted' })
                }
                i++
                continue
              }
            }
            break
          } else {
            break
          }
        }

        // If _interrupted flag is set but no tool_result-based marker was added, add it now
        if (msgInterrupted && !parts.some(p => p.type === 'interrupted')) {
          parts.push({ type: 'interrupted' })
        }

        chatMessages.push({
          id: `assistant-${chatMessages.length}`,
          role: 'assistant',
          content: fullText,
          parts,
          timestamp: startTimestamp ? new Date(startTimestamp) : new Date(),
        })
      }

      // Conversation-level interrupted fallback — covers checkpoint 1 aborts where
      // _interrupted on messages wasn't persisted (no new messages were saved).
      if (data._last_interrupted) {
        for (let k = chatMessages.length - 1; k >= 0; k--) {
          if (chatMessages[k].role === 'assistant') {
            const parts = chatMessages[k].parts || []
            if (!parts.some((p: DisplayPart) => p.type === 'interrupted')) {
              chatMessages[k] = {
                ...chatMessages[k],
                parts: [...parts, { type: 'interrupted' }],
              }
            }
            break
          }
        }
      }

      const pendingInteraction = data.active_run?.pending_interaction as
        | {
            interaction_id?: string
            questions?: Extract<DisplayPart, { type: 'ask_user' }>['questions']
            created_at?: string | Date
          }
        | undefined
      if (pendingInteraction?.interaction_id && Array.isArray(pendingInteraction.questions)) {
        pendingInteractionIdsRef.current.set(targetKey, pendingInteraction.interaction_id)
        chatMessages.push({
          id: `assistant-ask-${pendingInteraction.interaction_id}`,
          role: 'assistant',
          content: '',
          parts: [{
            type: 'ask_user',
            interaction_id: pendingInteraction.interaction_id,
            questions: pendingInteraction.questions,
            answered: false,
          }],
          timestamp: pendingInteraction.created_at ? new Date(pendingInteraction.created_at) : new Date(),
        })
      } else {
        pendingInteractionIdsRef.current.delete(targetKey)
      }

      // Always cache the DB-loaded state (needed for background reconnect + later navigation back)
      const artifactFields: ConversationArtifactFields = {
        output: { files: data.output?.files, manifest: data.output?.manifest },
      }
      const loadedSettings = (data.settings ?? {}) as { orchestrator_model?: string; research_domain?: string; memory_enabled?: boolean }
      cacheRef.current.set(targetKey, {
        messages: chatMessages,
        dbArtifactFields: artifactFields,
        settings: loadedSettings,
        contextUsage: null,
        compactionStatus: null,
      })
      void hydrateCompactionStatus(targetKey)

      // Sync waiting_for_user flag from DB (persisted across tabs / refreshes)
      setWaitingForUserIds(prev => {
        const has = prev.has(targetKey)
        if (data._waiting_for_user && !has) return new Set([...prev, targetKey])
        if (!data._waiting_for_user && has) {
          const next = new Set(prev)
          next.delete(targetKey)
          return next
        }
        return prev
      })

      // Reconnect to live SSE broadcast if the loop is still running.
      // This must happen BEFORE the activeKey guard — even if the user navigated away,
      // background reconnect keeps the cache updated so switching back shows live progress.
      if (data.is_running) {
        const runId = data.active_run?.run_id as string | undefined
        if (runId) activeRunIdsRef.current.set(targetKey, runId)
        consumeReconnectStream(targetKey, runId)
      }

      // Only update React state if this is still the active conversation
      if (activeKeyRef.current !== targetKey) return

      setConversationId(data.conversation_id)
      setDbArtifactFields(artifactFields)
      setMessages(chatMessages)
      setIsLoadingConversation(false)
      // Workspace gating: a loaded conversation should reveal the workspace
      // panel iff a mutator tool was ever fired in its history. Scan parts
      // once here so re-entering a prior conversation immediately matches
      // its terminal workspace visibility — otherwise this state would lag
      // until the next live tool_start event (or never fire if conversation
      // is already complete).
      const hadMutator = chatMessages.some(m =>
        m.parts?.some(p => p.type === 'tool_call' && MUTATOR_TOOLS.has(p.tool)),
      )
      setHasMutatorStarted(hadMutator)
      // Hydrate ChatContext picker/conference from the loaded conversation
      // — this is what makes refreshing or reopening an old project show
      // the model that was actually used for it (not the default).
      onLoadedRef.current?.(loadedSettings)
    } catch {
      // Only clear loading if we're still on the same conversation; otherwise
      // a newer loadConversation has already taken over and may be in its own
      // loading window — don't trample its state.
      if (activeKeyRef.current === targetKey) setIsLoadingConversation(false)
    }
  // consumeReconnectStream is likewise a ref-backed transport helper; keeping
  // loadConversation stable prevents restore-on-mount from firing repeatedly.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])  // No reactive closure dependencies — all mutable state comes from refs

  // ==================== updateCachedSettings ====================
  // Patch a cached conversation's settings field so subsequent cache-hit
  // switches re-emit the latest values to ChatContext (memory toggle, model,
  // etc.). Used when the user changes a setting without sending a message —
  // otherwise the cache holds the stale value from the last DB load and a
  // switch-back would revert the toggle.

  const updateCachedSettings = useCallback(
    (id: string, partial: { orchestrator_model?: string; research_domain?: string; memory_enabled?: boolean }) => {
      const cached = cacheRef.current.get(id)
      if (!cached) return
      cached.settings = { ...(cached.settings ?? {}), ...partial }
    },
    [],
  )

  // ==================== resetChat (new chat without page reload) ====================

  const resetChat = useCallback(() => {
    // Cache already has current conversation's latest state — no need to save from closure
    const previousKey = activeKeyRef.current
    stopCompactionPolling(previousKey)
    activeKeyRef.current = '_new'
    setMessages([])
    setIsLoading(false)
    // Clear in case the user clicked "new chat" while a previous cache-miss
    // load was still pending — the orphaned fetch's active-key guard would
    // otherwise leave isLoadingConversation stuck at true and hide TaskWorkbench.
    setIsLoadingConversation(false)
    setConversationId(null)
    if (previousKey === '_new') activeRunIdsRef.current.delete('_new')
    setDbArtifactFields(null)
    setContextUsage(null)
    setHasMutatorStarted(false)
  }, [])  // No closure dependencies

  return {
    messages,
    isLoading,
    isLoadingConversation,
    conversationId,
    dbArtifactFields,
    runningConversationIds,
    waitingForUserIds,
    contextUsage,
    hasMutatorStarted,
    sendMessage,
    stopGeneration,
    loadConversation,
    refreshWorkspaceArtifacts,
    answerQuestion,
    resetChat,
    updateCachedSettings,
  }
}
