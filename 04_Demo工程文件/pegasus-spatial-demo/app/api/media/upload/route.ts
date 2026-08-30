import { NextRequest, NextResponse } from 'next/server'
import { resolveLocalOwner } from '@/lib/local-owner'
import { getConversation } from '@/lib/db/repository'
import { buildMediaPublicUrl } from '@/lib/media/public-url'
import { toRasterAssetRef } from '@/lib/media/reference'
import { writeImageAsset } from '@/lib/media/storage'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MAX_FILE_SIZE = 20 * 1024 * 1024

/**
 * Accept one binary browser upload and return an opaque asset reference.
 * Base64 exists only transiently inside the image processor; it is never sent
 * in chat JSON, written to Conversation.messages, or forwarded to the gateway.
 */
export async function POST(req: NextRequest) {
  const userId = await resolveLocalOwner()
  if (userId instanceof Response) return userId

  try {
    // Fail before writing an orphan if the provider-facing origin is not ready.
    buildMediaPublicUrl('A'.repeat(43))

    const form = await req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: '缺少图片文件' }, { status: 400 })
    }
    if (file.size <= 0 || file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: '单张图片不能超过 20MB' }, { status: 413 })
    }

    const rawConversationId = form.get('conversationId')
    const conversationId = typeof rawConversationId === 'string' && rawConversationId.trim()
      ? rawConversationId.trim()
      : undefined
    if (conversationId && !await getConversation(conversationId, userId)) {
      return NextResponse.json({ error: '对话不存在' }, { status: 404 })
    }
    const input = Buffer.from(await file.arrayBuffer())
    const stored = await writeImageAsset({
      ownerUserId: userId,
      conversationId,
      buffer: input,
      mimeType: file.type,
      source: 'user_upload',
    })

    return NextResponse.json({
      image: toRasterAssetRef(stored),
      mimeCorrection: file.type && file.type !== stored.mimeType
        ? { claimed: file.type, detected: stored.mimeType }
        : null,
    })
  } catch (err) {
    const message = (err as Error).message
    const configurationError = message.includes('MEDIA_PUBLIC_BASE_URL') || message.includes('图片 URL 模式')
    const invalidImage = /无法解析图片内容|仅支持 PNG|图片 MIME 与文件内容不一致/.test(message)
    return NextResponse.json(
      {
        error: message,
        code: configurationError
          ? 'media_public_url_unavailable'
          : invalidImage ? 'invalid_image' : 'image_upload_failed',
      },
      { status: configurationError ? 503 : invalidImage ? 415 : 500 },
    )
  }
}
