'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useChatContext } from '@/contexts/ChatContext'

const SPATIAL_TOOLS = new Set([
  'GenerateImage',
  'CreateObject3D',
  'CreateWorld3D',
  'GetSpatialJob',
  'WaitSpatialJob',
  'InspectSpatialArtifact',
])

const ACTIVE = new Set(['prepared', 'submitting', 'submitted', 'running', 'materializing'])

type SpatialEnvelope = {
  schema_version?: number
  job_id?: string
  artifact_id?: string
  kind?: 'image' | 'object3d' | 'world3d' | string
  status?: string
  provider?: string
  workspace_paths?: string[]
  message?: string
  error?: string
  elapsed_ms?: number
  relations?: Array<{
    kind: 'derived_from' | 'revision_of' | 'conditioned_by' | 'compared_with' | string
    artifact_id: string
  }>
  metadata?: Record<string, string | number | boolean | null>
  created_at?: string
  updated_at?: string
}

function parseEnvelope(value: string | undefined): SpatialEnvelope | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    const nested = record.job && typeof record.job === 'object' && !Array.isArray(record.job)
      ? record.job as Record<string, unknown>
      : record
    return nested as SpatialEnvelope
  } catch {
    return null
  }
}

function kindLabel(kind: string | undefined, tool: string): string {
  if (kind === 'image' || tool === 'GenerateImage') return '图像生成'
  if (kind === 'object' || kind === 'object3d' || tool === 'CreateObject3D') return '3D 物体'
  if (kind === 'world' || kind === 'world3d' || tool === 'CreateWorld3D') return '空间世界'
  return '空间任务'
}

function statusLabel(status: string | undefined): string {
  switch (status) {
    case 'prepared': return '已准备'
    case 'submitting': return '正在提交'
    case 'submitted': return '已提交'
    case 'running': return '供应商处理中'
    case 'materializing': return '正在保存资产'
    case 'published': return '已发布'
    case 'unknown': return '结果未知'
    case 'failed': return '失败'
    case 'cancelled': return '已取消'
    default: return status || '状态待同步'
  }
}

function statusTone(status: string | undefined): string {
  if (status === 'published') return 'border-success/20 bg-success/10 text-success'
  if (status === 'failed' || status === 'unknown') return 'border-warning/20 bg-warning/10 text-warning'
  if (status === 'cancelled') return 'border-outline-variant/20 bg-surface-low text-ink-faint'
  return 'border-primary/20 bg-primary/10 text-primary'
}

