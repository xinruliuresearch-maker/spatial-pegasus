export class WorkspaceAclError extends Error {
  readonly code = 'workspace_acl_denied'

  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceAclError'
  }
}

export class WorkspaceRevisionConflictError extends Error {
  readonly code = 'workspace_revision_conflict'

  constructor(
    readonly path: string,
    readonly expectedRevision: number | null,
    readonly actualRevision: number | null,
  ) {
    super(
      `Workspace revision conflict at ${path}: expected ${expectedRevision ?? 'missing'}, `
      + `found ${actualRevision ?? 'missing'}`,
    )
    this.name = 'WorkspaceRevisionConflictError'
  }
}

export class WorkspaceCapacityError extends Error {
  readonly code = 'workspace_capacity_exceeded'

  constructor(readonly maximum: number, readonly requestedNewPaths: number) {
    super(`Workspace file limit reached (${maximum}); cannot reserve ${requestedNewPaths} new path(s)`)
    this.name = 'WorkspaceCapacityError'
  }
}

export class WorkspaceReservationConflictError extends Error {
  readonly code = 'workspace_reservation_conflict'

  constructor(readonly paths: string[]) {
    super(`Workspace paths are reserved by another operation: ${paths.join(', ')}`)
    this.name = 'WorkspaceReservationConflictError'
  }
}

export class WorkspaceReservationError extends Error {
  readonly code = 'workspace_reservation_invalid'

  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceReservationError'
  }
}

export class WorkspaceExecutionFenceError extends Error {
  readonly code = 'workspace_execution_fence_lost'

  constructor() {
    super('Workspace write rejected because the execution fence is no longer valid')
    this.name = 'WorkspaceExecutionFenceError'
  }
}

export class WorkspaceCanonicalArtifactConflictError extends Error {
  readonly code = 'workspace_canonical_artifact_conflict'

  constructor(readonly canonicalArtifactKey: string) {
    super(`Canonical artifact key already refers to different content: ${canonicalArtifactKey}`)
    this.name = 'WorkspaceCanonicalArtifactConflictError'
  }
}

export class WorkspaceCanonicalArtifactPendingError extends Error {
  readonly code = 'workspace_canonical_artifact_pending'

  constructor(readonly canonicalArtifactKey: string) {
    super(`Canonical artifact is currently being published: ${canonicalArtifactKey}`)
    this.name = 'WorkspaceCanonicalArtifactPendingError'
  }
}

export class WorkspaceProposalPublicationConflictError extends Error {
  readonly code = 'workspace_proposal_publication_conflict'

  constructor(readonly publicationKey: string, message: string) {
    super(message)
    this.name = 'WorkspaceProposalPublicationConflictError'
  }
}
