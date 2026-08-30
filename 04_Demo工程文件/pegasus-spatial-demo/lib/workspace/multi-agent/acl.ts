import { assertWorkspaceWritePath, normalizeWorkspacePath } from '../path-policy'
import { WorkspaceAclError } from './errors'
import type {
  WorkspaceActor,
  WorkspaceFileSnapshot,
  WorkspaceFileVisibility,
} from './types'

const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/

export function agentPrivateRoot(agentId: string): string {
  if (!AGENT_ID.test(agentId)) throw new Error('Agent id is not safe for a workspace path')
  return `.sci-pegasus/agents/${agentId}`
}

export function isAgentPrivatePath(path: string, agentId: string): boolean {
  const normalized = normalizeWorkspacePath(path)
  return normalized.startsWith(`${agentPrivateRoot(agentId)}/`)
}

export function assertWorkspaceActor(actor: WorkspaceActor): void {
  if (!actor.teamId || !actor.agentId || !actor.rootAgentId) {
    throw new WorkspaceAclError('Workspace actor identity is incomplete')
  }
  if (actor.role === 'root' && actor.agentId !== actor.rootAgentId) {
    throw new WorkspaceAclError('Root role does not match the team root Agent')
  }
  if (actor.role === 'member' && actor.agentId === actor.rootAgentId) {
    throw new WorkspaceAclError('The root Agent cannot use a member role')
  }
}

export function assertWorkspaceReadAllowed(
  actor: WorkspaceActor,
  file: Pick<WorkspaceFileSnapshot, 'path' | 'visibility' | 'owner_agent_id' | 'writer'>,
): void {
  assertWorkspaceActor(actor)
  if (actor.teamId !== file.writer.team_id) {
    throw new WorkspaceAclError('Workspace file belongs to another Agent team')
  }
  if (actor.role === 'root' || file.visibility !== 'agent_private') return
  if (file.owner_agent_id === actor.agentId) return

  const granted = new Set(
    (actor.privatePathReferences ?? []).map(path => normalizeWorkspacePath(path)),
  )
  if (!granted.has(normalizeWorkspacePath(file.path))) {
    throw new WorkspaceAclError(`Private workspace path was not shared with Agent ${actor.agentId}`)
  }
}

export function assertWorkspaceWriteAllowed(input: {
  actor: WorkspaceActor
  path: string
  visibility: WorkspaceFileVisibility
  ownerAgentId?: string
}): string {
  const { actor, visibility, ownerAgentId } = input
  assertWorkspaceActor(actor)
  const path = assertWorkspaceWritePath(input.path)

  if (visibility === 'managed_reference') {
    if (!actor.managedReferenceTool) {
      throw new WorkspaceAclError('Managed reference files may only be committed by a trusted literature tool')
    }
    if (!path.startsWith('references/')) {
      throw new WorkspaceAclError('Managed reference files must be stored below references/')
    }
    if (ownerAgentId) throw new WorkspaceAclError('Managed reference files cannot have a private owner')
    return path
  }

  if (visibility === 'public') {
    const delegatedImageOutput = actor.publicWriteTool === 'GenerateImage'
      && /^output\/spatial\/images\/[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:png|jpe?g|webp)$/i.test(path)
    if (actor.role !== 'root' && !delegatedImageOutput) {
      throw new WorkspaceAclError('Only the root Agent may write public workspace paths')
    }
    if (path.startsWith('.sci-pegasus/agents/')) {
      throw new WorkspaceAclError('Agent-private paths cannot be published as public files')
    }
    if (ownerAgentId) throw new WorkspaceAclError('Public files cannot have a private owner')
    return path
  }

  if (ownerAgentId !== actor.agentId) {
    throw new WorkspaceAclError('An Agent may only own files in its own private workspace')
  }
  if (!isAgentPrivatePath(path, actor.agentId)) {
    throw new WorkspaceAclError(`Private writes must stay below ${agentPrivateRoot(actor.agentId)}/`)
  }
  return path
}
