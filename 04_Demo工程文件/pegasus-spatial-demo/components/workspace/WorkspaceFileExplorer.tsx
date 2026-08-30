'use client'

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { WorkspaceArtifact } from '@/hooks/useWorkspaceArtifacts'
import {
  parsePaperSummaryFile,
  type LiteraturePaperSummary,
} from '@/lib/literature/paper-summaries'
import {
  buildWorkspaceTree,
  flattenVisibleTree,
  getAncestorPaths,
  getDefaultExpandedPaths,
  getVisibleNavigationTarget,
  type WorkspaceTreeNode,
} from './workspace-file-tree-model'

const EXPANDED_PATHS_KEY_PREFIX = 'pegasus_spatial_workspace_expanded:'
const EMPTY_PAPER_SUMMARIES = new Map<string, LiteraturePaperSummary>()

const ROOT_FOLDER_LABELS: Readonly<Record<string, string>> = {
  output: '成果',
  analysis: '分析',
  references: '文献',
  notes: '笔记',
}

interface WorkspaceFileExplorerProps {
  conversationId: string
  artifacts: WorkspaceArtifact[]
  paperSummaries?: ReadonlyMap<string, LiteraturePaperSummary>
  activePath: string | null
  inFlightPaths: ReadonlySet<string>
  onSelect: (path: string) => void
}

function folderPaths(roots: readonly WorkspaceTreeNode[]): Set<string> {
  const result = new Set<string>()
  const visit = (nodes: readonly WorkspaceTreeNode[]) => {
    for (const node of nodes) {
      if (node.kind !== 'folder') continue
      result.add(node.path)
      visit(node.children)
    }
  }
  visit(roots)
  return result
}

