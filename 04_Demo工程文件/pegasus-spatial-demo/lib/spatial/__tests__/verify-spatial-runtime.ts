import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ProviderDefinitelyNotAcceptedError,
  createProductionSpatialDependencies,
  parseSpatialAssetHostAllowlist,
  readSpatialRuntimeConfig,
  sanitizeSpatialRuntimeError,
  spatialWorkspaceWriterIdentity,
  type SpatialBuildJobRecord,
  type SpatialProviderAdapter,
} from '..'

function env(values: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', ...values }
}

function job(): SpatialBuildJobRecord {
  const now = new Date('2026-08-25T00:00:00.000Z')
  return {
    job_id: 'spjob_runtime_fixture',
    idempotency_key: 'project\0run\0tool',
    project_id: 'project',
    run_id: 'run',
    tool_use_id: 'tool',
    user_id: 'user',
    conversation_id: 'project',
    kind: 'object',
    provider: 'lux3d',
    model_snapshot: 'G1',
    request_hash: 'a'.repeat(64),
    request_snapshot: {
      output_path_prefix: 'output/spatial/objects/runtime-fixture',
      prompt: 'fixture',
    },
    status: 'prepared',
    status_revision: 0,
    execution_attempts: 0,
    submission_attempts: 0,
    poll_attempts: 0,
    lease: null,
    external_job_id: null,
    provider_status: null,
    published_artifact_ids: [],
    published_workspace_paths: [],
    publication_token: null,
    available_at: now,
    last_error: null,
    unknown_reason: null,
    created_at: now,
    updated_at: now,
    finished_at: null,
  }
}

function adapter(
  dependencies: ReturnType<typeof createProductionSpatialDependencies>,
  provider: string,
): SpatialProviderAdapter {
  const adapters = dependencies.adapters
  const value = 'get' in adapters && typeof adapters.get === 'function'
    ? adapters.get(provider)
    : (adapters as Readonly<Record<string, SpatialProviderAdapter>>)[provider]
  assert.ok(value)
  return value
}

async function verifyProviderConfiguration(): Promise<void> {
  const parsed = parseSpatialAssetHostAllowlist(
    'cdn.example.test, CDN.EXAMPLE.TEST., https://bad.example.test, *.invalid',
  )
  assert.deepEqual(parsed.hosts, ['cdn.example.test'])
  assert.deepEqual(parsed.invalid, ['https://bad.example.test', '*.invalid'])

  const disabled = readSpatialRuntimeConfig(env({
    SPATIAL_WORKER_ENABLED: '1',
  }))
  assert.equal(disabled.workerEnabled, true)
  assert.equal(disabled.concurrency, 8, 'default worker throughput should support parallel Agent fan-out')
  assert.equal(disabled.aholo.submissionEnabled, false)
  assert.equal(disabled.lux3d.submissionEnabled, false)
  assert.equal(disabled.configurationWarnings.length, 4)

  const boundedConcurrency = readSpatialRuntimeConfig(env({
    SPATIAL_WORKER_CONCURRENCY: '999',
  }))
  assert.equal(boundedConcurrency.concurrency, 32, 'local worker safety cap is not a project backlog limit')

  const missingAllowlist = readSpatialRuntimeConfig(env({
    AHOLO_API_KEY: 'aholo-secret',
    LUX3D_API_KEY: 'lux-secret',
  }))
  assert.equal(missingAllowlist.aholo.submissionEnabled, false)
  assert.equal(missingAllowlist.lux3d.submissionEnabled, false)
  assert.equal(missingAllowlist.configurationWarnings.length, 2)

  const configured = readSpatialRuntimeConfig(env({
    AHOLO_API_KEY: 'aholo-secret',
    AHOLO_ASSET_HOST_ALLOWLIST: 'world-cdn.example.test',
    LUX3D_API_KEY: 'lux-secret',
    LUX3D_ASSET_HOST_ALLOWLIST: 'lux-cdn.example.test',
  }))
  assert.equal(configured.aholo.submissionEnabled, true)
  assert.equal(configured.lux3d.submissionEnabled, true)
  assert.deepEqual(configured.configurationWarnings, [])

  const configuredWithoutGlobalSwitch = readSpatialRuntimeConfig(env({
    AHOLO_API_KEY: 'aholo-secret',
    AHOLO_ASSET_HOST_ALLOWLIST: 'world-cdn.example.test',
    LUX3D_API_KEY: 'lux-secret',
    LUX3D_ASSET_HOST_ALLOWLIST: 'lux-cdn.example.test',
  }))
  assert.equal(configuredWithoutGlobalSwitch.aholo.submissionEnabled, true)
  assert.equal(configuredWithoutGlobalSwitch.lux3d.submissionEnabled, true)
}

