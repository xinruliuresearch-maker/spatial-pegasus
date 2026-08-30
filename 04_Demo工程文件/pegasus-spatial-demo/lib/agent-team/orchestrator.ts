import { createHash, randomUUID } from 'node:crypto'
import {
  ActiveAgentRunError,
  cancelInactiveAgentRun,
  createAgentRun,
  getActiveAgentRun,
  getActiveAgentRunForSession,
  getAgentRun,
  newAgentRunId,
  requestAgentSessionRunCancellation,
  resumeWaitingAgentRun,
} from '../agent-runtime/repository'
import { wakeAgentRunner } from '../agent-runtime/runner'
import {
  bindIdempotentQueuedMessageToRun,
  enqueueMessage,
  getIdempotentQueuedMessage,
  rerouteTargetedInternalAgentMessage,
  releaseQueuedMessagesForRun,
  repairTerminalRootTeamQueueReceipts,
  settleSupersededInternalAgentMessage,
} from '../agent/message-queue'
import { buildUntrustedDataReminder } from '../agent/system-reminder'
import { recoverStaleAgentBudgetAdmissions } from './execution-budget'
import {
  AgentMailboxMessageModel,
  AgentWaitSubscriptionModel,
  AgentTaskModel,
  AgentTeamModel,
  TeamAgentModel,
  WorkspaceProposalModel,
} from './models'
import { agentTeamRepository } from './repository'
import { agentTeamService } from './service'
import type {
  AgentTaskRecord,
  AgentMailboxMessageRecord,
  AgentMessageKind,
  AgentTeamRecord,
  AgentWakeEvaluation,
  MailboxDeliveryKind,
  TeamAgentRecord,
  TeamEventRecord,
  WorkspaceProposalRecord,
} from './types'

const APPROVED_PUBLICATION_REPAIR_AFTER_MS = 60_000

function internalMessageId(prefix: string): string {
  return `${prefix}_${randomUUID()}`
}

function deterministicInternalId(prefix: string, ...parts: string[]): string {
  const digest = createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 40)
  return `${prefix}_${digest}`
}

function taskPacket(task: AgentTaskRecord, agent: TeamAgentRecord): string {
  return buildUntrustedDataReminder('agent_task', {
    task_id: task.task_id,
    agent: {
      display_name: agent.display_name,
      role: agent.role,
    },
    objective: task.objective,
    acceptance_criteria: task.acceptance_criteria.length > 0
      ? task.acceptance_criteria
      : ['Satisfy the objective with an evidence-backed result.'],
    context_references: task.context_refs,
    operating_contract: [
      'Work autonomously in the private Agent workspace.',
      'Communicate meaningful milestones or blockers to peers or Root.',
      'Finish with a concise natural-language response; the runtime records and delivers it automatically.',
    ],
  })
}

function teamUpdate(content: string): string {
  return buildUntrustedDataReminder('agent_update', { content })
}

async function announceRootRun(
  team: AgentTeamRecord,
  runId: string,
  sourceIds: string[] | undefined,
  content: string,
): Promise<void> {
  const sourceKey = sourceIds?.length
    ? [...sourceIds].sort().join(',')
    : createHash('sha256').update(content).digest('hex').slice(0, 24)
  await agentTeamRepository.appendEvent({
    teamId: team.team_id,
    userId: team.user_id,
    type: 'supervision_due',
    subjectAgentId: team.root_agent_id,
    runId,
    payload: { source_count: sourceIds?.length ?? 0 },
    dedupeKey: `root_run_wake:${runId}:${sourceKey}`,
  })
}

async function dependenciesAccepted(task: AgentTaskRecord): Promise<boolean> {
  if (task.dependency_task_ids.length === 0) return true
  const accepted = await AgentTaskModel.countDocuments({
    team_id: task.team_id,
    task_id: { $in: task.dependency_task_ids },
    status: 'accepted',
  })
  return accepted === task.dependency_task_ids.length
}