function normalizeInFlightPath(path: string): string {
  return path.replace(/^\/workspace\//, '').replace(/^workspace\//, '').replace(/^\//, '')
}

function readExpandedPaths(conversationId: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(`${EXPANDED_PATHS_KEY_PREFIX}${conversationId}`) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function extensionBadge(path: string): { label: string; tone: string } {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  if (extension === 'md') return { label: 'MD', tone: 'text-primary/75' }
  if (extension === 'pdf') return { label: 'PDF', tone: 'text-[#a35f58]' }
  if (extension === 'json' || extension === 'jsonl') return { label: '{ }', tone: 'text-[#6e735c]' }
  if (extension === 'csv') return { label: 'CSV', tone: 'text-[#668267]' }
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(extension)) return { label: 'IMG', tone: 'text-primary' }
  if (extension === 'glb' || extension === 'gltf') return { label: '3D', tone: 'text-[#8a6848]' }
  if (extension === 'txt') return { label: 'TXT', tone: 'text-ink-faint' }
  return { label: extension.slice(0, 4).toUpperCase() || 'FILE', tone: 'text-ink-faint' }
}

function managedReference(path: string): boolean {
  return path.startsWith('references/papers/') || path.startsWith('references/searches/')
}

function paperDirectoryLabel(name: string): string | null {
  const match = /^(sciverse|arxiv)-(.+)-[a-f0-9]{10}$/i.exec(name)
  if (!match) return null
  const source = match[1].toLocaleLowerCase() === 'arxiv' ? 'arXiv' : 'Sciverse'
  const identity = match[2]
  const abbreviated = identity.length > 16 ? `${identity.slice(0, 12)}…` : identity
  return `${source} · ${abbreviated}`
}

function visibleNodeLabel(
  node: WorkspaceTreeNode,
  depth: number,
  paperSummaries: ReadonlyMap<string, LiteraturePaperSummary>,
): string {
  if (node.kind === 'file') return node.artifact.label || node.name
  if (depth === 0) return ROOT_FOLDER_LABELS[node.name] ?? node.name
  if (node.parentPath === 'references/papers') {
    return paperSummaries.get(node.path)?.title ?? paperDirectoryLabel(node.name) ?? node.name
  }
  return node.name
}

export function WorkspaceFileExplorer({
  conversationId,
  artifacts,
  paperSummaries = EMPTY_PAPER_SUMMARIES,
  activePath,
  inFlightPaths,
  onSelect,
}: WorkspaceFileExplorerProps) {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [focusedPath, setFocusedPath] = useState<string | null>(null)
  const expansionOwnerRef = useRef<string | null>(null)
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>())

  // Chat text streams frequently while the set of file paths changes rarely.
  // Use a path fingerprint so a 500-file tree is not rebuilt for every token.
  const pathFingerprint = artifacts.map(artifact => artifact.path).sort().join('\u0000')
  const treeCacheRef = useRef<{
    fingerprint: string
    roots: ReturnType<typeof buildWorkspaceTree>
  } | null>(null)
  if (!treeCacheRef.current || treeCacheRef.current.fingerprint !== pathFingerprint) {
    treeCacheRef.current = {
      fingerprint: pathFingerprint,
      roots: buildWorkspaceTree(artifacts),
    }
  }
  const roots = treeCacheRef.current.roots

  useEffect(() => {
    const validFolders = folderPaths(roots)
    const ancestors = activePath ? getAncestorPaths(activePath) : []
    const changedOwner = expansionOwnerRef.current !== conversationId
    expansionOwnerRef.current = conversationId

    setExpanded(current => {
      const next = new Set<string>()
      const candidates = changedOwner
        ? [...getDefaultExpandedPaths(roots), ...readExpandedPaths(conversationId)]
        : [...current]
      for (const path of [...candidates, ...ancestors]) {
        if (validFolders.has(path)) next.add(path)
      }
      return next
    })
  }, [activePath, conversationId, pathFingerprint, roots])

  useEffect(() => {
    if (expansionOwnerRef.current !== conversationId) return
    const timeout = window.setTimeout(() => {
      try {
        localStorage.setItem(
          `${EXPANDED_PATHS_KEY_PREFIX}${conversationId}`,
          JSON.stringify([...expanded]),
        )
      } catch { /* ignore unavailable storage */ }
    }, 160)
    return () => window.clearTimeout(timeout)
  }, [conversationId, expanded])

  const visibleNodes = useMemo(() => flattenVisibleTree(roots, expanded), [expanded, roots])
  const normalizedInFlight = useMemo(
    () => new Set([...inFlightPaths].map(normalizeInFlightPath)),
    [inFlightPaths],
  )
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const matches = useMemo(() => {
    if (!normalizedQuery) return []
    return artifacts
      .filter(artifact => {
        if (
          artifact.path.toLocaleLowerCase().includes(normalizedQuery)
          || artifact.label.toLocaleLowerCase().includes(normalizedQuery)
        ) return true
        const paper = parsePaperSummaryFile(artifact.path)
        const title = paper ? paperSummaries.get(paper.identity.directory)?.title : undefined
        return title?.toLocaleLowerCase().includes(normalizedQuery) ?? false
      })
      .sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true }))
  }, [artifacts, normalizedQuery, paperSummaries])

  const focusNode = (path: string | null) => {
    if (!path) return
    setFocusedPath(path)
    // Every keyboard navigation target is already present in the visible tree.
    // Focus it in the key event itself so a busy render cannot postpone the
    // accessibility response until an arbitrarily delayed animation frame.
    nodeRefs.current.get(path)?.focus()
  }

  const toggleFolder = (path: string, force?: boolean) => {
    setExpanded(current => {
      const next = new Set(current)
      const shouldOpen = force ?? !next.has(path)
      if (shouldOpen) next.add(path)
      else next.delete(path)
      return next
    })
  }

  const activateNode = (node: WorkspaceTreeNode) => {
    setFocusedPath(node.path)
    if (node.kind === 'folder') toggleFolder(node.path)
    else onSelect(node.path)
  }

  const handleTreeKeyDown = (event: KeyboardEvent<HTMLButtonElement>, node: WorkspaceTreeNode) => {
    const move = (path: string | null) => {
      event.preventDefault()
      focusNode(path)
    }
    if (event.key === 'ArrowDown') return move(getVisibleNavigationTarget(roots, expanded, node.path, 'next'))
    if (event.key === 'ArrowUp') return move(getVisibleNavigationTarget(roots, expanded, node.path, 'previous'))
    if (event.key === 'Home') return move(visibleNodes[0]?.node.path ?? null)
    if (event.key === 'End') return move(visibleNodes.at(-1)?.node.path ?? null)
    if (event.key === 'ArrowRight' && node.kind === 'folder') {
      if (!expanded.has(node.path)) {
        event.preventDefault()
        toggleFolder(node.path, true)
      } else {
        move(getVisibleNavigationTarget(roots, expanded, node.path, 'first-child'))
      }
      return
    }
    if (event.key === 'ArrowLeft') {
      if (node.kind === 'folder' && expanded.has(node.path)) {
        event.preventDefault()
        toggleFolder(node.path, false)
      } else {
        move(getVisibleNavigationTarget(roots, expanded, node.path, 'parent'))
      }
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      activateNode(node)
    }
  }

  if (artifacts.length === 0) {
    return (
      <div className="flex min-h-52 flex-col items-center justify-center px-5 text-center">
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-card bg-primary/7 text-primary/65">
          <FolderIcon open />
        </div>
        <p className="text-xs font-medium text-ink-secondary">空间资产尚未生成</p>
        <p className="mt-1 max-w-44 text-[10px] leading-4 text-ink-faint">Agent 发布图像、GLB 或 World manifest 后，会自动出现在这里。</p>
      </div>
    )
  }

  return (
    <section aria-label="项目文件资源管理器" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="px-3 pb-2 pt-1">
        <label className="group flex h-8 items-center gap-2 rounded-ctrl border border-outline-variant/15 bg-surface-lowest/55 px-2.5 transition focus-within:border-primary/30 focus-within:bg-surface-lowest/85">
          <svg className="h-3.5 w-3.5 shrink-0 text-ink-faint group-focus-within:text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-4.35-4.35m1.35-5.4a6.75 6.75 0 1 1-13.5 0 6.75 6.75 0 0 1 13.5 0Z" />
          </svg>
          <span className="sr-only">筛选项目文件</span>
          <input
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={`筛选 ${artifacts.length} 个文件`}
            className="min-w-0 flex-1 bg-transparent text-[11px] text-ink outline-none placeholder:text-ink-faint"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label="清除筛选" className="text-[13px] text-ink-faint hover:text-ink">×</button>
          )}
        </label>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-2 pb-3" data-testid="workspace-file-explorer">
        {normalizedQuery ? (
          <div role="listbox" aria-label="文件筛选结果" className="space-y-0.5">
            {matches.map(artifact => (
              <SearchResult
                key={artifact.path}
                artifact={artifact}
                active={artifact.path === activePath}
                paperSummary={paperSummaries.get(parsePaperSummaryFile(artifact.path)?.identity.directory ?? '')}
                onSelect={onSelect}
              />
            ))}
            {matches.length === 0 && <p className="px-3 py-8 text-center text-[10px] text-ink-faint">没有匹配的文件</p>}
          </div>
        ) : (
          <div role="tree" aria-label={`Workspace 文件，共 ${artifacts.length} 个`} className="w-full min-w-0">
            {visibleNodes.map(({ node, depth, indexInParent, siblingCount }) => {
              const isFolder = node.kind === 'folder'
              const isOpen = isFolder && expanded.has(node.path)
              const isSelected = node.kind === 'file' && node.path === activePath
              const isUpdating = node.kind === 'file' && normalizedInFlight.has(node.path)
              const isFocusable = focusedPath ? focusedPath === node.path : (activePath ? activePath === node.path : visibleNodes[0]?.node.path === node.path)
              const paperSummary = isFolder ? paperSummaries.get(node.path) : undefined
              const label = visibleNodeLabel(node, depth, paperSummaries)
              return (
                <button
                  key={node.id}
                  ref={element => {
                    if (element) nodeRefs.current.set(node.path, element)
                    else nodeRefs.current.delete(node.path)
                  }}
                  type="button"
                  role="treeitem"
                  aria-level={depth + 1}
                  aria-posinset={indexInParent + 1}
                  aria-setsize={siblingCount}
                  aria-expanded={isFolder ? isOpen : undefined}
                  aria-selected={!isFolder ? isSelected : undefined}
                  aria-label={isFolder ? `${label}，${node.descendantFileCount} 个文件` : `${label}，${node.path}${isUpdating ? '，正在更新' : ''}`}
                  tabIndex={isFocusable ? 0 : -1}
                  onFocus={() => setFocusedPath(node.path)}
                  onClick={() => activateNode(node)}
                  onKeyDown={event => handleTreeKeyDown(event, node)}
                  className={`group relative flex h-[30px] w-full min-w-0 max-w-full items-center overflow-hidden rounded-lg pr-2 text-left transition focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/45 ${isSelected ? 'bg-primary/10 font-semibold text-primary' : 'text-ink-secondary hover:bg-white/45 hover:text-ink'}`}
                  style={{ paddingLeft: 6 + depth * 14 }}
                >
                  {isSelected && (
                    <span
                      aria-hidden="true"
                      className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary"
                      style={{ boxShadow: '0 0 7px color-mix(in srgb, var(--primary) 45%, transparent)' }}
                    />
                  )}
                  <span className="mr-1 flex h-4 w-4 shrink-0 items-center justify-center text-ink-faint">
                    {isFolder ? <ChevronIcon open={isOpen} /> : null}
                  </span>
                  <span className="mr-1.5 flex h-4 w-4 shrink-0 items-center justify-center">
                    {isFolder ? <FolderIcon open={isOpen} /> : <FileTypeMark path={node.path} />}
                  </span>
                  <span className={`min-w-0 flex-1 truncate text-[10.5px] ${paperSummary ? 'font-medium tracking-[-0.01em] text-ink' : 'font-mono'}`} data-path={node.path}>{label}</span>
                  {isFolder ? (
                    <span className="ml-2 shrink-0 font-mono text-[9px] tabular-nums text-ink-faint">{node.descendantFileCount}</span>
                  ) : (
                    <span className="ml-2 flex shrink-0 items-center gap-1.5">
                      {managedReference(node.path) && <ManagedReferenceMark />}
                      {isUpdating && <span className="relative flex h-1.5 w-1.5" aria-hidden="true"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/45 motion-reduce:animate-none" /><span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" /></span>}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}

function SearchResult({ artifact, active, paperSummary, onSelect }: {
  artifact: WorkspaceArtifact
  active: boolean
  paperSummary?: LiteraturePaperSummary
  onSelect: (path: string) => void
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      aria-label={`${artifact.label || artifact.path.split('/').at(-1) || artifact.path}，${paperSummary?.title ?? artifact.path}`}
      onClick={() => onSelect(artifact.path)}
      className={`group flex w-full min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-ctrl px-2 py-1.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 ${active ? 'bg-primary/10 text-primary' : 'text-ink-secondary hover:bg-white/45 hover:text-ink'}`}
    >
      <FileTypeMark path={artifact.path} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[10.5px] font-medium">{artifact.label || artifact.path.split('/').at(-1)}</span>
        <span className={`block truncate text-[9px] text-ink-faint ${paperSummary ? 'font-medium' : 'font-mono'}`}>
          {(paperSummary?.title ?? artifact.path.split('/').slice(0, -1).join('/')) || 'Workspace'}
        </span>
      </span>
    </button>
  )
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg className={`h-3 w-3 transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="m6 3.5 4 4.5-4 4.5" />
    </svg>
  )
}

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg className={`h-4 w-4 ${open ? 'text-primary/75' : 'text-ink-faint'}`} fill="none" viewBox="0 0 20 20" stroke="currentColor" strokeWidth={1.35} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.75 5.75A1.75 1.75 0 0 1 4.5 4h3.1c.47 0 .92.19 1.25.52l.68.68c.33.33.78.52 1.25.52h4.72a1.75 1.75 0 0 1 1.75 1.75v6.78A1.75 1.75 0 0 1 15.5 16h-11a1.75 1.75 0 0 1-1.75-1.75v-8.5Z" />
    </svg>
  )
}

function FileTypeMark({ path }: { path: string }) {
  const badge = extensionBadge(path)
  return <span aria-hidden="true" className={`w-5 shrink-0 text-center font-mono text-[7.5px] font-bold tracking-[-0.04em] ${badge.tone}`}>{badge.label}</span>
}

function ManagedReferenceMark() {
  return (
    <svg className="h-2.5 w-2.5 text-ink-faint" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.4} aria-hidden="true">
      <path strokeLinecap="round" d="M6.1 5.2 8.7 2.6a2.35 2.35 0 0 1 3.3 3.3L9.8 8.1M9.9 10.8l-2.6 2.6A2.35 2.35 0 1 1 4 10.1l2.2-2.2M5.9 10.1l4.2-4.2" />
    </svg>
  )
}
