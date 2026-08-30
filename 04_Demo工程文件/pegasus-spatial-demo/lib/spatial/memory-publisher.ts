import type {
  PublishedSpatialAsset,
  SpatialAssetPublisher,
  StagedSpatialAsset,
} from './types'

interface PrivateStagedSpatialAsset extends StagedSpatialAsset {
  buffer: Buffer
}

/** Byte-retaining publisher intended only for deterministic tests. */
export class InMemorySpatialAssetPublisher implements SpatialAssetPublisher {
  private readonly staged = new Map<string, PrivateStagedSpatialAsset>()
  private readonly ready = new Map<string, { assets: StagedSpatialAsset[]; expiresAt: Date }>()
  private readonly published = new Map<string, { asset: PublishedSpatialAsset; buffer: Buffer }>()

  async recoverStage(input: {
    artifactId: string
    job: { job_id: string }
    publicationToken: string
    providerAssetKey: string
    kind: StagedSpatialAsset['kind']
    filename: string
    workspacePath: string
    relations: StagedSpatialAsset['relations']
    metadata: StagedSpatialAsset['metadata']
  }): Promise<StagedSpatialAsset | null> {
    const value = this.staged.get(`memory_stage:${input.artifactId}`)
    if (!value) return null
    const safe = { ...value } as Partial<PrivateStagedSpatialAsset>
    delete safe.buffer
    return structuredClone(safe) as StagedSpatialAsset
  }

  async stage(input: {
    job: { job_id: string }
    publicationToken: string
    artifactId: string
    providerAssetKey: string
    kind: StagedSpatialAsset['kind']
    filename: string
    workspacePath: string
    buffer: Buffer
    mimeType: string
    sha256: string
    relations: StagedSpatialAsset['relations']
    metadata: StagedSpatialAsset['metadata']
  }): Promise<StagedSpatialAsset> {
    const stageId = `memory_stage:${input.artifactId}`
    const asset: PrivateStagedSpatialAsset = {
      stageId,
      artifactId: input.artifactId,
      jobId: input.job.job_id,
      publicationToken: input.publicationToken,
      providerAssetKey: input.providerAssetKey,
      kind: input.kind,
      filename: input.filename,
      workspacePath: input.workspacePath,
      mimeType: input.mimeType,
      sizeBytes: input.buffer.length,
      sha256: input.sha256,
      relations: structuredClone(input.relations),
      metadata: structuredClone(input.metadata),
      buffer: Buffer.from(input.buffer),
    }
    this.staged.set(stageId, asset)
    return {
      stageId: asset.stageId,
      artifactId: asset.artifactId,
      jobId: asset.jobId,
      publicationToken: asset.publicationToken,
      providerAssetKey: asset.providerAssetKey,
      kind: asset.kind,
      filename: asset.filename,
      workspacePath: asset.workspacePath,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      sha256: asset.sha256,
      relations: structuredClone(asset.relations),
      metadata: structuredClone(asset.metadata),
    }
  }

  async markBatchReady(input: {
    job: { job_id: string }
    publicationToken: string
    assets: readonly StagedSpatialAsset[]
  }): Promise<void> {
    this.ready.set(`${input.job.job_id}\0${input.publicationToken}`, {
      assets: structuredClone([...input.assets]),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    })
  }

  async recoverReadyBatch(input: {
    job: { job_id: string }
    publicationToken: string
  }): Promise<StagedSpatialAsset[] | null> {
    const value = this.ready.get(`${input.job.job_id}\0${input.publicationToken}`)
    return value ? structuredClone(value.assets) : null
  }

  async publishBatch(input: {
    assets: readonly StagedSpatialAsset[]
  }): Promise<PublishedSpatialAsset[]> {
    const result: PublishedSpatialAsset[] = []
    for (const requested of input.assets) {
      const staged = this.staged.get(requested.stageId)
      if (!staged) throw new Error(`Missing memory stage: ${requested.stageId}`)
      const asset: PublishedSpatialAsset = {
        stageId: staged.stageId,
        artifactId: staged.artifactId,
        jobId: staged.jobId,
        publicationToken: staged.publicationToken,
        providerAssetKey: staged.providerAssetKey,
        kind: staged.kind,
        filename: staged.filename,
        workspacePath: staged.workspacePath,
        mimeType: staged.mimeType,
        sizeBytes: staged.sizeBytes,
        sha256: staged.sha256,
        relations: structuredClone(staged.relations),
        metadata: structuredClone(staged.metadata),
        storageUri: `memory://spatial/${staged.artifactId}`,
      }
      this.published.set(staged.artifactId, { asset, buffer: Buffer.from(staged.buffer) })
      result.push(asset)
    }
    return result
  }

  async discardBatch(assets: readonly StagedSpatialAsset[]): Promise<void> {
    for (const asset of assets) {
      this.staged.delete(asset.stageId)
      this.ready.delete(`${asset.jobId}\0${asset.publicationToken}`)
    }
  }

  async discardJobStages(input: { job: { job_id: string }; publicationToken: string }): Promise<number> {
    let removed = 0
    for (const [stageId, asset] of this.staged) {
      if (asset.jobId !== input.job.job_id || asset.publicationToken !== input.publicationToken) continue
      this.staged.delete(stageId)
      removed += 1
    }
    this.ready.delete(`${input.job.job_id}\0${input.publicationToken}`)
    return removed
  }

  async cleanupExpired(now = new Date()): Promise<number> {
    let removed = 0
    for (const [key, value] of this.ready) {
      if (value.expiresAt > now) continue
      this.ready.delete(key)
      for (const asset of value.assets) this.staged.delete(asset.stageId)
      removed += value.assets.length
    }
    return removed
  }

  readPublished(artifactId: string): Buffer | null {
    const value = this.published.get(artifactId)
    return value ? Buffer.from(value.buffer) : null
  }
}
