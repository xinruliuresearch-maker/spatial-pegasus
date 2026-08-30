import { TopProgressBar } from '@/components/loading/TopProgressBar'
import { Skeleton } from '@/components/loading/Skeleton'

/**
 * Loading state for the Library route — grid of project card skeletons +
 * top progress bar. Replaces the page region while ShellLayout keeps the
 * sidebar + top nav.
 */
export default function Loading() {
  return (
    <>
      <TopProgressBar />
      <div className="flex-1 h-full overflow-y-auto">
        <Skeleton variant="library" />
      </div>
    </>
  )
}
