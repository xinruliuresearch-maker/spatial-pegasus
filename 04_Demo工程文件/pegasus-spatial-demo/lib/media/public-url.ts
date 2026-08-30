// ============================================================
// Public media URL resolution
//
// Conversation messages persist only an opaque Pegasus Spatial asset ID. The provider
// adapter resolves that ID to an absolute URL immediately before an LLM
// request, so changing a local tunnel or the production origin never requires
// rewriting conversation history.
// ============================================================

import { getMediaStorageDriver, getOSSMediaConfig, type MediaStorageDriver } from './config'
import type { RasterAssetVariantName } from './model'
import { buildRasterAssetObjectKey } from './object-prefix'
import { MEDIA_ASSET_ID_PATTERN } from './browser-url'

export { MEDIA_ASSET_ID_PATTERN } from './browser-url'

const LOOPBACK_OR_PRIVATE_HOST = /^(localhost|0\.0\.0\.0|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|.*\.local)$/i

/**
 * Return the stable public origin that model providers can reach.
 *
 * Production normally falls back to APP_PUBLIC_URL. Local development must set
 * MEDIA_PUBLIC_BASE_URL to a public tunnel (for example a named Cloudflare
 * Tunnel); localhost/private LAN addresses cannot be fetched by cloud models.
 */
export function getMediaPublicBaseUrl(): string {
  const raw = process.env.MEDIA_PUBLIC_BASE_URL?.trim()

  if (!raw) {
    throw new Error(
      '图片 URL 模式尚未配置：请设置 MEDIA_PUBLIC_BASE_URL。' +
      '本地开发可使用安全的公网隧道，生产环境填写 Pegasus Spatial 公网 HTTPS 地址。',
    )
  }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('MEDIA_PUBLIC_BASE_URL 必须是完整的 http(s) URL')
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('MEDIA_PUBLIC_BASE_URL 只支持 http(s) URL')
  }
  if (LOOPBACK_OR_PRIVATE_HOST.test(parsed.hostname)) {
    throw new Error(
      `MEDIA_PUBLIC_BASE_URL=${raw} 无法被云端模型访问；本地请配置公网隧道地址`,
    )
  }

  return parsed.origin
}

function objectKeyUrl(storageKey: string): string {
  const encodedPath = storageKey.split('/').map(encodeURIComponent).join('/')
  return new URL(`/${encodedPath}`, getOSSMediaConfig().cdnBaseUrl).toString()
}

/** Build a URL for an exact immutable OSS object key. */
export function buildOSSObjectPublicUrl(storageKey: string): string {
  if (!storageKey || storageKey.startsWith('/') || storageKey.includes('..')) {
    throw new Error('Invalid media storage key')
  }
  return objectKeyUrl(storageKey)
}

/**
 * Build a provider/browser URL without a database lookup.
 *
 * Passing `oss`/`gridfs` is legacy compatibility for the former single-object
 * layout. New code passes a variant (or accepts the model default).
 */
export function buildMediaPublicUrl(
  assetId: string,
  variantOrLegacyDriver: RasterAssetVariantName | MediaStorageDriver = 'model',
): string {
  if (!MEDIA_ASSET_ID_PATTERN.test(assetId)) {
    throw new Error('Invalid media asset ID')
  }
  if (variantOrLegacyDriver === 'oss') {
    return objectKeyUrl(`llm-images/${assetId}`)
  }
  if (variantOrLegacyDriver === 'gridfs') {
    return new URL(`/api/media/${encodeURIComponent(assetId)}`, getMediaPublicBaseUrl()).toString()
  }
  if (getMediaStorageDriver() === 'oss') {
    return objectKeyUrl(buildRasterAssetObjectKey(assetId, variantOrLegacyDriver))
  }
  return new URL(
    `/api/media/${encodeURIComponent(assetId)}/${variantOrLegacyDriver}`,
    getMediaPublicBaseUrl(),
  ).toString()
}
