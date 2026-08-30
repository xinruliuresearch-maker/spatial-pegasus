import { NextRequest, NextResponse } from 'next/server'
import { resolveLocalOwner } from '@/lib/local-owner'
import { claimSpatialRenderCommand } from '@/lib/spatial'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; sceneId: string }> }) {
  const userId = await resolveLocalOwner(); if (userId instanceof Response) return userId
  const { id, sceneId } = await params
  const body = await request.json() as { session_id?: unknown; lease_token?: unknown }
  if (typeof body.session_id !== 'string' || typeof body.lease_token !== 'string') return NextResponse.json({ error: 'invalid session' }, { status: 400 })
  const command = await claimSpatialRenderCommand({ scope: { projectId: id, userId }, sceneId, sessionId: body.session_id, leaseToken: body.lease_token })
  return NextResponse.json({ command })
}
