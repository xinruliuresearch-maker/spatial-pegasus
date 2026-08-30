'use client'

import { ThemeProvider } from 'next-themes'
import { WorkspaceLayoutProvider } from '@/contexts/WorkspaceLayoutContext'

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="light"
      forcedTheme="light"
      enableSystem={false}
      disableTransitionOnChange
    >
      <WorkspaceLayoutProvider>{children}</WorkspaceLayoutProvider>
    </ThemeProvider>
  )
}
