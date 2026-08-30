import { createHash } from 'node:crypto'
import type {
  ContentBlock,
  ConversationDoc,
  ConversationMessage,
  ImageBlock,
} from '../types'
import type { AgentRunDocument } from './models'
import { AgentRun } from './models'
import {
  acknowledgeRunPendingInputs,
  advanceRunCheckpoint,
  freezeAgentRunModelAlias,
  heartbeatAgentRun,
  isRunCancellationRequested,
  setRunCurrentAction,
  setRunStatus,
} from './repository'
import {
  buildOrphanedToolRecoveryMessage,
  buildSelectiveToolRecoveryMessage,
  findDurableToolResultMessage,
  findInterruptedAgentTeamToolUse,
} from './tool-recovery'
import { recoverCompactionCheckpoint } from './compaction-recovery'
import type {
  CompactionCheckpoint,
  FrozenProjectContextSnapshot,
} from './types'
import {
  appendMemberSessionMessages,
  clearMemberCompactionCheckpoint,
  freezeMemberSessionModel,
  inheritPreviousMemberGeneration,
  loadFencedMemberSession,
  memberSessionHippocampus,
  MemberSessionLeaseLostError,
  patchMemberSessionHippocampus,
  replaceMemberCompactedMessages,
  validateMemberExecutionFences,
  type MemberExecutionFenceIdentity,
} from './member-session'
import {
  mergeActiveRunTakeoverTail,
  selectActiveRunTakeoverTail,
} from './messages'
import {
  AgentCommandReceiptModel,
  AgentMailboxMessageModel,
  AgentTaskModel,
  TeamAgentModel,
} from '../agent-team/models'
import {
  agentTeamRepository,
  heartbeatAgentSessionRun,
  heartbeatExecutionSlot,
} from '../agent-team/repository'
import { agentTeamService } from '../agent-team/service'
import {
  instrumentAgentProviderForBudget,
} from '../agent-team/execution-budget'
import {
  AgentExecutionBudgetExceededError,
  InvalidAgentTeamOperationError,
  TeamAgentNotFoundError,
} from '../agent-team/errors'
import {
  LEGACY_AGENT_TEAM_TOOL_NAMES,
  normalizeAgentTeamToolNameForExecution,
  ROOT_AGENT_TOOL_NAMES,
} from '../agent-team/policy'
import {
  executeAgentTeamTool,
  isAgentTeamTool,
} from '../agent-team/tool-adapter'
import {
  canExecuteTool,
  type AgentExecutionContext,
} from '../agent/execution-context'
import { buildUntrustedDataReminder } from '../agent/system-reminder'
import type {
  AgentMailboxMessageRecord,
  AgentResultFile,
  AgentTaskRecord,
  AgentTeamRecord,
  DelegationGrantRecord,
  TeamAgentRecord,
} from '../agent-team/types'
import {
  deliverRootMailbox,
  reconcileAgentWaitBoundary,
  wakeMemberForMailbox,
  wakeRootWithUpdate,
} from '../agent-team/orchestrator'
import {
  createAgentProvider,
  estimateOverheadTokens,
  estimateProjectContextOverheadTokens,
} from '../agent/provider'
import { agentLoop } from '../agent/loop'
import { tokenTracker } from '../agent/token-tracker'
import {
  compileProjectGuide,
  validateProjectGuideRef,
} from '../agent/project-guide'
import {
  projectContextSnapshotMatchesGuide,
  type FrozenProjectContext,
} from '../agent/project-context'
import { buildWorkspaceProjection } from '../agent/compaction'
import { scopeWorkspaceForAgent } from '../workspace/agent-scope'
import { createWorkspaceInstance } from '../workspace/instance'
import { spatialCreationWorkspace } from '../workspace/definitions/spatial-creation'
import type { FileEntry, ManifestEntry } from '../workspace/types'
import {
  createMultiAgentWorkspaceBridge,
  MultiAgentWorkspaceRepository,
  type WorkspaceActor,
  type WorkspaceFileSnapshot,
} from '../workspace/multi-agent'
import { loadSkills } from '../skills/loader'
import {
  getToolSchemasForCapabilities,
  EXPLICIT_SPATIAL_DELEGATION_TOOL_NAMES,
  toolSchemas,
} from '../tools/schemas'
import {
  acknowledgeDequeuedMessages,
  dequeueMessages,
  partitionQueuedMessages,
  releaseDequeuedMessageClaim,
  type DequeuedMessage,
} from '../agent/message-queue'
import {
  aliasSupportsVision,
  canUseAlias,
  defaultMainAliasFor,
  getAliasCapabilities,
  resolveAlias,
  resolveMainAliasForUser,
  type ModelAlias,
} from '../llm-registry'
import { getUserModelOverrides, getUserPlan } from '../demo-access-policy'
import {
  getConversation,
  initializeConversationProjectGuide,
} from '../db/repository'
import { getOrCreateProfile } from '../memory-v2/repository'
import { memoryV2Flags } from '../memory-v2/flags'
import type { MemoryRuntimeContext } from '../memory-v2/types'
import { writeImageAsset } from '../media/storage'
import { toImageBlock } from '../media/reference'
import { handoffBackgroundCompaction } from '../agent-compaction/handoff'
import {
  acquireSourceTurnCompactionGuard,
  activateDurableCompactionJob,
  closeFailedCompactionAfterSynchronousRepair,
  CompactionJobNotUnclaimedQueuedError,
  heartbeatSourceTurnCompactionGuard,
  offerPreparedCompactionSummary,
  releaseSourceTurnCompactionGuard,
} from '../agent-compaction/repository'
import {
  deferExecutorForCompactionReload,
  enforceExecutorCompactionBarrier,
  ExecutorCompactionBarrierStoppedError,
  failClosedExecutorCompactionPrepare,
} from './compaction-barrier'

const HEARTBEAT_MS = 10_000
const MAX_MEMBER_TURNS = 50
const TEAM_TOOL_NAMES = new Set<string>([
  ...ROOT_AGENT_TOOL_NAMES,
  ...LEGACY_AGENT_TEAM_TOOL_NAMES,
])

export interface MemberAgentDispatchEnvelope {
  run: AgentRunDocument
  ownerId: string
  executionFenceToken: string
  sessionFenceToken: string
}

export interface MemberAgentExecutionOutcome {
  accepted: true
  run_id: string
  state: 'completed' | 'waiting_agents' | 'recoverable' | 'cancelled' | 'failed' | 'detached' | 'deferred_compaction'
  implicit_result_id?: string
  error?: string
}

interface MemberRuntimeContext {
  team: AgentTeamRecord
  agent: TeamAgentRecord
  grant: DelegationGrantRecord
  task?: AgentTaskRecord
}

interface ClaimedMailbox {
  claimId: string
  messages: AgentMailboxMessageRecord[]
}

interface ClaimedQueue {
  claimId?: string
  messages: DequeuedMessage[]
}

function asConversationDoc(value: { toObject(): unknown }): ConversationDoc {
  return value.toObject() as ConversationDoc
}

function messageText(message: ConversationMessage | undefined): string {
  if (!message) return ''
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
}

function memberAllowedTools(
  grant: DelegationGrantRecord,
  exposedTeamTools: readonly string[],
): string[] {
  const wildcard = grant.allowed_tool_names.includes('*')
  const generic = wildcard
    ? [
        ...toolSchemas.map(schema => schema.name),
        ...(memoryV2Flags.recallTool() ? ['RecallHistory'] : []),
      ]
    : grant.allowed_tool_names
  const legacyRecoveryAliases = LEGACY_AGENT_TEAM_TOOL_NAMES.filter(alias => (
    exposedTeamTools.includes(normalizeAgentTeamToolNameForExecution(alias))
  ))
  return [...new Set([
    ...generic.filter(name => (
      name !== 'AskUserQuestion'
      && !TEAM_TOOL_NAMES.has(name)
      && (!wildcard || !EXPLICIT_SPATIAL_DELEGATION_TOOL_NAMES.has(name))
    )),
    ...exposedTeamTools,
    ...legacyRecoveryAliases,
  ])]
}

async function buildMemberExecutionContext(input: {
  run: AgentRunDocument
  context: MemberRuntimeContext
  ownerId: string
}): Promise<AgentExecutionContext> {
  const exposedTeamTools = await agentTeamService.exposedTools({
    teamId: input.context.team.team_id,
    userId: input.run.user_id,
    agentId: input.context.agent.agent_id,
  })
  const allowedTools = memberAllowedTools(input.context.grant, exposedTeamTools)
  return {
    userId: input.run.user_id,
    conversationId: input.run.conversation_id,
    runId: input.run.run_id,
    teamId: input.context.team.team_id,
    agentId: input.context.agent.agent_id,
    agentSessionId: input.context.agent.current_session_id,
    taskId: input.context.task?.task_id,
    isRoot: false,
    policyVersion: input.run.policy_version ?? input.context.team.policy.version,
    workspaceId: input.context.team.workspace_id,
    executionFenceToken: input.ownerId,
    teamFenceRequired: true,
    agentAlias: input.context.agent.display_name,
    agentRole: input.context.agent.role,
    agentInstructions: input.context.agent.instructions ?? undefined,
    allowedTools,
    canDelegateTasks: input.context.grant.capabilities.can_delegate_tasks,
  }
}

