import type { WorkspaceArtifact } from '@/hooks/useWorkspaceArtifacts'

export function ArtifactLoadingOverlay({ artifact }: { artifact: WorkspaceArtifact }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="text-center">
        <span className="mx-auto block h-8 w-8 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
        <p className="mt-4 text-sm font-medium text-ink-secondary">飞马空间 Agent 正在更新{artifact.label}</p>
        <p className="mt-1 text-xs text-ink-muted">完成后会自动刷新最终内容</p>
      </div>
    </div>
  )
}
