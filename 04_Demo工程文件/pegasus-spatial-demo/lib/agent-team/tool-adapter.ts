import { createHash } from 'node:crypto'
import type { AgentExecutionContext, ToolExecutionInvocation } from '../agent/execution-context'
import type { ToolResult } from '../types'
import {
  getActiveAgentRun,
  getActiveAgentRunForSession,
  requestAgentSessionRunCancellation,
  requestRunCancellation,
  validateAgentRunLeaseFence,
} from '../agent-runtime/repository'
import {
  MultiAgentWorkspaceRepository,
  WorkspaceAclError,
  WorkspaceCapacityError,
  WorkspaceProposalPublicationConflictError,
  WorkspaceRevisionConflictError,
} from '../workspace/multi-agent'
import {
  assertWorkspaceWritePath,
  normalizeWorkspacePath,
} from '../workspace/path-policy'
import { AgentTeamError, InvalidAgentTeamOperationError } from './errors'
import { agentTeamService } from './service'
import {
  LEGACY_AGENT_TEAM_TOOL_NAMES,
  ROOT_AGENT_TOOL_NAMES,
  normalizeAgentName,
} from './policy'
import { validateExecutionFence } from './repository'
import type {
  AgentBudget,
  AgentCommandContext,
  AgentContextReference,
  AgentMessageKind,
  AgentResultRecord,
  AgentTaskStatus,
  MailboxAttachmentReference,
  TeamAgentRecord,
  WorkspaceProposalRecord,
} from './types'
import {
  deliverRootMailbox,
  resumeWaitingAgentById,
  scheduleNextAgentTask,
  scheduleReadyAgents,
  wakeMemberForMailbox,
  wakeRootWithUpdate,
} from './orchestrator'

const TEAM_TOOL_NAMES = new Set<string>([
  ...ROOT_AGENT_TOOL_NAMES,
  ...LEGACY_AGENT_TEAM_TOOL_NAMES,
])

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function expectedWorkspaceRevision(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  throw new InvalidAgentTeamOperationError(
    'expected_target_revision must be a non-negative integer when provided.',
  )
}

function proposalPublicationKey(proposalId: string, targetPath: string): string {
  const targetDigest = createHash('sha256').update(targetPath).digest('hex').slice(0, 32)
  return `workspace-proposal:${proposalId}:${targetDigest}`
}

function isDeterministicPublicationError(error: unknown): error is Error & { code?: string } {
  if (
    error instanceof WorkspaceAclError
    || error instanceof WorkspaceCapacityError
    || error instanceof WorkspaceProposalPublicationConflictError
    || error instanceof WorkspaceRevisionConflictError
  ) return true
  if (!(error instanceof Error)) return false
  // Path-policy validation intentionally uses plain Error because it is also
  // shared by the legacy in-memory Workspace. These failures are input/state
  // conflicts, not transient database or execution-fence failures.
  return /^(Workspace path|Workspace root|Root-level workspace|Unsupported workspace file extension)/.test(
    error.message,
  )
}

function budget(value: unknown): AgentBudget | undefined {
  const input = record(value)
  if (Object.keys(input).length === 0) return undefined
  const allowedKeys = new Set([
    'max_tokens',
    'max_cost_usd',
    'max_tool_calls',
    'max_download_bytes',
  ])
  const unexpected = Object.keys(input).find(key => !allowedKeys.has(key))
  if (unexpected) {
    throw new InvalidAgentTeamOperationError(`Unknown budget field: ${unexpected}.`)
  }
  const numeric = (key: string, integer: boolean): number | undefined => {
    const candidate = input[key]
    if (candidate === undefined) return undefined
    if (
      typeof candidate !== 'number'
      || !Number.isFinite(candidate)
      || candidate < 0
      || (integer && !Number.isSafeInteger(candidate))
    ) {
      throw new InvalidAgentTeamOperationError(
        `${key} must be a finite non-negative${integer ? ' integer' : ' number'}.`,
      )
    }
    return candidate
  }
  return {
    max_tokens: numeric('max_tokens', true),
    max_cost_usd: numeric('max_cost_usd', false),
    max_tool_calls: numeric('max_tool_calls', true),
    max_download_bytes: numeric('max_download_bytes', true),
  }
}

const TASK_STATUSES = new Set<AgentTaskStatus>([
  'queued',
  'running',
  'waiting',
  'submitted',
  'accepted',
  'rework',
  'failed',
  'cancelled',
])

function taskStatus(value: unknown): AgentTaskStatus | undefined {
  const candidate = text(value)
  if (!candidate) return undefined
  if (!TASK_STATUSES.has(candidate as AgentTaskStatus)) {
    throw new InvalidAgentTeamOperationError(`Unknown Task status: ${candidate}.`)
  }
  return candidate as AgentTaskStatus
}