function createProjectContextSnapshot(
  projectGuide: ReturnType<typeof validateProjectGuideRef>,
  projection: Awaited<ReturnType<typeof buildWorkspaceProjection>>,
  epoch: number,
): FrozenProjectContextSnapshot {
  const guide = compileProjectGuide(projectGuide)
  return {
    epoch,
    template_id: guide.template_id,
    version: guide.version,
    ...(Object.keys(guide.parameters).length > 0
      ? { parameters: { ...guide.parameters } }
      : {}),
    guide_title: guide.title,
    compiled_guide: guide.content,
    guide_hash: createHash('sha256').update(guide.content).digest('hex'),
    workspace_projection: projection,
  }
}

function toFrozenProjectContext(
  snapshot: FrozenProjectContextSnapshot,
): FrozenProjectContext {
  return {
    guide: {
      template_id: snapshot.template_id,
      version: snapshot.version,
      title: snapshot.guide_title,
      parameters: { ...(snapshot.parameters ?? {}) },
      content: snapshot.compiled_guide,
    },
    workspaceProjection: snapshot.workspace_projection.content,
  }
}

function referencedPrivatePaths(
  grant: DelegationGrantRecord,
  task: AgentTaskRecord | undefined,
  mailbox: AgentMailboxMessageRecord[],
): string[] {
  return [...new Set([
    ...grant.allowed_read_paths.filter(path => path !== '**'),
    ...(task?.context_refs
      .filter(ref => ref.kind === 'workspace_path')
      .map(ref => ref.value) ?? []),
    ...mailbox.flatMap(message => message.attachments
      .filter(ref => ref.kind === 'workspace_path')
      .map(ref => ref.value)),
  ])]
}

export function mailboxConversationMessage(
  message: AgentMailboxMessageRecord,
  runId: string,
  sequence: number,
): ConversationMessage {
  const payload = {
    message_id: message.message_id,
    from_agent_id: message.sender_agent_id,
    to_agent_id: message.recipient_agent_id,
    from: message.sender_name ?? message.sender_agent_id,
    to: message.recipient_name ?? message.recipient_agent_id,
    kind: message.kind,
    task_id: message.task_id ?? null,
    correlation_id: message.correlation_id ?? null,
    reply_to_message_id: message.reply_to_message_id ?? null,
    content: message.content,
    attachments: message.attachments,
    created_at: message.created_at,
  }
  return {
    role: 'user',
    content: [{
      type: 'text',
      text: buildUntrustedDataReminder('agent_mailbox', payload),
    }],
    timestamp: new Date(message.created_at),
    message_id: `session_mail_${message.message_id}`,
    run_id: runId,
    sequence,
    visibility: 'internal',
  }
}

/** Hydrate acknowledged terminal-race messages only for reply routing. */
export async function hydrateTurnMailboxRouting(input: {
  teamId: string
  userId: string
  recipientAgentId: string
  sourceMessageIds: readonly string[]
  claimedMessages: readonly AgentMailboxMessageRecord[]
}): Promise<AgentMailboxMessageRecord[]> {
  const sourceMessageIds = [...new Set(input.sourceMessageIds)]
  const sourceMessages = sourceMessageIds.length > 0
    ? await AgentMailboxMessageModel.find({
        team_id: input.teamId,
        user_id: input.userId,
        recipient_agent_id: input.recipientAgentId,
        message_id: { $in: sourceMessageIds },
      }).sort({ created_at: 1 }).lean<AgentMailboxMessageRecord[]>()
    : []
  const byId = new Map<string, AgentMailboxMessageRecord>()
  for (const message of [...sourceMessages, ...input.claimedMessages]) {
    byId.set(message.message_id, message)
  }
  return [...byId.values()]
}

/**
 * Find upstream recipients for a natural turn result. Response/progress/info
 * still wake Agents, but are not auto-answered to prevent notification loops.
 */
export function automaticTurnReplyTargets(input: {
  currentAgentId: string
  rootAgentId: string
  taskCreatorAgentId?: string | null
  messages: readonly AgentMailboxMessageRecord[]
}): Map<string, string> {
  const actionableKinds = new Set(['request', 'review', 'blocker', 'error'])
  const targets = new Map<string, string>()
  for (const message of input.messages) {
    if (message.sender_agent_id === input.currentAgentId
      || !actionableKinds.has(message.kind)) continue
    targets.set(message.sender_agent_id, message.message_id)
  }
  if (input.taskCreatorAgentId && input.taskCreatorAgentId !== input.currentAgentId) {
    targets.set(
      input.taskCreatorAgentId,
      targets.get(input.taskCreatorAgentId) ?? '',
    )
  }
  if (targets.size === 0) targets.set(input.rootAgentId, '')
  return targets
}

/** Select exactly the private revisions authored by this Run for proposals. */
export function automaticTurnProposalFiles(
  files: readonly WorkspaceFileSnapshot[],
  agentId: string,
  runId: string,
): AgentResultFile[] {
  return files
    .filter(file => (
      file.visibility === 'agent_private'
      && file.owner_agent_id === agentId
      && file.writer.run_id === runId
    ))
    .sort((left, right) => left.path.localeCompare(right.path))
    .slice(0, 500)
    .map(file => ({
      source_path: file.path,
      suggested_target_path: `output/${file.path.split('/').at(-1) ?? 'agent-result'}`,
      media_type: file.metadata.mime_type,
      sha256: file.metadata.sha256,
      size_bytes: file.metadata.size_bytes,
    }))
}

function queuedConversationMessage(
  message: DequeuedMessage,
  runId: string,
  sequence: number,
): ConversationMessage {
  return {
    role: 'user',
    content: [{
      type: 'text',
      text: buildUntrustedDataReminder('agent_update', {
        source: message.sourceKind ?? 'agent',
        content: message.content,
      }),
    }],
    timestamp: new Date(),
    message_id: message.messageId,
    run_id: runId,
    sequence,
    source_queue_id: message.queueId,
    visibility: 'internal',
  }
}

async function claimMemberMailbox(
  teamId: string,
  userId: string,
  agentId: string,
  runId: string,
): Promise<ClaimedMailbox> {
  const claimId = `member_mail_${runId}_${agentId}`
  await agentTeamRepository.claimMailboxMessages({
    teamId,
    userId,
    agentId,
    claimId,
    limit: 500,
  })
  const messages = await AgentMailboxMessageModel.find({
    team_id: teamId,
    user_id: userId,
    deliveries: {
      $elemMatch: {
        agent_id: agentId,
        status: 'claimed',
        claim_id: claimId,
      },
    },
  }).sort({ created_at: 1 }).lean<AgentMailboxMessageRecord[]>()
  return { claimId, messages }
}

async function claimTargetedQueue(run: AgentRunDocument): Promise<ClaimedQueue> {
  const messages = await dequeueMessages(run.conversation_id, run.run_id, {
    targetedOnly: true,
  })
  return { claimId: messages[0]?.claimId, messages }
}

export async function loadMemberRuntime(
  run: AgentRunDocument,
  options?: { allowNonRunningTaskForToolRecovery?: boolean },
): Promise<MemberRuntimeContext> {
  if (!run.team_id || !run.agent_id || !run.agent_session_id) {
    throw new Error('Member Agent Run has an incomplete Team identity.')
  }
  const team = await agentTeamService.getTeam({ teamId: run.team_id, userId: run.user_id })
  if (team.status !== 'active' || team.conversation_id !== run.conversation_id) {
    throw new Error('Member Agent Team is completed or does not match the Run.')
  }
  const [agent, grant] = await Promise.all([
    agentTeamService.getAgent({ teamId: team.team_id, userId: run.user_id, agentId: run.agent_id }),
    agentTeamService.getActiveGrant({ teamId: team.team_id, userId: run.user_id, agentId: run.agent_id }),
  ])
  if (agent.is_root || agent.current_session_id !== run.agent_session_id) {
    throw new Error('The Agent Run is not owned by the current member generation.')
  }
  let task: AgentTaskRecord | null = null
  if (run.task_id) {
    task = await AgentTaskModel.findOne({
      team_id: team.team_id,
      user_id: run.user_id,
      task_id: run.task_id,
      assigned_agent_id: agent.agent_id,
      status: 'running',
    }).lean<AgentTaskRecord>()
    if (!task && options?.allowNonRunningTaskForToolRecovery) {
      task = await AgentTaskModel.findOne({
        team_id: team.team_id,
        user_id: run.user_id,
        task_id: run.task_id,
        assigned_agent_id: agent.agent_id,
      }).lean<AgentTaskRecord>()
    }
    if (!task) {
      throw new Error(
        `Member Agent Run ${run.run_id} is stale or cancelled: task ${run.task_id} is not running for this Agent.`,
      )
    }
  } else {
    task = await AgentTaskModel.findOne({
      team_id: team.team_id,
      user_id: run.user_id,
      assigned_agent_id: agent.agent_id,
      status: 'running',
    }).sort({ started_at: -1 }).lean<AgentTaskRecord>()
  }
  return { team, agent, grant, ...(task ? { task } : {}) }
}

