import { TopProgressBar } from '@/components/loading/TopProgressBar'
import { Skeleton } from '@/components/loading/Skeleton'

export default function Loading() {
  return (
    <>
      <TopProgressBar />
      <div className="flex-1 h-full overflow-y-auto">
        <Skeleton variant="help" />
      </div>
    </>
  )
}
