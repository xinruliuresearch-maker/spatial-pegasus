'use client'

import { useRouter } from 'next/navigation'
import { useChatContext } from '@/contexts/ChatContext'
import { useProjects } from '@/hooks/useProjects'
import { ProjectCard } from '@/components/library/ProjectCard'
import { ShimmerBlock } from '@/components/loading/Skeleton'

export default function LibraryPage() {
  const router = useRouter()
  const { loadConversation } = useChatContext()
  const {
    projects,
    total,
    page,
    totalPages,
    isLoading,
    search,
    setSearch,
    loadMore,
    deleteProject,
    renameProject,
  } = useProjects()

  const handleSelect = (id: string) => {
    loadConversation(id)
    router.push('/')
  }

  return (
    <div className="flex-1 h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-8 py-10">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-title font-semibold text-ink tracking-tight mb-2">
            空间创作项目库
          </h1>
          <p className="text-sm text-ink-secondary">
            管理创作简报、持久任务、空间资产与修订关系 — 共 {total} 个项目
          </p>
        </div>

        {/* Search */}
        <div className="mb-8">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="搜索项目..."
            className="w-full max-w-sm rounded-card bg-surface-lowest px-4 py-2.5 text-sm text-ink placeholder-ink-muted focus:outline-none ghost-border pmo-field-focus transition-all"
            style={{ boxShadow: 'var(--shadow-ambient)' }}
          />
        </div>

        {/* Grid */}
        {projects.length > 0 ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-5">
            {projects.map(project => (
              <ProjectCard
                key={project.conversation_id}
                project={project}
                onSelect={handleSelect}
                onDelete={deleteProject}
                onRename={renameProject}
              />
            ))}
          </div>
        ) : isLoading ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-5">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="bg-surface-lowest rounded-card overflow-hidden ghost-border flex flex-col"
                style={{ boxShadow: 'var(--shadow-ambient)' }}
              >
                {/* Mirror ProjectCard layout: thumb flush to edges, info p-4 below */}
                <ShimmerBlock className="aspect-[4/3]" />
                <div className="p-4">
                  <ShimmerBlock className="w-3/4 mb-1.5" h={14} />
                  <ShimmerBlock className="w-1/2" h={10} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-20">
            <div className="w-16 h-16 mx-auto mb-4 rounded-ctrl bg-surface-low flex items-center justify-center">
              <svg className="w-8 h-8 text-ink-muted/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776" />
              </svg>
            </div>
            <p className="text-sm text-ink-muted">
              {search ? '没有匹配的项目' : '暂无项目，开始创建第一个空间世界吧'}
            </p>
          </div>
        )}

        {/* Load more */}
        {page < totalPages && (
          <div className="mt-8 text-center">
            <button
              onClick={loadMore}
              disabled={isLoading}
              className="px-6 py-2 rounded-ctrl text-sm font-medium text-primary hover:bg-primary/5 transition-colors disabled:opacity-50"
            >
              {isLoading ? '加载中...' : '加载更多'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
