import { createHash } from 'node:crypto'
import { getOwnedImageAsset } from '../media/storage'
import { toRasterAssetRef } from '../media/reference'
import { normalizeWorkspacePath } from '../workspace/path-policy'
import type { WorkspaceInstance } from '../workspace/types'
import type { AgentExecutionContext, ToolExecutionInvocation } from '../agent/execution-context'
import type { ToolResult } from '../types'
import {
  createSpatialScene,
  createSpatialObservation,
  enqueueSpatialRenderCommand,
  enqueueSpatialSurfaceQueryCommand,
  getCurrentSpatialSceneRevision,
  getSpatialRenderCommand,
  listSpatialSceneHistory,
  mutateSpatialScene,
  requireSpatialScene,
  resolvePublishedObjectSource,
  resolvePublishedWorldSource,
  restoreSpatialSceneRevision,
  setSpatialSceneViewpoint,
} from '../spatial/scene-repository'
import { compileSceneSpecNodes, parseSceneSpecV1, summarizeSceneSpecChange } from '../spatial/scene-spec'
import { sceneAlignedGlbSize } from '../spatial/object-alignment'
import { normalizeTransform, normalizeViewpoint } from '../spatial/scene-math'
import type {
  SceneCommandScope,
  SceneMutationIdentity,
  SceneObjectInstance,
  SpatialSceneRecord,
  SpatialSceneRevisionRecord,
  Vec3,
} from '../spatial/scene-types'

export const SPATIAL_SCENE_TOOL_NAMES = [
  'CreateSpatialScene',
  'SetSceneEnvironment',
  'SetSceneWorld',
  'AddSceneTerrain',
  'AddSceneObject',
  'TransformSceneObject',
  'RemoveSceneObject',
  'ApplySceneSpec',
  'InspectSpatialScene',
  'RestoreSpatialScene',
  'SetSceneViewpoint',
  'FocusSceneObject',
  'CaptureSceneView',
  'QuerySceneSurface',
] as const
export type SpatialSceneToolName = typeof SPATIAL_SCENE_TOOL_NAMES[number]

export interface SpatialSceneToolRuntime {
  executionContext?: AgentExecutionContext
  invocation?: ToolExecutionInvocation
  signal?: AbortSignal
  workspace?: WorkspaceInstance
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('工具输入必须是对象。')
  return value as Record<string, unknown>
}
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys)
  if (Object.keys(value).some(key => !allowed.has(key))) throw new TypeError('工具输入包含未知字段。')
}
function text(label: string, value: unknown, max = 400): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} 必须是非空字符串。`)
  if (value.trim().length > max) throw new TypeError(`${label} 不能超过 ${max} 个字符。`)
  return value.trim()
}
function optionalText(label: string, value: unknown, max = 400): string | undefined {
  return value === undefined ? undefined : text(label, value, max)
}
function context(runtime: SpatialSceneToolRuntime): {
  identity: SceneMutationIdentity
  scope: SceneCommandScope
  context: AgentExecutionContext
  invocation: ToolExecutionInvocation
} {
  const execution = runtime.executionContext
  const invocation = runtime.invocation
  if (!execution || !invocation) throw new TypeError('Scene 工具需要持久化的 Agent 执行上下文。')
  const projectId = execution.workspaceId || execution.conversationId
  return {
    identity: {
      projectId,
      userId: execution.userId,
      conversationId: execution.conversationId,
      runId: execution.runId,
      toolUseId: invocation.toolUseId,
      actorId: execution.agentId || execution.agentAlias || 'root',
    },
    scope: { projectId, userId: execution.userId, conversationId: execution.conversationId },
    context: execution,
    invocation,
  }
}
function result(value: Record<string, unknown>, error = false): ToolResult {
  return { content: JSON.stringify({ schema_version: 1, ...value }), ...(error ? { is_error: true } : {}) }
}
function failure(error: unknown): ToolResult {
  const candidate = error as { code?: unknown; message?: unknown }
  return result({
    kind: 'scene',
    status: candidate.code === 'SPATIAL_SCENE_COMMAND_REJECTED' ? 'scene_changed' : 'failed',
    error: typeof candidate.message === 'string' ? candidate.message.slice(0, 4000) : 'Scene 工具执行失败。',
  }, true)
}
function revisionPayload(scene: SpatialSceneRecord, revision: SpatialSceneRevisionRecord, replayed = false): Record<string, unknown> {
  return {
    kind: 'scene', status: 'applied', scene_id: scene.scene_id, scene_version: scene.current_version,
    change_summary: revision.change_summary, replayed,
  }
}
function mutationPayload(value: Awaited<ReturnType<typeof mutateSpatialScene>>): ToolResult {
  if (value.status === 'scene_changed') return result({
    kind: 'scene', status: 'scene_changed', scene_id: value.scene.scene_id,
    scene_version: value.scene.current_version,
    error: 'Scene 已被其他修改更新；请 InspectSpatialScene 后用绝对坐标重试。',
  }, true)
  return result(revisionPayload(value.scene, value.revision, value.replayed))
}
function optionalObservation(input: Record<string, unknown>): string | undefined {
  return optionalText('observation_id', input.observation_id, 160)
}

function finiteNumber(label: string, value: unknown, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} 必须是有限数字。`)
  return value
}

