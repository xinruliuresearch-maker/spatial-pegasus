'use client'

import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { WorkspaceArtifact } from '@/hooks/useWorkspaceArtifacts'
import type { QuotedSelection } from '@/components/chat/ChatContainer'
import { useChatContext } from '@/contexts/ChatContext'
import { useConversationTitle } from '@/hooks/useConversation'
import { useGridFSContent } from '@/hooks/useGridFSContent'
import { SpatialStage } from '@/components/spatial-stage/SpatialStage'
import { ShimmerBlock } from '@/components/loading/Skeleton'
import { ArtifactLoadingOverlay } from './ArtifactLoadingOverlay'
import { LiteraturePaperReader } from './LiteraturePaperReader'
import { parseLiteratureArtifactPath } from './literature-paper-model'
import {
  SpatialImageViewer,
  SpatialModelViewer,
  SpatialWorldViewer,
} from './SpatialArtifactViewers'

interface WorkspacePanelProps {
  artifacts: WorkspaceArtifact[]
  isStreaming: boolean
  onQuoteSelection?: (selection: QuotedSelection) => void
  quotedSelection?: QuotedSelection | null
}

export function WorkspacePanel({ artifacts, isStreaming, onQuoteSelection, quotedSelection }: WorkspacePanelProps) {
  const {
    activeArtifactPath,
    activeSceneId,
    conversationId,
    setSidebarCollapsed,
    setSidebarView,
  } = useChatContext()
  const { title: projectTitle } = useConversationTitle(conversationId)
  const active = artifacts.find(item => item.path === activeArtifactPath) ?? artifacts[0]
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [active?.path])

  if (activeSceneId && conversationId) {
    return <section className="relative h-full min-w-0 overflow-hidden border-r border-[var(--glass-panel-border)] bg-[#dfe3eb]">
      <SpatialStage
        conversationId={conversationId}
        projectTitle={projectTitle}
        artifacts={artifacts}
        isProjectLoading={false}
        sceneId={activeSceneId}
        embedded
      />
    </section>
  }

  if (!active) {
    return (
      <div className="h-full p-4">
        <div className="flex h-full items-center justify-center rounded-2xl border border-[var(--glass-panel-border)] bg-[var(--glass-panel-bg)] backdrop-blur-xl">
          <div className="text-center">
            {isStreaming && <span className="mx-auto mb-4 block h-8 w-8 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />}
            <p className="text-sm font-medium text-ink-secondary">{isStreaming ? 'Agent 正在构建空间产物…' : '空间产物会显示在这里'}</p>
            <p className="mt-1 text-xs text-ink-muted">生成图、GLB 物体、World manifest 与可观察评审</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <section className="flex h-full min-w-0 flex-col border-r border-[var(--glass-panel-border)] bg-[color-mix(in_srgb,var(--glass-panel-bg)_42%,transparent)]">
      <WorkspaceBreadcrumb
        path={active.path}
        onRevealInSidebar={() => {
          setSidebarView('files')
          setSidebarCollapsed(false)
        }}
      />
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <ArtifactBody artifact={active} onQuoteSelection={onQuoteSelection} quotedSelection={quotedSelection} />
      </div>
    </section>
  )
}

function WorkspaceBreadcrumb({ path, onRevealInSidebar }: {
  path: string
  onRevealInSidebar: () => void
}) {
  const [copied, setCopied] = useState(false)
  const segments = path.split('/').filter(Boolean)
  const extension = segments.at(-1)?.split('.').pop()?.toUpperCase() ?? 'FILE'

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(path)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch { /* Clipboard can be denied in embedded browsers. */ }
  }

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--glass-panel-border)] bg-[color-mix(in_srgb,var(--glass-panel-bg)_74%,transparent)] px-3 backdrop-blur-xl">
      <button
        type="button"
        onClick={onRevealInSidebar}
        aria-label="在文件资源管理器中显示"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-ctrl text-ink-muted transition hover:bg-surface-low hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
      >
        <svg className="h-[17px] w-[17px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75A2.25 2.25 0 016 4.5h4.19c.6 0 1.17.24 1.59.66l1.06 1.06c.42.42.99.66 1.59.66H18A2.25 2.25 0 0120.25 9v8.25A2.25 2.25 0 0118 19.5H6a2.25 2.25 0 01-2.25-2.25V6.75z" />
        </svg>
      </button>

      <nav aria-label="当前文件路径" className="min-w-0 flex-1 overflow-hidden">
        <ol className="flex min-w-0 items-center gap-1 whitespace-nowrap text-[11px] text-ink-muted">
          <li className="shrink-0 font-medium text-ink-secondary">Workspace</li>
          {segments.map((segment, index) => {
            const isLast = index === segments.length - 1
            const hideMiddle = segments.length > 4 && index > 0 && index < segments.length - 2
            if (hideMiddle && index !== 1) return null
            return (
              <li key={`${segment}-${index}`} className={`flex min-w-0 items-center gap-1 ${isLast ? 'flex-1' : 'shrink-0'}`}>
                <span aria-hidden="true" className="text-outline-variant">/</span>
                {hideMiddle ? (
                  <span className="rounded px-1 font-mono text-ink-faint" title={segments.slice(1, -2).join('/')}>…</span>
                ) : (
                  <span
                    className={`${isLast ? 'truncate font-mono font-semibold text-ink' : 'max-w-28 truncate font-mono'}`}
                    title={segments.slice(0, index + 1).join('/')}
                  >
                    {segment}
                  </span>
                )}
              </li>
            )
          })}
        </ol>
      </nav>

      <span className="hidden shrink-0 rounded-md bg-surface-low px-1.5 py-1 font-mono text-[9px] font-semibold tracking-[0.08em] text-ink-faint sm:inline">
        {extension}
      </span>
      <button
        type="button"
        onClick={copyPath}
        className="shrink-0 rounded-ctrl px-2 py-1.5 text-[10px] font-medium text-ink-muted transition hover:bg-surface-low hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
        aria-label={copied ? '路径已复制' : '复制完整路径'}
      >
        {copied ? '已复制' : '复制路径'}
      </button>
    </header>
  )
}

