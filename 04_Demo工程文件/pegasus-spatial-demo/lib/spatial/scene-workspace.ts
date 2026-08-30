import { randomUUID } from 'node:crypto'
import { getConversation } from '../db/repository'
import { agentTeamService } from '../agent-team/service'
import { createWorkspaceInstance } from '../workspace/instance'
import { spatialCreationWorkspace } from '../workspace/definitions/spatial-creation'
import { createMultiAgentWorkspaceBridge, MultiAgentWorkspaceRepository } from '../workspace/multi-agent'
import type { FileEntry, ManifestEntry, WorkspaceInstance } from '../workspace/types'

/** Build a one-request, owner-scoped public publication workspace for Stage screenshots. */
export async function createScenePublicationWorkspace(input: {
  conversationId: string
  userId: string
}): Promise<WorkspaceInstance> {
  const conversation = await getConversation(input.conversationId, input.userId)
  if (!conversation) throw new Error('Conversation not found')
  const team = await agentTeamService.ensureTeam({
    conversationId: input.conversationId, userId: input.userId, workspaceId: input.conversationId,
  })
  const rootAgent = await agentTeamService.getAgent({ teamId: team.team_id, userId: input.userId, agentId: team.root_agent_id })
  const runId = `scene_publication_${randomUUID()}`; const fence = randomUUID()
  const repository = new MultiAgentWorkspaceRepository({
    fenceValidator: ({ writer }) => writer.run_id === runId && writer.execution_fence_token === fence,
  })
  const bridge = await createMultiAgentWorkspaceBridge({
    repository, workspaceId: team.workspace_id,
    actor: { teamId: team.team_id, agentId: rootAgent.agent_id, rootAgentId: team.root_agent_id, role: 'root' },
    writer: { team_id: team.team_id, agent_id: rootAgent.agent_id, run_id: runId, execution_fence_token: fence },
    legacyFiles: conversation.output?.files as Record<string, FileEntry> | undefined,
  })
  return createWorkspaceInstance(
    spatialCreationWorkspace,
    bridge.projectedFiles,
    conversation.output?.manifest as Record<string, ManifestEntry> | undefined,
    {
      conversationId: input.conversationId, ownerUserId: input.userId,
      onFileMutations: bridge.onFileMutations, onFileSetBegin: bridge.onFileSetBegin,
      onFileSetFinalize: bridge.onFileSetFinalize, onFileSetAbort: bridge.onFileSetAbort,
    },
  )
}
