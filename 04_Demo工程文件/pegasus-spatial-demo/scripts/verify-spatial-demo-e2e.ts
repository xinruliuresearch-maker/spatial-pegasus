import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import mongoose from 'mongoose'
import {
  assertSafeLocalEnvironment,
  ensureLocalMongo,
  startManagedLocalApp,
  stopManagedLocalApp,
} from './demo-local'
import { loadProjectEnv } from './load-project-env'
import { seedSpatialUiFixture } from './spatial-ui-fixture'
import { connectDB } from '../lib/db/mongodb'

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const BASE_URL = 'http://localhost:3200'

function e2eMongoUri(source: string, database: string): string {
  const parsed = new URL(source)
  parsed.pathname = `/${database}`
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString()
}

function runBrowserPhase(input: {
  phase: 'before-restart' | 'after-restart'
  conversationId: string
  conversationTitle: string
  jobId: string
  suffix: string
}): void {
  const args = [
    'scripts/verify-spatial-ui-smoke.py',
    '--base-url', BASE_URL,
    '--phase', input.phase,
    '--fixture-conversation-id', input.conversationId,
    '--fixture-title', input.conversationTitle,
    '--fixture-job-id', input.jobId,
    '--screenshot', resolve(tmpdir(), `pegasus-spatial-e2e-${input.phase}-${input.suffix}.png`),
  ]
  const result = spawnSync('python3', args, {
    cwd: PROJECT_ROOT,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    throw new Error(`零费用浏览器 E2E 阶段失败：${input.phase}`)
  }
}

async function main(): Promise<void> {
  loadProjectEnv()
  const sourceMongoUri = process.env.MONGODB_URI?.trim()
  if (!sourceMongoUri) throw new Error('MONGODB_URI is required.')
  const suffix = randomBytes(6).toString('hex')
  const database = `pegasus_spatial_e2e_${suffix}`
  const mongoUri = e2eMongoUri(sourceMongoUri, database)
  process.env.MONGODB_URI = mongoUri
  assertSafeLocalEnvironment({ allowE2eDatabase: true })
  await ensureLocalMongo()

  let ownsApp = false
  let databaseCreated = false
  try {
    await connectDB()
    databaseCreated = true
    const fixture = await seedSpatialUiFixture({ suffix })

    const firstStart = await startManagedLocalApp(process.env)
    if (!firstStart.started) {
      throw new Error('端口 3200 已有 Pegasus Spatial；请先停止现有服务再运行重启 E2E。')
    }
    ownsApp = true

    // Even a healthy Pegasus page can belong to a stale E2E process pointed at
    // another database. Judge startup must never reuse any existing listener.
    let refusedExistingPort = false
    try {
      await startManagedLocalApp(process.env)
    } catch (error) {
      refusedExistingPort = /拒绝接管/.test((error as Error).message)
    }
    if (!refusedExistingPort) {
      throw new Error('本地启动器未拒绝复用已有的 3200 端口。')
    }

    runBrowserPhase({
      phase: 'before-restart',
      ...fixture,
      suffix,
    })

    await stopManagedLocalApp()
    ownsApp = false

    const secondStart = await startManagedLocalApp(process.env)
    if (!secondStart.started) throw new Error('E2E 无法取得重启后的本地进程。')
    ownsApp = true
    runBrowserPhase({
      phase: 'after-restart',
      ...fixture,
      suffix,
    })

    console.log('spatial-local-e2e passed: direct local access, owner fence, refresh, Job card/API, process restart recovery')
    console.log('provider calls: 0 (terminal fixture records only)')
  } finally {
    if (ownsApp) await stopManagedLocalApp().catch(() => undefined)
    if (databaseCreated) {
      const databaseHandle = mongoose.connection.db
      const activeDatabase = databaseHandle?.databaseName
      if (
        !databaseHandle
        || activeDatabase !== database
        || !/^pegasus_spatial_e2e_[a-f0-9]+$/.test(activeDatabase)
      ) {
        throw new Error('拒绝清理：当前 Mongo 连接不是本轮隔离 E2E 数据库。')
      }
      await databaseHandle.dropDatabase()
    }
    await mongoose.disconnect()
  }
}

main().catch(error => {
  console.error(`[spatial-local-e2e] ${(error as Error).message}`)
  process.exitCode = 1
})