async function verifyDisabledWorkerAdapterDoesNotCallNetwork(): Promise<void> {
  let calls = 0
  const config = readSpatialRuntimeConfig(env({
    LUX3D_API_KEY: 'must-not-be-used',
  }))
  const dependencies = createProductionSpatialDependencies(config, {
    fetchImpl: async () => {
      calls += 1
      return Response.json({})
    },
  })
  await assert.rejects(
    adapter(dependencies, 'lux3d').submit(job(), { providerIdempotencyKey: 'fixture' }),
    ProviderDefinitelyNotAcceptedError,
  )
  assert.equal(calls, 0)
  assert.deepEqual(
    dependencies.allowedArtifactHosts?.('lux3d'),
    ['spatial-artifacts-not-configured.invalid'],
  )
}

function verifyStableWriterAndSanitization(): void {
  const value = job()
  const first = spatialWorkspaceWriterIdentity(value, 'team', 'root')
  const second = spatialWorkspaceWriterIdentity({
    job_id: value.job_id,
    request_hash: value.request_hash,
    tool_use_id: value.tool_use_id,
  }, 'team', 'root')
  assert.deepEqual(first, second)
  assert.match(first.run_id, /spjob_runtime_fixture/)

  const secret = 'super-secret-key'
  const message = sanitizeSpatialRuntimeError(
    new Error(`mongodb://admin:password@db.example/x ${secret} image-tools-secret\nnext line`),
    env({ AHOLO_API_KEY: secret, LLM_API_KEY_TOOLS: 'image-tools-secret' }),
  )
  assert.doesNotMatch(message, /admin:password|super-secret-key|image-tools-secret|\n/)
  assert.match(message, /\[redacted\]/)
}

function verifySourceContract(): void {
  const source = readFileSync(join(process.cwd(), 'lib/spatial/runtime.ts'), 'utf8')
  assert.match(source, /SpatialBuildJobModel\.exists/)
  assert.match(source, /'lease\.token': capturedLease\.token/)
  assert.match(source, /createMultiAgentWorkspaceBridge/)
  assert.match(source, /spatialCreationWorkspace/)
  assert.match(source, /workspaceRepository\.discardFileSet/)
  assert.doesNotMatch(source, /onFileSetAbort:\s*bridge\.onFileSetAbort/)
  assert.doesNotMatch(source, /validateAgentRunLeaseFence|validateExecutionFence\s*\(/)
  assert.doesNotMatch(source, /onFilesUpdate\s*:/)

  const bootstrap = readFileSync(join(process.cwd(), 'instrumentation-node.ts'), 'utf8')
  assert.match(bootstrap, /ImageGenerationReceiptModel\.syncIndexes\(\)/)
  assert.match(bootstrap, /SPATIAL_MODELS\.map\(model => model\.syncIndexes\(\)\)/)
  assert.match(bootstrap, /startProductionSpatialBuildWorker/)
  assert.match(bootstrap, /await spatialBuildWorker\.stop\(\)/)
}

async function main(): Promise<void> {
await verifyProviderConfiguration()
  await verifyDisabledWorkerAdapterDoesNotCallNetwork()
  verifyStableWriterAndSanitization()
  verifySourceContract()
  console.log('spatial runtime verification passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
