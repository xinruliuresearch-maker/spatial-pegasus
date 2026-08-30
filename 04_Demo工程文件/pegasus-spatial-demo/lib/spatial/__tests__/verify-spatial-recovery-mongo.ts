import assert from 'node:assert/strict'

const TEST_DATABASE_SUFFIX = '_test'
const mongoUri = process.env.SPATIAL_TEST_MONGODB_URI?.trim()
  || 'mongodb://127.0.0.1:27019/pegasus_spatial_build_test'
const databaseName = mongoUri.match(/\/([^/?]+)(?:\?|$)/)?.[1]

if (!databaseName?.endsWith(TEST_DATABASE_SUFFIX)) {
  throw new Error(`Refusing to run Spatial integration tests outside an isolated *${TEST_DATABASE_SUFFIX} database.`)
}

process.env.MONGODB_URI = mongoUri
process.env.MEDIA_PUBLIC_BASE_URL ||= 'https://media.example.test'

const resolvePublicFixtureHostname = async (): Promise<readonly string[]> => ['93.184.216.34']

function glbFixture(): Buffer {
  const buffer = Buffer.alloc(12)
  buffer.write('glTF', 0, 'ascii')
  buffer.writeUInt32LE(2, 4)
  buffer.writeUInt32LE(buffer.length, 8)
  return buffer
}

function pngFixture(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  )
}

