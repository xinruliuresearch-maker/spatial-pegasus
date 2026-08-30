'use client'

import { useEffect, useRef, useState } from 'react'
import type { ProjectSummary } from '@/hooks/useProjects'

interface ProjectCardProps {
  project: ProjectSummary
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => Promise<boolean> | void
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

export function ProjectCard({ project, onSelect, onDelete, onRename }: ProjectCardProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (editing) inputRef.current?.focus() }, [editing])
  const value = draft ?? project.title
  const commit = () => {
    const next = value.trim()
    if (next && next !== project.title) void onRename(project.conversation_id, next)
    setDraft(null)
    setEditing(false)
  }

  return (
    <article onClick={() => { if (!editing) onSelect(project.conversation_id) }} className="group relative min-h-48 cursor-pointer rounded-2xl border border-[var(--glass-panel-border)] bg-[var(--glass-panel-bg)] p-5 shadow-[var(--shadow-glass)] transition hover:-translate-y-0.5 hover:shadow-[var(--shadow-hover)]">
      <div className="mb-8 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" stroke="currentColor" strokeWidth="1.7"><path d="M5 4.5h10.5A2.5 2.5 0 0 1 18 7v12.5H7.5A2.5 2.5 0 0 1 5 17V4.5Z"/><path d="M8 8h7M8 11.5h7M8 15h4" strokeLinecap="round"/></svg>
      </div>
      {editing ? (
        <input ref={inputRef} value={value} maxLength={200} onChange={event => setDraft(event.target.value)} onClick={event => event.stopPropagation()} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') commit(); if (event.key === 'Escape') setEditing(false) }} className="mb-2 w-full rounded-lg bg-surface-low px-2 py-1 text-sm font-semibold text-ink outline-none" />
      ) : (
        <h3 onDoubleClick={event => { event.stopPropagation(); setEditing(true) }} className="mb-2 line-clamp-2 text-sm font-semibold leading-5 text-ink">{project.title}</h3>
      )}
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-muted">
        {project.settings?.research_domain && <span className="max-w-full truncate rounded-full bg-primary/8 px-2 py-1 text-primary">{project.settings.research_domain}</span>}
        <span>{formatDate(project.updated_at)}</span>
      </div>
      {!editing && (
        <div className="absolute right-3 top-3 flex gap-1 opacity-0 transition group-hover:opacity-100">
          <button type="button" title="重命名" onClick={event => { event.stopPropagation(); setEditing(true) }} className="rounded-lg bg-surface-lowest/90 px-2 py-1 text-xs text-ink-muted hover:text-ink">改名</button>
          <button type="button" title="删除" onClick={event => { event.stopPropagation(); onDelete(project.conversation_id) }} className="rounded-lg bg-surface-lowest/90 px-2 py-1 text-xs text-ink-muted hover:text-error">删除</button>
        </div>
      )}
    </article>
  )
}
