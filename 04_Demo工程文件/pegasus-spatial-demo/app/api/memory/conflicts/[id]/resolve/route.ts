import { NextRequest, NextResponse } from 'next/server'
import { resolveLocalOwner } from '@/lib/local-owner'
import { resolveConflict } from '@/lib/memory-v2/repository'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId
  const { id } = await params
  const body = await req.json()
  if (!['accept', 'ignore'].includes(body.resolution)) {
    return NextResponse.json({ error: 'resolution must be accept or ignore' }, { status: 400 })
  }
  const candidate = await resolveConflict(userId, id, body.resolution, String(body.note || ''))
  return candidate
    ? NextResponse.json(candidate)
    : NextResponse.json({ error: 'Conflict not found' }, { status: 404 })
}
