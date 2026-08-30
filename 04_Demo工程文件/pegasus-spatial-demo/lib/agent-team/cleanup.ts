import {
  WorkspaceCanonicalArtifact,
  WorkspaceCapacity,
  WorkspaceFile,
  WorkspaceFileRevision,
} from '../workspace/multi-agent'
import {
  AgentCommandReceiptModel,
  AgentExecutionSlotModel,
  AgentExecutionBudgetStateModel,
  AgentBudgetAdmissionModel,
  AgentExecutionTelemetryModel,
  AgentMailboxMessageModel,
  AgentResultModel,
  AgentSessionRuntimeModel,
  AgentTaskModel,
  AgentTeamModel,
  AgentWaitSubscriptionModel,
  DelegationGrantModel,
  TeamAgentModel,
  TeamEventModel,
  WorkspaceProposalModel,
} from './models'
import { agentTeamRepository } from './repository'

/** Delete project-scoped Team metadata after the owning Conversation is deleted. */
export async function deleteAgentTeamState(
  conversationId: string,
  userId: string,
): Promise<{ teams: number; records: number; workspace_records: number }> {
  await agentTeamRepository.connect()
  const teams = await AgentTeamModel.find({
    conversation_id: conversationId,
    user_id: userId,
  }).select('team_id workspace_id').lean<Array<{ team_id: string; workspace_id: string }>>()
  if (teams.length === 0) return { teams: 0, records: 0, workspace_records: 0 }
  const teamIds = teams.map(team => team.team_id)
  const workspaceIds = [...new Set(teams.map(team => team.workspace_id))]
  const deletions = await Promise.all([
    TeamAgentModel.deleteMany({ team_id: { $in: teamIds }, user_id: userId }),
    AgentSessionRuntimeModel.deleteMany({ team_id: { $in: teamIds }, user_id: userId }),
    DelegationGrantModel.deleteMany({ team_id: { $in: teamIds }, user_id: userId }),
    AgentTaskModel.deleteMany({ team_id: { $in: teamIds }, user_id: userId }),
    AgentMailboxMessageModel.deleteMany({ team_id: { $in: teamIds }, user_id: userId }),
    AgentResultModel.deleteMany({ team_id: { $in: teamIds }, user_id: userId }),
    WorkspaceProposalModel.deleteMany({ team_id: { $in: teamIds }, user_id: userId }),
    AgentWaitSubscriptionModel.deleteMany({ team_id: { $in: teamIds }, user_id: userId }),
    TeamEventModel.deleteMany({ team_id: { $in: teamIds }, user_id: userId }),
    AgentCommandReceiptModel.deleteMany({ team_id: { $in: teamIds }, user_id: userId }),
    AgentExecutionSlotModel.deleteMany({ team_id: { $in: teamIds }, user_id: userId }),
    AgentExecutionTelemetryModel.deleteMany({ team_id: { $in: teamIds }, user_id: userId }),
    AgentExecutionBudgetStateModel.deleteMany({ team_id: { $in: teamIds }, user_id: userId }),
    AgentBudgetAdmissionModel.deleteMany({ team_id: { $in: teamIds }, user_id: userId }),
  ])
  const workspaceDeletions = await Promise.all([
    WorkspaceFile.deleteMany({ workspace_id: { $in: workspaceIds } }),
    WorkspaceFileRevision.deleteMany({ workspace_id: { $in: workspaceIds } }),
    WorkspaceCapacity.deleteMany({ workspace_id: { $in: workspaceIds } }),
    WorkspaceCanonicalArtifact.deleteMany({ workspace_id: { $in: workspaceIds } }),
  ])
  const teamDeletion = await AgentTeamModel.deleteMany({
    team_id: { $in: teamIds },
    user_id: userId,
  })
  return {
    teams: teamDeletion.deletedCount,
    records: deletions.reduce((sum, result) => sum + result.deletedCount, 0),
    workspace_records: workspaceDeletions.reduce((sum, result) => sum + result.deletedCount, 0),
  }
}