/** Queue the next ready task for an idle member. The session active-key is the race fence. */
export async function scheduleNextAgentTask(input: {
  teamId: string
  userId: string
  agentId: string
  /** A direct task-linked message may explicitly resume one manual wait. */
  preferredTaskId?: string
}): Promise<string | null> {
  const [team, agent] = await Promise.all([
    AgentTeamModel.findOne({ team_id: input.teamId, user_id: input.userId }).lean<AgentTeamRecord>(),
    TeamAgentModel.findOne({
      team_id: input.teamId,
      user_id: input.userId,
      agent_id: input.agentId,
    }).lean<TeamAgentRecord>(),
  ])
  if (!team || !agent || team.status !== 'active' || agent.is_root) return null
  if (!['idle', 'running'].includes(agent.status)) return null

  const active = await getActiveAgentRunForSession(agent.current_session_id, input.userId)
  if (active) return active.run_id

  const candidates = await AgentTaskModel.find({
    team_id: input.teamId,
    user_id: input.userId,
    assigned_agent_id: input.agentId,
    ...(input.preferredTaskId ? { task_id: input.preferredTaskId } : {}),
    $or: [
      { status: { $in: ['queued', 'rework'] } },
      { status: 'waiting', waiting_kind: 'dependencies' },
    ],
  }).sort({ created_at: 1 }).lean<AgentTaskRecord[]>()

  let task: AgentTaskRecord | undefined
  for (const candidate of candidates) {
    if (await dependenciesAccepted(candidate)) {
      task = candidate
      break
    }
    if (candidate.status !== 'waiting') {
      await AgentTaskModel.updateOne(
        { task_id: candidate.task_id, status: candidate.status },
        { $set: { status: 'waiting', waiting_kind: 'dependencies' } },
      )
    }
  }
  if (!task) return null

  const runId = newAgentRunId()
  try {
    await createAgentRun({
      runId,
      conversationId: team.conversation_id,
      userId: team.user_id,
      request: {
        message: taskPacket(task, agent),
        internal: { kind: 'task_wakeup', source_ids: [task.task_id] },
      },
      startedMessageId: internalMessageId('agent_task_input'),
      teamId: team.team_id,
      agentId: agent.agent_id,
      agentSessionId: agent.current_session_id,
      taskId: task.task_id,
      trigger: task.status === 'rework' ? 'message' : 'task',
      policyVersion: team.policy.version,
      rootVisible: false,
      executionMode: 'agent_session',
    })
  } catch (error) {
    if (error instanceof ActiveAgentRunError) return error.runId ?? null
    throw error
  }

  const claimedTask = await AgentTaskModel.updateOne(
    {
      task_id: task.task_id,
      team_id: team.team_id,
      user_id: team.user_id,
      assigned_agent_id: agent.agent_id,
      status: task.status,
      updated_at: task.updated_at,
    },
    {
      $set: {
        status: 'running',
        waiting_kind: null,
        started_at: task.started_at ?? new Date(),
      },
    },
  )
  if (claimedTask.matchedCount !== 1) {
    // The Task was cancelled, reassigned, manually paused or otherwise
    // changed after candidate selection. The newly-created Run is still
    // queued, so retire it before it can execute under stale ownership.
    const cancelledWhileInactive = await cancelInactiveAgentRun(runId, team.user_id)
    if (!cancelledWhileInactive) {
      // A worker may have claimed the queued Run in the narrow interval
      // before the Task CAS. Fence that exact session/Run as the fallback;
      // running executors observe cancellation_requested before committing.
      await requestAgentSessionRunCancellation(
        agent.current_session_id,
        team.user_id,
        runId,
      )
    }
    return null
  }
  await agentTeamRepository.appendEvent({
    teamId: team.team_id,
    userId: team.user_id,
    type: 'task_status_changed',
    subjectAgentId: agent.agent_id,
    taskId: task.task_id,
    runId,
    payload: { status: 'running' },
    dedupeKey: `task_run:${task.task_id}:${runId}`,
  })
  wakeAgentRunner()
  return runId
}

