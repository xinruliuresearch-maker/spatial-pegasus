import { createHash } from 'node:crypto'
import mongoose from 'mongoose'
import { Conversation } from '../lib/db/models'
import { connectDB } from '../lib/db/mongodb'
import {
  activateOperatorSpatialBuildPaidSlot,
  claimSpatialBuildJobForOperator,
  createProductionSpatialDependencies,
  deterministicSpatialJobId,
  getCurrentSpatialSceneRevision,
  getSpatialBuildJob,
  markSpatialJobSubmitting,
  mutateSpatialScene,
  normalizeTransform,
  prepareSpatialBuild,
  processClaimedSpatialBuildJob,
  readSpatialRuntimeConfig,
  recordSpatialJobSubmitted,
  requireSpatialScene,
  resolvePublishedObjectSource,
  spatialRequestHash,
  type SceneObjectInstance,
  type Vec3,
} from '../lib/spatial'

const IMPORT_CONTRACT = 'lux3d-existing-task-import-v1'
const PRODUCTION_ASSET_HOST = 'qhsmodel.kujiale.com'

type Arguments = Record<string, string>

function parseArguments(argv: readonly string[]): Arguments {
  const result: Arguments = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) throw new TypeError(`未知参数：${token ?? '(missing)'}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new TypeError(`${token} 缺少值。`)
    const key = token.slice(2)
    if (key in result) throw new TypeError(`${token} 重复。`)
    result[key] = value
    index += 1
  }
  const allowed = new Set(['project-id', 'task-id', 'scene-id', 'label', 'position', 'rotation-deg', 'scale'])
  const unknown = Object.keys(result).filter(key => !allowed.has(key))
  if (unknown.length) throw new TypeError(`未知参数：${unknown.map(key => `--${key}`).join(', ')}`)
  return result
}

function requiredText(args: Arguments, key: string): string {
  const value = args[key]?.trim()
  if (!value) throw new TypeError(`--${key} 需要非空值。`)
  return value
}

function taskId(args: Arguments): string {
  const value = requiredText(args, 'task-id')
  if (!/^\d{1,32}$/.test(value)) throw new TypeError('--task-id 必须是 Lux3D 返回的数字任务 ID。')
  return value
}

function vector(args: Arguments, key: string, fallback: Vec3): Vec3 {
  const raw = args[key]
  if (!raw) return fallback
  const values = raw.split(',').map(value => Number(value.trim()))
  if (values.length !== 3 || values.some(value => !Number.isFinite(value))) {
    throw new TypeError(`--${key} 必须是三个以逗号分隔的有限数字。`)
  }
  return values as Vec3
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2))
  const projectId = requiredText(args, 'project-id')
  const externalTaskId = taskId(args)
  const fingerprint = shortHash(externalTaskId)

  await connectDB()
  const conversation = await Conversation.findOne({ conversation_id: projectId })
    .select('conversation_id user_id').lean<{ conversation_id: string; user_id: string }>()
  if (!conversation) throw new Error('project-id 对应的 Conversation 不存在。')

  // Never reopen the historical terminal Job. A deterministic import Job
  // freezes the already-paid provider task and is safe to replay.
  const runId = `lux_task_import_${fingerprint}`
  const toolUseId = 'import_object'
  const outputPrefix = `output/spatial/objects/task-import-${fingerprint}`
  const request = {
    output_path_prefix: outputPrefix,
    provider_options: {
      import_contract: IMPORT_CONTRACT,
      output_formats: ['glb', 'ply'],
      name: args.label?.trim() || 'Imported Lux3D Object',
    },
  }
  const jobId = deterministicSpatialJobId({ projectId, runId, toolUseId })
  let job = await getSpatialBuildJob(jobId, { projectId, userId: conversation.user_id })
  if (job) {
    const sameFrozenImport = job.run_id === runId
      && job.tool_use_id === toolUseId
      && job.conversation_id === conversation.conversation_id
      && job.kind === 'object'
      && job.provider === 'lux3d'
      && job.model_snapshot === IMPORT_CONTRACT
      && job.request_hash === spatialRequestHash(request)
    if (!sameFrozenImport) throw new Error('既有导入 Job 的冻结身份不匹配，拒绝复用。')
  } else {
    job = await prepareSpatialBuild({
      projectId,
      runId,
      toolUseId,
      userId: conversation.user_id,
      conversationId: conversation.conversation_id,
      kind: 'object',
      provider: 'lux3d',
      modelSnapshot: IMPORT_CONTRACT,
      executionGate: 'operator',
      request,
    })
  }

  if (job.status !== 'published') {
    if (job.status !== 'prepared') throw new Error(`导入 Job 已存在但状态为 ${job.status}，拒绝隐式重开。`)
    job = await activateOperatorSpatialBuildPaidSlot(job.job_id)
    const claim = await claimSpatialBuildJobForOperator({
      jobId: job.job_id,
      ownerId: `lux-existing-task-import:${fingerprint}`,
      leaseMs: 15 * 60_000,
    })
    if (!claim) throw new Error('无法取得导入 Job 的 operator lease。')
    const submitting = await markSpatialJobSubmitting(claim)
    const submitted = await recordSpatialJobSubmitted(submitting, {
      externalJobId: externalTaskId,
      providerStatus: 'existing-task-import',
    })
    const runtimeConfig = readSpatialRuntimeConfig({
      ...process.env,
      LUX3D_ASSET_HOST_ALLOWLIST: PRODUCTION_ASSET_HOST,
    })
    const processed = await processClaimedSpatialBuildJob(
      submitted,
      createProductionSpatialDependencies(runtimeConfig),
      { providerPollDelayMs: 5_000 },
    )
    job = processed.job
  }

  const authoritative = await getSpatialBuildJob(job.job_id, { projectId, userId: conversation.user_id })
  if (!authoritative || authoritative.status !== 'published') {
    throw new Error(`Lux3D 产物镜像没有完成（status ${authoritative?.status ?? 'missing'}）。`)
  }

  let sceneResult: {
    scene_id: string
    scene_version: number
    instance_id: string
    replayed: boolean
  } | null = null
  if (args['scene-id']) {
    const sceneId = requiredText(args, 'scene-id')
    const scope = { projectId, userId: conversation.user_id, conversationId: conversation.conversation_id }
    const object = await resolvePublishedObjectSource(authoritative.job_id, scope)
    const scene = await requireSpatialScene(sceneId, scope)
    const current = await getCurrentSpatialSceneRevision(scene)
    const label = (args.label?.trim() || 'Lux3D 物体').slice(0, 160)
    const instanceId = `instance_lux_${fingerprint}`
    const transformInput = {
      position: vector(args, 'position', [0, 0, 0]),
      rotation_deg: vector(args, 'rotation-deg', [0, 0, 0]),
      scale: vector(args, 'scale', [1, 1, 1]),
    }
    const instance: SceneObjectInstance = {
      instance_id: instanceId,
      label,
      ...object,
      normalization: { ...object.normalization, scene_up_axis: current.world?.up_axis ?? 'Z' },
      transform: normalizeTransform(transformInput),
    }
    const identity = {
      ...scope,
      runId,
      toolUseId: `add_to_scene_${shortHash(sceneId)}`,
      actorId: 'operator:lux-existing-task-import',
    }
    const mutationInput = {
      scene_id: sceneId,
      object_job_id: authoritative.job_id,
      instance_id: instanceId,
      label,
      ...transformInput,
    }
    const mutation = await mutateSpatialScene({
      identity,
      sceneId,
      commandHash: sha256(mutationInput),
      summary: `添加已生成的 Lux3D 物体“${label}”`,
      mutate: snapshot => {
        if (snapshot.instances.some(candidate => candidate.instance_id === instanceId)) {
          throw new TypeError(`Scene 已包含 ${instanceId}，拒绝重复添加。`)
        }
        return { ...snapshot, instances: [...snapshot.instances, instance] }
      },
    })
    if (mutation.status !== 'applied') throw new Error(`Scene 已变化至 v${mutation.latestRevision.version}，请重试导入。`)
    sceneResult = {
      scene_id: mutation.scene.scene_id,
      scene_version: mutation.revision.version,
      instance_id: instanceId,
      replayed: mutation.replayed,
    }
  }

  const object = await resolvePublishedObjectSource(authoritative.job_id, {
    projectId,
    userId: conversation.user_id,
  })
  console.log(JSON.stringify({
    state: 'published',
    source: 'lux3d_existing_task_via_public_api',
    task_fingerprint: fingerprint,
    job_id: authoritative.job_id,
    workspace_paths: authoritative.published_workspace_paths,
    glb: {
      artifact_id: object.glb_artifact.artifact_id,
      workspace_path: object.glb_artifact.workspace_path,
      bytes: object.glb_artifact.size_bytes,
      sha256: object.glb_artifact.sha256,
      metadata: object.glb_artifact.metadata,
    },
    ply: object.optional_ply_artifact ? {
      artifact_id: object.optional_ply_artifact.artifact_id,
      workspace_path: object.optional_ply_artifact.workspace_path,
      bytes: object.optional_ply_artifact.size_bytes,
      sha256: object.optional_ply_artifact.sha256,
    } : null,
    scene: sceneResult,
  }, null, 2))
}

void main()
  .catch(error => {
    console.error(JSON.stringify({
      state: 'failed_closed',
      error: error instanceof Error ? error.message : String(error),
    }, null, 2))
    process.exitCode = 1
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect()
  })
