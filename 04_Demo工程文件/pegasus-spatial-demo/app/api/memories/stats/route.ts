import { NextResponse } from 'next/server'
import { getMemoryStats } from '@/lib/db/memory-repository'
import { resolveLocalOwner } from '@/lib/local-owner'

export const dynamic = 'force-dynamic'

export async function GET() {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId

  try {
    const stats = await getMemoryStats(userId)
    return NextResponse.json(stats)
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    )
  }
}
