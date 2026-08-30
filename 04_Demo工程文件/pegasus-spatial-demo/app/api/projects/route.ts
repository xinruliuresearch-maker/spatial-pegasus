import { NextRequest, NextResponse } from 'next/server'
import { listProjects } from '@/lib/db/repository'
import { resolveLocalOwner } from '@/lib/local-owner'
import { hideInternalWorkspaceState } from '@/lib/workspace/public-view'

export async function GET(req: NextRequest) {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId

  try {
    const { searchParams } = req.nextUrl
    const page = Math.max(1, Number(searchParams.get('page') ?? 1))
    const limit = Math.min(50, Math.max(1, Number(searchParams.get('limit') ?? 20)))
    const search = searchParams.get('search') ?? undefined

    const { data, total } = await listProjects(userId, page, limit, search)

    const projects = data.map(d => {
      const project = d.toObject() as Record<string, unknown>
      hideInternalWorkspaceState(project)
      return project
    })

    return NextResponse.json({
      projects,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    })
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    )
  }
}
