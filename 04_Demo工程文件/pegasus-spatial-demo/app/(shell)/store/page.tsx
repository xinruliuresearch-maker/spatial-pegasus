'use client'

import { FormEvent, useMemo, useState } from 'react'
import { ShimmerBlock } from '@/components/loading/Skeleton'
import { MemoryHero } from '@/components/store/MemoryHero'
import {
  useMemoryV2,
  type MemoryCandidate,
  type MemoryHistoryEvent,
  type MemoryPreference,
} from '@/hooks/useMemoryV2'

type Section = 'profile' | 'history' | 'candidates'

const categoryLabels: Record<string, string> = {
  communication: '沟通方式',
  workflow: '工作习惯',
  output: '交付偏好',
  design: '设计偏好',
  technical: '技术习惯',
  general: '一般偏好',
}

const polarityLabels: Record<MemoryPreference['polarity'], string> = {
  positive: '偏好',
  negative: '避免',
  neutral: '说明',
}

const candidateLabels: Record<MemoryCandidate['status'], string> = {
  pending: '仍在观察',
  claimed: '正在整理',
  promoted: '已进入画像',
  ignored: '已放下',
  conflict: '需要确认',
  quota_blocked: '空间已满',
  legacy_review: '来自旧记忆',
}

const visibleCandidateStatuses = new Set<MemoryCandidate['status']>([
  'pending',
  'claimed',
  'conflict',
  'quota_blocked',
  'legacy_review',
])

const formatDate = (value?: string) => value
  ? new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value))
  : '—'

type IconName = 'profile' | 'history' | 'candidate' | 'search' | 'plus'
  | 'close' | 'edit' | 'trash' | 'chevron' | 'check'

function Icon({ name, className = 'h-5 w-5' }: { name: IconName; className?: string }) {
  const paths = {
    profile: <><circle cx="12" cy="8" r="3.2" /><path d="M5.5 19c.7-3.5 2.9-5.4 6.5-5.4s5.8 1.9 6.5 5.4" /></>,
    history: <><path d="M4 6.5h16v13H4z" /><path d="M7 3.5v6m10-6v6M4 10h16" /></>,
    candidate: <><circle cx="12" cy="12" r="2.2" /><circle cx="5.5" cy="7" r="1.4" /><circle cx="18.5" cy="6" r="1.4" /><circle cx="17.5" cy="18" r="1.4" /><path d="m6.7 7.9 3.5 2.7m3.7-.2 3.3-3.1m-3.6 6.2 2.8 3.2" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 5 5" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    edit: <><path d="m4 20 4.2-1 10.4-10.4-3.2-3.2L5 15.8 4 20Z" /><path d="m13.8 7 3.2 3.2" /></>,
    trash: <><path d="M5 7h14M9 7V4h6v3m2 0-1 13H8L7 7" /></>,
    chevron: <path d="m8 10 4 4 4-4" />,
    check: <path d="m5 12 4.2 4.2L19 6.5" />,
  }

  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {paths[name]}
    </svg>
  )
}

