import { NextRequest, NextResponse } from 'next/server'
import { resolveLocalOwner } from '@/lib/local-owner'
import { deletePreference, MemoryQuotaExceededError, updatePreference } from '@/lib/memory-v2/repository'

export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId
  const { id } = await params
  const body = await req.json()
  const allowed = ['category', 'subject', 'statement', 'scope', 'polarity', 'status'] as const
  const updates: Record<string, unknown> = {}
  for (const key of allowed) if (body[key] !== undefined) updates[key] = body[key]
  try {
    const profile = await updatePreference(userId, id, updates)
    return profile
      ? NextResponse.json(profile)
      : NextResponse.json({ error: 'Preference not found' }, { status: 404 })
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
  const profile = await deletePreference(userId, id)
  return profile
    ? NextResponse.json(profile)
    : NextResponse.json({ error: 'Preference not found' }, { status: 404 })
}
