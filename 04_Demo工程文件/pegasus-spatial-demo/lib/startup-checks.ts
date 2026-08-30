/**
 * Runtime environment preflight. Called once from `instrumentation.ts` before
 * the server starts serving requests. Anything required to run in production
 * but commonly forgotten (secrets, API keys, deploy URLs) goes here — we fail
 * loud on boot instead of leaving users to trip on obscure errors mid-request.
 */

import * as mediaObjectPrefix from './media/object-prefix'

interface CheckFailure {
  variable: string
  reason: string
}

const MIN_INTERNAL_SECRET_LEN = 32
const SECRET_PLACEHOLDER_VALUES = new Set([
  'change-me-in-production',
  'your-secret-here',
  'replace-with-a-random-secret',
  'replace-with-at-least-32-random-characters',
  'replace-with-a-second-random-secret-at-least-32-characters',
  'replace-with-a-third-random-secret-at-least-32-characters',
  'secret',
])

function hasValidHostAllowlist(value: string | undefined): boolean {
  const entries = value?.split(',').map(item => item.trim().toLowerCase()).filter(Boolean) ?? []
  return entries.length > 0 && entries.every(host => (
    /^[a-z0-9.-]+$/.test(host)
    && !host.startsWith('.')
    && !host.endsWith('.')
    && !host.includes('..')
    && !['localhost', 'metadata.google.internal'].includes(host)
  ))
}

function isProviderReachableHttpsOrigin(value: string | undefined): boolean {
  if (!value?.trim()) return false
  try {
    const parsed = new URL(value)
    const privateHost = /^(localhost|0\.0\.0\.0|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|.*\.local)$/i.test(parsed.hostname)
    return parsed.protocol === 'https:' && !privateHost && !parsed.username && !parsed.password
  } catch {
    return false
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === 'localhost'
    || normalized === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(normalized)
}

function newApiBaseUrlFailure(
  value: string,
  production: boolean,
  allowInsecureDevelopmentHttp: boolean,
): string | null {
  try {
    const parsed = new URL(value)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return 'must use the HTTP or HTTPS protocol'
    }
    if (parsed.username || parsed.password) {
      return 'must not contain embedded credentials'
    }
    if (parsed.search || parsed.hash) {
      return 'must not contain a query string or fragment'
    }
    if (parsed.protocol === 'http:') {
      if (production) return 'must use HTTPS in production'
      if (!isLoopbackHostname(parsed.hostname) && !allowInsecureDevelopmentHttp) {
        return 'plain HTTP is allowed only for loopback development URLs unless PEGASUS_SPATIAL_ALLOW_INSECURE_NEWAPI_HTTP=1 is explicitly set'
      }
    }
    return null
  } catch {
    return 'must be a complete HTTP(S) URL'
  }
}

