'use client'

interface ThinkingStatusProps {
  status: string
}

export function ThinkingStatus({ status }: ThinkingStatusProps) {
  if (!status) return null

  return (
    <div className="flex items-center gap-2 px-4 py-2 text-xs text-gray-500">
      <div className="w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      <span>{status}</span>
    </div>
  )
}