function pair(label: string, value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new TypeError(`${label} 必须是两个有限数字。`)
  return [finiteNumber(`${label}[0]`, value[0]), finiteNumber(`${label}[1]`, value[1])]
}

async function resolvePanoramaEnvironment(
  workspace: WorkspaceInstance | undefined,
  execution: AgentExecutionContext,
  rawPath: unknown,
  yaw: unknown,
  exposure: unknown,
) {
  if (!workspace) throw new TypeError('SetSceneEnvironment 需要受权 Workspace。')
  if (typeof rawPath !== 'string' || !rawPath.trim()) throw new TypeError('image_path 必须是非空 Workspace 图片路径。')
  const path = normalizeWorkspacePath(rawPath)
  const first = await workspace.readRaster(path)
  if (!first) throw new TypeError(`Workspace 中不存在可用图片：${path}`)
  const stored = await getOwnedImageAsset(first.assetId, execution.userId, execution.conversationId)
  if (!stored) throw new TypeError('全景图片不属于当前项目或尚未完成持久化。')
  const current = await workspace.readRaster(path)
  if (!current || current.assetId !== first.assetId) throw new TypeError('读取期间 Workspace 图片发生变化，请重新提交。')
  const yawDeg = finiteNumber('yaw_deg', yaw, 0)
  const exposureValue = finiteNumber('exposure', exposure, 1)
  if (exposureValue <= 0 || exposureValue > 8) throw new TypeError('exposure 必须大于 0 且不超过 8。')
  const original = stored.variants.original
  return {
    kind: 'equirectangular_panorama' as const,
    workspace_path: path,
    asset_id: stored.assetId,
    mime_type: original.mimeType,
    width: original.width,
    height: original.height,
    size_bytes: original.sizeBytes,
    sha256: stored.sha256,
    yaw_deg: yawDeg,
    exposure: exposureValue,
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]))
  }
  return value
}

function commandHash(name: SpatialSceneToolName, input: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(canonical({ name, input }))).digest('hex')
}

