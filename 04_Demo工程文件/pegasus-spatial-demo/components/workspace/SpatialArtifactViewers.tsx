'use client'

import { createElement, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import type { WorkspaceArtifact } from '@/hooks/useWorkspaceArtifacts'
import { ProgressiveImage } from '@/components/media/ProgressiveImage'
import { isInternalWorkspacePath, normalizeWorkspacePath } from '@/lib/workspace/path-policy'

function fileUrl(conversationId: string, artifact: WorkspaceArtifact, extra = ''): string {
  const revision = artifact.sha256
    || artifact.assetId
    || artifact.updatedAt
    || (artifact.revision !== undefined ? String(artifact.revision) : '')
  const version = revision ? `&v=${encodeURIComponent(revision)}` : ''
  return `/api/conversations/${encodeURIComponent(conversationId)}/files/binary?path=${encodeURIComponent(artifact.path)}${version}${extra}`
}

export function SpatialImageViewer({ artifact, conversationId }: {
  artifact: WorkspaceArtifact
  conversationId: string
}) {
  const [fullscreen, setFullscreen] = useState(false)
  const [resolvedAspectRatio, setResolvedAspectRatio] = useState<string | null>(() => (
    artifact.width && artifact.height ? `${artifact.width} / ${artifact.height}` : null
  ))
  const imageTriggerRef = useRef<HTMLButtonElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const src = fileUrl(conversationId, artifact, '&w=1600&inline=1')
  const aspectRatio = resolvedAspectRatio ?? '16 / 10'

  useEffect(() => {
    if (!fullscreen) return
    const previousOverflow = document.body.style.overflow
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : imageTriggerRef.current
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFullscreen(false)
      if (event.key === 'Tab') { event.preventDefault(); closeButtonRef.current?.focus() }
    }
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', handleKeyDown)
    window.requestAnimationFrame(() => closeButtonRef.current?.focus())
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleKeyDown)
      previouslyFocused?.focus()
    }
  }, [fullscreen])

  return (
    <>
      <section className="relative flex h-full min-h-0 items-center justify-center overflow-hidden px-5 py-16 sm:px-8 sm:py-20" data-workspace-content="unframed">
        <div className="absolute right-3 top-3 z-20 flex items-center gap-2 sm:right-4 sm:top-4">
          <button type="button" onClick={() => setFullscreen(true)} aria-label="全屏展示图片" title="全屏展示" className="pmo-viewer-tool">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 3.75h-4.5v4.5m12-4.5h4.5v4.5m0 7.5v4.5h-4.5m-7.5 0h-4.5v-4.5" /></svg>
          </button>
          <a href={fileUrl(conversationId, artifact, '&download=1')} download aria-label="下载原图" title="下载原图" className="pmo-viewer-tool">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M12 3.75v10.5m0 0 4-4m-4 4-4-4M5.25 15.75v2.5a2 2 0 0 0 2 2h9.5a2 2 0 0 0 2-2v-2.5" /></svg>
          </a>
        </div>
        <div className="relative mx-auto max-h-[min(100%,48rem)] w-full max-w-5xl" style={{ aspectRatio }}>
          <button ref={imageTriggerRef} type="button" onClick={() => setFullscreen(true)} aria-label={`全屏展示图片：${artifact.label}`} title="点击全屏展示" className="group block h-full w-full cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/70">
            <ProgressiveImage
              src={src}
              alt={artifact.label}
              frameClassName="pmo-progressive-image--unframed pointer-events-none h-full w-full"
              imageClassName="h-full w-full object-contain transition-transform duration-300 group-hover:scale-[1.006]"
              onLoad={event => {
                const { naturalWidth, naturalHeight } = event.currentTarget
                if (naturalWidth > 0 && naturalHeight > 0) setResolvedAspectRatio(`${naturalWidth} / ${naturalHeight}`)
              }}
            />
          </button>
        </div>
      </section>

      {fullscreen && typeof document !== 'undefined' && createPortal(
        <div role="dialog" aria-modal="true" aria-label={`全屏图片：${artifact.label}`} className="pmo-viewer-fullscreen" onMouseDown={event => { if (event.currentTarget === event.target) setFullscreen(false) }}>
          <button ref={closeButtonRef} type="button" onClick={() => setFullscreen(false)} aria-label="退出图片全屏展示" title="退出全屏" className="pmo-viewer-close">×</button>
          <div className="h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] sm:h-[calc(100vh-3rem)] sm:w-[calc(100vw-3rem)]">
            <ProgressiveImage src={src} alt={artifact.label} frameClassName="h-full w-full" imageClassName="h-full w-full object-contain" />
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

export function SpatialModelViewer({ artifact, conversationId }: {
  artifact: WorkspaceArtifact
  conversationId: string
}) {
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const fullscreenTriggerRef = useRef<HTMLButtonElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const src = fileUrl(conversationId, artifact)

  useEffect(() => {
    let mounted = true
    void import('@google/model-viewer')
      .then(() => { if (mounted) setReady(true) })
      .catch(() => { if (mounted) setFailed(true) })
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    if (!fullscreen) return
    const previousOverflow = document.body.style.overflow
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : fullscreenTriggerRef.current
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFullscreen(false)
      if (event.key === 'Tab') { event.preventDefault(); closeButtonRef.current?.focus() }
    }
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', handleKeyDown)
    window.requestAnimationFrame(() => closeButtonRef.current?.focus())
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleKeyDown)
      previouslyFocused?.focus()
    }
  }, [fullscreen])

  const model = ready ? createElement('model-viewer', {
    src,
    alt: artifact.label,
    'camera-controls': true,
    'auto-rotate': true,
    'rotation-per-second': '12deg',
    'shadow-intensity': '0.45',
    'environment-image': 'neutral',
    'interaction-prompt': 'auto',
    style: { width: '100%', height: '100%', minHeight: '420px', background: 'transparent' },
  }) : (
    <div className="flex h-full min-h-[420px] w-full items-center justify-center text-center">
      <div>
        <span className={`mx-auto block h-8 w-8 rounded-full border-2 ${failed ? 'border-red-400/70' : 'animate-spin border-black/10 border-t-primary'}`} />
        <p className="mt-4 text-xs text-ink-muted">{failed ? '3D 查看器加载失败，请下载 GLB 查看' : '正在初始化 3D 查看器…'}</p>
      </div>
    </div>
  )

  return (
    <>
      <section className="relative flex h-full min-h-0 items-center justify-center overflow-hidden px-5 py-16 text-ink sm:px-8 sm:py-20" data-workspace-content="unframed">
        <div className="absolute right-3 top-3 z-20 flex items-center gap-2 sm:right-4 sm:top-4">
          <button ref={fullscreenTriggerRef} type="button" onClick={() => setFullscreen(true)} aria-label="全屏展示3D模型" title="全屏展示" className="pmo-viewer-tool">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 3.75h-4.5v4.5m12-4.5h4.5v4.5m0 7.5v4.5h-4.5m-7.5 0h-4.5v-4.5" /></svg>
          </button>
          <a href={fileUrl(conversationId, artifact, '&download=1')} download aria-label="下载3D模型" title="下载 GLB" className="pmo-viewer-tool">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M12 3.75v10.5m0 0 4-4m-4 4-4-4M5.25 15.75v2.5a2 2 0 0 0 2 2h9.5a2 2 0 0 0 2-2v-2.5" /></svg>
          </a>
        </div>
        <div className="relative mx-auto h-full max-h-[min(100%,48rem)] w-full max-w-5xl">
          {!fullscreen && model}
        </div>
      </section>

      {fullscreen && typeof document !== 'undefined' && createPortal(
        <div role="dialog" aria-modal="true" aria-label={`全屏3D模型：${artifact.label}`} className="pmo-viewer-fullscreen" onMouseDown={event => { if (event.currentTarget === event.target) setFullscreen(false) }}>
          <button ref={closeButtonRef} type="button" onClick={() => setFullscreen(false)} aria-label="退出3D模型全屏展示" title="退出全屏" className="pmo-viewer-close">×</button>
          <div className="h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] sm:h-[calc(100vh-3rem)] sm:w-[calc(100vw-3rem)]">{model}</div>
        </div>,
        document.body,
      )}
    </>
  )
}

