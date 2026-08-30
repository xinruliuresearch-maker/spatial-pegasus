import type { WorkspaceInstance } from './types'
import {
  canonicalWorkspaceWritePath,
  isManagedLiteratureArtifactPath,
} from './path-policy'

export interface AgentWorkspaceScope {
  agentId: string
  isRoot: boolean
  readablePrivatePaths?: readonly string[]
}

function privateOwner(path: string): string | null {
  const normalized = canonicalWorkspaceWritePath(path)
  const match = /^\.sci-pegasus\/agents\/([^/]+)\//.exec(normalized)
  return match?.[1] ?? null
}

export function agentScratchPrefix(agentId: string): string {
  return `.sci-pegasus/agents/${agentId}/`
}

function isManagedLiteratureNamespace(path: string): boolean {
  return isManagedLiteratureArtifactPath(path)
}

export function canAgentReadWorkspacePath(
  path: string,
  scope: AgentWorkspaceScope,
): boolean {
  if (scope.isRoot) return true
  const normalized = canonicalWorkspaceWritePath(path)
  const explicitlyReferenced = (scope.readablePrivatePaths ?? []).some(candidate => (
    canonicalWorkspaceWritePath(candidate) === normalized
  ))
  if (normalized.startsWith('.sci-pegasus/')
    && !normalized.startsWith(agentScratchPrefix(scope.agentId))) {
    return explicitlyReferenced
  }
  const owner = privateOwner(normalized)
  if (!owner || owner === scope.agentId) return true
  return explicitlyReferenced
}

export function canAgentWriteWorkspacePath(
  path: string,
  scope: AgentWorkspaceScope,
  options?: { managedLiterature?: boolean },
): boolean {
  if (scope.isRoot) return true
  const normalized = canonicalWorkspaceWritePath(path)
  if (normalized.startsWith(agentScratchPrefix(scope.agentId))) return true
  return options?.managedLiterature === true && isManagedLiteratureNamespace(normalized)
}

/**
 * A view over the shared Workspace that enforces Agent-owned scratch paths and
 * reference-scoped peer reads. Literature tools opt into their immutable
 * managed namespace through the low-level write methods; generic Write/Edit
 * still receive an explicit provider-side guard.
 */
export function scopeWorkspaceForAgent(
  workspace: WorkspaceInstance,
  scope: AgentWorkspaceScope,
): WorkspaceInstance {
  const assertRead = (path: string) => {
    if (!canAgentReadWorkspacePath(path, scope)) {
      throw new Error(`Agent is not permitted to read private workspace path: ${path}`)
    }
  }
  const assertWrite = (path: string, managedLiterature = false) => {
    if (!canAgentWriteWorkspacePath(path, scope, { managedLiterature })) {
      throw new Error(`Agent may only write its private scratch directory: ${agentScratchPrefix(scope.agentId)}`)
    }
  }
  const visible = (path: string) => canAgentReadWorkspacePath(path, scope)
  // WorkspaceFileRevision is the authoritative immutable history for member
  // paths. The legacy archive mechanism writes below the shared
  // `.sci-pegasus/versions/**` namespace, which would both violate private ACL
  // ownership and risk exposing a private prior revision. Root retains the
  // legacy projection during migration; members always disable it.
  const memberWriteOptions = (options?: { archive?: boolean }) => (
    scope.isRoot ? options : { ...options, archive: false as const }
  )

  return {
    definition: workspace.definition,
    async read(path) {
      assertRead(path)
      return workspace.read(path)
    },
    async readText(path) {
      assertRead(path)
      return workspace.readText(path)
    },
    async write(path, content, note, options) {
      assertWrite(path, isManagedLiteratureNamespace(path))
      return workspace.write(path, content, note, memberWriteOptions(options))
    },
    async writeText(path, content, note, options) {
      assertWrite(path, isManagedLiteratureNamespace(path))
      return workspace.writeText(path, content, note, memberWriteOptions(options))
    },
    async readRaster(path) {
      assertRead(path)
      return workspace.readRaster(path)
    },
    async readRasterBuffer(path, variant) {
      assertRead(path)
      return workspace.readRasterBuffer(path, variant)
    },
    async writeRaster(path, asset, note, options) {
      assertWrite(path, isManagedLiteratureNamespace(path))
      return workspace.writeRaster(path, asset, note, memberWriteOptions(options))
    },
    async writeRasters(entries) {
      for (const entry of entries) {
        assertWrite(entry.path, isManagedLiteratureNamespace(entry.path))
      }
      return workspace.writeRasters(entries.map(entry => ({
        ...entry,
        options: memberWriteOptions(entry.options),
      })))
    },
    async writeDocument(input) {
      assertWrite(input.path, isManagedLiteratureNamespace(input.path))
      return workspace.writeDocument(input)
    },
    async readDocument(path) {
      assertRead(path)
      return workspace.readDocument(path)
    },
    async readDocumentBuffer(path) {
      assertRead(path)
      return workspace.readDocumentBuffer(path)
    },
    async stat(path) {
      assertRead(path)
      return workspace.stat(path)
    },
    list(pattern) {
      return workspace.list(pattern).filter(visible)
    },
    exists(path) {
      return visible(path) && workspace.exists(path)
    },
    async withFileSetReservation(paths, idempotencyKey, operation) {
      for (const path of paths) assertWrite(path, isManagedLiteratureNamespace(path))
      return workspace.withFileSetReservation(paths, idempotencyKey, operation)
    },
    getFileDeclaration(path) {
      return visible(path) ? workspace.getFileDeclaration(path) : undefined
    },
  }
}
