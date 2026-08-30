import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const TEST_DATABASE_SUFFIX = '_test'
const mongoUri = process.env.SPATIAL_TEST_MONGODB_URI?.trim()
  || 'mongodb://127.0.0.1:27019/pegasus_spatial_operator_smoke_test'
const databaseName = mongoUri.match(/\/([^/?]+)(?:\?|$)/)?.[1]

if (!databaseName?.endsWith(TEST_DATABASE_SUFFIX)) {
  throw new Error(`Refusing to run Operator smoke tests outside an isolated *${TEST_DATABASE_SUFFIX} database.`)
}

process.env.MONGODB_URI = mongoUri
process.env.AHOLO_API_BASE_URL = 'https://api.example.test'
process.env.AHOLO_API_KEY = 'operator-test-key-never-sent'
process.env.LLM_BASE_URL = 'https://newapi.example.test/v1'
process.env.LLM_API_KEY_TOOLS = 'operator-test-key-never-sent'
process.env.PEGASUS_SPATIAL_IMAGE_MODEL = 'GPT-image-2'
process.env.MEDIA_PUBLIC_BASE_URL = 'https://media.example.test'

function glbFixture(): Buffer {
  const buffer = Buffer.alloc(12)
  buffer.write('glTF', 0, 'ascii')
  buffer.writeUInt32LE(2, 4)
  buffer.writeUInt32LE(buffer.length, 8)
  return buffer
}

