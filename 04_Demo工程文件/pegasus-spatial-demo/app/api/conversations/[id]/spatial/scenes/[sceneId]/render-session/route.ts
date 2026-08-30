import { NextRequest, NextResponse } from 'next/server'
import { resolveLocalOwner } from '@/lib/local-owner'
import { heartbeatSpatialRenderSession, registerSpatialRenderSession, releaseSpatialRenderSession } from '@/lib/spatial'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; sceneId: string }> }) {
  const userId = await resolveLocalOwner(); if (userId instanceof Response) return userId
  const { id, sceneId } = await params
  try {
    const body = await request.json() as { client_id?: unknown }
    if (typeof body.client_id !== 'string') return NextResponse.json({ error: 'client_id required' }, { status: 400 })
    const session = await registerSpatialRenderSession({ scope: { projectId: id, userId }, sceneId, clientId: body.client_id })
    return NextResponse.json({ session })
  } catch { return NextResponse.json({ error: 'Unable to register render session' }, { status: 400 }) }
}

export async function PATCH(request: NextRequest) {
  const userId = await resolveLocalOwner(); if (userId instanceof Response) return userId
  const body = await request.json() as { session_id?: unknown; lease_token?: unknown }
  if (typeof body.session_id !== 'string' || typeof body.lease_token !== 'string') return NextResponse.json({ error: 'invalid heartbeat' }, { status: 400 })
  const alive = await heartbeatSpatialRenderSession({ sessionId: body.session_id, leaseToken: body.lease_token })
  return NextResponse.json({ alive }, { status: alive ? 200 : 409 })
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string; sceneId: string }> }) {
  const userId = await resolveLocalOwner(); if (userId instanceof Response) return userId
  const { id, sceneId } = await params
  const body = await request.json() as { session_id?: unknown; lease_token?: unknown }
  if (typeof body.session_id !== 'string' || typeof body.lease_token !== 'string') return NextResponse.json({ error: 'invalid session release' }, { status: 400 })
  const released = await releaseSpatialRenderSession({
    scope: { projectId: id, userId },
    sceneId,
    sessionId: body.session_id,
    leaseToken: body.lease_token,
  })
  return NextResponse.json({ released })
}
