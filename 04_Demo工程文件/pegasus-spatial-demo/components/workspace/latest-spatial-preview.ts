export interface SpatialPreviewArtifact {
  path: string
  type: 'markdown' | 'text' | 'document' | 'image' | 'model3d' | 'world'
  assetId?: string
  sha256?: string
  revision?: number
  createdAt?: string
  updatedAt?: string
}

export function isSpatialPreviewArtifact(artifact: SpatialPreviewArtifact): boolean {
  return artifact.type === 'image' || artifact.type === 'model3d' || artifact.type === 'world'
}

function previewPriority(type: SpatialPreviewArtifact['type']): number {
  if (type === 'world') return 3
  if (type === 'model3d') return 2
  if (type === 'image') return 1
  return 0
}

function artifactTimestamp(artifact: SpatialPreviewArtifact): number {
  const timestamp = Date.parse(artifact.updatedAt || artifact.createdAt || '')
  return Number.isFinite(timestamp) ? timestamp : 0
}

export function latestSpatialPreview<T extends SpatialPreviewArtifact>(
  artifacts: readonly T[],
): T | null {
  let latest: T | null = null
  for (const artifact of artifacts) {
    if (!isSpatialPreviewArtifact(artifact)) continue
    if (!latest) {
      latest = artifact
      continue
    }
    const timestampDelta = artifactTimestamp(artifact) - artifactTimestamp(latest)
    if (timestampDelta > 0) {
      latest = artifact
      continue
    }
    if (timestampDelta < 0) continue
    const priorityDelta = previewPriority(artifact.type) - previewPriority(latest.type)
    if (priorityDelta > 0 || (priorityDelta === 0 && artifact.path > latest.path)) {
      latest = artifact
    }
  }
  return latest
}

export function spatialPreviewRevision(artifact: SpatialPreviewArtifact): string {
  return [
    artifact.path,
    artifact.assetId || '',
    artifact.sha256 || '',
    artifact.revision ?? '',
    artifact.updatedAt || '',
  ].join('\u0000')
}
