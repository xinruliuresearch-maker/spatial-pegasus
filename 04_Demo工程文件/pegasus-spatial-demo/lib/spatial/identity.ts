import { createHash } from 'node:crypto'
import type { SpatialBuildRequestSnapshot } from './types'

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value instanceof Date) return value.toISOString()
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    )
  }
  return value
}

export function canonicalSpatialJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function spatialRequestHash(request: SpatialBuildRequestSnapshot): string {
  return createHash('sha256').update(canonicalSpatialJson(request)).digest('hex')
}

function nonEmptyIdentityPart(label: string, value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.includes('\0')) {
    throw new TypeError(`${label} must be a non-empty identifier.`)
  }
  return normalized
}

export function spatialIdempotencyKey(input: {
  projectId: string
  runId: string
  toolUseId: string
}): string {
  return [
    nonEmptyIdentityPart('projectId', input.projectId),
    nonEmptyIdentityPart('runId', input.runId),
    nonEmptyIdentityPart('toolUseId', input.toolUseId),
  ].join('\0')
}

export function deterministicSpatialJobId(input: {
  projectId: string
  runId: string
  toolUseId: string
}): string {
  const digest = createHash('sha256')
    .update(spatialIdempotencyKey(input))
    .digest('hex')
    .slice(0, 40)
  return `spjob_${digest}`
}

export function providerSpatialIdempotencyKey(jobId: string): string {
  return `pegasus-spatial:${nonEmptyIdentityPart('jobId', jobId)}`
}

/** Stable across worker leases so a staged provider payload can be resumed. */
export function spatialPublicationToken(jobId: string): string {
  const digest = createHash('sha256')
    .update(`pegasus-spatial-publication-v1\0${nonEmptyIdentityPart('jobId', jobId)}`)
    .digest('hex')
    .slice(0, 40)
  return `sppub_${digest}`
}

export function normalizeSpatialWorkspacePrefix(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
    throw new TypeError('output_path_prefix must be a relative Workspace path.')
  }
  const segments = normalized.split('/').filter(Boolean)
  if (segments.some(segment => segment === '.' || segment === '..')) {
    throw new TypeError('output_path_prefix cannot traverse outside the Workspace.')
  }
  const result = segments.join('/')
  if (result !== 'output/spatial' && !result.startsWith('output/spatial/')) {
    throw new TypeError('Spatial outputs must live under output/spatial/.')
  }
  return result
}
