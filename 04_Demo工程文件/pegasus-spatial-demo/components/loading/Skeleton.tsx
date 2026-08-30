'use client'

/**
 * Skeleton blocks shaped like Sci-Pegasus pages, with a soft shimmer wash.
 *
 * Pair with <TopProgressBar /> in a loading.tsx — the top bar gives a global
 * "still loading" hint while each block has a 1.6s diagonal highlight sweep
 * (pmo-shimmer-sweep, globals.css:346) so the page reads as "being painted in"
 * rather than frozen.
 *
 * Shared design tokens used:
 *  - bg-surface-mid (raised paper) for blocks
 *  - rounded-ctrl/card radius scale
 *  - ghost-border / shadow-ambient for card chrome
 *  - bg-surface-bright + ghost-border-l/-r/-t/-b for workspace panel separators
 */

interface SkeletonProps {
  variant?:
    | 'workspace'
    | 'library'
    | 'editor'
    | 'help'
    | 'settings'
    | 'store'
    | 'plain'
}

/**
 * Single shimmer block. Exported so inline loading states (e.g. WorkspacePanel
 * artifact pending) can reuse the same visual language as route loading.tsx.
 */
export function ShimmerBlock({
  className,
  h,
  w,
}: {
  className?: string
  h?: string | number
  w?: string | number
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-ctrl bg-surface-mid ${className ?? ''}`}
      style={{ height: h, width: w }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'linear-gradient(105deg, transparent 30%, rgba(246,248,251,0.55) 50%, transparent 70%)',
          transform: 'translateX(-120%) skewX(-18deg)',
          animation: 'pmo-shimmer-sweep 1.6s ease-in-out infinite',
        }}
      />
    </div>
  )
}

const Block = ShimmerBlock

/* ─── Workspace variant: chat editorial timeline (left) + workspace panel (right) ─── */
function WorkspaceSkeleton() {
  return (
    <div className="flex h-full">
      {/* Left: workspace panel (flex-1) — first DOM child = leftmost in LTR row */}
      <div className="flex-1 min-w-0 h-full flex flex-col bg-surface-bright">
        {/* Single-file breadcrumb bar (file navigation now lives in the sidebar). */}
        <div className="flex-shrink-0 flex items-center gap-2 px-3 h-12 ghost-border-b">
          <Block h={28} w={28} />
          <Block h={10} w={70} />
          <Block h={10} w={8} />
          <Block h={10} w={84} />
          <Block h={10} className="min-w-0 flex-1 max-w-44" />
          <div className="ml-auto flex items-center gap-2">
            <Block h={20} w={34} />
            <Block h={24} w={54} />
          </div>
        </div>

        {/* Main content area */}
        <div className="flex-1 flex items-center justify-center p-6 overflow-hidden">
          <Block className="w-full max-w-[640px] aspect-[4/3]" />
        </div>

      </div>

      {/* Right: 560px chat — editorial timeline */}
      <div
        className="flex-shrink-0 h-full flex flex-col ghost-border-l"
        style={{ width: 560 }}
      >
        <div className="flex-1 overflow-hidden" style={{ padding: '40px 28px 16px' }}>
          <div className="mx-auto flex flex-col gap-7" style={{ maxWidth: 680 }}>
            {/* User — meta line + body, no bubble */}
            <div className="flex flex-col gap-2">
              <Block h={10} w={88} />
              <Block h={14} w="62%" />
            </div>

            {/* Assistant — meta + bubble container with inline tool call */}
            <div className="flex flex-col gap-2">
              <Block h={10} w={64} />
              <div
                className="flex flex-col gap-2 p-3 rounded-card bg-surface-lowest ghost-border"
                style={{ boxShadow: 'var(--shadow-ambient)' }}
              >
                <Block h={12} w="92%" />
                <Block h={12} w="78%" />
                <Block h={12} w="84%" />
                <div className="mt-2 p-2 rounded-ctrl bg-surface-mid/40 flex items-center gap-2">
                  <Block h={14} w={14} className="rounded-full" />
                  <Block h={10} w="40%" />
                </div>
              </div>
            </div>

            {/* User follow-up */}
            <div className="flex flex-col gap-2">
              <Block h={10} w={88} />
              <Block h={14} w="48%" />
            </div>

            {/* Assistant final answer plain */}
            <div className="flex flex-col gap-2">
              <Block h={10} w={64} />
              <Block h={12} w="88%" />
              <Block h={12} w="92%" />
              <Block h={12} w="70%" />
            </div>
          </div>
        </div>

        {/* Chat input bar */}
        <div className="flex-shrink-0 px-7 py-4 ghost-border-t">
          <Block h={48} className="w-full" />
        </div>
      </div>
    </div>
  )
}

function LibrarySkeleton() {
  return (
    <div className="px-8 py-10">
      <Block className="w-48 mb-3" h={28} />
      <Block className="w-72 mb-10" h={14} />
      {/* Mirror real Library page grid + ProjectCard layout (thumb flush, info p-4) */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-5">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="bg-surface-lowest rounded-card overflow-hidden ghost-border flex flex-col"
            style={{ boxShadow: 'var(--shadow-ambient)' }}
          >
            <Block className="aspect-[4/3]" />
            <div className="p-4">
              <Block className="w-3/4 mb-1.5" h={14} />
              <Block className="w-1/2" h={10} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function EditorSkeleton() {
  return (
    <div className="flex h-full">
      <div className="w-72 ghost-border-r p-4 flex flex-col gap-3">
        <Block className="w-3/4" h={20} />
        {Array.from({ length: 8 }).map((_, i) => (
          <Block key={i} className="w-full" h={36} />
        ))}
      </div>
      <div className="flex-1 flex items-center justify-center">
        <Block className="w-3/4 max-w-[600px] aspect-[4/3]" />
      </div>
    </div>
  )
}

/* ─── Help: collapsible FAQ list ─── */
function HelpSkeleton() {
  return (
    <div className="px-8 py-10 max-w-[820px] mx-auto">
      <Block className="w-32 mb-3" h={24} />
      <Block className="w-72 mb-10" h={14} />
      <div className="flex flex-col gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="bg-surface-lowest rounded-card px-4 py-4 ghost-border"
            style={{ boxShadow: 'var(--shadow-ambient)' }}
          >
            <Block className="w-2/3" h={16} />
          </div>
        ))}
      </div>
    </div>
  )
}

/* ─── Settings: tab list + form ─── */
function SettingsSkeleton() {
  return (
    <div className="px-8 py-10 max-w-[760px] mx-auto">
      <Block className="w-28 mb-3" h={24} />
      <Block className="w-56 mb-8" h={14} />
      {/* Tabs */}
      <div className="flex gap-4 mb-8 ghost-border-b pb-3">
        <Block h={20} w={64} />
        <Block h={20} w={88} />
      </div>
      {/* Avatar + form fields */}
      <div className="flex items-center gap-4 mb-8">
        <Block className="rounded-full" h={64} w={64} />
        <div className="flex flex-col gap-2">
          <Block h={16} w={140} />
          <Block h={12} w={200} />
        </div>
      </div>
      <div className="flex flex-col gap-5">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <Block h={11} w={88} />
            <Block h={36} className="w-full" />
          </div>
        ))}
      </div>
    </div>
  )
}

/* ─── Store: stats bento + memory card grid ─── */
function StoreSkeleton() {
  return (
    <div className="px-8 py-10">
      <Block className="w-32 mb-3" h={24} />
      <Block className="w-72 mb-8" h={14} />
      {/* Stats bento — 4 small KPI tiles */}
      <div className="grid grid-cols-4 gap-3 mb-10">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="bg-surface-lowest rounded-card p-4 ghost-border"
            style={{ boxShadow: 'var(--shadow-ambient)' }}
          >
            <Block className="w-1/2 mb-2" h={11} />
            <Block className="w-2/3" h={24} />
          </div>
        ))}
      </div>
      {/* Filter tabs */}
      <div className="flex gap-2 mb-6">
        {[40, 56, 56, 56, 56].map((w, i) => (
          <Block key={i} h={28} w={w} />
        ))}
      </div>
      {/* Memory card grid — match real /store grid (md:2, lg:3, gap-6, p-6) */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="bg-surface-lowest rounded-card p-6 ghost-border flex flex-col gap-3"
            style={{ boxShadow: 'var(--shadow-ambient)' }}
          >
            <div className="flex items-center justify-between mb-1">
              <Block h={20} w={20} className="rounded-ctrl" />
              <Block h={18} w={64} className="rounded-full" />
            </div>
            <Block h={18} className="w-3/4" />
            <Block h={12} className="w-full" />
            <Block h={12} className="w-5/6" />
          </div>
        ))}
      </div>
    </div>
  )
}

function PlainSkeleton() {
  return (
    <div className="p-8 flex flex-col gap-3">
      <Block className="w-1/3" h={28} />
      <Block className="w-2/3" h={14} />
      <Block className="w-full mt-4" h={120} />
      <Block className="w-1/2" h={14} />
      <Block className="w-3/4" h={14} />
    </div>
  )
}

export function Skeleton({ variant = 'workspace' }: SkeletonProps) {
  if (variant === 'workspace') return <WorkspaceSkeleton />
  if (variant === 'library') return <LibrarySkeleton />
  if (variant === 'editor') return <EditorSkeleton />
  if (variant === 'help') return <HelpSkeleton />
  if (variant === 'settings') return <SettingsSkeleton />
  if (variant === 'store') return <StoreSkeleton />
  return <PlainSkeleton />
}
