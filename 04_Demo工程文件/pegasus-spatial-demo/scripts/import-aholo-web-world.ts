import { createHash } from 'node:crypto'
import mongoose from 'mongoose'
import { Conversation } from '../lib/db/models'
import { connectDB } from '../lib/db/mongodb'
import {
  activateOperatorSpatialBuildPaidSlot,
  claimSpatialBuildJobForOperator,
  createProductionSpatialDependencies,
  createSpatialScene,
  deterministicSpatialJobId,
  getSpatialBuildJob,
  markSpatialJobSubmitting,
  prepareSpatialBuild,
  processClaimedSpatialBuildJob,
  readSpatialRuntimeConfig,
  recordSpatialJobSubmitted,
  resolvePublishedWorldSource,
  spatialRequestHash,
} from '../lib/spatial'

const IMPORT_CONTRACT = 'aholo-web-world-import-v1'
const DEFAULT_API_BASE = 'https://api.aholo3d.cn'
const PRODUCTION_ASSET_HOST = 'holo-cos.aholo3d.cn'

type Arguments = Record<string, string | boolean>

function parseArguments(argv: readonly string[]): Arguments {
  const result: Arguments = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--latest-succeeded') {
      if (token.slice(2) in result) throw new TypeError(`${token} 重复。`)
      result[token.slice(2)] = true
      continue
    }
    if (!token?.startsWith('--')) throw new TypeError(`未知参数：${token ?? '(missing)'}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new TypeError(`${token} 缺少值。`)
    const key = token.slice(2)
    if (key in result) throw new TypeError(`${token} 重复。`)
    result[key] = value
    index += 1
  }
  const allowed = new Set(['project-id', 'world-id', 'latest-succeeded', 'title'])
  const unknown = Object.keys(result).filter(key => !allowed.has(key))
  if (unknown.length) throw new TypeError(`未知参数：${unknown.map(key => `--${key}`).join(', ')}`)
  if (Boolean(result['world-id']) === Boolean(result['latest-succeeded'])) {
    throw new TypeError('必须且只能提供 --world-id 或 --latest-succeeded。')
  }
  return result
}

function requiredText(args: Arguments, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`--${key} 需要非空值。`)
  return value.trim()
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Aholo 返回结构无效。')
  return value as Record<string, unknown>
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function resultBody(value: unknown): Record<string, unknown> {
  const body = object(value)
  for (const key of ['result', 'data', 'd']) {
    const nested = body[key]
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested as Record<string, unknown>
  }
  return body
}

async function jsonRequest(url: URL, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, redirect: 'error' })
  const text = await response.text()
  let body: unknown
  try { body = JSON.parse(text) } catch { throw new Error(`Aholo 返回了非 JSON 响应（HTTP ${response.status}）。`) }
  if (!response.ok) throw new Error(`Aholo 请求失败（HTTP ${response.status}）。`)
  const envelope = object(body)
  const code = envelope.c ?? envelope.code
  if (typeof code === 'number' && code !== 0) throw new Error(`Aholo 请求被拒绝（code ${code}）。`)
  return body
}

async function latestSucceededWorldId(base: URL, apiKey: string): Promise<string> {
  const body = object(await jsonRequest(new URL('/world/v1/list', base), {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pageNum: 0, pageSize: 20 }),
  }))
  const candidates = [body.result, body.data, body.d]
  let records: unknown[] | null = candidates.find(Array.isArray) as unknown[] | undefined ?? null
  if (!records) {
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
      const list = (candidate as Record<string, unknown>).list
      if (Array.isArray(list)) { records = list; break }
    }
  }
  for (const value of records ?? []) {
    const record = object(value)
    if (record.status !== 'SUCCEEDED') continue
    const worldId = nonEmptyString(record.worldId) ?? nonEmptyString(record.id) ?? nonEmptyString(record._id)
    if (worldId) return worldId
  }
  throw new Error('最近 20 个 Aholo World 中没有 SUCCEEDED 记录。')
}

async function assertWorldSucceeded(base: URL, apiKey: string, worldId: string): Promise<void> {
  const detail = resultBody(await jsonRequest(new URL(`/world/v1/${encodeURIComponent(worldId)}`, base), {
    headers: { Authorization: apiKey },
  }))
  if (detail.status !== 'SUCCEEDED') throw new Error(`Aholo World 尚未成功（status ${String(detail.status)}）。`)
  const assets = detail.assets && typeof detail.assets === 'object' && !Array.isArray(detail.assets)
    ? detail.assets as Record<string, unknown>
    : null
  const splats = assets?.splats && typeof assets.splats === 'object' && !Array.isArray(assets.splats)
    ? assets.splats as Record<string, unknown>
    : null
  const urls = splats?.urls && typeof splats.urls === 'object' && !Array.isArray(splats.urls)
    ? splats.urls as Record<string, unknown>
    : splats
  if (!nonEmptyString(urls?.spzPath) && !nonEmptyString(urls?.plyPath)) {
    throw new Error('Aholo World 成功记录没有 SPZ 或 PLY，拒绝导入。')
  }
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2))
  const projectId = requiredText(args, 'project-id')
  const apiKey = (process.env.AHOLO_API_KEY || process.env.AHOLO_API_TOKEN || '').trim()
  if (!apiKey) throw new Error('AHOLO_API_KEY 未配置。')
  const base = new URL(process.env.AHOLO_API_BASE_URL || DEFAULT_API_BASE)
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('AHOLO_API_BASE_URL 必须是无凭证、query 和 fragment 的 HTTPS 地址。')
  }

  const worldId = typeof args['world-id'] === 'string'
    ? requiredText(args, 'world-id')
    : await latestSucceededWorldId(base, apiKey)
  await assertWorldSucceeded(base, apiKey, worldId)
  const fingerprint = shortHash(worldId)

  await connectDB()
  const conversation = await Conversation.findOne({ conversation_id: projectId })
    .select('conversation_id user_id').lean<{ conversation_id: string; user_id: string }>()
  if (!conversation) throw new Error('project-id 对应的 Conversation 不存在。')

  const runId = `aholo_web_import_${fingerprint}`
  const toolUseId = 'import_world'
  const outputPrefix = `output/spatial/worlds/web-import-${fingerprint}`
  const request = {
    output_path_prefix: outputPrefix,
    provider_options: { import_contract: IMPORT_CONTRACT },
  }
  const jobId = deterministicSpatialJobId({ projectId, runId, toolUseId })
  let job = await getSpatialBuildJob(jobId, {
    projectId,
    userId: conversation.user_id,
  })
  if (job) {
    const sameFrozenImport = job.run_id === runId
      && job.tool_use_id === toolUseId
      && job.conversation_id === conversation.conversation_id
      && job.kind === 'world'
      && job.provider === 'aholo'
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
      kind: 'world',
      provider: 'aholo',
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
      ownerId: `aholo-web-import:${fingerprint}`,
      leaseMs: 15 * 60_000,
    })
    if (!claim) throw new Error('无法取得导入 Job 的 operator lease。')
    const submitting = await markSpatialJobSubmitting(claim)
    const submitted = await recordSpatialJobSubmitted(submitting, {
      externalJobId: worldId,
      providerStatus: 'web-import-succeeded',
    })
    const runtimeConfig = readSpatialRuntimeConfig({
      ...process.env,
      AHOLO_ASSET_HOST_ALLOWLIST: PRODUCTION_ASSET_HOST,
    })
    const processed = await processClaimedSpatialBuildJob(
      submitted,
      createProductionSpatialDependencies(runtimeConfig),
      { providerPollDelayMs: 5_000 },
    )
    job = processed.job
  }

  const authoritative = await getSpatialBuildJob(job.job_id, {
    projectId,
    userId: conversation.user_id,
  })
  if (!authoritative || authoritative.status !== 'published') {
    throw new Error(`World 镜像没有完成（status ${authoritative?.status ?? 'missing'}）。`)
  }
  const world = await resolvePublishedWorldSource(authoritative.job_id, {
    projectId,
    userId: conversation.user_id,
  })
  const sceneIdentity = {
    projectId,
    userId: conversation.user_id,
    runId,
    toolUseId: 'create_scene',
    actorId: 'operator:aholo-web-import',
  }
  const title = typeof args.title === 'string' && args.title.trim()
    ? args.title.trim().slice(0, 160)
    : 'Aholo Web World 联调 Scene'
  const scene = await createSpatialScene({
    identity: sceneIdentity,
    title,
    world,
    commandHash: createHash('sha256').update(JSON.stringify({ title, job_id: authoritative.job_id })).digest('hex'),
  })
  if (scene.status !== 'applied') throw new Error('Scene 创建发生并发冲突。')

  console.log(JSON.stringify({
    state: 'published',
    source: 'aholo_web_world_via_public_api',
    world_fingerprint: fingerprint,
    job_id: authoritative.job_id,
    workspace_paths: authoritative.published_workspace_paths,
    scene_id: scene.scene.scene_id,
    scene_version: scene.revision.version,
    replayed: scene.replayed,
  }, null, 2))
}

main()
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
