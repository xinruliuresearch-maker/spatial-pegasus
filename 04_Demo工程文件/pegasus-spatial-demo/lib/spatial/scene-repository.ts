import { createHash, randomUUID } from 'node:crypto'
import { connectDB } from '../db/mongodb'
import {
  SpatialArtifactNodeModel,
  SpatialBuildJobModel,
  SpatialObservationModel,
  SpatialRenderCommandModel,
  SpatialRenderSessionModel,
  SpatialSceneModel,
  SpatialSceneRevisionModel,
} from './models'
import { normalizeViewpoint } from './scene-math'
import type {
  SceneCommandScope,
  SceneMutationIdentity,
  SceneMutationResult,
  SceneObjectInstance,
  ScenePanoramaEnvironment,
  SceneSourceArtifact,
  SceneViewpoint,
  SceneWorldSource,
  SpatialObservationRecord,
  SpatialRenderCommandRecord,
  SpatialRenderSessionRecord,
  SpatialSceneRecord,
  SpatialSceneRevisionRecord,
  Vec3,
} from './scene-types'
import type { SpatialArtifactNodeRecord, SpatialBuildJobRecord } from './types'

function hashId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`
}

function mutationKey(identity: SceneMutationIdentity): string {
  return `${identity.runId.trim()}:${identity.toolUseId.trim()}`
}

function requireText(label: string, value: string, max = 400): string {
  const normalized = value.trim()
  if (!normalized) throw new TypeError(`${label} 不能为空。`)
  if (normalized.length > max) throw new TypeError(`${label} 不能超过 ${max} 个字符。`)
  return normalized
}

function clone<T>(value: T): T { return structuredClone(value) }

function duplicateKey(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 11000)
}

function scopedSceneFilter(sceneId: string, scope: SceneCommandScope): Record<string, unknown> {
  return { scene_id: sceneId.trim(), project_id: scope.projectId.trim(), user_id: scope.userId.trim() }
}

export class SpatialSceneCommandRejectedError extends Error {
  readonly code = 'SPATIAL_SCENE_COMMAND_REJECTED'
  constructor(message = 'Scene 不存在或不属于当前项目。') { super(message); this.name = 'SpatialSceneCommandRejectedError' }
}

export class SpatialSceneAssetRejectedError extends Error {
  readonly code = 'SPATIAL_SCENE_ASSET_REJECTED'
  constructor(message: string) { super(message); this.name = 'SpatialSceneAssetRejectedError' }
}

export async function getSpatialScene(sceneId: string, scope: SceneCommandScope): Promise<SpatialSceneRecord | null> {
  await connectDB()
  return SpatialSceneModel.findOne(scopedSceneFilter(sceneId, scope)).lean<SpatialSceneRecord>()
}

export async function requireSpatialScene(sceneId: string, scope: SceneCommandScope): Promise<SpatialSceneRecord> {
  const scene = await getSpatialScene(sceneId, scope)
  if (!scene) throw new SpatialSceneCommandRejectedError()
  return scene
}

export async function getSpatialSceneRevision(
  sceneId: string,
  revisionId: string,
  scope: SceneCommandScope,
): Promise<SpatialSceneRevisionRecord | null> {
  await connectDB()
  return SpatialSceneRevisionModel.findOne({
    scene_id: sceneId.trim(),
    revision_id: revisionId.trim(),
    project_id: scope.projectId.trim(),
    user_id: scope.userId.trim(),
    committed: true,
  }).lean<SpatialSceneRevisionRecord>()
}

export async function getCurrentSpatialSceneRevision(
  scene: SpatialSceneRecord,
): Promise<SpatialSceneRevisionRecord> {
  let revision = await SpatialSceneRevisionModel.findOne({
    revision_id: scene.current_revision_id,
    scene_id: scene.scene_id,
  }).lean<SpatialSceneRevisionRecord>()
  if (!revision) throw new SpatialSceneCommandRejectedError('Scene 当前 revision 缺失，拒绝继续修改。')
  if (!revision.committed) {
    revision = await SpatialSceneRevisionModel.findOneAndUpdate({
      revision_id: revision.revision_id, scene_id: scene.scene_id, committed: false,
    }, { $set: { committed: true } }, { returnDocument: 'after' }).lean<SpatialSceneRevisionRecord>()
    if (!revision) {
      revision = await SpatialSceneRevisionModel.findOne({
        revision_id: scene.current_revision_id, scene_id: scene.scene_id, committed: true,
      }).lean<SpatialSceneRevisionRecord>()
    }
  }
  if (!revision) throw new SpatialSceneCommandRejectedError('Scene 当前 revision 恢复失败。')
  return revision
}

export async function listSpatialSceneHistory(
  sceneId: string,
  scope: SceneCommandScope,
  limit = 100,
): Promise<SpatialSceneRevisionRecord[]> {
  await requireSpatialScene(sceneId, scope)
  return SpatialSceneRevisionModel.find({
    scene_id: sceneId.trim(), project_id: scope.projectId.trim(), user_id: scope.userId.trim(), committed: true,
  }).sort({ version: -1, created_at: -1 }).limit(Math.max(1, Math.min(limit, 200))).lean<SpatialSceneRevisionRecord[]>()
}

function sourceArtifact(record: SpatialArtifactNodeRecord): SceneSourceArtifact {
  return {
    artifact_id: record.artifact_id,
    job_id: record.job_id,
    kind: record.kind,
    workspace_path: record.workspace_path,
    mime_type: record.mime_type,
    size_bytes: record.size_bytes,
    sha256: record.sha256,
    metadata: clone(record.metadata ?? {}),
  }
}

async function publishedJobWithArtifacts(
  jobId: string,
  scope: SceneCommandScope,
  kind: 'world' | 'object',
): Promise<{ job: SpatialBuildJobRecord; artifacts: SceneSourceArtifact[] }> {
  await connectDB()
  const job = await SpatialBuildJobModel.findOne({
    job_id: jobId.trim(), project_id: scope.projectId.trim(), user_id: scope.userId.trim(), kind, status: 'published',
  }).lean<SpatialBuildJobRecord>()
  if (!job) throw new SpatialSceneAssetRejectedError(`${kind === 'world' ? 'World' : 'Object'} Job 未发布或不属于当前项目。`)
  const records = await SpatialArtifactNodeModel.find({
    job_id: job.job_id, project_id: job.project_id, user_id: job.user_id, state: 'published',
  }).sort({ created_at: 1 }).lean<SpatialArtifactNodeRecord[]>()
  return { job, artifacts: records.map(sourceArtifact) }
}

export async function resolvePublishedWorldSource(
  jobId: string,
  scope: SceneCommandScope,
): Promise<SceneWorldSource> {
  const { job, artifacts } = await publishedJobWithArtifacts(jobId, scope, 'world')
  if (!artifacts.some(artifact => /\.(spz|ply)$/i.test(artifact.workspace_path))) {
    throw new SpatialSceneAssetRejectedError('World Job 没有已发布的 SPZ 或 PLY。')
  }
  const up = artifacts.map(artifact => artifact.metadata.up_axis).find(value => value === 'Y' || value === 'Z')
  return { source_job_id: job.job_id, up_axis: up === 'Y' ? 'Y' : 'Z', artifacts }
}

export async function resolvePublishedObjectSource(
  jobId: string,
  scope: SceneCommandScope,
): Promise<Pick<SceneObjectInstance, 'source_job_id' | 'glb_artifact' | 'optional_ply_artifact' | 'normalization'>> {
  const { job, artifacts } = await publishedJobWithArtifacts(jobId, scope, 'object')
  const glb = artifacts.find(artifact => artifact.workspace_path.toLowerCase().endsWith('.glb'))
  if (!glb) throw new SpatialSceneAssetRejectedError('Object Job 没有已发布的 standalone GLB。')
  const ply = artifacts.find(artifact => artifact.workspace_path.toLowerCase().endsWith('.ply'))
  if (ply && job.provider !== 'lux3d') {
    throw new SpatialSceneAssetRejectedError('该 PLY 没有已知的本地坐标基契约，拒绝猜测姿态。')
  }
  const bounds = glb.metadata.bounds
  const parsedBounds = bounds && typeof bounds === 'object' && !Array.isArray(bounds)
    ? clone(bounds) as SceneObjectInstance['normalization']['bounds']
    : undefined
  return {
    source_job_id: job.job_id,
    glb_artifact: glb,
    ...(ply ? { optional_ply_artifact: ply } : {}),
    normalization: {
      ...(job.provider === 'lux3d' ? { basis_contract_version: 'lux3d_g1_paired_v1' as const } : {}),
      source_up_axis: 'Y',
      scene_up_axis: 'Z',
      pivot: 'bottom_center',
      glb_basis_correction: 'gltf_y_up_to_scene_z_up',
      ...(ply ? {
        ply_source_up_axis: '-Y' as const,
        ply_basis_correction: 'lux_ply_negative_y_up_to_scene_z_up' as const,
      } : {}),
      ...(parsedBounds ? { bounds: parsedBounds } : {}),
    },
  }
}

export async function createSpatialScene(input: {
  identity: SceneMutationIdentity
  title: string
  world?: SceneWorldSource | null
  environment?: ScenePanoramaEnvironment | null
  commandHash: string
}): Promise<SceneMutationResult> {
  await connectDB()
  const key = mutationKey(input.identity)
  const sceneId = hashId('scene', input.identity.projectId, key)
  const revisionId = hashId('scnrev', input.identity.projectId, key)
  const existing = await SpatialSceneRevisionModel.findOne({ project_id: input.identity.projectId, mutation_key: key })
    .lean<SpatialSceneRevisionRecord>()
  if (existing) {
    if (existing.mutation_hash !== input.commandHash) {
      throw new SpatialSceneCommandRejectedError('同一 tool call 的 Scene 创建参数发生变化，拒绝重放。')
    }
    let scene = await getSpatialScene(existing.scene_id, input.identity)
    if (!scene) {
      try {
        await SpatialSceneModel.create({
          scene_id: sceneId, project_id: input.identity.projectId, user_id: input.identity.userId,
          conversation_id: input.identity.conversationId ?? input.identity.projectId,
          title: requireText('title', input.title, 160), current_revision_id: revisionId,
          current_version: 1, agent_viewpoint: null,
        })
      } catch (error) { if (!duplicateKey(error)) throw error }
      scene = await requireSpatialScene(sceneId, input.identity)
    }
    const committed = existing.committed
      ? existing
      : await SpatialSceneRevisionModel.findOneAndUpdate(
        { revision_id: existing.revision_id, committed: false },
        { $set: { committed: true } },
        { returnDocument: 'after' },
      ).lean<SpatialSceneRevisionRecord>()
    if (!committed) throw new SpatialSceneCommandRejectedError('Scene 创建恢复失败。')
    return { status: 'applied', scene, revision: committed, replayed: true }
  }
  const revision: Omit<SpatialSceneRevisionRecord, 'created_at' | 'updated_at'> = {
    revision_id: revisionId,
    scene_id: sceneId,
    project_id: input.identity.projectId,
    user_id: input.identity.userId,
    version: 1,
    parent_revision_id: null,
    mutation_key: key,
    mutation_hash: input.commandHash,
    environment: clone(input.environment ?? null),
    world: clone(input.world ?? null),
    instances: [],
    change_summary: input.environment ? '创建 Scene 并设置全景环境' : input.world ? '创建 Scene 并设置初始 World' : '创建空 Scene',
    observation_id: null,
    created_by: input.identity.actorId,
    committed: false,
  }
  try {
    await SpatialSceneModel.create({
      scene_id: sceneId,
      project_id: input.identity.projectId,
      user_id: input.identity.userId,
      conversation_id: input.identity.conversationId ?? input.identity.projectId,
      title: requireText('title', input.title, 160),
      current_revision_id: revisionId,
      current_version: 1,
      agent_viewpoint: null,
    })
  } catch (error) {
    if (!duplicateKey(error)) throw error
  }
  try { await SpatialSceneRevisionModel.create(revision) } catch (error) { if (!duplicateKey(error)) throw error }
  const scene = await requireSpatialScene(sceneId, input.identity)
  const committed = await SpatialSceneRevisionModel.findOneAndUpdate({
    revision_id: scene.current_revision_id,
    scene_id: scene.scene_id,
    mutation_hash: input.commandHash,
  }, { $set: { committed: true } }, { returnDocument: 'after' }).lean<SpatialSceneRevisionRecord>()
  if (!committed) throw new SpatialSceneCommandRejectedError('Scene 创建未完整提交。')
  return { status: 'applied', scene, revision: committed, replayed: false }
}

export async function mutateSpatialScene(input: {
  identity: SceneMutationIdentity
  sceneId: string
  expectedVersion?: number
  observationId?: string
  summary: string
  commandHash: string
  mutate(snapshot: Pick<SpatialSceneRevisionRecord, 'environment' | 'world' | 'instances'>): Pick<SpatialSceneRevisionRecord, 'environment' | 'world' | 'instances'>
}): Promise<SceneMutationResult> {
  await connectDB()
  const key = mutationKey(input.identity)
  const prior = await SpatialSceneRevisionModel.findOne({ project_id: input.identity.projectId, mutation_key: key })
    .lean<SpatialSceneRevisionRecord>()
  if (prior) {
    if (prior.scene_id !== input.sceneId) throw new SpatialSceneCommandRejectedError('同一 tool call 已绑定到其他 Scene。')
    if (prior.mutation_hash !== input.commandHash) throw new SpatialSceneCommandRejectedError('同一 tool call 的 Scene 修改参数发生变化，拒绝重放。')
    const scene = await requireSpatialScene(input.sceneId, input.identity)
    if (!prior.committed && scene.current_revision_id === prior.revision_id) {
      const repaired = await SpatialSceneRevisionModel.findOneAndUpdate(
        { revision_id: prior.revision_id, committed: false },
        { $set: { committed: true } },
        { returnDocument: 'after' },
      ).lean<SpatialSceneRevisionRecord>()
      if (!repaired) throw new SpatialSceneCommandRejectedError('Scene revision 恢复失败。')
      return { status: 'applied', scene, revision: repaired, replayed: true }
    }
    if (prior.committed && scene.current_revision_id === prior.revision_id) {
      return { status: 'applied', scene, revision: prior, replayed: true }
    }
    return { status: 'scene_changed', scene, latestRevision: await getCurrentSpatialSceneRevision(scene) }
  }
  const scene = await requireSpatialScene(input.sceneId, input.identity)
  const parent = await getCurrentSpatialSceneRevision(scene)
  if (input.expectedVersion !== undefined && parent.version !== input.expectedVersion) {
    return { status: 'scene_changed', scene, latestRevision: parent }
  }
  if (input.observationId) {
    const observation = await SpatialObservationModel.findOne({
      observation_id: input.observationId,
      scene_id: scene.scene_id,
      project_id: scene.project_id,
      user_id: scene.user_id,
    }).lean<SpatialObservationRecord>()
    if (!observation || observation.revision_id !== parent.revision_id) {
      throw new SpatialSceneCommandRejectedError('观察点来自旧 Scene revision；请重新观察后再修改。')
    }
  }
  const next = input.mutate({ environment: clone(parent.environment ?? null), world: clone(parent.world), instances: clone(parent.instances) })
  const revisionId = hashId('scnrev', scene.scene_id, key)
  const candidate: Omit<SpatialSceneRevisionRecord, 'created_at' | 'updated_at'> = {
    revision_id: revisionId,
    scene_id: scene.scene_id,
    project_id: scene.project_id,
    user_id: scene.user_id,
    version: parent.version + 1,
    parent_revision_id: parent.revision_id,
    mutation_key: key,
    mutation_hash: input.commandHash,
    environment: clone(next.environment),
    world: clone(next.world),
    instances: clone(next.instances),
    change_summary: requireText('change_summary', input.summary, 1000),
    observation_id: input.observationId?.trim() || null,
    created_by: input.identity.actorId,
    committed: false,
  }
  try { await SpatialSceneRevisionModel.create(candidate) } catch (error) { if (!duplicateKey(error)) throw error }
  const updated = await SpatialSceneModel.findOneAndUpdate({
    ...scopedSceneFilter(scene.scene_id, input.identity),
    current_revision_id: parent.revision_id,
    current_version: parent.version,
  }, {
    $set: { current_revision_id: revisionId, current_version: parent.version + 1 },
  }, { returnDocument: 'after' }).lean<SpatialSceneRecord>()
  if (!updated) {
    const latest = await requireSpatialScene(scene.scene_id, input.identity)
    return { status: 'scene_changed', scene: latest, latestRevision: await getCurrentSpatialSceneRevision(latest) }
  }
  const committed = await SpatialSceneRevisionModel.findOneAndUpdate({ revision_id: revisionId }, {
    $set: { committed: true },
  }, { returnDocument: 'after' }).lean<SpatialSceneRevisionRecord>()
  if (!committed) throw new SpatialSceneCommandRejectedError('Scene revision 提交失败。')
  return { status: 'applied', scene: updated, revision: committed, replayed: false }
}

export async function restoreSpatialSceneRevision(input: {
  identity: SceneMutationIdentity
  sceneId: string
  version: number
  commandHash: string
}): Promise<SceneMutationResult> {
  const scene = await requireSpatialScene(input.sceneId, input.identity)
  const source = await SpatialSceneRevisionModel.findOne({
    scene_id: scene.scene_id, project_id: scene.project_id, user_id: scene.user_id,
    version: input.version, committed: true,
  }).lean<SpatialSceneRevisionRecord>()
  if (!source) throw new SpatialSceneCommandRejectedError('找不到指定的历史 Scene version。')
  return mutateSpatialScene({
    identity: input.identity,
    sceneId: scene.scene_id,
    commandHash: input.commandHash,
    summary: `从 Scene v${source.version} 恢复为一个新的 revision`,
    mutate: () => ({ environment: clone(source.environment ?? null), world: clone(source.world), instances: clone(source.instances) }),
  })
}

export async function setSpatialSceneViewpoint(input: {
  scope: SceneCommandScope
  sceneId: string
  viewpoint: SceneViewpoint
}): Promise<SpatialSceneRecord> {
  await connectDB()
  const viewpoint = normalizeViewpoint(input.viewpoint)
  const scene = await SpatialSceneModel.findOneAndUpdate(scopedSceneFilter(input.sceneId, input.scope), {
    $set: { agent_viewpoint: viewpoint },
  }, { returnDocument: 'after' }).lean<SpatialSceneRecord>()
  if (!scene) throw new SpatialSceneCommandRejectedError()
  return scene
}

export async function registerSpatialRenderSession(input: {
  scope: SceneCommandScope
  sceneId: string
  clientId: string
  ttlMs?: number
}): Promise<SpatialRenderSessionRecord> {
  await requireSpatialScene(input.sceneId, input.scope)
  const now = new Date(); const sessionId = hashId('rendersess', input.scope.projectId, input.sceneId, input.clientId)
  const record = await SpatialRenderSessionModel.findOneAndUpdate({ session_id: sessionId }, {
    $set: {
      scene_id: input.sceneId, project_id: input.scope.projectId, user_id: input.scope.userId,
      client_id: requireText('client_id', input.clientId), lease_token: randomUUID(), heartbeat_at: now,
      expires_at: new Date(now.getTime() + Math.max(5_000, Math.min(input.ttlMs ?? 120_000, 300_000))),
    },
    $setOnInsert: { session_id: sessionId },
  }, { upsert: true, returnDocument: 'after' }).lean<SpatialRenderSessionRecord>()
  if (!record) throw new Error('无法注册空间舞台 render session。')
  return record
}

export async function heartbeatSpatialRenderSession(input: {
  sessionId: string; leaseToken: string; ttlMs?: number
}): Promise<boolean> {
  const now = new Date()
  const result = await SpatialRenderSessionModel.updateOne({ session_id: input.sessionId, lease_token: input.leaseToken }, {
    $set: { heartbeat_at: now, expires_at: new Date(now.getTime() + Math.max(5_000, Math.min(input.ttlMs ?? 120_000, 300_000))) },
  })
  return result.matchedCount === 1
}

export async function releaseSpatialRenderSession(input: {
  scope: SceneCommandScope
  sceneId: string
  sessionId: string
  leaseToken: string
}): Promise<boolean> {
  await connectDB()
  const result = await SpatialRenderSessionModel.deleteOne({
    session_id: input.sessionId,
    lease_token: input.leaseToken,
    scene_id: input.sceneId,
    project_id: input.scope.projectId,
    user_id: input.scope.userId,
  })
  return result.deletedCount === 1
}

export async function enqueueSpatialRenderCommand(input: {
  identity: SceneMutationIdentity
  sceneId: string
  note?: string
}): Promise<SpatialRenderCommandRecord | null> {
  await connectDB()
  const scene = await requireSpatialScene(input.sceneId, input.identity)
  if (!scene.agent_viewpoint) throw new SpatialSceneCommandRejectedError('请先设置 Agent 相机。')
  const active = await SpatialRenderSessionModel.exists({
    scene_id: scene.scene_id, project_id: scene.project_id, user_id: scene.user_id, expires_at: { $gt: new Date() },
  })
  if (!active) return null
  const commandId = hashId('rendercmd', scene.project_id, input.identity.runId, input.identity.toolUseId)
  const existing = await SpatialRenderCommandModel.findOne({ command_id: commandId }).lean<SpatialRenderCommandRecord>()
  if (existing) return existing
  return SpatialRenderCommandModel.create({
    command_id: commandId, scene_id: scene.scene_id, project_id: scene.project_id, user_id: scene.user_id,
    run_id: input.identity.runId, tool_use_id: input.identity.toolUseId,
    kind: 'capture',
    revision_id: scene.current_revision_id, viewpoint: clone(scene.agent_viewpoint),
    note: input.note?.trim().slice(0, 1000) || null, status: 'queued', lease: null,
    observation_id: hashId('observation', commandId), screenshot_asset_id: null,
    surface_query: null, surface_result: null,
    screenshot_workspace_path: null, last_error: null, completed_at: null,
  }).then(document => document.toObject() as SpatialRenderCommandRecord)
}

export async function enqueueSpatialSurfaceQueryCommand(input: {
  identity: SceneMutationIdentity
  sceneId: string
  terrainInstanceId: string
  horizontal: [number, number]
  castHeight?: number
}): Promise<SpatialRenderCommandRecord | null> {
  await connectDB()
  const scene = await requireSpatialScene(input.sceneId, input.identity)
  const revision = await getCurrentSpatialSceneRevision(scene)
  const terrain = revision.instances.find(candidate => candidate.instance_id === input.terrainInstanceId)
  if (!terrain || terrain.role !== 'terrain') {
    throw new SpatialSceneCommandRejectedError('指定 instance 不是当前 Scene 的 Lux 地形。')
  }
  const active = await SpatialRenderSessionModel.exists({
    scene_id: scene.scene_id, project_id: scene.project_id, user_id: scene.user_id, expires_at: { $gt: new Date() },
  })
  if (!active) return null
  const commandId = hashId('rendercmd', scene.project_id, input.identity.runId, input.identity.toolUseId)
  const existing = await SpatialRenderCommandModel.findOne({ command_id: commandId }).lean<SpatialRenderCommandRecord>()
  if (existing) return existing
  const castHeight = Math.max(1, Math.min(input.castHeight ?? 10_000, 1_000_000))
  return SpatialRenderCommandModel.create({
    command_id: commandId, scene_id: scene.scene_id, project_id: scene.project_id, user_id: scene.user_id,
    run_id: input.identity.runId, tool_use_id: input.identity.toolUseId, kind: 'surface_query',
    revision_id: scene.current_revision_id,
    viewpoint: scene.agent_viewpoint ?? { position: [0, 0, 1], target: [0, 1, 1], up: [0, 0, 1], fov_deg: 56 },
    note: null, status: 'queued', lease: null, observation_id: hashId('surface', commandId),
    surface_query: {
      terrain_instance_id: terrain.instance_id,
      horizontal: clone(input.horizontal),
      cast_height: castHeight,
      up_axis: terrain.normalization.scene_up_axis,
    },
    surface_result: null, screenshot_asset_id: null, screenshot_workspace_path: null,
    last_error: null, completed_at: null,
  }).then(document => document.toObject() as SpatialRenderCommandRecord)
}

export async function claimSpatialRenderCommand(input: {
  scope: SceneCommandScope; sceneId: string; sessionId: string; leaseToken: string; leaseMs?: number
}): Promise<SpatialRenderCommandRecord | null> {
  await connectDB()
  const session = await SpatialRenderSessionModel.findOne({
    session_id: input.sessionId, lease_token: input.leaseToken, scene_id: input.sceneId,
    project_id: input.scope.projectId, user_id: input.scope.userId, expires_at: { $gt: new Date() },
  }).lean<SpatialRenderSessionRecord>()
  if (!session) return null
  const now = new Date(); const token = randomUUID()
  return SpatialRenderCommandModel.findOneAndUpdate({
    scene_id: input.sceneId, project_id: input.scope.projectId, user_id: input.scope.userId,
    $or: [
      { status: 'queued' },
      { status: 'claimed', 'lease.expires_at': { $lte: now } },
    ],
  }, {
    $set: { status: 'claimed', lease: { session_id: session.session_id, token, expires_at: new Date(now.getTime() + Math.max(10_000, Math.min(input.leaseMs ?? 45_000, 120_000))) } },
  }, { sort: { created_at: 1 }, returnDocument: 'after' }).lean<SpatialRenderCommandRecord>()
}

export async function completeSpatialRenderCommand(input: {
  commandId: string; sessionId: string; leaseToken: string; screenshotAssetId: string; screenshotWorkspacePath: string
}): Promise<SpatialRenderCommandRecord | null> {
  await connectDB()
  return SpatialRenderCommandModel.findOneAndUpdate({
    command_id: input.commandId, status: 'claimed', 'lease.session_id': input.sessionId,
    'lease.token': input.leaseToken, 'lease.expires_at': { $gt: new Date() },
  }, {
    $set: {
      status: 'completed', lease: null, screenshot_asset_id: requireText('screenshot_asset_id', input.screenshotAssetId),
      screenshot_workspace_path: requireText('screenshot_workspace_path', input.screenshotWorkspacePath),
      completed_at: new Date(), last_error: null,
    },
  }, { returnDocument: 'after' }).lean<SpatialRenderCommandRecord>()
}

export async function completeSpatialSurfaceQueryCommand(input: {
  commandId: string; sessionId: string; leaseToken: string; point: Vec3; terrainInstanceId: string
}): Promise<SpatialRenderCommandRecord | null> {
  await connectDB()
  return SpatialRenderCommandModel.findOneAndUpdate({
    command_id: input.commandId, kind: 'surface_query', status: 'claimed',
    'lease.session_id': input.sessionId, 'lease.token': input.leaseToken, 'lease.expires_at': { $gt: new Date() },
    'surface_query.terrain_instance_id': input.terrainInstanceId,
  }, {
    $set: {
      status: 'completed', lease: null,
      surface_result: { point: clone(input.point), terrain_instance_id: input.terrainInstanceId },
      completed_at: new Date(), last_error: null,
    },
  }, { returnDocument: 'after' }).lean<SpatialRenderCommandRecord>()
}

export async function failSpatialRenderCommand(input: {
  commandId: string; sessionId: string; leaseToken: string; error: string
}): Promise<SpatialRenderCommandRecord | null> {
  await connectDB()
  return SpatialRenderCommandModel.findOneAndUpdate({
    command_id: input.commandId, status: 'claimed', 'lease.session_id': input.sessionId,
    'lease.token': input.leaseToken, 'lease.expires_at': { $gt: new Date() },
  }, {
    $set: { status: 'failed', lease: null, last_error: requireText('error', input.error, 1000), completed_at: new Date() },
  }, { returnDocument: 'after' }).lean<SpatialRenderCommandRecord>()
}

export async function createSpatialObservation(input: Omit<SpatialObservationRecord, 'created_at' | 'updated_at'>): Promise<SpatialObservationRecord> {
  await connectDB()
  const scene = await requireSpatialScene(input.scene_id, { projectId: input.project_id, userId: input.user_id })
  const revisionExists = await SpatialSceneRevisionModel.exists({
    revision_id: input.revision_id, scene_id: scene.scene_id,
    project_id: scene.project_id, user_id: scene.user_id, committed: true,
  })
  if (!revisionExists) throw new SpatialSceneCommandRejectedError('观察对应的 Scene revision 不存在。')
  const existing = await SpatialObservationModel.findOne({ observation_id: input.observation_id }).lean<SpatialObservationRecord>()
  if (existing) return existing
  const document = await SpatialObservationModel.create({ ...clone(input), viewpoint: normalizeViewpoint(input.viewpoint) })
  return document.toObject() as SpatialObservationRecord
}

export async function getSpatialRenderCommand(commandId: string, scope: SceneCommandScope): Promise<SpatialRenderCommandRecord | null> {
  await connectDB()
  return SpatialRenderCommandModel.findOne({ command_id: commandId, project_id: scope.projectId, user_id: scope.userId })
    .lean<SpatialRenderCommandRecord>()
}
