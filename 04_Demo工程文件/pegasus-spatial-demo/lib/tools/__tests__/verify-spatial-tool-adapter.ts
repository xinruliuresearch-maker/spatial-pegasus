import assert from 'node:assert/strict'
import { createAgentProvider } from '../../agent/provider'
import type { AgentExecutionContext, ToolExecutionInvocation } from '../../agent/execution-context'
import {
  deterministicSpatialJobId,
  parseSpatialToolResult,
  type PrepareSpatialBuildInput,
  type SpatialBuildJobRecord,
  type SpatialCommandScope,
  type SpatialToolResultEnvelope,
} from '../../spatial'
import type { RasterAssetRef } from '../../types'
import { createInMemoryWorkspace } from '../__test-utils__/in-memory-workspace'
import {
  executeCreateObject3D,
  executeCreateWorld3D,
  executeGetSpatialJob,
  executeInspectSpatialArtifact,
  executeWaitSpatialJob,
  type SpatialToolDependencies,
} from '../spatial'

const rootContext: AgentExecutionContext = {
  userId: 'user_spatial',
  conversationId: 'conversation_spatial',
  workspaceId: 'project_spatial',
  runId: 'run_spatial',
  isRoot: true,
  allowedTools: ['*'],
}

const invocation: ToolExecutionInvocation = {
  toolUseId: 'tool_spatial',
  actionId: 'action_spatial',
  turn: 1,
}

function raster(assetId: string): RasterAssetRef {
  return {
    assetId,
    mimeType: 'image/png',
    width: 1024,
    height: 1024,
    sizeBytes: 2_048,
    urls: {
      original: `https://media.example.test/raster-assets/${assetId}/original`,
      model: `https://media.example.test/raster-assets/${assetId}/model`,
      thumbnail: `https://media.example.test/raster-assets/${assetId}/thumbnail`,
    },
  }
}

