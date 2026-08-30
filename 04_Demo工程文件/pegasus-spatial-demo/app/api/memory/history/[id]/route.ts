import { NextRequest, NextResponse } from 'next/server'
import { resolveLocalOwner } from '@/lib/local-owner'
import { deleteHistoryEvent, MemoryQuotaExceededError, updateHistoryEvent } from '@/lib/memory-v2/repository'

export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId
  const { id } = await params
  const body = await req.json()
  try {
    const updated = await updateHistoryEvent(userId, id, body)
    return updated
      ? NextResponse.json(updated)
      : NextResponse.json({ error: 'History event not found' }, { status: 404 })
  } catch (error) {
    if (error instanceof MemoryQuotaExceededError) {
      return NextResponse.json({ error: '本地项目记忆空间已满，只能保存缩短后的内容' }, { status: 409 })
    }
    throw error
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId
  const { id } = await params
  const deleted = await deleteHistoryEvent(userId, id)
  return deleted
    ? NextResponse.json({ success: true })
    : NextResponse.json({ error: 'History event not found' }, { status: 404 })
}
