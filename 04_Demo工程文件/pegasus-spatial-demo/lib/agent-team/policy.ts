import {
  DEFAULT_MAX_ACTIVE_AGENTS,
  DEFAULT_MAX_TOTAL_AGENTS,
  DEFAULT_SUPERVISION_INTERVAL_MS,
  type AgentGrantCapabilities,
  type AgentBudget,
  type AgentMessageKind,
  type AgentTaskStatus,
  type AgentTeamPolicySnapshot,
  type DelegationGrantSnapshot,
} from './types'

export const ROOT_AGENT_TOOL_NAMES = [
  'Agent',
  'SendMessage',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'ReviewWorkspaceChanges',
  'ManageAgent',
] as const

export type RootAgentToolName = typeof ROOT_AGENT_TOOL_NAMES[number]

/**
 * Historical names are accepted by the execution adapter so a persisted Run
 * can replay an already-issued tool call. They are deliberately absent from
 * ROOT_AGENT_TOOL_NAMES and from the model-facing schemas.
 */
export const LEGACY_AGENT_TEAM_TOOL_NAMES = [
  'CreateAgent',
  'AssignAgentTask',
  'SendAgentMessage',
  'InspectAgentTeam',
  'WaitForAgents',
  'SubmitAgentResult',
  'ReviewAgentResult',
] as const

export type LegacyAgentTeamToolName = typeof LEGACY_AGENT_TEAM_TOOL_NAMES[number]

const LEGACY_TOOL_CANONICAL_NAME: Record<LegacyAgentTeamToolName, RootAgentToolName> = {
  CreateAgent: 'Agent',
  AssignAgentTask: 'TaskCreate',
  SendAgentMessage: 'SendMessage',
  InspectAgentTeam: 'TaskList',
  // Wait/result submission have moved into durable runtime turn boundaries.
  // These mappings authorize replay only; neither legacy name is advertised.
  WaitForAgents: 'TaskList',
  SubmitAgentResult: 'TaskUpdate',
  ReviewAgentResult: 'ReviewWorkspaceChanges',
}

export function normalizeAgentTeamToolNameForExecution(name: string): string {
  return LEGACY_TOOL_CANONICAL_NAME[name as LegacyAgentTeamToolName] ?? name
}

export function isLegacyAgentTeamToolName(name: string): name is LegacyAgentTeamToolName {
  return (LEGACY_AGENT_TEAM_TOOL_NAMES as readonly string[]).includes(name)
}

const MANAGED_REFERENCE_WRITER_TOOLS = new Set([
  'SciverseSearchPapers',
  'SciverseSearchEvidence',
  'SciverseFetchPaper',
  'SciverseListRelations',
  'ArxivSearchPapers',
  'ArxivFetchPaper',
])

export function toolAllowlistNeedsReferencePublishing(toolNames: readonly string[]): boolean {
  return toolNames.includes('*') || toolNames.some(name => MANAGED_REFERENCE_WRITER_TOOLS.has(name))
}

export const ROOT_CAPABILITIES: AgentGrantCapabilities = {
  is_coordinator: true,
  can_create_agents: true,
  can_delegate_tasks: true,
  can_message_agents: true,
  can_inspect_team: true,
  can_wait_for_agents: true,
  can_submit_results: true,
  can_review_results: true,
  can_manage_agents: true,
  can_read_public_workspace: true,
  can_write_private_workspace: true,
  can_publish_references: true,
  can_ask_user: true,
}

export const MEMBER_CAPABILITIES: AgentGrantCapabilities = {
  is_coordinator: false,
  can_create_agents: false,
  can_delegate_tasks: false,
  can_message_agents: true,
  can_inspect_team: true,
  can_wait_for_agents: true,
  can_submit_results: true,
  can_review_results: false,
  can_manage_agents: false,
  can_read_public_workspace: true,
  can_write_private_workspace: true,
  can_publish_references: false,
  can_ask_user: false,
}