/** Wake a member for any direct mailbox message, exactly like a user turn. */
export async function wakeMemberForMailbox(input: {
  teamId: string
  userId: string
  agentId: string
  messageId: string
  kind: AgentMessageKind
}): Promise<string | null> {
  const [team, agent] = await Promise.all([
    AgentTeamModel.findOne({ team_id: input.teamId, user_id: input.userId }).lean<AgentTeamRecord>(),
    TeamAgentModel.findOne({
      team_id: input.teamId,
      user_id: input.userId,
      agent_id: input.agentId,
    }).lean<TeamAgentRecord>(),
  ])
  if (!team || !agent || agent.is_root || team.status !== 'active') return null
  if (['paused', 'completed', 'failed'].includes(agent.status)) return null

  // A message explicitly associated with a Task is the durable equivalent of
  // the user continuing that task's conversation. If the owner had placed it
  // in a manual wait, move it back to the scheduler queue exactly once and
  // prefer that Task when the Agent has no other active Run. Dependency waits
  // remain protected by their dependency gate; terminal Tasks become ordinary
  // taskless follow-up conversations.
  const sourceMessage = await AgentMailboxMessageModel.findOne({
    team_id: input.teamId,
    user_id: input.userId,
    recipient_agent_id: input.agentId,
    message_id: input.messageId,
  }).select('task_id').lean<{ task_id?: string | null }>()
  let preferredTaskId: string | undefined
  if (sourceMessage?.task_id) {
    const linkedTask = await AgentTaskModel.findOne({
      team_id: input.teamId,
      user_id: input.userId,
      task_id: sourceMessage.task_id,
      assigned_agent_id: input.agentId,
      status: { $in: ['queued', 'rework', 'waiting'] },
    }).lean<AgentTaskRecord>()
    if (linkedTask) {
      if (linkedTask.status === 'waiting' && linkedTask.waiting_kind === 'manual') {
        const resumed = await AgentTaskModel.updateOne(
          {
            team_id: linkedTask.team_id,
            user_id: linkedTask.user_id,
            task_id: linkedTask.task_id,
            assigned_agent_id: input.agentId,
            status: 'waiting',
            waiting_kind: 'manual',
            updated_at: linkedTask.updated_at,
          },
          { $set: { status: 'queued', waiting_kind: null } },
        )
        if (resumed.matchedCount === 1) {
          await agentTeamRepository.appendEvent({
            teamId: linkedTask.team_id,
            userId: linkedTask.user_id,
            type: 'task_status_changed',
            subjectAgentId: input.agentId,
            taskId: linkedTask.task_id,
            payload: {
              previous_status: 'waiting',
              status: 'queued',
              reason: 'task_linked_message',
              message_id: input.messageId,
            },
            dedupeKey: `task_message_resume:${linkedTask.task_id}:${input.messageId}`,
          })
          preferredTaskId = linkedTask.task_id
        }
      } else {
        preferredTaskId = linkedTask.task_id
      }
    }
  }
  if (preferredTaskId) {
    await scheduleNextAgentTask({
      teamId: input.teamId,
      userId: input.userId,
      agentId: input.agentId,
      preferredTaskId,
    })
  }
  const notice = `New ${input.kind} mailbox message ${input.messageId}. Read the durable mailbox, respond or adjust your work as appropriate.`
  const wakeMessageId = deterministicInternalId(
    'agent_mail_wake',
    input.teamId,
    input.agentId,
    input.messageId,
  )
  const active = await getActiveAgentRunForSession(agent.current_session_id, input.userId)
  if (active) {
    // A delivery replay can race the Run creation or the pending-input
    // checkpoint. The durable mailbox message is the source identity; if this
    // exact source already started the Run or is already pending, do not add a
    // second reminder.
    if (
      active.request.internal?.source_ids?.includes(input.messageId)
      || active.pending_inputs?.some(pending => pending.message_id === wakeMessageId)
    ) {
      await settleSupersededInternalAgentMessage(
        team.conversation_id,
        wakeMessageId,
        active.run_id,
      )
      return active.run_id
    }
    const rerouted = await rerouteTargetedInternalAgentMessage(
      team.conversation_id,
      wakeMessageId,
      active.run_id,
    )
    if (['waiting_agents', 'recoverable'].includes(active.status)) {
      const resumed = await resumeWaitingAgentRun(
        active.run_id,
        input.userId,
        rerouted
          ? undefined
          : {
              message_id: wakeMessageId,
              message: notice,
              visibility: 'internal',
              source_kind: 'agent',
              created_at: new Date(),
            },
      )
      if (resumed) wakeAgentRunner()
      return resumed?.run_id ?? active.run_id
    }
    if (['queued', 'running'].includes(active.status)) {
      if (rerouted) return active.run_id
      await enqueueMessage(team.conversation_id, notice, undefined, active.run_id, {
        visibility: 'internal',
        sourceKind: 'agent',
        idempotencyKey: `member-mail-wake:${input.teamId}:${input.messageId}:${active.run_id}`,
        messageId: wakeMessageId,
      })
      return active.run_id
    }
    return active.run_id
  }

  let runId = newAgentRunId()
  try {
    await createAgentRun({
      runId,
      conversationId: team.conversation_id,
      userId: team.user_id,
      request: {
        message: teamUpdate(notice),
        internal: { kind: 'agent_update', source_ids: [input.messageId] },
      },
      startedMessageId: wakeMessageId,
      teamId: team.team_id,
      agentId: agent.agent_id,
      agentSessionId: agent.current_session_id,
      trigger: 'message',
      policyVersion: team.policy.version,
      rootVisible: false,
      executionMode: 'agent_session',
    })
  } catch (error) {
    if (error instanceof ActiveAgentRunError) {
      const winner = await getActiveAgentRunForSession(agent.current_session_id, input.userId)
      runId = winner?.run_id ?? error.runId ?? ''
      if (!runId) return null
    } else {
      throw error
    }
  }
  await settleSupersededInternalAgentMessage(
    team.conversation_id,
    wakeMessageId,
    runId,
  )
  wakeAgentRunner()
  return runId
}

