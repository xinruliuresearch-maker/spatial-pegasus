import { NextRequest, NextResponse } from 'next/server'
import { getMemory } from '@/lib/db/memory-repository'
import { resolveLocalOwner } from '@/lib/local-owner'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId

  const { id } = await params
  const memory = await getMemory(id, userId)
  if (!memory) {
    return NextResponse.json({ error: 'Memory not found' }, { status: 404 })
  }
  return NextResponse.json({
    memory_id: memory.memory_id,
    name: memory.name,
    description: memory.description,
    type: memory.type,
    content: memory.content,
    tags: memory.tags,
    access_count: memory.access_count,
    last_accessed_at: memory.last_accessed_at,
    created_at: memory.created_at,
    updated_at: memory.updated_at,
  })
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId

  void req; void params; void userId
  return NextResponse.json({ error: 'Memory V1 is read-only; use /api/memory/*' }, { status: 410 })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId

  void params; void userId
  return NextResponse.json({ error: 'Memory V1 is read-only; use /api/memory/*' }, { status: 410 })
}
