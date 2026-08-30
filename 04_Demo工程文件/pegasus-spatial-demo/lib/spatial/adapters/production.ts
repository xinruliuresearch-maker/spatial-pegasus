import type { SpatialProviderAdapter } from '../types'
import { createAholoAdapterFromEnv } from './aholo'
import { createLux3DAdapterFromEnv } from './lux3d'

/** Construct configured adapters without performing provider I/O. */
export function createOfficialSpatialAdaptersFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyMap<string, SpatialProviderAdapter> {
  const adapters: SpatialProviderAdapter[] = [
    createAholoAdapterFromEnv({}, env),
    createLux3DAdapterFromEnv({}, env),
  ]
  return new Map(adapters.map(adapter => [adapter.provider, adapter]))
}