/** Deliver an internal team update to Root while keeping Root's reply public. */
export async function wakeRootWithUpdate(input: {
  team: AgentTeamRecord
  content: string
  sourceIds?: string[]
  /** Stable outbox identity for crash-safe Root injection. */
  deliveryKey?: string
  /** Stable ConversationMessage id paired with deliveryKey. */
  messageId?: string
}): Promise<string | null> {
  if (input.team.status !== 'active') return null
  const root = await TeamAgentModel.findOne({
    team_id: input.team.team_id,
    user_id: input.team.user_id,
    agent_id: input.team.root_agent_id,
  }).lean<TeamAgentRecord>()
  if (!root) return null
  const rawContent = input.content
  const runContent = teamUpdate(rawContent)

  // A failed/paused/completed Root is a durable delivery boundary, not an
  // invitation to create a Run that the Team execution fence must reject.
  // Critical callers use a stable delivery key (results, member errors,
  // mailbox and routine supervision), so retain that exact update as an
  // untargeted queue receipt. The first public or supervision Run after an
  // explicit recovery will claim it together with the rest of the backlog.
  // Do this before returning: result_submitted is intentionally excluded from
  // routine supervision and would otherwise have no second delivery path.
  if (!rootCanAcceptTeamUpdate(root.status)) {
    if (input.deliveryKey) {
      const messageId = input.messageId
        ?? deterministicInternalId('root_team_update', input.team.team_id, input.deliveryKey)
      await enqueueMessage(
        input.team.conversation_id,
        rawContent,
        undefined,
        undefined,
        {
          visibility: 'internal',
          sourceKind: 'team_supervision',
          idempotencyKey: input.deliveryKey,
          messageId,
        },
      )
    }
    return null
  }
  if (input.deliveryKey) {
    const messageId = input.messageId
      ?? deterministicInternalId('root_team_update', input.team.team_id, input.deliveryKey)
    const deterministicRunId = deterministicInternalId(
      'run_root_team_update',
      input.team.team_id,
      input.deliveryKey,
    )
    let receipt = await getIdempotentQueuedMessage(
      input.team.conversation_id,
      input.deliveryKey,
    )
    if (receipt?.status === 'acknowledged') {
      const runId = receipt.targetRunId ?? deterministicRunId
      await announceRootRun(input.team, runId, input.sourceIds, rawContent)
      return runId
    }

    if (receipt?.targetRunId) {
      const target = await getAgentRun(receipt.targetRunId, input.team.user_id)
      if (target && ['waiting_agents', 'recoverable'].includes(target.status)) {
        const resumed = await resumeWaitingAgentRun(target.run_id, input.team.user_id)
        if (resumed) wakeAgentRunner()
        await announceRootRun(input.team, target.run_id, input.sourceIds, rawContent)
        return target.run_id
      }
      if (target && ['queued', 'running', 'waiting_user'].includes(target.status)) {
        await announceRootRun(input.team, target.run_id, input.sourceIds, rawContent)
        return target.run_id
      }
      await releaseQueuedMessagesForRun(receipt.targetRunId)
      receipt = await getIdempotentQueuedMessage(input.team.conversation_id, input.deliveryKey)
    }

    const active = await getActiveAgentRun(input.team.conversation_id, input.team.user_id)
    if (active) {
      if (!receipt) {
        receipt = await enqueueMessage(
          input.team.conversation_id,
          rawContent,
          undefined,
          active.run_id,
          {
            visibility: 'internal',
            sourceKind: 'team_supervision',
            idempotencyKey: input.deliveryKey,
            messageId,
          },
        )
      }
      receipt = await bindIdempotentQueuedMessageToRun(
        input.team.conversation_id,
        input.deliveryKey,
        active.run_id,
      )
      if (receipt?.targetRunId && receipt.targetRunId !== active.run_id) {
        const boundRun = await getAgentRun(receipt.targetRunId, input.team.user_id)
        if (boundRun && ['queued', 'running', 'waiting_user', 'waiting_agents', 'recoverable'].includes(boundRun.status)) {
          await announceRootRun(input.team, boundRun.run_id, input.sourceIds, rawContent)
          return boundRun.run_id
        }
      }
      if (['waiting_agents', 'recoverable'].includes(active.status)) {
        const resumed = await resumeWaitingAgentRun(active.run_id, input.team.user_id)
        if (resumed) wakeAgentRunner()
      }
      await announceRootRun(input.team, active.run_id, input.sourceIds, rawContent)
      return active.run_id
    }

    if (!receipt) {
      receipt = await enqueueMessage(
        input.team.conversation_id,
        rawContent,
        undefined,
        undefined,
        {
          visibility: 'internal',
          sourceKind: 'team_supervision',
          idempotencyKey: input.deliveryKey,
          messageId,
        },
      )
    }
    let deliveryRunId = deterministicRunId
    let existingDeliveryRun = await getAgentRun(deliveryRunId, input.team.user_id)
    if (existingDeliveryRun && ['completed', 'cancelled', 'failed'].includes(existingDeliveryRun.status)) {
      deliveryRunId = deterministicInternalId(
        'run_root_team_update_recovery',
        input.team.team_id,
        input.deliveryKey,
        receipt.queueId,
      )
      existingDeliveryRun = await getAgentRun(deliveryRunId, input.team.user_id)
      if (existingDeliveryRun && ['completed', 'cancelled', 'failed'].includes(existingDeliveryRun.status)) {
        deliveryRunId = newAgentRunId()
        existingDeliveryRun = null
      }
    }
    if (!existingDeliveryRun) {
      try {
        await createAgentRun({
          runId: deliveryRunId,
          conversationId: input.team.conversation_id,
          userId: input.team.user_id,
          request: {
            message: teamUpdate('A durable Team update is queued. Consume the queued update before continuing.'),
            internal: { kind: 'team_supervision', source_ids: input.sourceIds },
          },
          startedMessageId: deterministicInternalId(
            'root_team_update_trigger',
            input.team.team_id,
            input.deliveryKey,
          ),
          teamId: input.team.team_id,
          agentId: root.agent_id,
          agentSessionId: root.current_session_id,
          trigger: 'supervision',
          policyVersion: input.team.policy.version,
          rootVisible: true,
          executionMode: 'conversation',
        })
      } catch (error) {
        const winner = error instanceof ActiveAgentRunError
          ? await getActiveAgentRun(input.team.conversation_id, input.team.user_id)
          : await getAgentRun(deliveryRunId, input.team.user_id)
        if (!winner) throw error
        deliveryRunId = winner.run_id
      }
    } else if (['waiting_agents', 'recoverable'].includes(existingDeliveryRun.status)) {
      await resumeWaitingAgentRun(existingDeliveryRun.run_id, input.team.user_id)
    }
    receipt = await bindIdempotentQueuedMessageToRun(
      input.team.conversation_id,
      input.deliveryKey,
      deliveryRunId,
    )
    if (receipt?.targetRunId && receipt.targetRunId !== deliveryRunId) {
      deliveryRunId = receipt.targetRunId
    }
    await announceRootRun(input.team, deliveryRunId, input.sourceIds, rawContent)
    wakeAgentRunner()
    return deliveryRunId
  }
  const active = await getActiveAgentRun(input.team.conversation_id, input.team.user_id)
  if (active) {
    if (['waiting_agents', 'recoverable'].includes(active.status)) {
      const resumed = await resumeWaitingAgentRun(active.run_id, input.team.user_id, {
        message_id: internalMessageId('root_team_wake'),
        message: rawContent,
        visibility: 'internal',
        source_kind: 'team_supervision',
        created_at: new Date(),
      })
      if (resumed) {
        await announceRootRun(input.team, resumed.run_id, input.sourceIds, rawContent)
        wakeAgentRunner()
      }
      return resumed?.run_id ?? active.run_id
    }
    // Do not erase a pending AskUserQuestion. The update remains queued and is
    // consumed at the next safe boundary after the user answers.
    await enqueueMessage(input.team.conversation_id, rawContent, undefined, active.run_id, {
      visibility: 'internal',
      sourceKind: 'team_supervision',
    })
    return active.run_id
  }

  const runId = newAgentRunId()
  try {
    await createAgentRun({
      runId,
      conversationId: input.team.conversation_id,
      userId: input.team.user_id,
      request: {
        message: runContent,
        internal: { kind: 'team_supervision', source_ids: input.sourceIds },
      },
      startedMessageId: internalMessageId('root_supervision_input'),
      teamId: input.team.team_id,
      agentId: root.agent_id,
      agentSessionId: root.current_session_id,
      trigger: 'supervision',
      policyVersion: input.team.policy.version,
      rootVisible: true,
      executionMode: 'conversation',
    })
  } catch (error) {
    if (error instanceof ActiveAgentRunError) {
      const winner = await getActiveAgentRun(input.team.conversation_id, input.team.user_id)
      if (winner) {
        await enqueueMessage(input.team.conversation_id, rawContent, undefined, winner.run_id, {
          visibility: 'internal',
          sourceKind: 'team_supervision',
        })
        await announceRootRun(input.team, winner.run_id, input.sourceIds, rawContent)
      }
      return winner?.run_id ?? error.runId ?? null
    }
    throw error
  }
  await announceRootRun(input.team, runId, input.sourceIds, rawContent)
  wakeAgentRunner()
  return runId
}