const TOOL_CAPABILITY: Record<RootAgentToolName, keyof AgentGrantCapabilities> = {
  Agent: 'can_create_agents',
  SendMessage: 'can_message_agents',
  TaskCreate: 'can_delegate_tasks',
  // Every member can maintain the status/description of its own task. The
  // service separately gates reassignment and dependency edits on delegation.
  TaskUpdate: 'can_inspect_team',
  TaskList: 'can_inspect_team',
  TaskGet: 'can_inspect_team',
  ReviewWorkspaceChanges: 'can_review_results',
  ManageAgent: 'can_manage_agents',
}

export function defaultTeamPolicy(): AgentTeamPolicySnapshot {
  return {
    version: 1,
    strategy_version: 1,
    max_active_agents: DEFAULT_MAX_ACTIVE_AGENTS,
    max_total_agents: DEFAULT_MAX_TOTAL_AGENTS,
    supervision_interval_ms: DEFAULT_SUPERVISION_INTERVAL_MS,
  }
}

export function rootDelegationGrant(): DelegationGrantSnapshot {
  return {
    capabilities: { ...ROOT_CAPABILITIES },
    allowed_tool_names: ['*'],
    allowed_read_paths: ['**'],
  }
}

export function memberDelegationGrant(
  overrides: Omit<Partial<DelegationGrantSnapshot>, 'capabilities'> & {
    capabilities?: Partial<AgentGrantCapabilities>
  } = {},
): DelegationGrantSnapshot {
  const requested = overrides.capabilities ?? {}
  // Product invariants: coordinator and user/publication authority are Root-only.
  const capabilities: AgentGrantCapabilities = {
    ...MEMBER_CAPABILITIES,
    ...requested,
    is_coordinator: false,
    can_create_agents: false,
    can_review_results: false,
    can_manage_agents: false,
    can_ask_user: false,
  }
  return {
    capabilities,
    allowed_tool_names: [...(overrides.allowed_tool_names ?? [])],
    allowed_read_paths: [...(overrides.allowed_read_paths ?? [])],
    ...(overrides.budget ? { budget: { ...overrides.budget } } : {}),
  }
}

export function visibleAgentTeamTools(grant: DelegationGrantSnapshot): RootAgentToolName[] {
  return ROOT_AGENT_TOOL_NAMES.filter(name => grant.capabilities[TOOL_CAPABILITY[name]])
}

export function isToolAllowlistSubset(childTools: string[], parentTools: string[]): boolean {
  if (parentTools.includes('*')) return true
  if (childTools.includes('*')) return false
  const parent = new Set(parentTools)
  return childTools.every(tool => parent.has(tool))
}

export function isBudgetWithin(child: AgentBudget | undefined, ceiling: AgentBudget | undefined): boolean {
  if (!child || !ceiling) return true
  const keys: Array<keyof AgentBudget> = [
    'max_tokens',
    'max_cost_usd',
    'max_tool_calls',
    'max_download_bytes',
  ]
  return keys.every(key => {
    const requested = child[key]
    const allowed = ceiling[key]
    return requested === undefined || allowed === undefined || requested <= allowed
  })
}

export function shouldWakeForMessage(kind: AgentMessageKind, observer: boolean): boolean {
  if (observer) return kind === 'blocker' || kind === 'error'
  // A direct Agent message has the same interaction semantics as a new user
  // turn: it wakes an idle recipient regardless of its supervision label.
  return true
}

export const READY_TASK_STATUSES: ReadonlySet<AgentTaskStatus> = new Set([
  'submitted',
  'accepted',
  'failed',
  'cancelled',
])

export function taskWaitSatisfied(
  statuses: AgentTaskStatus[],
  mode: 'all' | 'any',
): boolean {
  if (statuses.length === 0) return true
  return mode === 'all'
    ? statuses.every(status => READY_TASK_STATUSES.has(status))
    : statuses.some(status => READY_TASK_STATUSES.has(status))
}

export function normalizeAgentName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
}

export function privateWorkspacePrefix(agentId: string): string {
  return `.sci-pegasus/agents/${agentId}/`
}

export function isAgentPrivatePath(agentId: string, path: string): boolean {
  const normalized = path.replaceAll('\\', '/').replace(/^\/+/, '')
  return normalized.startsWith(privateWorkspacePrefix(agentId))
    && !normalized.split('/').includes('..')
}

export function buildCommandKey(runId: string, toolUseId: string, commandName: string): string {
  return `${runId}:${toolUseId}:${commandName}`
}