type WorldManifest = {
  title?: string
  status?: string
  provider?: string
  world_id?: string
  provider_task_id?: string
  viewer_url?: string
  preview_path?: string
  source_image_path?: string
  created_at?: string
  updated_at?: string
  up_axis?: string
  relations?: Array<{
    kind?: string
    artifact_id?: string
  }>
  assets?: Array<{
    key?: string
    kind?: string
    path?: string
    mime_type?: string
    size_bytes?: number
    sha256?: string
  }>
}

function safeManifest(content: string): WorldManifest | null {
  try {
    const value = JSON.parse(content) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? value as WorldManifest : null
  } catch {
    return null
  }
}

function safeHttpUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

function worldStatusLabel(status: string): string {
  switch (status.toLowerCase()) {
    case 'succeeded': return '已成功'
    case 'published': return '已发布'
    case 'running': return '生成中'
    case 'materializing': return '正在保存资产'
    case 'failed': return '失败'
    case 'unknown': return '结果未知'
    default: return status
  }
}

function worldRelationLabel(kind: string | undefined): string {
  switch (kind) {
    case 'derived_from': return '派生自'
    case 'revision_of': return '修订自'
    case 'conditioned_by': return '参考资产'
    case 'compared_with': return '对比资产'
    default: return kind || '来源'
  }
}

