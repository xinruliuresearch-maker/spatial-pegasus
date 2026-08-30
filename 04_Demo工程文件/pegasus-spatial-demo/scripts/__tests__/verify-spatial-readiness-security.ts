import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const projectRoot = path.resolve(import.meta.dirname, '../..')
const jitiCli = path.join(projectRoot, 'node_modules/jiti/lib/jiti-cli.mjs')
const readinessScript = path.join(projectRoot, 'scripts/check-spatial-readiness.ts')

function testEnvironment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    NODE_ENV: 'development',
    MONGODB_URI: 'mongodb://127.0.0.1:27019/pegasus_spatial',
    LLM_BASE_URL: 'https://newapi.invalid/v1',
    LLM_API_KEY_ORCHESTRATOR: 'dummy-orchestrator-key',
    LLM_API_KEY_TOOLS: 'dummy-tools-key',
    PEGASUS_SPATIAL_IMAGE_MODEL: 'GPT-image-2',
    MEDIA_STORAGE_DRIVER: 'gridfs',
    MEDIA_PUBLIC_BASE_URL: 'https://media.invalid',
    NEXT_PUBLIC_PEGASUS_SPATIAL_MEDIA_PREFIX: 'raster-assets/pegasus-spatial',
    APP_PUBLIC_URL: 'http://localhost:3200',
    AHOLO_API_KEY: 'dummy-aholo-key',
    AHOLO_ASSET_HOST_ALLOWLIST: 'artifacts.aholo.invalid',
    LUX3D_API_KEY: 'dummy-lux-key',
    LUX3D_ASSET_HOST_ALLOWLIST: 'artifacts.lux.invalid',
    ...overrides,
  }
}

function runStartup(overrides: Record<string, string> = {}) {
  return spawnSync(process.execPath, [
    '--import',
    'jiti/register',
    '-e',
    "import('./lib/startup-checks.ts').then(mod => (mod.runStartupChecks || mod.default.runStartupChecks)())",
  ], {
    cwd: projectRoot,
    env: testEnvironment(overrides),
    encoding: 'utf8',
  })
}

function runReadiness(baseUrl: string, overrides: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [jitiCli, readinessScript], {
    cwd: projectRoot,
    env: testEnvironment({ LLM_BASE_URL: baseUrl, ...overrides }),
    encoding: 'utf8',
  })
  return {
    ...result,
    report: JSON.parse(result.stdout) as {
      ready_for_paid_smoke: boolean
      checks: Array<{ name: string; ok: boolean; detail: string }>
    },
  }
}

assert.equal(
  runStartup({ LLM_BASE_URL: 'http://127.0.0.1:3000/v1' }).status,
  0,
  'non-production loopback HTTP should remain usable for local development',
)
assert.equal(
  runStartup({
    LLM_BASE_URL: 'http://newapi.invalid/v1',
    PEGASUS_SPATIAL_ALLOW_INSECURE_NEWAPI_HTTP: '1',
  }).status,
  0,
  'an explicit development-only override may unlock a legacy public HTTP gateway',
)

for (const [name, overrides, expected] of [
  ['invalid media prefix', {
    NEXT_PUBLIC_PEGASUS_SPATIAL_MEDIA_PREFIX: '../raster-assets',
  }, 'NEXT_PUBLIC_PEGASUS_SPATIAL_MEDIA_PREFIX'],
  ['legacy media prefix mismatch', {
    PEGASUS_SPATIAL_MEDIA_PREFIX: 'old-project/raster-assets',
  }, 'PEGASUS_SPATIAL_MEDIA_PREFIX'],
] as const) {
  const result = runStartup(overrides)
  assert.equal(result.status, 1, `${name} must fail startup`)
  assert.match(result.stderr, new RegExp(expected), `${name} should identify the conflicting variable`)
}

for (const [name, overrides, expected] of [
  ['production HTTP', { NODE_ENV: 'production', LLM_BASE_URL: 'http://127.0.0.1:3000/v1' }, 'must use HTTPS'],
  ['production HTTP with override', {
    NODE_ENV: 'production',
    LLM_BASE_URL: 'http://newapi.invalid/v1',
    PEGASUS_SPATIAL_ALLOW_INSECURE_NEWAPI_HTTP: '1',
  }, 'must use HTTPS'],
  ['non-loopback HTTP', { LLM_BASE_URL: 'http://newapi.invalid/v1' }, 'only for loopback'],
  ['embedded credentials', { LLM_BASE_URL: 'https://user:pass@newapi.invalid/v1' }, 'embedded credentials'],
  ['query string', { LLM_BASE_URL: 'https://newapi.invalid/v1?token=bad' }, 'query string or fragment'],
  ['fragment', { LLM_BASE_URL: 'https://newapi.invalid/v1#token' }, 'query string or fragment'],
] as const) {
  const result = runStartup(overrides)
  assert.equal(result.status, 1, `${name} must fail startup`)
  assert.match(result.stderr, new RegExp(expected), `${name} should explain the rejected URL`)
}

const httpsReadiness = runReadiness('https://newapi.invalid/v1')
assert.equal(httpsReadiness.status, 0)
assert.equal(httpsReadiness.report.ready_for_paid_smoke, true)

const mediaPrefixReadinessOverrides: Array<Record<string, string>> = [
  { NEXT_PUBLIC_PEGASUS_SPATIAL_MEDIA_PREFIX: 'media/../raster' },
  { PEGASUS_SPATIAL_MEDIA_PREFIX: 'old-project/raster-assets' },
]
for (const overrides of mediaPrefixReadinessOverrides) {
  const result = runReadiness('https://newapi.invalid/v1', overrides)
  const prefix = result.report.checks.find(check => check.name === 'MEDIA object prefix')
  assert.equal(result.status, 1, 'invalid or divergent media prefix must not be paid-ready')
  assert.equal(result.report.ready_for_paid_smoke, false)
  assert.ok(prefix && !prefix.ok)
}

for (const [url, expected] of [
  ['http://127.0.0.1:3000/v1', '明文 HTTP 不能作为正式付费就绪配置'],
  ['http://newapi.invalid/v1', '非回环 NewAPI 必须使用 HTTPS'],
  ['https://user:pass@newapi.invalid/v1', '禁止在 URL 中内嵌'],
  ['https://newapi.invalid/v1?token=bad', '禁止携带 query 或 fragment'],
  ['https://newapi.invalid/v1#token', '禁止携带 query 或 fragment'],
] as const) {
  const result = runReadiness(url)
  const gateway = result.report.checks.find(check => check.name === 'LLM_BASE_URL (NewAPI)')
  assert.equal(result.status, 1, `${url} must not be paid-ready`)
  assert.equal(result.report.ready_for_paid_smoke, false)
  assert.ok(gateway && !gateway.ok)
  assert.match(gateway.detail, new RegExp(expected))
}

console.log('spatial readiness URL security verification passed')
