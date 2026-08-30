'use client'

import { useAgentTeam, type AgentTeamMemberStatus } from '@/hooks/useAgentTeam'

interface AgentTeamPanelProps {
  conversationId: string | null
}

const STATUS_PRESENTATION: Record<AgentTeamMemberStatus, {
  label: string
  dotClass: string
  pillClass: string
}> = {
  running: {
    label: '运行中',
    dotClass: 'bg-primary shadow-[0_0_0_3px_var(--primary-tint-mid)]',
    pillClass: 'bg-[var(--primary-tint-weak)] text-primary',
  },
  idle: {
    label: '待机',
    dotClass: 'bg-ink-muted',
    pillClass: 'bg-surface-mid text-ink-secondary',
  },
  paused: {
    label: '待机',
    dotClass: 'bg-warning',
    pillClass: 'bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] text-warning',
  },
  completed: {
    label: '已完成',
    dotClass: 'bg-success',
    pillClass: 'bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-success',
  },
  failed: {
    label: '异常',
    dotClass: 'bg-error',
    pillClass: 'bg-[color-mix(in_srgb,var(--error)_10%,transparent)] text-error',
  },
}

export function AgentTeamPanel({ conversationId }: AgentTeamPanelProps) {
  const { snapshot, isLoading, isLive, error } = useAgentTeam(conversationId)

  if (!conversationId) return null
  if (isLoading && !snapshot) {
    return (
      <section aria-label="Agent Team 状态" className="shrink-0 border-b border-ghost-border/20 bg-surface-lowest/55 px-5 py-3">
        <div className="flex items-center gap-3 text-xs text-ink-muted">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
          <span className="font-semibold uppercase tracking-[0.16em]">Team</span>
          <span>正在建立只读状态视图…</span>
        </div>
      </section>
    )
  }
  if (!snapshot) {
    return (
      <section aria-label="Agent Team 状态" className="shrink-0 border-b border-ghost-border/20 bg-surface-lowest/55 px-5 py-3">
        <div className="flex items-center gap-3 text-xs text-error">
          <span className="h-1.5 w-1.5 rounded-full bg-error" />
          <span className="font-semibold uppercase tracking-[0.16em]">Team</span>
          <span className="truncate">{error || '状态暂时不可用，正在重试'}</span>
        </div>
      </section>
    )
  }

  const counts = [
    { label: '全部', value: snapshot.counts.total, className: 'text-ink' },
    { label: '运行', value: snapshot.counts.running, className: 'text-primary' },
    { label: '待机', value: snapshot.counts.standby, className: 'text-ink-secondary' },
    { label: '完成', value: snapshot.counts.completed, className: 'text-success' },
    { label: '异常', value: snapshot.counts.failed, className: 'text-error' },
  ]

  return (
    <section aria-label="Agent Team 状态" className="shrink-0 border-b border-ghost-border/20 bg-surface-lowest/72 px-5 py-3 backdrop-blur-xl">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-center gap-2.5">
          <span className={`h-1.5 w-1.5 rounded-full ${isLive ? 'bg-success shadow-[0_0_0_3px_color-mix(in_srgb,var(--success)_12%,transparent)]' : 'bg-ink-muted'}`} />
          <h2 className="text-[11px] font-bold uppercase tracking-[0.18em] text-ink">Team</h2>
          <span className="text-[10px] text-ink-muted">只读状态</span>
        </div>
        <dl className="flex flex-wrap items-center gap-1.5" aria-label="Agent 数量汇总">
          {counts.map(item => (
            <div key={item.label} className="flex items-baseline gap-1 rounded-full bg-surface-low px-2 py-0.5">
              <dt className="text-[9px] text-ink-muted">{item.label}</dt>
              <dd className={`text-[10px] font-bold tabular-nums ${item.className}`}>{item.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="mt-2 max-h-32 space-y-1 overflow-y-auto pr-1">
        {snapshot.agents.map(agent => {
          const status = STATUS_PRESENTATION[agent.status]
          return (
            <article key={agent.agent_id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-xl bg-surface-low/70 px-3 py-2">
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[0.12em] ${agent.is_root ? 'bg-primary text-on-primary' : 'bg-surface-high text-ink-secondary'}`}>
                    {agent.is_root ? 'Root' : '成员'}
                  </span>
                  <span className="truncate text-xs font-semibold text-ink">{agent.alias}</span>
                  <span className="truncate text-[10px] text-ink-muted">{agent.role}</span>
                </div>
                <p className="mt-1 truncate text-[9px] text-ink-muted">
                  最后切换 · <time dateTime={agent.last_transition_at}>{formatTransitionTime(agent.last_transition_at)}</time>
                </p>
              </div>
              <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[9px] font-semibold ${status.pillClass}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${status.dotClass}`} />
                {status.label}
              </span>
            </article>
          )
        })}
      </div>
      {error && <p className="mt-1.5 truncate text-[9px] text-warning">实时同步正在恢复 · {error}</p>}
    </section>
  )
}

function formatTransitionTime(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
}
