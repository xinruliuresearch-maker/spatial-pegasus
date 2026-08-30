import { NextRequest, NextResponse } from 'next/server'
import { resolveLocalOwner } from '@/lib/local-owner'
import { connectDB } from '@/lib/db/mongodb'
import { Conversation } from '@/lib/db/models'
import { DurableCompactionJobModel } from '@/lib/agent-compaction/models'
import type { DurableCompactionStatus } from '@/lib/agent-compaction/types'
import { resolvePublicCompactionCapacity } from '@/lib/agent-compaction/public-capacity'
import { getAliasCapabilities, type FrozenModelResolutionSnapshot } from '@/lib/llm-registry'

export const dynamic = 'force-dynamic'

interface PublicCompactionJob {
  job_id: string
  status: DurableCompactionStatus
  attempt: number
  model_alias_snapshot?: string | null
  model_resolution_snapshot?: FrozenModelResolutionSnapshot | null
  available_at?: Date | null
  last_error?: string | null
  created_at: Date
  updated_at: Date
  finished_at?: Date | null
}

function publicCompactionStatus(
  conversationId: string,
  job: PublicCompactionJob,
): Record<string, unknown> {
  const modelCapacity = resolvePublicCompactionCapacity(job, getAliasCapabilities)
  return {
    type: 'compaction_status',
    conversation_id: conversationId,
    job_id: job.job_id,
    status: job.status,
    attempt: job.attempt,
    available_at: job.available_at ?? null,
    last_error: job.last_error ?? null,
    created_at: job.created_at,
    updated_at: job.updated_at,
    finished_at: job.finished_at ?? null,
    ...(modelCapacity ?? {}),
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId

  const { id } = await params
  await connectDB()
  if (!await Conversation.exists({ conversation_id: id, user_id: userId })) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }

  const job = await DurableCompactionJobModel.findOne({
    owner_kind: 'conversation',
    owner_key: `conversation:${id}`,
    conversation_id: id,
    user_id: userId,
  }).sort({ created_at: -1, _id: -1 }).select(
    'job_id status attempt model_alias_snapshot model_resolution_snapshot available_at last_error created_at updated_at finished_at',
  ).lean<PublicCompactionJob>()

  return NextResponse.json({
    conversation_id: id,
    compaction: job ? publicCompactionStatus(id, job) : null,
  })
}
