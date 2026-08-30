/**
 * Seed the local MongoDB `model_config` collection from `config/llm-registry.json`.
 *
 * Why: in production the registry lives in the isolated Sci-Pegasus MongoDB.
 * On a fresh local DB the collection is empty, so Sci-Pegasus falls back to the
 * JSON file for 60s before each process's first DB refresh — which means local
 * dev and prod can diverge if anyone edits one without the other. Running this
 * script once per local DB populates `model_config` so both environments read
 * from the same source of truth.
 *
 * Idempotent — upserts the single `config_key: 'main'` doc. Safe to re-run.
 *
 * Usage:
 *   npx tsx scripts/seed-model-config.ts
 */

import fs from 'node:fs'
import path from 'node:path'
import mongoose from 'mongoose'
import { requireMongoUri } from './runtime-env'

const MONGODB_URI = requireMongoUri()
const REGISTRY_PATH = path.join(__dirname, '..', 'config', 'llm-registry.json')

// Default RMB pricing for local observability. Production values remain
// operator-managed and are not overwritten by a re-seed.
const DEFAULT_PRICING_BY_ALIAS_RMB: Record<string, Record<string, number>> = {
  main_standard: { input: 18, output: 72 },
  main_pro: { input: 108, output: 540, cache_creation: 135, cache_read: 10.8 },
  main_deepseek: { input: 3.6, output: 14.4 },
  main_glm: { input: 4.32, output: 15.84 },
  main_gpt: { input: 0, output: 0 },
  tool_websearch: { input: 0, output: 0, per_call_cents: 5 },
}

const ModelConfigSchema = new mongoose.Schema(
  { config_key: { type: String, required: true, unique: true, default: 'main' } },
  { collection: 'model_config', strict: false },
)
const ModelConfig = mongoose.models.ModelConfig || mongoose.model('ModelConfig', ModelConfigSchema)

function stripDollarKeys<T>(input: T): T {
  if (Array.isArray(input)) return input.map(stripDollarKeys) as unknown as T
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (k.startsWith('$')) continue
      out[k] = stripDollarKeys(v)
    }
    return out as T
  }
  return input
}

async function main() {
  console.log(`[seed] reading ${REGISTRY_PATH}`)
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8')
  const parsed = stripDollarKeys(JSON.parse(raw)) as {
    aliases: Record<string, Record<string, unknown>>
    toolSelection: Record<string, Record<string, string>>
    defaultMainAlias: Record<string, string>
  }
  if (!parsed.aliases || !parsed.toolSelection || !parsed.defaultMainAlias) {
    throw new Error('Invalid registry JSON: missing aliases / toolSelection / defaultMainAlias')
  }

  // Enrich each alias with default pricing so the admin's cost dashboard works
  // on a fresh seed.
  const enrichedAliases: Record<string, Record<string, unknown>> = {}
  for (const [aliasName, cfg] of Object.entries(parsed.aliases)) {
    const defaultPricing = DEFAULT_PRICING_BY_ALIAS_RMB[aliasName]
    enrichedAliases[aliasName] = {
      ...cfg,
      pricing: cfg.pricing || defaultPricing || { input: 0, output: 0 },
    }
  }

  console.log(`[seed] connecting to ${MONGODB_URI.replace(/\/\/[^@]+@/, '//***@')}`)
  await mongoose.connect(MONGODB_URI)

  const result = await ModelConfig.findOneAndUpdate(
    { config_key: 'main' },
    {
      $set: {
        aliases: enrichedAliases,
        toolSelection: parsed.toolSelection,
        defaultMainAlias: parsed.defaultMainAlias,
        updated_at: new Date(),
        updated_by: 'seed-script',
      },
      // high_cost_aliases_disabled is admin-managed; do not overwrite on re-seed
      $setOnInsert: {
        config_key: 'main',
        created_at: new Date(),
        high_cost_aliases_disabled: [],
      },
    },
    { upsert: true, returnDocument: 'after' },
  ).lean()

  const aliasCount = Object.keys(enrichedAliases).length
  console.log(`[seed] OK — ${aliasCount} aliases written to model_config (config_key=main)`)
  console.log(`[seed] doc _id: ${(result as { _id: unknown })._id}`)

  await mongoose.disconnect()
}

main().catch(err => {
  console.error('[seed] failed:', err)
  process.exit(1)
})
