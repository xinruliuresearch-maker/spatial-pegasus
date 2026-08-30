import { isInternalWorkspacePath, normalizeWorkspacePath } from '../workspace/path-policy'
import { AgentPermissionError, InvalidAgentTeamOperationError } from './errors'
import { DelegationGrantModel } from './models'
import type { AgentContextReference, MailboxAttachmentReference } from './types'

type WorkspaceReference = AgentContextReference | MailboxAttachmentReference

const PRIVATE_AGENT_PATH = /^\.sci-pegasus\/agents\/([A-Za-z0-9_-]{1,128})\/.+/

export function normalizeWorkspaceReferences<T extends WorkspaceReference>(refs: readonly T[]): T[] {
  return refs.map(ref => {
    if (ref.kind !== 'workspace_path') return structuredClone(ref)
    return { ...structuredClone(ref), value: normalizeWorkspacePath(ref.value) }
  })
}

export function privatePathsFromReferences(refs: readonly WorkspaceReference[]): string[] {
  const result = new Set<string>()
  for (const ref of refs) {
    if (ref.kind !== 'workspace_path') continue
    const path = normalizeWorkspacePath(ref.value)
    if (PRIVATE_AGENT_PATH.test(path)) {
      result.add(path)
      continue
    }
    if (isInternalWorkspacePath(path)) {
      throw new InvalidAgentTeamOperationError(
        `Internal workspace path cannot be delegated: ${path}`,
      )
    }
  }
  return [...result]
}

export function assertCanDelegatePrivatePaths(input: {
  actorAgentId: string
  actorIsRoot: boolean
  actorAllowedReadPaths: readonly string[]
  paths: readonly string[]
}): void {
  if (input.actorIsRoot || input.paths.length === 0) return
  const allowed = new Set(input.actorAllowedReadPaths.map(normalizeWorkspacePath))
  for (const path of input.paths) {
    const owner = PRIVATE_AGENT_PATH.exec(path)?.[1]
    if (owner === input.actorAgentId || allowed.has(path)) continue
    throw new AgentPermissionError(`delegate_private_workspace_path:${path}`)
  }
}

/**
 * Exact path grants are derived from durable task/message references. They do
 * not expand capability or tool grants, so `$addToSet` is both idempotent and
 * safe to replay after a command-receipt crash window.
 */
export async function persistDelegatedPrivatePaths(input: {
  teamId: string
  userId: string
  recipientAgentId: string
  paths: readonly string[]
}): Promise<void> {
  if (input.paths.length === 0) return
  const updated = await DelegationGrantModel.updateOne(
    {
      team_id: input.teamId,
      user_id: input.userId,
      agent_id: input.recipientAgentId,
      active_key: `${input.teamId}:${input.recipientAgentId}`,
    },
    { $addToSet: { allowed_read_paths: { $each: [...new Set(input.paths)] } } },
  )
  if (updated.matchedCount !== 1) {
    throw new AgentPermissionError('recipient_active_delegation_grant')
  }
}
