import type { WorkspaceArtifact } from '@/hooks/useWorkspaceArtifacts'

export type WorldRenderFormat = 'spz' | 'ply'

export interface WorldStageAsset {
  key?: string
  kind?: string
  path: string
  mime_type?: string
  size_bytes?: number
  sha256?: string
}

export interface WorldStageRelation {
  kind?: string
  artifact_id?: string
}

export interface WorldStageManifest {
  schema_version?: number
  title?: string
  status?: string
  provider?: string
  job_id?: string
  world_id?: string
  provider_task_id?: string
  viewer_url?: string
  preview_path?: string
  source_image_path?: string
  created_at?: string
  updated_at?: string
  up_axis?: string
  assets: WorldStageAsset[]
  relations: WorldStageRelation[]
}

export interface WorldRenderSource {
  path: string
  format: WorldRenderFormat
  sizeBytes?: number
  sha256?: string
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function parseWorldStageManifest(content: string): WorldStageManifest | null {
  try {
    const value = JSON.parse(content) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    const assets = Array.isArray(record.assets)
      ? record.assets.flatMap((candidate): WorldStageAsset[] => {
          if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
          const asset = candidate as Record<string, unknown>
          const path = text(asset.path)?.replace(/^\/+/, '')
          if (!path || !path.startsWith('output/spatial/worlds/')) return []
          return [{
            path,
            ...(text(asset.key) ? { key: text(asset.key) } : {}),
            ...(text(asset.kind) ? { kind: text(asset.kind) } : {}),
            ...(text(asset.mime_type) ? { mime_type: text(asset.mime_type) } : {}),
            ...(number(asset.size_bytes) !== undefined ? { size_bytes: number(asset.size_bytes) } : {}),
            ...(text(asset.sha256) ? { sha256: text(asset.sha256) } : {}),
          }]
        })
      : []
    const relations = Array.isArray(record.relations)
      ? record.relations.flatMap((candidate): WorldStageRelation[] => {
          if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
          const relation = candidate as Record<string, unknown>
          const kind = text(relation.kind)
          const artifactId = text(relation.artifact_id)
          return kind && artifactId ? [{ kind, artifact_id: artifactId }] : []
        })
      : []

    return {
      ...(number(record.schema_version) !== undefined ? { schema_version: number(record.schema_version) } : {}),
      ...(text(record.title) ? { title: text(record.title) } : {}),
      ...(text(record.status) ? { status: text(record.status) } : {}),
      ...(text(record.provider) ? { provider: text(record.provider) } : {}),
      ...(text(record.job_id) ? { job_id: text(record.job_id) } : {}),
      ...(text(record.world_id) ? { world_id: text(record.world_id) } : {}),
      ...(text(record.provider_task_id) ? { provider_task_id: text(record.provider_task_id) } : {}),
      ...(text(record.viewer_url) ? { viewer_url: text(record.viewer_url) } : {}),
      ...(text(record.preview_path) ? { preview_path: text(record.preview_path)?.replace(/^\/+/, '') } : {}),
      ...(text(record.source_image_path) ? { source_image_path: text(record.source_image_path) } : {}),
      ...(text(record.created_at) ? { created_at: text(record.created_at) } : {}),
      ...(text(record.updated_at) ? { updated_at: text(record.updated_at) } : {}),
      ...(text(record.up_axis) ? { up_axis: text(record.up_axis)?.toUpperCase() } : {}),
      assets,
      relations,
    }
  } catch {
    return null
  }
}

export function chooseWorldRenderSource(manifest: WorldStageManifest | null): WorldRenderSource | null {
  if (!manifest) return null
  const candidates = manifest.assets.flatMap((asset): WorldRenderSource[] => {
    const lower = asset.path.toLowerCase()
    const format: WorldRenderFormat | null = lower.endsWith('.spz')
      ? 'spz'
      : lower.endsWith('.ply')
        ? 'ply'
        : null
    return format ? [{
      path: asset.path,
      format,
      ...(asset.size_bytes !== undefined ? { sizeBytes: asset.size_bytes } : {}),
      ...(asset.sha256 ? { sha256: asset.sha256 } : {}),
    }] : []
  })
  return candidates.find(candidate => candidate.format === 'spz')
    ?? candidates.find(candidate => candidate.format === 'ply')
    ?? null
}

export function worldBinaryUrl(conversationId: string, path: string, sha256?: string): string {
  const version = sha256 ? `&v=${encodeURIComponent(sha256)}` : ''
  return `/api/conversations/${encodeURIComponent(conversationId)}/files/binary?path=${encodeURIComponent(path)}${version}`
}

export function listWorldManifests(artifacts: readonly WorkspaceArtifact[]): WorkspaceArtifact[] {
  return artifacts
    .filter(artifact => artifact.type === 'world')
    .sort((left, right) => right.path.localeCompare(left.path))
}

export function worldBuildLabel(path: string): string {
  const match = path.match(/^output\/spatial\/worlds\/([^/]+)\/manifest\.json$/i)
  return match?.[1] ?? path.split('/').at(-2) ?? 'world'
}

export function formatSpatialBytes(value: number | undefined): string {
  if (value === undefined) return '大小未知'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}
