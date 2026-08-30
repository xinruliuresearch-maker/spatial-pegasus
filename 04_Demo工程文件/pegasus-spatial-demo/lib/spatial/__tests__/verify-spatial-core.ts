import assert from 'node:assert/strict'
import {
  AholoAdapter,
  FakeSpatialProviderAdapter,
  InMemorySpatialAssetPublisher,
  InvalidSpatialStatusTransitionError,
  Lux3DAdapter,
  ProviderDefinitelyNotAcceptedError,
  ProviderConfigurationBlockedError,
  SPATIAL_TOOL_RESULT_SCHEMA_VERSION,
  SpatialArtifactDownloadTransientError,
  SpatialArtifactDnsResolutionError,
  SpatialAssetValidationError,
  canTransitionSpatialStatus,
  canonicalSpatialJson,
  createAholoOfficialWireContract,
  deterministicSpatialJobId,
  inspectSpatialAssetBytes,
  mirrorRemoteSpatialArtifacts,
  parseSpatialToolResult,
  serializeSpatialToolResult,
  spatialRequestHash,
  type SpatialBuildJobRecord,
  type SpatialHttpWireContract,
} from '..'
import { assertSpatialStatusTransition } from '../state-machine'
import { createLux3DOfficialG1WireContract } from '../adapters/official-contracts'

const resolvePublicFixtureHostname = async (): Promise<readonly string[]> => ['93.184.216.34']

function job(overrides: Partial<SpatialBuildJobRecord> = {}): SpatialBuildJobRecord {
  const now = new Date('2026-08-25T00:00:00.000Z')
  return {
    job_id: 'spjob_fixture',
    idempotency_key: 'project\0run\0tool',
    project_id: 'project',
    run_id: 'run',
    tool_use_id: 'tool',
    user_id: 'user',
    conversation_id: 'conversation',
    kind: 'object',
    provider: 'fake',
    model_snapshot: 'fixture-v1',
    request_hash: 'hash',
    request_snapshot: { output_path_prefix: 'output/spatial/objects/build' },
    status: 'submitted',
    status_revision: 2,
    execution_attempts: 1,
    submission_attempts: 1,
    poll_attempts: 0,
    lease: null,
    external_job_id: 'external',
    provider_status: 'submitted',
    published_artifact_ids: [],
    published_workspace_paths: [],
    publication_token: null,
    available_at: null,
    last_error: null,
    unknown_reason: null,
    created_at: now,
    updated_at: now,
    finished_at: null,
    ...overrides,
  }
}

function glbFixture(size = 12): Buffer {
  const buffer = Buffer.alloc(size)
  buffer.write('glTF', 0, 'ascii')
  buffer.writeUInt32LE(2, 4)
  buffer.writeUInt32LE(buffer.length, 8)
  return buffer
}

async function verifyIdentityAndStateMachine(): Promise<void> {
  const left = { output_path_prefix: 'output/spatial/worlds/a', prompt: 'room', provider_options: { b: 2, a: 1 } }
  const right = { provider_options: { a: 1, b: 2 }, prompt: 'room', output_path_prefix: 'output/spatial/worlds/a' }
  assert.equal(canonicalSpatialJson(left), canonicalSpatialJson(right))
  assert.equal(spatialRequestHash(left), spatialRequestHash(right))
  assert.equal(
    deterministicSpatialJobId({ projectId: 'p', runId: 'r', toolUseId: 't' }),
    deterministicSpatialJobId({ projectId: 'p', runId: 'r', toolUseId: 't' }),
  )
  assert.equal(canTransitionSpatialStatus('prepared', 'submitting'), true)
  assert.equal(canTransitionSpatialStatus('submitting', 'prepared'), false)
  assert.throws(
    () => assertSpatialStatusTransition('unknown', 'submitting'),
    InvalidSpatialStatusTransitionError,
  )
}

