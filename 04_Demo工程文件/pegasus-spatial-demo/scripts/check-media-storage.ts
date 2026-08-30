import { randomBytes } from 'crypto'
import OSS from 'ali-oss'
import mongoose from 'mongoose'
import { connectDB } from '../lib/db/mongodb'
import { getOSSMediaConfig } from '../lib/media/config'
import { ImageAsset } from '../lib/media/model'
import { buildRasterAssetObjectKey } from '../lib/media/object-prefix'
import { buildOSSObjectPublicUrl } from '../lib/media/public-url'
import { loadProjectEnv } from './load-project-env'

loadProjectEnv()

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

function ossClient() {
  const config = getOSSMediaConfig()
  return new OSS({
    region: config.region, bucket: config.bucket,
    accessKeyId: config.accessKeyId, accessKeySecret: config.accessKeySecret,
    stsToken: config.stsToken, endpoint: config.endpoint,
  })
}

async function verifyCdn(url: string) {
  const head = await fetch(url, { method: 'HEAD', redirect: 'follow' })
  if (!head.ok) throw new Error(`CDN HEAD failed: HTTP ${head.status}`)
  const contentType = head.headers.get('content-type') || ''
  if (!contentType.toLowerCase().startsWith('image/')) {
    throw new Error(`CDN MIME invalid: expected image/*, got ${contentType || '(missing)'}`)
  }
  const cors = head.headers.get('access-control-allow-origin')
  if (cors !== '*') throw new Error(`CDN CORS invalid: expected *, got ${cors || '(missing)'}`)
  const options = await fetch(url, {
    method: 'OPTIONS',
    headers: { Origin: process.env.APP_PUBLIC_URL || 'http://localhost:3200', 'Access-Control-Request-Method': 'GET' },
  })
  if (!options.ok) throw new Error(`CDN OPTIONS failed: HTTP ${options.status}`)
  const allowedMethods = (options.headers.get('access-control-allow-methods') || '').toUpperCase()
  // Access-Control-Allow-Methods lists the actual resource methods that a
  // preflight authorizes. OPTIONS is the preflight transport itself and does
  // not need to be listed in this response header.
  for (const method of ['GET', 'HEAD']) {
    if (!allowedMethods.split(/\s*,\s*/).includes(method)) {
      throw new Error(`CDN CORS methods missing ${method}: ${allowedMethods || '(missing)'}`)
    }
  }
  const corp = head.headers.get('cross-origin-resource-policy')
  if (corp && corp.toLowerCase() !== 'cross-origin') {
    throw new Error(`CDN CORP invalid: expected cross-origin, got ${corp}`)
  }
  console.log(`[media:check] CDN OK ${url} (${contentType}; CORS GET/HEAD + OPTIONS preflight)`)
}

async function main() {
  const writeProbe = process.argv.includes('--write-probe')
  const explicitId = process.argv.find(arg => arg.startsWith('--asset-id='))?.split('=')[1]
  let probeKey: string | null = null
  try {
    if (writeProbe) {
      // Exercise the exact prefix used by production writers so a least-
      // privilege RAM policy does not need a separate diagnostics grant.
      probeKey = buildRasterAssetObjectKey(randomBytes(32).toString('base64url'), 'original')
      await ossClient().put(probeKey, ONE_PIXEL_PNG, {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' },
      })
      const result = await ossClient().get(probeKey)
      if (!Buffer.from(result.content).equals(ONE_PIXEL_PNG)) throw new Error('OSS read-after-write checksum mismatch')
      await verifyCdn(buildOSSObjectPublicUrl(probeKey))
      await ossClient().delete(probeKey)
      probeKey = null
      console.log('[media:check] OSS write/read/CDN/delete permissions verified')
      return
    }

    await connectDB()
    const doc = explicitId
      ? await ImageAsset.findOne({ asset_id: explicitId, state: { $ne: 'deleted' } }).lean()
      : await ImageAsset.findOne({ state: { $ne: 'deleted' }, 'variants.model.storage_key': { $exists: true } })
        .sort({ created_at: -1 }).lean()
    const key = doc?.variants?.model?.storage_key
    if (!key) throw new Error('No image asset found. Pass --write-probe for an explicit temporary probe.')
    await verifyCdn(buildOSSObjectPublicUrl(key))
    console.log('[media:check] read-only check completed; no object was created')
  } finally {
    if (probeKey) {
      await ossClient().delete(probeKey).catch(error => {
        console.error('[media:check] WARNING: temporary probe cleanup failed:', (error as Error).message)
      })
    }
  }
}

main()
  .catch(error => { console.error('[media:check] failed:', error); process.exitCode = 1 })
  .finally(async () => { await mongoose.disconnect() })