/** Only a runnable Root may receive a new automatic Team turn. */
export function rootCanAcceptTeamUpdate(status: TeamAgentRecord['status']): boolean {
  return status === 'idle' || status === 'running'
}

const ROOT_MAILBOX_OBSERVER_PREVIEW_CHARS = 1_000
const ROOT_MAILBOX_PRIMARY_INLINE_CHARS = 8_000

function compactMailboxPreview(content: string, maxChars: number): string {
  const normalized = content.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars).trimEnd()}…`
}

/**
 * The mailbox document is the authoritative body. Root's automatically
 * appended context is only a notification surface: observer copies must not
 * duplicate peer-to-peer bodies, and unusually large task handoffs should be
 * loaded deliberately through TaskGet instead of arriving as an unbounded
 * burst. Taskless direct messages stay inline because they have no TaskGet
 * recovery path.
 */
export function rootMailboxModelBody(
  message: Pick<AgentMailboxMessageRecord,
    'message_id' | 'task_id' | 'summary' | 'content'>,
  deliveryKind: MailboxDeliveryKind | undefined,
): string {
  const durableReference = message.task_id
    ? `Full durable message retained as id=${message.message_id}; call TaskGet for task=${message.task_id} to read it.`
    : `Full durable observer message retained as id=${message.message_id}.`

  if (deliveryKind === 'root_observer') {
    const preview = message.summary?.trim()
      || compactMailboxPreview(message.content, ROOT_MAILBOX_OBSERVER_PREVIEW_CHARS)
    return `summary: ${preview}\n[${durableReference}]`
  }

  if (
    message.task_id
    && message.content.length > ROOT_MAILBOX_PRIMARY_INLINE_CHARS
  ) {
    const preview = message.summary?.trim()
      || compactMailboxPreview(message.content, ROOT_MAILBOX_OBSERVER_PREVIEW_CHARS)
    return `summary: ${preview}\n[${durableReference}]`
  }

  return message.content
}

/** Claim, durably inject, then acknowledge Root's observer/primary mailbox. */
export async function deliverRootMailbox(team: AgentTeamRecord): Promise<{
  delivered: number
  run_id: string | null
}> {
  const claim = await agentTeamRepository.claimMailboxMessages({
    teamId: team.team_id,
    userId: team.user_id,
    agentId: team.root_agent_id,
    limit: 200,
  })
  if (claim.messages.length === 0) return { delivered: 0, run_id: null }
  try {
    let runId: string | null = null
    for (const message of claim.messages) {
      const attachments = message.attachments.length > 0
        ? `\nrefs: ${message.attachments.map(ref => `[${ref.kind}] ${ref.value}`).join(', ')}`
        : ''
      const rootDelivery = message.deliveries.find(delivery => (
        delivery.agent_id === team.root_agent_id
      ))
      const modelBody = rootMailboxModelBody(message, rootDelivery?.kind)
      const content = `${message.created_at.toISOString()} ${message.kind} `
        + `${message.sender_name ?? message.sender_agent_id} → ${message.recipient_name ?? message.recipient_agent_id}`
        + `${message.task_id ? ` task=${message.task_id}` : ''} id=${message.message_id}\n`
        + `${modelBody}${attachments}`
      runId = await wakeRootWithUpdate({
        team,
        content: `Durable Agent mailbox message:\n${content}`,
        sourceIds: [message.message_id],
        deliveryKey: `root-mailbox:${team.team_id}:${message.message_id}`,
        messageId: deterministicInternalId(
          'root_mailbox_message',
          team.team_id,
          message.message_id,
        ),
      })
      if (!runId) break
    }
    if (!runId) {
      await agentTeamRepository.releaseMailboxClaim({
        teamId: team.team_id,
        userId: team.user_id,
        agentId: team.root_agent_id,
        claimId: claim.claim_id,
      })
      return { delivered: 0, run_id: null }
    }
    await agentTeamRepository.acknowledgeMailboxClaim({
      teamId: team.team_id,
      userId: team.user_id,
      agentId: team.root_agent_id,
      claimId: claim.claim_id,
    })
    return { delivered: claim.messages.length, run_id: runId }
  } catch (error) {
    await agentTeamRepository.releaseMailboxClaim({
      teamId: team.team_id,
      userId: team.user_id,
      agentId: team.root_agent_id,
      claimId: claim.claim_id,
    })
    throw error
  }
}

export async function resumeResolvedAgentWait(
  wake: AgentWakeEvaluation,
  userId: string,
): Promise<boolean> {
  const run = await getAgentRun(wake.run_id, userId)
  if (!run) return false
  const wakeMessageId = `agent_wait_resolved_${wake.wait_id}`
  if (run.pending_inputs.some(input => input.message_id === wakeMessageId)) {
    await AgentWaitSubscriptionModel.updateOne(
      {
        wait_id: wake.wait_id,
        status: { $in: ['triggered', 'timed_out'] },
        wake_delivered_at: null,
      },
      { $set: { wake_delivered_at: new Date() } },
    )
    return true
  }
  if (!['waiting_agents', 'recoverable'].includes(run.status)) return false
  const resumed = await resumeWaitingAgentRun(run.run_id, userId, {
    message_id: wakeMessageId,
    message: `WaitForAgents ${wake.wait_id} resolved: ${wake.reason}. Inspect the current Team state and continue.`,
    visibility: 'internal',
    source_kind: 'team_supervision',
    created_at: new Date(),
  })
  if (resumed) {
    await AgentWaitSubscriptionModel.updateOne(
      {
        wait_id: wake.wait_id,
        status: { $in: ['triggered', 'timed_out'] },
        wake_delivered_at: null,
      },
      { $set: { wake_delivered_at: new Date() } },
    )
    if (run.root_visible && run.team_id) {
      const team = await AgentTeamModel.findOne({
        team_id: run.team_id,
        user_id: userId,
      }).lean<AgentTeamRecord>()
      if (team) {
        await announceRootRun(
          team,
          resumed.run_id,
          [wake.wait_id],
          `WaitForAgents ${wake.wait_id} resolved: ${wake.reason}`,
        )
      }
    }
    wakeAgentRunner()
  }
  return Boolean(resumed)
}

/**
 * Close the small race between a Wait subscription resolving and the owning
 * AgentRun becoming `waiting_agents`. A result can arrive after the tool has
 * created the subscription but before the route persists the control
 * boundary; the first wake then correctly sees a running Run and does
 * nothing. Routes call this immediately after storing `waiting_agents` so an
 * already-triggered durable subscription cannot sleep forever.
 */
export async function reconcileAgentWaitBoundary(input: {
  teamId: string
  userId: string
  runId: string
}): Promise<boolean> {
  await agentTeamService.evaluateWake({
    teamId: input.teamId,
    userId: input.userId,
  })
  const resolved = await AgentWaitSubscriptionModel.findOne({
    team_id: input.teamId,
    user_id: input.userId,
    run_id: input.runId,
    status: { $in: ['triggered', 'timed_out'] },
    wake_delivered_at: null,
  }).sort({ resolved_at: -1 }).lean<{
    wait_id: string
    agent_id: string
    run_id: string
    status: 'triggered' | 'timed_out'
    trigger_reason?: string | null
    triggered_event_seq?: number | null
  }>()
  if (!resolved) return false
  return resumeResolvedAgentWait({
    wait_id: resolved.wait_id,
    agent_id: resolved.agent_id,
    run_id: resolved.run_id,
    status: resolved.status,
    reason: resolved.trigger_reason ?? 'task condition satisfied',
    event_seq: resolved.triggered_event_seq ?? undefined,
  }, input.userId)
}

export async function resumeWaitingAgentById(input: {
  teamId: string
  userId: string
  agentId: string
  reason: string
}): Promise<boolean> {
  const agent = await TeamAgentModel.findOne({
    team_id: input.teamId,
    user_id: input.userId,
    agent_id: input.agentId,
  }).lean<TeamAgentRecord>()
  if (!agent) return false
  const active = agent.is_root
    ? await getActiveAgentRun(agent.conversation_id, input.userId)
    : await getActiveAgentRunForSession(agent.current_session_id, input.userId)
  if (!active || active.status !== 'waiting_agents') return false
  const resumed = await resumeWaitingAgentRun(active.run_id, input.userId, {
    message_id: internalMessageId('agent_wait_wake'),
    message: input.reason,
    visibility: 'internal',
    source_kind: 'team_supervision',
    created_at: new Date(),
  })
  if (resumed) wakeAgentRunner()
  return Boolean(resumed)
}

function eventDigest(events: TeamEventRecord[]): string {
  return events.map(event => {
    const subject = event.subject_agent_id ? ` agent=${event.subject_agent_id}` : ''
    const task = event.task_id ? ` task=${event.task_id}` : ''
    return `- #${event.seq} ${event.type}${subject}${task}: ${JSON.stringify(event.payload)}`
  }).join('\n')
}