async function main(): Promise<void> {
  const mongoose = (await import('mongoose')).default
  const { connectDB } = await import('../../db/mongodb')
  const { QueuedMessage } = await import('../../db/queue-model')
  const { AgentRun, ConversationRuntime } = await import('../../agent-runtime/models')
  const { AGENT_TEAM_MODELS, agentTeamService } = await import('../../agent-team')
  const spatial = await import('..')
  const {
    FakeSpatialProviderAdapter,
    InMemorySpatialAssetPublisher,
    ProviderConfigurationBlockedError,
    ProviderTransientError,
    SpatialArtifactNodeModel,
    SpatialBuildJobModel,
    SpatialPaidSlotModel,
    SpatialStagedBatchModel,
    SpatialIdempotencyConflictError,
    SpatialOutputPathConflictError,
    SpatialPaidCapacityError,
    acquireSpatialPaidSlot,
    bindSpatialPaidSlot,
    claimNextSpatialBuildJob,
    countActiveSpatialJobs,
    deliverSpatialJobCompletion,
    createWorkspaceSpatialPublisher,
    failSpatialJob,
    getSpatialJobResult,
    inspectSpatialArtifactResult,
    markSpatialJobMaterializing,
    markSpatialJobSubmitting,
    prepareSpatialBuild,
    processClaimedSpatialBuildJob,
    recordSpatialJobSubmitted,
    recoverAmbiguousSpatialSubmissions,
    registerPublishedSpatialArtifact,
    spatialStageObjectId,
  } = spatial

  await connectDB()
  const database = mongoose.connection.db
  assert.ok(database, 'MongoDB test connection must expose a database')
  await database.dropDatabase()
  await Promise.all([
    SpatialBuildJobModel.syncIndexes(),
    SpatialArtifactNodeModel.syncIndexes(),
    SpatialPaidSlotModel.syncIndexes(),
    SpatialStagedBatchModel.syncIndexes(),
    QueuedMessage.syncIndexes(),
    AgentRun.syncIndexes(),
    ConversationRuntime.syncIndexes(),
    ...AGENT_TEAM_MODELS.map(model => model.syncIndexes()),
  ])

  const scope = { projectId: 'project_spatial', userId: 'user_spatial' }
  const prepare = (toolUseId: string) => prepareSpatialBuild({
    projectId: scope.projectId,
    runId: 'run_spatial',
    toolUseId,
    userId: scope.userId,
    conversationId: 'conversation_spatial',
    kind: 'object' as const,
    provider: 'fake',
    modelSnapshot: 'fake-v1',
    request: {
      output_path_prefix: `output/spatial/objects/${toolUseId}`,
      prompt: 'a fixture object',
      provider_options: { source_asset_id: 'asset_fixture_source' },
    },
  })

  try {
    const ambiguous = await prepare('tool_ambiguous')
    const replay = await prepare('tool_ambiguous')
    assert.equal(replay.job_id, ambiguous.job_id)
    assert.equal(await SpatialBuildJobModel.countDocuments({ job_id: ambiguous.job_id }), 1)
    await assert.rejects(
      prepareSpatialBuild({
        projectId: scope.projectId,
        runId: 'run_spatial',
        toolUseId: 'tool_ambiguous',
        userId: scope.userId,
        conversationId: 'conversation_spatial',
        kind: 'object',
        provider: 'fake',
        modelSnapshot: 'fake-v1',
        request: {
          output_path_prefix: 'output/spatial/objects/tool_ambiguous',
          prompt: 'different frozen request',
        },
      }),
      SpatialIdempotencyConflictError,
    )

    const competingClaims = await Promise.all([
      claimNextSpatialBuildJob('worker_alpha', 30_000),
      claimNextSpatialBuildJob('worker_beta', 30_000),
    ])
    const winner = competingClaims.find((value): value is NonNullable<typeof value> => value !== null)
    assert.ok(winner)
    assert.equal(competingClaims.filter(Boolean).length, 1, 'only one worker may lease a prepared job')
    const submitting = await markSpatialJobSubmitting(winner)

    // Crash window: status is `submitting`, but no external id was durably
    // recorded. A takeover must not spend again.
    await SpatialBuildJobModel.updateOne(
      { job_id: submitting.job.job_id },
      { $set: { 'lease.expires_at': new Date(0) } },
    )
    const recoveredAmbiguity = await recoverAmbiguousSpatialSubmissions()
    assert.equal(recoveredAmbiguity.unknown, 1)
    const unknown = await SpatialBuildJobModel.findOne({ job_id: ambiguous.job_id }).lean()
    assert.equal(unknown?.status, 'unknown')
    assert.equal(unknown?.external_job_id, null)

    // Crash window after external id commit. Takeover resumes polling and never
    // invokes submit again.
    const submittedSeed = await prepare('tool_submitted_recovery')
    const submitClaim = await claimNextSpatialBuildJob('worker_submit', 30_000)
    assert.equal(submitClaim?.job.job_id, submittedSeed.job_id)
    const submitStarted = await markSpatialJobSubmitting(submitClaim!)
    const submitted = await recordSpatialJobSubmitted(submitStarted, {
      externalJobId: 'external_submitted_recovery',
      providerStatus: 'queued',
    })
    await SpatialBuildJobModel.updateOne(
      { job_id: submitted.job.job_id },
      { $set: { 'lease.expires_at': new Date(0) } },
    )
    const takeover = await claimNextSpatialBuildJob('worker_takeover', 30_000)
    assert.equal(takeover?.job.job_id, submittedSeed.job_id)
    assert.equal(takeover?.job.status, 'submitted')

    const bytes = glbFixture()
    const adapter = new FakeSpatialProviderAdapter({
      externalJobId: 'must_not_be_used',
      pollResults: [{
        state: 'succeeded',
        artifacts: [{
          assetKey: 'main-glb',
          kind: 'model',
          fileName: 'model.glb',
          remoteUrl: 'https://assets.example.test/model.glb?expires=soon',
          claimedMimeType: 'model/gltf-binary',
        }],
      }],
    })
    const publisher = new InMemorySpatialAssetPublisher()
    const published = await processClaimedSpatialBuildJob(takeover!, {
      adapters: new Map([['fake', adapter]]),
      publisher,
      allowedArtifactHosts: () => ['assets.example.test'],
      resolveArtifactHostname: resolvePublicFixtureHostname,
      fetchImpl: async () => new Response(new Uint8Array(bytes), {
        headers: { 'Content-Type': 'model/gltf-binary' },
      }),
    })
    assert.equal(published.job.status, 'published')
    assert.equal(adapter.submissions.length, 0, 'a submitted takeover must only poll')
    assert.equal(adapter.polls.length, 1)
    assert.equal(published.job.published_artifact_ids.length, 2)

    const terminalSeed = await prepare('tool_provider_terminal_status')
    const providerTerminalClaim = await claimNextSpatialBuildJob('worker_terminal_status', 30_000)
    assert.equal(providerTerminalClaim?.job.job_id, terminalSeed.job_id)
    const terminalSubmitting = await markSpatialJobSubmitting(providerTerminalClaim!)
    const terminalSubmitted = await recordSpatialJobSubmitted(terminalSubmitting, {
      externalJobId: 'external_terminal_status', providerStatus: 'running',
    })
    const terminalResult = await processClaimedSpatialBuildJob(terminalSubmitted, {
      adapters: { fake: new FakeSpatialProviderAdapter({ pollResults: [{ state: 'failed', providerStatus: 'rejected' }] }) },
      publisher: new InMemorySpatialAssetPublisher(),
    })
    assert.equal(terminalResult.job.status, 'failed')
    assert.equal(terminalResult.job.provider_status, 'rejected', 'terminal provider status must replace stale running diagnostics')

    // Terminal commit -> Root reminder is durable and idempotent. A retry
    // with the stale pre-dispatch snapshot must reuse the same queue receipt.
    const notificationConversation = 'conversation_spatial_notification'
    const notificationUser = 'user_spatial_notification'
    await agentTeamService.ensureTeam({
      conversationId: notificationConversation,
      userId: notificationUser,
    })
    const notificationSeed = await prepareSpatialBuild({
      projectId: notificationConversation,
      runId: 'run_notification_origin',
      toolUseId: 'tool_notification_origin',
      userId: notificationUser,
      conversationId: notificationConversation,
      kind: 'object',
      provider: 'fake',
      request: {
        output_path_prefix: 'output/spatial/objects/notification-origin',
        prompt: 'notification fixture',
      },
      notifyOnTerminal: true,
    })
    const notificationFinishedAt = new Date('2026-08-27T12:00:00.000Z')
    const notificationTerminal = await SpatialBuildJobModel.findOneAndUpdate({
      job_id: notificationSeed.job_id,
    }, {
      $set: {
        status: 'published',
        status_revision: 4,
        published_artifact_ids: ['artifact_notification'],
        published_workspace_paths: ['output/spatial/objects/notification-origin/model.glb'],
        finished_at: notificationFinishedAt,
        updated_at: notificationFinishedAt,
      },
    }, { returnDocument: 'after' }).lean()
    assert.ok(notificationTerminal)
    assert.equal(await deliverSpatialJobCompletion(notificationTerminal), true)
    const notificationKey = `spatial-job-terminal:v1:${notificationTerminal.job_id}:4`
    assert.equal(await QueuedMessage.countDocuments({
      conversation_id: notificationConversation,
      idempotency_key: notificationKey,
    }), 1)
    assert.equal(
      (await SpatialBuildJobModel.findOne({ job_id: notificationTerminal.job_id }).lean())
        ?.completion_notified_at instanceof Date,
      true,
    )
    assert.equal(
      await deliverSpatialJobCompletion(notificationTerminal),
      false,
      'stale terminal replay may rediscover the receipt but must not mark a second dispatch',
    )
    assert.equal(await QueuedMessage.countDocuments({
      conversation_id: notificationConversation,
      idempotency_key: notificationKey,
    }), 1)

    const result = await getSpatialJobResult({ jobId: published.job.job_id, scope })
    assert.equal(result.status, 'published')
    assert.deepEqual(result.workspace_paths, [
      'output/spatial/objects/tool_submitted_recovery/model.glb',
      'output/spatial/objects/tool_submitted_recovery/manifest.json',
    ])
    assert.deepEqual(result.relations, [{
      kind: 'conditioned_by',
      artifact_id: 'asset_fixture_source',
    }])
    assert.doesNotMatch(JSON.stringify(result), /expires=soon|a fixture object|external_submitted/)
    const inspected = await inspectSpatialArtifactResult({
      artifactId: published.job.published_artifact_ids[0],
      scope,
    })
    assert.equal(inspected.status, 'published')
    assert.equal(inspected.artifact_id, published.job.published_artifact_ids[0])
    assert.deepEqual(inspected.relations, [{
      kind: 'conditioned_by',
      artifact_id: 'asset_fixture_source',
    }])
    const manifestNode = await SpatialArtifactNodeModel.findOne({
      job_id: published.job.job_id,
      kind: 'manifest',
    }).lean()
    assert.ok(manifestNode)
    const manifestBytes = publisher.readPublished(manifestNode.artifact_id)
    assert.ok(manifestBytes)
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
      job_id: string
      publication_token: string
      assets: Array<Record<string, unknown>>
      relations: Array<Record<string, unknown>>
    }
    assert.equal(manifest.job_id, published.job.job_id)
    assert.ok(manifest.publication_token.startsWith('sppub_'))
    assert.equal(manifest.assets[0].mime_type, 'model/gltf-binary')
    assert.equal(manifest.assets[0].size_bytes, bytes.length)
    assert.match(String(manifest.assets[0].sha256), /^[a-f0-9]{64}$/)
    assert.deepEqual(manifest.relations, [{
      kind: 'conditioned_by',
      artifact_id: 'asset_fixture_source',
    }])

    // Crash window after provider success but before mirroring. The next lease
    // polls the known external job and completes the same durable Job.
    const materializingSeed = await prepare('tool_materializing_recovery')
    const materializingClaim = await claimNextSpatialBuildJob('worker_materializing', 30_000)
    assert.equal(materializingClaim?.job.job_id, materializingSeed.job_id)
    const materializingSubmit = await recordSpatialJobSubmitted(
      await markSpatialJobSubmitting(materializingClaim!),
      { externalJobId: 'external_materializing' },
    )
    const materializing = await markSpatialJobMaterializing(materializingSubmit, 'succeeded')
    await SpatialBuildJobModel.updateOne(
      { job_id: materializing.job.job_id },
      { $set: { 'lease.expires_at': new Date(0) } },
    )
    const materializingTakeover = await claimNextSpatialBuildJob('worker_materializing_takeover', 30_000)
    assert.equal(materializingTakeover?.job.status, 'materializing')
    const materializingAdapter = new FakeSpatialProviderAdapter({
      pollResults: [{
        state: 'succeeded',
        artifacts: [{
          assetKey: 'recovered-glb',
          kind: 'model',
          fileName: 'recovered.glb',
          remoteUrl: 'https://assets.example.test/recovered.glb',
        }],
      }],
    })
    const materialized = await processClaimedSpatialBuildJob(materializingTakeover!, {
      adapters: { fake: materializingAdapter },
      publisher,
      resolveArtifactHostname: resolvePublicFixtureHostname,
      fetchImpl: async () => new Response(new Uint8Array(bytes), {
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    })
    assert.equal(materialized.job.status, 'published')
    assert.equal(materializingAdapter.submissions.length, 0)

    // Crash after all provider bytes were durably mirrored but before the
    // Workspace batch committed. A fresh publisher instance must recover from
    // GridFS without polling or touching the short-lived URL again.
    const durableSeed = await prepare('tool_durable_stage_recovery')
    const durableClaim = await claimNextSpatialBuildJob('worker_durable_stage', 30_000)
    assert.equal(durableClaim?.job.job_id, durableSeed.job_id)
    const durableSubmitted = await recordSpatialJobSubmitted(
      await markSpatialJobSubmitting(durableClaim!),
      { externalJobId: 'external_durable_stage' },
    )
    const durableMaterializing = await markSpatialJobMaterializing(durableSubmitted, 'succeeded')
    let crashPublication = true
    const committed = new Map<string, Buffer>()
    let workspaceWrites = 0
    const workspace = {
      exists(path: string) { return committed.has(path) },
      async readRaster() { return null },
      async readRasterBuffer() { return null },
      async readDocument(path: string) {
        const buffer = committed.get(path)
        if (!buffer || path.endsWith('.json')) return null
        return {
          path,
          filename: path.split('/').at(-1)!,
          mimeType: 'model/gltf-binary',
          sizeBytes: buffer.length,
          sha256: (await import('node:crypto')).createHash('sha256').update(buffer).digest('hex'),
          source: { provider: 'fake' },
          provenance: { retrieved_at: new Date().toISOString() },
        }
      },
      async readText(path: string) {
        return path.endsWith('.json') ? committed.get(path)?.toString('utf8') ?? null : null
      },
      async withFileSetReservation(_paths: string[], _key: string, callback: () => Promise<void>) {
        if (crashPublication) throw new Error('fixture crash after durable stage')
        await callback()
      },
      async writeDocument(input: { path: string; buffer: Buffer }) {
        workspaceWrites += 1
        committed.set(input.path, Buffer.from(input.buffer))
      },
      async writeText(path: string, content: string) {
        workspaceWrites += 1
        committed.set(path, Buffer.from(content, 'utf8'))
      },
      async writeRasters() {},
    }
    const durablePublisher = createWorkspaceSpatialPublisher({
      resolveWorkspace: async () => workspace as never,
    })
    const orphanArtifactId = 'spart_mid_upload_orphan_fixture'
    const orphanFileId = spatialStageObjectId(orphanArtifactId)
    await database.collection('pegasus_spatial_staging.chunks').insertOne({
      _id: new mongoose.Types.ObjectId(),
      files_id: orphanFileId,
      n: 0,
      data: Buffer.from('interrupted upload'),
    })
    const orphanBytes = glbFixture()
    const orphanStage = await durablePublisher.stage({
      job: durableMaterializing.job,
      publicationToken: 'sppub_orphan_repair',
      artifactId: orphanArtifactId,
      providerAssetKey: 'orphan-repair',
      kind: 'model',
      filename: 'orphan-repair.glb',
      workspacePath: 'output/spatial/objects/orphan-repair/orphan-repair.glb',
      buffer: orphanBytes,
      mimeType: 'model/gltf-binary',
      sha256: (await import('node:crypto')).createHash('sha256').update(orphanBytes).digest('hex'),
      relations: [],
      metadata: {},
    })
    assert.equal(orphanStage.stageId, orphanFileId.toString())
    assert.equal(await database.collection('pegasus_spatial_staging.chunks').countDocuments({
      files_id: orphanFileId,
    }), 1, 'mid-upload orphan chunks must be replaced by one complete GridFS object')
    await durablePublisher.discardJobStages({
      job: durableMaterializing.job,
      publicationToken: 'sppub_orphan_repair',
    })

    // A failure after raster mutation but during Workspace file-set finalize
    // must return the newly claimed capability asset to private staged state.
    const rasterBytes = pngFixture()
    const rasterSha = (await import('node:crypto')).createHash('sha256').update(rasterBytes).digest('hex')
    const finalizeFaultPublisher = createWorkspaceSpatialPublisher({
      resolveWorkspace: async () => ({
        exists: () => false,
        async readRaster() { return null },
        async readRasterBuffer() { return null },
        async readDocument() { return null },
        async readText() { return null },
        async writeRasters() {},
        async withFileSetReservation(_paths: string[], _key: string, callback: () => Promise<void>) {
          await callback()
          throw new Error('fixture finalize fence fault')
        },
      }) as never,
    })
    const rasterStage = await finalizeFaultPublisher.stage({
      job: durableMaterializing.job,
      publicationToken: 'sppub_finalize_raster_fault',
      artifactId: 'spart_finalize_raster_fault',
      providerAssetKey: 'preview',
      kind: 'thumbnail',
      filename: 'preview.png',
      workspacePath: 'output/spatial/objects/finalize-raster-fault/preview.png',
      buffer: rasterBytes,
      mimeType: 'image/png',
      sha256: rasterSha,
      relations: [],
      metadata: {},
    })
    await finalizeFaultPublisher.markBatchReady({
      job: durableMaterializing.job,
      publicationToken: 'sppub_finalize_raster_fault',
      assets: [rasterStage],
    })
    await assert.rejects(
      finalizeFaultPublisher.publishBatch({
        job: durableMaterializing.job,
        publicationToken: 'sppub_finalize_raster_fault',
        assets: [rasterStage],
      }),
      /finalize fence fault/,
    )
    const { ImageAsset } = await import('../../media/model')
    const rolledBackRaster = await ImageAsset.findOne({
      owner_user_id: durableMaterializing.job.user_id,
      sha256: rasterSha,
    }).lean()
    assert.equal(rolledBackRaster?.state, 'staged')
    assert.equal(rolledBackRaster?.conversation_id, null)
    await finalizeFaultPublisher.discardJobStages({
      job: durableMaterializing.job,
      publicationToken: 'sppub_finalize_raster_fault',
    })
    const shortUrlAdapter = new FakeSpatialProviderAdapter({
      pollResults: [{
        state: 'succeeded',
        artifacts: [{
          assetKey: 'durable-glb',
          kind: 'model',
          fileName: 'durable.glb',
          remoteUrl: 'https://assets.example.test/durable.glb?expires=immediately',
        }],
      }],
    })
    let durableFetches = 0
    await processClaimedSpatialBuildJob(durableMaterializing, {
      adapters: { fake: shortUrlAdapter },
      publisher: durablePublisher,
      resolveArtifactHostname: resolvePublicFixtureHostname,
      fetchImpl: async () => {
        durableFetches += 1
        return new Response(new Uint8Array(bytes), {
          headers: { 'Content-Type': 'application/octet-stream' },
        })
      },
    }, { providerPollDelayMs: 1 })
    assert.equal(durableFetches, 1)
    assert.equal(await SpatialStagedBatchModel.countDocuments({ job_id: durableSeed.job_id }), 1)
    await SpatialBuildJobModel.updateOne(
      { job_id: durableSeed.job_id },
      { $set: { lease: null, available_at: new Date(0) } },
    )
    crashPublication = false
    const durableTakeover = await claimNextSpatialBuildJob('worker_durable_stage_takeover', 30_000)
    assert.equal(durableTakeover?.job.status, 'materializing')
    const mustNotPoll = new FakeSpatialProviderAdapter({
      pollResults: [{ state: 'failed', error: 'recovery must not poll provider' }],
    })
    const restartedPublisher = createWorkspaceSpatialPublisher({
      resolveWorkspace: async () => workspace as never,
    })
    const readyBeforeJobCommit = await restartedPublisher.recoverReadyBatch({
      job: durableTakeover!.job,
      publicationToken: spatial.spatialPublicationToken(durableTakeover!.job.job_id),
    })
    assert.ok(readyBeforeJobCommit)
    await restartedPublisher.publishBatch({
      job: durableTakeover!.job,
      publicationToken: spatial.spatialPublicationToken(durableTakeover!.job.job_id),
      assets: readyBeforeJobCommit,
    })
    assert.equal(workspaceWrites, 2)
    const durablePublished = await processClaimedSpatialBuildJob(durableTakeover!, {
      adapters: { fake: mustNotPoll },
      publisher: restartedPublisher,
      fetchImpl: async () => {
        throw new Error('expired provider URL must not be fetched')
      },
    })
    assert.equal(durablePublished.job.status, 'published')
    assert.equal(mustNotPoll.polls.length, 0)
    assert.equal(durableFetches, 1)
    assert.equal(workspaceWrites, 2, 'exact published heads must replay without rewriting Workspace versions')
    assert.ok(committed.has('output/spatial/objects/tool_durable_stage_recovery/durable.glb'))
    assert.ok(committed.has('output/spatial/objects/tool_durable_stage_recovery/manifest.json'))
    assert.equal(await SpatialStagedBatchModel.countDocuments({ job_id: durableSeed.job_id }), 0)

    // Known paid task + temporarily missing API key/config remains recoverable
    // and does not consume the consecutive transient-failure budget.
    const blockedSeed = await prepare('tool_configuration_blocked')
    const blockedClaim = await claimNextSpatialBuildJob('worker_configuration_blocked', 30_000)
    assert.equal(blockedClaim?.job.job_id, blockedSeed.job_id)
    const blockedSubmitted = await recordSpatialJobSubmitted(
      await markSpatialJobSubmitting(blockedClaim!),
      { externalJobId: 'external_configuration_blocked' },
    )
    const blockedAdapter = {
      provider: 'fake',
      supports: () => true,
      async submit() { throw new Error('must not submit known paid task') },
      async poll() { throw new ProviderConfigurationBlockedError('fixture API key missing') },
    }
    await processClaimedSpatialBuildJob(blockedSubmitted, {
      adapters: { fake: blockedAdapter },
      publisher,
    })
    let blockedRecord = await SpatialBuildJobModel.findOne({ job_id: blockedSeed.job_id }).lean()
    assert.equal(blockedRecord?.status, 'submitted')
    assert.equal(blockedRecord?.provider_status, 'configuration_blocked')
    assert.equal(blockedRecord?.consecutive_failures, 0)
    await SpatialBuildJobModel.updateOne(
      { job_id: blockedSeed.job_id },
      { $set: { available_at: new Date(0) } },
    )
    const restoredClaim = await claimNextSpatialBuildJob('worker_configuration_restored', 30_000)
    assert.equal(restoredClaim?.job.job_id, blockedSeed.job_id)
    const restoredAdapter = new FakeSpatialProviderAdapter({
      pollResults: [{
        state: 'succeeded',
        artifacts: [{
          assetKey: 'restored-glb',
          kind: 'model',
          fileName: 'restored.glb',
          remoteUrl: 'https://assets.example.test/restored.glb',
        }],
      }],
    })
    const restored = await processClaimedSpatialBuildJob(restoredClaim!, {
      adapters: { fake: restoredAdapter },
      publisher,
      resolveArtifactHostname: resolvePublicFixtureHostname,
      fetchImpl: async () => new Response(new Uint8Array(bytes)),
    })
    assert.equal(restored.job.status, 'published')

    // Artifact allowlist absence after provider success is also a reversible
    // configuration block, not a permanent failure of already-paid work.
    const allowlistSeed = await prepare('tool_allowlist_blocked')
    const allowlistClaim = await claimNextSpatialBuildJob('worker_allowlist_blocked', 30_000)
    const allowlistSubmitted = await recordSpatialJobSubmitted(
      await markSpatialJobSubmitting(allowlistClaim!),
      { externalJobId: 'external_allowlist_blocked' },
    )
    const allowlistAdapter = new FakeSpatialProviderAdapter({
      pollResults: [
        {
          state: 'succeeded',
          artifacts: [{
            assetKey: 'allowlist-glb',
            kind: 'model',
            fileName: 'allowlist.glb',
            remoteUrl: 'https://assets.example.test/allowlist.glb',
          }],
        },
        {
          state: 'succeeded',
          artifacts: [{
            assetKey: 'allowlist-glb',
            kind: 'model',
            fileName: 'allowlist.glb',
            remoteUrl: 'https://assets.example.test/allowlist.glb',
          }],
        },
      ],
    })
    let allowlistConfigured = false
    let allowlistFetches = 0
    await processClaimedSpatialBuildJob(allowlistSubmitted, {
      adapters: { fake: allowlistAdapter },
      publisher,
      artifactMirroringConfigured: () => allowlistConfigured,
      fetchImpl: async () => {
        allowlistFetches += 1
        return new Response(new Uint8Array(bytes))
      },
    })
    blockedRecord = await SpatialBuildJobModel.findOne({ job_id: allowlistSeed.job_id }).lean()
    assert.equal(blockedRecord?.status, 'materializing')
    assert.equal(blockedRecord?.provider_status, 'configuration_blocked')
    assert.equal(allowlistFetches, 0)
    allowlistConfigured = true
    await SpatialBuildJobModel.updateOne(
      { job_id: allowlistSeed.job_id },
      { $set: { available_at: new Date(0) } },
    )
    const allowlistTakeover = await claimNextSpatialBuildJob('worker_allowlist_restored', 30_000)
    const allowlistPublished = await processClaimedSpatialBuildJob(allowlistTakeover!, {
      adapters: { fake: allowlistAdapter },
      publisher,
      artifactMirroringConfigured: () => allowlistConfigured,
      resolveArtifactHostname: resolvePublicFixtureHostname,
      fetchImpl: async () => {
        allowlistFetches += 1
        return new Response(new Uint8Array(bytes))
      },
    })
    assert.equal(allowlistPublished.job.status, 'published')
    assert.equal(allowlistFetches, 1)

    // A temporary DNS resolver outage must release the known paid task for a
    // retry. It is not a permanent artifact validation failure and must retain
    // the external task identity without another submission.
    const dnsSeed = await prepare('tool_dns_transient')
    const dnsClaim = await claimNextSpatialBuildJob('worker_dns_transient', 30_000)
    const dnsSubmitted = await recordSpatialJobSubmitted(
      await markSpatialJobSubmitting(dnsClaim!),
      { externalJobId: 'external_dns_transient' },
    )
    const dnsAdapter = new FakeSpatialProviderAdapter({
      pollResults: [1, 2].map(() => ({
        state: 'succeeded' as const,
        artifacts: [{
          assetKey: 'dns-glb',
          kind: 'model' as const,
          fileName: 'dns.glb',
          remoteUrl: 'https://assets.example.test/dns.glb',
        }],
      })),
    })
    let dnsFetches = 0
    await processClaimedSpatialBuildJob(dnsSubmitted, {
      adapters: { fake: dnsAdapter },
      publisher,
      allowedArtifactHosts: () => ['assets.example.test'],
      resolveArtifactHostname: async () => { throw new Error('fixture DNS outage') },
      fetchImpl: async () => {
        dnsFetches += 1
        return new Response(new Uint8Array(bytes))
      },
    }, { providerPollDelayMs: 1 })
    let dnsRecord = await SpatialBuildJobModel.findOne({ job_id: dnsSeed.job_id }).lean()
    assert.equal(dnsRecord?.status, 'materializing')
    assert.equal(dnsRecord?.external_job_id, 'external_dns_transient')
    assert.equal(dnsRecord?.consecutive_failures, 1)
    assert.equal(dnsFetches, 0)
    await SpatialBuildJobModel.updateOne(
      { job_id: dnsSeed.job_id },
      { $set: { available_at: new Date(0) } },
    )
    const dnsRetry = await claimNextSpatialBuildJob('worker_dns_recovered', 30_000)
    const dnsPublished = await processClaimedSpatialBuildJob(dnsRetry!, {
      adapters: { fake: dnsAdapter },
      publisher,
      allowedArtifactHosts: () => ['assets.example.test'],
      resolveArtifactHostname: resolvePublicFixtureHostname,
      fetchImpl: async () => {
        dnsFetches += 1
        return new Response(new Uint8Array(bytes))
      },
    })
    assert.equal(dnsPublished.job.status, 'published')
    assert.equal(dnsAdapter.submissions.length, 0)
    assert.equal(dnsFetches, 1)
    dnsRecord = await SpatialBuildJobModel.findOne({ job_id: dnsSeed.job_id }).lean()
    assert.equal(dnsRecord?.external_job_id, 'external_dns_transient')

    // Retryable artifact HTTP statuses preserve the same paid task, while the
    // execution-attempt ceiling still guarantees a terminal bound.
    const httpSeed = await prepare('tool_artifact_http_transient')
    const httpClaim = await claimNextSpatialBuildJob('worker_artifact_http_transient', 30_000)
    const httpSubmitted = await recordSpatialJobSubmitted(
      await markSpatialJobSubmitting(httpClaim!),
      { externalJobId: 'external_artifact_http_transient' },
    )
    const httpAdapter = new FakeSpatialProviderAdapter({
      pollResults: [1, 2].map(() => ({
        state: 'succeeded' as const,
        artifacts: [{
          assetKey: 'http-glb',
          kind: 'model' as const,
          fileName: 'http.glb',
          remoteUrl: 'https://assets.example.test/http.glb',
        }],
      })),
    })
    let httpFetchStatus = 503
    await processClaimedSpatialBuildJob(httpSubmitted, {
      adapters: { fake: httpAdapter },
      publisher,
      allowedArtifactHosts: () => ['assets.example.test'],
      resolveArtifactHostname: resolvePublicFixtureHostname,
      fetchImpl: async () => httpFetchStatus === 200
        ? new Response(new Uint8Array(bytes))
        : new Response(null, { status: httpFetchStatus }),
    }, { providerPollDelayMs: 1 })
    let httpRecord = await SpatialBuildJobModel.findOne({ job_id: httpSeed.job_id }).lean()
    assert.equal(httpRecord?.status, 'materializing')
    assert.equal(httpRecord?.external_job_id, 'external_artifact_http_transient')
    assert.equal(httpRecord?.consecutive_failures, 1)
    httpFetchStatus = 200
    await SpatialBuildJobModel.updateOne(
      { job_id: httpSeed.job_id },
      { $set: { available_at: new Date(0) } },
    )
    const httpRetry = await claimNextSpatialBuildJob('worker_artifact_http_recovered', 30_000)
    const httpPublished = await processClaimedSpatialBuildJob(httpRetry!, {
      adapters: { fake: httpAdapter },
      publisher,
      allowedArtifactHosts: () => ['assets.example.test'],
      resolveArtifactHostname: resolvePublicFixtureHostname,
      fetchImpl: async () => new Response(new Uint8Array(bytes)),
    })
    assert.equal(httpPublished.job.status, 'published')
    assert.equal(httpAdapter.submissions.length, 0)
    httpRecord = await SpatialBuildJobModel.findOne({ job_id: httpSeed.job_id }).lean()
    assert.equal(httpRecord?.external_job_id, 'external_artifact_http_transient')

    const exhaustedSeed = await prepare('tool_artifact_http_exhausted')
    const exhaustedClaim = await claimNextSpatialBuildJob('worker_artifact_http_exhausted_1', 30_000)
    const exhaustedSubmitted = await recordSpatialJobSubmitted(
      await markSpatialJobSubmitting(exhaustedClaim!),
      { externalJobId: 'external_artifact_http_exhausted' },
    )
    const exhaustedAdapter = new FakeSpatialProviderAdapter({
      pollResults: [1, 2].map(() => ({
        state: 'succeeded' as const,
        artifacts: [{
          assetKey: 'exhausted-glb',
          kind: 'model' as const,
          fileName: 'exhausted.glb',
          remoteUrl: 'https://assets.example.test/exhausted.glb',
        }],
      })),
    })
    const exhaustedDependencies = {
      adapters: { fake: exhaustedAdapter },
      publisher,
      allowedArtifactHosts: () => ['assets.example.test'],
      resolveArtifactHostname: resolvePublicFixtureHostname,
      fetchImpl: async () => new Response(null, { status: 503 }),
    }
    await processClaimedSpatialBuildJob(
      exhaustedSubmitted,
      exhaustedDependencies,
      { maxExecutionAttempts: 2, providerPollDelayMs: 1 },
    )
    await SpatialBuildJobModel.updateOne(
      { job_id: exhaustedSeed.job_id },
      { $set: { available_at: new Date(0) } },
    )
    const exhaustedRetry = await claimNextSpatialBuildJob('worker_artifact_http_exhausted_2', 30_000)
    const exhausted = await processClaimedSpatialBuildJob(
      exhaustedRetry!,
      exhaustedDependencies,
      { maxExecutionAttempts: 2, providerPollDelayMs: 1 },
    )
    assert.equal(exhausted.job.status, 'failed')
    assert.equal(exhausted.job.external_job_id, 'external_artifact_http_exhausted')
    assert.equal(exhaustedAdapter.submissions.length, 0)

    // Normal queued/running polls do not consume transient failure budget.
    // After >12 successful progress polls, one transport fault must still retry.
    const longPollSeed = await prepare('tool_long_poll_recovery')
    const longPollInitial = await claimNextSpatialBuildJob('worker_long_poll_submit', 30_000)
    const longPollSubmitted = await recordSpatialJobSubmitted(
      await markSpatialJobSubmitting(longPollInitial!),
      { externalJobId: 'external_long_poll' },
    )
    let pollMode: 'running' | 'transient' | 'succeeded' = 'running'
    const longPollAdapter = {
      provider: 'fake',
      supports: () => true,
      async submit() { throw new Error('must not submit known task') },
      async poll() {
        if (pollMode === 'transient') throw new ProviderTransientError('fixture transient poll')
        if (pollMode === 'succeeded') return {
          state: 'succeeded' as const,
          artifacts: [{
            assetKey: 'long-poll-glb',
            kind: 'model' as const,
            fileName: 'long-poll.glb',
            remoteUrl: 'https://assets.example.test/long-poll.glb',
          }],
        }
        return { state: 'running' as const }
      },
    }
    await processClaimedSpatialBuildJob(longPollSubmitted, {
      adapters: { fake: longPollAdapter },
      publisher,
    })
    for (let index = 1; index < 13; index += 1) {
      await SpatialBuildJobModel.updateOne(
        { job_id: longPollSeed.job_id },
        { $set: { available_at: new Date(0) } },
      )
      const runningClaim = await claimNextSpatialBuildJob(`worker_long_poll_${index}`, 30_000)
      assert.equal(runningClaim?.job.job_id, longPollSeed.job_id)
      await processClaimedSpatialBuildJob(runningClaim!, {
        adapters: { fake: longPollAdapter },
        publisher,
      })
    }
    pollMode = 'transient'
    await SpatialBuildJobModel.updateOne(
      { job_id: longPollSeed.job_id },
      { $set: { available_at: new Date(0) } },
    )
    const transientClaim = await claimNextSpatialBuildJob('worker_long_poll_transient', 30_000)
    await processClaimedSpatialBuildJob(transientClaim!, {
      adapters: { fake: longPollAdapter },
      publisher,
    })
    const afterTransient = await SpatialBuildJobModel.findOne({ job_id: longPollSeed.job_id }).lean()
    assert.equal(afterTransient?.status, 'running')
    assert.ok((afterTransient?.execution_attempts ?? 0) > 12)
    assert.equal(afterTransient?.consecutive_failures, 1)
    pollMode = 'succeeded'
    await SpatialBuildJobModel.updateOne(
      { job_id: longPollSeed.job_id },
      { $set: { available_at: new Date(0) } },
    )
    const longPollFinish = await claimNextSpatialBuildJob('worker_long_poll_finish', 30_000)
    const longPollPublished = await processClaimedSpatialBuildJob(longPollFinish!, {
      adapters: { fake: longPollAdapter },
      publisher,
      resolveArtifactHostname: resolvePublicFixtureHostname,
      fetchImpl: async () => new Response(new Uint8Array(bytes)),
    })
    assert.equal(longPollPublished.job.status, 'published')

    const registeredImage = await registerPublishedSpatialArtifact({
      artifactId: 'asset_generated_fixture',
      jobId: 'spimg_fixture',
      projectId: scope.projectId,
      userId: scope.userId,
      provider: 'gpt-image-2',
      publicationToken: 'spimg_publication_fixture',
      providerAssetKey: 'generated-image',
      kind: 'image',
      filename: 'generated.png',
      workspacePath: 'output/spatial/images/generated.png',
      storageUri: 'asset:asset_generated_fixture',
      mimeType: 'image/png',
      sizeBytes: 123,
      sha256: 'a'.repeat(64),
      relations: [{ kind: 'conditioned_by', artifact_id: 'asset_input_fixture' }],
      metadata: { schema_version: 1 },
    })
    const registeredReplay = await registerPublishedSpatialArtifact({
      artifactId: 'asset_generated_fixture',
      jobId: 'spimg_fixture',
      projectId: scope.projectId,
      userId: scope.userId,
      provider: 'gpt-image-2',
      publicationToken: 'spimg_publication_fixture',
      providerAssetKey: 'generated-image',
      kind: 'image',
      filename: 'generated.png',
      workspacePath: 'output/spatial/images/generated.png',
      storageUri: 'asset:asset_generated_fixture',
      mimeType: 'image/png',
      sizeBytes: 123,
      sha256: 'a'.repeat(64),
      relations: [{ kind: 'conditioned_by', artifact_id: 'asset_input_fixture' }],
      metadata: { schema_version: 1 },
    })
    assert.equal(registeredReplay.artifact_id, registeredImage.artifact_id)
    const registeredInspection = await inspectSpatialArtifactResult({
      artifactId: registeredImage.artifact_id,
      scope,
    })
    assert.equal(registeredInspection.job_id, 'spimg_fixture')
    assert.deepEqual(registeredInspection.relations, [{
      kind: 'conditioned_by',
      artifact_id: 'asset_input_fixture',
    }])

    assert.equal(await SpatialBuildJobModel.countDocuments({ status: 'unknown' }), 1)
    assert.equal(await SpatialBuildJobModel.countDocuments({
      status: 'published',
      project_id: { $ne: notificationConversation },
    }), 8)
    assert.equal(await SpatialArtifactNodeModel.countDocuments({ state: 'published' }), 17)

    const prefixScope = { projectId: 'project_prefix_race', userId: 'user_prefix_race' }
    const prefixRace = await Promise.allSettled(['left', 'right'].map(toolUseId => prepareSpatialBuild({
      projectId: prefixScope.projectId,
      runId: 'run_prefix',
      toolUseId,
      userId: prefixScope.userId,
      conversationId: 'conversation_prefix',
      kind: 'object',
      provider: 'fake',
      request: {
        output_path_prefix: 'output/spatial/objects/shared-prefix',
        prompt: toolUseId,
      },
    })))
    assert.equal(prefixRace.filter(value => value.status === 'fulfilled').length, 1)
    assert.equal(prefixRace.filter(value => value.status === 'rejected').length, 1)
    assert.ok(prefixRace.some(value => (
      value.status === 'rejected' && value.reason instanceof SpatialOutputPathConflictError
    )))

    const mixedScope = { projectId: 'project_mixed_capacity', userId: 'user_mixed_capacity' }
    const imageSlot = await acquireSpatialPaidSlot({
      projectId: mixedScope.projectId,
      userId: mixedScope.userId,
      holderType: 'image_generation',
      holderKey: 'image-receipt',
    })
    await bindSpatialPaidSlot(imageSlot)
    const mixedPrepare = (toolUseId: string) => prepareSpatialBuild({
      projectId: mixedScope.projectId,
      runId: 'run_mixed',
      toolUseId,
      userId: mixedScope.userId,
      conversationId: 'conversation_mixed',
      kind: 'object' as const,
      provider: 'fake',
      request: {
        output_path_prefix: `output/spatial/objects/mixed-${toolUseId}`,
        prompt: toolUseId,
      },
    })
    await mixedPrepare('one')
    await mixedPrepare('two')
    await mixedPrepare('three')
    const secondImageSlot = await acquireSpatialPaidSlot({
      projectId: mixedScope.projectId,
      userId: mixedScope.userId,
      holderType: 'image_generation',
      holderKey: 'second-image',
    })
    await bindSpatialPaidSlot(secondImageSlot)
    await assert.rejects(
      acquireSpatialPaidSlot({
        projectId: mixedScope.projectId,
        userId: mixedScope.userId,
        holderType: 'image_generation',
        holderKey: 'third-image',
      }),
      SpatialPaidCapacityError,
    )
    assert.equal(
      await SpatialPaidSlotModel.countDocuments({ project_id: mixedScope.projectId }),
      2,
      'product 3D jobs are durable but unthrottled; only explicit image test gates occupy slots',
    )

    const capacityRace = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) => prepare(`tool_capacity_${index}`)),
    )
    const admitted = capacityRace.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof prepare>>> => result.status === 'fulfilled',
    )
    const rejected = capacityRace.filter(result => result.status === 'rejected')
    assert.equal(admitted.length, 12, 'product 3D preparation must not reject parallel Agent work')
    assert.equal(rejected.length, 0)
    assert.equal(await SpatialBuildJobModel.countDocuments({
      tool_use_id: /^tool_capacity_/,
      status: 'prepared',
    }), 12)
    const replayAtCapacity = await prepare(admitted[0].value.tool_use_id)
    assert.equal(replayAtCapacity.job_id, admitted[0].value.job_id, 'idempotent replay must not create another job')

    await SpatialBuildJobModel.updateMany(
      { project_id: { $ne: scope.projectId }, status: { $in: ['prepared', 'submitted', 'running', 'materializing'] } },
      { $set: { available_at: new Date('2999-01-01T00:00:00.000Z') } },
    )
    const activeBeforeReplacement = await countActiveSpatialJobs(scope)
    const terminalClaim = await claimNextSpatialBuildJob('worker_capacity_release', 30_000)
    assert.ok(terminalClaim)
    await failSpatialJob(
      await markSpatialJobSubmitting(terminalClaim),
      'fixture terminal release',
    )
    const replacement = await prepare('tool_capacity_replacement')
    assert.equal(replacement.active_slot, undefined)
    assert.equal(
      await countActiveSpatialJobs(scope),
      activeBeforeReplacement,
      'one terminal job plus one replacement keeps the active durable queue size stable',
    )
    console.log('✓ Spatial Mongo crash/recovery verification passed')
  } finally {
    await database.dropDatabase()
    await mongoose.disconnect()
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
