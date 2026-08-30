/**
 * Model alias registry — the single abstraction layer between user-facing
 * model choices / tool internal model selection and real gateway model
 * IDs + API keys.
 *
 * Source of truth lives in the `model_config` Mongo collection (single doc,
 * `config_key='main'`), managed by the deployment operator. The on-disk
 * `config/llm-registry.json` is a **fallback / first-launch seed**:
 *  - first call after process start synchronously reads the JSON so all
 *    consumers (which are sync) always have data
 *  - a stale-while-revalidate background task swaps the cache for the DB
 *    document on a 60s TTL
 *  - if the DB read fails (network, mongo restart) we keep the existing
 *    cache and try again next tick — never wedge sync callers on async I/O
 *
 * The synchronous public API is preserved deliberately; rewriting to async
 * would touch every tool / agent caller and provides no business value
 * since the data is small and changes infrequently.
 *
 * Gateway configuration contract: each alias's `realModel` MUST match the
 * exact custom model name configured upstream (case-sensitive,
 * including dots).
 */

import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { LLM_API_KEY_ORCHESTRATOR, LLM_API_KEY_TOOLS } from './llm-config'
import { connectDB } from './db/mongodb'
import { ModelConfig } from './db/model-config-models'

export type UserPlan = 'free' | 'pro' | 'team'

export type KeyChannel = 'orchestrator' | 'tools'

// Aliases are runtime-defined (from DB / JSON), so ModelAlias is just a string.
// Callers that previously relied on literal-union narrowing should treat this
// as an opaque identifier and rely on canUseAlias / resolveAlias for validation.
export type ModelAlias = string

interface AliasConfig {
  realModel: string
  keyChannel: KeyChannel
  availableToPlans?: UserPlan[]
  displayName?: string
  displayDescription?: string
  /** Whether this model can read image content blocks. This field is required
   *  operationally; missing values are treated as false and warned. */
  supportsVision?: boolean
  /** Main model total input+output context capacity W. */
  contextWindow?: number
  /** Main-loop maximum output capability O. Actual requests still tighten dynamically. */
  maxOutputTokens?: number
  /** Compression summary output ceiling R. */
  compactionMaxOutputTokens?: number
  /** Prompt-cache lifetime used by cache-safe context rewriting. */
  promptCacheTtl?: '5m' | '1h' | 'none'
}

export interface ModelCapabilities {
  contextWindow: number
  maxOutputTokens: number
  compactionMaxOutputTokens: number
  promptCacheTtl: '5m' | '1h' | 'none'
  promptCacheTtlMs: number
  usedCompatibilityDefaults: boolean
}

/**
 * Immutable, credential-free model mapping persisted by detached work such as
 * durable compaction. An alias remains useful for policy/audit, while the real
 * model, key channel and capacities prevent a later registry refresh from
 * changing the request that a Job was created to execute.
 */
export interface FrozenModelResolutionSnapshot {
  snapshot_version: 1
  alias: ModelAlias
  real_model: string
  key_channel: KeyChannel
  supports_vision: boolean
  context_window: number
  max_output_tokens: number
  compaction_max_output_tokens: number
  prompt_cache_ttl: '5m' | '1h' | 'none'
  used_compatibility_defaults: boolean
  registry_source: 'db' | 'fs'
  registry_revision: string
  registry_hash: string
  resolved_at: Date
}

/** Validate an untrusted persisted/handoff snapshot without resolving a key. */
export function validateFrozenModelResolutionSnapshot(
  snapshot: FrozenModelResolutionSnapshot,
  expectedAlias = snapshot.alias,
): FrozenModelResolutionSnapshot {
  if (
    snapshot.snapshot_version !== 1
    || snapshot.alias !== expectedAlias
    || !snapshot.real_model?.trim()
    || (snapshot.key_channel !== 'orchestrator' && snapshot.key_channel !== 'tools')
    || !Number.isSafeInteger(snapshot.context_window)
    || snapshot.context_window <= 0
    || !Number.isSafeInteger(snapshot.max_output_tokens)
    || snapshot.max_output_tokens <= 0
    || !Number.isSafeInteger(snapshot.compaction_max_output_tokens)
    || snapshot.compaction_max_output_tokens <= 0
    || snapshot.max_output_tokens >= snapshot.context_window
    || snapshot.compaction_max_output_tokens >= snapshot.context_window
    || !['5m', '1h', 'none'].includes(snapshot.prompt_cache_ttl)
    || !snapshot.registry_revision?.trim()
    || !/^[a-f0-9]{64}$/i.test(snapshot.registry_hash)
  ) {
    throw new Error(`Invalid frozen model resolution snapshot for alias: ${expectedAlias}`)
  }
  return structuredClone(snapshot)
}

