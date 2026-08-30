import { NextRequest, NextResponse } from 'next/server'
import { resolveLocalOwner } from '@/lib/local-owner'
import {
  addPreference,
  getOrCreateProfile,
  MemoryProfileLimitError,
  MemoryQuotaExceededError,
} from '@/lib/memory-v2/repository'

export const dynamic = 'force-dynamic'

export async function GET() {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId
  const profile = await getOrCreateProfile(userId)
  return NextResponse.json(profile.preferences)
}

export async function POST(req: NextRequest) {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId
  const body = await req.json()
  if (!body.category?.trim() || !body.subject?.trim() || !body.statement?.trim()) {
    return NextResponse.json({ error: 'category, subject and statement are required' }, { status: 400 })
  }
  try {
    const profile = await addPreference(userId, {
      category: String(body.category).trim().slice(0, 64),
      subject: String(body.subject).trim().slice(0, 160),
      statement: String(body.statement).trim().slice(0, 800),
      scope: String(body.scope || 'general').trim().slice(0, 120),
      polarity: ['positive', 'negative', 'neutral'].includes(body.polarity) ? body.polarity : 'neutral',
      evidence_refs: [],
    })
    return NextResponse.json(profile, { status: 201 })
  } catch (error) {
    if (error instanceof MemoryProfileLimitError) {
      return NextResponse.json({ error: '长期画像最多保留 30 条有效偏好' }, { status: 409 })
    }
    if (error instanceof MemoryQuotaExceededError) {
      return NextResponse.json({ error: '本地项目记忆空间已满，请先精简或删除已有记忆' }, { status: 409 })
    }
    throw error
  }
}
