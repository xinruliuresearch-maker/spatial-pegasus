import type { MultiAgentWorkspaceStore } from './store'
import type {
  CanonicalArtifactClaim,
  CanonicalArtifactRecord,
  WorkspaceCapacityState,
  WorkspaceFileSnapshot,
} from './types'

function clone<T>(value: T): T {
  return structuredClone(value)
}

function fileKey(workspaceId: string, path: string): string {
  return `${workspaceId}\u0000${path}`
}

function canonicalKey(workspaceId: string, key: string): string {
  return `${workspaceId}\u0000${key}`
}

/** Deterministic persistence adapter for focused tests and local simulations. */
export class InMemoryMultiAgentWorkspaceStore implements MultiAgentWorkspaceStore {
  private readonly capacities = new Map<string, WorkspaceCapacityState>()
  private readonly files = new Map<string, WorkspaceFileSnapshot>()
  private readonly canonicalArtifacts = new Map<string, CanonicalArtifactRecord>()

  async createCapacityIfMissing(state: WorkspaceCapacityState): Promise<WorkspaceCapacityState> {
    const existing = this.capacities.get(state.workspace_id)
    if (existing) return clone(existing)
    this.capacities.set(state.workspace_id, clone(state))
    return clone(state)
  }

  async getCapacity(workspaceId: string): Promise<WorkspaceCapacityState | null> {
    const state = this.capacities.get(workspaceId)
    return state ? clone(state) : null
  }

  async compareAndSwapCapacity(
    expectedRevision: number,
    next: WorkspaceCapacityState,
  ): Promise<boolean> {
    const current = this.capacities.get(next.workspace_id)
    if (!current || current.revision !== expectedRevision) return false
    this.capacities.set(next.workspace_id, clone(next))
    return true
  }

  async getFile(workspaceId: string, path: string): Promise<WorkspaceFileSnapshot | null> {
    const file = this.files.get(fileKey(workspaceId, path))
    return file ? clone(file) : null
  }

  async listFiles(workspaceId: string): Promise<WorkspaceFileSnapshot[]> {
    return [...this.files.values()]
      .filter(file => file.workspace_id === workspaceId)
      .sort((left, right) => left.path.localeCompare(right.path))
      .map(clone)
  }

  async compareAndSwapFile(
    expectedRevision: number | null,
    candidate: WorkspaceFileSnapshot,
  ): Promise<{ committed: true } | { committed: false; actualRevision: number | null }> {
    const key = fileKey(candidate.workspace_id, candidate.path)
    const current = this.files.get(key)
    const actualRevision = current?.revision ?? null
    if (actualRevision !== expectedRevision) return { committed: false, actualRevision }
    this.files.set(key, clone(candidate))
    return { committed: true }
  }

  async deleteStagedFiles(workspaceId: string, reservationId: string): Promise<number> {
    let deleted = 0
    for (const [key, file] of this.files) {
      if (
        file.workspace_id === workspaceId
        && file.capacity_reservation_id === reservationId
      ) {
        this.files.delete(key)
        deleted += 1
      }
    }
    return deleted
  }

  async claimCanonicalArtifact(record: CanonicalArtifactRecord): Promise<CanonicalArtifactClaim> {
    const key = canonicalKey(record.workspace_id, record.canonical_artifact_key)
    const existing = this.canonicalArtifacts.get(key)
    if (existing) return { state: 'existing', record: clone(existing) }
    this.canonicalArtifacts.set(key, clone(record))
    return { state: 'claimed', record: clone(record) }
  }

  async getCanonicalArtifact(
    workspaceId: string,
    canonicalArtifactKey: string,
  ): Promise<CanonicalArtifactRecord | null> {
    const record = this.canonicalArtifacts.get(canonicalKey(workspaceId, canonicalArtifactKey))
    return record ? clone(record) : null
  }

  async markCanonicalArtifactPublished(
    workspaceId: string,
    canonicalArtifactKey: string,
    fileRevision: number,
  ): Promise<void> {
    const key = canonicalKey(workspaceId, canonicalArtifactKey)
    const record = this.canonicalArtifacts.get(key)
    if (!record) return
    this.canonicalArtifacts.set(key, {
      ...clone(record),
      status: 'published',
      file_revision: fileRevision,
      updated_at: new Date(),
    })
  }

  async markCanonicalArtifactFailed(
    workspaceId: string,
    canonicalArtifactKey: string,
  ): Promise<void> {
    const key = canonicalKey(workspaceId, canonicalArtifactKey)
    const record = this.canonicalArtifacts.get(key)
    if (!record || record.status !== 'staging') return
    this.canonicalArtifacts.set(key, {
      ...clone(record),
      status: 'failed',
      updated_at: new Date(),
    })
  }
}