/**
 * Select only events that can carry new information for a routine Root
 * supervision turn. Execution-slot events are lease bookkeeping, while the
 * Root's own running/idle transitions are consequences of the supervision
 * turn itself. Feeding either category back to Root creates a self-sustaining
 * supervision loop with no new team information.
 */
export function routineSupervisionEvents(
  events: TeamEventRecord[],
  rootAgentId: string,
): TeamEventRecord[] {
  return events.filter(event => {
    if (
      event.type === 'message_sent'
      || event.type === 'supervision_due'
      // Result delivery is an immediate, idempotent turn boundary. Replaying
      // its audit event in the later routine digest would inject the same
      // logical completion into Root twice.
      || event.type === 'result_submitted'
      // Execution-slot claim/release is runtime lease bookkeeping and never
      // requires scientific or coordination judgment from Root.
      || event.type === 'execution_slot_claimed'
      || event.type === 'execution_slot_released'
    ) return false

    // A Root supervision Run changes Root to running and then idle. Those
    // transitions are effects of the Run, not new team state to supervise.
    // Member status changes remain visible because they can require action.
    if (
      event.type === 'agent_status_changed'
      && event.subject_agent_id === rootAgentId
    ) return false

    return true
  })
}

/**
 * `approved` Workspace proposals are a durable publication outbox. A crashed
 * Root tool may have stopped immediately before publication, or immediately
 * after the public CAS but before recording its outcome. Maintenance never
 * writes the public Workspace itself: it only wakes Root under a deterministic
 * delivery key so a fresh, fenced ReviewWorkspaceChanges call can reconcile
 * the exact same authorization.
 */
