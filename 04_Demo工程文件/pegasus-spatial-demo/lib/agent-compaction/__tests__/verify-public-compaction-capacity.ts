import assert from 'node:assert/strict'
import type { FrozenModelResolutionSnapshot } from '../../llm-registry'
import { resolvePublicCompactionCapacity } from '../public-capacity'

function snapshot(
  overrides: Partial<FrozenModelResolutionSnapshot> = {},
): FrozenModelResolutionSnapshot {
  return {
    snapshot_version: 1,
    alias: 'retired_alias',
    real_model: 'frozen-real-model',
    key_channel: 'orchestrator',
    supports_vision: false,
    context_window: 128_000,
    max_output_tokens: 16_000,
    compaction_max_output_tokens: 8_000,
    prompt_cache_ttl: '5m',
    used_compatibility_defaults: false,
    registry_source: 'db',
    registry_revision: '2026-08-10T00:00:00.000Z',
    registry_hash: 'a'.repeat(64),
    resolved_at: new Date('2026-08-10T00:00:00.000Z'),
    ...overrides,
  }
}

let liveLookups = 0
const remapped = resolvePublicCompactionCapacity({
  model_alias_snapshot: 'retired_alias',
  model_resolution_snapshot: snapshot(),
}, () => {
  liveLookups += 1
  return { contextWindow: 999_000, maxOutputTokens: 1 }
})
assert.deepEqual(remapped, {
  context_window: 128_000,
  input_limit_tokens: 112_000,
  max_output_tokens: 16_000,
})
assert.equal(liveLookups, 0, 'a live alias remap must not override the Job snapshot')

const removed = resolvePublicCompactionCapacity({
  model_alias_snapshot: 'retired_alias',
  model_resolution_snapshot: snapshot(),
}, () => {
  throw new Error('Unknown model alias: retired_alias')
})
assert.deepEqual(removed, remapped, 'a removed alias must retain its frozen W/O capacity')

liveLookups = 0
const legacy = resolvePublicCompactionCapacity({
  model_alias_snapshot: 'legacy_alias',
  model_resolution_snapshot: null,
}, alias => {
  liveLookups += 1
  assert.equal(alias, 'legacy_alias')
  return { contextWindow: 64_000, maxOutputTokens: 8_000 }
})
assert.deepEqual(legacy, {
  context_window: 64_000,
  input_limit_tokens: 56_000,
  max_output_tokens: 8_000,
})
assert.equal(liveLookups, 1, 'only legacy Jobs may consult the live registry')

liveLookups = 0
assert.equal(resolvePublicCompactionCapacity({
  model_alias_snapshot: 'retired_alias',
  model_resolution_snapshot: snapshot({ context_window: 8_000 }),
}, () => {
  liveLookups += 1
  return { contextWindow: 64_000, maxOutputTokens: 8_000 }
}), null, 'an invalid persisted snapshot must fail closed')
assert.equal(liveLookups, 0, 'a snapshot-bearing Job is never a legacy fallback')

assert.equal(resolvePublicCompactionCapacity({
  model_alias_snapshot: 'removed_legacy_alias',
  model_resolution_snapshot: null,
}, () => {
  throw new Error('Unknown model alias: removed_legacy_alias')
}), null, 'an unresolvable legacy Job must omit capacity instead of fabricating it')

console.log('public-compaction-capacity:verify passed')
