'use client'

import { useEffect, useMemo, useState } from 'react'

interface ModelOption {
  id: string
  name: string
  description?: string
  provider?: string
}

interface ModelPickerModalProps {
  open: boolean
  models: ModelOption[]
  isLoading: boolean
  selectedId: string
  onSelect: (id: string) => void
  onClose: () => void
}

// Outer gate: only mount the implementation when open=true. This makes state
// (query, scroll position, etc.) reset automatically on each open via React's
// natural mount/unmount lifecycle — no effect needed to "sync" derived state.
export function ModelPickerModal(props: ModelPickerModalProps) {
  if (!props.open) return null
  return <ModelPickerModalImpl {...props} />
}

function ModelPickerModalImpl({
  models,
  isLoading,
  selectedId,
  onSelect,
  onClose,
}: ModelPickerModalProps) {
  const [query, setQuery] = useState('')

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return models
    return models.filter(m =>
      m.name.toLowerCase().includes(q) ||
      m.id.toLowerCase().includes(q) ||
      (m.description?.toLowerCase().includes(q) ?? false),
    )
  }, [models, query])

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-10 bg-ink/20 backdrop-blur-xl"
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="w-full max-w-lg max-h-[85vh] flex flex-col rounded-glass bg-[var(--glass-panel-bg)] backdrop-blur-[24px] backdrop-saturate-150 border border-[var(--glass-panel-border)] shadow-[var(--shadow-glass)]"
        style={{ boxShadow: '0 25px 50px -12px rgba(16,18,24,0.25)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-outline-variant/15">
          <span className="text-sm font-semibold text-ink">选择模型</span>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-ctrl flex items-center justify-center text-ink-muted hover:text-ink hover:bg-surface-low transition-colors"
            aria-label="关闭"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Search */}
        <div className="px-5 pt-3 pb-2">
          <input
            autoFocus
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索模型..."
            className="w-full rounded-card bg-surface-low px-3 py-2 text-sm text-ink placeholder-ink-muted focus:bg-surface-lowest focus:outline-none ghost-border transition-all"
          />
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-2 pb-3">
          {isLoading ? (
            <div className="px-3 py-8 text-center text-sm text-ink-muted">加载中...</div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-ink-muted">没有匹配的模型</div>
          ) : (
            filtered.map(m => {
              const isSelected = m.id === selectedId
              return (
                <button
                  key={m.id}
                  onClick={() => { onSelect(m.id); onClose() }}
                  className={`w-full flex items-start justify-between gap-3 px-3 py-2.5 rounded-card text-left transition-colors ${
                    isSelected
                      ? 'bg-[var(--primary-tint-weak)] text-ink'
                      : 'text-ink-secondary hover:bg-surface-low hover:text-ink'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className={`text-sm truncate ${isSelected ? 'font-semibold' : ''}`}>
                      {m.name}
                    </div>
                    {m.description && (
                      <div className="text-xs text-ink-muted truncate mt-0.5">
                        {m.description}
                      </div>
                    )}
                  </div>
                  <div className="flex-shrink-0 flex items-center gap-2">
                    {m.provider && (
                      <span className="text-[0.65rem] uppercase tracking-wider text-ink-muted">
                        {m.provider}
                      </span>
                    )}
                    {isSelected && (
                      <svg className="w-4 h-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                    )}
                  </div>
                </button>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