function elapsed(value: number | undefined): string | null {
  if (!Number.isFinite(value) || (value ?? 0) < 0) return null
  const seconds = Math.round((value ?? 0) / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function relationLabel(kind: string): string {
  switch (kind) {
    case 'derived_from': return '派生自'
    case 'revision_of': return '修订自'
    case 'conditioned_by': return '参考资产'
    case 'compared_with': return '对比资产'
    default: return kind
  }
}

export function isSpatialTool(tool: string): boolean {
  return SPATIAL_TOOLS.has(tool)
}

export function SpatialJobCard({ tool, content, pending, isError }: {
  tool: string
  content?: string
  pending?: boolean
  isError?: boolean
}) {
  const initial = useMemo(() => parseEnvelope(content), [content])
  const [job, setJob] = useState<SpatialEnvelope | null>(initial)
  const refreshedRef = useRef<string | null>(null)
  const {
    conversationId,
    refreshWorkspaceArtifacts,
    setActiveArtifactPath,
    setSidebarCollapsed,
    setSidebarView,
  } = useChatContext()

  useEffect(() => setJob(initial), [initial])

  useEffect(() => {
    const jobId = job?.job_id
    if (!conversationId || !jobId || !ACTIVE.has(job.status ?? '')) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | null = null

    const poll = async () => {
      try {
        const response = await fetch(
          `/api/conversations/${encodeURIComponent(conversationId)}/spatial/jobs/${encodeURIComponent(jobId)}`,
          { cache: 'no-store', signal: controller.signal },
        )
        if (response.ok) {
          const payload = await response.json() as unknown
          const next = payload && typeof payload === 'object' && !Array.isArray(payload)
            ? ((payload as { job?: SpatialEnvelope }).job ?? payload as SpatialEnvelope)
            : null
          if (next) {
            setJob(next)
            if (next.status === 'published' && refreshedRef.current !== jobId) {
              refreshedRef.current = jobId
              void refreshWorkspaceArtifacts(conversationId)
            }
          }
        }
      } catch {
        // A transient status read must not mutate the durable Job presentation.
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2_000)
    }

    timer = setTimeout(poll, 1_000)
    return () => {
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [conversationId, job?.job_id, job?.status, refreshWorkspaceArtifacts])

  if (!isSpatialTool(tool)) return null
  if (!job) {
    if (!pending && !isError) return null
    return (
      <div className="mx-3 mb-3 rounded-md border border-ghost-border/20 bg-surface-lowest px-3 py-3 text-[11px] text-ink-muted shadow-sm">
        {isError ? '空间任务未能建立持久记录。' : '正在建立持久空间任务…'}
      </div>
    )
  }

  const workspacePaths = Array.isArray(job.workspace_paths)
    ? job.workspace_paths.filter(path => typeof path === 'string' && path.length > 0)
    : []
  const duration = elapsed(job.elapsed_ms)
  const relations = Array.isArray(job.relations)
    ? job.relations.filter(relation => (
        relation
        && typeof relation.kind === 'string'
        && typeof relation.artifact_id === 'string'
        && relation.artifact_id.length > 0
      )).slice(0, 6)
    : []

  return (
    <section className="mx-3 mb-3 overflow-hidden rounded-md border border-ghost-border/20 bg-surface-lowest text-ink shadow-[0_14px_40px_rgba(38,49,72,.10)]">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ghost-border/20 px-3.5 py-3">
        <div className="min-w-0">
          <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-primary">{kindLabel(job.kind, tool)}</p>
          <p className="mt-1 truncate font-mono text-[10px] text-ink-faint" title={job.job_id}>JOB {job.job_id ?? '—'}</p>
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-[9px] font-semibold ${statusTone(job.status)}`}>
          {statusLabel(job.status)}
        </span>
      </div>
      <div className="grid gap-px bg-ghost-border/20 sm:grid-cols-3">
        <div className="bg-surface-lowest px-3.5 py-2.5">
          <p className="font-mono text-[8px] uppercase tracking-[0.16em] text-ink-faint">供应商</p>
          <p className="mt-1 text-[10px] text-ink-secondary">{job.provider || '—'}</p>
        </div>
        <div className="bg-surface-lowest px-3.5 py-2.5">
          <p className="font-mono text-[8px] uppercase tracking-[0.16em] text-ink-faint">资产</p>
          <p className="mt-1 truncate font-mono text-[10px] text-ink-secondary" title={job.artifact_id}>{job.artifact_id || '待生成'}</p>
        </div>
        <div className="bg-surface-lowest px-3.5 py-2.5">
          <p className="font-mono text-[8px] uppercase tracking-[0.16em] text-ink-faint">耗时</p>
          <p className="mt-1 text-[10px] text-ink-secondary">{duration || '—'}</p>
        </div>
      </div>
      {(job.message || job.error || workspacePaths.length > 0 || relations.length > 0) && (
        <div className="px-3.5 py-3">
          {(job.error || job.message) && (
            <p className={`text-[10px] leading-5 ${job.error ? 'text-warning' : 'text-ink-muted'}`}>
              {(job.error || job.message)?.slice(0, 320)}
            </p>
          )}
          {workspacePaths.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {workspacePaths.slice(0, 5).map(path => (
                <button
                  key={path}
                  type="button"
                  onClick={() => {
                    setActiveArtifactPath(path)
                    setSidebarView('files')
                    setSidebarCollapsed(false)
                  }}
                  className="max-w-full truncate rounded border border-ghost-border/20 bg-surface-low px-2 py-1.5 font-mono text-[9px] text-ink-muted transition hover:border-primary/40 hover:text-ink"
                  title={path}
                >
                  {path.split('/').at(-1)}
                </button>
              ))}
            </div>
          )}
          {relations.length > 0 && (
            <div className="mt-2.5 border-t border-ghost-border/20 pt-2.5">
              <p className="mb-1.5 font-mono text-[8px] uppercase tracking-[0.16em] text-ink-faint">来源关系</p>
              <div className="flex flex-wrap gap-1.5">
                {relations.map(relation => (
                  <span
                    key={`${relation.kind}:${relation.artifact_id}`}
                    className="max-w-full truncate rounded border border-primary/15 bg-primary/[0.06] px-2 py-1 font-mono text-[9px] text-primary/70"
                    title={`${relationLabel(relation.kind)} ${relation.artifact_id}`}
                  >
                    {relationLabel(relation.kind)} · {relation.artifact_id}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
