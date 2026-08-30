// The OSS object prefix is intentionally public configuration: browsers need
// the same value as the server in order to address immutable CDN objects
// directly. Keep one NEXT_PUBLIC_* variable instead of a private/public pair
// that can silently drift apart.

export const DEFAULT_MEDIA_OBJECT_PREFIX = 'raster-assets/pegasus-spatial'
export const MEDIA_OBJECT_PREFIX_ENV = 'NEXT_PUBLIC_PEGASUS_SPATIAL_MEDIA_PREFIX'
export const LEGACY_MEDIA_OBJECT_PREFIX_ENV = 'PEGASUS_SPATIAL_MEDIA_PREFIX'

const PREFIX_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const MAX_PREFIX_LENGTH = 240

export function mediaObjectPrefixFailure(value: string): string | null {
  if (!value) return 'must not be empty'
  if (value.length > MAX_PREFIX_LENGTH) return `must be at most ${MAX_PREFIX_LENGTH} characters`
  if (value.startsWith('/') || value.endsWith('/')) return 'must not start or end with a slash'

  const segments = value.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    return 'must contain only non-empty, non-traversing path segments'
  }
  if (segments.some(segment => !PREFIX_SEGMENT_PATTERN.test(segment))) {
    return 'segments may contain only letters, numbers, dot, underscore, and hyphen'
  }
  return null
}

export interface MediaObjectPrefixConfigurationFailure {
  variable: typeof MEDIA_OBJECT_PREFIX_ENV | typeof LEGACY_MEDIA_OBJECT_PREFIX_ENV
  reason: string
}

/**
 * Validate deployment configuration without reading secrets or mutating the
 * environment. The legacy variable may temporarily coexist only when it is
 * exactly equal to the canonical public value (or its fixed default).
 */
export function validateMediaObjectPrefixConfiguration(
  publicValue: string | undefined,
  legacyValue: string | undefined,
): { prefix: string; failures: MediaObjectPrefixConfigurationFailure[] } {
  const prefix = publicValue === undefined ? DEFAULT_MEDIA_OBJECT_PREFIX : publicValue.trim()
  const failures: MediaObjectPrefixConfigurationFailure[] = []
  const invalid = mediaObjectPrefixFailure(prefix)
  if (invalid) failures.push({ variable: MEDIA_OBJECT_PREFIX_ENV, reason: invalid })

  if (legacyValue !== undefined && legacyValue.trim() !== prefix) {
    failures.push({
      variable: LEGACY_MEDIA_OBJECT_PREFIX_ENV,
      reason: `legacy value must be removed or exactly match ${MEDIA_OBJECT_PREFIX_ENV}`,
    })
  }
  return { prefix, failures }
}

/**
 * Resolve the canonical prefix used by both server and browser bundles.
 *
 * The default is part of the product isolation contract. When overriding it,
 * the public variable must be set at build time as well as server runtime.
 */
export function getMediaObjectPrefix(): string {
  const configured = process.env.NEXT_PUBLIC_PEGASUS_SPATIAL_MEDIA_PREFIX
  const value = configured === undefined
    ? DEFAULT_MEDIA_OBJECT_PREFIX
    : configured.trim()
  const failure = mediaObjectPrefixFailure(value)
  if (failure) {
    throw new Error(`${MEDIA_OBJECT_PREFIX_ENV} ${failure}`)
  }
  return value
}

/** Immutable key shared by the OSS writer and both URL constructors. */
export function buildRasterAssetObjectKey(assetId: string, variant: string): string {
  return `${getMediaObjectPrefix()}/${assetId}/${variant}`
}

/**
 * Aholo validates the filename extension in remote image URLs before it
 * fetches the bytes. Workspace assets deliberately use extension-less,
 * immutable variant keys, so expose an equally immutable delivery alias whose
 * suffix is derived from the sniffed MIME type rather than user input.
 */
export function providerRasterExtension(mimeType: string): 'png' | 'jpg' | 'webp' {
  if (mimeType === 'image/png') return 'png'
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/webp') return 'webp'
  throw new Error(`Unsupported provider raster MIME type: ${mimeType}`)
}

export function buildProviderRasterAliasObjectKey(
  originalStorageKey: string,
  mimeType: string,
): string {
  if (!originalStorageKey || originalStorageKey.startsWith('/') || originalStorageKey.includes('..')) {
    throw new Error('Invalid original raster storage key')
  }
  return `${originalStorageKey}.${providerRasterExtension(mimeType)}`
}