export async function remindStaleApprovedWorkspacePublications(
  team: AgentTeamRecord,
  now = new Date(),
  staleAfterMs = APPROVED_PUBLICATION_REPAIR_AFTER_MS,
): Promise<number> {
  if (team.status !== 'active') return 0
  const cutoff = new Date(now.getTime() - Math.max(1_000, staleAfterMs))
  const proposals = await WorkspaceProposalModel.find({
    team_id: team.team_id,
    user_id: team.user_id,
    status: 'approved',
    $or: [
      { reviewed_at: { $lte: cutoff } },
      { reviewed_at: null },
      { reviewed_at: { $exists: false } },
    ],
  }).sort({ reviewed_at: 1, created_at: 1 }).limit(100).lean<WorkspaceProposalRecord[]>()

  let notified = 0
  for (const proposal of proposals) {
    const runId = await wakeRootWithUpdate({
      team,
      content: `Approved Workspace publication ${proposal.proposal_id} for result ${proposal.result_id} has not reached a durable outcome. Reconcile it with ReviewWorkspaceChanges using action=accept, the same target ${proposal.target_path}, and expected_target_revision=${proposal.expected_target_revision ?? 'new'}. Do not retarget or reject it until reconciliation completes.`,
      sourceIds: [proposal.proposal_id],
      deliveryKey: `workspace-proposal-repair:${team.team_id}:${proposal.proposal_id}:${proposal.review_command_key ?? 'unkeyed'}`,
      messageId: deterministicInternalId(
        'workspace_proposal_repair',
        team.team_id,
        proposal.proposal_id,
        proposal.review_command_key ?? 'unkeyed',
      ),
    })
    if (runId) notified += 1
  }
  return notified
}

/**
 * Durable maintenance sweep: resolves wait timeouts/readiness and batches only
 * teams with unseen routine events. With no events it makes no model call.
 */
