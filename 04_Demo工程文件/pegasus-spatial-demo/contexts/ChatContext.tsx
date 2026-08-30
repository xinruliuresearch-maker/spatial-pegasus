'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ImageAttachment, ModelProvider } from '@/lib/types'
import { useChat, type ChatMessage } from '@/hooks/useChat'
import {
  buildArtifactsFromDB,
  useWorkspaceArtifacts,
  type WorkspaceArtifact,
} from '@/hooks/useWorkspaceArtifacts'
import {
  isSpatialPreviewArtifact,
  latestSpatialPreview,
  spatialPreviewRevision,
} from '@/components/workspace/latest-spatial-preview'
import {
  ROOT_AGENT_RUN_EVENT,
  type RootAgentRunEventDetail,
} from '@/hooks/useAgentTeam'
import type { QuotedSelection } from '@/components/chat/ChatContainer'

const ACTIVE_CONVERSATION_KEY = 'pegasus_spatial_active_conversation_id'
const ACTIVE_ARTIFACT_KEY_PREFIX = 'pegasus_spatial_workspace_active_file:'
const ACTIVE_SCENE_KEY_PREFIX = 'pegasus_spatial_workspace_active_scene:'

export type SidebarView = 'projects' | 'scenes' | 'files'

interface ChatContextValue {
  model: ModelProvider
  setModel: (model: ModelProvider) => void
  researchDomain: string
  setResearchDomain: (domain: string) => void
  messages: ChatMessage[]
  isLoading: boolean
  isLoadingConversation: boolean
  conversationId: string | null
  contextUsage: { compressible: number; threshold: number } | null
  runningConversationIds: Set<string>
  waitingForUserIds: Set<string>
  sendMessage: (
    text: string,
    images?: ImageAttachment[],
    interactionId?: string,
    researchDomainOverride?: string,
  ) => void
  stopGeneration: () => void
  loadConversation: (id: string) => void
  refreshWorkspaceArtifacts: (id: string) => Promise<void>
  answerQuestion: (answer: string) => void
  resetChat: () => void
  artifacts: WorkspaceArtifact[]
  showWorkspace: boolean
  activeArtifactPath: string | null
  setActiveArtifactPath: (path: string | null) => void
  activeSceneId: string | null
  setActiveSceneId: (sceneId: string | null) => void
  inFlightPaths: Set<string>
  quotedSelection: QuotedSelection | null
  setQuotedSelection: (selection: QuotedSelection | null) => void
  sidebarCollapsed: boolean
  setSidebarCollapsed: (collapsed: boolean) => void
  sidebarView: SidebarView
  setSidebarView: (view: SidebarView) => void
  handleNewChat: () => void
  handleDeleteConversation: (id: string) => void
}

const ChatContext = createContext<ChatContextValue | null>(null)

