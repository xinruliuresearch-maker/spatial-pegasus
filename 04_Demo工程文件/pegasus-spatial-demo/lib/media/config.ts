export type MediaStorageDriver = 'gridfs' | 'oss'

export function getMediaStorageDriver(): MediaStorageDriver {
  const configured = process.env.MEDIA_STORAGE_DRIVER?.trim().toLowerCase()
  if (!configured) return 'gridfs'
  if (configured === 'gridfs' || configured === 'oss') return configured
  throw new Error(`Unsupported MEDIA_STORAGE_DRIVER: ${configured}`)
}

export interface OSSMediaConfig {
  region: string
  bucket: string
  accessKeyId: string
  accessKeySecret: string
  stsToken?: string
  endpoint?: string
  cdnBaseUrl: string
  requestTimeoutMs: number
  uploadAttempts: number
}

function boundedPositiveInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(minimum, Math.min(maximum, Math.trunc(parsed)))
}

export function getOSSMediaConfig(): OSSMediaConfig {
  const required = {
    region: process.env.OSS_REGION?.trim(),
    bucket: process.env.OSS_BUCKET?.trim(),
    accessKeyId: process.env.OSS_ACCESS_KEY_ID?.trim(),
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET?.trim(),
    cdnBaseUrl: process.env.OSS_CDN_BASE_URL?.trim(),
  }
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key)
  if (missing.length > 0) {
    throw new Error(`OSS 图片存储缺少配置: ${missing.join(', ')}`)
  }

  let cdn: URL
  try {
    cdn = new URL(required.cdnBaseUrl!)
  } catch {
    throw new Error('OSS_CDN_BASE_URL 必须是完整的 HTTPS URL')
  }
  if (cdn.protocol !== 'https:') {
    throw new Error('OSS_CDN_BASE_URL 必须使用 HTTPS')
  }

  return {
    region: required.region!,
    bucket: required.bucket!,
    accessKeyId: required.accessKeyId!,
    accessKeySecret: required.accessKeySecret!,
    stsToken: process.env.OSS_STS_TOKEN?.trim() || undefined,
    endpoint: process.env.OSS_ENDPOINT?.trim() || undefined,
    cdnBaseUrl: cdn.origin,
    requestTimeoutMs: boundedPositiveInteger(
      process.env.OSS_REQUEST_TIMEOUT_MS,
      120_000,
      30_000,
      10 * 60_000,
    ),
    uploadAttempts: boundedPositiveInteger(process.env.OSS_UPLOAD_ATTEMPTS, 3, 1, 5),
  }
}