const COMPATIBILITY_CAPABILITIES = {
  contextWindow: 200_000,
  maxOutputTokens: 32_768,
  compactionMaxOutputTokens: 8_000,
  promptCacheTtl: '5m' as const,
}
const warnedMissingCapabilities = new Set<string>()

/**
 * Tool-internal model purposes — each tool that needs to call a downstream LLM
 * picks an alias from this fixed set. Sci-Pegasus currently needs a search
 * router and a lightweight memory model; future literature adapters can add
 * new purposes without coupling them to the main-loop model picker.
 */
type ToolPurpose = 'websearch' | 'memory'

interface RegistryFile {
  aliases: Record<string, AliasConfig>
  toolSelection: Record<ToolPurpose, Record<UserPlan, ModelAlias>>
  defaultMainAlias: Record<UserPlan, ModelAlias>
}

// The fallback lives under the project config directory. Keeping the path
// statically scoped prevents Next.js file tracing from bundling the whole repo.
const CONFIG_PATH = path.join(process.cwd(), 'config', 'llm-registry.json')
const CACHE_TTL_MS = 60_000

let cache: { data: RegistryFile; loadedAt: number; source: 'fs' | 'db' } | null = null
let inflightRefresh: Promise<void> | null = null

function readFromFs(): RegistryFile {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
  const parsed = JSON.parse(raw) as RegistryFile
  if (!parsed.aliases || !parsed.toolSelection || !parsed.defaultMainAlias) {
    throw new Error(`Invalid llm-registry.json: missing required top-level keys`)
  }
  return parsed
}

function applyDisabled(reg: RegistryFile, disabled: string[]): RegistryFile {
  if (!disabled.length) return reg
  // Strip disabled aliases from availableToPlans so they disappear from
  // listVisibleMainAliases / canUseAlias output. They stay in `aliases` so
  // resolveAlias still works for already-stored conversation references —
  // emergency disable shouldn't crash existing chats, just hide the model
  // from the picker.
  const next: RegistryFile = {
    aliases: {},
    toolSelection: reg.toolSelection,
    defaultMainAlias: reg.defaultMainAlias,
  }
  const disabledSet = new Set(disabled)
  for (const [key, cfg] of Object.entries(reg.aliases)) {
    next.aliases[key] = disabledSet.has(key) ? { ...cfg, availableToPlans: [] } : cfg
  }
  return next
}

async function refreshFromDB(): Promise<void> {
  try {
    await connectDB()
    const doc = await ModelConfig.findOne({ config_key: 'main' }).lean()

    // Empty DB / first-launch state: admin hasn't populated yet. Keep the
    // file-based cache and just bump loadedAt so we don't hammer Mongo for
    // 60s. Once admin saves once, DB takes over.
    if (!doc || !doc.aliases || Object.keys(doc.aliases as Record<string, unknown>).length === 0) {
      // First detection only — avoid spamming logs every 60s if DB stays empty.
      if (cache?.source === 'fs' && cache.loadedAt === 0) {
        console.warn('[llm-registry] model_config is empty in DB; staying on JSON fallback. Run: npx tsx scripts/seed-model-config.ts')
      }
      if (cache) cache.loadedAt = Date.now()
      return
    }

    const docAny = doc as unknown as {
      aliases: Record<string, AliasConfig>
      toolSelection?: RegistryFile['toolSelection']
      defaultMainAlias?: RegistryFile['defaultMainAlias']
      high_cost_aliases_disabled?: string[]
    }

    const next: RegistryFile = {
      aliases: docAny.aliases,
      toolSelection: docAny.toolSelection ?? {
        websearch: { free: '', pro: '', team: '' },
        memory: { free: '', pro: '', team: '' },
      },
      defaultMainAlias: docAny.defaultMainAlias ?? { free: '', pro: '', team: '' },
    }

    cache = {
      data: applyDisabled(next, docAny.high_cost_aliases_disabled || []),
      loadedAt: Date.now(),
      source: 'db',
    }
  } catch (err) {
    console.warn('[llm-registry] DB refresh failed, keeping existing cache:', err)
    // Bump loadedAt anyway so we don't retry-storm on a sustained outage.
    if (cache) cache.loadedAt = Date.now()
  }
}

