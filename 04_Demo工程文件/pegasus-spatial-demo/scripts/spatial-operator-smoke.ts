import mongoose from 'mongoose'
import {
  dryRunOperatorSmoke,
  prepareOperatorSmoke,
  reconcileUnknownOperatorSmoke,
  resumeOperatorSmoke,
  statusOperatorSmoke,
  submitOperatorSmoke,
} from '../lib/spatial/operator-smoke-runner'
import { sanitizeSpatialRuntimeError } from '../lib/spatial/runtime'
import { operatorSmokeCliHelp } from '../lib/spatial/operator-smoke'
import type { SpatialOperatorSmokeProvider } from '../lib/spatial/types'

type Arguments = Record<string, string | boolean>

function parseArguments(argv: readonly string[]): Arguments {
  const result: Arguments = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) throw new TypeError(`不支持的位置参数：${item}`)
    const name = item.slice(2)
    if (!name || name in result) throw new TypeError(`重复或无效参数：${item}`)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) result[name] = true
    else {
      result[name] = next
      index += 1
    }
  }
  return result
}

function stringArg(args: Arguments, name: string, required = false): string | undefined {
  const value = args[name]
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`--${name} 需要非空值。`)
  return value.trim()
}

function flag(args: Arguments, name: string): boolean {
  const value = args[name]
  if (value === undefined) return false
  if (value !== true) throw new TypeError(`--${name} 是不带值的操作标志。`)
  return true
}

function providerArg(args: Arguments): SpatialOperatorSmokeProvider {
  const value = stringArg(args, 'provider', true)
  if (!['aholo', 'lux3d', 'image'].includes(value!)) {
    throw new TypeError('--provider 必须是 aholo、lux3d 或 image。')
  }
  return value as SpatialOperatorSmokeProvider
}

function imageMode(args: Arguments): 'text' | 'edit' | undefined {
  const value = stringArg(args, 'mode')
  if (value === undefined) return undefined
  if (value !== 'text' && value !== 'edit') throw new TypeError('--mode 必须是 text 或 edit。')
  return value
}

function rejectUnknownArguments(args: Arguments): void {
  const known = new Set([
    'provider',
    'help',
    'dry-run',
    'prepare',
    'submit',
    'status',
    'resume',
    'reconcile-unknown',
    'smoke-id',
    'confirm',
    'project-id',
    'phase',
    'purpose',
    'prompt',
    'input-path',
    'output-path',
    'mode',
    'aspect-ratio',
    'actor',
    'reason',
  ])
  const unknown = Object.keys(args).filter(name => !known.has(name))
  if (unknown.length > 0) throw new TypeError(`未知参数：${unknown.map(name => `--${name}`).join(', ')}`)
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2))
  rejectUnknownArguments(args)
  if (flag(args, 'help')) {
    const extras = Object.keys(args).filter(name => name !== 'help' && name !== 'provider')
    if (extras.length > 0) throw new TypeError('--help 只能与脚本预置的 --provider 一起使用。')
    console.log(operatorSmokeCliHelp())
    return
  }
  const provider = providerArg(args)
  const actions = ['dry-run', 'prepare', 'submit', 'status', 'resume', 'reconcile-unknown']
    .filter(name => flag(args, name))
  if (actions.length !== 1) {
    throw new TypeError(
      '必须且只能选择 --dry-run、--prepare、--submit、--status、--resume、--reconcile-unknown 之一。',
    )
  }
  const action = actions[0]
  let report
  if (action === 'dry-run') {
    report = await dryRunOperatorSmoke({
      provider,
      projectId: stringArg(args, 'project-id') || '',
      prompt: stringArg(args, 'prompt'),
      inputPath: stringArg(args, 'input-path'),
      outputPath: stringArg(args, 'output-path'),
      imageMode: imageMode(args),
      aspectRatio: stringArg(args, 'aspect-ratio'),
      phase: stringArg(args, 'phase'),
      purpose: stringArg(args, 'purpose'),
    })
  } else if (action === 'prepare') {
    report = await prepareOperatorSmoke({
      provider,
      projectId: stringArg(args, 'project-id', true)!,
      phase: stringArg(args, 'phase', true)!,
      purpose: stringArg(args, 'purpose', true)!,
      prompt: stringArg(args, 'prompt'),
      inputPath: stringArg(args, 'input-path'),
      outputPath: stringArg(args, 'output-path'),
      imageMode: imageMode(args),
      aspectRatio: stringArg(args, 'aspect-ratio'),
    })
  } else if (action === 'submit') {
    report = await submitOperatorSmoke(
      stringArg(args, 'smoke-id', true)!,
      stringArg(args, 'confirm', true)!,
    )
  } else if (action === 'status') {
    report = await statusOperatorSmoke(stringArg(args, 'smoke-id', true)!)
  } else if (action === 'reconcile-unknown') {
    report = await reconcileUnknownOperatorSmoke(
      stringArg(args, 'smoke-id', true)!,
      {
        confirmation: stringArg(args, 'confirm', true)!,
        actor: stringArg(args, 'actor', true)!,
        reason: stringArg(args, 'reason', true)!,
      },
    )
  } else {
    report = await resumeOperatorSmoke(stringArg(args, 'smoke-id', true)!)
  }
  if (report.provider !== provider) {
    throw new Error(`smoke-id 属于 ${report.provider}，拒绝通过 ${provider} 命令操作。`)
  }
  console.log(JSON.stringify(report, null, 2))
}

main()
  .catch(error => {
    console.error(JSON.stringify({
      state: 'failed_closed',
      error: sanitizeSpatialRuntimeError(error),
      supplier_submissions: process.argv.includes('--dry-run') ? 0 : 'inspect_durable_status',
    }, null, 2))
    process.exitCode = 1
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect()
  })
