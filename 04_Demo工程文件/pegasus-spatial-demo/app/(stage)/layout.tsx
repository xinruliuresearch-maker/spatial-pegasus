'use client'

import { NavigationProgress } from '@/components/loading/NavigationProgress'

export default function SpatialStageLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-screen overflow-hidden bg-[#dfe3eb]">
      <NavigationProgress />
      {children}
    </div>
  )
}
