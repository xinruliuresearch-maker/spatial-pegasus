import assert from 'node:assert/strict'

const mongoUri = process.env.SPATIAL_SCENE_TEST_MONGODB_URI?.trim()
  || 'mongodb://127.0.0.1:27019/pegasus_spatial_scene_test'
const databaseName = mongoUri.match(/\/([^/?]+)(?:\?|$)/)?.[1]
if (!databaseName?.endsWith('_test')) throw new Error('Refusing to run Scene tests outside an isolated *_test database.')
process.env.MONGODB_URI = mongoUri

async function main(): Promise<void> {
  const mongoose = (await import('mongoose')).default
  const { connectDB } = await import('../../db/mongodb')
  const spatial = await import('..')
  await connectDB()
  const database = mongoose.connection.db
  assert.ok(database)
  await database.dropDatabase()
  await Promise.all(spatial.SPATIAL_MODELS.map(model => model.syncIndexes()))

  const base = { projectId: 'scene_project', userId: 'scene_user', conversationId: 'scene_project', actorId: 'root' }
  const identity = (toolUseId: string) => ({ ...base, runId: 'scene_run', toolUseId })
  const created = await spatial.createSpatialScene({ identity: identity('create'), title: '可编辑客厅', commandHash: 'create-hash' })
  assert.equal(created.status, 'applied')
  if (created.status !== 'applied') throw new Error('fixture scene was not created')
  assert.equal(created.scene.current_version, 1)
  const replay = await spatial.createSpatialScene({ identity: identity('create'), title: '可编辑客厅', commandHash: 'create-hash' })
  assert.equal(replay.status, 'applied')
  if (replay.status === 'applied') assert.equal(replay.revision.revision_id, created.revision.revision_id)

  const sceneId = created.scene.scene_id
  const race = await Promise.all([
    spatial.mutateSpatialScene({ identity: identity('race_a'), sceneId, commandHash: 'race-a', summary: 'A', mutate: snapshot => ({ ...snapshot, instances: [] }) }),
    spatial.mutateSpatialScene({ identity: identity('race_b'), sceneId, commandHash: 'race-b', summary: 'B', mutate: snapshot => ({ ...snapshot, instances: [] }) }),
  ])
  assert.equal(race.filter(item => item.status === 'applied').length, 1)
  assert.equal(race.filter(item => item.status === 'scene_changed').length, 1)
  const afterRace = await spatial.requireSpatialScene(sceneId, base)
  assert.equal(afterRace.current_version, 2)

  await spatial.SpatialObservationModel.create({
    observation_id: 'observation_v2', scene_id: sceneId, project_id: base.projectId, user_id: base.userId,
    revision_id: afterRace.current_revision_id, source: 'user',
    viewpoint: { position: [3, 3, 2], target: [0, 0, 0], up: [0, 0, 1], fov_deg: 56 },
    screenshot_asset_id: 'asset_observation', screenshot_workspace_path: 'output/spatial/reviews/o/view.png',
    selected_instance_id: null, visible_instance_ids: [], comment: '从这里调整',
  })
  const fromObservation = await spatial.mutateSpatialScene({
    identity: identity('observation_mutation'), sceneId, observationId: 'observation_v2', commandHash: 'observation-mutation', summary: '应用观察',
    mutate: snapshot => snapshot,
  })
  assert.equal(fromObservation.status, 'applied')
  await assert.rejects(spatial.mutateSpatialScene({
    identity: identity('stale_observation'), sceneId, observationId: 'observation_v2', commandHash: 'stale-observation', summary: '不应应用',
    mutate: snapshot => snapshot,
  }), /旧 Scene revision/)

  const restored = await spatial.restoreSpatialSceneRevision({ identity: identity('restore'), sceneId, version: 1, commandHash: 'restore' })
  assert.equal(restored.status, 'applied')
  if (restored.status === 'applied') {
    assert.equal(restored.scene.current_version, 4)
    assert.equal(restored.revision.parent_revision_id, fromObservation.status === 'applied' ? fromObservation.revision.revision_id : null)
  }
  assert.equal(await spatial.SpatialSceneRevisionModel.countDocuments({ scene_id: sceneId, committed: true }), 4)

  const recoveryIdentity = identity('create_recovery')
  const recoveryCreated = await spatial.createSpatialScene({ identity: recoveryIdentity, title: '崩溃恢复 Scene', commandHash: 'create-recovery' })
  assert.equal(recoveryCreated.status, 'applied')
  if (recoveryCreated.status !== 'applied') throw new Error('recovery fixture was not created')
  await spatial.SpatialSceneModel.deleteOne({ scene_id: recoveryCreated.scene.scene_id })
  await spatial.SpatialSceneRevisionModel.updateOne({ revision_id: recoveryCreated.revision.revision_id }, { $set: { committed: false } })
  const repairedCreate = await spatial.createSpatialScene({ identity: recoveryIdentity, title: '崩溃恢复 Scene', commandHash: 'create-recovery' })
  assert.equal(repairedCreate.status, 'applied')
  if (repairedCreate.status === 'applied') assert.equal(repairedCreate.replayed, true)
  await assert.rejects(
    spatial.createSpatialScene({ identity: recoveryIdentity, title: '参数已变化', commandHash: 'different-command' }),
    /参数发生变化/,
  )

  const revisionMissingIdentity = identity('create_revision_missing')
  const revisionMissing = await spatial.createSpatialScene({ identity: revisionMissingIdentity, title: '指针先落库', commandHash: 'revision-missing' })
  assert.equal(revisionMissing.status, 'applied')
  if (revisionMissing.status !== 'applied') throw new Error('revision-missing fixture was not created')
  await spatial.SpatialSceneRevisionModel.deleteOne({ revision_id: revisionMissing.revision.revision_id })
  const repairedMissingRevision = await spatial.createSpatialScene({ identity: revisionMissingIdentity, title: '指针先落库', commandHash: 'revision-missing' })
  assert.equal(repairedMissingRevision.status, 'applied')

  const repairMutationInput = {
    identity: identity('mutation_recovery'), sceneId: recoveryCreated.scene.scene_id,
    commandHash: 'mutation-recovery', summary: '模拟 pointer CAS 后崩溃',
    mutate: (snapshot: { world: null; instances: [] }) => snapshot,
  }
  const mutationBeforeCrash = await spatial.mutateSpatialScene(repairMutationInput)
  assert.equal(mutationBeforeCrash.status, 'applied')
  if (mutationBeforeCrash.status !== 'applied') throw new Error('mutation recovery fixture failed')
  await spatial.SpatialSceneRevisionModel.updateOne({ revision_id: mutationBeforeCrash.revision.revision_id }, { $set: { committed: false } })
  const repairedMutation = await spatial.mutateSpatialScene(repairMutationInput)
  assert.equal(repairedMutation.status, 'applied')
  if (repairedMutation.status === 'applied') assert.equal(repairedMutation.replayed, true)

  const session = await spatial.registerSpatialRenderSession({ scope: base, sceneId, clientId: 'browser_1', ttlMs: 20_000 })
  await spatial.setSpatialSceneViewpoint({ scope: base, sceneId, viewpoint: { position: [4, 4, 3], target: [0, 0, 0], up: [0, 0, 1], fov_deg: 52 } })
  const command = await spatial.enqueueSpatialRenderCommand({ identity: identity('capture'), sceneId })
  assert.ok(command)
  const claimed = await spatial.claimSpatialRenderCommand({ scope: base, sceneId, sessionId: session.session_id, leaseToken: session.lease_token })
  assert.equal(claimed?.command_id, command?.command_id)
  const completed = await spatial.completeSpatialRenderCommand({
    commandId: claimed!.command_id, sessionId: session.session_id, leaseToken: claimed!.lease!.token,
    screenshotAssetId: 'asset_capture', screenshotWorkspacePath: 'output/spatial/reviews/capture/view.png',
  })
  assert.equal(completed?.status, 'completed')
  const secondClaim = await spatial.claimSpatialRenderCommand({ scope: base, sceneId, sessionId: session.session_id, leaseToken: session.lease_token })
  assert.equal(secondClaim, null, 'completed command must never be rendered twice')

  const terrainSceneCreated = await spatial.createSpatialScene({
    identity: identity('create_terrain_scene'), title: '全景与 Lux 地形 Scene', commandHash: 'create-terrain-scene',
  })
  assert.equal(terrainSceneCreated.status, 'applied')
  if (terrainSceneCreated.status !== 'applied') throw new Error('terrain scene fixture failed')
  assert.equal(terrainSceneCreated.revision.environment ?? null, null)
  const terrainSceneId = terrainSceneCreated.scene.scene_id
  const terrainMutation = await spatial.mutateSpatialScene({
    identity: identity('set_environment_and_terrain'), sceneId: terrainSceneId,
    commandHash: 'set-environment-and-terrain', summary: '设置全景并加入地形',
    mutate: snapshot => ({
      ...snapshot,
      environment: {
        kind: 'equirectangular_panorama', workspace_path: 'output/spatial/images/sky.exr',
        asset_id: 'asset_sky', mime_type: 'image/png', width: 2048, height: 1024,
        size_bytes: 2048, sha256: 'a'.repeat(64), yaw_deg: 12, exposure: 1.1,
      },
      instances: [{
        instance_id: 'terrain_ground', label: '山谷地形', role: 'terrain', source_job_id: 'job_terrain',
        glb_artifact: {
          artifact_id: 'artifact_ground', job_id: 'job_terrain', kind: 'glb',
          workspace_path: 'output/spatial/objects/ground/model.glb', mime_type: 'model/gltf-binary',
          size_bytes: 1024, sha256: 'b'.repeat(64), metadata: {},
        },
        normalization: { source_up_axis: 'Y', scene_up_axis: 'Z', pivot: 'bottom_center' },
        transform: { position: [0, 0, 0], rotation_quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
      }],
    }),
  })
  assert.equal(terrainMutation.status, 'applied')
  if (terrainMutation.status !== 'applied') throw new Error('terrain mutation failed')
  assert.equal(terrainMutation.revision.environment?.asset_id, 'asset_sky')
  assert.equal(terrainMutation.revision.instances[0].role, 'terrain')

  const terrainSession = await spatial.registerSpatialRenderSession({ scope: base, sceneId: terrainSceneId, clientId: 'browser_terrain', ttlMs: 20_000 })
  const surfaceCommand = await spatial.enqueueSpatialSurfaceQueryCommand({
    identity: identity('surface_query'), sceneId: terrainSceneId,
    terrainInstanceId: 'terrain_ground', horizontal: [3, -2], castHeight: 500,
  })
  assert.equal(surfaceCommand?.kind, 'surface_query')
  assert.deepEqual(surfaceCommand?.surface_query, {
    terrain_instance_id: 'terrain_ground', horizontal: [3, -2], cast_height: 500, up_axis: 'Z',
  })
  const claimedSurface = await spatial.claimSpatialRenderCommand({
    scope: base, sceneId: terrainSceneId, sessionId: terrainSession.session_id, leaseToken: terrainSession.lease_token,
  })
  assert.equal(claimedSurface?.command_id, surfaceCommand?.command_id)
  const completedSurface = await spatial.completeSpatialSurfaceQueryCommand({
    commandId: claimedSurface!.command_id, sessionId: terrainSession.session_id,
    leaseToken: claimedSurface!.lease!.token, terrainInstanceId: 'terrain_ground', point: [3, -2, 1.75],
  })
  assert.equal(completedSurface?.status, 'completed')
  assert.deepEqual(completedSurface?.surface_result?.point, [3, -2, 1.75])
  const repeatedSurfaceClaim = await spatial.claimSpatialRenderCommand({
    scope: base, sceneId: terrainSceneId, sessionId: terrainSession.session_id, leaseToken: terrainSession.lease_token,
  })
  assert.equal(repeatedSurfaceClaim, null, 'completed surface query must never be executed twice')

  console.log('spatial scene Mongo verification passed')
  await database.dropDatabase()
  await mongoose.disconnect()
}

void main().catch(error => { console.error(error); process.exit(1) })