function PreferenceEditor({ initial, onSave, onClose }: {
  initial?: MemoryPreference
  onSave: (value: Pick<MemoryPreference, 'category' | 'subject' | 'statement' | 'scope' | 'polarity'>) => Promise<void>
  onClose: () => void
}) {
  const [category, setCategory] = useState(initial?.category || 'general')
  const [subject, setSubject] = useState(initial?.subject || '')
  const [statement, setStatement] = useState(initial?.statement || '')
  const [scope, setScope] = useState(initial?.scope || 'general')
  const [polarity, setPolarity] = useState<MemoryPreference['polarity']>(initial?.polarity || 'neutral')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!subject.trim() || !statement.trim()) return
    setSaving(true)
    setError('')
    try {
      await onSave({ category, subject, statement, scope, polarity })
      onClose()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const fieldClass = 'mt-2 w-full rounded-card bg-surface-low px-4 py-3 text-body-sm text-ink ghost-border pmo-field-focus transition-all placeholder:text-ink-faint'

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/10 p-4 backdrop-blur-[5px]"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}
    >
      <form
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="memory-preference-editor-title"
        className="pmo-memory-dialog max-h-[calc(100vh-32px)] w-full max-w-2xl overflow-y-auto rounded-glass bg-[var(--glass-panel-bg)] p-6 backdrop-blur-[24px] backdrop-saturate-150 border border-[var(--glass-panel-border)] shadow-[var(--shadow-glass)] sm:p-8"
      >
        <div className="mb-7 flex items-start justify-between gap-5">
          <div>
            <p className="text-label text-primary">长期画像</p>
            <h2 id="memory-preference-editor-title" className="mt-1 text-heading font-semibold text-ink">
              {initial ? '调整一条记忆' : '告诉 Pegasus Spatial 一件值得长期记住的事'}
            </h2>
            <p className="mt-2 max-w-lg text-caption text-ink-muted">
              只保存能跨任务稳定成立的偏好；单次项目的临时风格更适合留在当前对话。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-ctrl p-2 text-ink-muted transition-colors hover:bg-surface-low hover:text-ink"
            aria-label="关闭"
          >
            <Icon name="close" />
          </button>
        </div>

        <fieldset>
          <legend className="text-label text-ink-secondary">它主要影响什么</legend>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {Object.entries(categoryLabels).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={category === value}
                onClick={() => setCategory(value)}
                className={`rounded-ctrl px-3 py-2.5 text-body-sm transition-all ${
                  category === value
                    ? 'bg-primary text-on-primary shadow-sm'
                    : 'bg-surface-low text-ink-secondary ghost-border hover:bg-surface-mid hover:text-ink'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2">
          <label className="text-label text-ink-secondary sm:col-span-2">
            记忆主题
            <input
              value={subject}
              onChange={event => setSubject(event.target.value)}
              className={fieldClass}
              placeholder="例如：解释复杂机制时"
            />
          </label>
          <label className="text-label text-ink-secondary sm:col-span-2">
            希望 Pegasus Spatial 记住什么
            <textarea
              value={statement}
              onChange={event => setStatement(event.target.value)}
              rows={4}
              className={`${fieldClass} resize-none`}
              placeholder="例如：先把因果关系讲清楚，再讨论术语和实现细节"
            />
          </label>
          <label className="text-label text-ink-secondary">
            适用场景
            <input
              value={scope}
              onChange={event => setScope(event.target.value)}
              className={fieldClass}
              placeholder="全部任务 / 写作 / 设计"
            />
          </label>
          <fieldset>
            <legend className="text-label text-ink-secondary">表达方式</legend>
            <div className="mt-2 grid grid-cols-3 rounded-card bg-surface-low p-1 ghost-border">
              {(['positive', 'negative', 'neutral'] as const).map(value => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={polarity === value}
                  onClick={() => setPolarity(value)}
                  className={`rounded-ctrl px-2 py-2 text-caption transition-all ${
                    polarity === value
                      ? 'bg-surface-lowest font-semibold text-ink shadow-[var(--shadow-ambient)]'
                      : 'text-ink-muted hover:text-ink'
                  }`}
                >
                  {polarityLabels[value]}
                </button>
              ))}
            </div>
          </fieldset>
        </div>

        {error && (
          <p className="mt-4 rounded-ctrl bg-error/5 px-3 py-2 text-caption text-error">{error}</p>
        )}

        <div className="mt-8 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-ctrl px-4 py-2.5 text-body-sm text-ink-secondary transition-colors hover:bg-surface-low hover:text-ink"
          >
            取消
          </button>
          <button
            disabled={saving || !subject.trim() || !statement.trim()}
            className="pmo-btn-primary rounded-ctrl px-5 py-2.5 text-body-sm font-semibold"
          >
            {saving ? '正在保存…' : initial ? '更新记忆' : '记住这件事'}
          </button>
        </div>
      </form>
    </div>
  )
}

function PreferenceCard({ item, onEdit, onDelete }: {
  item: MemoryPreference
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <article className="group flex min-h-52 flex-col rounded-card bg-[var(--glass-panel-bg)] p-6 backdrop-blur-[20px] backdrop-saturate-150 border border-[var(--glass-panel-border)] shadow-[var(--shadow-glass)] transition-all hover:-translate-y-0.5 hover:shadow-[var(--shadow-hover)]">
      <div className="flex items-start justify-between gap-4">
        <span className="text-caption font-semibold text-primary">
          {categoryLabels[item.category] || item.category}
        </span>
        <span className={`text-micro ${item.polarity === 'negative' ? 'text-error' : 'text-ink-muted'}`}>
          {polarityLabels[item.polarity]}
        </span>
      </div>
      <h3 className="mt-5 text-heading font-semibold text-ink">{item.subject}</h3>
      <p className="mt-2 flex-1 text-body-sm text-ink-secondary line-clamp-4">{item.statement}</p>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-outline-variant/15 pt-4">
        <p className="text-caption text-ink-muted">{item.scope} · {item.evidence_refs.length} 条原始证据</p>
        <div className="flex items-center gap-1">
          <button
            onClick={onEdit}
            className="flex items-center gap-1.5 rounded-ctrl px-2.5 py-1.5 text-caption text-ink-muted transition-colors hover:bg-surface-low hover:text-ink"
          >
            <Icon name="edit" className="h-3.5 w-3.5" />编辑
          </button>
          <button
            onClick={onDelete}
            className="flex items-center gap-1.5 rounded-ctrl px-2.5 py-1.5 text-caption text-ink-muted transition-colors hover:bg-error/5 hover:text-error"
          >
            <Icon name="trash" className="h-3.5 w-3.5" />删除
          </button>
        </div>
      </div>
    </article>
  )
}

function CandidateCard({ item, onResolve }: {
  item: MemoryCandidate
  onResolve: (id: string, resolution: 'accept' | 'ignore') => Promise<void>
}) {
  const needsDecision = item.status === 'conflict'

  return (
    <article className={`relative overflow-hidden rounded-card bg-[var(--glass-panel-bg)] p-6 backdrop-blur-[20px] backdrop-saturate-150 border shadow-[var(--shadow-glass)] ${
      needsDecision ? 'border-warning/25' : 'border-[var(--glass-panel-border)]'
    }`}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-caption font-semibold text-primary">{categoryLabels[item.category] || item.category}</p>
        <span className={`text-micro ${
          needsDecision
            ? 'text-warning'
            : item.status === 'quota_blocked'
              ? 'text-error'
              : 'text-ink-muted'
        }`}>
          {candidateLabels[item.status]}
        </span>
      </div>
      <h3 className="mt-5 text-heading font-semibold text-ink">{item.subject || '一条尚未命名的候选'}</h3>
      <p className="mt-2 text-body-sm text-ink-secondary">{item.statement}</p>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <span className="rounded-ctrl bg-surface-low px-2.5 py-1 text-micro text-ink-muted">适用 · {item.scope}</span>
        <span className="rounded-ctrl bg-surface-low px-2.5 py-1 text-micro text-ink-muted">{item.evidence_refs.length} 条用户原话</span>
      </div>

      {item.evidence_refs[0]?.excerpt && (
        <blockquote className="mt-4 border-l border-primary/25 pl-3 text-caption text-ink-muted line-clamp-2">
          「{item.evidence_refs[0].excerpt}」
        </blockquote>
      )}

      {needsDecision && (
        <div className="mt-5 flex flex-wrap gap-2 border-t border-outline-variant/15 pt-4">
          <button
            onClick={() => onResolve(item.candidate_id, 'accept')}
            className="pmo-btn-primary flex items-center gap-1.5 rounded-ctrl px-3 py-2 text-caption font-semibold"
          >
            <Icon name="check" className="h-3.5 w-3.5" />记住这条
          </button>
          <button
            onClick={() => onResolve(item.candidate_id, 'ignore')}
            className="rounded-ctrl bg-surface-low px-3 py-2 text-caption text-ink-secondary ghost-border transition-colors hover:text-ink"
          >
            这次不要记
          </button>
        </div>
      )}
    </article>
  )
}

function HistoryCard({ event, expanded, onToggle, onUpdate, onDelete }: {
  event: MemoryHistoryEvent
  expanded: boolean
  onToggle: () => void
  onUpdate: (id: string, updates: Partial<MemoryHistoryEvent>) => Promise<void>
  onDelete: (id: string) => Promise<void>
}) {
  const edit = () => {
    const summary = prompt('编辑历史摘要', event.summary)
    if (summary !== null && summary.trim()) void onUpdate(event.event_id, { summary: summary.trim() })
  }

  return (
    <article className={`rounded-card bg-[var(--glass-panel-bg)] backdrop-blur-[20px] backdrop-saturate-150 border border-[var(--glass-panel-border)] shadow-[var(--shadow-glass)] transition-all ${expanded ? 'md:col-span-2 2xl:col-span-3' : ''}`}>
      <button onClick={onToggle} className="w-full p-6 text-left">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <time className="text-caption text-ink-muted">{formatDate(event.event_at)}</time>
              {event.project && (
                <span className="text-micro font-semibold text-primary">{event.project}</span>
              )}
            </div>
            <h3 className="mt-4 text-heading font-semibold text-ink">{event.title}</h3>
            <p className="mt-2 text-body-sm text-ink-secondary line-clamp-3">{event.summary}</p>
          </div>
          <Icon name="chevron" className={`mt-1 h-4 w-4 shrink-0 text-ink-muted transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </div>
        {event.tags.length > 0 && (
          <div className="mt-5 flex flex-wrap gap-1.5">
            {event.tags.slice(0, 5).map(tag => (
              <span key={tag} className="rounded-ctrl bg-surface-mid px-2 py-1 text-micro text-ink-muted">{tag}</span>
            ))}
          </div>
        )}
      </button>

      {expanded && (
        <div className="pmo-memory-section border-t border-outline-variant/15 px-6 py-5">
          <p className="whitespace-pre-wrap text-body-sm text-ink-secondary">{event.detail || event.summary}</p>

          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            {event.decisions.length > 0 && (
              <div>
                <h4 className="text-label font-semibold text-ink">关键决策</h4>
                <ul className="mt-2 space-y-2">
                  {event.decisions.map((item, index) => (
                    <li key={index} className="flex gap-3 text-body-sm text-ink-secondary">
                      <span className="font-mono text-caption text-primary">{String(index + 1).padStart(2, '0')}</span>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {event.artifacts.length > 0 && (
              <div>
                <h4 className="text-label font-semibold text-ink">交付物</h4>
                <div className="mt-2 flex flex-wrap gap-2">
                  {event.artifacts.map((item, index) => item.url ? (
                    <a
                      key={index}
                      href={item.url}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-ctrl bg-surface-low px-3 py-2 text-caption text-primary ghost-border hover:underline"
                    >
                      {item.label || item.path || '查看资源'}
                    </a>
                  ) : (
                    <span key={index} className="rounded-ctrl bg-surface-low px-3 py-2 text-caption text-ink-secondary ghost-border">
                      {item.label || item.path || item.asset_id}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="mt-6 flex gap-2">
            <button
              onClick={edit}
              className="flex items-center gap-1.5 rounded-ctrl bg-surface-low px-3 py-2 text-caption text-ink-secondary ghost-border transition-colors hover:text-ink"
            >
              <Icon name="edit" className="h-3.5 w-3.5" />编辑摘要
            </button>
            <button
              onClick={() => { if (confirm('删除这条历史记录？')) void onDelete(event.event_id) }}
              className="flex items-center gap-1.5 rounded-ctrl px-3 py-2 text-caption text-error transition-colors hover:bg-error/5"
            >
              <Icon name="trash" className="h-3.5 w-3.5" />删除
            </button>
          </div>
        </div>
      )}
    </article>
  )
}

function EmptyState({ section, onCreate }: { section: Section; onCreate?: () => void }) {
  const content = {
    profile: {
      title: '还没有形成长期画像',
      description: '只有明确、稳定且值得跨任务保留的偏好才会进入这里。单次项目的配色和风格不会被擅自固化。',
    },
    history: {
      title: '这里会留下真正完成过的事',
      description: '项目、决策和交付物会作为历史事实保存，但不会自动影响你正在做的新任务。',
    },
    candidates: {
      title: '暂时没有值得你分心的候选',
      description: '记忆整理会安静地在后台完成；只有可能成为长期偏好、或发生冲突时，候选才会出现在这里。',
    },
  }[section]

  return (
    <div
      className="relative min-h-60 overflow-hidden rounded-glass bg-[var(--glass-panel-bg)] px-6 py-14 text-center backdrop-blur-[20px] backdrop-saturate-150 border border-[var(--glass-panel-border)] shadow-[var(--shadow-glass)]"
      style={{ gridColumn: '1 / -1' }}
    >
      <div className="pmo-memory-empty-mark" aria-hidden><i /><i /><i /><i /></div>
      <p className="relative mt-5 text-body-sm font-semibold text-ink">{content.title}</p>
      <p className="relative mx-auto mt-2 max-w-lg text-caption text-ink-muted">{content.description}</p>
      {section === 'profile' && onCreate && (
        <button onClick={onCreate} className="relative mt-5 rounded-ctrl bg-surface-low px-4 py-2 text-caption font-semibold text-primary ghost-border transition-colors hover:bg-surface-mid">
          添加第一条明确偏好
        </button>
      )}
    </div>
  )
}

export default function StorePage() {
  const memory = useMemoryV2()
  const [section, setSection] = useState<Section>('profile')
  const [editor, setEditor] = useState<MemoryPreference | 'new' | null>(null)
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const preferences = useMemo(
    () => [...(memory.profile?.preferences || [])].sort((left, right) => {
      const categoryOrder = (categoryLabels[left.category] || left.category)
        .localeCompare(categoryLabels[right.category] || right.category, 'zh-CN')
      return categoryOrder || left.subject.localeCompare(right.subject, 'zh-CN')
    }),
    [memory.profile?.preferences],
  )

  const candidates = useMemo(
    () => [...memory.activity.candidates]
      .filter(candidate => visibleCandidateStatuses.has(candidate.status))
      .sort((left, right) => {
        const priority = (status: MemoryCandidate['status']) => status === 'conflict' ? 0 : status === 'quota_blocked' ? 1 : 2
        return priority(left.status) - priority(right.status)
          || new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime()
      }),
    [memory.activity.candidates],
  )

  const savePreference = async (value: Pick<MemoryPreference, 'category' | 'subject' | 'statement' | 'scope' | 'polarity'>) => {
    if (editor && editor !== 'new') await memory.updatePreference(editor.preference_id, value)
    else await memory.createPreference(value)
  }

  const searchHistory = (event: FormEvent) => {
    event.preventDefault()
    void memory.refresh(search)
  }

  const sectionCopy = {
    profile: ['长期画像', '这些偏好会稳定地陪伴新任务，但当前指令永远拥有更高优先级。'],
    history: ['历史', '过去做过的项目、决策与交付物；它们是事实记录，不是当前任务规范。'],
    candidates: ['候选记忆', '这里只展示可能值得长期保留、或需要你判断的内容。后台运行过程本身不会打扰你。'],
  }[section]

  return (
    <main className="h-full flex-1 overflow-y-auto">
      <div className="mx-auto max-w-7xl px-5 py-8 sm:px-8 lg:px-12 lg:py-10">
        <header className="mb-8 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-3 flex items-center gap-3">
              <span className="h-px w-10 bg-primary/70" />
              <p className="text-label tracking-[0.18em] text-primary">ACCOUNT MEMORY</p>
            </div>
            <h1 className="pmo-crystallize text-title font-semibold text-ink">记忆</h1>
            <p className="mt-2 max-w-2xl text-body-sm text-ink-secondary">
              长期画像保存稳定偏好，历史保留过去项目与决策；候选只在真正值得你关注时出现。
            </p>
          </div>
          <button
            onClick={() => setEditor('new')}
            className="pmo-btn-primary flex w-fit items-center gap-2 rounded-ctrl px-4 py-2.5 text-body-sm font-semibold"
          >
            <Icon name="plus" className="h-4 w-4" />记录明确偏好
          </button>
        </header>

        <MemoryHero
          usedTokens={memory.capacity?.used_tokens || 0}
          limitTokens={memory.capacity?.limit_tokens || 20_000}
          profileTokens={memory.capacity?.profile_tokens || 0}
          historyTokens={memory.capacity?.history_tokens || 0}
          remainingTokens={memory.capacity?.remaining_tokens || 20_000}
          usageRatio={memory.capacity?.usage_ratio || 0}
          onViewHistory={() => setSection('history')}
        />

        <div className="mt-8 flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <nav className="grid w-full grid-cols-3 rounded-card bg-[var(--glass-panel-bg)] p-1 backdrop-blur-[20px] border border-[var(--glass-panel-border)] shadow-[var(--shadow-glass)] sm:w-auto" aria-label="记忆分类">
            {([
              ['profile', 'profile', '长期画像', preferences.length],
              ['history', 'history', '历史', memory.history.length],
              ['candidates', 'candidate', '候选', candidates.length],
            ] as const).map(([value, icon, label, count]) => (
              <button
                key={value}
                onClick={() => setSection(value)}
                aria-current={section === value ? 'page' : undefined}
                className={`flex items-center justify-center gap-2 rounded-ctrl px-4 py-2.5 text-body-sm transition-all ${
                  section === value
                    ? 'bg-surface-lowest font-semibold text-ink shadow-[var(--shadow-ambient)]'
                    : 'text-ink-muted hover:text-ink'
                }`}
              >
                <Icon name={icon} className={`h-4 w-4 ${section === value ? 'text-primary' : ''}`} />
                {label}
                {count > 0 && <span className="font-mono text-micro text-ink-muted">{count}</span>}
              </button>
            ))}
          </nav>

          {section === 'history' && (
            <form onSubmit={searchHistory} className="relative w-full sm:w-80">
              <Icon name="search" className="absolute left-3.5 top-3 h-4 w-4 text-ink-muted" />
              <input
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="搜索项目、决策或关键词"
                className="w-full rounded-card bg-[var(--glass-panel-bg)] py-2.5 pl-10 pr-4 text-body-sm text-ink placeholder:text-ink-muted border border-[var(--glass-panel-border)] pmo-field-focus backdrop-blur-[20px]"
              />
            </form>
          )}
        </div>

        <div className="mb-5 mt-7 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-heading font-semibold text-ink">{sectionCopy[0]}</h2>
            <p className="mt-1 max-w-2xl text-caption text-ink-muted">{sectionCopy[1]}</p>
          </div>
          {section === 'profile' && (
            <p className="text-caption text-ink-muted">最多 30 条已确认偏好 · 共用 20K 账户记忆空间</p>
          )}
        </div>

        {memory.error && (
          <div className="mb-6 rounded-card bg-error/5 px-5 py-4 text-body-sm text-error ghost-border">
            {memory.error}
          </div>
        )}

        {memory.isLoading && !memory.profile ? (
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2 2xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <div
                key={index}
                className="rounded-card bg-[var(--glass-panel-bg)] p-6 border border-[var(--glass-panel-border)] shadow-[var(--shadow-glass)]"
              >
                <ShimmerBlock h={18} w={72} className="mb-5 rounded-ctrl" />
                <ShimmerBlock h={18} className="mb-3 w-3/4" />
                <ShimmerBlock h={12} className="mb-2 w-full" />
                <ShimmerBlock h={12} className="w-5/6" />
              </div>
            ))}
          </div>
        ) : (
          <div key={section} className="pmo-memory-section">
            {section === 'profile' ? (
              <section className="grid grid-cols-1 gap-5 md:grid-cols-2">
                {preferences.length ? preferences.map(item => (
                  <PreferenceCard
                    key={item.preference_id}
                    item={item}
                    onEdit={() => setEditor(item)}
                    onDelete={() => {
                      if (confirm('删除这条偏好？Pegasus Spatial 会避免根据旧证据把它自动重建。')) {
                        void memory.deletePreference(item.preference_id)
                      }
                    }}
                  />
                )) : <EmptyState section="profile" onCreate={() => setEditor('new')} />}
              </section>
            ) : section === 'history' ? (
              <section className="grid grid-cols-1 gap-5 md:grid-cols-2 2xl:grid-cols-3">
                {memory.history.length ? memory.history.map(event => (
                  <HistoryCard
                    key={event.event_id}
                    event={event}
                    expanded={expandedEvent === event.event_id}
                    onToggle={() => setExpandedEvent(value => value === event.event_id ? null : event.event_id)}
                    onUpdate={memory.updateHistory}
                    onDelete={memory.deleteHistory}
                  />
                )) : <EmptyState section="history" />}
              </section>
            ) : (
              <section className="grid grid-cols-1 gap-5 md:grid-cols-2 2xl:grid-cols-3">
                {candidates.length ? candidates.map(item => (
                  <CandidateCard key={item.candidate_id} item={item} onResolve={memory.resolveConflict} />
                )) : <EmptyState section="candidates" />}
              </section>
            )}
          </div>
        )}
      </div>

      {editor && (
        <PreferenceEditor
          initial={editor === 'new' ? undefined : editor}
          onSave={savePreference}
          onClose={() => setEditor(null)}
        />
      )}
    </main>
  )
}