function loadRegistry(): RegistryFile {
  // First call: synchronously seed from JSON file so callers always have data.
  // loadedAt=0 forces an immediate background refresh on the next call.
  //
  // DB is the source of truth (admin-managed). The JSON seed
  // is only a cold-start safety net used for ~60s before the first DB refresh
  // completes. If you see this warning persisting, either the DB connection is
  // unreachable or model_config hasn't been populated yet — run
  //   npx tsx scripts/seed-model-config.ts
  // to populate local DB from the JSON.
  if (!cache) {
    console.warn('[llm-registry] cold-start: seeding from JSON; DB refresh follows within 60s')
    cache = { data: readFromFs(), loadedAt: 0, source: 'fs' }
  }

  // Stale-while-revalidate: trigger async refresh when expired, but return
  // existing cached data immediately. Single inflight promise prevents N
  // concurrent reads from each starting a refresh.
  if (Date.now() - cache.loadedAt >= CACHE_TTL_MS && !inflightRefresh) {
    inflightRefresh = refreshFromDB().finally(() => {
      inflightRefresh = null
    })
  }

  return cache.data
}

/**
 * Resolve an alias to { realModel, apiKey }. This is the one and only way
 * application code should obtain a model ID + key pair.
 */
export function resolveAlias(alias: ModelAlias): { model: string; apiKey: string } {
  const cfg = loadRegistry().aliases[alias]
  if (!cfg) throw new Error(`Unknown model alias: ${alias}`)
  const apiKey = resolveApiKeyForChannel(cfg.keyChannel, alias)
  return { model: cfg.realModel, apiKey }
}

/** Resolve only the credential channel frozen in a persisted model snapshot. */
export function resolveApiKeyForChannel(
  keyChannel: KeyChannel,
  alias = 'persisted-model-snapshot',
): string {
  const apiKey = keyChannel === 'orchestrator'
    ? LLM_API_KEY_ORCHESTRATOR
    : LLM_API_KEY_TOOLS
  if (!apiKey) {
    throw new Error(`API key not configured for channel: ${keyChannel} (alias=${alias})`)
  }
  return apiKey
}

function canonicalizeRegistryValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(canonicalizeRegistryValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalizeRegistryValue(entry)]),
  )
}

function registryHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeRegistryValue(value)))
    .digest('hex')
}

/**
 * Await the Mongo source of truth instead of the server's stale-while-
 * revalidate cache. Empty first-launch databases deliberately use the JSON
 * seed; DB connection failures never silently downgrade to the seed.
 * Credentials are neither read nor returned here.
 */