async function verifyByteInspectionAndMirroring(): Promise<void> {
  const bytes = glbFixture()
  assert.deepEqual(inspectSpatialAssetBytes(bytes, 'object.glb', 'application/octet-stream'), {
    mimeType: 'model/gltf-binary',
    extension: 'glb',
  })
  assert.throws(
    () => inspectSpatialAssetBytes(bytes, 'object.glb', 'image/png'),
    /conflicts with sniffed/,
  )

  const publisher = new InMemorySpatialAssetPublisher()
  const materialized = await mirrorRemoteSpatialArtifacts({
    job: job(),
    publicationToken: 'publication',
    artifacts: [{
      assetKey: 'primary-glb',
      kind: 'model',
      fileName: 'object.glb',
      remoteUrl: 'https://assets.example.test/object.glb?temporary=secret',
      claimedMimeType: 'model/gltf-binary',
      metadata: { lod: 0 },
    }],
    publisher,
    allowedHosts: ['assets.example.test'],
    resolveHostname: resolvePublicFixtureHostname,
    fetchImpl: async () => new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': 'model/gltf-binary',
        'Content-Length': String(bytes.length),
      },
    }),
  })
  assert.equal(materialized.length, 1)
  assert.equal(materialized[0].workspacePath, 'output/spatial/objects/build/object.glb')
  assert.deepEqual(publisher.readPublished(materialized[0].artifactId), bytes)
  assert.doesNotMatch(JSON.stringify(materialized), /temporary=secret/)

  await assert.rejects(
    mirrorRemoteSpatialArtifacts({
      job: job(),
      publicationToken: 'too-many',
      artifacts: [1, 2].map(index => ({
        assetKey: `asset-${index}`,
        kind: 'model' as const,
        fileName: `asset-${index}.glb`,
        inlineContent: glbFixture().toString('binary'),
      })),
      publisher,
      maxArtifactCount: 1,
    }),
    /more than 1 artifacts/,
  )

  const largeGlb = glbFixture(700)
  await assert.rejects(
    mirrorRemoteSpatialArtifacts({
      job: job(),
      publicationToken: 'too-large',
      artifacts: [1, 2].map(index => ({
        assetKey: `large-${index}`,
        kind: 'model' as const,
        fileName: `large-${index}.glb`,
        remoteUrl: `https://assets.example.test/large-${index}.glb`,
      })),
      publisher,
      allowedHosts: ['assets.example.test'],
      maxAssetBytes: 1_024,
      maxBatchBytes: 1_100,
      resolveHostname: resolvePublicFixtureHostname,
      fetchImpl: async () => new Response(new Uint8Array(largeGlb)),
    }),
    /exceeds 1100 bytes/,
  )

  await assert.rejects(
    mirrorRemoteSpatialArtifacts({
      job: job(),
      publicationToken: 'bad-publication',
      artifacts: [{
        assetKey: 'bad',
        kind: 'model',
        fileName: '../object.glb',
        remoteUrl: 'https://assets.example.test/object.glb',
      }],
      publisher,
      fetchImpl: async () => new Response(new Uint8Array(bytes)),
    }),
    /safe basename/,
  )

  for (const blockedUrl of [
    'https://127.0.0.1/object.glb',
    'https://169.254.169.254/latest/meta-data/object.glb',
    'https://[::1]/object.glb',
  ]) {
    let fetchCalls = 0
    await assert.rejects(
      mirrorRemoteSpatialArtifacts({
        job: job(),
        publicationToken: `blocked-${fetchCalls}`,
        artifacts: [{
          assetKey: `blocked-${blockedUrl}`,
          kind: 'model',
          fileName: 'blocked.glb',
          remoteUrl: blockedUrl,
        }],
        publisher,
        // An operator mistake must not turn the allowlist into an SSRF bypass.
        allowedHosts: [new URL(blockedUrl).hostname.replace(/^\[|\]$/g, '')],
        fetchImpl: async () => {
          fetchCalls += 1
          return new Response(new Uint8Array(bytes))
        },
      }),
      /not publicly routable/,
    )
    assert.equal(fetchCalls, 0, 'SSRF targets must be rejected before fetch')
  }

  for (const blockedUrl of [
    'https://user:password@assets.example.test/object.glb',
    'https://assets.example.test:8443/object.glb',
  ]) {
    let fetchCalls = 0
    await assert.rejects(
      mirrorRemoteSpatialArtifacts({
        job: job(),
        publicationToken: `blocked-url-${fetchCalls}`,
        artifacts: [{
          assetKey: `blocked-url-${blockedUrl}`,
          kind: 'model',
          fileName: 'blocked-url.glb',
          remoteUrl: blockedUrl,
        }],
        publisher,
        allowedHosts: ['assets.example.test'],
        resolveHostname: resolvePublicFixtureHostname,
        fetchImpl: async () => {
          fetchCalls += 1
          return new Response(new Uint8Array(bytes))
        },
      }),
      /userinfo|default HTTPS port/,
    )
    assert.equal(fetchCalls, 0, 'userinfo and non-default ports must be rejected before fetch')
  }

  for (const addresses of [
    ['127.0.0.1'],
    ['93.184.216.34', '10.0.0.8'],
    ['::ffff:7f00:1'],
  ]) {
    let fetchCalls = 0
    await assert.rejects(
      mirrorRemoteSpatialArtifacts({
        job: job(),
        publicationToken: `blocked-dns-${addresses.join('-')}`,
        artifacts: [{
          assetKey: `blocked-dns-${addresses.join('-')}`,
          kind: 'model',
          fileName: 'blocked-dns.glb',
          remoteUrl: 'https://assets.example.test/object.glb',
        }],
        publisher,
        allowedHosts: ['assets.example.test'],
        resolveHostname: async () => addresses,
        fetchImpl: async () => {
          fetchCalls += 1
          return new Response(new Uint8Array(bytes))
        },
      }),
      /private or reserved address/,
    )
    assert.equal(fetchCalls, 0, 'private DNS answers must be rejected before fetch')
  }

  for (const resolveHostname of [
    async (): Promise<readonly string[]> => { throw new Error('temporary resolver outage') },
    async (): Promise<readonly string[]> => [],
  ]) {
    let fetchCalls = 0
    await assert.rejects(
      mirrorRemoteSpatialArtifacts({
        job: job(),
        publicationToken: 'transient-dns',
        artifacts: [{
          assetKey: 'transient-dns',
          kind: 'model',
          fileName: 'transient-dns.glb',
          remoteUrl: 'https://assets.example.test/object.glb',
        }],
        publisher,
        allowedHosts: ['assets.example.test'],
        resolveHostname,
        fetchImpl: async () => {
          fetchCalls += 1
          return new Response(new Uint8Array(bytes))
        },
      }),
      SpatialArtifactDnsResolutionError,
    )
    assert.equal(fetchCalls, 0, 'DNS lookup failures must remain retryable without fetching')
  }

  for (const status of [408, 425, 429, 500, 503]) {
    await assert.rejects(
      mirrorRemoteSpatialArtifacts({
        job: job(),
        publicationToken: `transient-http-${status}`,
        artifacts: [{
          assetKey: `transient-http-${status}`,
          kind: 'model',
          fileName: 'transient-http.glb',
          remoteUrl: 'https://assets.example.test/object.glb',
        }],
        publisher,
        allowedHosts: ['assets.example.test'],
        resolveHostname: resolvePublicFixtureHostname,
        fetchImpl: async () => new Response(null, { status }),
      }),
      SpatialArtifactDownloadTransientError,
    )
  }
  await assert.rejects(
    mirrorRemoteSpatialArtifacts({
      job: job(),
      publicationToken: 'permanent-http-404',
      artifacts: [{
        assetKey: 'permanent-http-404',
        kind: 'model',
        fileName: 'permanent-http.glb',
        remoteUrl: 'https://assets.example.test/object.glb',
      }],
      publisher,
      allowedHosts: ['assets.example.test'],
      resolveHostname: resolvePublicFixtureHostname,
      fetchImpl: async () => new Response(null, { status: 404 }),
    }),
    SpatialAssetValidationError,
  )

  let redirectMode: RequestRedirect | undefined
  await assert.rejects(
    mirrorRemoteSpatialArtifacts({
      job: job(),
      publicationToken: 'blocked-redirect',
      artifacts: [{
        assetKey: 'blocked-redirect',
        kind: 'model',
        fileName: 'blocked-redirect.glb',
        remoteUrl: 'https://assets.example.test/object.glb',
      }],
      publisher,
      allowedHosts: ['assets.example.test'],
      resolveHostname: resolvePublicFixtureHostname,
      fetchImpl: async (_input, init) => {
        redirectMode = init?.redirect
        const response = new Response(new Uint8Array(bytes))
        Object.defineProperty(response, 'url', { value: 'https://redirected.example.test/object.glb' })
        return response
      },
    }),
    /not allowed/,
  )
  assert.equal(redirectMode, 'error')
}

