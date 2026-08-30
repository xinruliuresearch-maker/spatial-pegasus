'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

export const LEFT_SIDEBAR_LIMITS = { min: 232, max: 400, default: 280 } as const
export const RIGHT_PANEL_LIMITS = { min: 420, max: 760, default: 560 } as const

const LEFT_SIDEBAR_STORAGE_KEY = 'pegasus-spatial:left-sidebar-width'
const RIGHT_PANEL_STORAGE_KEY = 'pegasus-spatial:right-panel-width'

interface WorkspaceLayoutContextValue {
  leftSidebarWidth: number
  rightPanelWidth: number
  setLeftSidebarWidth: (width: number) => void
  setRightPanelWidth: (width: number) => void
  resetLeftSidebarWidth: () => void
  resetRightPanelWidth: () => void
}

const WorkspaceLayoutContext = createContext<WorkspaceLayoutContextValue | null>(null)

function clamp(width: number, limits: { min: number; max: number }): number {
  return Math.round(Math.min(limits.max, Math.max(limits.min, width)))
}

function storedWidth(key: string, limits: { min: number; max: number }): number | null {
  try {
    const value = Number.parseFloat(localStorage.getItem(key) ?? '')
    return Number.isFinite(value) ? clamp(value, limits) : null
  } catch {
    return null
  }
}

export function WorkspaceLayoutProvider({ children }: { children: ReactNode }) {
  const [leftSidebarWidth, setLeftSidebarWidthState] = useState<number>(LEFT_SIDEBAR_LIMITS.default)
  const [rightPanelWidth, setRightPanelWidthState] = useState<number>(RIGHT_PANEL_LIMITS.default)
  const [hydrated, setHydrated] = useState(false)

  const setLeftSidebarWidth = useCallback((width: number) => {
    setLeftSidebarWidthState(clamp(width, LEFT_SIDEBAR_LIMITS))
  }, [])
  const setRightPanelWidth = useCallback((width: number) => {
    setRightPanelWidthState(clamp(width, RIGHT_PANEL_LIMITS))
  }, [])
  const resetLeftSidebarWidth = useCallback(() => setLeftSidebarWidthState(LEFT_SIDEBAR_LIMITS.default), [])
  const resetRightPanelWidth = useCallback(() => setRightPanelWidthState(RIGHT_PANEL_LIMITS.default), [])

  useEffect(() => {
    const savedLeft = storedWidth(LEFT_SIDEBAR_STORAGE_KEY, LEFT_SIDEBAR_LIMITS)
    const savedRight = storedWidth(RIGHT_PANEL_STORAGE_KEY, RIGHT_PANEL_LIMITS)
    if (savedLeft !== null) setLeftSidebarWidthState(savedLeft)
    if (savedRight !== null) setRightPanelWidthState(savedRight)
    setHydrated(true)
  }, [])

  useEffect(() => {
    if (!hydrated) return
    try { localStorage.setItem(LEFT_SIDEBAR_STORAGE_KEY, String(leftSidebarWidth)) } catch { /* private mode */ }
  }, [hydrated, leftSidebarWidth])

  useEffect(() => {
    if (!hydrated) return
    try { localStorage.setItem(RIGHT_PANEL_STORAGE_KEY, String(rightPanelWidth)) } catch { /* private mode */ }
  }, [hydrated, rightPanelWidth])

  const value = useMemo<WorkspaceLayoutContextValue>(() => ({
    leftSidebarWidth,
    rightPanelWidth,
    setLeftSidebarWidth,
    setRightPanelWidth,
    resetLeftSidebarWidth,
    resetRightPanelWidth,
  }), [leftSidebarWidth, rightPanelWidth, setLeftSidebarWidth, setRightPanelWidth, resetLeftSidebarWidth, resetRightPanelWidth])

  return <WorkspaceLayoutContext.Provider value={value}>{children}</WorkspaceLayoutContext.Provider>
}

export function useWorkspaceLayout(): WorkspaceLayoutContextValue {
  const context = useContext(WorkspaceLayoutContext)
  if (!context) throw new Error('useWorkspaceLayout must be used within WorkspaceLayoutProvider')
  return context
}
