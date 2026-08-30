import { NextRequest, NextResponse } from 'next/server'
import { RASTER_ASSET_VARIANTS, type RasterAssetVariantName } from '@/lib/media/model'
import { providerRasterExtension } from '@/lib/media/object-prefix'
import { buildOSSObjectPublicUrl, MEDIA_ASSET_ID_PATTERN } from '@/lib/media/public-url'
import { getImageAsset, readImageAsset } from '@/lib/media/storage'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const VARIANTS = new Set<string>(RASTER_ASSET_VARIANTS)

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ assetId: string; variant: string }> },
) {
  const { assetId, variant: rawVariant } = await params
  const providerMatch = /^provider\.(png|jpg|webp)$/.exec(rawVariant)
  if (!MEDIA_ASSET_ID_PATTERN.test(assetId) || (!VARIANTS.has(rawVariant) && !providerMatch)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const variant: RasterAssetVariantName = providerMatch
    ? 'original'
    : rawVariant as RasterAssetVariantName

  try {
    const asset = await getImageAsset(assetId)
    if (!asset || asset.state === 'deleted') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    if (providerMatch && providerMatch[1] !== providerRasterExtension(asset.variants.original.mimeType)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    if (asset.storageDriver === 'oss') {
      return NextResponse.redirect(buildOSSObjectPublicUrl(asset.variants[variant].storageKey), {
        status: 307,
        headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
      })
    }

    const found = await readImageAsset(assetId, variant)
    if (!found) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const selected = found.asset.variants[variant]
    return new NextResponse(new Uint8Array(found.buffer), {
      headers: {
        'Content-Type': selected.mimeType,
        'Content-Length': found.buffer.length.toString(),
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
      },
    })
  } catch (error) {
    console.error('[media] failed to read asset variant:', (error as Error).message)
    return NextResponse.json({ error: 'Media unavailable' }, { status: 500 })
  }
}

export async function HEAD(
  req: NextRequest,
  context: { params: Promise<{ assetId: string; variant: string }> },
) {
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
