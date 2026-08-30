import {
  SPATIAL_ARTIFACT_RELATIONS,
  SPATIAL_BUILD_STATUSES,
  type SpatialArtifactRelation,
  type SpatialBuildKind,
  type SpatialBuildStatus,
} from './types'

export const SPATIAL_TOOL_RESULT_SCHEMA_VERSION = 1 as const

export type SpatialToolResultKind = SpatialBuildKind | 'job' | 'artifact'

/** Stable, byte-free JSON contract shared by tools, persisted messages and UI. */
export interface SpatialToolResultEnvelope {
  schema_version: typeof SPATIAL_TOOL_RESULT_SCHEMA_VERSION
  job_id?: string
  artifact_id?: string
  kind: SpatialToolResultKind
  status: SpatialBuildStatus
  provider: string
  workspace_paths?: string[]
  message?: string
  created_at?: string
  elapsed_ms?: number
  relations?: SpatialArtifactRelation[]
  metadata?: Record<string, string | number | boolean | null>
  updated_at: string
  error?: string
}

const KINDS: readonly SpatialToolResultKind[] = ['image', 'object', 'world', 'job', 'artifact']
const ENVELOPE_KEYS = new Set([
  'schema_version',
  'job_id',
  'artifact_id',
  'kind',
  'status',
  'provider',
  'workspace_paths',
  'message',
  'created_at',
  'elapsed_ms',
  'relations',
  'metadata',
  'updated_at',
  'error',
])

export function serializeSpatialToolResult(result: SpatialToolResultEnvelope): string {
  const serialized = JSON.stringify(result)
  if (!parseSpatialToolResult(serialized)) {
    throw new TypeError('Spatial tool result does not satisfy the byte-free schema v1 contract.')
  }
  return serialized
}

export function parseSpatialToolResult(value: string): SpatialToolResultEnvelope | null {
  let candidate: unknown
  try {
    candidate = JSON.parse(value)
  } catch {
    return null
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
  const record = candidate as Record<string, unknown>
  if (Object.keys(record).some(key => !ENVELOPE_KEYS.has(key))) return null
  if (
    record.schema_version !== SPATIAL_TOOL_RESULT_SCHEMA_VERSION
    || typeof record.kind !== 'string'
    || !KINDS.includes(record.kind as SpatialToolResultKind)
    || typeof record.status !== 'string'
    || !(SPATIAL_BUILD_STATUSES as readonly string[]).includes(record.status)
    || typeof record.provider !== 'string'
    || typeof record.updated_at !== 'string'
  ) return null
  if (record.relations !== undefined && (
    !Array.isArray(record.relations)
    || record.relations.some(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return true
      const relation = value as Record<string, unknown>
      return Object.keys(relation).some(key => !['kind', 'artifact_id'].includes(key))
        || typeof relation.kind !== 'string'
        || !(SPATIAL_ARTIFACT_RELATIONS as readonly string[]).includes(relation.kind)
        || typeof relation.artifact_id !== 'string'
    })
  )) return null
  if (record.metadata !== undefined && (
    !record.metadata
    || typeof record.metadata !== 'object'
    || Array.isArray(record.metadata)
    || Object.values(record.metadata as Record<string, unknown>).some(value => (
      value !== null && !['string', 'number', 'boolean'].includes(typeof value)
    ))
  )) return null
  if (record.job_id !== undefined && typeof record.job_id !== 'string') return null
  if (record.artifact_id !== undefined && typeof record.artifact_id !== 'string') return null
  if (record.message !== undefined && typeof record.message !== 'string') return null
  if (record.created_at !== undefined && typeof record.created_at !== 'string') return null
  if (
    record.elapsed_ms !== undefined
    && (typeof record.elapsed_ms !== 'number' || !Number.isSafeInteger(record.elapsed_ms) || record.elapsed_ms < 0)
  ) return null
  if (record.error !== undefined && typeof record.error !== 'string') return null
  if (
    record.workspace_paths !== undefined
    && (!Array.isArray(record.workspace_paths) || record.workspace_paths.some(path => typeof path !== 'string'))
  ) return null
  return {
    schema_version: SPATIAL_TOOL_RESULT_SCHEMA_VERSION,
    ...(typeof record.job_id === 'string' ? { job_id: record.job_id } : {}),
    ...(typeof record.artifact_id === 'string' ? { artifact_id: record.artifact_id } : {}),
    kind: record.kind as SpatialToolResultKind,
    status: record.status as SpatialBuildStatus,
    provider: record.provider,
    ...(Array.isArray(record.workspace_paths)
      ? { workspace_paths: record.workspace_paths as string[] }
      : {}),
    ...(typeof record.message === 'string' ? { message: record.message } : {}),
    ...(typeof record.created_at === 'string' ? { created_at: record.created_at } : {}),
    ...(typeof record.elapsed_ms === 'number' ? { elapsed_ms: record.elapsed_ms } : {}),
    ...(Array.isArray(record.relations)
      ? { relations: structuredClone(record.relations) as SpatialArtifactRelation[] }
      : {}),
    ...(record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? { metadata: structuredClone(record.metadata) as Record<string, string | number | boolean | null> }
      : {}),
    updated_at: record.updated_at,
    ...(typeof record.error === 'string' ? { error: record.error } : {}),
  }
}
