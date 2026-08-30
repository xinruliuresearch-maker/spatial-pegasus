import { NextResponse } from 'next/server'
import { resolveLocalOwner } from '@/lib/local-owner'
import { getMemoryCapacity } from '@/lib/memory-v2/repository'

export const dynamic = 'force-dynamic'

export async function GET() {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId
  return NextResponse.json(await getMemoryCapacity(userId))
}
