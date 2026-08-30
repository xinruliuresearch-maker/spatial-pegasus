import { NextRequest, NextResponse } from 'next/server'
import { MEDIA_ASSET_ID_PATTERN } from '@/lib/media/public-url'
import { buildOSSObjectPublicUrl } from '@/lib/media/public-url'
import { getImageAsset, readImageAsset } from '@/lib/media/storage'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Public capability URL consumed by model providers.
 *
 * The 256-bit random asset ID is the access capability. No user/session cookie
 * is required because Anthropic/OpenRouter/NewAPI fetches this URL server-side.
 * Only validated raster uploads can enter this bucket.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ assetId: string }> },
) {
  const { assetId } = await params
  if (!MEDIA_ASSET_ID_PATTERN.test(assetId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  try {
    const asset = await getImageAsset(assetId)
    if (!asset || asset.state === 'deleted') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    if (asset.storageDriver === 'oss') {
      return NextResponse.redirect(buildOSSObjectPublicUrl(asset.variants.original.storageKey), {
        status: 307,
        headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
      })
    }

    const found = await readImageAsset(assetId)
    if (!found || !found.asset.mimeType.startsWith('image/')) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    return new NextResponse(new Uint8Array(found.buffer), {
      headers: {
        'Content-Type': found.asset.mimeType,
        'Content-Length': found.buffer.length.toString(),
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
      },
    })
  } catch (err) {
    console.error('[media] failed to read asset:', (err as Error).message)
    return NextResponse.json({ error: 'Media unavailable' }, { status: 500 })
  }
}

export async function HEAD(req: NextRequest, context: { params: Promise<{ assetId: string }> }) {
  const response = await GET(req, context)
  return new NextResponse(null, { status: response.status, headers: response.headers })
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Range',
      'Access-Control-Max-Age': '86400',
    },
  })
}
