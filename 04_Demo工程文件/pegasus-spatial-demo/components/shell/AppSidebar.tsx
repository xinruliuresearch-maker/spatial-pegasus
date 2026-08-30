'use client'

import { useState, useRef, useEffect, useMemo } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useChatContext } from '@/contexts/ChatContext'
import { useConversationTitle } from '@/hooks/useConversation'
import { useLiteraturePaperSummaries } from '@/hooks/useLiteraturePaperSummaries'
import { parsePaperSummaryFile } from '@/lib/literature/paper-summaries'
import { WorkspaceFileExplorer } from '@/components/workspace/WorkspaceFileExplorer'
import { SpatialSceneList } from '@/components/spatial-stage/SpatialSceneList'
import { useSpatialScenes } from '@/hooks/useSpatialScenes'
import { LEFT_SIDEBAR_LIMITS, useWorkspaceLayout } from '@/contexts/WorkspaceLayoutContext'
import { ConversationList } from './ConversationList'
import { FeedbackDialog } from './FeedbackDialog'
import { PanelResizeHandle } from './PanelResizeHandle'

function SidebarModeTab({ selected, disabled = false, label, count, onClick }: {
  selected: boolean
  disabled?: boolean
  label: string
  count?: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-8 items-center justify-center gap-1.5 rounded-ctrl text-[11px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-35 ${selected ? 'bg-surface-lowest text-primary shadow-sm' : 'text-ink-muted hover:bg-white/35 hover:text-ink'}`}
    >
      {label}
      {count !== undefined && <span className={`font-mono text-[8.5px] tabular-nums ${selected ? 'text-primary/70' : 'text-ink-faint'}`}>{count}</span>}
    </button>
  )
}

function CollapsedNavigationButton({ active, disabled = false, label, icon, count, onClick }: {
  active: boolean
  disabled?: boolean
  label: string
  icon: 'projects' | 'scenes' | 'files'
  count?: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`relative flex h-10 w-10 items-center justify-center rounded-card transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-30 ${active ? 'bg-primary/10 text-primary' : 'text-ink-muted hover:bg-white/45 hover:text-ink'}`}
    >
      {icon === 'projects' ? (
        <svg className="h-[18px] w-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.55} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 5.25A2.25 2.25 0 0 1 6 3h3.19c.6 0 1.17.24 1.59.66l.56.56c.42.42.99.66 1.59.66H18A2.25 2.25 0 0 1 20.25 7.1v10.65A2.25 2.25 0 0 1 18 20H6a2.25 2.25 0 0 1-2.25-2.25V5.25Z" /></svg>
      ) : icon === 'scenes' ? (
        <svg className="h-[18px] w-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.55} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="m4.5 7.5 7.5-4 7.5 4-7.5 4-7.5-4Z" /><path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12 7.5 4 7.5-4M4.5 16.5l7.5 4 7.5-4" /></svg>
      ) : (
        <svg className="h-[18px] w-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.55} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3.75h7.69c.4 0 .78.16 1.06.44l2.31 2.31c.28.28.44.66.44 1.06v12.69h-11.5a1.5 1.5 0 0 1-1.5-1.5V5.25a1.5 1.5 0 0 1 1.5-1.5Z" /><path strokeLinecap="round" d="M14.25 3.75V7.5h3.75M8.5 12h6.5M8.5 15h6.5" /></svg>
      )}
      {count !== undefined && count > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-primary px-1 font-mono text-[7px] leading-4 text-on-primary shadow-sm">{count > 99 ? '99+' : count}</span>}
    </button>
  )
}

export function AppSidebar({ className = '' }: { className?: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const { leftSidebarWidth, setLeftSidebarWidth, resetLeftSidebarWidth } = useWorkspaceLayout()
  const {
    conversationId,
    artifacts,
    activeArtifactPath,
    setActiveArtifactPath,
    activeSceneId,
    setActiveSceneId,
    inFlightPaths,
    runningConversationIds,
    waitingForUserIds,
    loadConversation,
    handleDeleteConversation,
    handleNewChat,
    sidebarCollapsed,
    setSidebarCollapsed,
    sidebarView,
    setSidebarView,
  } = useChatContext()

  const collapsed = sidebarCollapsed
  const [showMenu, setShowMenu] = useState(false)
  const [showFeedback, setShowFeedback] = useState(false)
  const [shimmering, setShimmering] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const canBrowseFiles = pathname === '/' && Boolean(conversationId)
  const effectiveView = canBrowseFiles ? sidebarView : 'projects'
  const spatialScenes = useSpatialScenes(canBrowseFiles ? conversationId : null, canBrowseFiles)
  const { title: activeProjectTitle } = useConversationTitle(canBrowseFiles ? conversationId : null)
  const paperFingerprint = useMemo(() => {
    const bundles = new Map<string, Set<string>>()
    for (const artifact of artifacts) {
      const parsed = parsePaperSummaryFile(artifact.path)
      if (!parsed) continue
      let roles = bundles.get(parsed.identity.directory)
      if (!roles) {
        roles = new Set<string>()
        bundles.set(parsed.identity.directory, roles)
      }
      roles.add(parsed.relativePath)
    }
    return [...bundles]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([directory, roles]) => `${directory}:${[...roles].sort().join(',')}`)
      .join('\u0000')
  }, [artifacts])
  const paperSummaries = useLiteraturePaperSummaries(
    canBrowseFiles ? conversationId : null,
    paperFingerprint,
    effectiveView === 'files',
  )
  const paperSummaryByDirectory = useMemo(
    () => new Map(paperSummaries.papers.map(paper => [paper.directory, paper])),
    [paperSummaries.papers],
  )

  const handleCreate = () => {
    setShimmering(true)
    setTimeout(() => setShimmering(false), 850)
    handleNewChat()
    if (pathname !== '/') router.push('/')
  }

  const selectConversation = (id: string) => {
    setSidebarView('files')
    loadConversation(id)
  }

  const openScenes = () => {
    if (!canBrowseFiles) return
    setSidebarView('scenes')
    if (!activeSceneId && spatialScenes.scenes[0]) setActiveSceneId(spatialScenes.scenes[0].scene_id)
  }

  useEffect(() => {
    if (!spatialScenes.hasLoaded || !activeSceneId) return
    if (!spatialScenes.scenes.some(scene => scene.scene_id === activeSceneId)) setActiveSceneId(null)
  }, [activeSceneId, setActiveSceneId, spatialScenes.hasLoaded, spatialScenes.scenes])

  // Close menu on outside click
  useEffect(() => {
    if (!showMenu) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showMenu])

  return (
    <>
      {/* 玻璃岛(W3b):侧栏面板底从 bg-surface-sidebar 硬底校准到玻璃 token——
          区域玻璃取 --glass-panel-bg 的 55%(与顶栏/hero 同比),活背景从侧栏
          下透过;右缘 1px 硬发丝分隔线 → 极淡玻璃边。 */}
      <aside
        aria-label="项目与文件导航"
        data-resizable-panel="left-sidebar"
        className={`pmo-resizable-panel h-screen fixed left-0 top-0 pt-16 flex flex-col bg-[color-mix(in_srgb,var(--glass-panel-bg)_55%,transparent)] backdrop-blur-[20px] backdrop-saturate-150 z-40 ${className}`}
        style={{ width: collapsed ? 64 : leftSidebarWidth, boxShadow: '1px 0 0 rgba(20,26,38,0.08), 10px 0 30px -18px rgba(16,20,32,0.15)' }}
      >
        <div className={`flex shrink-0 items-center gap-2 py-2 ${collapsed ? 'flex-col px-3' : 'px-4'}`}>
          <button
            type="button"
            onClick={() => setSidebarCollapsed(!collapsed)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-card text-ink-muted transition hover:bg-white/50 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            title={collapsed ? '展开导航' : '收起导航'}
            aria-label={collapsed ? '展开导航' : '收起导航'}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
            </svg>
          </button>
          {!collapsed && <span className="min-w-0 flex-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-faint">空间创作导航</span>}
          <button
            type="button"
            onClick={handleCreate}
            className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-card text-primary transition hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${collapsed ? 'mt-1' : ''}`}
            title="新项目"
            aria-label="新项目"
          >
            <svg className="h-[17px] w-[17px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.9} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            <span aria-hidden="true" className={`pmo-shimmer ${shimmering ? 'pmo-shimmer-fire' : ''}`} />
          </button>
        </div>

        {collapsed ? (
          <div className="flex flex-1 flex-col items-center gap-2 px-3 pt-3">
            <CollapsedNavigationButton
              active={effectiveView === 'projects'}
              label="项目"
              onClick={() => {
                setSidebarView('projects')
                setSidebarCollapsed(false)
              }}
              icon="projects"
            />
            <CollapsedNavigationButton
              active={effectiveView === 'scenes'}
              disabled={!canBrowseFiles}
              label={canBrowseFiles ? `场景，共 ${spatialScenes.scenes.length} 个` : '请先打开项目'}
              count={canBrowseFiles ? spatialScenes.scenes.length : undefined}
              onClick={() => {
                openScenes()
                setSidebarCollapsed(false)
              }}
              icon="scenes"
            />
            <CollapsedNavigationButton
              active={effectiveView === 'files'}
              disabled={!canBrowseFiles}
              label={canBrowseFiles ? `文件，共 ${artifacts.length} 个` : '请先打开项目'}
              count={canBrowseFiles ? artifacts.length : undefined}
              onClick={() => {
                if (!canBrowseFiles) return
                setSidebarView('files')
                setSidebarCollapsed(false)
              }}
              icon="files"
            />
          </div>
        ) : (
          <>
            <div className="shrink-0 px-4 pb-2">
              <div role="tablist" aria-label="导航模式" className="grid grid-cols-3 gap-1 rounded-card bg-surface-low/65 p-1">
                <SidebarModeTab
                  selected={effectiveView === 'projects'}
                  label="项目"
                  onClick={() => setSidebarView('projects')}
                />
                <SidebarModeTab
                  selected={effectiveView === 'scenes'}
                  disabled={!canBrowseFiles}
                  label="场景"
                  count={canBrowseFiles ? spatialScenes.scenes.length : undefined}
                  onClick={openScenes}
                />
                <SidebarModeTab
                  selected={effectiveView === 'files'}
                  disabled={!canBrowseFiles}
                  label="文件"
                  count={canBrowseFiles ? artifacts.length : undefined}
                  onClick={() => setSidebarView('files')}
                />
              </div>
            </div>

            {effectiveView === 'projects' ? (
              <div role="tabpanel" aria-label="项目" className="min-h-0 flex-1 overflow-y-auto px-4 pb-3 no-scrollbar">
                <button
                  type="button"
                  onClick={handleCreate}
                  className="pmo-btn-primary relative mb-5 mt-1 flex h-10 w-full items-center justify-center rounded-ctrl px-3 text-[12px]"
                  style={{ boxShadow: '0 4px 16px -5px color-mix(in srgb, var(--primary) 32%, transparent)' }}
                >
                  <span className="relative z-10 inline-flex items-center gap-2">
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true"><path strokeLinecap="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                    新项目
                  </span>
                  <span aria-hidden="true" className={`pmo-shimmer ${shimmering ? 'pmo-shimmer-fire' : ''}`} />
                </button>
                <div className="pmo-sidebar-section-title">PROJECTS · 历史项目</div>
                <ConversationList
                  currentConversationId={conversationId}
                  runningConversationIds={runningConversationIds}
                  waitingForUserIds={waitingForUserIds}
                  onSelectConversation={selectConversation}
                  onDeleteConversation={handleDeleteConversation}
                />
              </div>
            ) : effectiveView === 'scenes' ? (
              <div role="tabpanel" aria-label="场景" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                <SpatialSceneList
                  scenes={spatialScenes.scenes}
                  activeSceneId={activeSceneId}
                  isLoading={spatialScenes.isLoading}
                  error={spatialScenes.error}
                  onSelect={sceneId => {
                    setActiveSceneId(sceneId)
                    setSidebarView('scenes')
                  }}
                />
              </div>
            ) : (
              <div role="tabpanel" aria-label="文件" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                <div className="mx-4 mb-2 mt-1 rounded-card border border-outline-variant/10 bg-white/35 px-3 py-2.5">
                  <p className="truncate text-[11.5px] font-semibold text-ink" title={activeProjectTitle ?? '当前研究项目'}>{activeProjectTitle ?? '当前研究项目'}</p>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">Workspace</span>
                    <span className="font-mono text-[9px] tabular-nums text-ink-faint">{artifacts.length} files</span>
                  </div>
                </div>
                {conversationId && (
                  <WorkspaceFileExplorer
                    conversationId={conversationId}
                    artifacts={artifacts}
                    paperSummaries={paperSummaryByDirectory}
                    activePath={activeArtifactPath}
                    inFlightPaths={inFlightPaths}
                    onSelect={setActiveArtifactPath}
                  />
                )}
              </div>
            )}
          </>
        )}

        {/* Bottom — Settings popover */}
        <div className={`mt-auto pt-2 pb-5 ${collapsed ? 'px-3' : 'pl-5 pr-4'} space-y-1`}>
          {/* Settings & Help button + popover */}
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setShowMenu(!showMenu)}
              className={`flex items-center gap-3 rounded-card text-ink-muted hover:text-on-surface hover:bg-white/50 transition-all h-9 ${
                collapsed ? 'justify-center px-0 w-full' : 'px-2 w-full'
              }`}
              title="设置与帮助"
            >
              <svg className="w-[18px] h-[18px] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              {!collapsed && <span className="text-[12.5px] tracking-tight">设置与帮助</span>}
            </button>

            {showMenu && (
              <div className="absolute bottom-full left-0 mb-2 w-56 rounded-card bg-[var(--glass-panel-bg)] backdrop-blur-[20px] backdrop-saturate-150 shadow-[var(--shadow-glass)] border border-[var(--glass-panel-border)] py-2 z-50 animate-fade-in">
                {/* Feedback */}
                <button
                  onClick={() => { setShowMenu(false); setShowFeedback(true) }}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-ink-secondary hover:text-ink hover:bg-surface-low transition-colors"
                >
                  <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
                  </svg>
                  <span>反馈</span>
                </button>

                {/* Help */}
                <button
                  onClick={() => { setShowMenu(false); router.push('/help') }}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-ink-secondary hover:text-ink hover:bg-surface-low transition-colors"
                >
                  <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z" />
                  </svg>
                  <span>帮助</span>
                </button>
              </div>
            )}
          </div>
        </div>
        {!collapsed && <PanelResizeHandle
          edge="right"
          label="调整左侧导航宽度"
          value={leftSidebarWidth}
          min={LEFT_SIDEBAR_LIMITS.min}
          max={LEFT_SIDEBAR_LIMITS.max}
          onChange={setLeftSidebarWidth}
          onReset={resetLeftSidebarWidth}
        />}
      </aside>

      {/* Feedback dialog — rendered outside sidebar */}
      <FeedbackDialog open={showFeedback} onClose={() => setShowFeedback(false)} />
    </>
  )
}