export async function runAgentTeamMaintenanceSweep(now = new Date()): Promise<{
  waits_resumed: number
  supervision_runs: number
  publication_repairs_notified: number
  terminal_root_receipts_released: number
}> {
  const terminalRootReceiptsReleased = await repairTerminalRootTeamQueueReceipts()
  const teams = await AgentTeamModel.find({ status: 'active' }).lean<AgentTeamRecord[]>()
  let waitsResumed = 0
  let supervisionRuns = 0
  let publicationRepairsNotified = 0
  for (const team of teams) {
    publicationRepairsNotified += await remindStaleApprovedWorkspacePublications(team, now)
    await agentTeamService.evaluateWake({
      teamId: team.team_id,
      userId: team.user_id,
      now,
    })
    const wakeups = await AgentWaitSubscriptionModel.find({
      team_id: team.team_id,
      user_id: team.user_id,
      status: { $in: ['triggered', 'timed_out'] },
      wake_delivered_at: null,
    }).sort({ resolved_at: 1 }).limit(500).lean<Array<{
      wait_id: string
      agent_id: string
      run_id: string
      status: 'triggered' | 'timed_out'
      trigger_reason?: string | null
      triggered_event_seq?: number | null
    }>>()
    for (const wake of wakeups) {
      if (await resumeResolvedAgentWait({
        wait_id: wake.wait_id,
        agent_id: wake.agent_id,
        run_id: wake.run_id,
        status: wake.status,
        reason: wake.trigger_reason ?? (wake.status === 'timed_out' ? 'timeout' : 'tasks_ready'),
        event_seq: wake.triggered_event_seq ?? undefined,
      }, team.user_id)) waitsResumed += 1
    }

    const supervisionOwnerId = `team_supervisor_${randomUUID()}`
    const claimed = await agentTeamRepository.claimSupervisionLease({
      teamId: team.team_id,
      userId: team.user_id,
      ownerId: supervisionOwnerId,
      now,
    })
    if (!claimed) continue
    try {
      const leasedTeam = claimed.team
      if (leasedTeam.next_event_seq <= leasedTeam.supervision_cursor) continue
      const events = await agentTeamService.listEventsAfter({
        teamId: leasedTeam.team_id,
        userId: leasedTeam.user_id,
        afterSeq: leasedTeam.supervision_cursor,
        limit: 200,
      })
      if (events.length === 0) continue
      const first = events[0]
      if (now.getTime() - new Date(first.created_at).getTime() < leasedTeam.policy.supervision_interval_ms) {
        continue
      }
      // Freeze the exact event range before injecting it. If the process dies
      // after enqueue but before cursor CAS, takeover reuses this same batch
      // even when newer TeamEvents have since arrived.
      const batch = await agentTeamRepository.getOrCreateSupervisionBatch({
        teamId: leasedTeam.team_id,
        userId: leasedTeam.user_id,
        afterSeq: leasedTeam.supervision_cursor,
        events,
      })
      const mailbox = await deliverRootMailbox(leasedTeam)
      const mailboxSettled = await agentTeamRepository.mailboxDeliveriesSettled({
        teamId: leasedTeam.team_id,
        userId: leasedTeam.user_id,
        agentId: leasedTeam.root_agent_id,
        messageIds: batch.message_ids,
      })
      if (!mailboxSettled) continue

      const supervisionEvents = routineSupervisionEvents(
        batch.events,
        leasedTeam.root_agent_id,
      )
      let runId = batch.delivered_run_id ?? mailbox.run_id
      if (!batch.delivered_at && supervisionEvents.length > 0) {
        runId = await wakeRootWithUpdate({
          team: leasedTeam,
          content: `Routine supervision batch (${supervisionEvents.length} event${supervisionEvents.length === 1 ? '' : 's'}):\n${eventDigest(supervisionEvents)}\n\nObserve first. Intervene only for drift, conflict, blockers, or a necessary next decision.`,
          sourceIds: supervisionEvents.map(event => event.event_id),
          deliveryKey: `root-supervision:${leasedTeam.team_id}:${batch.batch_id}`,
          messageId: deterministicInternalId(
            'root_supervision_batch',
            leasedTeam.team_id,
            batch.batch_id,
          ),
        })
      }
      if (runId || supervisionEvents.length === 0) {
        await agentTeamRepository.markSupervisionBatchDelivered({
          teamId: leasedTeam.team_id,
          userId: leasedTeam.user_id,
          batchId: batch.batch_id,
          runId,
        })
        await agentTeamRepository.advanceSupervisionCursor({
          teamId: leasedTeam.team_id,
          userId: leasedTeam.user_id,
          throughSeq: batch.through_seq,
          lease: claimed.lease,
        })
      }
      if (runId) supervisionRuns += 1
    } finally {
      await agentTeamRepository.releaseSupervisionLease({
        teamId: team.team_id,
        userId: team.user_id,
        ownerId: claimed.lease.ownerId,
        leaseToken: claimed.lease.leaseToken,
      })
    }
  }
  await recoverStaleAgentBudgetAdmissions()
  return {
    waits_resumed: waitsResumed,
    supervision_runs: supervisionRuns,
    publication_repairs_notified: publicationRepairsNotified,
    terminal_root_receipts_released: terminalRootReceiptsReleased,
  }
}

export async function scheduleReadyAgents(teamId: string, userId: string): Promise<void> {
  const agents = await TeamAgentModel.find({
    team_id: teamId,
    user_id: userId,
    is_root: false,
    status: 'idle',
  }).select('agent_id').lean<Array<Pick<TeamAgentRecord, 'agent_id'>>>()
  await Promise.all(agents.map(agent => scheduleNextAgentTask({
    teamId,
    userId,
    agentId: agent.agent_id,
  })))
}