async function main(): Promise<void> {
  const mongoose = (await import('mongoose')).default
  const { connectDB } = await import('../../db/mongodb')
  const { Conversation } = await import('../../db/models')
  const {
    dryRunOperatorSmoke,
    prepareOperatorSmoke,
    resumeOperatorSmoke,
    statusOperatorSmoke,
  } = await import('../operator-smoke-runner')
  const {
    ImageGenerationReceiptModel,
    reconcileImageGenerationPaidSlots,
  } = await import('../../image-generation/receipt-store')
  const { writeImageAsset } = await import('../../media/storage')
  const {
    FakeSpatialProviderAdapter,
    InMemorySpatialAssetPublisher,
    ProviderDefinitelyNotAcceptedError,
    SPATIAL_MODELS,
    SpatialBuildJobModel,
    SpatialOperatorProviderSubmissionGuardModel,
    SpatialOperatorSmokeIntentModel,
    SpatialPaidSlotModel,
    SpatialOperatorSmokeAuthorizationError,
    SpatialOperatorSmokeConflictError,
    SpatialIdempotencyConflictError,
    acquireSpatialPaidSlot,
    activateOperatorSpatialBuildPaidSlot,
    authorizeSpatialOperatorSmokeIntent,
    bindSpatialPaidSlot,
    claimNextSpatialBuildJob,
    claimSpatialBuildJobForOperator,
    countActiveSpatialJobs,
    markSpatialJobSubmitting,
    prepareSpatialBuild,
    prepareSpatialOperatorSmokeIntent,
    reconcileSpatialOperatorSmokeUnknown,
    processClaimedSpatialBuildJob,
    recoverAmbiguousSpatialSubmissions,
    syncSpatialOperatorSmokeIntent,
  } = await import('..')

  await connectDB()
  const database = mongoose.connection.db
  assert.ok(database)
  await database.dropDatabase()
  await Promise.all([
    ...SPATIAL_MODELS.map(model => model.syncIndexes()),
    ImageGenerationReceiptModel.syncIndexes(),
  ])

  try {
    // Normal product GenerateImage receipts do not allocate a global paid-slot
    // row. Their stale submitting state must still converge to unknown during
    // the periodic recovery sweep.
    const receiptRecoveryNow = new Date('2026-08-28T12:00:00.000Z')
    await ImageGenerationReceiptModel.create({
      project_id: 'slotless_image_recovery_project',
      user_id: 'slotless_image_recovery_user',
      run_id: 'slotless_image_recovery_run',
      tool_use_id: 'slotless_image_recovery_tool',
      paid_slot_holder_key: 'spimg_slotless_image_recovery',
      request_hash: 'request-hash',
      command_hash: 'command-hash',
      input_hash: 'input-hash',
      status: 'submitting',
      provider: 'newapi-images-v2',
      model: 'GPT-image-2',
      output_path: 'output/spatial/images/slotless-recovery.png',
      submission_owner: 'crashed-owner',
      submission_started_at: new Date(receiptRecoveryNow.getTime() - 10 * 60_000),
      created_at: new Date(receiptRecoveryNow.getTime() - 10 * 60_000),
      updated_at: new Date(receiptRecoveryNow.getTime() - 10 * 60_000),
    })
    const slotlessRecovery = await reconcileImageGenerationPaidSlots(
      receiptRecoveryNow,
      6 * 60_000,
    )
    assert.equal(slotlessRecovery.markedUnknown, 1)
    assert.equal(
      await ImageGenerationReceiptModel.findOne({ project_id: 'slotless_image_recovery_project' })
        .then(value => value?.status),
      'unknown',
    )

    // High-level prepare/status/resume use the real tool and Workspace bridge,
    // but the quarantined gate guarantees zero adapter submissions.
    await Conversation.create({
      conversation_id: 'runner_project',
      user_id: 'runner_user',
      title: 'Operator smoke runner fixture',
    })
    const coldPrepare = spawnSync(process.execPath, [
      'node_modules/jiti/lib/jiti-cli.mjs',
      'scripts/spatial-operator-smoke.ts',
      '--provider', 'aholo',
      '--prepare',
      '--project-id', 'runner_project',
      '--phase', 'H0',
      '--purpose', 'runner-world-once',
      '--prompt', 'minimal fixture world',
    ], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
      timeout: 20_000,
    })
    assert.equal(coldPrepare.status, 0, coldPrepare.stderr || coldPrepare.stdout)
    assert.match(coldPrepare.stdout, /"supplier_submissions": 0/)
    const preparedReport = await prepareOperatorSmoke({
      provider: 'aholo',
      projectId: 'runner_project',
      phase: 'H0',
      purpose: 'runner-world-once',
      prompt: 'minimal fixture world',
    })
    assert.equal(preparedReport.state, 'prepared')
    assert.equal(preparedReport.supplier_submissions, 0)
    assert.ok(preparedReport.smoke_id)
    const statusReport = await statusOperatorSmoke(preparedReport.smoke_id!)
    assert.equal(statusReport.state, 'prepared')
    assert.equal(statusReport.supplier_submissions, 0)
    const resumeReport = await resumeOperatorSmoke(preparedReport.smoke_id!)
    assert.equal(resumeReport.state, 'prepared')
    assert.equal(resumeReport.supplier_submissions, 0)
    assert.match(resumeReport.error || '', /禁止.*提交/)
    assert.equal(await claimNextSpatialBuildJob('runner_ordinary_worker', 30_000), null)
    const quarantinedRunnerJob = await SpatialBuildJobModel.findOne({
      job_id: preparedReport.target_id,
    }).lean()
    assert.ok(quarantinedRunnerJob)
    await assert.rejects(
      prepareSpatialBuild({
        projectId: quarantinedRunnerJob!.project_id,
        runId: quarantinedRunnerJob!.run_id,
        toolUseId: quarantinedRunnerJob!.tool_use_id,
        userId: quarantinedRunnerJob!.user_id,
        conversationId: quarantinedRunnerJob!.conversation_id,
        kind: quarantinedRunnerJob!.kind,
        provider: quarantinedRunnerJob!.provider,
        modelSnapshot: quarantinedRunnerJob!.model_snapshot,
        request: quarantinedRunnerJob!.request_snapshot,
        // Deliberately omit executionGate: a product/worker replay must not
        // adopt an operator-quarantined identity.
      }),
      SpatialIdempotencyConflictError,
    )

    // Image preparation reuses the authoritative GenerateImage receipt. A
    // status or resume operation cannot cross the prepared -> submit boundary.
    await Conversation.create({
      conversation_id: 'runner_image_project',
      user_id: 'runner_image_user',
      title: 'Operator image smoke runner fixture',
    })
    const imagePrepared = await prepareOperatorSmoke({
      provider: 'image',
      imageMode: 'text',
      projectId: 'runner_image_project',
      phase: 'H0',
      purpose: 'runner-image-text-once',
      prompt: 'minimal fixture image',
    })
    assert.equal(imagePrepared.state, 'prepared')
    assert.equal(imagePrepared.supplier_submissions, 0)
    assert.ok(imagePrepared.smoke_id)
    assert.ok(imagePrepared.target_id)
    const preparedReceipt = await ImageGenerationReceiptModel.findOne({
      project_id: 'runner_image_project',
    }).lean()
    assert.equal(preparedReceipt?.status, 'prepared')
    assert.equal(await statusOperatorSmoke(imagePrepared.smoke_id!).then(report => report.state), 'prepared')
    const imageResume = await resumeOperatorSmoke(imagePrepared.smoke_id!)
    assert.equal(imageResume.state, 'prepared')
    assert.equal(imageResume.supplier_submissions, 0)
    assert.match(imageResume.error || '', /禁止.*提交/)

    // Image text and edit are distinct, explicitly authorized slots in the
    // same phase. Repeating either mode with another purpose is still blocked.
    const samePhaseEdit = await prepareSpatialOperatorSmokeIntent({
      projectId: 'runner_image_project',
      userId: 'runner_image_user',
      conversationId: 'runner_image_project',
      provider: 'image',
      imageMode: 'edit',
      phase: 'H0',
      purpose: 'runner-image-edit-once',
      request: { prompt: 'edit fixture', output_path: 'output/spatial/images/edit.png' },
    })
    assert.equal(imagePrepared.state, 'prepared')
    assert.equal(samePhaseEdit.state, 'prepared')
    const samePhaseImageSlots = await SpatialOperatorSmokeIntentModel.find({
      project_id: 'runner_image_project',
      phase: 'H0',
      provider: 'image',
    }).sort({ budget_key: 1 }).lean()
    assert.deepEqual(
      samePhaseImageSlots.map(slot => slot.budget_key),
      ['image:edit', 'image:text'],
    )
    assert.ok(samePhaseImageSlots.every(slot => slot.provider_fence_key === 'image'))
    await assert.rejects(
      prepareSpatialOperatorSmokeIntent({
        projectId: 'runner_image_project',
        userId: 'runner_image_user',
        conversationId: 'runner_image_project',
        provider: 'image',
        imageMode: 'edit',
        phase: 'H0',
        purpose: 'runner-image-edit-second-attempt',
        request: { prompt: 'second edit', output_path: 'output/spatial/images/edit-2.png' },
      }),
      SpatialOperatorSmokeConflictError,
    )

    // Both image modes have a zero-submit dry-run. Edit additionally proves
    // the raster belongs to the selected Workspace, without creating intent.
    const textDryRun = await dryRunOperatorSmoke({
      provider: 'image',
      imageMode: 'text',
      projectId: 'dry-run-project-not-created',
      prompt: 'dry-run only',
    })
    assert.equal(textDryRun.state, 'dry_run')
    assert.equal(textDryRun.supplier_submissions, 0)
    const onePixelPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    )
    const sourceAsset = await writeImageAsset({
      ownerUserId: 'runner_image_user',
      conversationId: 'runner_image_project',
      buffer: onePixelPng,
      mimeType: 'image/png',
      source: 'user_upload',
    })
    await Conversation.updateOne(
      { conversation_id: 'runner_image_project' },
      {
        $set: {
          'output.files': {
            'output/spatial/images/operator-edit-source.png': {
              storage: 'asset',
              kind: 'raster',
              asset_id: sourceAsset.assetId,
              mime_type: sourceAsset.mimeType,
              width: sourceAsset.width,
              height: sourceAsset.height,
              size_bytes: sourceAsset.sizeBytes,
            },
          },
        },
      },
    )
    const coldEditDryRun = spawnSync(process.execPath, [
      'node_modules/jiti/lib/jiti-cli.mjs',
      'scripts/spatial-operator-smoke.ts',
      '--provider', 'image',
      '--dry-run',
      '--mode', 'edit',
      '--project-id', 'runner_image_project',
      '--input-path', 'output/spatial/images/operator-edit-source.png',
      '--prompt', 'dry-run edit only',
    ], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
      timeout: 20_000,
    })
    assert.equal(coldEditDryRun.status, 0, coldEditDryRun.stderr || coldEditDryRun.stdout)
    assert.match(coldEditDryRun.stdout, /"supplier_submissions": 0/)
    const editDryRun = await dryRunOperatorSmoke({
      provider: 'image',
      imageMode: 'edit',
      projectId: 'runner_image_project',
      inputPath: 'output/spatial/images/operator-edit-source.png',
      prompt: 'dry-run edit only',
    })
    assert.equal(editDryRun.state, 'dry_run')
    assert.equal(editDryRun.supplier_submissions, 0)
    assert.ok(editDryRun.checks?.some(check => check.name === 'workspace_input'))
    assert.equal(await SpatialOperatorSmokeIntentModel.countDocuments({
      project_id: 'runner_image_project',
      purpose: /^dry-run/,
    }), 0)

    const intentInput = {
      projectId: 'operator_project',
      userId: 'operator_user',
      conversationId: 'operator_project',
      provider: 'lux3d' as const,
      phase: 'H0',
      purpose: 'lux-one-paid-submission',
      request: { prompt: 'fixture', output_path: 'output/spatial/objects/operator-fixture' },
    }
    const intent = await prepareSpatialOperatorSmokeIntent(intentInput)
    const replay = await prepareSpatialOperatorSmokeIntent(intentInput)
    assert.equal(replay.smoke_id, intent.smoke_id)
    assert.equal(await SpatialOperatorSmokeIntentModel.countDocuments({
      project_id: intentInput.projectId,
    }), 1)
    await assert.rejects(
      prepareSpatialOperatorSmokeIntent({
        ...intentInput,
        request: { ...intentInput.request, prompt: 'different' },
      }),
      SpatialOperatorSmokeConflictError,
    )
    await assert.rejects(
      prepareSpatialOperatorSmokeIntent({
        ...intentInput,
        purpose: 'attempt-to-bypass-provider-budget',
      }),
      SpatialOperatorSmokeConflictError,
    )
    await assert.rejects(
      authorizeSpatialOperatorSmokeIntent(intent.smoke_id, 'yes'),
      SpatialOperatorSmokeAuthorizationError,
    )
    const authorized = await authorizeSpatialOperatorSmokeIntent(
      intent.smoke_id,
      'AUTHORIZE_ONE_PAID_SUBMISSION',
    )
    assert.equal(authorized.state, 'authorized')
    assert.ok(authorized.authorized_at)

    // An ambiguous supplier outcome fences the whole project/provider budget,
    // including intents in other phases and an intent authorized beforehand.
    const crossPhaseAuthorized = await prepareSpatialOperatorSmokeIntent({
      projectId: 'cross_phase_project',
      userId: 'cross_phase_user',
      conversationId: 'cross_phase_project',
      provider: 'aholo',
      phase: 'H1',
      purpose: 'authorized-before-ambiguity',
      request: { prompt: 'future', output_path: 'output/spatial/worlds/future' },
    })
    await authorizeSpatialOperatorSmokeIntent(
      crossPhaseAuthorized.smoke_id,
      'AUTHORIZE_ONE_PAID_SUBMISSION',
    )
    const crossPhaseUnknown = await prepareSpatialOperatorSmokeIntent({
      projectId: 'cross_phase_project',
      userId: 'cross_phase_user',
      conversationId: 'cross_phase_project',
      provider: 'aholo',
      phase: 'H0',
      purpose: 'ambiguous-provider-accounting',
      request: { prompt: 'unknown', output_path: 'output/spatial/worlds/unknown-source' },
    })
    await syncSpatialOperatorSmokeIntent(crossPhaseUnknown.smoke_id, {
      state: 'unknown',
      submissionCount: 1,
      lastError: 'supplier acceptance is ambiguous',
    })
    await assert.rejects(
      prepareSpatialOperatorSmokeIntent({
        projectId: 'cross_phase_project',
        userId: 'cross_phase_user',
        conversationId: 'cross_phase_project',
        provider: 'aholo',
        phase: 'H2',
        purpose: 'phase-change-must-not-bypass',
        request: { prompt: 'blocked', output_path: 'output/spatial/worlds/blocked-by-unknown' },
      }),
      (error: unknown) => error instanceof SpatialOperatorSmokeAuthorizationError
        && /未人工核销.*unknown/.test(error.message),
    )
    await assert.rejects(
      authorizeSpatialOperatorSmokeIntent(
        crossPhaseAuthorized.smoke_id,
        'AUTHORIZE_ONE_PAID_SUBMISSION',
      ),
      SpatialOperatorSmokeAuthorizationError,
      'an intent authorized before unknown must still fail at the submit authorization boundary',
    )
    await assert.rejects(
      reconcileSpatialOperatorSmokeUnknown(crossPhaseUnknown.smoke_id, {
        confirmation: 'yes',
        actor: 'operator@example.test',
        reason: 'Provider ledger checked; no replay of the unknown intent.',
      }),
      SpatialOperatorSmokeAuthorizationError,
    )
    const reconciledAt = new Date('2026-08-27T12:00:00.000Z')
    const reconciled = await reconcileSpatialOperatorSmokeUnknown(
      crossPhaseUnknown.smoke_id,
      {
        confirmation: 'RECONCILE_UNKNOWN_AFTER_PROVIDER_ACCOUNTING',
        actor: 'operator@example.test',
        reason: 'Provider ledger checked; no replay of the unknown intent.',
      },
      reconciledAt,
    )
    assert.equal(reconciled.state, 'unknown', 'reconciliation must never reopen the old intent')
    assert.equal(reconciled.unknown_reconciled_at?.toISOString(), reconciledAt.toISOString())
    assert.equal(reconciled.unknown_reconciled_by, 'operator@example.test')
    assert.match(reconciled.unknown_reconciliation_reason || '', /Provider ledger checked/)
    const replayedReconciliation = await reconcileSpatialOperatorSmokeUnknown(
      crossPhaseUnknown.smoke_id,
      {
        confirmation: 'RECONCILE_UNKNOWN_AFTER_PROVIDER_ACCOUNTING',
        actor: 'operator@example.test',
        reason: 'Provider ledger checked; no replay of the unknown intent.',
      },
      new Date('2026-08-28T12:00:00.000Z'),
    )
    assert.equal(replayedReconciliation.unknown_reconciled_at?.toISOString(), reconciledAt.toISOString())
    await assert.rejects(
      reconcileSpatialOperatorSmokeUnknown(crossPhaseUnknown.smoke_id, {
        confirmation: 'RECONCILE_UNKNOWN_AFTER_PROVIDER_ACCOUNTING',
        actor: 'different-operator@example.test',
        reason: 'overwrite attempt',
      }),
      SpatialOperatorSmokeConflictError,
    )
    const preparedAfterReconciliation = await prepareSpatialOperatorSmokeIntent({
      projectId: 'cross_phase_project',
      userId: 'cross_phase_user',
      conversationId: 'cross_phase_project',
      provider: 'aholo',
      phase: 'H2',
      purpose: 'new-audited-intent-after-reconciliation',
      request: { prompt: 'new intent', output_path: 'output/spatial/worlds/after-reconciliation' },
    })
    assert.equal(preparedAfterReconciliation.state, 'prepared')

    // Image text/edit have separate phase slots but share one provider-wide
    // uncertainty fence across both modes and every phase.
    const unknownTextImage = await prepareSpatialOperatorSmokeIntent({
      projectId: 'cross_mode_project',
      userId: 'cross_mode_user',
      conversationId: 'cross_mode_project',
      provider: 'image',
      imageMode: 'text',
      phase: 'H0',
      purpose: 'unknown-text-image',
      request: { prompt: 'unknown text image', output_path: 'output/spatial/images/unknown.png' },
    })
    await syncSpatialOperatorSmokeIntent(unknownTextImage.smoke_id, {
      state: 'unknown',
      submissionCount: 1,
    })
    await assert.rejects(
      prepareSpatialOperatorSmokeIntent({
        projectId: 'cross_mode_project',
        userId: 'cross_mode_user',
        conversationId: 'cross_mode_project',
        provider: 'image',
        imageMode: 'edit',
        phase: 'H1',
        purpose: 'edit-mode-bypass-attempt',
        request: { prompt: 'edit', output_path: 'output/spatial/images/edit.png' },
      }),
      SpatialOperatorSmokeAuthorizationError,
    )
    await reconcileSpatialOperatorSmokeUnknown(unknownTextImage.smoke_id, {
      confirmation: 'RECONCILE_UNKNOWN_AFTER_PROVIDER_ACCOUNTING',
      actor: 'operator@example.test',
      reason: 'Provider accounting reconciled before authorizing an edit.',
    })
    const editAfterReconciliation = await prepareSpatialOperatorSmokeIntent({
      projectId: 'cross_mode_project',
      userId: 'cross_mode_user',
      conversationId: 'cross_mode_project',
      provider: 'image',
      imageMode: 'edit',
      phase: 'H1',
      purpose: 'edit-after-reconciliation',
      request: { prompt: 'edit', output_path: 'output/spatial/images/edit.png' },
    })
    assert.equal(editAfterReconciliation.state, 'prepared')

    // Old intents did not persist provider_fence_key. Their provider field is
    // the compatibility fence, so an old unknown still blocks both new modes.
    const legacyUnknown = await prepareSpatialOperatorSmokeIntent({
      projectId: 'legacy_fence_project',
      userId: 'legacy_fence_user',
      conversationId: 'legacy_fence_project',
      provider: 'image',
      imageMode: 'text',
      phase: 'H0',
      purpose: 'legacy-unknown',
      request: { prompt: 'legacy', output_path: 'output/spatial/images/legacy.png' },
    })
    await syncSpatialOperatorSmokeIntent(legacyUnknown.smoke_id, {
      state: 'unknown',
      submissionCount: 1,
    })
    await SpatialOperatorSmokeIntentModel.collection.updateOne(
      { smoke_id: legacyUnknown.smoke_id },
      { $unset: { provider_fence_key: '' }, $set: { budget_key: 'image' } },
    )
    await assert.rejects(
      prepareSpatialOperatorSmokeIntent({
        projectId: 'legacy_fence_project',
        userId: 'legacy_fence_user',
        conversationId: 'legacy_fence_project',
        provider: 'image',
        imageMode: 'edit',
        phase: 'H1',
        purpose: 'legacy-fence-must-block',
        request: { prompt: 'blocked', output_path: 'output/spatial/images/blocked.png' },
      }),
      SpatialOperatorSmokeAuthorizationError,
    )

    const legacyEditSlot = await prepareSpatialOperatorSmokeIntent({
      projectId: 'legacy_slot_project',
      userId: 'legacy_slot_user',
      conversationId: 'legacy_slot_project',
      provider: 'image',
      imageMode: 'edit',
      phase: 'H0',
      purpose: 'legacy-edit-slot',
      request: { prompt: 'legacy edit', output_path: 'output/spatial/images/legacy-edit.png' },
    })
    await SpatialOperatorSmokeIntentModel.collection.updateOne(
      { smoke_id: legacyEditSlot.smoke_id },
      { $set: { budget_key: 'image' }, $unset: { provider_fence_key: '' } },
    )
    await assert.rejects(
      prepareSpatialOperatorSmokeIntent({
        projectId: 'legacy_slot_project',
        userId: 'legacy_slot_user',
        conversationId: 'legacy_slot_project',
        provider: 'image',
        imageMode: 'edit',
        phase: 'H0',
        purpose: 'legacy-edit-slot-bypass',
        request: { prompt: 'blocked edit', output_path: 'output/spatial/images/blocked-edit.png' },
      }),
      SpatialOperatorSmokeConflictError,
    )
    const textBesideLegacyEdit = await prepareSpatialOperatorSmokeIntent({
      projectId: 'legacy_slot_project',
      userId: 'legacy_slot_user',
      conversationId: 'legacy_slot_project',
      provider: 'image',
      imageMode: 'text',
      phase: 'H0',
      purpose: 'text-beside-legacy-edit',
      request: { prompt: 'allowed text', output_path: 'output/spatial/images/allowed-text.png' },
    })
    assert.equal(textBesideLegacyEdit.budget_key, 'image:text')

    // A unique provider guard closes both the live authorization race and the
    // crash-recovery window. The backing Job becomes unknown before another
    // phase can cross the paid boundary, even while its intent is stale.
    const spatialCrashA = await prepareSpatialOperatorSmokeIntent({
      projectId: 'spatial_crash_fence_project',
      userId: 'spatial_crash_fence_user',
      conversationId: 'spatial_crash_fence_project',
      provider: 'aholo',
      phase: 'H0',
      purpose: 'crash-before-external-id',
      request: { prompt: 'first', output_path: 'output/spatial/worlds/crash-first' },
    })
    const spatialCrashB = await prepareSpatialOperatorSmokeIntent({
      projectId: 'spatial_crash_fence_project',
      userId: 'spatial_crash_fence_user',
      conversationId: 'spatial_crash_fence_project',
      provider: 'aholo',
      phase: 'H1',
      purpose: 'must-not-cross-active-or-unknown',
      request: { prompt: 'second', output_path: 'output/spatial/worlds/crash-second' },
    })
    await authorizeSpatialOperatorSmokeIntent(
      spatialCrashA.smoke_id,
      'AUTHORIZE_ONE_PAID_SUBMISSION',
    )
    await assert.rejects(
      authorizeSpatialOperatorSmokeIntent(
        spatialCrashB.smoke_id,
        'AUTHORIZE_ONE_PAID_SUBMISSION',
      ),
      SpatialOperatorSmokeAuthorizationError,
      'an active provider guard must atomically block another phase',
    )
    const crashJob = await prepareSpatialBuild({
      projectId: spatialCrashA.project_id,
      runId: spatialCrashA.run_id,
      toolUseId: spatialCrashA.tool_use_id,
      userId: spatialCrashA.user_id,
      conversationId: spatialCrashA.conversation_id,
      kind: 'world',
      provider: 'aholo',
      executionGate: 'operator',
      request: {
        output_path_prefix: 'output/spatial/worlds/crash-first',
        prompt: 'first',
      },
    })
    await syncSpatialOperatorSmokeIntent(spatialCrashA.smoke_id, {
      targetId: crashJob.job_id,
      state: 'authorized',
      submissionCount: 0,
    })
    await activateOperatorSpatialBuildPaidSlot(crashJob.job_id)
    const crashClaim = await claimSpatialBuildJobForOperator({
      jobId: crashJob.job_id,
      ownerId: 'operator_crash_before_external_id',
      leaseMs: 30_000,
    })
    assert.ok(crashClaim)
    const crashSubmitting = await markSpatialJobSubmitting(crashClaim!)
    await SpatialBuildJobModel.updateOne(
      { job_id: crashSubmitting.job.job_id },
      { $set: { 'lease.expires_at': new Date(0) } },
    )
    assert.equal(
      await SpatialOperatorSmokeIntentModel.findOne({ smoke_id: spatialCrashA.smoke_id })
        .then(value => value?.state),
      'authorized',
      'the fault fixture must begin with a stale intent',
    )
    await assert.rejects(
      authorizeSpatialOperatorSmokeIntent(
        spatialCrashB.smoke_id,
        'AUTHORIZE_ONE_PAID_SUBMISSION',
      ),
      SpatialOperatorSmokeAuthorizationError,
    )
    assert.equal(
      await SpatialBuildJobModel.findOne({ job_id: crashJob.job_id }).then(value => value?.status),
      'unknown',
    )
    assert.equal(
      await SpatialOperatorSmokeIntentModel.findOne({ smoke_id: spatialCrashA.smoke_id })
        .then(value => value?.state),
      'unknown',
    )
    assert.equal(
      await SpatialOperatorProviderSubmissionGuardModel.findOne({
        project_id: spatialCrashA.project_id,
        provider_fence_key: 'aholo',
      }).then(value => value?.smoke_id),
      spatialCrashA.smoke_id,
      'unknown retains the provider guard until explicit accounting reconciliation',
    )
    await reconcileSpatialOperatorSmokeUnknown(spatialCrashA.smoke_id, {
      confirmation: 'RECONCILE_UNKNOWN_AFTER_PROVIDER_ACCOUNTING',
      actor: 'operator@example.test',
      reason: 'Provider accounting completed for the spatial crash fixture.',
    })
    assert.equal(await SpatialOperatorProviderSubmissionGuardModel.countDocuments({
      project_id: spatialCrashA.project_id,
      provider_fence_key: 'aholo',
    }), 0)
    const spatialCrashBAuthorized = await authorizeSpatialOperatorSmokeIntent(
      spatialCrashB.smoke_id,
      'AUTHORIZE_ONE_PAID_SUBMISSION',
    )
    assert.equal(spatialCrashBAuthorized.state, 'authorized')
    await syncSpatialOperatorSmokeIntent(spatialCrashB.smoke_id, {
      state: 'failed',
      submissionCount: 0,
      lastError: 'fixture ended before provider I/O',
    })
    assert.equal(await SpatialOperatorProviderSubmissionGuardModel.countDocuments({
      project_id: spatialCrashA.project_id,
      provider_fence_key: 'aholo',
    }), 0, 'failed releases the provider guard')

    // Image text/edit share the same atomic provider guard. A receipt left in
    // submitting is sealed unknown by the normal lease recovery before an edit
    // in a later phase can be authorized; no image adapter is invoked here.
    await Conversation.create({
      conversation_id: 'image_crash_fence_project',
      user_id: 'image_crash_fence_user',
      title: 'Image crash provider fence fixture',
    })
    const imageCrashA = await prepareOperatorSmoke({
      provider: 'image',
      imageMode: 'text',
      projectId: 'image_crash_fence_project',
      phase: 'H0',
      purpose: 'text-crash-before-result',
      prompt: 'first image',
    })
    assert.ok(imageCrashA.smoke_id)
    const imageCrashB = await prepareSpatialOperatorSmokeIntent({
      projectId: 'image_crash_fence_project',
      userId: 'image_crash_fence_user',
      conversationId: 'image_crash_fence_project',
      provider: 'image',
      imageMode: 'edit',
      phase: 'H1',
      purpose: 'edit-must-not-cross-active-or-unknown',
      request: { prompt: 'edit', output_path: 'output/spatial/images/edit-after-crash.png' },
    })
    await authorizeSpatialOperatorSmokeIntent(
      imageCrashA.smoke_id!,
      'AUTHORIZE_ONE_PAID_SUBMISSION',
    )
    await assert.rejects(
      authorizeSpatialOperatorSmokeIntent(
        imageCrashB.smoke_id,
        'AUTHORIZE_ONE_PAID_SUBMISSION',
      ),
      SpatialOperatorSmokeAuthorizationError,
    )
    const imageCrashReceipt = await ImageGenerationReceiptModel.findOne({
      project_id: 'image_crash_fence_project',
    }).lean()
    assert.ok(imageCrashReceipt)
    const imageSlot = await acquireSpatialPaidSlot({
      projectId: 'image_crash_fence_project',
      userId: 'image_crash_fence_user',
      holderType: 'image_generation',
      holderKey: imageCrashReceipt!.paid_slot_holder_key,
    })
    await bindSpatialPaidSlot(imageSlot)
    const staleImageSubmission = new Date(Date.now() - 10 * 60_000)
    await ImageGenerationReceiptModel.updateOne(
      { _id: imageCrashReceipt!._id },
      {
        $set: {
          status: 'submitting',
          submission_owner: 'crashed-image-owner',
          submission_started_at: staleImageSubmission,
          updated_at: staleImageSubmission,
        },
      },
    )
    assert.equal(
      await SpatialOperatorSmokeIntentModel.findOne({ smoke_id: imageCrashA.smoke_id })
        .then(value => value?.state),
      'authorized',
    )
    await assert.rejects(
      authorizeSpatialOperatorSmokeIntent(
        imageCrashB.smoke_id,
        'AUTHORIZE_ONE_PAID_SUBMISSION',
      ),
      SpatialOperatorSmokeAuthorizationError,
    )
    assert.equal(
      await ImageGenerationReceiptModel.findOne({ _id: imageCrashReceipt!._id })
        .then(value => value?.status),
      'unknown',
    )
    assert.equal(
      await SpatialOperatorSmokeIntentModel.findOne({ smoke_id: imageCrashA.smoke_id })
        .then(value => value?.state),
      'unknown',
    )
    assert.equal(
      await SpatialOperatorProviderSubmissionGuardModel.findOne({
        project_id: 'image_crash_fence_project',
        provider_fence_key: 'image',
      }).then(value => value?.smoke_id),
      imageCrashA.smoke_id,
    )

    // A stale status reader must not roll any terminal state back to
    // submitting. The CAS also covers the race where both syncs read the same
    // pre-terminal state.
    for (const terminalState of ['unknown', 'published', 'failed'] as const) {
      const projectId = `monotonic_${terminalState}_project`
      const monotonicIntent = await prepareSpatialOperatorSmokeIntent({
        projectId,
        userId: `monotonic_${terminalState}_user`,
        conversationId: projectId,
        provider: 'aholo',
        phase: 'H0',
        purpose: `monotonic-${terminalState}`,
        request: { prompt: terminalState, output_path: `output/spatial/worlds/${terminalState}` },
      })
      await syncSpatialOperatorSmokeIntent(monotonicIntent.smoke_id, {
        state: 'submitting',
        submissionCount: 1,
      })
      const terminal = await syncSpatialOperatorSmokeIntent(monotonicIntent.smoke_id, {
        state: terminalState,
        submissionCount: 1,
        lastError: terminalState === 'published' ? null : `${terminalState} fixture`,
      })
      assert.equal(terminal.state, terminalState)
      const afterLateSync = await syncSpatialOperatorSmokeIntent(monotonicIntent.smoke_id, {
        state: 'submitting',
        submissionCount: 1,
        lastError: 'stale status response',
      })
      assert.equal(afterLateSync.state, terminalState)
      const persisted = await SpatialOperatorSmokeIntentModel.findOne({
        smoke_id: monotonicIntent.smoke_id,
      }).lean()
      assert.equal(persisted?.state, terminalState)
      assert.notEqual(persisted?.last_error, 'stale status response')
    }

    const quarantined = await prepareSpatialBuild({
      projectId: intent.project_id,
      runId: intent.run_id,
      toolUseId: intent.tool_use_id,
      userId: intent.user_id,
      conversationId: intent.conversation_id,
      kind: 'object',
      provider: 'fake',
      modelSnapshot: 'G1',
      executionGate: 'operator',
      request: {
        output_path_prefix: 'output/spatial/objects/operator-fixture',
        prompt: 'fixture',
      },
    })
    await syncSpatialOperatorSmokeIntent(intent.smoke_id, {
      targetId: quarantined.job_id,
      state: 'authorized',
      submissionCount: 0,
    })
    assert.equal(quarantined.execution_gate, 'operator')
    assert.equal(quarantined.active_slot, undefined)
    assert.equal(await countActiveSpatialJobs({
      projectId: intent.project_id,
      userId: intent.user_id,
    }), 0)
    assert.equal(await claimNextSpatialBuildJob('ordinary_worker', 30_000), null)

    const activated = await activateOperatorSpatialBuildPaidSlot(quarantined.job_id)
    assert.ok(activated.active_slot === 0 || activated.active_slot === 1)
    assert.equal(await SpatialPaidSlotModel.countDocuments({
      holder_key: quarantined.job_id,
    }), 1)
    const claim = await claimSpatialBuildJobForOperator({
      jobId: quarantined.job_id,
      ownerId: 'operator_submit',
      leaseMs: 30_000,
    })
    assert.ok(claim)
    const noRetry = new FakeSpatialProviderAdapter({
      submitErrors: [new ProviderDefinitelyNotAcceptedError('fixture was definitely rejected')],
    })
    await processClaimedSpatialBuildJob(claim!, {
      adapters: new Map([['fake', noRetry]]),
      publisher: new InMemorySpatialAssetPublisher(),
    }, { maxSubmissionAttempts: 1 })
    assert.equal(noRetry.submissions.length, 1, 'Operator smoke must not use the product auto-retry')
    const failed = await SpatialBuildJobModel.findOne({ job_id: quarantined.job_id }).lean()
    assert.equal(failed?.status, 'failed')
    assert.equal(failed?.submission_attempts, 1)
    assert.equal(await SpatialPaidSlotModel.countDocuments({ holder_key: quarantined.job_id }), 0)

    // First successful output discovers only exact hostnames, persists a
    // recoverable configuration_blocked state, and never stores the signed URL.
    const blockedJob = await prepareSpatialBuild({
      projectId: 'blocked_project',
      runId: 'blocked_run',
      toolUseId: 'blocked_tool',
      userId: 'blocked_user',
      conversationId: 'blocked_project',
      kind: 'object',
      provider: 'fake',
      modelSnapshot: 'G1',
      executionGate: 'operator',
      request: {
        output_path_prefix: 'output/spatial/objects/blocked',
        prompt: 'fixture',
      },
    })
    await activateOperatorSpatialBuildPaidSlot(blockedJob.job_id)
    const blockedClaim = await claimSpatialBuildJobForOperator({
      jobId: blockedJob.job_id,
      ownerId: 'operator_blocked',
      leaseMs: 30_000,
    })
    assert.ok(blockedClaim)
    const provider = new FakeSpatialProviderAdapter({
      externalJobId: 'external_blocked',
      pollResults: [{
        state: 'succeeded',
        artifacts: [{
          assetKey: 'model',
          kind: 'model',
          fileName: 'model.glb',
          remoteUrl: 'https://Assets.Example.Test/model.glb?signature=must-not-persist',
          claimedMimeType: 'model/gltf-binary',
        }],
      }],
    })
    const publisher = new InMemorySpatialAssetPublisher()
    await processClaimedSpatialBuildJob(blockedClaim!, {
      adapters: new Map([['fake', provider]]),
      publisher,
      artifactMirroringConfigured: () => false,
    }, { maxSubmissionAttempts: 1 })
    const blocked = await SpatialBuildJobModel.findOne({ job_id: blockedJob.job_id }).lean()
    assert.equal(blocked?.status, 'materializing')
    assert.equal(blocked?.provider_status, 'configuration_blocked')
    assert.deepEqual(blocked?.configuration_blocked_hosts, ['assets.example.test'])
    assert.match(blocked?.last_error || '', /assets\.example\.test/)
    assert.doesNotMatch(JSON.stringify(blocked), /signature=must-not-persist/)
    assert.equal(provider.submissions.length, 1)
    const blockedIntent = await prepareSpatialOperatorSmokeIntent({
      projectId: 'blocked_project',
      userId: 'blocked_user',
      conversationId: 'blocked_project',
      provider: 'lux3d',
      phase: 'H0',
      purpose: 'blocked-host-discovery',
      request: { prompt: 'fixture', output_path: 'output/spatial/objects/blocked' },
    })
    const syncedBlockedIntent = await syncSpatialOperatorSmokeIntent(blockedIntent.smoke_id, {
      targetId: blockedJob.job_id,
      state: 'configuration_blocked',
      submissionCount: 1,
      artifactHostnames: blocked?.configuration_blocked_hosts ?? [],
      lastError: blocked?.last_error,
    })
    assert.deepEqual(syncedBlockedIntent.artifact_hostnames, ['assets.example.test'])
    assert.doesNotMatch(JSON.stringify(syncedBlockedIntent), /signature=must-not-persist/)

    // Configuration recovery reclaims the same known external job and only
    // polls/materializes; a second provider submit is impossible.
    await SpatialBuildJobModel.updateOne(
      { job_id: blockedJob.job_id },
      { $set: { available_at: new Date(0) } },
    )
    const takeover = await claimNextSpatialBuildJob('ordinary_recovery', 30_000)
    assert.equal(takeover?.job.job_id, blockedJob.job_id)
    await processClaimedSpatialBuildJob(takeover!, {
      adapters: new Map([['fake', provider]]),
      publisher,
      artifactMirroringConfigured: () => true,
      allowedArtifactHosts: () => ['assets.example.test'],
      resolveArtifactHostname: async () => ['93.184.216.34'],
      fetchImpl: async () => new Response(new Uint8Array(glbFixture()), {
        headers: { 'Content-Type': 'model/gltf-binary' },
      }),
    })
    const published = await SpatialBuildJobModel.findOne({ job_id: blockedJob.job_id }).lean()
    assert.equal(published?.status, 'published')
    assert.equal(provider.submissions.length, 1)

    // A crash after the submitting marker but before durable external id is
    // terminal unknown and cannot be claimed for either submit or resume.
    const ambiguous = await prepareSpatialBuild({
      projectId: 'unknown_project',
      runId: 'unknown_run',
      toolUseId: 'unknown_tool',
      userId: 'unknown_user',
      conversationId: 'unknown_project',
      kind: 'world',
      provider: 'fake',
      executionGate: 'operator',
      request: {
        output_path_prefix: 'output/spatial/worlds/unknown',
        prompt: 'fixture',
      },
    })
    await activateOperatorSpatialBuildPaidSlot(ambiguous.job_id)
    const ambiguousClaim = await claimSpatialBuildJobForOperator({
      jobId: ambiguous.job_id,
      ownerId: 'operator_unknown',
      leaseMs: 30_000,
    })
    const submitting = await markSpatialJobSubmitting(ambiguousClaim!)
    await SpatialBuildJobModel.updateOne(
      { job_id: submitting.job.job_id },
      { $set: { 'lease.expires_at': new Date(0) } },
    )
    const recovered = await recoverAmbiguousSpatialSubmissions()
    assert.equal(recovered.unknown, 1)
    const unknown = await SpatialBuildJobModel.findOne({ job_id: ambiguous.job_id }).lean()
    assert.equal(unknown?.status, 'unknown')
    assert.equal(await claimSpatialBuildJobForOperator({
      jobId: ambiguous.job_id,
      ownerId: 'operator_must_not_retry',
    }), null)
  } finally {
    await mongoose.connection.db?.dropDatabase()
    await mongoose.disconnect()
  }

  console.log('spatial Operator smoke Mongo verification passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
