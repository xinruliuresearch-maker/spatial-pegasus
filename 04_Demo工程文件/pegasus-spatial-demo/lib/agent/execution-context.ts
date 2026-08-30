import { normalizeAgentTeamToolNameForExecution } from '../agent-team/policy'

export interface AgentExecutionContext {
  userId: string
  conversationId: string
  runId: string
  teamId?: string
  agentId?: string
  agentSessionId?: string
  taskId?: string
  isRoot: boolean
  policyVersion?: number
  workspaceId?: string
  /** Current AgentRun lease owner; used as the write/control fence. */
  executionFenceToken?: string
  /** Background Team worker acquired both execution-slot and session fences. */
  teamFenceRequired?: boolean
  agentAlias?: string
  agentRole?: string
  agentInstructions?: string
  allowedTools?: readonly string[]
  canDelegateTasks?: boolean
}

export interface ToolExecutionInvocation {
  toolUseId: string
  actionId: string
  turn: number
}

export function toolCommandKey(
  context: Pick<AgentExecutionContext, 'runId'>,
  invocation: Pick<ToolExecutionInvocation, 'toolUseId'>,
): string {
  return `${context.runId}:${invocation.toolUseId}`
}

export function canExecuteTool(
  context: AgentExecutionContext | undefined,
  toolName: string,
): boolean {
  if (!context?.allowedTools) return true
  const canonical = normalizeAgentTeamToolNameForExecution(toolName)
  return context.allowedTools.some(allowed => (
    normalizeAgentTeamToolNameForExecution(allowed) === canonical
  ))
}
