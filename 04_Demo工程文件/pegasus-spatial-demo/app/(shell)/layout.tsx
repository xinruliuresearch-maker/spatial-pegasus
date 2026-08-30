'use client'

import { TopNavBar } from '@/components/shell/TopNavBar'
import { AppSidebar } from '@/components/shell/AppSidebar'
import { AppBackground, type AppBackgroundState } from '@/components/shell/AppBackground'
import { NavigationProgress } from '@/components/loading/NavigationProgress'
import { useChatContext } from '@/contexts/ChatContext'
import { useWorkspaceLayout } from '@/contexts/WorkspaceLayoutContext'

export default function ShellLayout({ children }: { children: React.ReactNode }) {
  const { sidebarCollapsed, messages, isLoading } = useChatContext()
  const { leftSidebarWidth } = useWorkspaceLayout()
  const backgroundState: AppBackgroundState = isLoading ? 'running' : messages.length ? 'idle' : 'landing'
  const sidebarWidth = sidebarCollapsed ? 64 : leftSidebarWidth
  return (
    <div className="h-screen">
      <AppBackground state={backgroundState} />
      <NavigationProgress />
      <TopNavBar />
      <AppSidebar />
      <div
        data-resizable-offset="left-sidebar"
        className="pmo-resizable-offset flex h-screen min-w-0 pt-16"
        style={{ marginLeft: sidebarWidth }}
      >
        {children}
      </div>
    </div>
  )
}
