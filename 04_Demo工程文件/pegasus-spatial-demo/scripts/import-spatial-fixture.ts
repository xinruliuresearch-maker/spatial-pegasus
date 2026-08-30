import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { extname, relative, resolve, sep } from 'node:path'
import mongoose from 'mongoose'
import { Conversation } from '../lib/db/models'
import { connectDB } from '../lib/db/mongodb'
import { toRasterAssetRef } from '../lib/media/reference'
import { writeImageAsset } from '../lib/media/storage'
import { createScenePublicationWorkspace } from '../lib/spatial/scene-workspace'
import { assertWorkspaceWritePath } from '../lib/workspace/path-policy'

const MAX_FIXTURE_BYTES = 20 * 1024 * 1024
const FIXTURE_ROOT = resolve(process.cwd(), 'fixtures/spatial')
const OUTPUT_PREFIX = 'output/spatial/images/'

type Arguments = Record<string, string>

function parseArguments(argv: readonly string[]): Arguments {
  const result: Arguments = {}
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value || value.startsWith('--')) {
      throw new TypeError(`参数必须使用 --name value：${name ?? '(missing)'}`)
    }
    const key = name.slice(2)
    if (!key || key in result) throw new TypeError(`重复或无效参数：${name}`)
    result[key] = value
    index += 1
  }
  const allowed = new Set(['project-id', 'source-file', 'workspace-path'])
  const unknown = Object.keys(result).filter(key => !allowed.has(key))
  if (unknown.length > 0) throw new TypeError(`未知参数：${unknown.map(key => `--${key}`).join(', ')}`)
  return result
}

function required(args: Arguments, name: string): string {
  const value = args[name]?.trim()
  if (!value) throw new TypeError(`--${name} 需要非空值。`)
  return value
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

async function assertFixtureSource(sourceFile: string): Promise<{ absolute: string; display: string }> {
  const [root, absolute] = await Promise.all([
    realpath(FIXTURE_ROOT),
    realpath(resolve(process.cwd(), sourceFile)),
  ])
  const withinRoot = absolute === root || absolute.startsWith(`${root}${sep}`)
  if (!withinRoot) throw new Error('source-file 必须位于仓库的 fixtures/spatial/ 目录内。')
  const extension = extname(absolute).toLowerCase()
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) {
    throw new Error('测试图片只支持 PNG、JPEG 或 WebP。')
  }
  return { absolute, display: relative(process.cwd(), absolute) }
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2))
  const projectId = required(args, 'project-id')
  const source = await assertFixtureSource(required(args, 'source-file'))
  const workspacePath = assertWorkspaceWritePath(required(args, 'workspace-path'))
  if (!workspacePath.startsWith(OUTPUT_PREFIX)) {
    throw new Error(`workspace-path 必须位于 ${OUTPUT_PREFIX} 下。`)
  }

  const buffer = await readFile(source.absolute)
  if (buffer.length === 0 || buffer.length > MAX_FIXTURE_BYTES) {
    throw new Error(`测试图片必须为 1-${MAX_FIXTURE_BYTES} bytes。`)
  }
  const sourceSha = sha256(buffer)

  await connectDB()
  const conversation = await Conversation.findOne({ conversation_id: projectId })
  if (!conversation) throw new Error('project-id 对应的 Conversation 不存在。')

  const workspace = await createScenePublicationWorkspace({
    conversationId: projectId,
    userId: conversation.user_id,
  })
  const existing = await workspace.readRasterBuffer(workspacePath, 'original')
  if (existing) {
    if (sha256(existing) !== sourceSha) {
      throw new Error('目标 Workspace 路径已存在不同内容；请使用新的测试路径。')
    }
    console.log(JSON.stringify({
      state: 'already_present',
      project_id: projectId,
      source_file: source.display,
      workspace_path: workspacePath,
      sha256: sourceSha,
      size_bytes: buffer.length,
    }, null, 2))
    return
  }

  const stored = await writeImageAsset({
    ownerUserId: conversation.user_id,
    conversationId: projectId,
    buffer,
    source: 'user_upload',
  })
  await workspace.writeRaster(
    workspacePath,
    toRasterAssetRef(stored),
    'Aholo World 单图真实测试参考图',
    { archive: false },
  )
  const published = await workspace.readRasterBuffer(workspacePath, 'original')
  if (!published || sha256(published) !== sourceSha) {
    throw new Error('Workspace 发布后的图片校验失败。')
  }

  console.log(JSON.stringify({
    state: 'published',
    project_id: projectId,
    source_file: source.display,
    workspace_path: workspacePath,
    asset_id: stored.assetId,
    sha256: stored.sha256,
    size_bytes: stored.variants.original.sizeBytes,
    width: stored.variants.original.width,
    height: stored.variants.original.height,
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