export async function resolveAuthoritativeModelSnapshot(
  alias: ModelAlias,
): Promise<FrozenModelResolutionSnapshot> {
  await connectDB()
  const doc = await ModelConfig.findOne({ config_key: 'main' }).lean()
  const raw = doc as unknown as {
    aliases?: Record<string, AliasConfig>
    toolSelection?: RegistryFile['toolSelection']
    defaultMainAlias?: RegistryFile['defaultMainAlias']
    high_cost_aliases_disabled?: string[]
    updated_at?: Date | string | null
  } | null
  const hasDbRegistry = Boolean(
    raw?.aliases && Object.keys(raw.aliases).length > 0,
  )
  const source: FrozenModelResolutionSnapshot['registry_source'] = hasDbRegistry
    ? 'db'
    : 'fs'
  const registry = hasDbRegistry
    ? {
        aliases: raw!.aliases!,
        toolSelection: raw!.toolSelection ?? {
          websearch: { free: '', pro: '', team: '' },
          memory: { free: '', pro: '', team: '' },
        },
        defaultMainAlias: raw!.defaultMainAlias ?? { free: '', pro: '', team: '' },
      }
    : readFromFs()
  const cfg = registry.aliases[alias]
  if (!cfg) throw new Error(`Unknown model alias in authoritative registry: ${alias}`)
  if (!cfg.realModel?.trim()) {
    throw new Error(`Model alias has no real model mapping: ${alias}`)
  }
  if (cfg.keyChannel !== 'orchestrator' && cfg.keyChannel !== 'tools') {
    throw new Error(`Model alias has an invalid key channel: ${alias}`)
  }
  const usedCompatibilityDefaults =
    cfg.contextWindow === undefined
    || cfg.maxOutputTokens === undefined
    || cfg.compactionMaxOutputTokens === undefined
    || cfg.promptCacheTtl === undefined
  const promptCacheTtl = cfg.promptCacheTtl ?? COMPATIBILITY_CAPABILITIES.promptCacheTtl
  const contextWindow = cfg.contextWindow ?? COMPATIBILITY_CAPABILITIES.contextWindow
  const maxOutputTokens = cfg.maxOutputTokens ?? COMPATIBILITY_CAPABILITIES.maxOutputTokens
  const compactionMaxOutputTokens =
    cfg.compactionMaxOutputTokens
    ?? COMPATIBILITY_CAPABILITIES.compactionMaxOutputTokens
  if (
    !Number.isSafeInteger(contextWindow)
    || contextWindow <= 0
    || !Number.isSafeInteger(maxOutputTokens)
    || maxOutputTokens <= 0
    || !Number.isSafeInteger(compactionMaxOutputTokens)
    || compactionMaxOutputTokens <= 0
    || maxOutputTokens >= contextWindow
    || compactionMaxOutputTokens >= contextWindow
    || !['5m', '1h', 'none'].includes(promptCacheTtl)
  ) {
    throw new Error(`Model alias has invalid capacity metadata: ${alias}`)
  }
  const hash = registryHash({
    aliases: registry.aliases,
    toolSelection: registry.toolSelection,
    defaultMainAlias: registry.defaultMainAlias,
    disabled: source === 'db' ? raw?.high_cost_aliases_disabled ?? [] : [],
  })
  const updatedAt = source === 'db' && raw?.updated_at
    ? new Date(raw.updated_at)
    : null
  return {
    snapshot_version: 1,
    alias,
    real_model: cfg.realModel,
    key_channel: cfg.keyChannel,
    supports_vision: cfg.supportsVision === true,
    context_window: contextWindow,
    max_output_tokens: maxOutputTokens,
    compaction_max_output_tokens: compactionMaxOutputTokens,
    prompt_cache_ttl: promptCacheTtl,
    used_compatibility_defaults: usedCompatibilityDefaults,
    registry_source: source,
    registry_revision: updatedAt && Number.isFinite(updatedAt.getTime())
      ? updatedAt.toISOString()
      : `${source}:${hash}`,
    registry_hash: hash,
    resolved_at: new Date(),
  }
}

/**
 * Resolve capacity/cache metadata used by Hippocampus. Old model_config
 * documents remain readable through explicit compatibility defaults; a
 * warning identifies aliases that still need the idempotent backfill.
 */
export function getAliasCapabilities(alias: ModelAlias): ModelCapabilities {
  const cfg = loadRegistry().aliases[alias]
  if (!cfg) throw new Error(`Unknown model alias: ${alias}`)

  const usedCompatibilityDefaults =
    cfg.contextWindow === undefined ||
    cfg.maxOutputTokens === undefined ||
    cfg.compactionMaxOutputTokens === undefined ||
    cfg.promptCacheTtl === undefined

  if (usedCompatibilityDefaults && !warnedMissingCapabilities.has(alias)) {
    warnedMissingCapabilities.add(alias)
    console.warn(
      `[llm-registry] alias "${alias}" lacks Hippocampus capabilities; ` +
      'using compatibility defaults W=200000 O=32768 R=8000 TTL=5m. ' +
      'Run the model capability backfill to persist explicit values.',
    )
  }

  const promptCacheTtl = cfg.promptCacheTtl ?? COMPATIBILITY_CAPABILITIES.promptCacheTtl
  return {
    contextWindow: cfg.contextWindow ?? COMPATIBILITY_CAPABILITIES.contextWindow,
    maxOutputTokens: cfg.maxOutputTokens ?? COMPATIBILITY_CAPABILITIES.maxOutputTokens,
    compactionMaxOutputTokens:
      cfg.compactionMaxOutputTokens ?? COMPATIBILITY_CAPABILITIES.compactionMaxOutputTokens,
    promptCacheTtl,
    promptCacheTtlMs: promptCacheTtl === '1h'
      ? 60 * 60 * 1_000
      : promptCacheTtl === '5m'
        ? 5 * 60 * 1_000
        : 0,
    usedCompatibilityDefaults,
  }
}

/**
 * Pick the right tool-internal alias for a user + purpose. The mapping lives
 * in `toolSelection`.
 */