export function ChatProvider({ children }: { children: ReactNode }) {
  const [model, setModel] = useState<ModelProvider>('main_standard')
  // Legacy metadata remains readable for existing projects, but new Spatial
  // conversations no longer invent a user-facing "creation context" choice.
  const [researchDomain, setResearchDomain] = useState('')
  const [quotedSelection, setQuotedSelection] = useState<QuotedSelection | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarView, setSidebarView] = useState<SidebarView>('projects')
  const [activeArtifactPath, setActiveArtifactPathState] = useState<string | null>(null)
  const [activeSceneId, setActiveSceneIdState] = useState<string | null>(null)
  const previousConversationIdRef = useRef<string | null>(null)
  const observedSpatialHeadsRef = useRef<{
    conversationId: string | null
    revisions: Map<string, string>
  }>({ conversationId: null, revisions: new Map() })
  const handleConversationLoaded = useCallback((settings: {
    orchestrator_model?: string
    research_domain?: string
    memory_enabled?: boolean
  }) => {
    if (settings.orchestrator_model) setModel(settings.orchestrator_model as ModelProvider)
    if (settings.research_domain !== undefined) setResearchDomain(settings.research_domain)
  }, [])

  const chat = useChat({ model, researchDomain, onConversationLoaded: handleConversationLoaded })
  const activeConversationId = chat.conversationId
  const reconnectConversation = chat.loadConversation

  useEffect(() => {
    const handleRootAgentRun = (rawEvent: Event) => {
      const event = rawEvent as CustomEvent<RootAgentRunEventDetail>
      if (!event.detail?.conversationId || event.detail.conversationId !== activeConversationId) return
      // loadConversation paints the cache immediately, then either keeps the
      // existing subscriber or rehydrates Mongo before attaching to the newly
      // announced public Root stream. Member streams are never accepted here.
      reconnectConversation(event.detail.conversationId)
    }
    window.addEventListener(ROOT_AGENT_RUN_EVENT, handleRootAgentRun)
    return () => window.removeEventListener(ROOT_AGENT_RUN_EVENT, handleRootAgentRun)
  }, [activeConversationId, reconnectConversation])

  const assistantParts = useMemo(() => chat.messages.flatMap(message => (
    message.role === 'assistant' ? message.parts ?? [] : []
  )), [chat.messages])
  const timelineArtifacts = useWorkspaceArtifacts(assistantParts)
  const dbArtifacts = useMemo(
    () => chat.dbArtifactFields ? buildArtifactsFromDB(chat.dbArtifactFields) : [],
    [chat.dbArtifactFields],
  )
  const artifacts = useMemo(() => {
    const merged = new Map<string, WorkspaceArtifact>()
    for (const artifact of dbArtifacts) merged.set(artifact.path, artifact)
    for (const artifact of timelineArtifacts) merged.set(artifact.path, artifact)
    return Array.from(merged.values())
  }, [dbArtifacts, timelineArtifacts])

  const setActiveArtifactPath = useCallback((path: string | null) => {
    setActiveArtifactPathState(path)
    if (path) setActiveSceneIdState(null)
    if (!chat.conversationId) return
    try {
      const key = `${ACTIVE_ARTIFACT_KEY_PREFIX}${chat.conversationId}`
      if (path) localStorage.setItem(key, path)
      else localStorage.removeItem(key)
      if (path) localStorage.removeItem(`${ACTIVE_SCENE_KEY_PREFIX}${chat.conversationId}`)
    } catch { /* localStorage may be unavailable in privacy modes */ }
  }, [chat.conversationId])

  const setActiveSceneId = useCallback((sceneId: string | null) => {
    setActiveSceneIdState(sceneId)
    if (sceneId) setActiveArtifactPathState(null)
    if (!chat.conversationId) return
    try {
      const key = `${ACTIVE_SCENE_KEY_PREFIX}${chat.conversationId}`
      if (sceneId) localStorage.setItem(key, sceneId)
      else localStorage.removeItem(key)
      if (sceneId) localStorage.removeItem(`${ACTIVE_ARTIFACT_KEY_PREFIX}${chat.conversationId}`)
    } catch { /* localStorage may be unavailable in privacy modes */ }
  }, [chat.conversationId])

  // The active file belongs to a project, not to the global application. A
  // project switch restores its last file; a genuinely new spatial revision
  // is handled separately below and becomes the live workspace preview once.
  useEffect(() => {
    const nextConversationId = chat.conversationId
    const changedProject = previousConversationIdRef.current !== nextConversationId
    previousConversationIdRef.current = nextConversationId

    if (!nextConversationId) {
      setActiveArtifactPathState(null)
      setActiveSceneIdState(null)
      setSidebarView('projects')
      return
    }

    if (changedProject) {
      setQuotedSelection(null)
      let savedPath: string | null = null
      let savedSceneId: string | null = null
      try {
        savedPath = localStorage.getItem(`${ACTIVE_ARTIFACT_KEY_PREFIX}${nextConversationId}`)
        savedSceneId = localStorage.getItem(`${ACTIVE_SCENE_KEY_PREFIX}${nextConversationId}`)
      } catch { /* ignore */ }
      setActiveSceneIdState(savedSceneId)
      setActiveArtifactPathState(savedSceneId ? null : savedPath)
      setSidebarView(savedSceneId ? 'scenes' : 'files')
    }
  }, [chat.conversationId])

  useEffect(() => {
    if (!chat.conversationId) return
    if (activeSceneId) return
    if (artifacts.length === 0) {
      setActiveArtifactPathState(null)
      return
    }
    setActiveArtifactPathState(current => {
      if (current && artifacts.some(artifact => artifact.path === current)) return current

      let savedPath: string | null = null
      try { savedPath = localStorage.getItem(`${ACTIVE_ARTIFACT_KEY_PREFIX}${chat.conversationId}`) } catch { /* ignore */ }
      const preferred = artifacts.find(artifact => artifact.path === savedPath)
        ?? latestSpatialPreview(artifacts)
        ?? artifacts.find(artifact => artifact.path === 'output/research-report.md')
        ?? artifacts.find(artifact => artifact.path === 'analysis/research-scope.md')
        ?? artifacts[0]
      try { localStorage.setItem(`${ACTIVE_ARTIFACT_KEY_PREFIX}${chat.conversationId}`, preferred.path) } catch { /* ignore */ }
      return preferred.path
    })
  }, [activeSceneId, artifacts, chat.conversationId])

  // Auto-present only a newly published image/model/world revision. Repeated
  // status polling produces the same revision fingerprint and therefore never
  // keeps stealing focus after the user manually opens another file.
  useEffect(() => {
    const conversationId = chat.conversationId
    const previews = artifacts.filter(isSpatialPreviewArtifact)
    const nextRevisions = new Map(
      previews.map(artifact => [artifact.path, spatialPreviewRevision(artifact)]),
    )
    const observed = observedSpatialHeadsRef.current
    if (!conversationId || observed.conversationId !== conversationId) {
      observedSpatialHeadsRef.current = { conversationId, revisions: nextRevisions }
      return
    }

    const changed = previews.filter(artifact => (
      observed.revisions.get(artifact.path) !== nextRevisions.get(artifact.path)
    ))
    observedSpatialHeadsRef.current = { conversationId, revisions: nextRevisions }
    const latest = latestSpatialPreview(changed)
    if (!latest) return

    setActiveSceneIdState(null)
    setActiveArtifactPathState(latest.path)
    setSidebarView('files')
    try {
      localStorage.setItem(`${ACTIVE_ARTIFACT_KEY_PREFIX}${conversationId}`, latest.path)
      localStorage.removeItem(`${ACTIVE_SCENE_KEY_PREFIX}${conversationId}`)
    } catch { /* localStorage may be unavailable in privacy modes */ }
  }, [artifacts, chat.conversationId])
  const showWorkspace = Boolean(activeSceneId) || artifacts.length > 0 || (chat.isLoading && chat.hasMutatorStarted)
  const inFlightPaths = useMemo(() => {
    const result = new Set<string>()
    for (const part of assistantParts) {
      if (part.type === 'tool_call' && part.pending && part.target_path) result.add(part.target_path)
    }
    return result
  }, [assistantParts])

  const handleNewChat = useCallback(() => {
    setQuotedSelection(null)
    setActiveArtifactPathState(null)
    setActiveSceneIdState(null)
    setSidebarView('projects')
    chat.resetChat()
  }, [chat])
  const handleDeleteConversation = useCallback((id: string) => {
    if (id === chat.conversationId) chat.resetChat()
  }, [chat])

  useEffect(() => {
    let savedId: string | null = null
    try { savedId = localStorage.getItem(ACTIVE_CONVERSATION_KEY) } catch { return }
    if (!savedId) return
    fetch(`/api/conversations/${savedId}`)
      .then(response => response.ok ? response.json() : null)
      .then(data => {
        if (data?.is_running) chat.loadConversation(savedId as string)
        else localStorage.removeItem(ACTIVE_CONVERSATION_KEY)
      })
      .catch(() => {
        try { localStorage.removeItem(ACTIVE_CONVERSATION_KEY) } catch { /* ignore */ }
      })
  // Restore only once. useChat keeps loadConversation stable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const value = useMemo<ChatContextValue>(() => ({
    model,
    setModel,
    researchDomain,
    setResearchDomain,
    messages: chat.messages,
    isLoading: chat.isLoading,
    isLoadingConversation: chat.isLoadingConversation,
    conversationId: chat.conversationId,
    contextUsage: chat.contextUsage,
    runningConversationIds: chat.runningConversationIds,
    waitingForUserIds: chat.waitingForUserIds,
    sendMessage: chat.sendMessage,
    stopGeneration: chat.stopGeneration,
    loadConversation: chat.loadConversation,
    refreshWorkspaceArtifacts: chat.refreshWorkspaceArtifacts,
    answerQuestion: chat.answerQuestion,
    resetChat: chat.resetChat,
    artifacts,
    showWorkspace,
    activeArtifactPath,
    setActiveArtifactPath,
    activeSceneId,
    setActiveSceneId,
    inFlightPaths,
    quotedSelection,
    setQuotedSelection,
    sidebarCollapsed,
    setSidebarCollapsed,
    sidebarView,
    setSidebarView,
    handleNewChat,
    handleDeleteConversation,
  }), [
    model, researchDomain, chat.messages, chat.isLoading, chat.isLoadingConversation,
    chat.conversationId, chat.contextUsage, chat.runningConversationIds,
    chat.waitingForUserIds, chat.sendMessage, chat.stopGeneration,
    chat.loadConversation, chat.refreshWorkspaceArtifacts, chat.answerQuestion, chat.resetChat,
    artifacts, showWorkspace, activeArtifactPath, setActiveArtifactPath,
    activeSceneId, setActiveSceneId,
    inFlightPaths, quotedSelection, sidebarCollapsed, sidebarView,
    handleNewChat, handleDeleteConversation,
  ])

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>
}

export function useChatContext() {
  const context = useContext(ChatContext)
  if (!context) throw new Error('useChatContext must be used within ChatProvider')
  return context
}
