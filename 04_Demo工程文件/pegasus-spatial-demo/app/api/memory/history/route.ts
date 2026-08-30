import { NextRequest, NextResponse } from 'next/server'
import { resolveLocalOwner } from '@/lib/local-owner'
import { listHistoryEvents, recallHistory } from '@/lib/memory-v2/repository'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId
  const query = req.nextUrl.searchParams.get('query')?.trim()
  const limit = Number(req.nextUrl.searchParams.get('limit') || 50)
  const events = query
    ? await recallHistory(userId, { query, depth: 'detail', limit })
    : await listHistoryEvents(userId, limit)
  return NextResponse.json(events)
}
