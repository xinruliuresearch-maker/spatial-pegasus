import type { RasterAssetVariant } from '@/lib/types'
import { buildRasterAssetObjectKey } from './object-prefix'

export const MEDIA_ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/

type LegacyStorageDriver = 'gridfs' | 'oss'

function browserCdnOrigin(): string | null {
  const configured = process.env.NEXT_PUBLIC_MEDIA_CDN_BASE_URL?.trim()
  if (!configured) return null
  try {
    const parsed = new URL(configured)
    return parsed.protocol === 'https:' ? parsed.origin : null
  } catch {
    return null
  }
}

function encodedPath(...segments: string[]): string {
  return segments.map(encodeURIComponent).join('/')
}

/**
 * Construct a browser-facing media URL without touching the Pegasus Spatial API.
 *
 * New assets have immutable, deterministic OSS keys, so their opaque assetId
 * is sufficient to address the CDN directly. The application redirect remains
 * only for legacy GridFS assets and as a safe local fallback when the public
 * CDN origin is not configured in the browser bundle.
 */
export function buildBrowserMediaUrl(
  assetId: string,
  variant: RasterAssetVariant = 'model',
  legacyStorageDriver?: LegacyStorageDriver,
): string {
  if (!MEDIA_ASSET_ID_PATTERN.test(assetId)) {
    throw new Error('Invalid media asset ID')
  }

  const cdnOrigin = browserCdnOrigin()
  if (legacyStorageDriver === 'gridfs' || !cdnOrigin) {
    const suffix = legacyStorageDriver === 'gridfs' ? '' : `/${variant}`
    return `/api/media/${encodeURIComponent(assetId)}${suffix}`
  }

  // Compatibility for the pre-variant OSS writer.
  if (legacyStorageDriver === 'oss') {
    return `${cdnOrigin}/${encodedPath('llm-images', assetId)}`
  }

  return `${cdnOrigin}/${encodedPath(...buildRasterAssetObjectKey(assetId, variant).split('/'))}`
}

export function buildBrowserMediaUrls(
  assetId: string,
  legacyStorageDriver?: LegacyStorageDriver,
): Record<RasterAssetVariant, string> {
  return {
    original: buildBrowserMediaUrl(assetId, 'original', legacyStorageDriver),
    model: buildBrowserMediaUrl(assetId, 'model', legacyStorageDriver),
    thumbnail: buildBrowserMediaUrl(assetId, 'thumbnail', legacyStorageDriver),
  }
}