function ArtifactBody({ artifact, onQuoteSelection, quotedSelection }: {
  artifact: WorkspaceArtifact
  onQuoteSelection?: (selection: QuotedSelection) => void
  quotedSelection?: QuotedSelection | null
}) {
  const {
    conversationId,
    inFlightPaths,
    artifacts,
    setActiveArtifactPath,
  } = useChatContext()
  const beingEdited = inFlightPaths.has(artifact.path)
  const lazy = useGridFSContent(conversationId, artifact.path, !!artifact.gridfsPending && !beingEdited)
  const content = artifact.content || lazy.content

  if (beingEdited) return <ArtifactLoadingOverlay artifact={artifact} />
  if (artifact.gridfsPending && lazy.isLoading && !content) {
    return <div className="m-4 flex h-[calc(100%-2rem)] flex-col gap-3 rounded-2xl bg-surface-lowest/70 p-8"><ShimmerBlock className="w-1/3" h={24} /><ShimmerBlock className="flex-1" /></div>
  }
  if (lazy.error) {
    return <div className="p-8 text-sm text-error">无法加载该产物：{lazy.error}</div>
  }
  if (artifact.type === 'image') {
    return conversationId
      ? <SpatialImageViewer artifact={artifact} conversationId={conversationId} />
      : <div className="p-8 text-sm text-error">图片所属项目尚未加载。</div>
  }
  if (artifact.type === 'model3d') {
    return conversationId
      ? <SpatialModelViewer artifact={artifact} conversationId={conversationId} />
      : <div className="p-8 text-sm text-error">3D 资产所属项目尚未加载。</div>
  }
  if (artifact.type === 'world') {
    return conversationId
      ? <SpatialWorldViewer artifact={artifact} conversationId={conversationId} content={content} />
      : <div className="p-8 text-sm text-error">世界资产所属项目尚未加载。</div>
  }
  if (parseLiteratureArtifactPath(artifact.path)) {
    return (
      <LiteraturePaperReader
        activeArtifact={artifact}
        content={content}
        allArtifacts={artifacts}
        conversationId={conversationId}
        setActivePath={setActiveArtifactPath}
        onQuoteSelection={onQuoteSelection}
      />
    )
  }
  if (artifact.type === 'document') {
    return <DocumentArtifactBody artifact={artifact} conversationId={conversationId} />
  }

  const captureSelection = () => {
    const selected = window.getSelection()?.toString().trim()
    if (selected && onQuoteSelection) {
      onQuoteSelection({ path: artifact.path, content: selected })
      window.getSelection()?.removeAllRanges()
    }
  }
  const quotedHere = quotedSelection?.path === artifact.path

  return (
    <article onMouseUp={captureSelection} className={`m-4 min-h-[calc(100%-2rem)] rounded-2xl border bg-surface-lowest/85 px-8 py-7 shadow-sm ${quotedHere ? 'border-primary/25' : 'border-outline-variant/10'}`}>
      {artifact.type === 'markdown' ? (
        <div className="prose prose-sm mx-auto max-w-[76ch] text-ink">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      ) : (
        <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-6 text-ink-secondary">{content}</pre>
      )}
    </article>
  )
}

