import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { runStartupChecks } from '../lib/startup-checks'
import { loadProjectEnv } from './load-project-env'

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const APP_PORT = 3200
const APP_URL = `http://127.0.0.1:${APP_PORT}`
const PID_FILE = join(tmpdir(), 'pegasus-spatial-local.pid')
const LOG_FILE = join(tmpdir(), 'pegasus-spatial-local.log')
const NEXT_BIN = join(PROJECT_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next')
const JITI_BIN = join(PROJECT_ROOT, 'node_modules', 'jiti', 'lib', 'jiti-cli.mjs')
const EXPECTED_MONGO_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

type AppProbe = 'offline' | 'pegasus-spatial' | 'occupied'

interface ManagedPid {
  pid: number
  projectRoot: string
  port: number
  startedAt: string
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

function commandFailure(command: string, result: ReturnType<typeof spawnSync>): Error {
  const detail = String(result.stderr || result.stdout || result.error?.message || '').trim()
  return new Error(`${command} 失败${detail ? `：${detail}` : ''}`)
}

function docker(args: string[], options: { quiet?: boolean } = {}): string {
  const result = spawnSync('docker', args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    stdio: options.quiet ? 'pipe' : ['ignore', 'inherit', 'inherit'],
  })
  if (result.status !== 0) throw commandFailure(`docker ${args.join(' ')}`, result)
  return typeof result.stdout === 'string' ? result.stdout.trim() : ''
}

export function assertDockerAvailable(): void {
  const engine = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if ((engine.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    throw new Error('未找到 Docker CLI；请先安装并启动 Docker Desktop 或 Docker Engine。')
  }
  if (engine.status !== 0) {
    throw new Error('无法连接 Docker Engine；请确认 Docker 已启动且当前用户有访问权限。')
  }
  const compose = spawnSync('docker', ['compose', 'version'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (compose.status !== 0) {
    throw new Error('未检测到 Docker Compose v2；请安装 docker compose 插件。')
  }
}

function mongoDatabaseName(uri: string): string {
  const parsed = new URL(uri)
  return parsed.pathname.replace(/^\//, '').split('?')[0] ?? ''
}

/**
 * Local deployment safety boundary. It deliberately refuses remote Mongo before
 * Docker or Next.js is started. Provider submission is controlled by the
 * configured credentials and durable task contracts, not a global flag.
 */
export function assertSafeLocalEnvironment(options: { allowE2eDatabase?: boolean } = {}): void {
  loadProjectEnv()
  const mongoUri = process.env.MONGODB_URI?.trim()
  if (!mongoUri) throw new Error('缺少 MONGODB_URI；请先完成 .env.local。')
  let parsed: URL
  try {
    parsed = new URL(mongoUri)
  } catch {
    throw new Error('MONGODB_URI 不是有效的 MongoDB URL。')
  }
  const database = mongoDatabaseName(mongoUri)
  const validDatabase = database === 'pegasus_spatial'
    || (options.allowE2eDatabase === true && /^pegasus_spatial_e2e_[a-f0-9]+$/.test(database))
  if (
    parsed.protocol !== 'mongodb:'
    || !EXPECTED_MONGO_HOSTS.has(parsed.hostname)
    || (parsed.port || '27017') !== '27019'
    || !validDatabase
  ) {
    throw new Error(
      '本地部署只允许 127.0.0.1:27019 上的 pegasus_spatial 数据库；拒绝连接远程或其他数据库。',
    )
  }

  // Reuse the same fail-closed validation as the real application. It reports
  // variable names and reasons only; secret values are never printed.
  runStartupChecks()
}

export async function ensureLocalMongo(): Promise<void> {
  assertDockerAvailable()
  docker(['compose', 'up', '-d', 'mongo'])
  const deadline = Date.now() + 70_000
  while (Date.now() < deadline) {
    const containerId = docker(['compose', 'ps', '-q', 'mongo'], { quiet: true })
    if (containerId) {
      const health = docker(
        ['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', containerId],
        { quiet: true },
      )
      if (health === 'healthy') return
      if (health === 'unhealthy' || health === 'exited' || health === 'dead') {
        throw new Error(`Mongo 容器状态异常：${health}`)
      }
    }
    await sleep(1_000)
  }
  throw new Error('等待本地 Mongo 健康检查超时。')
}

async function probeApp(): Promise<AppProbe> {
  try {
    const response = await fetch(`${APP_URL}/`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(1_500),
    })
    const text = await response.text()
    if (response.status === 200 && text.includes('Pegasus Spatial')) return 'pegasus-spatial'
    return 'occupied'
  } catch {
    return 'offline'
  }
}

function readManagedPid(): ManagedPid | null {
  if (!existsSync(PID_FILE)) return null
  try {
    const value = JSON.parse(readFileSync(PID_FILE, 'utf8')) as Partial<ManagedPid>
    if (
      Number.isSafeInteger(value.pid)
      && (value.pid ?? 0) > 1
      && value.projectRoot === PROJECT_ROOT
      && value.port === APP_PORT
      && typeof value.startedAt === 'string'
    ) return value as ManagedPid
  } catch {
    // Invalid/stale state is handled as unowned below.
  }
  return null
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function isOwnedNextProcess(pid: number): boolean {
  if (!isProcessAlive(pid)) return false
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const command = typeof result.stdout === 'string' ? result.stdout.trim() : ''
  return result.status === 0
    && command.includes(NEXT_BIN)
    && command.includes('dev')
    && command.includes(String(APP_PORT))
}

function removePidFile(): void {
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE)
}

function logTail(maxLines = 24): string {
  if (!existsSync(LOG_FILE)) return ''
  return readFileSync(LOG_FILE, 'utf8').split('\n').slice(-maxLines).join('\n').trim()
}

export async function startManagedLocalApp(
  childEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<{ started: boolean }> {
  const current = await probeApp()
  if (current === 'pegasus-spatial') {
    throw new Error(
      `端口 ${APP_PORT} 已有 Pegasus Spatial。为避免复用错误数据库或残留 E2E 进程，拒绝接管；请先运行 npm run local:down。`,
    )
  }
  if (current === 'occupied') {
    throw new Error(`端口 ${APP_PORT} 已被其他服务占用；拒绝覆盖或终止未知进程。`)
  }
  if (!existsSync(NEXT_BIN)) {
    throw new Error('缺少 node_modules；请先运行 npm install。')
  }

  const stale = readManagedPid()
  if (stale && isOwnedNextProcess(stale.pid)) {
    throw new Error('检测到受管 Next 进程仍在运行，但页面未就绪；请先运行 npm run local:down。')
  }
  removePidFile()

  const logFd = openSync(LOG_FILE, 'a', 0o600)
  const child = spawn(process.execPath, [NEXT_BIN, 'dev', '-H', '127.0.0.1', '-p', String(APP_PORT)], {
    cwd: PROJECT_ROOT,
    detached: true,
    env: {
      ...childEnvironment,
      PORT: String(APP_PORT),
      APP_PUBLIC_URL: `http://localhost:${APP_PORT}`,
      AGENT_RUNTIME_INTERNAL_BASE_URL: `http://127.0.0.1:${APP_PORT}`,
    },
    stdio: ['ignore', logFd, logFd],
  })
  closeSync(logFd)
  child.unref()
  if (!child.pid) throw new Error('无法取得 Next.js 本地进程 PID。')
  writeFileSync(PID_FILE, JSON.stringify({
    pid: child.pid,
    projectRoot: PROJECT_ROOT,
    port: APP_PORT,
    startedAt: new Date().toISOString(),
  } satisfies ManagedPid), { mode: 0o600 })

  const deadline = Date.now() + 70_000
  while (Date.now() < deadline) {
    if (!isProcessAlive(child.pid)) {
      removePidFile()
      throw new Error(`Next.js 本地服务提前退出。\n${logTail()}`.trim())
    }
    const probe = await probeApp()
    if (probe === 'pegasus-spatial') return { started: true }
    if (probe === 'occupied') {
      await stopManagedLocalApp()
      throw new Error(`端口 ${APP_PORT} 返回了非 Pegasus Spatial 页面。`)
    }
    await sleep(500)
  }
  await stopManagedLocalApp()
  throw new Error(`等待 Pegasus Spatial 页面就绪超时。\n${logTail()}`.trim())
}

export async function stopManagedLocalApp(): Promise<boolean> {
  const managed = readManagedPid()
  if (!managed) {
    removePidFile()
    return false
  }
  if (!isProcessAlive(managed.pid)) {
    removePidFile()
    return false
  }
  if (!isOwnedNextProcess(managed.pid)) {
    removePidFile()
    throw new Error('PID 已被其他进程复用；为避免误杀，未发送终止信号。')
  }

  process.kill(-managed.pid, 'SIGTERM')
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && isProcessAlive(managed.pid)) await sleep(250)
  if (isProcessAlive(managed.pid)) {
    throw new Error('Next.js 本地进程未在 15 秒内退出；未强制终止。')
  }
  removePidFile()
  return true
}

async function localStatus(): Promise<number> {
  loadProjectEnv()
  const configurationCheck = spawnSync(
    process.execPath,
    [JITI_BIN, 'scripts/check-demo-configuration.ts'],
    {
      cwd: PROJECT_ROOT,
      env: process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const configuration = configurationCheck.status === 0
    ? 'ready · local configuration valid'
    : 'blocked · 运行 npm run local:up 查看缺失或无效配置'

  let mongo = 'unavailable'
  try {
    assertDockerAvailable()
    const containerId = docker(['compose', 'ps', '-q', 'mongo'], { quiet: true })
    mongo = containerId
      ? docker(
          ['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', containerId],
          { quiet: true },
        )
      : 'stopped'
  } catch {
    mongo = 'docker unavailable'
  }
  const app = await probeApp()
  console.log(`configuration: ${configuration}`)
  console.log(`mongo: ${mongo}`)
  console.log('access: direct · fixed local identity · loopback only')
  console.log(`web: ${app === 'pegasus-spatial' ? `ready · ${APP_URL}` : app}`)
  console.log('data: local Docker volume preserved')
  return configuration.startsWith('ready')
    && mongo === 'healthy'
    && app === 'pegasus-spatial'
    ? 0
    : 1
}

async function main(): Promise<void> {
  const action = process.argv[2]
  if (!['up', 'status', 'down'].includes(action ?? '')) {
    throw new Error('Usage: npm run local:up | npm run local:status | npm run local:down')
  }

  if (action === 'up') {
    assertSafeLocalEnvironment()
    await ensureLocalMongo()
    await startManagedLocalApp()
    console.log(`Pegasus Spatial 本地环境已启动：http://localhost:${APP_PORT}`)
    console.log(`状态检查：npm run local:status`)
    console.log(`安全停止：npm run local:down（不会删除 Mongo volume）`)
    console.log(`服务日志：${LOG_FILE}`)
    return
  }

  if (action === 'status') {
    process.exitCode = await localStatus()
    return
  }

  const app = await probeApp()
  const managed = readManagedPid()
  if (app === 'pegasus-spatial' && (!managed || !isOwnedNextProcess(managed.pid))) {
    throw new Error('检测到非本脚本管理的 Pegasus Spatial 进程；请先手动停止它，Mongo 保持运行。')
  }
  const stopped = await stopManagedLocalApp()
  docker(['compose', 'stop', 'mongo'])
  console.log(`Web：${stopped ? '已停止' : '未运行'}`)
  console.log('Mongo：已停止；容器与 pegasus-spatial 数据卷完整保留。')
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    console.error(`[local] ${(error as Error).message}`)
    process.exitCode = 1
  })
}
