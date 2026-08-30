import { NextRequest, NextResponse } from 'next/server'
import { enqueueMessage } from '@/lib/agent/message-queue'
import type { ImageAttachment } from '@/lib/types'
import { resolveLocalOwner } from '@/lib/local-owner'
import { claimImageAsset } from '@/lib/media/storage'
import { MEDIA_ASSET_ID_PATTERN } from '@/lib/media/public-url'
import { getConversation } from '@/lib/db/repository'
import { getActiveAgentRun } from '@/lib/agent-runtime/repository'

export const dynamic = 'force-dynamic'

/**
 * Mid-turn message endpoint — accepts user messages while the agent loop is running.
 * Messages are queued and consumed by the agent loop between tool execution rounds.
 */
export async function POST(req: NextRequest) {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId

  const { conversation_id, message, images } = await req.json() as {
    conversation_id: string
    message: string
    images?: ImageAttachment[]
  }

  if (!conversation_id || !message) {
    return NextResponse.json({ error: 'conversation_id and message are required' }, { status: 400 })
  }

  if (!await getConversation(conversation_id, userId)) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }

  const activeRun = await getActiveAgentRun(conversation_id, userId)
  if (!activeRun || !['queued', 'running'].includes(activeRun.status)) {
    return NextResponse.json({ error: 'No active agent loop for this conversation' }, { status: 409 })
  }

  const MAX_IMAGES_PER_MESSAGE = 5
  if ((images?.length ?? 0) > MAX_IMAGES_PER_MESSAGE) {
    return NextResponse.json(
      { error: `一次最多上传 ${MAX_IMAGES_PER_MESSAGE} 张图片`, code: 'too_many_images' },
      { status: 400 },
    )
  }

  const claimedImages: ImageAttachment[] = []
  for (const image of images ?? []) {
    if (!image || !('assetId' in image) || !MEDIA_ASSET_ID_PATTERN.test(image.assetId)) {
      return NextResponse.json({ error: '图片资产引用无效，请重新上传' }, { status: 400 })
    }
    const claimed = await claimImageAsset(image.assetId, userId, conversation_id)
    if (!claimed) {
      return NextResponse.json({ error: '图片资产不存在或不属于当前用户' }, { status: 400 })
    }
    claimedImages.push({
      assetId: claimed.assetId,
      mimeType: claimed.mimeType,
      width: claimed.width,
      height: claimed.height,
    })
  }

  await enqueueMessage(
    conversation_id,
    message,
    claimedImages.length ? claimedImages : undefined,
    activeRun.run_id,
  )

  return NextResponse.json({ queued: true, run_id: activeRun.run_id })
}