export function selectToolAlias(plan: UserPlan, purpose: ToolPurpose): ModelAlias {
  const table = loadRegistry().toolSelection[purpose]
  if (!table) throw new Error(`Unknown purpose: ${purpose}`)
  const alias = table[plan]
  if (!alias) throw new Error(`No tool alias configured for purpose=${purpose} plan=${plan}`)
  return alias
}

export interface VisibleAlias {
  alias: ModelAlias
  displayName: string
  displayDescription: string
  supportsVision: boolean
}

/**
 * Filter the registry to the main-loop aliases visible to this plan. Used by
 * /api/models to populate the chat input model picker.
 *
 * When `options.mask` is true (test-period accounts), returns a single masked
 * entry with displayName "AI 助手" so the picker locks to a single non-revealing
 * option. The actual alias used is `options.forcedAlias` (if it resolves) or
 * the plan default — picked correctly so backend / frontend state agree on
 * which alias is "selected" even though the user can't see it.
 */
export function listVisibleMainAliases(
  plan: UserPlan,
  options?: { mask?: boolean; forcedAlias?: string },
): VisibleAlias[] {
  if (options?.mask) {
    const reg = loadRegistry()
    const alias = options.forcedAlias && reg.aliases[options.forcedAlias]
      ? options.forcedAlias
      : defaultMainAliasFor(plan)
    return [{
      alias,
      displayName: 'AI 助手',
      displayDescription: '',
      supportsVision: aliasSupportsVision(alias),
    }]
  }
  const result: VisibleAlias[] = []
  for (const [key, cfg] of Object.entries(loadRegistry().aliases)) {
    // Main-loop picker only — internal tool aliases must not leak into the
    // user-facing chat model selector.
    if (!key.startsWith('main_')) continue
    if (cfg.availableToPlans?.includes(plan) && cfg.displayName) {
      result.push({
        alias: key,
        displayName: cfg.displayName,
        displayDescription: cfg.displayDescription ?? '',
        supportsVision: aliasSupportsVision(key),
      })
    }
  }
  return result
}

/**
 * Authorization check for the main-loop picker: can this user plan use this alias?
 * The /api/chat endpoint uses this to reject spoofed alias requests with 403.
 */
export function canUseAlias(plan: UserPlan, alias: ModelAlias): boolean {
  return loadRegistry().aliases[alias]?.availableToPlans?.includes(plan) === true
}

/**
 * Default main-loop alias for a given plan — used when conversation doesn't
 * yet have orchestrator_model set (first message).
 */
export function defaultMainAliasFor(plan: UserPlan): ModelAlias {
  const alias = loadRegistry().defaultMainAlias[plan]
  if (!alias) throw new Error(`No defaultMainAlias configured for plan: ${plan}`)
  return alias
}

/**
 * Whether this alias's underlying model can read multimodal image content.
 * Missing declarations are treated as text-only. Guessing multimodal support
 * would expose image tools and payloads to a model that may reject them.
 */
export function aliasSupportsVision(alias: ModelAlias): boolean {
  const cfg = loadRegistry().aliases[alias]
  if (!cfg) return false
  if (typeof cfg.supportsVision !== 'boolean') {
    const warningKey = `vision:${alias}`
    if (!warnedMissingCapabilities.has(warningKey)) {
      warnedMissingCapabilities.add(warningKey)
      console.warn(`[llm-registry] alias "${alias}" lacks supportsVision; treating it as text-only until explicitly configured.`)
    }
    return false
  }
  return cfg.supportsVision
}

// ==================== Per-User Override Resolution ====================
//
// Test-period override layer: an admin-set `forced_*_alias` on the user
// document overrides every other selection (in-app picker, conversation
// settings, plan default). Used only by callers that have already loaded
// `UserModelOverrides` for the active user.

/**
 * Resolve the main-loop alias for a user, honoring forced override before
 * plan default. Caller is responsible for providing the user's plan + force
 * field (typically from getUserModelOverrides).
 */
export function resolveMainAliasForUser(
  plan: UserPlan,
  forcedAlias: string | undefined,
): ModelAlias {
  if (forcedAlias && loadRegistry().aliases[forcedAlias]) return forcedAlias
  if (forcedAlias) {
    console.warn(
      `[llm-registry] forced_main_alias "${forcedAlias}" not in registry — falling back to plan default`,
    )
  }
  return defaultMainAliasFor(plan)
}
