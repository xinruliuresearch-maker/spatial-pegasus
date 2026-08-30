import type {
  FrozenModelResolutionSnapshot,
  ModelCapabilities,
} from '../llm-registry'

export interface CompactionCapacitySource {
  model_alias_snapshot?: string | null
  model_resolution_snapshot?: FrozenModelResolutionSnapshot | null
}

export interface PublicCompactionCapacity {
  context_window: number
  input_limit_tokens: number
  max_output_tokens: number
}

type LegacyCapacityResolver = (
  alias: string,
) => Pick<ModelCapabilities, 'contextWindow' | 'maxOutputTokens'>

function publicCapacity(
  contextWindow: number,
  maxOutputTokens: number,
): PublicCompactionCapacity | null {
  if (
    !Number.isSafeInteger(contextWindow)
    || !Number.isSafeInteger(maxOutputTokens)
    || maxOutputTokens <= 0
    || contextWindow <= maxOutputTokens
  ) return null

  return {
    context_window: contextWindow,
    input_limit_tokens: Math.max(1, contextWindow - maxOutputTokens),
    max_output_tokens: maxOutputTokens,
  }
}

/**
 * Project a Job's immutable public context capacity without exposing its real
 * model or key channel. New Jobs must use the persisted model resolution so a
 * later alias remap/removal cannot change reconnect UI semantics. Registry
 * lookup exists only for legacy Jobs created before resolution snapshots.
 */
export function resolvePublicCompactionCapacity(
  source: CompactionCapacitySource,
  resolveLegacyCapacity: LegacyCapacityResolver,
): PublicCompactionCapacity | null {
  const frozen = source.model_resolution_snapshot
  if (frozen) {
    if (
      frozen.snapshot_version !== 1
      || (source.model_alias_snapshot && frozen.alias !== source.model_alias_snapshot)
    ) return null

    return publicCapacity(
      frozen.context_window,
      frozen.max_output_tokens,
    )
  }

  // Only pre-snapshot legacy Jobs may consult the mutable registry. An invalid
  // persisted snapshot fails closed instead of silently changing model scope.
  const alias = source.model_alias_snapshot
  if (!alias) return null
  try {
    const legacy = resolveLegacyCapacity(alias)
    return publicCapacity(legacy.contextWindow, legacy.maxOutputTokens)
  } catch {
    // Removed aliases are expected for legacy Jobs. Status remains available,
    // but callers omit the gauge rather than inventing a model capacity.
    return null
  }
}
