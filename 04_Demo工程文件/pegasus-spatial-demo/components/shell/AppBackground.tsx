'use client'

import type { JSX } from 'react'

export type AppBackgroundState = 'landing' | 'idle' | 'running'

/** Lightweight atmosphere: branch-inspired motion without a second WebGL canvas. */
export function AppBackground({ state }: { state: AppBackgroundState }): JSX.Element {
  return (
    <div
      aria-hidden
      className="pmo-app-atmosphere pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-surface"
      data-state={state}
    >
      <i className="pmo-app-atmosphere__mass pmo-app-atmosphere__mass--clay" />
      <i className="pmo-app-atmosphere__mass pmo-app-atmosphere__mass--sage" />
      <i className="pmo-app-atmosphere__mass pmo-app-atmosphere__mass--paper" />
      <div className="pmo-app-atmosphere__grid" />
      <div className="pmo-app-atmosphere__veil" />
    </div>
  )
}
