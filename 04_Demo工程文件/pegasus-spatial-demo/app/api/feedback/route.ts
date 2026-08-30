import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { connectDB } from '@/lib/db/mongodb'
import { Feedback } from '@/lib/db/feedback-models'
import { resolveLocalOwner } from '@/lib/local-owner'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId

  const { content, page_url } = await req.json()

  if (!content || typeof content !== 'string' || !content.trim()) {
    return NextResponse.json({ error: '请输入反馈内容' }, { status: 400 })
  }

  await connectDB()
  await Feedback.create({
    feedback_id: randomUUID(),
    user_id: userId,
    content: content.trim(),
    page_url: page_url || '',
  })

  return NextResponse.json({ success: true }, { status: 201 })
}