async function verifyAdaptersFailClosedAndUseFixtures(): Promise<void> {
  let calls = 0
  const disabled = new Lux3DAdapter({
    baseUrl: 'https://lux.example.test',
    token: 'secret',
    fetchImpl: async (input, init) => {
      calls += 1
      const request = new Request(input, init)
      return request.method === 'GET'
        ? Response.json({ d: { status: 1 }, m: 'running', c: 0 })
        : new Response('{}')
    },
  })
  await assert.rejects(
    disabled.submit(job({ provider: 'lux3d' }), { providerIdempotencyKey: 'key' }),
    ProviderDefinitelyNotAcceptedError,
  )
  assert.equal(calls, 0, 'disabled adapter must fail before network I/O')
  const disabledPoll = await disabled.poll(job({
    provider: 'lux3d',
    external_job_id: 'already-paid-task',
  }), {})
  assert.equal(disabledPoll.state, 'running')
  assert.equal(calls, 1, 'paid-call switch must not prevent recovery polling')

  const missingRecoveryKey = new Lux3DAdapter({
    baseUrl: 'https://lux.example.test',
    fetchImpl: async () => {
      throw new Error('must not reach network without recovery key')
    },
  })
  await assert.rejects(
    missingRecoveryKey.poll(job({ provider: 'lux3d', external_job_id: 'paid-task' }), {}),
    ProviderConfigurationBlockedError,
  )

  const contract: SpatialHttpWireContract = {
    submitPath: () => '/fixture/jobs',
    pollPath: value => `/fixture/jobs/${value.external_job_id}`,
    idempotencyHeaderName: 'Idempotency-Key',
    encodeSubmission: value => ({ prompt: value.request_snapshot.prompt }),
    decodeSubmission(payload) {
      return { externalJobId: (payload as { task_id: string }).task_id }
    },
    decodePoll(payload) {
      const value = payload as { state: string }
      return value.state === 'done'
        ? { state: 'succeeded', artifacts: [] }
        : { state: 'running' }
    },
  }
  const requests: Request[] = []
  const enabled = new Lux3DAdapter({
    baseUrl: 'https://lux.example.test/api/',
    token: 'secret',
    allowPaidCalls: true,
    contract,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      return request.method === 'POST'
        ? Response.json({ task_id: 'lux_fixture_1' })
        : Response.json({ state: 'done' })
    },
  })
  const fixtureJob = job({ provider: 'lux3d', request_snapshot: {
    output_path_prefix: 'output/spatial/objects/build',
    prompt: 'fixture',
  } })
  const submitted = await enabled.submit(fixtureJob, { providerIdempotencyKey: 'stable-key' })
  assert.equal(submitted.externalJobId, 'lux_fixture_1')
  assert.equal(requests[0].headers.get('Idempotency-Key'), 'stable-key')
  const polled = await enabled.poll({ ...fixtureJob, external_job_id: submitted.externalJobId }, {})
  assert.equal(polled.state, 'succeeded')

  const aholo = new AholoAdapter()
  assert.equal(aholo.supports('world'), true)
  assert.equal(aholo.supports('object'), false)
  const fake = new FakeSpatialProviderAdapter()
  assert.equal(fake.supports('image'), true)

  const officialLuxRequests: Request[] = []
  const officialLux = new Lux3DAdapter({
    token: 'lux-key',
    allowPaidCalls: true,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init)
      officialLuxRequests.push(request)
      return request.method === 'POST'
        ? Response.json({ d: 4815162342, m: 'ok', c: 0 })
        : Response.json({
            d: {
              status: 3,
              outputs: [
                { content: 'https://assets.example.test/lux/package.zip' },
                { content: 'https://assets.example.test/lux/model.glb' },
                { content: 'https://assets.example.test/lux/gaussian.ply' },
              ],
            },
            m: 'ok',
            c: 0,
          })
    },
  })
  const imageLuxJob = job({
    provider: 'lux3d',
    request_snapshot: {
      output_path_prefix: 'output/spatial/objects/official-lux',
      provider_options: {
        source_image_url: 'https://media.example.test/authorized.png',
        output_formats: ['glb', 'ply'],
      },
    },
  })
  const officialLuxSubmission = await officialLux.submit(imageLuxJob, { providerIdempotencyKey: 'lux-idem' })
  assert.match(officialLuxRequests[0].url, /\/lux3d\/v1\/generate\/img-to-3d\/task\/create$/)
  assert.deepEqual(await officialLuxRequests[0].json(), {
    img: 'https://media.example.test/authorized.png',
    outputFormat: ['glb', 'ply'],
    version: 'G1',
    faceCount: 60000,
  })
  assert.equal(officialLuxSubmission.externalJobId, '4815162342')
  assert.equal(officialLuxRequests[0].headers.get('Authorization'), 'lux-key')
  const officialLuxPoll = await officialLux.poll({
    ...imageLuxJob,
    external_job_id: officialLuxSubmission.externalJobId,
  }, {})
  assert.equal(officialLuxPoll.state, 'succeeded')
  if (officialLuxPoll.state === 'succeeded') {
    assert.equal(officialLuxPoll.artifacts[0].fileName, 'model.glb')
    assert.equal(officialLuxPoll.artifacts[1].fileName, 'gaussian.ply')
    assert.equal(officialLuxPoll.artifacts[1].kind, 'point_cloud')
  }
  const luxWire = createLux3DOfficialG1WireContract()
  assert.equal(luxWire.decodePoll({ d: { status: 0 }, c: 0 }, imageLuxJob).state, 'queued')
  assert.equal(luxWire.decodePoll({ d: { status: 1 }, c: 0 }, imageLuxJob).state, 'running')
  assert.equal(luxWire.decodePoll({
    d: {
      status: 3,
      outputs: [
        { content: 'https://assets.example.test/lux/fixture.zip' },
        { content: 'https://assets.example.test/lux/fixture.glb' },
        { content: 'https://assets.example.test/lux/fixture.ply' },
      ],
    },
    c: 0,
  }, imageLuxJob).state, 'succeeded')
  assert.equal(luxWire.decodePoll({ d: { status: 4, message: 'failed' }, c: 0 }, imageLuxJob).state, 'failed')
  assert.throws(
    () => luxWire.decodePoll({ d: { status: 2 }, c: 0 }, imageLuxJob),
    /unknown status: 2/,
  )

  const multiImageLuxJob = job({
    provider: 'lux3d',
    request_snapshot: {
      output_path_prefix: 'output/spatial/objects/multi-image',
      provider_options: {
        source_image_urls: [
          'https://media.example.test/chair-front.png',
          'https://media.example.test/chair-back.png',
        ],
        reference_guidance: 'same chair, consistent proportions',
        version: 'G1-Turbo',
        output_formats: ['glb', 'ply'],
      },
    },
  })
  await officialLux.submit(multiImageLuxJob, { providerIdempotencyKey: 'lux-multi-image' })
  assert.match(officialLuxRequests[2].url, /\/lux3d\/v1\/generate\/img-to-3d\/task\/create$/)
  assert.deepEqual(await officialLuxRequests[2].json(), {
    imgs: [
      'https://media.example.test/chair-front.png',
      'https://media.example.test/chair-back.png',
    ],
    outputFormat: ['glb', 'ply'],
    version: 'G1-Turbo',
    faceCount: 200000,
    enablePbr: true,
  })
  const multiImageLuxPoll = luxWire.decodePoll({
    d: {
      status: 3,
      outputs: [
        { content: 'https://assets.example.test/lux/turbo.glb' },
        { content: 'https://assets.example.test/lux/turbo.ply' },
      ],
    },
    c: 0,
  }, multiImageLuxJob)
  assert.equal(multiImageLuxPoll.state, 'succeeded')
  if (multiImageLuxPoll.state === 'succeeded') {
    assert.equal(multiImageLuxPoll.artifacts[0].fileName, 'model.glb')
    assert.equal(multiImageLuxPoll.artifacts[0].metadata?.output_index, 0)
    assert.equal(multiImageLuxPoll.artifacts[1].fileName, 'gaussian.ply')
    assert.equal(multiImageLuxPoll.artifacts[1].metadata?.output_index, 1)
  }

  const textWithImageJob = job({
    provider: 'lux3d',
    request_snapshot: {
      output_path_prefix: 'output/spatial/objects/text-image',
      prompt: 'a refined chair',
      provider_options: { source_image_url: 'https://media.example.test/chair.png' },
    },
  })
  await officialLux.submit(textWithImageJob, { providerIdempotencyKey: 'lux-text-image' })
  assert.match(officialLuxRequests[3].url, /\/lux3d\/v1\/generate\/text-to-3d\/task\/create$/)
  assert.deepEqual(await officialLuxRequests[3].json(), {
    img: 'https://media.example.test/chair.png',
    prompt: 'a refined chair',
    outputFormat: ['glb'],
    version: 'G1',
    faceCount: 60000,
  })
  await assert.rejects(
    officialLux.submit(job({
      provider: 'lux3d',
      request_snapshot: {
        output_path_prefix: 'output/spatial/objects/invalid-multi',
        prompt: 'must not silently drop this prompt',
        provider_options: {
          source_image_urls: [
            'https://media.example.test/a.png',
            'https://media.example.test/b.png',
          ],
        },
      },
    }), { providerIdempotencyKey: 'invalid-multi' }),
    /at most one frozen reference image/,
  )

  const officialAholoRequests: Request[] = []
  const officialAholo = new AholoAdapter({
    token: 'aholo-raw-key',
    allowPaidCalls: true,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init)
      officialAholoRequests.push(request)
      return request.method === 'POST'
        ? Response.json({ worldId: 'world-fixture' })
        : Response.json({
            status: 'SUCCEEDED',
            assets: {
              imagery: { panoUrl: 'https://assets.example.test/world/pano.jpg' },
              splats: { urls: {
                plyPath: 'https://assets.example.test/world/world.ply',
                spzPath: 'https://assets.example.test/world/world.spz',
                lodMetaPath: 'https://assets.example.test/world/lod.json',
              } },
              semanticsMetadata: { upAxis: 'Y' },
            },
          })
    },
  })
  const worldJob = job({
    kind: 'world',
    provider: 'aholo',
    request_snapshot: {
      output_path_prefix: 'output/spatial/worlds/official-aholo',
      prompt: 'quiet reading room',
      provider_options: { source_image_url: 'https://media.example.test/authorized-room.png' },
    },
  })
  const aholoSubmission = await officialAholo.submit(worldJob, { providerIdempotencyKey: 'aholo-idem' })
  assert.equal(officialAholoRequests[0].headers.get('Authorization'), 'aholo-raw-key')
  assert.equal(officialAholoRequests[0].headers.get('x-source'), 'skills')
  assert.equal(officialAholoRequests[0].headers.get('Idempotency-Key'), null)
  assert.deepEqual(await officialAholoRequests[0].json(), {
    resources: [{ url: 'https://media.example.test/authorized-room.png', type: 'image' }],
    prompt: 'quiet reading room',
  })
  const aholoPoll = await officialAholo.poll({
    ...worldJob,
    external_job_id: aholoSubmission.externalJobId,
  }, {})
  assert.equal(aholoPoll.state, 'succeeded')
  if (aholoPoll.state === 'succeeded') {
    assert.deepEqual(aholoPoll.artifacts.map(value => value.assetKey), [
      'world-pano',
      'world-ply',
      'world-spz',
      'world-lod-metadata',
    ])
    assert.equal(aholoPoll.artifacts[1].metadata?.up_axis, 'Y')
  }
  assert.throws(
    () => createAholoOfficialWireContract().decodePoll({ status: 'completed', assets: {} }, fixtureJob),
    /unsupported status/,
  )

  const uploadRequests: Request[] = []
  const uploadAholo = new AholoAdapter({
    token: 'aholo-raw-key',
    allowPaidCalls: true,
    sourceImageLoader: async assetId => {
      assert.equal(assetId, 'asset_world_source')
      return { buffer: Buffer.from('png-fixture'), mimeType: 'image/png', filename: 'world-source.png' }
    },
    fetchImpl: async (input, init) => {
      const request = new Request(input, init)
      uploadRequests.push(request)
      if (request.url.endsWith('/asset/v1/token')) {
        return Response.json({
          ousToken: 'ous-token-fixture',
          globalDomain: 'https://ous-cos.kujiale.com',
          blockSize: 5 * 1024 * 1024,
        })
      }
      if (request.url.endsWith('/ous/api/v2/single/upload')) {
        assert.equal(request.headers.get('ous-token-v2'), 'ous-token-fixture')
        return Response.json({ c: 0, m: 'ok', d: { taskId: 'upload-fixture' } })
      }
      if (request.url.endsWith('/ous/api/v2/upload/status')) {
        return Response.json({
          c: 0,
          m: 'ok',
          d: { status: 5, url: 'https://qhstaticssl.kujiale.com/assets/world-source.png' },
        })
      }
      if (request.url.endsWith('/world/v1/generations')) {
        assert.deepEqual(await request.json(), {
          resources: [{
            url: 'https://qhstaticssl.kujiale.com/assets/world-source.png',
            type: 'image',
          }],
          prompt: 'quiet reading room',
        })
        return Response.json({ worldId: 'world-upload-fixture' })
      }
      throw new Error(`unexpected Aholo URL: ${request.url}`)
    },
  })
  const uploadSubmission = await uploadAholo.submit(job({
    kind: 'world',
    provider: 'aholo',
    request_snapshot: {
      output_path_prefix: 'output/spatial/worlds/upload-aholo',
      prompt: 'quiet reading room',
      provider_options: {
        source_asset_id: 'asset_world_source',
        source_image_url: 'https://media.example.test/original.png',
      },
    },
  }), { providerIdempotencyKey: 'internal-only' })
  assert.equal(uploadSubmission.externalJobId, 'world-upload-fixture')
  assert.deepEqual(uploadRequests.map(request => new URL(request.url).pathname), [
    '/asset/v1/token',
    '/ous/api/v2/single/upload',
    '/ous/api/v2/upload/status',
    '/world/v1/generations',
  ])
}

async function verifyStableToolResult(): Promise<void> {
  const serialized = serializeSpatialToolResult({
    schema_version: SPATIAL_TOOL_RESULT_SCHEMA_VERSION,
    job_id: 'spjob_1',
    kind: 'world',
    status: 'running',
    provider: 'aholo',
    message: '仍在后台运行',
    created_at: '2026-08-25T00:00:00.000Z',
    elapsed_ms: 1_250,
    relations: [{ kind: 'conditioned_by', artifact_id: 'asset_source' }],
    metadata: { up_axis: 'Y', size_bytes: 12 },
    updated_at: '2026-08-25T00:00:00.000Z',
  })
  assert.deepEqual(parseSpatialToolResult(serialized), JSON.parse(serialized))
  assert.equal(parseSpatialToolResult(JSON.stringify({
    ...JSON.parse(serialized),
    buffer: 'base64 bytes are forbidden',
  })), null)
}

async function main(): Promise<void> {
  await verifyIdentityAndStateMachine()
  await verifyByteInspectionAndMirroring()
  await verifyAdaptersFailClosedAndUseFixtures()
  await verifyStableToolResult()
  console.log('✓ Spatial durable core verification passed')
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
