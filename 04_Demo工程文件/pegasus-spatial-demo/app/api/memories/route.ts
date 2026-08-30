import { NextRequest, NextResponse } from 'next/server'
import { listMemories } from '@/lib/db/memory-repository'
import type { MemoryType } from '@/lib/db/memory-models'
import { resolveLocalOwner } from '@/lib/local-owner'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId

  const type = req.nextUrl.searchParams.get('type') as MemoryType | null
  const filter = type ? { type } : undefined
  const memories = await listMemories(userId, filter)
  return NextResponse.json(memories.map(m => ({
    memory_id: m.memory_id,
    name: m.name,
    description: m.description,
    type: m.type,
    content: m.content,
    tags: m.tags,
    access_count: m.access_count,
    last_accessed_at: m.last_accessed_at,
    created_at: m.created_at,
    updated_at: m.updated_at,
  })))
}

export async function POST(req: NextRequest) {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId

  void req
  return NextResponse.json({ error: 'Memory V1 is read-only; use /api/memory/*' }, { status: 410 })
}
