import mongoose from 'mongoose'
import { connectDB } from '../lib/db/mongodb'
import { ModelConfig } from '../lib/db/model-config-models'

const DEFAULTS = {
  contextWindow: 200_000,
  maxOutputTokens: 32_768,
  compactionMaxOutputTokens: 8_000,
  promptCacheTtl: '5m' as const,
}

async function main(): Promise<void> {
  await connectDB()
  const doc = await ModelConfig.findOne({ config_key: 'main' }).lean()
  if (!doc) {
    console.log('[backfill] model_config/main not found; nothing changed')
    return
  }

  const aliases = { ...((doc as unknown as { aliases?: Record<string, Record<string, unknown>> }).aliases ?? {}) }
  let changed = 0

  for (const [alias, raw] of Object.entries(aliases)) {
    if (!alias.startsWith('main_')) continue
    const next = { ...raw }
    let aliasChanged = false
    for (const [key, value] of Object.entries(DEFAULTS)) {
      if (next[key] !== undefined && next[key] !== null) continue
      next[key] = value
      aliasChanged = true
    }
    if (aliasChanged) {
      aliases[alias] = next
      changed += 1
    }
  }

  if (changed === 0) {
    console.log('[backfill] all main aliases already have explicit W/O/R/TTL; nothing changed')
    return
  }

  await ModelConfig.updateOne(
    { config_key: 'main' },
    { $set: { aliases, updated_at: new Date() } },
  )
  console.log(`[backfill] updated ${changed} main alias(es); existing explicit values were preserved`)
}

main()
  .catch(error => {
    console.error('[backfill] failed:', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await mongoose.disconnect()
  })
