import { TopProgressBar } from '@/components/loading/TopProgressBar'

/**
 * Shell-segment fallback. Intentionally minimal — just the top progress bar.
 *
 * Why no skeleton here: next.js loading.tsx is nested Suspense. When the user
 * navigates from one shell child route (e.g. `/`) to another (`/library`),
 * next.js may render this fallback briefly before the more-specific child
 * loading.tsx kicks in. If this rendered the workspace skeleton, the user
 * would see a confusing flash of "wrong page" skeleton.
 *
 * Each child route owns its own loading.tsx that renders the appropriate
 * Skeleton variant. The main conversation page (/) handles its own loading
 * via isLoadingConversation in page.tsx (since it's a client component
 * driven by ChatContext state, not by route changes).
 */
export default function Loading() {
  return <TopProgressBar />
}