function formatBytes(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return '未知大小'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function safeExternalUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null
  } catch {
    return null
  }
}

function DocumentArtifactBody({ artifact, conversationId }: {
  artifact: WorkspaceArtifact
  conversationId: string | null
}) {
  if (!conversationId || !artifact.sha256) {
    return <div className="p-8 text-sm text-error">该原始文献暂时无法打开。</div>
  }

  const baseUrl = `/api/conversations/${encodeURIComponent(conversationId)}/files/binary?path=${encodeURIComponent(artifact.path)}&v=${encodeURIComponent(artifact.sha256)}`
  const sourceUrl = safeExternalUrl(artifact.source?.canonical_url)
  const isPdf = artifact.mimeType === 'application/pdf'

  return (
    <section className="flex h-full min-h-[520px] flex-col bg-surface-lowest/60">
      <header className="shrink-0 border-b border-[var(--glass-panel-border)] bg-surface-lowest/90 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-ink" title={artifact.filename}>{artifact.filename ?? artifact.label}</h2>
            <p className="mt-1 text-xs text-ink-muted">
              {[artifact.mimeType, formatBytes(artifact.sizeBytes), artifact.source?.provider].filter(Boolean).join(' · ')}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            {sourceUrl && (
              <a href={sourceUrl} target="_blank" rel="noreferrer" className="rounded-lg border border-outline-variant/20 px-3 py-2 text-xs font-medium text-ink-secondary transition hover:bg-surface-low">
                查看来源
              </a>
            )}
            <a href={`${baseUrl}&download=1`} className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary transition hover:opacity-90">
              下载原文
            </a>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-muted">
          <span title={artifact.sha256}>SHA-256 {artifact.sha256.slice(0, 12)}…</span>
          {artifact.provenance?.retrieved_at && <span>获取于 {new Date(artifact.provenance.retrieved_at).toLocaleString()}</span>}
          {artifact.provenance?.license && <span>许可 {artifact.provenance.license}</span>}
        </div>
      </header>
      {isPdf ? (
        <iframe
          src={baseUrl}
          title={artifact.filename ?? artifact.label}
          className="min-h-0 flex-1 border-0 bg-white"
        />
      ) : (
        <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-ink-muted">
          此文档类型暂不支持内嵌预览，请下载原文件查看。
        </div>
      )}
    </section>
  )
}
