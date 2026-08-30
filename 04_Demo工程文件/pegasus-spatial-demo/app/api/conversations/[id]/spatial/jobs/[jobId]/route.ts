import { NextRequest, NextResponse } from 'next/server'
import { resolveLocalOwner } from '@/lib/local-owner'
import { connectDB } from '@/lib/db/mongodb'
import { Conversation } from '@/lib/db/models'
import {
  getSpatialJobResult,
  SpatialJobCommandRejectedError,
} from '@/lib/spatial'

export const dynamic = 'force-dynamic'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; jobId: string }> },
) {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId

  const { id, jobId } = await params
  await connectDB()
  if (!await Conversation.exists({ conversation_id: id, user_id: userId })) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }

  try {
    const job = await getSpatialJobResult({
      jobId,
      scope: { projectId: id, userId },
    })
    return NextResponse.json({ job })
  } catch (error) {
    // Do not disclose whether an unscoped job id exists for another user or
    // project. The durable repository applies the same project + owner fence.
    if (error instanceof SpatialJobCommandRejectedError) {
      return NextResponse.json({ error: 'Spatial job not found' }, { status: 404 })
    }
    return NextResponse.json(
      { error: 'Unable to read spatial job status' },
      { status: 500 },
    )
  }
}