async function resolveMemberModelAlias(
  run: AgentRunDocument,
  context: MemberRuntimeContext,
  conversation: ConversationDoc,
  ownerId: string,
): Promise<ModelAlias> {
  if (run.model_alias_snapshot) return run.model_alias_snapshot
  const [rootRun, plan, overrides] = await Promise.all([
    AgentRun.findOne({
      team_id: context.team.team_id,
      agent_id: context.team.root_agent_id,
      model_alias_snapshot: { $type: 'string' },
    }).sort({ created_at: -1 }).select('model_alias_snapshot').lean<{ model_alias_snapshot?: string }>(),
    getUserPlan(run.user_id),
    getUserModelOverrides(run.user_id),
  ])
  let proposed: ModelAlias
  if (rootRun?.model_alias_snapshot) {
    proposed = rootRun.model_alias_snapshot
  } else if (overrides.forced_main_alias) {
    proposed = resolveMainAliasForUser(plan, overrides.forced_main_alias)
  } else {
    const requested = conversation.settings.orchestrator_model as string | undefined
    proposed = requested && canUseAlias(plan, requested)
      ? requested
      : defaultMainAliasFor(plan)
  }
  return freezeAgentRunModelAlias(run.run_id, run.user_id, ownerId, proposed)
}

async function markTaskFailed(
  context: MemberRuntimeContext,
  runId: string,
  error: string,
): Promise<void> {
  if (context.task) {
    const updated = await AgentTaskModel.updateOne(
      {
        task_id: context.task.task_id,
        team_id: context.team.team_id,
        status: { $in: ['queued', 'running', 'waiting', 'rework'] },
      },
      { $set: { status: 'failed', completed_at: new Date() } },
    )
    if (updated.modifiedCount === 1) {
      await agentTeamRepository.appendEvent({
        teamId: context.team.team_id,
        userId: context.team.user_id,
        type: 'task_status_changed',
        subjectAgentId: context.agent.agent_id,
        taskId: context.task.task_id,
        runId,
        payload: { status: 'failed', error },
        dedupeKey: `member_task_failed:${runId}`,
      })
    }
  }
  await TeamAgentModel.updateOne(
    {
      team_id: context.team.team_id,
      user_id: context.team.user_id,
      agent_id: context.agent.agent_id,
    },
    { $set: { status: 'failed', last_transition_at: new Date() } },
  )
  await agentTeamRepository.appendEvent({
    teamId: context.team.team_id,
    userId: context.team.user_id,
    type: 'agent_error',
    subjectAgentId: context.agent.agent_id,
    taskId: context.task?.task_id,
    runId,
    payload: { error },
    dedupeKey: `member_agent_error:${runId}`,
  })
  await wakeRootWithUpdate({
    team: context.team,
    content: `Agent ${context.agent.display_name} (${context.agent.agent_id}) failed${context.task ? ` task ${context.task.task_id}` : ''}: ${error}`,
    sourceIds: [runId],
    deliveryKey: `root-agent-error:${context.team.team_id}:${runId}`,
  })
}

async function wakeForLateMailbox(
  context: MemberRuntimeContext,
  messages: AgentMailboxMessageRecord[],
): Promise<void> {
  for (const message of messages) {
    await wakeMemberForMailbox({
      teamId: context.team.team_id,
      userId: context.team.user_id,
      agentId: context.agent.agent_id,
      messageId: message.message_id,
      kind: message.kind,
    })
  }
}

function processInterrupted(error: Error): boolean {
  return /abort|terminated|shutdown|socket hang up/i.test(error.message)
}