export async function executeSpatialSceneTool(
  name: SpatialSceneToolName,
  rawInput: unknown,
  runtime: SpatialSceneToolRuntime,
): Promise<ToolResult> {
  try {
    const input = record(rawInput)
    const durable = context(runtime)
    switch (name) {
      case 'CreateSpatialScene': {
        onlyKeys(input, ['title', 'world_job_id'])
        const worldJobId = optionalText('world_job_id', input.world_job_id, 160)
        const world = worldJobId ? await resolvePublishedWorldSource(worldJobId, durable.scope) : null
        const created = await createSpatialScene({ identity: durable.identity, title: text('title', input.title, 160), world, commandHash: commandHash(name, input) })
        if (created.status !== 'applied') return mutationPayload(created)
        return result(revisionPayload(created.scene, created.revision, created.replayed))
      }
      case 'SetSceneEnvironment': {
        onlyKeys(input, ['scene_id', 'image_path', 'yaw_deg', 'exposure', 'observation_id'])
        const environment = await resolvePanoramaEnvironment(
          runtime.workspace,
          durable.context,
          input.image_path,
          input.yaw_deg,
          input.exposure,
        )
        return mutationPayload(await mutateSpatialScene({
          identity: durable.identity, sceneId: text('scene_id', input.scene_id, 160),
          commandHash: commandHash(name, input), observationId: optionalObservation(input),
          summary: `设置等距柱状全景环境 ${environment.workspace_path}`,
          mutate: snapshot => ({ ...snapshot, environment }),
        }))
      }
      case 'SetSceneWorld': {
        onlyKeys(input, ['scene_id', 'world_job_id', 'observation_id'])
        const world = await resolvePublishedWorldSource(text('world_job_id', input.world_job_id, 160), durable.scope)
        return mutationPayload(await mutateSpatialScene({
          identity: durable.identity, sceneId: text('scene_id', input.scene_id, 160),
          commandHash: commandHash(name, input),
          observationId: optionalObservation(input), summary: `将整体 World 更新为 Job ${world.source_job_id}`,
          mutate: snapshot => ({ ...snapshot, world }),
        }))
      }
      case 'AddSceneObject': {
        onlyKeys(input, ['scene_id', 'object_job_id', 'label', 'position', 'rotation_deg', 'scale', 'observation_id'])
        const object = await resolvePublishedObjectSource(text('object_job_id', input.object_job_id, 160), durable.scope)
        const scene = await requireSpatialScene(text('scene_id', input.scene_id, 160), durable.scope)
        const current = await getCurrentSpatialSceneRevision(scene)
        const instanceId = `instance_${durable.invocation.toolUseId.replace(/[^a-zA-Z0-9_-]/g, '').slice(-48) || 'object'}`
        const instance: SceneObjectInstance = {
          instance_id: instanceId,
          label: optionalText('label', input.label, 160) ?? '未命名物体',
          role: 'object',
          ...object,
          normalization: { ...object.normalization, scene_up_axis: current.world?.up_axis ?? 'Z' },
          transform: normalizeTransform({ position: input.position, rotation_deg: input.rotation_deg, scale: input.scale }),
        }
        return mutationPayload(await mutateSpatialScene({
          identity: durable.identity, sceneId: text('scene_id', input.scene_id, 160),
          commandHash: commandHash(name, input),
          observationId: optionalObservation(input), summary: `添加物体“${instance.label}”`,
          mutate: snapshot => ({ ...snapshot, instances: [...snapshot.instances, instance] }),
        }))
      }
      case 'AddSceneTerrain': {
        onlyKeys(input, ['scene_id', 'object_job_id', 'label', 'position', 'rotation_deg', 'scale', 'observation_id'])
        const object = await resolvePublishedObjectSource(text('object_job_id', input.object_job_id, 160), durable.scope)
        const scene = await requireSpatialScene(text('scene_id', input.scene_id, 160), durable.scope)
        const current = await getCurrentSpatialSceneRevision(scene)
        const instance: SceneObjectInstance = {
          instance_id: `terrain_${durable.invocation.toolUseId.replace(/[^a-zA-Z0-9_-]/g, '').slice(-48) || 'foundation'}`,
          label: optionalText('label', input.label, 160) ?? 'Lux 地形模块', role: 'terrain', ...object,
          normalization: { ...object.normalization, scene_up_axis: current.world?.up_axis ?? 'Z' },
          transform: normalizeTransform({ position: input.position, rotation_deg: input.rotation_deg, scale: input.scale }),
        }
        return mutationPayload(await mutateSpatialScene({
          identity: durable.identity, sceneId: scene.scene_id, commandHash: commandHash(name, input),
          observationId: optionalObservation(input), summary: `添加 Lux 地形“${instance.label}”`,
          mutate: snapshot => ({ ...snapshot, instances: [...snapshot.instances, instance] }),
        }))
      }
      case 'TransformSceneObject': {
        onlyKeys(input, ['scene_id', 'instance_id', 'position', 'rotation_deg', 'scale', 'observation_id'])
        if (input.position === undefined && input.rotation_deg === undefined && input.scale === undefined) {
          throw new TypeError('至少提供 position、rotation_deg 或 scale 之一。')
        }
        const instanceId = text('instance_id', input.instance_id, 160)
        return mutationPayload(await mutateSpatialScene({
          identity: durable.identity, sceneId: text('scene_id', input.scene_id, 160),
          commandHash: commandHash(name, input),
          observationId: optionalObservation(input), summary: `更新物体 ${instanceId} 的绝对变换`,
          mutate: snapshot => {
            let found = false
            const instances = snapshot.instances.map(instance => {
              if (instance.instance_id !== instanceId) return instance
              found = true
              return { ...instance, transform: normalizeTransform(input, instance.transform) }
            })
            if (!found) throw new TypeError('Scene 中不存在该 instance_id。')
            return { ...snapshot, instances }
          },
        }))
      }
      case 'RemoveSceneObject': {
        onlyKeys(input, ['scene_id', 'instance_id', 'observation_id'])
        const instanceId = text('instance_id', input.instance_id, 160)
        return mutationPayload(await mutateSpatialScene({
          identity: durable.identity, sceneId: text('scene_id', input.scene_id, 160),
          commandHash: commandHash(name, input),
          observationId: optionalObservation(input), summary: `移除物体 ${instanceId}`,
          mutate: snapshot => {
            const instances = snapshot.instances.filter(instance => instance.instance_id !== instanceId)
            if (instances.length === snapshot.instances.length) throw new TypeError('Scene 中不存在该 instance_id。')
            return { ...snapshot, instances }
          },
        }))
      }
      case 'ApplySceneSpec': {
        onlyKeys(input, ['scene_id', 'spec_path', 'observation_id'])
        if (!runtime.workspace) throw new TypeError('ApplySceneSpec 需要受权 Workspace。')
        const sceneId = text('scene_id', input.scene_id, 160)
        const specPath = normalizeWorkspacePath(text('spec_path', input.spec_path, 512))
        if (!specPath.startsWith('output/spatial/scenes/') || !specPath.endsWith('.json')) {
          throw new TypeError('spec_path 必须位于 output/spatial/scenes/ 且使用 .json。')
        }
        const source = await runtime.workspace.readText(specPath)
        if (source === null) throw new TypeError(`Workspace 中不存在 Scene spec：${specPath}`)
        const spec = parseSceneSpecV1(source)
        if (spec.scene_id !== sceneId) throw new TypeError('Scene spec 的 scene_id 与工具输入不一致。')
        const scene = await requireSpatialScene(sceneId, durable.scope)
        const current = await getCurrentSpatialSceneRevision(scene)
        const instances = await compileSceneSpecNodes({
          sceneId,
          nodes: spec.nodes,
          resolveObject: jobId => resolvePublishedObjectSource(jobId, durable.scope),
        })
        const environment = spec.environment === undefined
          ? current.environment ?? null
          : spec.environment === null
            ? null
            : await resolvePanoramaEnvironment(
              runtime.workspace,
              durable.context,
              spec.environment.image_path,
              spec.environment.yaw_deg,
              spec.environment.exposure,
            )
        const sourceSha = createHash('sha256').update(source).digest('hex')
        return mutationPayload(await mutateSpatialScene({
          identity: durable.identity,
          sceneId,
          expectedVersion: spec.expected_scene_version,
          commandHash: commandHash(name, { scene_id: sceneId, spec_path: specPath, spec_sha256: sourceSha }),
          observationId: optionalObservation(input),
          summary: summarizeSceneSpecChange(current.instances, instances),
          mutate: snapshot => ({ ...snapshot, environment, instances }),
        }))
      }
      case 'InspectSpatialScene': {
        onlyKeys(input, ['scene_id', 'revision_version', 'include_history'])
        const scene = await requireSpatialScene(text('scene_id', input.scene_id, 160), durable.scope)
        let revision = await getCurrentSpatialSceneRevision(scene)
        if (input.revision_version !== undefined) {
          if (!Number.isInteger(input.revision_version) || Number(input.revision_version) < 1) throw new TypeError('revision_version 必须是正整数。')
          const history = await listSpatialSceneHistory(scene.scene_id, durable.scope)
          const selected = history.find(candidate => candidate.version === Number(input.revision_version))
          if (!selected) throw new TypeError('找不到指定的历史 Scene version。')
          revision = selected
        }
        const history = input.include_history === true
          ? (await listSpatialSceneHistory(scene.scene_id, durable.scope)).map(item => ({ version: item.version, change_summary: item.change_summary, created_at: item.created_at }))
          : undefined
        return result({
          kind: 'scene', status: 'inspected', scene_id: scene.scene_id, scene_version: revision.version,
          title: scene.title, environment: revision.environment ?? null, world: revision.world, instances: revision.instances,
          agent_viewpoint: scene.agent_viewpoint, ...(history ? { history } : {}),
        })
      }
      case 'RestoreSpatialScene': {
        onlyKeys(input, ['scene_id', 'revision_version'])
        if (!Number.isInteger(input.revision_version) || Number(input.revision_version) < 1) throw new TypeError('revision_version 必须是正整数。')
        return mutationPayload(await restoreSpatialSceneRevision({
          identity: durable.identity, sceneId: text('scene_id', input.scene_id, 160), version: Number(input.revision_version),
          commandHash: commandHash(name, input),
        }))
      }
      case 'SetSceneViewpoint': {
        onlyKeys(input, ['scene_id', 'position', 'target', 'up', 'fov_deg'])
        const viewpoint = normalizeViewpoint({ position: input.position, target: input.target, up: input.up, fov_deg: input.fov_deg })
        const scene = await setSpatialSceneViewpoint({ scope: durable.scope, sceneId: text('scene_id', input.scene_id, 160), viewpoint })
        return result({ kind: 'scene_viewpoint', status: 'applied', scene_id: scene.scene_id, scene_version: scene.current_version, viewpoint })
      }
      case 'FocusSceneObject': {
        onlyKeys(input, ['scene_id', 'instance_id', 'framing'])
        const scene = await requireSpatialScene(text('scene_id', input.scene_id, 160), durable.scope)
        const revision = await getCurrentSpatialSceneRevision(scene)
        const instanceId = text('instance_id', input.instance_id, 160)
        const instance = revision.instances.find(candidate => candidate.instance_id === instanceId)
        if (!instance) throw new TypeError('Scene 中不存在该 instance_id。')
        const framing = input.framing === undefined ? 'medium' : text('framing', input.framing, 20)
        if (!['close', 'medium', 'wide'].includes(framing)) throw new TypeError('framing 必须是 close、medium 或 wide。')
        const alignedSize = sceneAlignedGlbSize(instance.normalization)
        const radius = alignedSize
          ? Math.max(...alignedSize.map((value, axis) => value * instance.transform.scale[axis]), 1)
          : Math.max(...instance.transform.scale, 1)
        const distance = radius * ({ close: 1.8, medium: 3, wide: 5 }[framing] ?? 3)
        const target = instance.transform.position
        const up: Vec3 = revision.world?.up_axis === 'Y' ? [0, 1, 0] : [0, 0, 1]
        // Aholo generated Worlds are capture-centred 3DGS rather than a free
        // navigable metric mesh. Moving the camera several scene units away
        // can leave the valid splat view volume and produce a black review.
        // Keep World reviews at the capture origin; object-only scenes retain
        // an ordinary orbit-style framing position.
        const worldCaptureOrigin: Vec3 = [0, 0, 0]
        const originDistance = Math.hypot(
          target[0] - worldCaptureOrigin[0],
          target[1] - worldCaptureOrigin[1],
          target[2] - worldCaptureOrigin[2],
        )
        const position: Vec3 = revision.world
          ? originDistance > 0.05
            ? worldCaptureOrigin
            : revision.world.up_axis === 'Y' ? [0, radius, 0] : [0, 0, radius]
          : [target[0] + distance, target[1] - distance, target[2] + radius * 0.35]
        const viewpoint = normalizeViewpoint({ position, target, up, fov_deg: 52 })
        await setSpatialSceneViewpoint({ scope: durable.scope, sceneId: scene.scene_id, viewpoint })
        return result({ kind: 'scene_viewpoint', status: 'applied', scene_id: scene.scene_id, scene_version: scene.current_version, viewpoint, focused_instance_id: instanceId })
      }
      case 'CaptureSceneView': {
        onlyKeys(input, ['scene_id', 'note'])
        const command = await enqueueSpatialRenderCommand({
          identity: durable.identity, sceneId: text('scene_id', input.scene_id, 160), note: optionalText('note', input.note, 1000),
        })
        if (!command) return result({ kind: 'scene_capture', status: 'viewer_unavailable', error: '没有活动的空间舞台。请用户打开空间舞台后重试。' }, true)
        const deadline = Date.now() + 45_000
        let current = command
        while (!['completed', 'failed'].includes(current.status) && Date.now() < deadline) {
          if (runtime.signal?.aborted) throw runtime.signal.reason ?? new Error('CaptureSceneView 已取消。')
          await new Promise(resolve => setTimeout(resolve, 500))
          current = await getSpatialRenderCommand(current.command_id, durable.scope) ?? current
        }
        if (current.status !== 'completed' || !current.screenshot_asset_id) {
          return result({ kind: 'scene_capture', status: current.status === 'failed' ? 'failed' : 'pending', command_id: current.command_id, observation_id: current.observation_id }, current.status === 'failed')
        }
        const asset = await getOwnedImageAsset(
          current.screenshot_asset_id,
          durable.context.userId,
          durable.context.conversationId,
        )
        if (!asset) throw new Error('截图已经完成，但媒体资产不可读取。')
        if (!current.screenshot_workspace_path) throw new Error('截图已经完成，但 Workspace 发布记录缺失。')
        await createSpatialObservation({
          observation_id: current.observation_id, scene_id: current.scene_id,
          project_id: current.project_id, user_id: current.user_id,
          revision_id: current.revision_id, source: 'agent', viewpoint: current.viewpoint,
          screenshot_asset_id: current.screenshot_asset_id,
          screenshot_workspace_path: current.screenshot_workspace_path,
          selected_instance_id: null, visible_instance_ids: [],
          comment: current.note ?? 'Agent 视角截图复核',
        })
        return {
          content: JSON.stringify({ schema_version: 1, kind: 'scene_capture', status: 'completed', command_id: current.command_id, observation_id: current.observation_id, scene_id: current.scene_id, scene_revision_id: current.revision_id, viewpoint: current.viewpoint, workspace_path: current.screenshot_workspace_path }),
          media: [toRasterAssetRef(asset)],
        }
      }
      case 'QuerySceneSurface': {
        onlyKeys(input, ['scene_id', 'terrain_instance_id', 'horizontal', 'cast_height'])
        const command = await enqueueSpatialSurfaceQueryCommand({
          identity: durable.identity,
          sceneId: text('scene_id', input.scene_id, 160),
          terrainInstanceId: text('terrain_instance_id', input.terrain_instance_id, 160),
          horizontal: pair('horizontal', input.horizontal),
          castHeight: input.cast_height === undefined ? undefined : finiteNumber('cast_height', input.cast_height),
        })
        if (!command) return result({ kind: 'scene_surface', status: 'viewer_unavailable', error: '没有活动的空间舞台。请用户打开空间舞台后重试。' }, true)
        const deadline = Date.now() + 20_000
        let current = command
        while (!['completed', 'failed'].includes(current.status) && Date.now() < deadline) {
          if (runtime.signal?.aborted) throw runtime.signal.reason ?? new Error('QuerySceneSurface 已取消。')
          await new Promise(resolve => setTimeout(resolve, 250))
          current = await getSpatialRenderCommand(current.command_id, durable.scope) ?? current
        }
        if (current.status !== 'completed' || !current.surface_result) {
          return result({ kind: 'scene_surface', status: current.status === 'failed' ? 'failed' : 'pending', command_id: current.command_id, ...(current.last_error ? { error: current.last_error } : {}) }, current.status === 'failed')
        }
        return result({
          kind: 'scene_surface', status: 'completed', scene_id: current.scene_id,
          scene_revision_id: current.revision_id, command_id: current.command_id,
          terrain_instance_id: current.surface_result.terrain_instance_id,
          point: current.surface_result.point,
        })
      }
    }
  } catch (error) {
    return failure(error)
  }
}