function jobRecord(input: PrepareSpatialBuildInput): SpatialBuildJobRecord {
  const now = new Date('2026-08-25T01:02:03.000Z')
  return {
    job_id: deterministicSpatialJobId({
      projectId: input.projectId,
      runId: input.runId,
      toolUseId: input.toolUseId,
    }),
    idempotency_key: 'test',
    project_id: input.projectId,
    run_id: input.runId,
    tool_use_id: input.toolUseId,
    user_id: input.userId,
    conversation_id: input.conversationId,
    kind: input.kind,
    provider: input.provider,
    model_snapshot: input.modelSnapshot ?? null,
    request_hash: 'hash',
    request_snapshot: structuredClone(input.request),
    output_path_prefix: input.request.output_path_prefix,
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

function envelope(job: SpatialBuildJobRecord): SpatialToolResultEnvelope {
  return {
    schema_version: 1,
    job_id: job.job_id,
    kind: job.kind,
    status: job.status,
    provider: job.provider,
    updated_at: job.updated_at.toISOString(),
  }
}

function setupDependencies(input?: {
  active?: number
  existing?: SpatialBuildJobRecord | null
}) {
  const prepared: PrepareSpatialBuildInput[] = []
  const scopes: SpatialCommandScope[] = []
  let latest: SpatialBuildJobRecord | null = input?.existing ?? null
  const dependencies: SpatialToolDependencies = {
    async prepareSpatialBuild(candidate) {
      prepared.push(structuredClone(candidate))
      latest = jobRecord(candidate)
      return structuredClone(latest)
    },
    async getSpatialBuildJob(_jobId, scope) {
      scopes.push(structuredClone(scope))
      return latest ? structuredClone(latest) : null
    },
    async countActiveSpatialJobs(scope) {
      scopes.push(structuredClone(scope))
      return input?.active ?? 0
    },
    async getSpatialJobResult({ jobId, scope }) {
      scopes.push(structuredClone(scope))
      if (!latest) {
        latest = jobRecord({
          projectId: scope.projectId,
          runId: rootContext.runId,
          toolUseId: invocation.toolUseId,
          userId: scope.userId,
          conversationId: rootContext.conversationId,
          kind: 'object',
          provider: 'lux3d',
          request: { output_path_prefix: 'output/spatial/objects/test' },
        })
      }
      return { ...envelope(latest), job_id: jobId }
    },
    async waitSpatialJobResult({ jobId, scope, timeoutMs, signal }) {
      scopes.push(structuredClone(scope))
      assert.equal(timeoutMs, 5_000)
      assert.equal(signal?.aborted, false)
      return {
        schema_version: 1,
        job_id: jobId,
        kind: 'job',
        status: 'running',
        provider: 'aholo',
        updated_at: '2026-08-25T01:02:03.000Z',
      }
    },
    async inspectSpatialArtifactResult({ artifactId, scope }) {
      scopes.push(structuredClone(scope))
      return {
        schema_version: 1,
        artifact_id: artifactId,
        kind: 'artifact',
        status: 'published',
        provider: 'lux3d',
        workspace_paths: ['output/spatial/objects/chair/model.glb'],
        updated_at: '2026-08-25T01:02:03.000Z',
      }
    },
    async resolveProviderRasterUrl(asset) {
      return asset.urls.original
    },
    now: () => new Date('2026-08-25T01:02:03.000Z'),
  }
  return { dependencies, prepared, scopes }
}

function parsed(content: string): SpatialToolResultEnvelope {
  const value = parseSpatialToolResult(content)
  assert.ok(value, `expected a stable spatial envelope, got: ${content}`)
  return value
}

const workspace = createInMemoryWorkspace()
await workspace.writeRaster('output/spatial/images/chair.png', raster('asset_chair'))
await workspace.writeRaster('output/spatial/images/chair-back.png', raster('asset_chair_back'))
await workspace.writeRaster('output/spatial/images/room.png', raster('asset_room'))
const insecureRaster = raster('asset_insecure_http')
insecureRaster.urls = {
  original: 'http://media.example.test/raster-assets/asset_insecure_http/original',
  model: 'http://media.example.test/raster-assets/asset_insecure_http/model',
  thumbnail: 'http://media.example.test/raster-assets/asset_insecure_http/thumbnail',
}
await workspace.writeRaster('output/spatial/images/insecure-http.png', insecureRaster)

// The public schemas intentionally avoid top-level JSON Schema combinators
// for Anthropic-compatible relay support. Runtime validation remains the
// authoritative guard for their cross-field input requirements.
{
  const state = setupDependencies()
  const missingObjectSource = await executeCreateObject3D({
    output_path_prefix: 'output/spatial/objects/missing-source',
  }, workspace, { executionContext: rootContext, invocation, dependencies: state.dependencies })
  assert.equal(missingObjectSource.is_error, true)
  assert.match(parsed(missingObjectSource.content).error ?? '', /至少需要 prompt 或 reference_image_paths/)

  const missingWorldSource = await executeCreateWorld3D({
    output_path_prefix: 'output/spatial/worlds/missing-source',
  }, workspace, { executionContext: rootContext, invocation, dependencies: state.dependencies })
  assert.equal(missingWorldSource.is_error, true)
  assert.match(parsed(missingWorldSource.content).error ?? '', /至少需要 prompt 或 source_image_path/)
  assert.equal(state.prepared.length, 0, 'invalid cross-field inputs must fail before preparing paid jobs')
}

// Workspace paths are resolved to project-owned media locators. The caller
// cannot inject arbitrary provider URLs into the frozen request.
{
  const state = setupDependencies()
  const result = await executeCreateObject3D({
    prompt: 'A woven reading chair',
    reference_image_paths: ['output/spatial/images/chair.png'],
    output_path_prefix: 'output/spatial/objects/chair-v1',
  }, workspace, { executionContext: rootContext, invocation, dependencies: state.dependencies })
  assert.equal(result.is_error, undefined)
  assert.equal(parsed(result.content).status, 'prepared')
  assert.equal(state.prepared.length, 1)
  assert.equal(state.prepared[0].notifyOnTerminal, true)
  assert.deepEqual(state.prepared[0].request.input_image_paths, ['output/spatial/images/chair.png'])
  assert.deepEqual(state.prepared[0].request.provider_options, {
    version: 'G1',
    output_formats: ['glb', 'ply'],
    source_image_urls: ['https://media.example.test/raster-assets/asset_chair/original'],
    source_asset_ids: ['asset_chair'],
  })

  const rejected = await executeCreateObject3D({
    reference_image_paths: ['https://attacker.example/image.png'],
    output_path_prefix: 'output/spatial/objects/untrusted',
  }, workspace, {
    executionContext: { ...rootContext, runId: 'run_untrusted' },
    invocation,
    dependencies: state.dependencies,
  })
  assert.equal(rejected.is_error, true)
  assert.match(parsed(rejected.content).error ?? '', /Workspace 图片路径|Workspace 中不存在可用图片/)
  assert.equal(state.prepared.length, 1)

  const insecure = await executeCreateObject3D({
    reference_image_paths: ['output/spatial/images/insecure-http.png'],
    output_path_prefix: 'output/spatial/objects/insecure-http',
  }, workspace, {
    executionContext: { ...rootContext, runId: 'run_insecure_http' },
    invocation,
    dependencies: state.dependencies,
  })
  assert.equal(insecure.is_error, true)
  assert.match(parsed(insecure.content).error ?? '', /公网 HTTPS URL/)
  assert.equal(state.prepared.length, 1, 'HTTP media must fail before a paid Job is prepared')
}

// Multiple references must route to Lux img-to-3D even when the caller also
// supplies design guidance. The guidance remains in the receipt without
// becoming an incompatible provider prompt.
{
  const state = setupDependencies()
  const result = await executeCreateObject3D({
    prompt: 'Keep the same woven chair identity and proportions',
    reference_image_paths: [
      'output/spatial/images/chair.png',
      'output/spatial/images/chair-back.png',
    ],
    output_path_prefix: 'output/spatial/objects/chair-multiview-v1',
  }, workspace, {
    executionContext: { ...rootContext, runId: 'run_multiview' },
    invocation: { ...invocation, toolUseId: 'tool_multiview' },
    dependencies: state.dependencies,
  })
  assert.equal(result.is_error, undefined)
  assert.equal(state.prepared.length, 1)
  assert.equal(state.prepared[0].request.prompt, undefined)
  assert.deepEqual(state.prepared[0].request.input_image_paths, [
    'output/spatial/images/chair.png',
    'output/spatial/images/chair-back.png',
  ])
  assert.deepEqual(state.prepared[0].request.provider_options, {
    version: 'G1-Turbo',
    reference_guidance: 'Keep the same woven chair identity and proportions',
    output_formats: ['glb', 'ply'],
    source_image_urls: [
      'https://media.example.test/raster-assets/asset_chair/original',
      'https://media.example.test/raster-assets/asset_chair_back/original',
    ],
    source_asset_ids: ['asset_chair', 'asset_chair_back'],
  })
}

{
  const state = setupDependencies()
  const result = await executeCreateWorld3D({
    source_image_path: 'output/spatial/images/room.png',
    output_path_prefix: 'output/spatial/worlds/reading-room-v1',
  }, workspace, { executionContext: rootContext, invocation, dependencies: state.dependencies })
  assert.equal(result.is_error, undefined)
  assert.equal(state.prepared[0].provider, 'aholo')
  assert.equal(
    (state.prepared[0].request.provider_options as Record<string, unknown>).source_image_url,
    'https://media.example.test/raster-assets/asset_room/original',
  )
}

// Wildcard filtering happens at delegation; an explicit durable grant is executable.
{
  const state = setupDependencies()
  const member = await executeCreateWorld3D({
    prompt: 'A quiet room',
    output_path_prefix: 'output/spatial/worlds/member-attempt',
  }, workspace, {
    executionContext: { ...rootContext, isRoot: false, allowedTools: ['CreateWorld3D'] },
    invocation,
    dependencies: state.dependencies,
  })
  assert.equal(member.is_error, undefined)
  assert.equal(state.prepared.length, 1)

  const provider = createAgentProvider(workspace, new Map(), {
    model: 'test-model',
    maxTokens: 1_000,
    temperature: 0,
    executionContext: { ...rootContext, isRoot: false, allowedTools: ['CreateWorld3D'] },
  })
  const direct = await provider.executeTool('CreateWorld3D', {
    prompt: 'attempted direct invocation',
    output_path_prefix: 'output/spatial/worlds/direct-member-attempt',
  }, invocation)
  assert.doesNotMatch(direct.content, /Root Agent/)
}

// Product creation never rejects because other project jobs are active; each
// accepted call becomes a durable job and idempotent replay remains stable.
{
  const unbounded = setupDependencies({ active: 200 })
  const result = await executeCreateObject3D({
    prompt: 'A chair',
    output_path_prefix: 'output/spatial/objects/third-build',
  }, workspace, { executionContext: rootContext, invocation, dependencies: unbounded.dependencies })
  assert.equal(result.is_error, undefined)
  assert.equal(parsed(result.content).status, 'prepared')
  assert.equal(unbounded.prepared.length, 1)

  const existingInput: PrepareSpatialBuildInput = {
    projectId: 'project_spatial',
    runId: 'run_spatial',
    toolUseId: 'tool_spatial',
    userId: 'user_spatial',
    conversationId: 'conversation_spatial',
    kind: 'object',
    provider: 'lux3d',
    modelSnapshot: 'G1',
    request: { output_path_prefix: 'output/spatial/objects/existing-build', prompt: 'A chair' },
  }
  const replay = setupDependencies({ active: 2, existing: jobRecord(existingInput) })
  const recovered = await executeCreateObject3D({
    prompt: 'A chair',
    output_path_prefix: 'output/spatial/objects/existing-build',
  }, workspace, { executionContext: rootContext, invocation, dependencies: replay.dependencies })
  assert.equal(recovered.is_error, undefined)
  assert.equal(replay.prepared.length, 1)
}

// Status and artifact reads inherit the same project + user identity fence and
// preserve the byte-free envelope without re-submitting paid work.
{
  const state = setupDependencies()
  const get = await executeGetSpatialJob({ job_id: 'spjob_existing' }, {
    executionContext: rootContext,
    invocation,
    dependencies: state.dependencies,
  })
  assert.equal(parsed(get.content).job_id, 'spjob_existing')

  const abort = new AbortController()
  const wait = await executeWaitSpatialJob({ job_id: 'spjob_existing', timeout_ms: 5_000 }, {
    executionContext: rootContext,
    invocation,
    signal: abort.signal,
    dependencies: state.dependencies,
  })
  assert.equal(parsed(wait.content).status, 'running')

  const inspect = await executeInspectSpatialArtifact({ artifact_id: 'spart_chair' }, {
    executionContext: rootContext,
    invocation,
    dependencies: state.dependencies,
  })
  assert.equal(parsed(inspect.content).artifact_id, 'spart_chair')
  assert.ok(state.scopes.every(scope => (
    scope.projectId === 'project_spatial' && scope.userId === 'user_spatial'
  )))
}

console.log('Spatial tool adapter verification passed.')