function contextReference(value: string): AgentContextReference {
  if (/^https?:\/\//i.test(value)) return { kind: 'url', value }
  const explicit = /^(workspace_path|evidence|paper|task|message|url):([\s\S]+)$/.exec(value)
  if (explicit) {
    const kind = explicit[1] as AgentContextReference['kind']
    const referencedValue = explicit[2].trim()
    return {
      kind,
      value: kind === 'workspace_path'
        ? normalizeWorkspacePath(referencedValue)
        : referencedValue,
    }
  }
  return { kind: 'workspace_path', value: normalizeWorkspacePath(value) }
}

function attachmentReference(value: string): MailboxAttachmentReference {
  const ref = contextReference(value)
  if (ref.kind === 'workspace_path') {
    ref.value = normalizeWorkspacePath(ref.value)
  }
  return {
    kind: ref.kind === 'message' ? 'evidence' : ref.kind,
    value: ref.value,
  } as MailboxAttachmentReference
}

function objectiveTitle(objective: string): string {
  const first = objective.split(/\r?\n/, 1)[0].trim()
  return first.length <= 120 ? first : `${first.slice(0, 117)}...`
}

function jsonResult(value: unknown, control?: ToolResult['control']): ToolResult {
  return {
    content: JSON.stringify(value, null, 2),
    ...(control ? { control } : {}),
  }
}

function errorResult(error: unknown): ToolResult {
  if (error instanceof AgentTeamError) {
    return {
      content: JSON.stringify({
        error: error.message,
        code: error.code,
        details: error.details,
      }, null, 2),
      is_error: true,
    }
  }
  return {
    content: `Agent Team tool failed: ${error instanceof Error ? error.message : String(error)}`,
    is_error: true,
  }
}

function commandContext(
  execution: AgentExecutionContext,
  invocation: ToolExecutionInvocation,
): AgentCommandContext {
  if (!execution.teamId || !execution.agentId) {
    throw new Error('Agent Team execution context is incomplete.')
  }
  return {
    team_id: execution.teamId,
    user_id: execution.userId,
    caller_agent_id: execution.agentId,
    run_id: execution.runId,
    tool_use_id: invocation.toolUseId,
    execution_owner_id: execution.executionFenceToken,
    agent_session_id: execution.agentSessionId,
    team_fence_required: execution.teamFenceRequired === true,
    require_execution_fence: true,
  }
}

function derivedCommandContext(
  command: AgentCommandContext,
  suffix: string,
): AgentCommandContext {
  return {
    ...command,
    tool_use_id: `${command.tool_use_id}:${suffix}`,
  }
}

async function teamSnapshot(command: AgentCommandContext) {
  return agentTeamService.inspectTeam({
    teamId: command.team_id,
    userId: command.user_id,
    callerAgentId: command.caller_agent_id,
  })
}

async function resolveAgentReference(
  command: AgentCommandContext,
  reference: string,
): Promise<TeamAgentRecord> {
  const value = reference.trim()
  if (!value) throw new InvalidAgentTeamOperationError('An Agent name is required.')
  // Name resolution is an internal addressing step guarded by the calling
  // tool's own capability. It must not accidentally require TaskList access.
  const snapshot = await agentTeamService.inspectTeam({
    teamId: command.team_id,
    userId: command.user_id,
  })
  const normalized = normalizeAgentName(value)
  const agent = snapshot.agents.find(candidate => (
    candidate.agent_id === value
    || candidate.normalized_name === normalized
  ))
  if (!agent) {
    throw new InvalidAgentTeamOperationError(`No Agent named "${value}" exists in this project.`)
  }
  return agent
}

async function wakeMessageRecipient(input: {
  command: AgentCommandContext
  recipient: TeamAgentRecord
  messageId: string
  kind: AgentMessageKind
}): Promise<string | null> {
  const team = await agentTeamService.getTeam({
    teamId: input.command.team_id,
    userId: input.command.user_id,
  })
  let wakeRunId: string | null = null
  if (input.recipient.agent_id === team.root_agent_id) {
    wakeRunId = (await deliverRootMailbox(team)).run_id
  } else {
    // The model-facing SendMessage has user-turn semantics: every direct
    // message wakes an idle peer. The persisted kind remains useful for Root
    // supervision, while the wake transport only distinguishes review copy.
    wakeRunId = await wakeMemberForMailbox({
      teamId: team.team_id,
      userId: team.user_id,
      agentId: input.recipient.agent_id,
      messageId: input.messageId,
      kind: input.kind === 'review' ? 'review' : 'request',
    })
  }
  if (input.kind === 'blocker' || input.kind === 'error') {
    wakeRunId ??= (await deliverRootMailbox(team)).run_id
  }
  return wakeRunId
}

function taskOwnerName(
  assignedAgentId: string,
  agents: readonly TeamAgentRecord[],
): string {
  return agents.find(agent => agent.agent_id === assignedAgentId)?.display_name
    ?? assignedAgentId
}

export function compactPendingWorkspaceChanges(
  proposals: readonly WorkspaceProposalRecord[],
  agents: readonly TeamAgentRecord[],
) {
  return proposals
    .filter(proposal => ['pending', 'approved', 'conflict'].includes(proposal.status))
    .map(proposal => ({
      result_id: proposal.result_id,
      ...(proposal.task_id ? { task_id: proposal.task_id } : {}),
      agent: taskOwnerName(proposal.agent_id, agents),
      proposal_item_id: proposal.proposal_id,
      source_path: proposal.source_path,
      target_path: proposal.target_path,
      status: proposal.status,
      expected_target_revision: proposal.expected_target_revision ?? undefined,
    }))
}

export function compactRecentTurnResults(
  results: readonly AgentResultRecord[],
  proposals: readonly WorkspaceProposalRecord[],
  agents: readonly TeamAgentRecord[],
  limit = 50,
) {
  const boundedLimit = Math.max(0, Math.min(limit, 50))
  return results.slice(0, boundedLimit).map(result => {
    const response = result.final_response.trim()
    return {
      result_id: result.result_id,
      ...(result.task_id ? { task_id: result.task_id } : {}),
      agent: taskOwnerName(result.agent_id, agents),
      outcome: result.outcome,
      final_response_summary: response.length <= 800
        ? response
        : `${response.slice(0, 797)}...`,
      proposal_count: proposals.filter(proposal => proposal.result_id === result.result_id).length,
      created_at: result.created_at,
    }
  })
}

async function dispatchMessage(input: {
  command: AgentCommandContext
  recipient: TeamAgentRecord
  kind: AgentMessageKind
  message: string
  summary?: string
  taskId?: string
  replyToMessageId?: string
  attachments?: MailboxAttachmentReference[]
}) {
  const payload: Parameters<typeof agentTeamService.sendMessage>[1] & {
    summary?: string
  } = {
    recipientAgentId: input.recipient.agent_id,
    kind: input.kind,
    content: input.message,
    summary: input.summary,
    taskId: input.taskId,
    replyToMessageId: input.replyToMessageId,
    attachments: input.attachments,
  }
  const sent = await agentTeamService.sendMessage(input.command, payload)
  const wakeRunId = await wakeMessageRecipient({
    command: input.command,
    recipient: input.recipient,
    messageId: sent.message.message_id,
    kind: input.kind,
  })
  const team = await agentTeamService.getTeam({
    teamId: input.command.team_id,
    userId: input.command.user_id,
  })
  for (const agentId of sent.wake_agent_ids) {
    await resumeWaitingAgentById({
      teamId: team.team_id,
      userId: team.user_id,
      agentId,
      reason: `Mailbox message ${sent.message.message_id} requires attention.`,
    })
  }
  return {
    message: sent.message,
    recipient_name: input.recipient.display_name,
    wake_run_id: wakeRunId,
  }
}

function modelMessageReceipt(delivery: Awaited<ReturnType<typeof dispatchMessage>>) {
  return {
    message_id: delivery.message.message_id,
    to: delivery.recipient_name,
    summary: delivery.message.summary ?? undefined,
    task_id: delivery.message.task_id ?? undefined,
    wake_run_id: delivery.wake_run_id,
  }
}

export function isAgentTeamTool(name: string): boolean {
  return TEAM_TOOL_NAMES.has(name)
}

export async function executeAgentTeamTool(
  name: string,
  input: Record<string, unknown>,
  execution: AgentExecutionContext | undefined,
  invocation: ToolExecutionInvocation | undefined,
): Promise<ToolResult> {
  if (!isAgentTeamTool(name)) {
    return { content: `Unknown Agent Team tool: ${name}`, is_error: true }
  }
  if (!execution || !invocation || !execution.teamId || !execution.agentId) {
    return { content: `${name} requires a durable Agent Run context.`, is_error: true }
  }
  const command = commandContext(execution, invocation)

  try {
    switch (name) {
      case 'Agent': {
        const agentName = text(input.name)
        const shortDescription = text(input.description)
        const prompt = text(input.prompt)
        const allowedTools = input.allowed_tools === undefined
          ? ['*']
          : strings(input.allowed_tools)
        const created = await agentTeamService.createAgent(command, {
          displayName: agentName,
          role: text(input.role) || shortDescription,
          instructions: text(input.instructions) || undefined,
          grant: {
            allowed_tool_names: allowedTools,
            capabilities: {
              can_delegate_tasks: input.can_delegate_tasks === true,
            },
            budget: budget(input.budget),
          },
        })
        const firstMessage = await dispatchMessage({
          command: derivedCommandContext(command, `initial-message:${created.agent.agent_id}`),
          recipient: created.agent,
          kind: 'request',
          message: prompt,
          summary: shortDescription,
          attachments: strings(input.refs).map(attachmentReference),
        })
        return jsonResult({
          agent: {
            name: created.agent.display_name,
            role: created.agent.role,
            status: created.agent.status,
            generation: created.agent.generation,
            private_workspace: created.agent.private_workspace_prefix,
          },
          first_message: modelMessageReceipt(firstMessage),
          scheduled_run_id: firstMessage.wake_run_id,
        })
      }

      case 'SendMessage': {
        const recipientRef = text(input.to)
        const message = text(input.message)
        const summary = text(input.summary) || undefined
        const attachments = strings(input.refs).map(attachmentReference)
        if (recipientRef === '*') {
          const snapshot = await teamSnapshot(command)
          if (snapshot.team.root_agent_id !== command.caller_agent_id) {
            throw new InvalidAgentTeamOperationError('Only Root may broadcast to every Agent.')
          }
          const plannedRecipientIds = await agentTeamService.planBroadcast(command)
          const byId = new Map(snapshot.agents.map(agent => [agent.agent_id, agent]))
          const recipients = plannedRecipientIds
            .map(agentId => byId.get(agentId))
            .filter((agent): agent is TeamAgentRecord => Boolean(agent))
          const deliveries = []
          for (const recipient of recipients) {
            // A recipient can be explicitly closed after the durable audience
            // was frozen but before a crash replay reaches it. Closing wins;
            // never retarget the old broadcast to a newly-created Agent.
            if (recipient.status === 'completed') {
              deliveries.push({
                message: null,
                recipient_name: recipient.display_name,
                wake_run_id: null,
                skipped: 'recipient_completed',
              })
              continue
            }
            deliveries.push(await dispatchMessage({
              command: derivedCommandContext(command, `broadcast:${recipient.agent_id}`),
              recipient,
              kind: 'request',
              message,
              summary,
              taskId: text(input.task_id) || undefined,
              attachments,
            }))
          }
          return jsonResult({
            broadcast: true,
            deliveries: deliveries.map(delivery => (
              delivery.message ? modelMessageReceipt(delivery) : {
                to: delivery.recipient_name,
                skipped: delivery.skipped,
              }
            )),
          })
        }
        const recipient = await resolveAgentReference(command, recipientRef)
        const delivered = await dispatchMessage({
          command,
          recipient,
          kind: 'request',
          message,
          summary,
          taskId: text(input.task_id) || undefined,
          attachments,
        })
        return jsonResult(modelMessageReceipt(delivered))
      }

      case 'TaskCreate': {
        const owner = await resolveAgentReference(command, text(input.owner))
        const task = await agentTeamService.assignTask(command, {
          assignedAgentId: owner.agent_id,
          title: text(input.subject),
          objective: text(input.description),
          acceptanceCriteria: strings(input.acceptance_criteria),
          contextRefs: strings(input.context_refs).map(contextReference),
          dependencyTaskIds: strings(input.blocked_by),
          budget: budget(input.budget),
        })
        const scheduledRunId = await scheduleNextAgentTask({
          teamId: command.team_id,
          userId: command.user_id,
          agentId: task.assigned_agent_id,
        })
        return jsonResult({
          task: {
            id: task.task_id,
            subject: task.title,
            description: task.objective,
            owner: owner.display_name,
            status: task.status,
            blocked_by: task.dependency_task_ids,
          },
          scheduled_run_id: scheduledRunId,
        })
      }

      case 'TaskUpdate': {
        const owner = text(input.owner)
          ? await resolveAgentReference(command, text(input.owner))
          : undefined
        const updated = await agentTeamService.updateTask(command, {
          taskId: text(input.task_id),
          status: taskStatus(input.status),
          title: text(input.subject) || undefined,
          objective: text(input.description) || undefined,
          ownerAgentId: owner?.agent_id,
          dependencyTaskIds: input.blocked_by === undefined
            ? undefined
            : strings(input.blocked_by),
          acceptanceCriteria: input.acceptance_criteria === undefined
            ? undefined
            : strings(input.acceptance_criteria),
        })
        if (['queued', 'rework'].includes(updated.status)) {
          await scheduleNextAgentTask({
            teamId: command.team_id,
            userId: command.user_id,
            agentId: updated.assigned_agent_id,
          })
        } else if (['accepted', 'failed', 'cancelled'].includes(updated.status)) {
          await scheduleReadyAgents(command.team_id, command.user_id)
        }
        const snapshot = await teamSnapshot(command)
        return jsonResult({
          task: {
            id: updated.task_id,
            subject: updated.title,
            description: updated.objective,
            owner: taskOwnerName(updated.assigned_agent_id, snapshot.agents),
            status: updated.status,
            blocked_by: updated.dependency_task_ids,
            acceptance_criteria: updated.acceptance_criteria,
          },
        })
      }

      case 'TaskList': {
        const snapshot = await teamSnapshot(command)
        return jsonResult({
          agents: snapshot.agents.map(agent => ({
            name: agent.display_name,
            role: agent.role,
            status: agent.status,
            generation: agent.generation,
            last_transition_at: agent.last_transition_at,
          })),
          counts: snapshot.counts,
          pending_workspace_changes: compactPendingWorkspaceChanges(
            snapshot.proposals,
            snapshot.agents,
          ),
          recent_turn_results: compactRecentTurnResults(
            snapshot.results,
            snapshot.proposals,
            snapshot.agents,
          ),
          tasks: snapshot.tasks.map(task => ({
            id: task.task_id,
            subject: task.title,
            status: task.status,
            owner: taskOwnerName(task.assigned_agent_id, snapshot.agents),
            blocked_by: task.dependency_task_ids,
            updated_at: task.updated_at,
          })),
        })
      }

      case 'TaskGet': {
        const snapshot = await agentTeamService.inspectTeam({
          teamId: command.team_id,
          userId: command.user_id,
          callerAgentId: command.caller_agent_id,
          includeMessages: true,
          messageLimit: 200,
        })
        const taskId = text(input.task_id)
        const task = snapshot.tasks.find(candidate => candidate.task_id === taskId)
        if (!task) throw new InvalidAgentTeamOperationError(`Task ${taskId} was not found in this project.`)
        return jsonResult({
          task: {
            id: task.task_id,
            subject: task.title,
            description: task.objective,
            acceptance_criteria: task.acceptance_criteria,
            context_refs: task.context_refs,
            owner: taskOwnerName(task.assigned_agent_id, snapshot.agents),
            status: task.status,
            blocked_by: task.dependency_task_ids,
            result_ids: task.result_ids,
            active_result_id: task.active_result_id,
            created_at: task.created_at,
            updated_at: task.updated_at,
          },
          results: snapshot.results.filter(result => result.task_id === task.task_id),
          proposals: snapshot.proposals.filter(proposal => proposal.task_id === task.task_id),
          messages: (snapshot.messages ?? [])
            .filter(message => message.task_id === task.task_id)
            .map(message => ({
              id: message.message_id,
              from: taskOwnerName(message.sender_agent_id, snapshot.agents),
              to: taskOwnerName(message.recipient_agent_id, snapshot.agents),
              kind: message.kind,
              summary: (message as typeof message & { summary?: string }).summary
                || message.content.slice(0, 120),
              content: message.content,
              created_at: message.created_at,
            })),
        })
      }

      case 'CreateAgent': {
        const initial = record(input.initial_task)
        const allowedTools = strings(input.allowed_tools)
        const created = await agentTeamService.createAgent(command, {
          displayName: text(input.alias),
          role: text(input.role),
          instructions: text(input.instructions),
          grant: {
            allowed_tool_names: allowedTools,
            capabilities: {
              can_delegate_tasks: input.can_delegate_tasks === true,
            },
            budget: budget(input.budget),
          },
          ...(Object.keys(initial).length > 0 ? {
            initialTask: {
              title: objectiveTitle(text(initial.objective)),
              objective: text(initial.objective),
              acceptanceCriteria: strings(initial.acceptance_criteria),
              contextRefs: strings(initial.context_refs).map(contextReference),
              budget: budget(input.budget),
            },
          } : {}),
        })
        const scheduledRunId = created.task
          ? await scheduleNextAgentTask({
              teamId: command.team_id,
              userId: command.user_id,
              agentId: created.agent.agent_id,
            })
          : null
        return jsonResult({
          agent: {
            agent_id: created.agent.agent_id,
            alias: created.agent.display_name,
            role: created.agent.role,
            status: created.agent.status,
            generation: created.agent.generation,
            private_workspace: created.agent.private_workspace_prefix,
          },
          task_id: created.task?.task_id,
          scheduled_run_id: scheduledRunId,
        })
      }

      case 'AssignAgentTask': {
        const objective = text(input.objective)
        const task = await agentTeamService.assignTask(command, {
          assignedAgentId: text(input.agent_id),
          title: objectiveTitle(objective),
          objective,
          acceptanceCriteria: strings(input.acceptance_criteria),
          contextRefs: strings(input.context_refs).map(contextReference),
          dependencyTaskIds: strings(input.depends_on),
          budget: budget(input.budget),
        })
        const scheduledRunId = await scheduleNextAgentTask({
          teamId: command.team_id,
          userId: command.user_id,
          agentId: task.assigned_agent_id,
        })
        return jsonResult({ task, scheduled_run_id: scheduledRunId })
      }

      case 'SendAgentMessage': {
        const kind = text(input.kind) as AgentMessageKind
        const recipient = await resolveAgentReference(command, text(input.to_agent_id))
        const sent = await dispatchMessage({
          command,
          recipient,
          kind,
          message: text(input.message),
          summary: text(input.summary) || undefined,
          taskId: text(input.task_id) || undefined,
          replyToMessageId: text(input.reply_to) || undefined,
          attachments: strings(input.refs).map(attachmentReference),
        })
        return jsonResult(sent)
      }

      case 'InspectAgentTeam': {
        const snapshot = await agentTeamService.inspectTeam({
          teamId: command.team_id,
          userId: command.user_id,
          callerAgentId: command.caller_agent_id,
          includeMessages: input.include_recent_messages === true,
          messageLimit: 200,
        })
        const afterSeq = Number(input.after_seq)
        const events = Number.isSafeInteger(afterSeq) && afterSeq >= 0
          ? await agentTeamService.listEventsAfter({
              teamId: command.team_id,
              userId: command.user_id,
              afterSeq,
              limit: 500,
            })
          : undefined
        const agentIds = new Set(strings(input.agent_ids))
        const taskIds = new Set(strings(input.task_ids))
        return jsonResult({
          team: snapshot.team,
          agents: agentIds.size
            ? snapshot.agents.filter(agent => agentIds.has(agent.agent_id))
            : snapshot.agents,
          tasks: taskIds.size
            ? snapshot.tasks.filter(task => taskIds.has(task.task_id))
            : snapshot.tasks,
          counts: snapshot.counts,
          latest_event_seq: snapshot.latest_event_seq,
          ...(events ? { events } : {}),
          ...(input.include_results === false ? {} : { results: snapshot.results, proposals: snapshot.proposals }),
          ...(snapshot.messages ? { messages: snapshot.messages } : {}),
        })
      }

      case 'WaitForAgents': {
        const waiting = await agentTeamService.createWaitSubscription(command, {
          taskIds: strings(input.task_ids),
          mode: text(input.mode, 'all') as 'all' | 'any',
          timeoutMs: Math.max(10, Number(input.timeout_seconds) || 120) * 1_000,
        })
        return jsonResult(
          waiting,
          waiting.subscription.status === 'waiting' ? 'wait_agents' : undefined,
        )
      }

      case 'SubmitAgentResult': {
        const proposedFiles = Array.isArray(input.proposed_files)
          ? input.proposed_files.map(item => record(item))
          : []
        const outcome = text(input.outcome, 'completed')
        if (!['completed', 'blocked', 'failed'].includes(outcome)) {
          throw new InvalidAgentTeamOperationError(
            'outcome must be completed, blocked, or failed.',
          )
        }
        const summary = text(input.summary)
        const submitted = await agentTeamService.submitResult(command, {
          taskId: text(input.task_id),
          outcome: outcome as 'completed' | 'blocked' | 'failed',
          finalResponse: summary,
          summary: {
            outcome,
            summary,
            findings: Array.isArray(input.findings) ? input.findings : [],
          },
          evidenceRefs: strings(input.refs).map(contextReference),
          files: proposedFiles.map(file => ({
            source_path: text(file.source_path),
            suggested_target_path: text(file.target_path) || undefined,
          })),
        })
        const team = await agentTeamService.getTeam({
          teamId: command.team_id,
          userId: command.user_id,
        })
        await wakeRootWithUpdate({
          team,
          content: `Agent ${submitted.result.agent_id} submitted ${submitted.result.outcome} result ${submitted.result.result_id} for task ${submitted.result.task_id}.\n\n${submitted.result.final_response}\n\nInspect the result and review each publication proposal.`,
          sourceIds: [submitted.result.result_id],
          deliveryKey: `root-result:${team.team_id}:${submitted.result.result_id}`,
        })
        for (const agentId of submitted.wake_agent_ids) {
          if (agentId === team.root_agent_id) continue
          await resumeWaitingAgentById({
            teamId: team.team_id,
            userId: team.user_id,
            agentId,
            reason: `Task ${submitted.result.task_id} submitted result ${submitted.result.result_id}.`,
          })
        }
        return jsonResult(submitted, 'task_submitted')
      }

      case 'ReviewWorkspaceChanges':
      case 'ReviewAgentResult': {
        const fileReviews = Array.isArray(input.file_reviews)
          ? input.file_reviews.map(item => record(item))
          : []
        const requestsRework = fileReviews.some(item => text(item.action) === 'request_changes')
        const taskAction = name === 'ReviewWorkspaceChanges'
          ? (requestsRework ? 'rework' : 'accept')
          : text(input.task_action)
        if (taskAction !== 'accept' && taskAction !== 'rework') {
          throw new InvalidAgentTeamOperationError('task_action must be accept or rework.')
        }
        const parsedReviews = fileReviews.map(item => {
          const action = text(item.action)
          if (!['accept', 'reject', 'retarget', 'request_changes'].includes(action)) {
            throw new InvalidAgentTeamOperationError(`Unknown file review action: ${action || '(empty)'}.`)
          }
          return {
            proposalId: text(item.proposal_item_id),
            action: action as 'accept' | 'reject' | 'retarget' | 'request_changes',
            targetPath: text(item.target_path)
              ? assertWorkspaceWritePath(text(item.target_path))
              : undefined,
            // Omission means "reuse the proposal's durable CAS expectation".
            // Preserve that distinction from an explicit null/new-target guard
            // so an approved publication can be safely taken over by a later
            // ReviewWorkspaceChanges command without accidentally changing it.
            expectedTargetRevision: item.expected_target_revision === undefined
              ? undefined
              : expectedWorkspaceRevision(item.expected_target_revision),
            note: text(item.reason) || undefined,
          }
        })
        if (taskAction === 'accept' && parsedReviews.some(item => item.action === 'request_changes')) {
          throw new InvalidAgentTeamOperationError(
            'request_changes requires task_action=rework so the author can submit a replacement.',
          )
        }
        const reviewed = await agentTeamService.reviewResult(command, {
          resultId: text(input.result_id),
          items: parsedReviews,
          taskDecision: name === 'ReviewWorkspaceChanges'
            ? (requestsRework ? 'rework' : undefined)
            : (taskAction === 'accept' ? 'accepted' : 'rework'),
          taskNote: text(input.feedback) || undefined,
        })

        const team = await agentTeamService.getTeam({
          teamId: command.team_id,
          userId: command.user_id,
        })
        const publishOutcomes: unknown[] = []
        if (reviewed.accepted_intents.length > 0) {
          if (!execution.executionFenceToken) {
            throw new Error('Review publication requires an AgentRun execution fence.')
          }
          const workspace = new MultiAgentWorkspaceRepository({
            fenceValidator: async ({ writer }) => {
              const runValid = await validateAgentRunLeaseFence(
                writer.run_id,
                writer.execution_fence_token,
              )
              if (!runValid || !execution.teamFenceRequired) return runValid
              if (!execution.agentSessionId) return false
              return validateExecutionFence({
                teamId: team.team_id,
                userId: team.user_id,
                agentId: command.caller_agent_id,
                sessionId: execution.agentSessionId,
                runId: writer.run_id,
                ownerId: writer.execution_fence_token,
              })
            },
          })
          for (const intent of reviewed.accepted_intents) {
            try {
              const outcome = await workspace.acceptProposalItem({
                workspaceId: execution.workspaceId ?? team.workspace_id,
                sourcePath: intent.source_path,
                targetPath: intent.target_path,
                publicationKey: proposalPublicationKey(intent.proposal_id, intent.target_path),
                expectedSourceSha256: intent.source_sha256,
                expectedTargetRevision: intent.expected_target_revision ?? null,
                actor: {
                  teamId: team.team_id,
                  agentId: command.caller_agent_id,
                  rootAgentId: team.root_agent_id,
                  role: 'root',
                },
                writer: {
                  team_id: team.team_id,
                  agent_id: command.caller_agent_id,
                  ...(intent.task_id ? { task_id: intent.task_id } : {}),
                  run_id: command.run_id,
                  execution_fence_token: execution.executionFenceToken,
                },
              })
              await agentTeamService.recordWorkspaceProposalOutcome({
                teamId: team.team_id,
                userId: team.user_id,
                proposalId: intent.proposal_id,
                status: outcome.status === 'accepted' ? 'published' : 'conflict',
                publishedRevision: outcome.status === 'accepted' ? outcome.file.revision : undefined,
              })
              publishOutcomes.push({ proposal_id: intent.proposal_id, ...outcome })
            } catch (error) {
              if (!isDeterministicPublicationError(error)) throw error
              await agentTeamService.recordWorkspaceProposalOutcome({
                teamId: team.team_id,
                userId: team.user_id,
                proposalId: intent.proposal_id,
                status: 'conflict',
              })
              publishOutcomes.push({
                proposal_id: intent.proposal_id,
                status: 'conflict',
                code: error.code ?? 'workspace_publication_invalid',
                message: error.message,
              })
            }
          }
        }
        if (reviewed.task?.status === 'rework') {
          await scheduleNextAgentTask({
            teamId: team.team_id,
            userId: team.user_id,
            agentId: reviewed.result.agent_id,
          })
        } else {
          await scheduleReadyAgents(team.team_id, team.user_id)
        }
        let feedbackWakeRunId: string | null = null
        if (reviewed.feedback_delivery) {
          // For a formal rework, create/claim the Task Run first so this
          // review lands in that same conversational Run. Taskless turns have
          // no scheduler path, so the durable review message itself starts the
          // author's next Run. A crash before this wake is repaired from the
          // pending mailbox; the service command already persisted it.
          const author = await agentTeamService.getAgent({
            teamId: team.team_id,
            userId: team.user_id,
            agentId: reviewed.result.agent_id,
          })
          feedbackWakeRunId = await wakeMessageRecipient({
            command,
            recipient: author,
            messageId: reviewed.feedback_delivery.message.message_id,
            kind: 'review',
          })
          for (const agentId of reviewed.feedback_delivery.wake_agent_ids) {
            await resumeWaitingAgentById({
              teamId: team.team_id,
              userId: team.user_id,
              agentId,
              reason: `Workspace review ${reviewed.feedback_delivery.message.message_id} requires changes.`,
            })
          }
        }
        const refreshed = await agentTeamService.inspectTeam({
          teamId: team.team_id,
          userId: team.user_id,
          callerAgentId: command.caller_agent_id,
        })
        return jsonResult({
          ...reviewed,
          ...(reviewed.task ? {
            task: refreshed.tasks.find(task => task.task_id === reviewed.task?.task_id) ?? reviewed.task,
          } : {}),
          ...(reviewed.feedback_delivery ? {
            feedback_message: {
              message_id: reviewed.feedback_delivery.message.message_id,
              to: reviewed.feedback_delivery.message.recipient_name
                ?? reviewed.result.agent_id,
              task_id: reviewed.feedback_delivery.message.task_id ?? undefined,
              wake_run_id: feedbackWakeRunId,
            },
          } : {}),
          publish_outcomes: publishOutcomes,
        })
      }

      case 'ManageAgent': {
        const targetBefore = await resolveAgentReference(
          command,
          text(input.name) || text(input.agent_id),
        )
        const action = text(input.action) as 'interrupt' | 'close' | 'reopen'
        const managed = await agentTeamService.manageAgent(command, {
          agentId: targetBefore.agent_id,
          action,
          reason: text(input.reason) || undefined,
        })
        if (action === 'interrupt' || action === 'close') {
          if (targetBefore.is_root) {
            const active = await getActiveAgentRun(targetBefore.conversation_id, command.user_id)
            if (active) await requestRunCancellation(targetBefore.conversation_id, command.user_id, active.run_id)
          } else {
            const active = await getActiveAgentRunForSession(targetBefore.current_session_id, command.user_id)
            if (active) {
              await requestAgentSessionRunCancellation(
                targetBefore.current_session_id,
                command.user_id,
                active.run_id,
              )
            }
          }
        }
        let taskId: string | undefined
        const taskInput = record(input.task)
        if (action === 'reopen' && Object.keys(taskInput).length > 0) {
          const objective = text(taskInput.objective)
          const task = await agentTeamService.assignTask(command, {
            assignedAgentId: managed.agent.agent_id,
            title: objectiveTitle(objective),
            objective,
            acceptanceCriteria: strings(taskInput.acceptance_criteria),
            contextRefs: strings(taskInput.context_refs).map(contextReference),
          })
          taskId = task.task_id
        }
        if (action === 'reopen') {
          await scheduleNextAgentTask({
            teamId: command.team_id,
            userId: command.user_id,
            agentId: managed.agent.agent_id,
          })
        }
        return jsonResult({ ...managed, task_id: taskId })
      }

      default:
        return { content: `Unknown Agent Team tool: ${name}`, is_error: true }
    }
  } catch (error) {
    return errorResult(error)
  }
}