export async function executeMemberAgentRun(
  envelope: MemberAgentDispatchEnvelope,
): Promise<MemberAgentExecutionOutcome> {
  const { run, ownerId } = envelope
  if (run.execution_mode !== 'agent_session' || !run.agent_session_id || !run.team_id || !run.agent_id) {
    throw new Error('The internal member executor accepts only agent_session Runs.')
  }
  const fences: MemberExecutionFenceIdentity = {
    teamId: run.team_id,
    userId: run.user_id,
    agentId: run.agent_id,
    sessionId: run.agent_session_id,
    runId: run.run_id,
    ownerId,
    executionFenceToken: envelope.executionFenceToken,
    sessionFenceToken: envelope.sessionFenceToken,
  }
  if (!await validateMemberExecutionFences(fences)) {
    throw new MemberSessionLeaseLostError(run.run_id)
  }

  let context: MemberRuntimeContext | null = null
  let mailboxClaim: ClaimedMailbox | null = null
  let queueClaim: ClaimedQueue | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let runLeaseValid = true
  const abortController = new AbortController()
  const requireFences = async (): Promise<void> => {
    if (!runLeaseValid || !await validateMemberExecutionFences(fences)) {
      runLeaseValid = false
      throw new MemberSessionLeaseLostError(run.run_id)
    }
  }

  try {
    const possibleInterruptedTeamTool = run.current_action?.kind === 'tool_call'
      && Boolean(run.current_action.tool_name)
      && isAgentTeamTool(run.current_action.tool_name!)
    context = await loadMemberRuntime(run, {
      allowNonRunningTaskForToolRecovery: possibleInterruptedTeamTool,
    })
    let session = await loadFencedMemberSession(fences)
    if (!session) throw new MemberSessionLeaseLostError(run.run_id)
    session = await inheritPreviousMemberGeneration(fences, session)

    heartbeat = setInterval(() => {
      void Promise.all([
        heartbeatAgentSessionRun({
          sessionId: fences.sessionId,
          runId: fences.runId,
          ownerId: fences.ownerId,
          fenceToken: fences.sessionFenceToken,
        }),
        heartbeatExecutionSlot({
          runId: fences.runId,
          ownerId: fences.ownerId,
          fenceToken: fences.executionFenceToken,
        }),
        heartbeatAgentRun(run.run_id, ownerId),
      ]).then(([sessionAlive, slotAlive, runState]) => {
        if (!sessionAlive || !slotAlive || runState === 'lost') {
          runLeaseValid = false
          abortController.abort('agent_team_lease_lost')
        } else if (runState === 'cancellation_requested') {
          abortController.abort('interrupt')
        }
      }).catch(error => {
        console.error('[member-agent] lease heartbeat failed:', (error as Error).message)
        runLeaseValid = false
        abortController.abort('agent_team_lease_heartbeat_failed')
      })
    }, HEARTBEAT_MS)
    heartbeat.unref?.()

    // A TaskUpdate(waiting) may durably commit before its tool_result and Run
    // checkpoint are appended. The Task is no longer `running`, but the exact
    // persisted assistant tool_use is still safe to replay because Team
    // commands are idempotent on (run_id, tool_use_id). Close only this narrow
    // boundary before applying the ordinary runnable-Task fence.
    if (run.task_id && context.task?.status !== 'running') {
      const persistedRecoveryMessages = [
        ...(session.messages as ConversationMessage[]),
        ...(session.compacted_messages as ConversationMessage[]),
      ]
      const takeoverTail = selectActiveRunTakeoverTail({
        fullMessages: session.messages as ConversationMessage[],
        compactedMessages: session.compacted_messages as ConversationMessage[],
        runId: run.run_id,
        checkpointMessageId: run.checkpoint_message_id,
        currentActionKind: run.current_action?.kind,
        currentToolUseId: run.current_action?.tool_use_id,
      })
      const exactInterruptedTeamTool = run.current_action
        ? findInterruptedAgentTeamToolUse(
            run.current_action,
            persistedRecoveryMessages,
          )
        : null
      const existingCommandReceipt = exactInterruptedTeamTool && run.current_action
        ? await AgentCommandReceiptModel.exists({
            team_id: context.team.team_id,
            user_id: run.user_id,
            run_id: run.run_id,
            tool_use_id: exactInterruptedTeamTool.id,
            actor_agent_id: context.agent.agent_id,
            status: { $in: ['processing', 'completed'] },
          })
        : null
      if (!exactInterruptedTeamTool || !run.current_action || !existingCommandReceipt) {
        // Preserve the strict stale/cancelled behavior for every Run that is
        // not sitting on an exact durable Team-tool boundary whose command
        // receipt proves execution began before the Task stopped running.
        context = null
        throw new Error(
          `Member Agent Run ${run.run_id} is stale or cancelled: task ${run.task_id} is not running for this Agent.`,
        )
      }

      const recoveryExecutionContext = await buildMemberExecutionContext({
        run,
        context,
        ownerId,
      })
      const recoverySequence = persistedRecoveryMessages.reduce((maximum, message) => (
        message.run_id === run.run_id && typeof message.sequence === 'number'
          ? Math.max(maximum, message.sequence + 1)
          : maximum
      ), 0)
      const durableResult = findDurableToolResultMessage(
        run.current_action,
        persistedRecoveryMessages,
      )
      const recoveredResult = await buildSelectiveToolRecoveryMessage({
        action: run.current_action,
        messages: persistedRecoveryMessages,
        runId: run.run_id,
        sequence: recoverySequence,
        visibleToolSchemas: getToolSchemasForCapabilities({
          supportsVision: false,
          includeRecallHistory: memoryV2Flags.recallTool(),
          allowedTools: recoveryExecutionContext.allowedTools,
          allowAskUser: false,
        }),
        replayAgentTeamTool: async replay => {
          await requireFences()
          if (!canExecuteTool(recoveryExecutionContext, replay.name)) {
            throw new Error(`Tool is no longer granted to this Agent: ${replay.name}`)
          }
          return executeAgentTeamTool(
            replay.name,
            replay.input,
            recoveryExecutionContext,
            {
              toolUseId: replay.toolUseId,
              actionId: replay.actionId,
              turn: 0,
            },
          )
        },
      })
      const orphanedResult = buildOrphanedToolRecoveryMessage({
        messages: recoveredResult
          ? [...persistedRecoveryMessages, recoveredResult]
          : persistedRecoveryMessages,
        runId: run.run_id,
        sequence: recoverySequence + (recoveredResult ? 1 : 0),
      })
      const recoveryResults = [recoveredResult, orphanedResult]
        .filter((message): message is ConversationMessage => Boolean(message))
      const durableRecoveryTail = [...takeoverTail, ...recoveryResults]
      if (durableRecoveryTail.length > 0) {
        await appendMemberSessionMessages(
          fences,
          durableRecoveryTail,
          session.compacted_messages.length > 0,
        )
      }
      const checkpointAdvanced = await advanceRunCheckpoint(
        run.run_id,
        run.current_action.action_id,
        recoveryResults[recoveryResults.length - 1]?.message_id ?? durableResult?.message_id,
        ownerId,
      )
      if (!checkpointAdvanced) throw new MemberSessionLeaseLostError(run.run_id)

      const freshTask = await AgentTaskModel.findOne({
        team_id: context.team.team_id,
        user_id: run.user_id,
        task_id: run.task_id,
        assigned_agent_id: context.agent.agent_id,
      }).lean<AgentTaskRecord>()
      if (freshTask?.status !== 'running') {
        if (heartbeat) {
          clearInterval(heartbeat)
          heartbeat = null
        }
        const stored = await setRunStatus(run.run_id, 'completed', {
          terminationReason: 'model_finished',
          releaseActive: true,
          leaseOwnerId: ownerId,
        })
        if (!stored) throw new MemberSessionLeaseLostError(run.run_id)
        return { accepted: true, run_id: run.run_id, state: 'completed' }
      }

      // A replayed command may have made the Task runnable again. Continue
      // from the now-durable result without replaying the local stale action.
      context.task = freshTask
      run.current_action = null
      run.checkpoint_seq += 1
      const refreshedSession = await loadFencedMemberSession(fences)
      if (!refreshedSession) throw new MemberSessionLeaseLostError(run.run_id)
      session = refreshedSession
    }

    mailboxClaim = await claimMemberMailbox(
      context.team.team_id,
      run.user_id,
      context.agent.agent_id,
      run.run_id,
    )
    // Only messages responsible for this Run (or claimed before the model
    // starts) are eligible as automatic reply targets. A terminal-race
    // message may already have been appended+acknowledged by the previous Run;
    // its stable source id remains on this Run request, so hydrate that record
    // for reply routing without injecting its content a second time.
    const turnMailboxMessages = await hydrateTurnMailboxRouting({
      teamId: context.team.team_id,
      userId: run.user_id,
      recipientAgentId: context.agent.agent_id,
      sourceMessageIds: run.request.internal?.source_ids ?? [],
      claimedMessages: mailboxClaim.messages,
    })
    queueClaim = await claimTargetedQueue(run)

    const conversationDoc = await getConversation(run.conversation_id, run.user_id)
    if (!conversationDoc) throw new Error('Member Agent Conversation no longer exists.')
    const conversation = asConversationDoc(conversationDoc)
    const projectGuide = validateProjectGuideRef(conversation.project_guide)
    if (!conversation.project_guide) {
      await initializeConversationProjectGuide(run.conversation_id, run.user_id, projectGuide)
    }

    const privatePathReferences = referencedPrivatePaths(
      context.grant,
      context.task,
      mailboxClaim.messages,
    )
    const workspaceActor: WorkspaceActor = {
      teamId: context.team.team_id,
      agentId: context.agent.agent_id,
      rootAgentId: context.team.root_agent_id,
      role: 'member',
      privatePathReferences,
      managedReferenceTool: context.grant.capabilities.can_publish_references,
      // The unscoped Workspace is handed only to GenerateImage as its trusted
      // publication target. Generic member tools keep using the scoped view,
      // so explicit delegation grants this one public image namespace without
      // turning the member into a general public writer.
      publicWriteTool: context.grant.allowed_tool_names.includes('GenerateImage')
        ? 'GenerateImage'
        : undefined,
    }
    const workspaceRepository = new MultiAgentWorkspaceRepository({
      fenceValidator: () => validateMemberExecutionFences(fences),
    })
    const legacyFiles = conversation.output?.files as Record<string, FileEntry> | undefined
    const legacyManifest = conversation.output?.manifest as Record<string, ManifestEntry> | undefined
    const bridge = await createMultiAgentWorkspaceBridge({
      repository: workspaceRepository,
      workspaceId: context.team.workspace_id,
      actor: workspaceActor,
      legacyFiles,
      writer: {
        team_id: context.team.team_id,
        agent_id: context.agent.agent_id,
        task_id: context.task?.task_id,
        run_id: run.run_id,
        execution_fence_token: ownerId,
      },
    })
    const sharedWorkspace = createWorkspaceInstance(
      spatialCreationWorkspace,
      bridge.projectedFiles,
      legacyManifest,
      {
        conversationId: run.conversation_id,
        ownerUserId: run.user_id,
        onFileMutations: bridge.onFileMutations,
        onFileSetBegin: bridge.onFileSetBegin,
        onFileSetFinalize: bridge.onFileSetFinalize,
        onFileSetAbort: bridge.onFileSetAbort,
        // Deliberately do not rewrite Conversation.output.files. WorkspaceFile
        // heads are authoritative and avoid whole-map lost updates.
      },
    )
    const workspace = scopeWorkspaceForAgent(sharedWorkspace, {
      agentId: context.agent.agent_id,
      isRoot: false,
      readablePrivatePaths: privatePathReferences,
    })

    let hippocampus = memberSessionHippocampus(session)
    let projectContextSnapshot = hippocampus.project_context_snapshot ?? null
    const recoveringFrozenPromptEpoch = run.recovery_count > 0
      || run.checkpoint_seq > 0
      || !!run.current_action
      || !!hippocampus.active_compaction
    if (
      !projectContextSnapshot
      || (
        !recoveringFrozenPromptEpoch
        && !projectContextSnapshotMatchesGuide(projectGuide, projectContextSnapshot)
      )
    ) {
      projectContextSnapshot = createProjectContextSnapshot(
        projectGuide,
        await buildWorkspaceProjection(workspace),
        (projectContextSnapshot?.epoch ?? 0) + 1,
      )
      await patchMemberSessionHippocampus(fences, {
        project_context_snapshot: projectContextSnapshot,
      })
    }
    let projectContext = toFrozenProjectContext(projectContextSnapshot)

    let historyMessages = (session.compacted_messages.length > 0
      ? session.compacted_messages
      : session.messages) as ConversationMessage[]
    let hasActiveCompactedContext = session.compacted_messages.length > 0
    let compactionStartedAt: Date | null = null
    if (hippocampus.active_compaction) {
      const recovered = await recoverCompactionCheckpoint(
        hippocampus.active_compaction,
        historyMessages,
        workspace,
        run.run_id,
        projectContextSnapshot,
      )
      if (recovered.action === 'merged') {
        if (recovered.checkpointUpgrade) {
          await patchMemberSessionHippocampus(fences, {
            active_compaction: recovered.checkpointUpgrade,
          })
        }
        const recoveredProjectContext = recovered.checkpointUpgrade?.project_context_snapshot
          ?? hippocampus.active_compaction.project_context_snapshot
        if (recoveredProjectContext) {
          projectContextSnapshot = recoveredProjectContext
          projectContext = toFrozenProjectContext(recoveredProjectContext)
          await patchMemberSessionHippocampus(fences, {
            project_context_snapshot: recoveredProjectContext,
          })
        }
        historyMessages = recovered.messages
        hasActiveCompactedContext = true
        await replaceMemberCompactedMessages(fences, recovered.messages)
      }
      await clearMemberCompactionCheckpoint(fences)
      hippocampus = { ...hippocampus, active_compaction: undefined }
    }

    const takeoverTail = hasActiveCompactedContext
      ? selectActiveRunTakeoverTail({
          fullMessages: session.messages as ConversationMessage[],
          compactedMessages: historyMessages,
          runId: run.run_id,
          checkpointMessageId: run.checkpoint_message_id,
          currentActionKind: run.current_action?.kind,
          currentToolUseId: run.current_action?.tool_use_id,
          requiredMessageIds: [
            ...(run.checkpoint_seq === 0 ? [run.started_message_id] : []),
            ...(run.pending_inputs ?? []).map(input => input.message_id),
            ...mailboxClaim.messages.map(message => `session_mail_${message.message_id}`),
            ...queueClaim.messages.map(message => message.messageId),
          ],
        })
      : []
    if (takeoverTail.length > 0) {
      historyMessages = mergeActiveRunTakeoverTail(historyMessages, takeoverTail)
    }

    let nextSequence = historyMessages.reduce((maximum, message) => (
      message.run_id === run.run_id && typeof message.sequence === 'number'
        ? Math.max(maximum, message.sequence + 1)
        : maximum
    ), 0)
    const allPersisted = [
      ...(session.messages as ConversationMessage[]),
      ...(session.compacted_messages as ConversationMessage[]),
      ...historyMessages,
    ]
    const persistedMessageIds = new Set(allPersisted
      .map(message => message.message_id)
      .filter((messageId): messageId is string => Boolean(messageId)))

    const initialMessages: ConversationMessage[] = []
    if (!persistedMessageIds.has(run.started_message_id)) {
      initialMessages.push({
        role: 'user',
        content: [{ type: 'text', text: run.request.message }],
        timestamp: run.created_at,
        message_id: run.started_message_id,
        run_id: run.run_id,
        sequence: nextSequence++,
        visibility: 'internal',
      })
      persistedMessageIds.add(run.started_message_id)
    }
    for (const pending of run.pending_inputs ?? []) {
      if (persistedMessageIds.has(pending.message_id)) continue
      initialMessages.push({
        role: 'user',
        content: [{
          type: 'text',
          text: pending.source_kind && pending.source_kind !== 'user'
            ? buildUntrustedDataReminder('agent_update', {
                source: pending.source_kind,
                content: pending.message,
              })
            : pending.message,
        }],
        timestamp: pending.created_at,
        message_id: pending.message_id,
        run_id: run.run_id,
        sequence: nextSequence++,
        visibility: 'internal',
      })
      persistedMessageIds.add(pending.message_id)
    }
    for (const message of mailboxClaim.messages) {
      const durable = mailboxConversationMessage(message, run.run_id, nextSequence++)
      if (persistedMessageIds.has(durable.message_id!)) continue
      initialMessages.push(durable)
      persistedMessageIds.add(durable.message_id!)
    }
    const partitionedQueue = partitionQueuedMessages(allPersisted, queueClaim.messages)
    if (partitionedQueue.duplicate.length > 0) {
      await acknowledgeDequeuedMessages(
        partitionedQueue.duplicate.map(message => message.queueId),
        partitionedQueue.duplicate[0].claimId,
      )
    }
    for (const message of partitionedQueue.fresh) {
      initialMessages.push(queuedConversationMessage(message, run.run_id, nextSequence++))
    }

    const memberExecutionContext = await buildMemberExecutionContext({
      run,
      context,
      ownerId,
    })
    const allowedTools = [...(memberExecutionContext.allowedTools ?? [])]

    const durableInterruptedResult = findDurableToolResultMessage(
      run.current_action,
      allPersisted,
    )
    const interrupted = await buildSelectiveToolRecoveryMessage({
      action: run.current_action,
      messages: allPersisted,
      runId: run.run_id,
      sequence: nextSequence,
      visibleToolSchemas: getToolSchemasForCapabilities({
        supportsVision: false,
        includeRecallHistory: memoryV2Flags.recallTool(),
        allowedTools,
        allowAskUser: false,
      }),
      replayAgentTeamTool: async replay => {
        await requireFences()
        if (!canExecuteTool(memberExecutionContext, replay.name)) {
          throw new Error(`Tool is no longer granted to this Agent: ${replay.name}`)
        }
        return executeAgentTeamTool(
          replay.name,
          replay.input,
          memberExecutionContext,
          {
            toolUseId: replay.toolUseId,
            actionId: replay.actionId,
            turn: 0,
          },
        )
      },
    })
    if (interrupted) {
      initialMessages.push(interrupted)
      nextSequence += 1
    }
    const orphaned = buildOrphanedToolRecoveryMessage({
      messages: interrupted
        ? [...allPersisted, interrupted]
        : allPersisted,
      runId: run.run_id,
      sequence: nextSequence,
    })
    if (orphaned) {
      initialMessages.push(orphaned)
      nextSequence += 1
    }
    if (!interrupted && !orphaned && run.current_action) {
      const completed = durableInterruptedResult
        ? await advanceRunCheckpoint(
            run.run_id,
            run.current_action.action_id,
            durableInterruptedResult.message_id,
            ownerId,
          )
        : await setRunCurrentAction(run.run_id, null, ownerId)
      if (!completed) throw new MemberSessionLeaseLostError(run.run_id)
    }

    await appendMemberSessionMessages(
      fences,
      [...takeoverTail, ...initialMessages],
      hasActiveCompactedContext,
    )
    if ((run.pending_inputs?.length ?? 0) > 0) {
      const acknowledged = await acknowledgeRunPendingInputs(
        run.run_id,
        run.pending_inputs.map(input => input.message_id),
        ownerId,
      )
      if (!acknowledged) throw new MemberSessionLeaseLostError(run.run_id)
    }
    if ((interrupted || orphaned) && run.current_action?.action_id) {
      const advanced = await advanceRunCheckpoint(
        run.run_id,
        run.current_action.action_id,
        (orphaned ?? interrupted)?.message_id,
        ownerId,
      )
      if (!advanced) throw new MemberSessionLeaseLostError(run.run_id)
    }
    await agentTeamRepository.acknowledgeMailboxClaim({
      teamId: context.team.team_id,
      userId: run.user_id,
      agentId: context.agent.agent_id,
      claimId: mailboxClaim.claimId,
    })
    mailboxClaim = null
    if (partitionedQueue.fresh.length > 0) {
      await acknowledgeDequeuedMessages(
        partitionedQueue.fresh.map(message => message.queueId),
        partitionedQueue.fresh[0].claimId,
      )
    }
    queueClaim = null

    const alias = await resolveMemberModelAlias(run, context, conversation, ownerId)
    const resolved = resolveAlias(alias)
    const capabilities = getAliasCapabilities(alias)
    await freezeMemberSessionModel(fences, {
      provider: 'anthropic-compatible',
      model_id: resolved.model,
      alias,
      settings: { supports_vision: aliasSupportsVision(alias) },
    })

    const skills = loadSkills({ projectGuideTemplateId: projectGuide.template_id })
    const frozenProfile = hippocampus.profile_snapshot
    let profileSnapshot = frozenProfile ?? null
    if (!profileSnapshot && memoryV2Flags.profileInjection()) {
      const profile = await getOrCreateProfile(run.user_id)
      profileSnapshot = {
        version: profile.version,
        token_count: profile.token_count,
        compiled_text: profile.compiled_text,
      }
      await patchMemberSessionHippocampus(fences, { profile_snapshot: profileSnapshot })
    }
    const memoryContext: MemoryRuntimeContext = {
      userId: run.user_id,
      profileText: profileSnapshot?.compiled_text ?? '',
      profileVersion: profileSnapshot?.version ?? 0,
      historyReminder: '',
    }
    let latestAssistantText = ''
    let checkpointSequence = run.checkpoint_seq
      + (interrupted || durableInterruptedResult ? 1 : 0)
    let promptCacheActivityAt: Date | undefined
    const provider = instrumentAgentProviderForBudget(createAgentProvider(
      workspace,
      skills,
      {
        model: resolved.model,
        apiKey: resolved.apiKey,
        maxTokens: capabilities.maxOutputTokens,
        temperature: 1,
        conversationId: run.conversation_id,
        abortSignal: abortController.signal,
        supportsVision: aliasSupportsVision(alias),
        executionContext: memberExecutionContext,
        publicationWorkspace: sharedWorkspace,
      },
      {
        onTextChunk(chunk) {
          latestAssistantText += chunk
        },
      },
      memoryContext,
      projectContext,
    ), {
      context: {
        teamId: context.team.team_id,
        conversationId: run.conversation_id,
        userId: run.user_id,
        agentId: context.agent.agent_id,
        taskId: context.task?.task_id,
        runId: run.run_id,
        executionOwnerId: ownerId,
        agentSessionId: fences.sessionId,
        teamFenceRequired: true,
      },
      model: resolved.model,
    })

    const toolMetadata = Array.from(skills.values()).map(skill => ({
      name: skill.name,
      description: skill.description,
    }))
    const visibleSchemas = getToolSchemasForCapabilities({
      supportsVision: aliasSupportsVision(alias),
      includeRecallHistory: memoryV2Flags.recallTool(),
      allowedTools,
      allowAskUser: false,
    })
    const overheadTokens = estimateOverheadTokens(
      visibleSchemas,
      toolMetadata,
      memoryContext,
      projectContext,
      memberExecutionContext,
    )
    const projectContextOverhead = estimateProjectContextOverheadTokens(projectContext)
    const allMessages = [...historyMessages, ...initialMessages]
    const compactionOwner = {
      kind: 'agent_session' as const,
      sessionId: fences.sessionId,
      conversationId: run.conversation_id,
      userId: run.user_id,
      teamId: context.team.team_id,
      agentId: context.agent.agent_id,
    }
    // Process-local proof that this executor, rather than a prior crashed
    // execution, prepared the exact delayed shadow it is allowed to bypass.
    let localShadowIntent: { jobId: string; before: Date } | undefined

    // A Job may be handed off after Runner's final pre-dispatch read. Check
    // again before AgentLoop can start either its background summarizer or the
    // main provider request.
    const initialCompactionBarrier = await enforceExecutorCompactionBarrier(run, ownerId)
    let failedCompactionRepair = initialCompactionBarrier.kind === 'open'
      && initialCompactionBarrier.repairRequired
      && initialCompactionBarrier.terminalJobId
      && initialCompactionBarrier.terminalIdempotencyKey
      ? {
          jobId: initialCompactionBarrier.terminalJobId,
          idempotencyKey: initialCompactionBarrier.terminalIdempotencyKey,
        }
      : undefined
    const result = await agentLoop(provider, allMessages, {
      runId: run.run_id,
      maxTurns: MAX_MEMBER_TURNS,
      model: resolved.model,
      modelAlias: alias,
      abortSignal: abortController.signal,
      userId: run.user_id,
      conversationId: run.conversation_id,
      midTurnQueueTargetedOnly: true,
      async persistImage(image): Promise<ImageBlock> {
        return toImageBlock(await writeImageAsset({
          ownerUserId: run.user_id,
          conversationId: run.conversation_id,
          buffer: Buffer.from(image.base64, 'base64'),
          mimeType: image.mimeType,
          source: 'tool_output',
        }))
      },
      workspace,
      contextWindow: capabilities.contextWindow,
      mainMaxOutputTokens: capabilities.maxOutputTokens,
      summaryMaxTokens: capabilities.compactionMaxOutputTokens,
      projectContextSnapshot,
      async onBackgroundCompactionPrepare(descriptor) {
        await requireFences()
        localShadowIntent = undefined
        let prepared: { jobId: string } | undefined
        try {
          prepared = await handoffBackgroundCompaction({
            owner: compactionOwner,
            sourceRunId: run.run_id,
            modelAliasSnapshot: alias,
            descriptor,
            notBefore: descriptor.initialAvailableAt,
          })
        } catch (error) {
          await failClosedExecutorCompactionPrepare(run, ownerId, error)
        }
        if (!prepared) throw new Error('durable compaction prepare did not return a Job')
        localShadowIntent = {
          jobId: prepared.jobId,
          before: descriptor.initialAvailableAt,
        }
        return prepared
      },
      async onBackgroundCompactionActivate(input) {
        await requireFences()
        const activated = await activateDurableCompactionJob({
          jobId: input.jobId,
          owner: compactionOwner,
          idempotencyKey: input.idempotencyKey,
        })
        const durableOwns = [
          'queued',
          'summarizing',
          'summary_ready',
          'merge_prepared',
          'retryable',
          'merged',
        ].includes(activated.job.status)
        localShadowIntent = undefined
        return durableOwns
      },
      async onBackgroundCompactionOfferSummary(input) {
        await requireFences()
        const offered = await offerPreparedCompactionSummary({
          jobId: input.jobId,
          owner: compactionOwner,
          idempotencyKey: input.idempotencyKey,
          expectedPrefixHash: input.prefixHash,
          summary: input.summary,
          usage: input.usage,
        })
        localShadowIntent = undefined
        return offered.outcome === 'accepted' || offered.outcome === 'already_offered'
      },
      async onBackgroundCompactionPause(input) {
        await requireFences()
        localShadowIntent = undefined
        await deferExecutorForCompactionReload(run, ownerId, input.jobId)
      },
      async onBackgroundCompactionAcquireSourceTurnGuard(input) {
        await requireFences()
        let acquired: Awaited<ReturnType<typeof acquireSourceTurnCompactionGuard>>
        try {
          acquired = await acquireSourceTurnCompactionGuard({
            jobId: input.jobId,
            owner: compactionOwner,
            idempotencyKey: input.idempotencyKey,
            sourceRunId: input.sourceRunId,
            guardOwnerId: ownerId,
          })
        } catch (error) {
          if (error instanceof CompactionJobNotUnclaimedQueuedError) return null
          throw error
        }
        return {
          guardToken: acquired.guardToken,
          expiresAt: acquired.expiresAt,
        }
      },
      async onBackgroundCompactionHeartbeatSourceTurnGuard(input) {
        await requireFences()
        const expiresAt = await heartbeatSourceTurnCompactionGuard({
          jobId: input.jobId,
          owner: compactionOwner,
          idempotencyKey: input.idempotencyKey,
          sourceRunId: input.sourceRunId,
          guardOwnerId: ownerId,
          guardToken: input.guardToken,
        })
        return expiresAt ? { expiresAt } : null
      },
      async onBackgroundCompactionReleaseSourceTurnGuard(input) {
        await requireFences()
        return releaseSourceTurnCompactionGuard({
          jobId: input.jobId,
          owner: compactionOwner,
          idempotencyKey: input.idempotencyKey,
          sourceRunId: input.sourceRunId,
          guardOwnerId: ownerId,
          guardToken: input.guardToken,
        })
      },
      async onFailedCompactionRepaired(input) {
        await requireFences()
        if (!failedCompactionRepair) return
        await closeFailedCompactionAfterSynchronousRepair({
          jobId: failedCompactionRepair.jobId,
          owner: compactionOwner,
          idempotencyKey: failedCompactionRepair.idempotencyKey,
          replacementMessageId: input.replacementMessageId,
        })
        failedCompactionRepair = undefined
      },
      async onBackgroundCompactionHandoff(descriptor) {
        await requireFences()
        return handoffBackgroundCompaction({
          owner: compactionOwner,
          sourceRunId: run.run_id,
          // `resolved.model` is not stable configuration. The member inherits
          // and freezes the same registry alias as Root for this Run.
          modelAliasSnapshot: alias,
          descriptor,
        })
      },
      promptCacheLastActivityAt: hippocampus.prompt_cache_last_activity_at,
      promptCacheTtlMs: capabilities.promptCacheTtlMs,
      hippocampusTelemetry: hippocampus.telemetry,
      hippocampusSafetyState: hippocampus.breaker_state,
      overheadTokens,
      projectContextOverheadTokens: projectContextOverhead,
      onPromptCacheActivity(at) {
        promptCacheActivityAt = at
      },
      async onHippocampusTelemetry(state) {
        await requireFences()
        await patchMemberSessionHippocampus(fences, { telemetry: state })
      },
      async onHippocampusSafetyState(state) {
        await requireFences()
        await patchMemberSessionHippocampus(fences, {
          breaker_state: state,
          rapid_refills: state.rapidRefills,
          turns_since_merge: state.turnsSinceMerge,
        })
      },
      async onAskUser() {
        throw new Error('Member Agents cannot call AskUserQuestion; send a blocker to Root instead.')
      },
      async onActionStart(action) {
        if (action.kind === 'model_request') {
          await enforceExecutorCompactionBarrier(run, ownerId, {
            ignoreActiveJobId: localShadowIntent?.jobId,
            ignoreActiveJobBefore: localShadowIntent?.before,
          })
        }
        await requireFences()
        const stored = await setRunCurrentAction(run.run_id, {
          kind: action.kind,
          action_id: action.actionId,
          tool_use_id: action.toolUseId,
          tool_name: action.toolName,
          input_hash: action.inputHash,
          prefix_hash: action.prefixHash,
          attempt: action.attempt,
          started_at: action.startedAt,
        }, ownerId)
        if (!stored) throw new MemberSessionLeaseLostError(run.run_id)
        const progress = await agentTeamService.updateProgressSnapshot({
          teamId: context!.team.team_id,
          userId: run.user_id,
          agentId: context!.agent.agent_id,
          sessionId: fences.sessionId,
          runId: run.run_id,
          leaseOwnerId: ownerId,
          fenceToken: fences.sessionFenceToken,
          checkpointSeq: checkpointSequence,
          currentAction: action.toolName
            ? `${action.kind}:${action.toolName}`
            : action.kind,
          taskId: context!.task?.task_id,
        })
        if (!progress) throw new MemberSessionLeaseLostError(run.run_id)
      },
      async onActionComplete(info) {
        await requireFences()
        const advanced = await advanceRunCheckpoint(
          run.run_id,
          info.actionId,
          info.checkpointMessageId,
          ownerId,
        )
        if (!advanced) throw new MemberSessionLeaseLostError(run.run_id)
        checkpointSequence += 1
        const progress = await agentTeamService.updateProgressSnapshot({
          teamId: context!.team.team_id,
          userId: run.user_id,
          agentId: context!.agent.agent_id,
          sessionId: fences.sessionId,
          runId: run.run_id,
          leaseOwnerId: ownerId,
          fenceToken: fences.sessionFenceToken,
          checkpointSeq: checkpointSequence,
          currentAction: 'checkpoint',
          taskId: context!.task?.task_id,
        })
        if (!progress) throw new MemberSessionLeaseLostError(run.run_id)
      },
      async onCompactionCheckpoint(checkpoint) {
        await requireFences()
        if (checkpoint.status === 'cleared') {
          await clearMemberCompactionCheckpoint(fences)
          compactionStartedAt = null
          return
        }
        const now = new Date()
        const startedAt = checkpoint.status === 'started' || !compactionStartedAt
          ? now
          : compactionStartedAt
        compactionStartedAt = startedAt
        const durable: CompactionCheckpoint = {
          compaction_id: checkpoint.compactionId,
          status: checkpoint.status,
          prefix_hash: checkpoint.prefixHash,
          prefix_message_id: checkpoint.prefixMessageId,
          summary: checkpoint.summary,
          workspace_projection: checkpoint.workspace_projection,
          project_context_snapshot: checkpoint.project_context_snapshot,
          replacement_message: checkpoint.replacement_message,
          started_at: startedAt,
          updated_at: now,
        }
        await patchMemberSessionHippocampus(fences, { active_compaction: durable })
        if (checkpoint.status === 'merged') {
          if (!checkpoint.messages) throw new Error('Merged member compaction is missing messages.')
          await replaceMemberCompactedMessages(fences, checkpoint.messages)
          hasActiveCompactedContext = true
          if (checkpoint.project_context_snapshot) {
            projectContextSnapshot = checkpoint.project_context_snapshot
            projectContext = toFrozenProjectContext(projectContextSnapshot)
            await patchMemberSessionHippocampus(fences, {
              project_context_snapshot: projectContextSnapshot,
            })
          }
          await clearMemberCompactionCheckpoint(fences)
          compactionStartedAt = null
        }
      },
      isCancellationRequested() {
        return isRunCancellationRequested(run.run_id)
      },
      async onTurnComplete(messages) {
        await requireFences()
        await appendMemberSessionMessages(fences, messages, hasActiveCompactedContext)
        const finalMessage = [...messages].reverse().find(message => message.role === 'assistant')
        const summary = messageText(finalMessage).slice(0, 500)
        const progress = await agentTeamService.updateProgressSnapshot({
          teamId: context!.team.team_id,
          userId: run.user_id,
          agentId: context!.agent.agent_id,
          sessionId: fences.sessionId,
          runId: run.run_id,
          leaseOwnerId: ownerId,
          fenceToken: fences.sessionFenceToken,
          checkpointSeq: checkpointSequence,
          currentAction: 'turn_complete',
          taskId: context!.task?.task_id,
          summary: summary || undefined,
        })
        if (!progress) throw new MemberSessionLeaseLostError(run.run_id)
      },
    })
    await requireFences()
    if (promptCacheActivityAt) {
      await patchMemberSessionHippocampus(fences, {
        prompt_cache_last_activity_at: promptCacheActivityAt,
      })
    }
    if (result.compacted) {
      await replaceMemberCompactedMessages(fences, result.messages)
    }

    // Close the race in which a direct message arrived after the last tool
    // boundary. Its exact mailbox record is made durable now and then wakes a
    // fresh/suspended Run after this Run transitions.
    const lateMailbox = await claimMemberMailbox(
      context.team.team_id,
      run.user_id,
      context.agent.agent_id,
      run.run_id,
    )
    mailboxClaim = lateMailbox
    const currentSession = await loadFencedMemberSession(fences)
    if (!currentSession) throw new MemberSessionLeaseLostError(run.run_id)
    const lateHistory = [
      ...(currentSession.messages as ConversationMessage[]),
      ...(currentSession.compacted_messages as ConversationMessage[]),
    ]
    let lateSequence = result.messages.reduce((maximum, message) => (
      message.run_id === run.run_id && typeof message.sequence === 'number'
        ? Math.max(maximum, message.sequence + 1)
        : maximum
    ), 0)
    const lateMessages = lateMailbox.messages.map(message =>
      mailboxConversationMessage(message, run.run_id, lateSequence++))
    await appendMemberSessionMessages(fences, lateMessages, hasActiveCompactedContext)
    await agentTeamRepository.acknowledgeMailboxClaim({
      teamId: context.team.team_id,
      userId: run.user_id,
      agentId: context.agent.agent_id,
      claimId: lateMailbox.claimId,
    })
    mailboxClaim = null
    const lateQueue = await claimTargetedQueue(run)
    queueClaim = lateQueue
    const latePartition = partitionQueuedMessages(lateHistory, lateQueue.messages)
    const lateQueueMessages = latePartition.fresh.map(message =>
      queuedConversationMessage(message, run.run_id, lateSequence++))
    await appendMemberSessionMessages(fences, lateQueueMessages, hasActiveCompactedContext)
    if (lateQueue.messages.length > 0) {
      await acknowledgeDequeuedMessages(
        lateQueue.messages.map(message => message.queueId),
        lateQueue.messages[0].claimId,
      )
    }
    queueClaim = null

    if (result.waitingForUser) {
      throw new Error('Member Agent attempted to enter a user interaction boundary.')
    }
    if (result.waitingForAgents) {
      if (heartbeat) {
        clearInterval(heartbeat)
        heartbeat = null
      }
      const stored = await setRunStatus(run.run_id, 'waiting_agents', { leaseOwnerId: ownerId })
      if (!stored) throw new MemberSessionLeaseLostError(run.run_id)
      await reconcileAgentWaitBoundary({
        teamId: context.team.team_id,
        userId: run.user_id,
        runId: run.run_id,
      })
      await wakeForLateMailbox(context, lateMailbox.messages)
      return { accepted: true, run_id: run.run_id, state: 'waiting_agents' }
    }

    const abortReason = String(abortController.signal.reason ?? '')
    if (result.aborted) {
      if (heartbeat) {
        clearInterval(heartbeat)
        heartbeat = null
      }
      if (/lease_lost|heartbeat_failed/.test(abortReason)) {
        return { accepted: true, run_id: run.run_id, state: 'detached' }
      }
      if (abortReason === 'interrupt' || await isRunCancellationRequested(run.run_id)) {
        const stored = await setRunStatus(run.run_id, 'cancelled', {
          terminationReason: 'user_cancelled',
          releaseActive: true,
          leaseOwnerId: ownerId,
        })
        if (!stored) throw new MemberSessionLeaseLostError(run.run_id)
        if (context.task) {
          await AgentTaskModel.updateOne(
            {
              task_id: context.task.task_id,
              team_id: context.team.team_id,
              status: 'running',
            },
            { $set: { status: 'rework' } },
          )
        }
        await TeamAgentModel.updateOne(
          { agent_id: context.agent.agent_id, team_id: context.team.team_id },
          { $set: { status: 'paused', last_transition_at: new Date() } },
        )
        return { accepted: true, run_id: run.run_id, state: 'cancelled' }
      }
      const stored = await setRunStatus(run.run_id, 'recoverable', {
        error: 'Member Agent execution stopped before a terminal checkpoint.',
        leaseOwnerId: ownerId,
      })
      if (!stored) throw new MemberSessionLeaseLostError(run.run_id)
      return { accepted: true, run_id: run.run_id, state: 'recoverable' }
    }

    if (result.truncated) {
      if (heartbeat) {
        clearInterval(heartbeat)
        heartbeat = null
      }
      const error = 'Member Agent loop reached the configured safety limit.'
      const stored = await setRunStatus(run.run_id, 'failed', {
        terminationReason: 'max_turns',
        error,
        releaseActive: true,
        leaseOwnerId: ownerId,
      })
      if (!stored) throw new MemberSessionLeaseLostError(run.run_id)
      await markTaskFailed(context, run.run_id, error)
      return { accepted: true, run_id: run.run_id, state: 'failed', error }
    }

    let implicitResultId: string | undefined
    if (!result.taskSubmitted) {
      await requireFences()
      const finalResponse = result.text.trim()
        || latestAssistantText.trim()
        || messageText([...result.messages].reverse().find(message => message.role === 'assistant'))
        || 'Agent loop ended without an explicit final response.'

      // Workspace provenance is the turn diff: only current-Run private
      // revisions can become automatic publication proposals. This is both
      // more precise and more crash-safe than comparing a mutable start/end
      // file map, and the repository revalidates the execution fence.
      const automaticFiles = automaticTurnProposalFiles(
        await workspaceRepository.listFiles(context.team.workspace_id, workspaceActor),
        context.agent.agent_id,
        run.run_id,
      )
      await requireFences()
      const implicit = await agentTeamService.submitResult({
        team_id: context.team.team_id,
        user_id: run.user_id,
        caller_agent_id: context.agent.agent_id,
        run_id: run.run_id,
        tool_use_id: 'implicit_result_v1',
        execution_owner_id: ownerId,
        agent_session_id: fences.sessionId,
        team_fence_required: true,
        require_execution_fence: true,
      }, {
        taskId: context.task?.task_id,
        finalResponse,
        summary: {
          automatic_turn_result: true,
          reason: 'natural_turn_end',
          source_message_ids: turnMailboxMessages.map(message => message.message_id),
        },
        files: automaticFiles,
        implicit: true,
        allowTerminalTaskFallback: true,
      })
      implicitResultId = implicit.result.result_id
      const proposalDigest = implicit.proposals.length > 0
        ? `\n\nWorkspace proposals (${implicit.proposals.length}):\n${implicit.proposals.slice(0, 50).map(proposal => (
            `- ${proposal.proposal_id}: ${proposal.source_path} -> ${proposal.target_path} `
            + `(expected_revision=${proposal.expected_target_revision ?? 'new'}, status=${proposal.status})`
          )).join('\n')}${implicit.proposals.length > 50 ? '\n- … inspect Team state for the remaining proposals.' : ''}`
        : ''

      // A natural response goes back to the Agent(s) that directly requested
      // this turn, plus the formal Task creator when one exists. Notifications
      // and prior responses still wake an idle Agent, but are deliberately not
      // auto-answered here; otherwise response→response ping-pong could keep a
      // Team alive forever without a new model decision.
      const replyToByAgent = automaticTurnReplyTargets({
        currentAgentId: context.agent.agent_id,
        rootAgentId: context.team.root_agent_id,
        taskCreatorAgentId: context.task?.created_by_agent_id,
        messages: turnMailboxMessages,
      })

      let rootWasPrimaryRecipient = false
      let deliveredAny = false
      const replyTargets = [...replyToByAgent.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
      for (const [index, [recipientAgentId, replyToMessageId]] of replyTargets.entries()) {
        await requireFences()
        try {
          const deliveryContent = recipientAgentId === context.team.root_agent_id
            ? `${finalResponse}${proposalDigest}`
            : finalResponse
          const sent = await agentTeamService.sendMessage({
            team_id: context.team.team_id,
            user_id: run.user_id,
            caller_agent_id: context.agent.agent_id,
            run_id: run.run_id,
            tool_use_id: `automatic_turn_delivery_v2_${index}_${recipientAgentId}`,
            execution_owner_id: ownerId,
            agent_session_id: fences.sessionId,
            team_fence_required: true,
            require_execution_fence: true,
          }, {
            recipientAgentId,
            kind: 'response',
            summary: `${context.agent.display_name} completed a turn`,
            content: deliveryContent.length <= 50_000
              ? deliveryContent
              : `${deliveryContent.slice(0, 49_000)}\n\n[Full response: ${implicit.result.result_id}]`,
            taskId: implicit.result.task_id ?? undefined,
            correlationId: implicit.result.result_id,
            replyToMessageId: replyToMessageId || undefined,
            attachments: [{
              kind: 'result',
              value: implicit.result.result_id,
              label: 'Automatic turn result',
            }],
            suppressRootObserver: true,
          })
          deliveredAny = true
          if (recipientAgentId === context.team.root_agent_id) {
            rootWasPrimaryRecipient = true
          } else {
            await wakeMemberForMailbox({
              teamId: context.team.team_id,
              userId: run.user_id,
              agentId: recipientAgentId,
              messageId: sent.message.message_id,
              kind: sent.message.kind,
            })
          }
        } catch (error) {
          // Closing a requester while its peer is finishing must not erase the
          // immutable result. Other storage/fence failures remain retryable.
          if (!(error instanceof TeamAgentNotFoundError)
            && !(error instanceof InvalidAgentTeamOperationError
              && /completed Agent/.test(error.message))) {
            throw error
          }
        }
      }

      // Claim a direct Root delivery immediately. Peer auto-replies suppress
      // their ordinary observer copy because this immutable result update is
      // the single Root delivery for the logical turn (avoiding duplicate
      // observer + result injections).
      await deliverRootMailbox(context.team)
      if (!rootWasPrimaryRecipient) {
        await wakeRootWithUpdate({
          team: context.team,
          content: `Agent ${context.agent.display_name} completed a turn${implicit.result.task_id ? ` for task ${implicit.result.task_id}` : ''} (result ${implicit.result.result_id}).\n\n${implicit.result.final_response}${proposalDigest}`,
          sourceIds: [implicit.result.result_id],
          deliveryKey: `root-result:${context.team.team_id}:${implicit.result.result_id}`,
        })
      } else if (!deliveredAny) {
        await wakeRootWithUpdate({
          team: context.team,
          content: `Agent ${context.agent.display_name} completed a turn (result ${implicit.result.result_id}).\n\n${implicit.result.final_response}`,
          sourceIds: [implicit.result.result_id],
          deliveryKey: `root-result:${context.team.team_id}:${implicit.result.result_id}`,
        })
      }
    }

    if (heartbeat) {
      clearInterval(heartbeat)
      heartbeat = null
    }

    const stored = await setRunStatus(run.run_id, 'completed', {
      terminationReason: 'model_finished',
      releaseActive: true,
      leaseOwnerId: ownerId,
    })
    if (!stored) throw new MemberSessionLeaseLostError(run.run_id)

    // Seal the terminal mailbox race. A direct message can arrive after the
    // pre-terminal late claim but before the completed CAS. Its sender saw the
    // old active Run and therefore targeted the old queue instead of creating
    // a fresh Run. Once the CAS above clears active_key, arrivals create/wake a
    // new Run themselves; this final fenced session checkpoint captures the
    // finite set that raced immediately before it.
    const postTerminalMailbox = await claimMemberMailbox(
      context.team.team_id,
      run.user_id,
      context.agent.agent_id,
      run.run_id,
    )
    mailboxClaim = postTerminalMailbox
    const postTerminalSession = await loadFencedMemberSession(fences)
    if (!postTerminalSession) throw new MemberSessionLeaseLostError(run.run_id)
    const postTerminalHistory = [
      ...(postTerminalSession.messages as ConversationMessage[]),
      ...(postTerminalSession.compacted_messages as ConversationMessage[]),
    ]
    let postTerminalSequence = postTerminalHistory.reduce((maximum, message) => (
      message.run_id === run.run_id && typeof message.sequence === 'number'
        ? Math.max(maximum, message.sequence + 1)
        : maximum
    ), 0)
    const postTerminalMailboxMessages = postTerminalMailbox.messages.map(message =>
      mailboxConversationMessage(message, run.run_id, postTerminalSequence++))
    await appendMemberSessionMessages(
      fences,
      postTerminalMailboxMessages,
      hasActiveCompactedContext,
    )
    await agentTeamRepository.acknowledgeMailboxClaim({
      teamId: context.team.team_id,
      userId: run.user_id,
      agentId: context.agent.agent_id,
      claimId: postTerminalMailbox.claimId,
    })
    mailboxClaim = null

    const postTerminalQueue = await claimTargetedQueue(run)
    queueClaim = postTerminalQueue
    const postTerminalQueuedMessages = postTerminalQueue.messages.map(message =>
      queuedConversationMessage(message, run.run_id, postTerminalSequence++))
    await appendMemberSessionMessages(
      fences,
      postTerminalQueuedMessages,
      hasActiveCompactedContext,
    )
    if (postTerminalQueue.messages.length > 0) {
      await acknowledgeDequeuedMessages(
        postTerminalQueue.messages.map(message => message.queueId),
        postTerminalQueue.messages[0].claimId,
      )
    }
    queueClaim = null
    await wakeForLateMailbox(context, [
      ...lateMailbox.messages,
      ...postTerminalMailbox.messages,
    ])
    tokenTracker.printReport()
    return {
      accepted: true,
      run_id: run.run_id,
      state: 'completed',
      ...(implicitResultId ? { implicit_result_id: implicitResultId } : {}),
    }
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught))
    if (heartbeat) clearInterval(heartbeat)
    if (mailboxClaim && context) {
      await agentTeamRepository.releaseMailboxClaim({
        teamId: context.team.team_id,
        userId: run.user_id,
        agentId: context.agent.agent_id,
        claimId: mailboxClaim.claimId,
      }).catch(() => undefined)
    }
    if (queueClaim?.claimId) {
      await releaseDequeuedMessageClaim(
        queueClaim.messages.map(message => message.queueId),
        queueClaim.claimId,
      ).catch(() => undefined)
    }
    if (error instanceof ExecutorCompactionBarrierStoppedError) {
      // The Run is already queued/terminal (or its lease was taken over).
      // Returning 2xx lets Runner release the Team slot/session fence without
      // marking the Task or Agent failed and without consuming input twice.
      runLeaseValid = false
      if (error.stop.kind === 'deferred') {
        return {
          accepted: true,
          run_id: run.run_id,
          state: 'deferred_compaction',
          error: error.message,
        }
      }
      if (error.stop.kind === 'failed') {
        return {
          accepted: true,
          run_id: run.run_id,
          state: 'failed',
          error: error.stop.error,
        }
      }
      return {
        accepted: true,
        run_id: run.run_id,
        state: 'detached',
        error: error.stop.error,
      }
    }
    const detached = error instanceof MemberSessionLeaseLostError
      || /lease lost/i.test(error.message)
      || !runLeaseValid
    if (detached) {
      return {
        accepted: true,
        run_id: run.run_id,
        state: 'detached',
        error: error.message,
      }
    }

    const budgetExhausted = error instanceof AgentExecutionBudgetExceededError
      || (error as { code?: string }).code === 'AGENT_EXECUTION_BUDGET_EXCEEDED'
    const interrupted = !budgetExhausted && processInterrupted(error)
    const stored = await setRunStatus(
      run.run_id,
      interrupted ? 'recoverable' : 'failed',
      interrupted
        ? { error: error.message, leaseOwnerId: ownerId }
        : {
            terminationReason: /model|provider|openrouter|anthropic/i.test(error.message)
              ? 'model_error'
              : 'runtime_error',
            error: error.message,
            releaseActive: true,
            leaseOwnerId: ownerId,
          },
    ).catch(() => false)
    if (!stored) {
      return {
        accepted: true,
        run_id: run.run_id,
        state: 'detached',
        error: error.message,
      }
    }
    if (!interrupted && context) {
      await markTaskFailed(
        context,
        run.run_id,
        budgetExhausted ? 'Agent execution budget exhausted.' : error.message,
      )
    }
    return {
      accepted: true,
      run_id: run.run_id,
      state: interrupted ? 'recoverable' : 'failed',
      error: budgetExhausted ? 'Agent execution budget exhausted.' : error.message,
    }
  }
}
