import assert from 'node:assert/strict'
import { buildBrowserMediaUrl } from '../browser-url'
import {
  buildProviderRasterAliasObjectKey,
  buildRasterAssetObjectKey,
  DEFAULT_MEDIA_OBJECT_PREFIX,
  getMediaObjectPrefix,
  validateMediaObjectPrefixConfiguration,
} from '../object-prefix'
import { buildMediaPublicUrl } from '../public-url'
import { getOSSMediaConfig } from '../config'
import { isRetryableOSSWriteError } from '../storage'

const assetId = 'A'.repeat(43)

process.env.MEDIA_STORAGE_DRIVER = 'oss'
process.env.OSS_REGION = 'oss-test-region'
process.env.OSS_BUCKET = 'test-bucket'
process.env.OSS_ACCESS_KEY_ID = 'test-access-id'
process.env.OSS_ACCESS_KEY_SECRET = 'test-access-secret'
process.env.OSS_CDN_BASE_URL = 'https://media.example.test'
process.env.NEXT_PUBLIC_MEDIA_CDN_BASE_URL = 'https://media.example.test'
delete process.env.OSS_REQUEST_TIMEOUT_MS
delete process.env.OSS_UPLOAD_ATTEMPTS
delete process.env.PEGASUS_SPATIAL_MEDIA_PREFIX

assert.equal(getOSSMediaConfig().requestTimeoutMs, 120_000)
assert.equal(getOSSMediaConfig().uploadAttempts, 3)
assert.equal(isRetryableOSSWriteError(new Error('Response timeout for 30000ms')), true)
assert.equal(isRetryableOSSWriteError({ status: 503, message: 'service unavailable' }), true)
assert.equal(isRetryableOSSWriteError({ status: 403, message: 'forbidden' }), false)

delete process.env.NEXT_PUBLIC_PEGASUS_SPATIAL_MEDIA_PREFIX
assert.equal(getMediaObjectPrefix(), DEFAULT_MEDIA_OBJECT_PREFIX)
assert.equal(
  buildRasterAssetObjectKey(assetId, 'original'),
  `raster-assets/pegasus-spatial/${assetId}/original`,
)

process.env.NEXT_PUBLIC_PEGASUS_SPATIAL_MEDIA_PREFIX = 'pegasus-spatial-v2/media/raster'
const expectedPath = `pegasus-spatial-v2/media/raster/${assetId}/thumbnail`
assert.equal(buildRasterAssetObjectKey(assetId, 'thumbnail'), expectedPath)
assert.equal(
  buildProviderRasterAliasObjectKey(buildRasterAssetObjectKey(assetId, 'original'), 'image/png'),
  `${buildRasterAssetObjectKey(assetId, 'original')}.png`,
)
assert.equal(
  buildProviderRasterAliasObjectKey(buildRasterAssetObjectKey(assetId, 'original'), 'image/jpeg'),
  `${buildRasterAssetObjectKey(assetId, 'original')}.jpg`,
)
assert.equal(
  buildMediaPublicUrl(assetId, 'thumbnail'),
  `https://media.example.test/${expectedPath}`,
  'server public URL must address the exact key written by OSS storage',
)
assert.equal(
  buildBrowserMediaUrl(assetId, 'thumbnail'),
  `https://media.example.test/${expectedPath}`,
  'browser CDN URL must use the same public prefix as the server',
)

for (const invalid of ['', '/media/raster', 'media/raster/', 'media//raster', 'media/../raster', 'media/raster?private=1']) {
  process.env.NEXT_PUBLIC_PEGASUS_SPATIAL_MEDIA_PREFIX = invalid
  assert.throws(
    () => getMediaObjectPrefix(),
    /NEXT_PUBLIC_PEGASUS_SPATIAL_MEDIA_PREFIX/,
    `invalid prefix ${JSON.stringify(invalid)} must fail closed`,
  )
}

assert.deepEqual(
  validateMediaObjectPrefixConfiguration(undefined, DEFAULT_MEDIA_OBJECT_PREFIX).failures,
  [],
  'the former default may coexist during migration because it matches the canonical default',
)
assert.equal(
  validateMediaObjectPrefixConfiguration('new/media', 'old/media').failures[0]?.variable,
  'PEGASUS_SPATIAL_MEDIA_PREFIX',
  'a legacy/private prefix that would diverge from browser URLs must fail closed',
)

console.log('media object prefix consistency verification passed')
