'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { useChatContext } from '@/contexts/ChatContext'
import { TopProgressBar } from './TopProgressBar'

/**
 * Global navigation progress bar.
 *
 * Sci-Pegasus uses a single-URL workspace (`/`) where switching conversations
 * mutates ChatContext state instead of changing the URL. So we listen for
 * **both** pathname changes (cross-route navigation) and conversationId
 * changes (intra-workspace conversation switch), and flash the top progress
 * bar for ~600ms on either trigger.
 *
 * Why we don't rely on next.js `loading.tsx`: it only fires when the target
 * page.tsx is an async server component or has a Suspense boundary. All
 * Sci-Pegasus pages are `'use client'`, so loading.tsx never gets a chance to
 * show. This component fills that gap.
 */
export function NavigationProgress({ minDurationMs = 600 }: { minDurationMs?: number }) {
  const pathname = usePathname()
  const { conversationId } = useChatContext()
  const [active, setActive] = useState(false)
  const firstRenderRef = useRef(true)

  useEffect(() => {
    if (firstRenderRef.current) {
      firstRenderRef.current = false
      return
    }
    setActive(true)
    const t = setTimeout(() => setActive(false), minDurationMs)
    return () => clearTimeout(t)
  // Re-runs on either pathname or conversationId change — both signal a
  // user-initiated context switch worth flagging visually.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, conversationId])

  if (!active) return null
  return <TopProgressBar />
}
