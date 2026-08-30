import type { LiteratureProvider, LiteratureProviderRegistry, LiteratureSource } from '../types'
import { ArxivLiteratureProvider, type ArxivProviderOptions } from './arxiv'
import { SciverseLiteratureProvider, type SciverseProviderOptions } from './sciverse'

export interface DefaultLiteratureProviderOptions {
  arxiv?: ArxivProviderOptions
  sciverse?: SciverseProviderOptions
}

export function createDefaultLiteratureProviderRegistry(
  options: DefaultLiteratureProviderOptions = {},
): LiteratureProviderRegistry {
  const arxiv = new ArxivLiteratureProvider(options.arxiv)
  const sciverse = new SciverseLiteratureProvider(options.sciverse)
  const entries: Array<[LiteratureSource, LiteratureProvider]> = [
    ['arxiv', arxiv],
    ['sciverse', sciverse],
  ]
  return new Map(entries)
}

export function getLiteratureProvider(
  registry: LiteratureProviderRegistry,
  source: LiteratureSource,
) {
  const provider = registry.get(source)
  if (!provider) throw new Error(`Literature provider is not available: ${source}`)
  return provider
}