const WORLD_COVER_EXTENSION = /\.(?:png|jpe?g|webp|gif)$/i

function safeWorldCoverPath(value: string | undefined): string | null {
  if (!value) return null
  try {
    const normalized = normalizeWorkspacePath(value)
    return !isInternalWorkspacePath(normalized) && WORLD_COVER_EXTENSION.test(normalized)
      ? normalized
      : null
  } catch {
    return null
  }
}

export function worldCoverPaths(manifest: WorldManifest | null): string[] {
  if (!manifest) return []
  const candidates = [
    manifest.preview_path,
    ...(manifest.assets ?? [])
      .filter(asset => asset.kind === 'thumbnail' || asset.kind === 'image' || asset.mime_type?.startsWith('image/'))
      .map(asset => asset.path),
    manifest.source_image_path,
  ]
  return [...new Set(candidates.flatMap(candidate => {
    const safe = safeWorldCoverPath(candidate)
    return safe ? [safe] : []
  }))]
}

export function SpatialWorldViewer({ artifact, conversationId, content }: {
  artifact: WorkspaceArtifact
  conversationId: string
  content: string
}) {
  const manifest = useMemo(() => safeManifest(content), [content])
  const coverPaths = useMemo(() => worldCoverPaths(manifest), [manifest])
  const [coverIndex, setCoverIndex] = useState(0)
  useEffect(() => { setCoverIndex(0) }, [content])
  const coverPath = coverPaths[coverIndex] ?? null
  const coverSrc = coverPath
    ? `/api/conversations/${encodeURIComponent(conversationId)}/files/binary?path=${encodeURIComponent(coverPath)}&w=1920&inline=1`
    : null
  const viewerUrl = safeHttpUrl(manifest?.viewer_url)
  const status = manifest?.status ?? 'published'
  const relations = Array.isArray(manifest?.relations)
    ? manifest.relations.filter(relation => relation?.kind && relation?.artifact_id).slice(0, 8)
    : []
  const assets = Array.isArray(manifest?.assets) ? manifest.assets : []

  return (
    <section className="relative h-full min-h-[420px] overflow-hidden bg-[#dfe3eb] text-[#f4f7ff] [container-type:inline-size]">
      {coverSrc ? (
        <ProgressiveImage
          src={coverSrc}
          alt={`${manifest?.title ?? artifact.label} 空间封面`}
          fit="cover"
          frameClassName="absolute inset-0 block h-full w-full"
          imageClassName="h-full w-full object-cover"
          onError={() => setCoverIndex(index => index + 1)}
        />
      ) : (
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_22%,rgba(93,119,173,.22),transparent_28%),linear-gradient(135deg,#68748b,#2f3747)]" />
      )}
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(18,22,19,.48),transparent_30%,transparent_58%,rgba(18,22,19,.82))]" />

      <div className="absolute left-5 top-5 flex items-center gap-2 rounded-md border border-white/20 bg-black/25 px-3 py-2 backdrop-blur-md">
        <span className="h-1.5 w-1.5 rounded-full bg-[#9ed1ac] shadow-[0_0_0_4px_rgba(158,209,172,.16)]" />
        <span className="text-[10px] font-semibold tracking-[0.08em]">空间世界 · {worldStatusLabel(status)}</span>
      </div>

      <div className="absolute right-5 top-5 flex gap-2">
        {viewerUrl && <a href={viewerUrl} target="_blank" rel="noreferrer" className="rounded-md border border-white/25 bg-black/25 px-3 py-2 text-[10px] font-semibold text-white backdrop-blur-md transition hover:bg-black/40">Aholo ↗</a>}
        <Link href={`/spatial/${encodeURIComponent(conversationId)}`} target="_blank" rel="noreferrer" className="rounded-md bg-primary px-4 py-2 text-[10px] font-bold text-white shadow-lg transition hover:bg-[var(--primary-deep)]">
          进入空间舞台
        </Link>
      </div>

      <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-6 p-5 sm:p-7">
        <div className="min-w-0 max-w-2xl">
          <p className="text-[10px] font-medium text-white/65">{coverPath === manifest?.source_image_path ? '创作参考图封面' : '空间封面'}</p>
          <h2 className="mt-1 truncate font-serif text-2xl font-semibold tracking-[-0.025em] sm:text-3xl">{manifest?.title ?? artifact.label}</h2>
          <p className="mt-2 truncate text-[10px] text-white/65">
            {[manifest?.provider ?? 'Aholo', manifest?.world_id ? `世界 ${manifest.world_id}` : null, manifest?.up_axis ? `${manifest.up_axis}-up` : null, `${assets.length} 个发布资产`].filter(Boolean).join(' · ')}
          </p>
        </div>
        {(assets.length > 0 || relations.length > 0) && <details className="group relative shrink-0 text-right">
          <summary className="cursor-pointer list-none rounded-md border border-white/20 bg-black/25 px-3 py-2 text-[10px] font-semibold backdrop-blur-md">构建信息</summary>
          <div className="absolute bottom-11 right-0 w-72 rounded-lg border border-white/20 bg-[#252a26]/95 p-3 text-left shadow-2xl backdrop-blur-xl">
            <p className="text-[9px] font-semibold text-white/55">{assets.length} 个资产 · {relations.length} 条来源关系</p>
            <div className="mt-2 max-h-40 space-y-1 overflow-auto">
              {assets.slice(0, 5).map((item, index) => <p key={`${item.path}:${index}`} className="truncate text-[9px] text-white/75" title={item.path}>{item.path ?? item.key ?? `资产 ${index + 1}`}</p>)}
              {relations.slice(0, 3).map((relation, index) => <p key={`${relation.kind}:${index}`} className="truncate text-[9px] text-[#bdcbed]">{worldRelationLabel(relation.kind)} · {relation.artifact_id}</p>)}
            </div>
          </div>
        </details>}
      </div>
    </section>
  )
}
