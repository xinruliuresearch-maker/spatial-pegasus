// ============================================================
// Model Pricing — cost estimation for API call logging
//
// Source of truth lives in `model_config.aliases.<name>.pricing` (single
// document managed by the deployment operator). This module reads from there with a
// 60s stale-while-revalidate cache, falling back to the hardcoded
// `DEFAULT_PRICING_RMB` table when:
//   - admin hasn't populated the aliases collection yet (cold start)
//   - Mongo blip during the read
//   - the model name returned by the gateway doesn't have a matching alias yet
//
// Unit:
//   - All token prices are RMB ¥ per 1,000,000 tokens
//   - per_call_cents is RMB 分 (1 cent = 1/100 ¥) charged once per request
//   - estimateCostCents() returns RMB 分, matching `api_call_logs.estimated_cost_cents`
//
// Why RMB not USD: the configured deployment bills in CNY, and the cost
// dashboard displays ¥. The previous USD-cents-relabeled-as-¥ scheme was
// off by ~7x. We give up vendor list-price fidelity in exchange for the
// admin number actually being the right currency without per-display
// conversion.
// ============================================================

import { connectDB } from '../db/mongodb'
import { ModelConfig } from '../db/model-config-models'

export interface AliasPricingRMB {
  input: number             // ¥ / 1M tokens (non-cached input)
  output: number            // ¥ / 1M tokens
  cache_creation?: number   // ¥ / 1M tokens (Anthropic only; ~1.25x input)
  cache_read?: number       // ¥ / 1M tokens (Anthropic only; ~0.1x input)
  per_call_cents?: number   // ¥ 分 / call (for services such as web search)
}

// Fallback when the DB has no entry for the model. Numbers below are
// vendor list prices in USD × 7.2 (rough RMB approximation), which is
// good enough for the dashboard's rough-cost purpose. Operators can edit
// model_config to match actual gateway pricing.
const DEFAULT_PRICING_RMB: Record<string, AliasPricingRMB> = {
  // ─── Main orchestrator ───
  'Claude-opus-4.6':   { input: 108,   output: 540,  cache_creation: 135,   cache_read: 10.8 },
  'Claude-sonnet-4.6': { input: 21.6,  output: 108,  cache_creation: 27,    cache_read: 2.16 },
  'Claude-haiku-4.5':  { input: 5.76,  output: 28.8, cache_creation: 7.2,   cache_read: 0.576 },

  'Gemini-3.1-pro':    { input: 18,    output: 72 },
  'Gemini-3-pro':      { input: 9,     output: 72 },
  'Gemini-3-flash':    { input: 2.16,  output: 8.64 },

  'deepseek-v4-pro':   { input: 3.6,   output: 14.4 },

  // 智谱 GLM 5.1 — 占位估算
  'GLM5.1':            { input: 4.32,  output: 15.84 },

  // Tool-service per-call pricing can be supplied through model_config.
}

const CACHE_TTL_MS = 60_000

interface PricingCache {
  byRealModel: Map<string, AliasPricingRMB>
  loadedAt: number
  source: 'fallback' | 'db'
}

let cache: PricingCache | null = null
let inflightRefresh: Promise<void> | null = null

async function refreshFromDB(): Promise<void> {
  try {
    await connectDB()
    const doc = await ModelConfig.findOne({ config_key: 'main' }).lean()
    const aliases = (doc as { aliases?: Record<string, { realModel?: string; pricing?: AliasPricingRMB }> })?.aliases

    if (!aliases || Object.keys(aliases).length === 0) {
      // No data yet — keep whatever cache exists (probably the fallback
      // seed from ensureSeed). Bump loadedAt so we don't hammer mongo.
      if (cache) cache.loadedAt = Date.now()
      return
    }

    const byRealModel = new Map<string, AliasPricingRMB>()
    // First seed with hardcoded defaults so unknown realModels still resolve.
    for (const [model, p] of Object.entries(DEFAULT_PRICING_RMB)) {
      byRealModel.set(model, p)
    }
    // Then overlay DB values so admin edits win.
    for (const cfg of Object.values(aliases)) {
      if (cfg?.realModel && cfg?.pricing) {
        byRealModel.set(cfg.realModel, cfg.pricing)
      }
    }

    cache = { byRealModel, loadedAt: Date.now(), source: 'db' }
  } catch (err) {
    console.warn('[pricing] DB refresh failed, keeping cache:', err)
    if (cache) cache.loadedAt = Date.now()
  }
}

function ensureSeed(): PricingCache {
  if (cache) return cache
  const byRealModel = new Map<string, AliasPricingRMB>()
  for (const [model, p] of Object.entries(DEFAULT_PRICING_RMB)) {
    byRealModel.set(model, p)
  }
  // loadedAt=0 forces an immediate background refresh on the next call,
  // matching llm-registry.ts's stale-while-revalidate pattern.
  cache = { byRealModel, loadedAt: 0, source: 'fallback' }
  return cache
}

function loadPricing(): Map<string, AliasPricingRMB> {
  const c = ensureSeed()
  if (Date.now() - c.loadedAt >= CACHE_TTL_MS && !inflightRefresh) {
    inflightRefresh = refreshFromDB().finally(() => {
      inflightRefresh = null
    })
  }
  return c.byRealModel
}

/**
 * Estimate cost in RMB 分 (cents) for a single API call.
 *
 * Per-call tier (for example web search):
 *   if pricing.per_call_cents > 0, return that flat fee — token counts
 *   are ignored when the configured gateway bills these services per request.
 *
 * Token tier (Claude / Gemini / DeepSeek / GLM):
 *   sum of (input + output + cache_creation + cache_read) priced
 *   per-million-tokens, rounded to integer 分.
 *
 * Cross-model compatibility:
 *   - Anthropic: input_tokens excludes cache; cache fields paid separately.
 *   - Other models: input_tokens covers all input, cache fields are 0.
 *   The formula naturally handles both shapes.
 */
export function estimateCostCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
): number {
  const byRealModel = loadPricing()
  const pricing = byRealModel.get(model)
  if (!pricing) return 0

  if (pricing.per_call_cents && pricing.per_call_cents > 0) {
    return Math.round(pricing.per_call_cents)
  }

  const inputCost = (inputTokens / 1_000_000) * pricing.input
  const outputCost = (outputTokens / 1_000_000) * pricing.output
  const cacheCreateCost =
    (cacheCreationTokens / 1_000_000) * (pricing.cache_creation ?? 0)
  const cacheReadCost =
    (cacheReadTokens / 1_000_000) * (pricing.cache_read ?? 0)

  const totalRMB = inputCost + outputCost + cacheCreateCost + cacheReadCost
  return Math.round(totalRMB * 100)
}