export function runStartupChecks(): void {
  const failures: CheckFailure[] = []
  const mediaDriver = process.env.MEDIA_STORAGE_DRIVER?.trim().toLowerCase()

  // OSS keys are constructed in both server and browser code. A single
  // intentionally-public value prevents writers and CDN readers from drifting.
  failures.push(...mediaObjectPrefix.validateMediaObjectPrefixConfiguration(
    process.env.NEXT_PUBLIC_PEGASUS_SPATIAL_MEDIA_PREFIX,
    process.env.PEGASUS_SPATIAL_MEDIA_PREFIX,
  ).failures)

  // LLM gateway credentials. Without these no request can reach the model.
  for (const key of ['LLM_BASE_URL', 'LLM_API_KEY_ORCHESTRATOR', 'LLM_API_KEY_TOOLS']) {
    if (!process.env[key]) failures.push({ variable: key, reason: 'not set (required)' })
  }
  const llmBaseUrl = process.env.LLM_BASE_URL?.trim()
  if (llmBaseUrl) {
    const reason = newApiBaseUrlFailure(
      llmBaseUrl,
      process.env.NODE_ENV === 'production',
      process.env.PEGASUS_SPATIAL_ALLOW_INSECURE_NEWAPI_HTTP === '1',
    )
    if (reason) failures.push({ variable: 'LLM_BASE_URL', reason })
  }
  const imageModel = process.env.PEGASUS_SPATIAL_IMAGE_MODEL?.trim() || 'GPT-image-2'
  if (imageModel !== 'GPT-image-2') {
    failures.push({
      variable: 'PEGASUS_SPATIAL_IMAGE_MODEL',
      reason: 'must be the exact case-sensitive NewAPI alias GPT-image-2',
    })
  }

  // MongoDB URI. Covered by a throw in lib/db/mongodb.ts too, but catching here
  // surfaces the misconfiguration earlier in the boot sequence.
  if (!process.env.MONGODB_URI) {
    failures.push({ variable: 'MONGODB_URI', reason: 'not set (required)' })
  }

  if (process.env.AGENT_RUNTIME_BACKGROUND_RUNNER === '1') {
    const runnerSecret = process.env.AGENT_RUNTIME_INTERNAL_SECRET
    if (!runnerSecret) {
      failures.push({
        variable: 'AGENT_RUNTIME_INTERNAL_SECRET',
        reason: 'not set (required when the durable background runner is enabled)',
      })
    } else if (runnerSecret.length < MIN_INTERNAL_SECRET_LEN) {
      failures.push({
        variable: 'AGENT_RUNTIME_INTERNAL_SECRET',
        reason: `length ${runnerSecret.length} < ${MIN_INTERNAL_SECRET_LEN}`,
      })
    } else if (SECRET_PLACEHOLDER_VALUES.has(runnerSecret)) {
      failures.push({ variable: 'AGENT_RUNTIME_INTERNAL_SECRET', reason: 'matches a known placeholder value' })
    }
  }

  // When a 3D provider is configured, validate the concrete prerequisites
  // needed to materialize its durable jobs. There is intentionally no
  // separate paid-call feature flag in the Agent path.
  const configuredSpatialProviders = [
    ['Aholo', 'AHOLO_API_KEY', 'AHOLO_API_TOKEN', 'AHOLO_ASSET_HOST_ALLOWLIST'],
    ['Lux3D', 'LUX3D_API_KEY', 'LUX3D_API_TOKEN', 'LUX3D_ASSET_HOST_ALLOWLIST'],
  ] as const
  const hasConfiguredSpatialProvider = configuredSpatialProviders.some(([, key, token]) => (
    Boolean((process.env[key] || process.env[token])?.trim())
  ))
  if (hasConfiguredSpatialProvider) {
    if (process.env.SPATIAL_WORKER_ENABLED === '0') {
      failures.push({
        variable: 'SPATIAL_WORKER_ENABLED',
        reason: 'must not be 0 when a spatial provider is configured',
      })
    }
    const providerMediaVariable = mediaDriver === 'oss'
      ? 'NEXT_PUBLIC_MEDIA_CDN_BASE_URL'
      : 'MEDIA_PUBLIC_BASE_URL'
    const providerMediaValue = mediaDriver === 'oss'
      ? process.env.NEXT_PUBLIC_MEDIA_CDN_BASE_URL || process.env.OSS_CDN_BASE_URL
      : process.env.MEDIA_PUBLIC_BASE_URL
    if (!isProviderReachableHttpsOrigin(providerMediaValue)) {
      failures.push({
        variable: providerMediaVariable,
        reason: 'must be a credential-free public HTTPS origin reachable by Aholo/Lux3D',
      })
    }
    for (const [, key, token, hosts] of configuredSpatialProviders) {
      if (!(process.env[key] || process.env[token])?.trim()) continue
      if (!hasValidHostAllowlist(process.env[hosts])) {
        failures.push({
          variable: hosts,
          reason: 'must contain one or more exact artifact hostnames discovered during H0 smoke testing',
        })
      }
    }
  }

  // GridFS is the isolated self-hosted default. If OSS is selected, its
  // credential and public-CDN configuration is treated atomically.
  if (mediaDriver === 'oss') {
    for (const key of [
      'OSS_REGION',
      'OSS_BUCKET',
      'OSS_ACCESS_KEY_ID',
      'OSS_ACCESS_KEY_SECRET',
      'OSS_CDN_BASE_URL',
      'NEXT_PUBLIC_MEDIA_CDN_BASE_URL',
    ]) {
      if (!process.env[key]) failures.push({ variable: key, reason: 'not set (required for OSS media)' })
    }
    const cdnBase = process.env.OSS_CDN_BASE_URL
    const browserCdnBase = process.env.NEXT_PUBLIC_MEDIA_CDN_BASE_URL
    let serverCdnOrigin: string | undefined
    let browserCdnOrigin: string | undefined
    for (const [variable, value] of [
      ['OSS_CDN_BASE_URL', cdnBase],
      ['NEXT_PUBLIC_MEDIA_CDN_BASE_URL', browserCdnBase],
    ] as const) {
      if (!value) continue
      try {
        const parsed = new URL(value)
        if (parsed.protocol !== 'https:') throw new Error('not HTTPS')
        if (variable === 'OSS_CDN_BASE_URL') serverCdnOrigin = parsed.origin
        else browserCdnOrigin = parsed.origin
      } catch {
        failures.push({ variable, reason: 'must be a complete HTTPS URL' })
      }
    }
    if (serverCdnOrigin && browserCdnOrigin && serverCdnOrigin !== browserCdnOrigin) {
      failures.push({
        variable: 'NEXT_PUBLIC_MEDIA_CDN_BASE_URL',
        reason: 'origin must match OSS_CDN_BASE_URL',
      })
    }
    if (process.env.NODE_ENV === 'production' && !process.env.CRON_SECRET) {
      failures.push({
        variable: 'CRON_SECRET',
        reason: 'not set (required for staged asset cleanup in production)',
      })
    }
  }

  if (failures.length > 0) {
    const lines = [
      '',
      '='.repeat(72),
      '[startup] Refusing to start — environment configuration is invalid:',
      '',
      ...failures.map(f => `  - ${f.variable}: ${f.reason}`),
      '',
      'See .env.example for the full list of required variables.',
      '='.repeat(72),
      '',
    ]
    console.error(lines.join('\n'))
    process.exit(1)
  }

  console.log('[startup] Environment check passed')
}
