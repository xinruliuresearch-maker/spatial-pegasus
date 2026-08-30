import { randomUUID } from 'node:crypto'
import {
  AgentMailboxMessageModel,
  AgentResultModel,
  AgentSessionRuntimeModel,
  AgentTaskModel,
  AgentTeamModel,
  AgentWaitSubscriptionModel,
  DelegationGrantModel,
  TeamAgentModel,
  WorkspaceProposalModel,
} from './models'
import {
  AgentCommandFenceLostError,
  AgentControlFenceLostError,
  AgentPermissionError,
  AgentResultNotFoundError,
  AgentTaskNotFoundError,
  AgentTeamCapacityError,
  AgentTeamNotFoundError,
  InvalidAgentTeamOperationError,
  TeamAgentNotFoundError,
} from './errors'
import {
  getActiveAgentRun,
  getActiveAgentRunForSession,
  requestAgentSessionRunCancellation,
  setRunStatus,
  validateAgentRunLeaseFence,
} from '../agent-runtime/repository'
import {
  buildCommandKey,
  defaultTeamPolicy,
  isAgentPrivatePath,
  isBudgetWithin,
  isToolAllowlistSubset,
  memberDelegationGrant,
  normalizeAgentName,
  privateWorkspacePrefix,
  rootDelegationGrant,
  shouldWakeForMessage,
  taskWaitSatisfied,
  toolAllowlistNeedsReferencePublishing,
  visibleAgentTeamTools,
} from './policy'
import {
  agentTeamRepository,
  type MongoAgentTeamRepository,
} from './repository'
import type {
  AcceptedWorkspaceIntent,
  AgentBudget,
  AgentCommandContext,
  AgentContextReference,
  AgentGrantCapabilities,
  AgentMailboxMessageRecord,
  AgentManagementAction,
  AgentMessageKind,
  AgentResultFile,
  AgentResultOutcome,
  AgentResultRecord,
  AgentSessionRuntimeRecord,
  AgentTaskRecord,
  AgentTaskStatus,
  AgentTeamPolicySnapshot,
  AgentTeamRecord,
  AgentTeamSnapshot,
  AgentWaitMode,
  AgentWaitSubscriptionRecord,
  AgentWakeEvaluation,
  DelegationGrantRecord,
  DelegationGrantSnapshot,
  MailboxAttachmentReference,
  TeamAgentRecord,
  TeamEventRecord,
  WorkspaceProposalRecord,
} from './types'
import { MAX_WAIT_TIMEOUT_MS } from './types'
import {
  assertCanDelegatePrivatePaths,
  normalizeWorkspaceReferences,
  persistDelegatedPrivatePaths,
  privatePathsFromReferences,
} from './path-grants'

function asRecord<T>(value: { toObject(): unknown }): T {
  return value.toObject() as T
}

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: number }).code === 11000
}

function cleanText(value: string, field: string, maxLength: number): string {
  const normalized = value.trim()
  if (!normalized) throw new InvalidAgentTeamOperationError(`${field} is required.`)
  if (normalized.length > maxLength) {
    throw new InvalidAgentTeamOperationError(`${field} exceeds ${maxLength} characters.`)
  }
  return normalized
}

function uniqueStrings(values: string[] | undefined, max = 100): string[] {
  return [...new Set((values ?? []).map(value => value.trim()).filter(Boolean))].slice(0, max)
}

function nextId(prefix: string): string {
  return `${prefix}_${randomUUID()}`
}

type CapabilityName = keyof AgentGrantCapabilities

interface ActorState {
  team: AgentTeamRecord
  agent: TeamAgentRecord
  grant: DelegationGrantRecord
}

export interface EnsureAgentTeamInput {
  conversationId: string
  userId: string
  workspaceId?: string
  rootDisplayName?: string
  rootRole?: string
  rootInstructions?: string
  policy?: Partial<AgentTeamPolicySnapshot>
}

export interface CreateAgentInput {
  displayName: string
  role: string
  instructions?: string
  grant?: Omit<Partial<DelegationGrantSnapshot>, 'capabilities'> & {
    capabilities?: Partial<AgentGrantCapabilities>
  }
  initialTask?: Omit<AssignAgentTaskInput, 'assignedAgentId'>
}

export interface AssignAgentTaskInput {
  assignedAgentId: string
  title: string
  objective: string
  acceptanceCriteria?: string[]
  contextRefs?: AgentContextReference[]
  dependencyTaskIds?: string[]
  budget?: AgentBudget
}

export interface SendAgentMessageInput {
  recipientAgentId: string
  kind: AgentMessageKind
  summary?: string
  content: string
  taskId?: string
  correlationId?: string
  replyToMessageId?: string
  attachments?: MailboxAttachmentReference[]
  /** Trusted runtime-only: an automatic turn result has its own single Root
   * delivery, so do not create a second observer mailbox delivery. */
  suppressRootObserver?: boolean
}

export interface CreateAgentWaitInput {
  taskIds: string[]
  mode: AgentWaitMode
  timeoutMs: number
}

export interface SubmitAgentResultInput {
  taskId?: string
  outcome?: AgentResultOutcome
  finalResponse: string
  summary?: Record<string, unknown>
  evidenceRefs?: AgentContextReference[]
  files?: AgentResultFile[]
  implicit?: boolean
  /** Internal turn-boundary compatibility: keep the result taskless if the
   * referenced Task became terminal while this Run was still finishing. */
  allowTerminalTaskFallback?: boolean
}

export interface UpdateAgentTaskInput {
  taskId: string
  status?: AgentTaskStatus
  ownerAgentId?: string
  title?: string
  objective?: string
  acceptanceCriteria?: string[]
  dependencyTaskIds?: string[]
}

export interface ReviewAgentResultInput {
  resultId: string
  items: Array<{
    proposalId: string
    action: 'accept' | 'reject' | 'retarget' | 'request_changes'
    targetPath?: string
    expectedTargetRevision?: number | null
    note?: string
  }>
  /** Optional for workspace-only review. Task acceptance is a separate
   * TaskUpdate decision in the conversational tool surface. */
  taskDecision?: 'accepted' | 'rework'
  taskNote?: string
}

export interface InspectAgentTeamInput {
  conversationId?: string
  teamId?: string
  userId: string
  callerAgentId?: string
  includeMessages?: boolean
  messageLimit?: number
}

export interface ManageAgentResult {
  agent: TeamAgentRecord
  session?: AgentSessionRuntimeRecord
  team_status: AgentTeamRecord['status']
}

const TASK_UPDATE_TRANSITIONS: Readonly<Record<AgentTaskStatus, readonly AgentTaskStatus[]>> = {
  queued: ['waiting', 'cancelled'],
  running: ['waiting', 'cancelled'],
  waiting: ['queued', 'cancelled'],
  submitted: ['accepted', 'rework', 'cancelled'],
  accepted: [],
  rework: ['queued', 'waiting', 'cancelled'],
  failed: [],
  cancelled: [],
}

function assertTaskTransition(current: AgentTaskStatus, next: AgentTaskStatus): void {
  if (current === next) return
  if (!TASK_UPDATE_TRANSITIONS[current].includes(next)) {
    throw new InvalidAgentTeamOperationError(
      `Task status cannot transition from ${current} to ${next}.`,
    )
  }
}

export class AgentTeamService {
  constructor(public readonly repository: MongoAgentTeamRepository = agentTeamRepository) {}

  private async resolveTeam(input: {
    userId: string
    conversationId?: string
    teamId?: string
  }): Promise<AgentTeamRecord> {
    await this.repository.connect()
    if (!input.conversationId && !input.teamId) {
      throw new InvalidAgentTeamOperationError('conversationId or teamId is required.')
    }
    const team = await AgentTeamModel.findOne({
      user_id: input.userId,
      ...(input.teamId ? { team_id: input.teamId } : {}),
      ...(input.conversationId ? { conversation_id: input.conversationId } : {}),
    }).lean<AgentTeamRecord>()
    if (!team) throw new AgentTeamNotFoundError()
    return team
  }

  private async loadActor(context: Pick<AgentCommandContext, 'team_id' | 'user_id' | 'caller_agent_id'>): Promise<ActorState> {
    const team = await this.resolveTeam({ teamId: context.team_id, userId: context.user_id })
    const agent = await TeamAgentModel.findOne({
      team_id: team.team_id,
      user_id: context.user_id,
      agent_id: context.caller_agent_id,
    }).lean<TeamAgentRecord>()
    if (!agent) throw new TeamAgentNotFoundError(context.caller_agent_id)
    const grant = await DelegationGrantModel.findOne({
      team_id: team.team_id,
      user_id: context.user_id,
      agent_id: agent.agent_id,
      active_key: `${team.team_id}:${agent.agent_id}`,
    }).lean<DelegationGrantRecord>()
    if (!grant) throw new AgentPermissionError('active_delegation_grant')
    return { team, agent, grant }
  }

  private requireCapability(actor: ActorState, capability: CapabilityName): void {
    if (!actor.grant.capabilities[capability]) throw new AgentPermissionError(capability)
  }

  private requireRoot(actor: ActorState, capability: CapabilityName): void {
    this.requireCapability(actor, capability)
    if (!actor.agent.is_root || actor.team.root_agent_id !== actor.agent.agent_id) {
      throw new AgentPermissionError('root_coordinator')
    }
  }

  private async assertExecutionFence(context: AgentCommandContext): Promise<void> {
    if (!context.require_execution_fence) return
    const ownerId = context.execution_owner_id
    if (!ownerId || !(await validateAgentRunLeaseFence(context.run_id, ownerId))) {
      throw new AgentControlFenceLostError(context.run_id)
    }
    if (!context.team_fence_required) return
    if (!context.agent_session_id || !(await this.repository.validateExecutionFence({
      teamId: context.team_id,
      userId: context.user_id,
      agentId: context.caller_agent_id,
      sessionId: context.agent_session_id,
      runId: context.run_id,
      ownerId,
    }))) {
      throw new AgentControlFenceLostError(context.run_id)
    }
  }

  private async withCommand<T>(input: {
    context: AgentCommandContext
    commandName: string
    reservations: Record<string, string>
    execute: (
      commandKey: string,
      reservations: Record<string, string>,
      assertWriteFence: () => Promise<void>,
    ) => Promise<T>
  }): Promise<T> {
    // Reject delayed/stale executors before they can acquire a command receipt.
    // The command receipt supplies idempotency; the Run/Team leases supply the
    // authority to create that receipt and perform fresh side effects.
    await this.assertExecutionFence(input.context)
    const commandKey = buildCommandKey(
      cleanText(input.context.run_id, 'run_id', 300),
      cleanText(input.context.tool_use_id, 'tool_use_id', 300),
      input.commandName,
    )
    const lease = await this.repository.beginCommand<T>({
      teamId: input.context.team_id,
      userId: input.context.user_id,
      actorAgentId: input.context.caller_agent_id,
      runId: input.context.run_id,
      toolUseId: input.context.tool_use_id,
      commandName: input.commandName,
      commandKey,
      reservations: input.reservations,
    })
    if (lease.replay !== undefined) return lease.replay
    try {
      // A short command lease becomes the child write permit for this exact
      // (run_id, tool_use_id) operation. Re-sample the parent execution fences
      // on both sides of its renewal: a takeover cannot reclaim the command
      // receipt or enter a later mutation phase under the previous owner.
      const assertWriteFence = async () => {
        await this.assertExecutionFence(input.context)
        if (!await this.repository.renewCommandLease(lease)) {
          throw new AgentCommandFenceLostError(commandKey)
        }
        await this.assertExecutionFence(input.context)
      }
      await assertWriteFence()
      const response = await input.execute(
        commandKey,
        lease.receipt.reservations,
        assertWriteFence,
      )
      await assertWriteFence()
      await this.repository.completeCommand(lease, response)
      return response
    } catch (error) {
      await this.repository.failCommand(lease, error)
      throw error
    }
  }

  async ensureTeam(input: EnsureAgentTeamInput): Promise<AgentTeamRecord> {
    await this.repository.connect()
    const conversationId = cleanText(input.conversationId, 'conversationId', 300)
    const userId = cleanText(input.userId, 'userId', 300)
    let team = await AgentTeamModel.findOne({ conversation_id: conversationId, user_id: userId })
    let created = false
    if (!team) {
      const policy = { ...defaultTeamPolicy(), ...(input.policy ?? {}) }
      policy.max_active_agents = Math.max(1, Math.min(8, policy.max_active_agents))
      policy.max_total_agents = Math.max(1, Math.min(32, policy.max_total_agents))
      policy.supervision_interval_ms = Math.max(10_000, policy.supervision_interval_ms)
      const teamId = nextId('agent_team')
      try {
        team = await AgentTeamModel.create({
          team_id: teamId,
          conversation_id: conversationId,
          user_id: userId,
          root_agent_id: nextId('agent'),
          workspace_id: input.workspaceId?.trim() || conversationId,
          status: 'active',
          policy,
          next_event_seq: 0,
          supervision_cursor: 0,
          completed_at: null,
        })
        created = true
      } catch (error) {
        if (!isDuplicateKey(error)) throw error
        team = await AgentTeamModel.findOne({ conversation_id: conversationId, user_id: userId })
      }
    }
    if (!team) throw new AgentTeamNotFoundError()
    if (created) {
      await this.repository.appendEvent({
        teamId: team.team_id,
        userId,
        type: 'team_created',
        subjectAgentId: team.root_agent_id,
        payload: { max_active_agents: team.policy.max_active_agents, max_total_agents: team.policy.max_total_agents },
        dedupeKey: 'bootstrap:team_created',
      })
    }
    await this.ensureRootAgent(team, input)
    const current = await AgentTeamModel.findOne({ team_id: team.team_id, user_id: userId }).lean<AgentTeamRecord>()
    if (!current) throw new AgentTeamNotFoundError()
    return current
  }

  private async ensureRootAgent(team: AgentTeamRecord | InstanceType<typeof AgentTeamModel>, input: EnsureAgentTeamInput): Promise<void> {
    const now = new Date()
    const rootAgentId = team.root_agent_id
    const existing = await TeamAgentModel.findOne({
      team_id: team.team_id,
      user_id: team.user_id,
      agent_id: rootAgentId,
    })
    const sessionId = existing?.current_session_id ?? nextId('agent_session')
    const grantId = existing?.active_grant_id ?? nextId('agent_grant')
    if (!existing) {
      await TeamAgentModel.updateOne(
        { agent_id: rootAgentId },
        {
          $setOnInsert: {
            agent_id: rootAgentId,
            team_id: team.team_id,
            conversation_id: team.conversation_id,
            user_id: team.user_id,
            slot: 0,
            display_name: input.rootDisplayName?.trim() || 'Root',
            normalized_name: normalizeAgentName(input.rootDisplayName?.trim() || 'Root'),
            role: input.rootRole?.trim() || '空间创作协调者',
            instructions: input.rootInstructions?.trim() || null,
            is_root: true,
            created_by_agent_id: null,
            status: 'idle',
            generation: 1,
            current_session_id: sessionId,
            active_grant_id: grantId,
            grant_version: 1,
            private_workspace_prefix: privateWorkspacePrefix(rootAgentId),
            last_transition_at: now,
          },
        },
        { upsert: true },
      )
    }

    // `ensureTeam` is intentionally called from chat, snapshot and stream
    // routes. Those requests can bootstrap the same project concurrently. The
    // loser of the TeamAgent upsert must discard its locally-reserved IDs and
    // continue from the single durable Root record; otherwise it can insert a
    // second version-1 Grant (or Session) under a different ID and trip the
    // logical unique indexes.
    const durableRoot = await TeamAgentModel.findOne({
      team_id: team.team_id,
      user_id: team.user_id,
      agent_id: rootAgentId,
    }).lean<TeamAgentRecord>()
    if (!durableRoot) throw new TeamAgentNotFoundError(rootAgentId)

    const rootGrant = rootDelegationGrant()
    const grantIdentity = {
      team_id: team.team_id,
      user_id: team.user_id,
      agent_id: rootAgentId,
      version: 1,
    }
    try {
      await DelegationGrantModel.updateOne(
        grantIdentity,
        {
          $setOnInsert: {
            grant_id: durableRoot.active_grant_id,
            ...grantIdentity,
            active_key: `${team.team_id}:${rootAgentId}`,
            granted_by_agent_id: rootAgentId,
            reason: 'Project-scoped Root coordinator grant',
            ...rootGrant,
            created_at: now,
          },
        },
        { upsert: true },
      )
    } catch (error) {
      // Mongo may surface the losing concurrent upsert as E11000 even though
      // the winner committed the exact logical record. Only absorb that race
      // after verifying the winner is now durable.
      if (!isDuplicateKey(error) || !await DelegationGrantModel.exists(grantIdentity)) {
        throw error
      }
    }

    const sessionIdentity = {
      team_id: team.team_id,
      user_id: team.user_id,
      agent_id: rootAgentId,
      generation: 1,
    }
    try {
      await AgentSessionRuntimeModel.updateOne(
        sessionIdentity,
        {
          $setOnInsert: {
            session_id: durableRoot.current_session_id,
            ...sessionIdentity,
            conversation_id: team.conversation_id,
            active_run_id: null,
            active_lease_owner_id: null,
            run_lease: null,
            revision: 0,
            messages: [],
            compacted_messages: [],
            hippocampus: {},
            model_snapshot: null,
          },
        },
        { upsert: true },
      )
    } catch (error) {
      if (!isDuplicateKey(error) || !await AgentSessionRuntimeModel.exists(sessionIdentity)) {
        throw error
      }
    }

    // Repair standalone-Mongo crash/concurrency remnants from an older build:
    // a logical Grant or Session may have committed with a reserved ID that is
    // different from the one stored on TeamAgent. Adopt the durable logical
    // records instead of deleting history or attempting a duplicate insert.
    const [durableGrant, durableSession] = await Promise.all([
      DelegationGrantModel.findOne({
        team_id: team.team_id,
        user_id: team.user_id,
        agent_id: rootAgentId,
        version: 1,
      }).lean<DelegationGrantRecord>(),
      AgentSessionRuntimeModel.findOne({
        team_id: team.team_id,
        user_id: team.user_id,
        agent_id: rootAgentId,
        generation: 1,
      }).lean<AgentSessionRuntimeRecord>(),
    ])
    if (!durableGrant) throw new AgentPermissionError('root_grant_bootstrap')
    if (!durableSession) throw new InvalidAgentTeamOperationError('Root session bootstrap failed.')
    if (
      durableRoot.active_grant_id !== durableGrant.grant_id
      || durableRoot.current_session_id !== durableSession.session_id
    ) {
      await TeamAgentModel.updateOne(
        {
          team_id: team.team_id,
          user_id: team.user_id,
          agent_id: rootAgentId,
          generation: 1,
        },
        {
          $set: {
            active_grant_id: durableGrant.grant_id,
            grant_version: durableGrant.version,
            current_session_id: durableSession.session_id,
          },
        },
      )
    }
    await this.repository.appendEvent({
      teamId: team.team_id,
      userId: team.user_id,
      type: 'agent_created',
      actorAgentId: rootAgentId,
      subjectAgentId: rootAgentId,
      payload: { display_name: input.rootDisplayName?.trim() || 'Root', role: input.rootRole?.trim() || '空间创作协调者', is_root: true },
      dedupeKey: 'bootstrap:root_agent_created',
    })
  }

  async getTeam(input: { conversationId?: string; teamId?: string; userId: string }): Promise<AgentTeamRecord> {
    return this.resolveTeam(input)
  }

  async getAgent(input: { teamId: string; userId: string; agentId: string }): Promise<TeamAgentRecord> {
    await this.repository.connect()
    const agent = await TeamAgentModel.findOne({
      team_id: input.teamId,
      user_id: input.userId,
      agent_id: input.agentId,
    }).lean<TeamAgentRecord>()
    if (!agent) throw new TeamAgentNotFoundError(input.agentId)
    return agent
  }

  async getActiveGrant(input: { teamId: string; userId: string; agentId: string }): Promise<DelegationGrantRecord> {
    await this.repository.connect()
    const grant = await DelegationGrantModel.findOne({
      team_id: input.teamId,
      user_id: input.userId,
      agent_id: input.agentId,
      active_key: `${input.teamId}:${input.agentId}`,
    }).lean<DelegationGrantRecord>()
    if (!grant) throw new AgentPermissionError('active_delegation_grant')
    return grant
  }

  /**
   * A failed Root is an execution failure, not a user-requested project close.
   * Recover it only at the authenticated public-input boundary; read-only Team
   * endpoints and internal supervision must never resurrect a failed Agent.
   *
   * A never-started supervision Run may still own the Conversation active key.
   * Supersede that exact unleased Run before restoring Root so the user's new
   * turn can become the active Run. Its targeted queue rows are released by
   * the caller after this fenced state transition and remain durable.
   */
  async recoverFailedRootForPublicInput(input: {
    conversationId: string
    userId: string
  }): Promise<{ recovered: boolean; supersededRunId?: string }> {
    await this.repository.connect()
    const team = await AgentTeamModel.findOne({
      conversation_id: input.conversationId,
      user_id: input.userId,
      status: 'active',
    }).lean<AgentTeamRecord>()
    if (!team) return { recovered: false }

    const root = await TeamAgentModel.findOne({
      team_id: team.team_id,
      user_id: input.userId,
      agent_id: team.root_agent_id,
      is_root: true,
      status: 'failed',
    }).lean<TeamAgentRecord>()
    if (!root) return { recovered: false }

    const now = new Date()
    const session = await AgentSessionRuntimeModel.findOne({
      session_id: root.current_session_id,
      team_id: team.team_id,
      user_id: input.userId,
      agent_id: root.agent_id,
      generation: root.generation,
    }).lean<AgentSessionRuntimeRecord>()
    if (!session) return { recovered: false }
    if (
      session.run_lease?.expires_at
      && new Date(session.run_lease.expires_at).getTime() > now.getTime()
    ) return { recovered: false }

    let supersededRunId: string | undefined
    const activeRun = await getActiveAgentRun(input.conversationId, input.userId)
    if (activeRun) {
      const canSupersede = activeRun.status === 'queued'
        && !activeRun.lease
        && activeRun.trigger === 'supervision'
        && activeRun.team_id === team.team_id
        && activeRun.agent_id === root.agent_id
        && activeRun.agent_session_id === root.current_session_id
        && activeRun.checkpoint_seq === 0
        && !activeRun.current_action
      if (!canSupersede) return { recovered: false }
      const cancelled = await setRunStatus(activeRun.run_id, 'cancelled', {
        terminationReason: 'runtime_error',
        error: 'Superseded by authenticated public input after Root recovery.',
        releaseActive: true,
        onlyIfUnleased: true,
      })
      if (!cancelled) return { recovered: false }
      supersededRunId = activeRun.run_id
    }

    const recovered = await TeamAgentModel.findOneAndUpdate(
      {
        team_id: team.team_id,
        user_id: input.userId,
        agent_id: root.agent_id,
        is_root: true,
        status: 'failed',
        generation: root.generation,
        current_session_id: root.current_session_id,
      },
      {
        $set: {
          status: 'idle',
          completed_at: null,
          interrupt_requested_at: null,
          last_transition_at: now,
        },
      },
      { returnDocument: 'after' },
    ).lean<TeamAgentRecord>()
    if (!recovered) {
      // A concurrent public request may have won the same recovery CAS. The
      // active-Run unique key remains the final concurrency authority.
      const alreadyRecovered = await TeamAgentModel.exists({
        team_id: team.team_id,
        user_id: input.userId,
        agent_id: root.agent_id,
        generation: root.generation,
        current_session_id: root.current_session_id,
        status: 'idle',
      })
      return { recovered: Boolean(alreadyRecovered), supersededRunId }
    }

    await this.repository.appendEvent({
      teamId: team.team_id,
      userId: input.userId,
      type: 'agent_status_changed',
      actorAgentId: root.agent_id,
      subjectAgentId: root.agent_id,
      payload: { status: 'idle', reason: 'public_input_recovery' },
      dedupeKey: `public_input_recovery:${root.agent_id}:${root.generation}:${new Date(root.last_transition_at).getTime()}`,
    })
    return { recovered: true, supersededRunId }
  }

  async exposedTools(input: { teamId: string; userId: string; agentId: string }): Promise<string[]> {
    return visibleAgentTeamTools(await this.getActiveGrant(input))
  }

  async createAgent(context: AgentCommandContext, input: CreateAgentInput): Promise<{
    agent: TeamAgentRecord
    session: AgentSessionRuntimeRecord
    grant: DelegationGrantRecord
    task?: AgentTaskRecord
  }> {
    const actor = await this.loadActor(context)
    this.requireRoot(actor, 'can_create_agents')
    if (actor.team.status !== 'active') {
      throw new InvalidAgentTeamOperationError('Cannot create an Agent in a completed team.')
    }
    const displayName = cleanText(input.displayName, 'displayName', 120)
    const role = cleanText(input.role, 'role', 500)
    const requestedGrant = memberDelegationGrant(input.grant)
    // Literature tools always persist immutable audits/artifacts. Their
    // explicit allowlisting is Root's narrow managed-reference grant; generic
    // Write/Edit still reject the protected artifact paths.
    requestedGrant.capabilities.can_publish_references = toolAllowlistNeedsReferencePublishing(
      requestedGrant.allowed_tool_names,
    )
    if (!isToolAllowlistSubset(requestedGrant.allowed_tool_names, actor.grant.allowed_tool_names)) {
      throw new AgentPermissionError('tool_allowlist_subset')
    }
    if (!isBudgetWithin(requestedGrant.budget, actor.grant.budget)
      || !isBudgetWithin(requestedGrant.budget, actor.team.policy.global_budget)) {
      throw new AgentPermissionError('budget_ceiling')
    }
    if (input.initialTask) {
      cleanText(input.initialTask.title, 'initialTask.title', 300)
      cleanText(input.initialTask.objective, 'initialTask.objective', 20_000)
      const dependencies = uniqueStrings(input.initialTask.dependencyTaskIds)
      if (dependencies.length > 0) {
        const count = await AgentTaskModel.countDocuments({
          team_id: actor.team.team_id,
          user_id: actor.team.user_id,
          task_id: { $in: dependencies },
        })
        if (count !== dependencies.length) {
          throw new InvalidAgentTeamOperationError('One or more dependency tasks are outside this team.')
        }
      }
    }
    const reservations = {
      agent_id: nextId('agent'),
      session_id: nextId('agent_session'),
      grant_id: nextId('agent_grant'),
      ...(input.initialTask ? { task_id: nextId('agent_task') } : {}),
    }
    return this.withCommand({
      context,
      commandName: 'CreateAgent',
      reservations,
      execute: async (commandKey, ids, assertWriteFence) => {
        let agent = await TeamAgentModel.findOne({ team_id: actor.team.team_id, creation_command_key: commandKey })
        if (!agent) {
          const sameName = await TeamAgentModel.findOne({
            team_id: actor.team.team_id,
            normalized_name: normalizeAgentName(displayName),
          }).lean<TeamAgentRecord>()
          if (sameName) {
            throw new InvalidAgentTeamOperationError('Agent display name is already in use.', {
              agent_id: sameName.agent_id,
            })
          }
          await assertWriteFence()
          for (let slot = 1; slot < actor.team.policy.max_total_agents; slot += 1) {
            try {
              agent = await TeamAgentModel.create({
                agent_id: ids.agent_id,
                team_id: actor.team.team_id,
                conversation_id: actor.team.conversation_id,
                user_id: actor.team.user_id,
                slot,
                display_name: displayName,
                normalized_name: normalizeAgentName(displayName),
                role,
                instructions: input.instructions?.trim() || null,
                is_root: false,
                created_by_agent_id: actor.agent.agent_id,
                status: 'idle',
                generation: 1,
                current_session_id: ids.session_id,
                active_grant_id: ids.grant_id,
                grant_version: 1,
                private_workspace_prefix: privateWorkspacePrefix(ids.agent_id),
                creation_command_key: commandKey,
                last_transition_at: new Date(),
              })
              break
            } catch (error) {
              if (!isDuplicateKey(error)) throw error
              const commandAgent = await TeamAgentModel.findOne({
                team_id: actor.team.team_id,
                creation_command_key: commandKey,
              })
              if (commandAgent) {
                agent = commandAgent
                break
              }
              const nameCollision = await TeamAgentModel.findOne({
                team_id: actor.team.team_id,
                normalized_name: normalizeAgentName(displayName),
              })
              if (nameCollision) {
                throw new InvalidAgentTeamOperationError('Agent display name is already in use.')
              }
            }
          }
        }
        if (!agent) throw new AgentTeamCapacityError(actor.team.policy.max_total_agents)

        await assertWriteFence()
        await DelegationGrantModel.updateOne(
          { grant_id: agent.active_grant_id },
          {
            $setOnInsert: {
              grant_id: agent.active_grant_id,
              team_id: actor.team.team_id,
              user_id: actor.team.user_id,
              agent_id: agent.agent_id,
              version: 1,
              active_key: `${actor.team.team_id}:${agent.agent_id}`,
              granted_by_agent_id: actor.agent.agent_id,
              reason: 'Initial member grant',
              ...requestedGrant,
              created_at: new Date(),
            },
          },
          { upsert: true },
        )
        await AgentSessionRuntimeModel.updateOne(
          { session_id: agent.current_session_id },
          {
            $setOnInsert: {
              session_id: agent.current_session_id,
              team_id: actor.team.team_id,
              conversation_id: actor.team.conversation_id,
              user_id: actor.team.user_id,
              agent_id: agent.agent_id,
              generation: agent.generation,
              active_run_id: null,
              active_lease_owner_id: null,
              run_lease: null,
              revision: 0,
              messages: [],
              compacted_messages: [],
              hippocampus: {},
              model_snapshot: null,
            },
          },
          { upsert: true },
        )
        const task = input.initialTask
          ? await this.assignTaskCore(actor, {
            ...input.initialTask,
            assignedAgentId: agent.agent_id,
          }, commandKey, ids.task_id, assertWriteFence)
          : undefined
        await this.repository.appendEvent({
          teamId: actor.team.team_id,
          userId: actor.team.user_id,
          type: 'agent_created',
          actorAgentId: actor.agent.agent_id,
          subjectAgentId: agent.agent_id,
          taskId: task?.task_id,
          runId: context.run_id,
          payload: { display_name: agent.display_name, role: agent.role, is_root: false },
          dedupeKey: `${commandKey}:agent_created`,
        })
        const [freshAgent, session, grant] = await Promise.all([
          TeamAgentModel.findOne({ agent_id: agent.agent_id }).lean<TeamAgentRecord>(),
          AgentSessionRuntimeModel.findOne({ session_id: agent.current_session_id }).lean<AgentSessionRuntimeRecord>(),
          DelegationGrantModel.findOne({ grant_id: agent.active_grant_id }).lean<DelegationGrantRecord>(),
        ])
        if (!freshAgent || !session || !grant) {
          throw new Error('Agent creation did not finish its dependent records.')
        }
        return { agent: freshAgent, session, grant, ...(task ? { task } : {}) }
      },
    })
  }

  private async assignTaskCore(
    actor: ActorState,
    input: AssignAgentTaskInput,
    commandKey: string,
    taskId: string,
    assertWriteFence: () => Promise<void>,
  ): Promise<AgentTaskRecord> {
    if (!isBudgetWithin(input.budget, actor.grant.budget)
      || !isBudgetWithin(input.budget, actor.team.policy.global_budget)) {
      throw new AgentPermissionError('budget_ceiling')
    }
    const normalizedContextRefs = normalizeWorkspaceReferences(input.contextRefs ?? []).slice(0, 200)
    const delegatedPrivatePaths = privatePathsFromReferences(normalizedContextRefs)
    assertCanDelegatePrivatePaths({
      actorAgentId: actor.agent.agent_id,
      actorIsRoot: actor.agent.is_root,
      actorAllowedReadPaths: actor.grant.allowed_read_paths,
      paths: delegatedPrivatePaths,
    })
    const existing = await AgentTaskModel.findOne({ team_id: actor.team.team_id, creation_command_key: commandKey })
    if (existing) {
      await assertWriteFence()
      await persistDelegatedPrivatePaths({
        teamId: actor.team.team_id,
        userId: actor.team.user_id,
        recipientAgentId: existing.assigned_agent_id,
        paths: delegatedPrivatePaths,
      })
      return asRecord<AgentTaskRecord>(existing)
    }
    const assignee = await TeamAgentModel.findOne({
      team_id: actor.team.team_id,
      user_id: actor.team.user_id,
      agent_id: input.assignedAgentId,
    }).lean<TeamAgentRecord>()
    if (!assignee) throw new TeamAgentNotFoundError(input.assignedAgentId)
    if (assignee.is_root) {
      throw new InvalidAgentTeamOperationError('Root receives work through the public coordinator Run, not the member task queue.')
    }
    if (assignee.status === 'completed') {
      throw new InvalidAgentTeamOperationError('A completed Agent must be reopened before receiving work.')
    }
    const dependencies = uniqueStrings(input.dependencyTaskIds)
    if (dependencies.includes(taskId)) {
      throw new InvalidAgentTeamOperationError('A task cannot depend on itself.')
    }
    if (dependencies.length > 0) {
      const count = await AgentTaskModel.countDocuments({
        team_id: actor.team.team_id,
        user_id: actor.team.user_id,
        task_id: { $in: dependencies },
      })
      if (count !== dependencies.length) {
        throw new InvalidAgentTeamOperationError('One or more dependency tasks are outside this team.')
      }
    }
    await assertWriteFence()
    const created = await AgentTaskModel.create({
      task_id: taskId,
      team_id: actor.team.team_id,
      conversation_id: actor.team.conversation_id,
      user_id: actor.team.user_id,
      title: cleanText(input.title, 'title', 300),
      objective: cleanText(input.objective, 'objective', 20_000),
      acceptance_criteria: uniqueStrings(input.acceptanceCriteria, 50),
      context_refs: normalizedContextRefs,
      assigned_agent_id: assignee.agent_id,
      created_by_agent_id: actor.agent.agent_id,
      dependency_task_ids: dependencies,
      status: 'queued',
      waiting_kind: null,
      ...(input.budget ? { budget: input.budget } : {}),
      result_ids: [],
      active_result_id: null,
      creation_command_key: commandKey,
    })
    await assertWriteFence()
    await persistDelegatedPrivatePaths({
      teamId: actor.team.team_id,
      userId: actor.team.user_id,
      recipientAgentId: assignee.agent_id,
      paths: delegatedPrivatePaths,
    })
    await this.repository.appendEvent({
      teamId: actor.team.team_id,
      userId: actor.team.user_id,
      type: 'task_assigned',
      actorAgentId: actor.agent.agent_id,
      subjectAgentId: assignee.agent_id,
      taskId: created.task_id,
      payload: { title: created.title, status: 'queued' },
      dedupeKey: `${commandKey}:task_assigned`,
    })
    return asRecord<AgentTaskRecord>(created)
  }

  async assignTask(context: AgentCommandContext, input: AssignAgentTaskInput): Promise<AgentTaskRecord> {
    const actor = await this.loadActor(context)
    this.requireCapability(actor, 'can_delegate_tasks')
    return this.withCommand({
      context,
      commandName: 'AssignAgentTask',
      reservations: { task_id: nextId('agent_task') },
      execute: (commandKey, ids, assertWriteFence) => this.assignTaskCore(
        actor,
        input,
        commandKey,
        ids.task_id,
        assertWriteFence,
      ),
    })
  }

  /**
   * Mutate the shared task ledger without coupling it to Agent messaging.
   *
   * Task owners may only move their own work through execution states. Root
   * and explicitly-authorized delegators may also edit/reassign schedulable
   * work. Submission remains a turn-result boundary; only Root can accept or
   * return a submitted Task for rework.
   */
  async updateTask(
    context: AgentCommandContext,
    input: UpdateAgentTaskInput,
  ): Promise<AgentTaskRecord> {
    const actor = await this.loadActor(context)
    const taskId = cleanText(input.taskId, 'taskId', 300)
    const task = await AgentTaskModel.findOne({
      team_id: actor.team.team_id,
      user_id: actor.team.user_id,
      task_id: taskId,
    }).lean<AgentTaskRecord>()
    if (!task) throw new AgentTaskNotFoundError(taskId)

    const isOwner = task.assigned_agent_id === actor.agent.agent_id
    const canDelegate = actor.agent.is_root || actor.grant.capabilities.can_delegate_tasks
    if (!isOwner && !canDelegate) throw new AgentPermissionError('update_owned_task')

    const editsMetadata = input.ownerAgentId !== undefined
      || input.title !== undefined
      || input.objective !== undefined
      || input.acceptanceCriteria !== undefined
      || input.dependencyTaskIds !== undefined
    if (editsMetadata && !canDelegate) {
      throw new AgentPermissionError('delegate_task_metadata')
    }
    if (!input.status && !editsMetadata) {
      throw new InvalidAgentTeamOperationError('TaskUpdate requires at least one change.')
    }
    if (['accepted', 'failed', 'cancelled'].includes(task.status)) {
      const commandKey = buildCommandKey(
        cleanText(context.run_id, 'run_id', 300),
        cleanText(context.tool_use_id, 'tool_use_id', 300),
        'TaskUpdate',
      )
      if (task.last_command_key !== commandKey) {
        throw new InvalidAgentTeamOperationError(`Task ${task.task_id} is terminal.`)
      }
    }

    let nextStatus = input.status ?? task.status
    let nextWaitingKind = task.waiting_kind ?? null
    if (input.status) {
      if (input.status === 'running') {
        throw new InvalidAgentTeamOperationError(
          'running is runtime-owned and can only be entered by the Agent scheduler.',
        )
      }
      if (['submitted', 'failed'].includes(input.status)) {
        throw new InvalidAgentTeamOperationError(
          `${input.status} is controlled by turn-result or runtime failure boundaries.`,
        )
      }
      if (['accepted', 'rework'].includes(input.status)
        && task.status === 'submitted'
        && !actor.agent.is_root) {
        throw new AgentPermissionError('root_task_review')
      }
      if (!canDelegate && !['waiting', 'cancelled'].includes(input.status)) {
        throw new AgentPermissionError('update_owned_task_status')
      }
      assertTaskTransition(task.status, input.status)
      nextWaitingKind = input.status === 'waiting' ? 'manual' : null
    }

    let nextOwnerId = task.assigned_agent_id
    let reassignmentPrivatePaths: string[] = []
    if (input.ownerAgentId !== undefined) {
      if (!['queued', 'waiting', 'rework'].includes(task.status)) {
        throw new InvalidAgentTeamOperationError(
          'A running or submitted Task must be interrupted/reworked before reassignment.',
        )
      }
      const ownerId = cleanText(input.ownerAgentId, 'ownerAgentId', 300)
      const owner = await TeamAgentModel.findOne({
        team_id: actor.team.team_id,
        user_id: actor.team.user_id,
        agent_id: ownerId,
      }).lean<TeamAgentRecord>()
      if (!owner) throw new TeamAgentNotFoundError(ownerId)
      if (owner.is_root || ['completed', 'failed'].includes(owner.status)) {
        throw new InvalidAgentTeamOperationError(
          'Task owner must be an active member Agent.',
        )
      }
      nextOwnerId = owner.agent_id
      reassignmentPrivatePaths = privatePathsFromReferences(task.context_refs)
      assertCanDelegatePrivatePaths({
        actorAgentId: actor.agent.agent_id,
        actorIsRoot: actor.agent.is_root,
        actorAllowedReadPaths: actor.grant.allowed_read_paths,
        paths: reassignmentPrivatePaths,
      })
      if (nextOwnerId !== task.assigned_agent_id) {
        nextStatus = 'queued'
        nextWaitingKind = null
      }
    }

    const metadataChangeAllowed = ['queued', 'waiting', 'rework'].includes(task.status)
    if (editsMetadata && !metadataChangeAllowed) {
      throw new InvalidAgentTeamOperationError(
        'Task metadata can only change while the Task is queued, waiting, or in rework.',
      )
    }

    let dependencies = task.dependency_task_ids
    if (input.dependencyTaskIds !== undefined) {
      dependencies = uniqueStrings(input.dependencyTaskIds)
      if (dependencies.includes(task.task_id)) {
        throw new InvalidAgentTeamOperationError('A Task cannot depend on itself.')
      }
      const teamTasks = await AgentTaskModel.find({
        team_id: actor.team.team_id,
        user_id: actor.team.user_id,
      }).select('task_id dependency_task_ids status').lean<Array<Pick<
        AgentTaskRecord,
        'task_id' | 'dependency_task_ids' | 'status'
      >>>()
      const graph = new Map(teamTasks.map(candidate => [
        candidate.task_id,
        candidate.dependency_task_ids,
      ]))
      for (const dependency of dependencies) {
        if (!graph.has(dependency)) {
          throw new InvalidAgentTeamOperationError(
            'One or more dependency Tasks are outside this Team.',
          )
        }
        const pending = [dependency]
        const visited = new Set<string>()
        while (pending.length > 0) {
          const current = pending.pop()!
          if (current === task.task_id) {
            throw new InvalidAgentTeamOperationError('Task dependencies would create a cycle.')
          }
          if (visited.has(current)) continue
          visited.add(current)
          pending.push(...(graph.get(current) ?? []))
        }
      }
      const accepted = new Set(teamTasks
        .filter(candidate => candidate.status === 'accepted')
        .map(candidate => candidate.task_id))
      const hasUnmetDependencies = dependencies.some(dependency => !accepted.has(dependency))
      if (input.status === undefined) {
        if (hasUnmetDependencies
          && !(task.status === 'waiting' && task.waiting_kind === 'manual')) {
          nextStatus = 'waiting'
          nextWaitingKind = 'dependencies'
        } else if (!hasUnmetDependencies
          && nextStatus === 'waiting'
          && task.waiting_kind === 'dependencies') {
          nextStatus = 'queued'
          nextWaitingKind = null
        }
      }
    }

    if (nextStatus !== 'waiting') nextWaitingKind = null
    assertTaskTransition(task.status, nextStatus)
    const nextTitle = input.title === undefined
      ? task.title
      : cleanText(input.title, 'title', 300)
    const nextObjective = input.objective === undefined
      ? task.objective
      : cleanText(input.objective, 'objective', 20_000)
    const nextCriteria = input.acceptanceCriteria === undefined
      ? task.acceptance_criteria
      : uniqueStrings(input.acceptanceCriteria, 50)

    return this.withCommand({
      context,
      commandName: 'TaskUpdate',
      reservations: {},
      execute: async (commandKey, _ids, assertWriteFence) => {
        const finishAppliedCommand = async (
          applied: AgentTaskRecord,
        ): Promise<AgentTaskRecord> => {
          // Reassignment copies every durable private-path context grant to
          // the new owner. Replaying this after the Task CAS is safe because
          // the grant update uses $addToSet; it also closes the standalone
          // Mongo crash window between the Task mutation and ACL persistence.
          if (input.ownerAgentId !== undefined && reassignmentPrivatePaths.length > 0) {
            await assertWriteFence()
            await persistDelegatedPrivatePaths({
              teamId: actor.team.team_id,
              userId: actor.team.user_id,
              recipientAgentId: applied.assigned_agent_id,
              paths: reassignmentPrivatePaths,
            })
          }
          if (applied.status === 'cancelled') {
            const owner = await TeamAgentModel.findOne({
              team_id: actor.team.team_id,
              user_id: actor.team.user_id,
              agent_id: applied.assigned_agent_id,
            }).select('current_session_id').lean<Pick<TeamAgentRecord, 'current_session_id'>>()
            if (owner) {
              const activeRun = await getActiveAgentRunForSession(
                owner.current_session_id,
                actor.team.user_id,
              )
              if (activeRun?.task_id === applied.task_id) {
                await assertWriteFence()
                await requestAgentSessionRunCancellation(
                  owner.current_session_id,
                  actor.team.user_id,
                  activeRun.run_id,
                )
              }
            }
          }
          await assertWriteFence()
          await this.repository.appendEvent({
            teamId: actor.team.team_id,
            userId: actor.team.user_id,
            type: 'task_status_changed',
            actorAgentId: actor.agent.agent_id,
            subjectAgentId: applied.assigned_agent_id,
            taskId: applied.task_id,
            runId: context.run_id,
            payload: {
              previous_status: task.status,
              status: applied.status,
              previous_owner_agent_id: task.assigned_agent_id,
              owner_agent_id: applied.assigned_agent_id,
              metadata_changed: editsMetadata,
            },
            dedupeKey: `${commandKey}:task_updated`,
          })
          return applied
        }

        // Standalone Mongo has no multi-document transaction. If a process
        // died after the Task CAS but before the command receipt/event was
        // completed, command-lease takeover reconstructs the same response
        // from this durable marker instead of reporting a false fence loss.
        const previouslyApplied = await AgentTaskModel.findOne({
          team_id: actor.team.team_id,
          user_id: actor.team.user_id,
          task_id: task.task_id,
          last_command_key: commandKey,
        }).lean<AgentTaskRecord>()
        if (previouslyApplied) return finishAppliedCommand(previouslyApplied)

        await assertWriteFence()
        const now = new Date()
        const updated = await AgentTaskModel.findOneAndUpdate(
          {
            team_id: actor.team.team_id,
            user_id: actor.team.user_id,
            task_id: task.task_id,
            assigned_agent_id: task.assigned_agent_id,
            status: task.status,
            updated_at: task.updated_at,
            last_command_key: { $ne: commandKey },
          },
          {
            $set: {
              assigned_agent_id: nextOwnerId,
              title: nextTitle,
              objective: nextObjective,
              acceptance_criteria: nextCriteria,
              dependency_task_ids: dependencies,
              status: nextStatus,
              waiting_kind: nextWaitingKind,
              last_command_key: commandKey,
              ...(nextStatus === 'running'
                ? { started_at: task.started_at ?? now, submitted_at: null, completed_at: null }
                : {}),
              ...(['queued', 'waiting', 'rework'].includes(nextStatus)
                ? { submitted_at: null, completed_at: null }
                : {}),
              ...(nextStatus === 'cancelled' ? { completed_at: now } : {}),
              ...(nextStatus === 'accepted' ? { completed_at: now } : {}),
              ...(nextOwnerId !== task.assigned_agent_id
                ? { started_at: null, submitted_at: null, completed_at: null, active_result_id: null }
                : {}),
            },
          },
          { returnDocument: 'after' },
        ).lean<AgentTaskRecord>()
        if (!updated) {
          const appliedAfterRace = await AgentTaskModel.findOne({
            team_id: actor.team.team_id,
            user_id: actor.team.user_id,
            task_id: task.task_id,
            last_command_key: commandKey,
          }).lean<AgentTaskRecord>()
          if (appliedAfterRace) return finishAppliedCommand(appliedAfterRace)
          throw new InvalidAgentTeamOperationError(
            'TaskUpdate lost its state fence; inspect the Task and retry.',
          )
        }
        return finishAppliedCommand(updated)
      },
    })
  }

  private async triggerAgentWaits(input: {
    teamId: string
    userId: string
    agentIds: string[]
    reason: string
    eventSeq?: number
  }): Promise<string[]> {
    const ids = [...new Set(input.agentIds)]
    if (ids.length === 0) return []
    const now = new Date()
    const waits = await AgentWaitSubscriptionModel.find({
      team_id: input.teamId,
      user_id: input.userId,
      agent_id: { $in: ids },
      status: 'waiting',
    }).select('wait_id agent_id').lean<Array<{ wait_id: string; agent_id: string }>>()
    const woken = new Set<string>()
    for (const wait of waits) {
      const result = await AgentWaitSubscriptionModel.updateOne(
        { wait_id: wait.wait_id, status: 'waiting' },
        {
          $set: {
            status: 'triggered',
            trigger_reason: input.reason,
            triggered_event_seq: input.eventSeq ?? null,
            resolved_at: now,
          },
        },
      )
      if (result.matchedCount === 1) woken.add(wait.agent_id)
    }
    return [...woken]
  }

  async sendMessage(context: AgentCommandContext, input: SendAgentMessageInput): Promise<{
    message: AgentMailboxMessageRecord
    wake_agent_ids: string[]
  }> {
    const actor = await this.loadActor(context)
    this.requireCapability(actor, 'can_message_agents')
    if (input.recipientAgentId === actor.agent.agent_id) {
      throw new InvalidAgentTeamOperationError('SendAgentMessage requires a different recipient.')
    }
    const recipient = await TeamAgentModel.findOne({
      team_id: actor.team.team_id,
      user_id: actor.team.user_id,
      agent_id: input.recipientAgentId,
    }).lean<TeamAgentRecord>()
    if (!recipient) throw new TeamAgentNotFoundError(input.recipientAgentId)
    if (recipient.status === 'completed') {
      throw new InvalidAgentTeamOperationError('Cannot deliver a message to a completed Agent.')
    }
    if (input.taskId) {
      const taskExists = await AgentTaskModel.exists({
        team_id: actor.team.team_id,
        user_id: actor.team.user_id,
        task_id: input.taskId,
      })
      if (!taskExists) throw new AgentTaskNotFoundError(input.taskId)
    }
    const normalizedAttachments = normalizeWorkspaceReferences(input.attachments ?? []).slice(0, 100)
    const delegatedPrivatePaths = privatePathsFromReferences(normalizedAttachments)
    assertCanDelegatePrivatePaths({
      actorAgentId: actor.agent.agent_id,
      actorIsRoot: actor.agent.is_root,
      actorAllowedReadPaths: actor.grant.allowed_read_paths,
      paths: delegatedPrivatePaths,
    })
    return this.withCommand({
      context,
      commandName: 'SendAgentMessage',
      reservations: { message_id: nextId('agent_message') },
      execute: async (commandKey, ids, assertWriteFence) => {
        let message = await AgentMailboxMessageModel.findOne({
          team_id: actor.team.team_id,
          creation_command_key: commandKey,
        })
        if (!message) {
          await assertWriteFence()
          const deliveries: AgentMailboxMessageRecord['deliveries'] = [{
            agent_id: recipient.agent_id,
            kind: 'primary',
            status: 'pending',
          }]
          if (actor.agent.agent_id !== actor.team.root_agent_id
            && recipient.agent_id !== actor.team.root_agent_id
            && !input.suppressRootObserver) {
            deliveries.push({
              agent_id: actor.team.root_agent_id,
              kind: 'root_observer',
              status: 'pending',
            })
          }
          message = await AgentMailboxMessageModel.create({
            message_id: ids.message_id,
            team_id: actor.team.team_id,
            conversation_id: actor.team.conversation_id,
            user_id: actor.team.user_id,
            sender_agent_id: actor.agent.agent_id,
            recipient_agent_id: recipient.agent_id,
            sender_name: actor.agent.display_name,
            recipient_name: recipient.display_name,
            task_id: input.taskId ?? null,
            correlation_id: input.correlationId?.trim() || null,
            reply_to_message_id: input.replyToMessageId?.trim() || null,
            kind: input.kind,
            summary: input.summary?.trim()
              ? cleanText(input.summary, 'summary', 500)
              : null,
            content: cleanText(input.content, 'content', 50_000),
            attachments: normalizedAttachments,
            deliveries,
            creation_command_key: commandKey,
          })
        }
        await assertWriteFence()
        await persistDelegatedPrivatePaths({
          teamId: actor.team.team_id,
          userId: actor.team.user_id,
          recipientAgentId: recipient.agent_id,
          paths: delegatedPrivatePaths,
        })
        await assertWriteFence()
        const event = await this.repository.appendEvent({
          teamId: actor.team.team_id,
          userId: actor.team.user_id,
          type: 'message_sent',
          actorAgentId: actor.agent.agent_id,
          subjectAgentId: recipient.agent_id,
          taskId: input.taskId,
          runId: context.run_id,
          payload: {
            message_id: message.message_id,
            kind: message.kind,
            summary: message.summary ?? null,
            has_attachments: message.attachments.length > 0,
            root_observer_suppressed: input.suppressRootObserver === true,
          },
          dedupeKey: `${commandKey}:message_sent`,
        })
        // A direct Agent message has the same wake semantics as a user
        // message: every kind wakes an idle recipient. `kind` remains useful
        // for rendering, prioritization and Root observer batching, but is no
        // longer an execution gate.
        const wakeTargets: string[] = [recipient.agent_id]
        if (shouldWakeForMessage(message.kind, true)
          && actor.team.root_agent_id !== recipient.agent_id) {
          wakeTargets.push(actor.team.root_agent_id)
        }
        const woken = await this.triggerAgentWaits({
          teamId: actor.team.team_id,
          userId: actor.team.user_id,
          agentIds: wakeTargets,
          reason: `message:${message.kind}:${message.message_id}`,
          eventSeq: event.seq,
        })
        return { message: asRecord<AgentMailboxMessageRecord>(message), wake_agent_ids: woken }
      },
    })
  }

  /**
   * Freeze a Root broadcast audience before the first per-recipient message is
   * written. The completed command receipt is the durable audience snapshot:
   * replay after a mid-broadcast crash cannot accidentally include Agents that
   * joined later, while each derived SendMessage command remains independently
   * idempotent.
   */
  async planBroadcast(context: AgentCommandContext): Promise<string[]> {
    const actor = await this.loadActor(context)
    this.requireRoot(actor, 'can_message_agents')
    return this.withCommand({
      context,
      commandName: 'PlanAgentBroadcast',
      reservations: {},
      execute: async (_commandKey, _ids, assertWriteFence) => {
        await assertWriteFence()
        const recipients = await TeamAgentModel.find({
          team_id: actor.team.team_id,
          user_id: actor.team.user_id,
          agent_id: { $ne: actor.agent.agent_id },
          status: { $in: ['running', 'idle'] },
        }).sort({ slot: 1 }).select('agent_id').lean<Array<Pick<TeamAgentRecord, 'agent_id'>>>()
        return recipients.map(recipient => recipient.agent_id)
      },
    })
  }

  async inspectTeam(input: InspectAgentTeamInput): Promise<AgentTeamSnapshot> {
    const team = await this.resolveTeam(input)
    let caller: ActorState | undefined
    if (input.callerAgentId) {
      caller = await this.loadActor({
        team_id: team.team_id,
        user_id: input.userId,
        caller_agent_id: input.callerAgentId,
      })
      this.requireCapability(caller, 'can_inspect_team')
    }
    const [agents, tasks, results, proposals] = await Promise.all([
      TeamAgentModel.find({ team_id: team.team_id, user_id: input.userId })
        .sort({ slot: 1 }).lean<TeamAgentRecord[]>(),
      AgentTaskModel.find({ team_id: team.team_id, user_id: input.userId })
        .sort({ created_at: -1 }).limit(500).lean<AgentTaskRecord[]>(),
      AgentResultModel.find({
        team_id: team.team_id,
        user_id: input.userId,
        ...(caller && !caller.agent.is_root ? { agent_id: caller.agent.agent_id } : {}),
      }).sort({ created_at: -1 }).limit(200).lean<AgentResultRecord[]>(),
      WorkspaceProposalModel.find({
        team_id: team.team_id,
        user_id: input.userId,
        ...(caller && !caller.agent.is_root ? { agent_id: caller.agent.agent_id } : {}),
      }).sort({ created_at: -1 }).limit(500).lean<WorkspaceProposalRecord[]>(),
    ])
    let messages: AgentMailboxMessageRecord[] | undefined
    if (input.includeMessages && caller) {
      messages = await AgentMailboxMessageModel.find({
        team_id: team.team_id,
        user_id: input.userId,
        ...(!caller.agent.is_root ? {
          $or: [
            { sender_agent_id: caller.agent.agent_id },
            { recipient_agent_id: caller.agent.agent_id },
            { 'deliveries.agent_id': caller.agent.agent_id },
          ],
        } : {}),
      }).sort({ created_at: -1 }).limit(Math.max(1, Math.min(input.messageLimit ?? 200, 1_000)))
        .lean<AgentMailboxMessageRecord[]>()
      messages.reverse()
    }
    const counts = {
      total_agents: agents.length,
      running_agents: agents.filter(agent => agent.status === 'running').length,
      idle_agents: agents.filter(agent => agent.status === 'idle').length,
      completed_agents: agents.filter(agent => agent.status === 'completed').length,
      failed_agents: agents.filter(agent => agent.status === 'failed').length,
      active_tasks: tasks.filter(task => ['queued', 'running', 'waiting', 'rework'].includes(task.status)).length,
      pending_results: proposals.filter(proposal => proposal.status === 'pending').length,
    }
    return {
      team,
      agents,
      tasks,
      results,
      proposals,
      ...(messages ? { messages } : {}),
      counts,
      latest_event_seq: team.next_event_seq,
    }
  }

  async getTeamStatusSnapshot(input: Omit<InspectAgentTeamInput, 'callerAgentId' | 'includeMessages'>): Promise<AgentTeamSnapshot> {
    return this.inspectTeam({ ...input, includeMessages: false })
  }

  async createWaitSubscription(
    context: AgentCommandContext,
    input: CreateAgentWaitInput,
  ): Promise<{ subscription: AgentWaitSubscriptionRecord; wake?: AgentWakeEvaluation }> {
    const actor = await this.loadActor(context)
    this.requireCapability(actor, 'can_wait_for_agents')
    const taskIds = uniqueStrings(input.taskIds, 100)
    if (taskIds.length === 0) {
      throw new InvalidAgentTeamOperationError('WaitForAgents requires at least one task id.')
    }
    const tasks = await AgentTaskModel.find({
      team_id: actor.team.team_id,
      user_id: actor.team.user_id,
      task_id: { $in: taskIds },
    }).lean<AgentTaskRecord[]>()
    if (tasks.length !== taskIds.length) {
      throw new InvalidAgentTeamOperationError('One or more wait tasks are outside this team.')
    }
    const timeoutMs = Math.max(1_000, Math.min(input.timeoutMs, MAX_WAIT_TIMEOUT_MS))
    return this.withCommand({
      context,
      commandName: 'WaitForAgents',
      reservations: { wait_id: nextId('agent_wait') },
      execute: async (commandKey, ids, assertWriteFence) => {
        let wait = await AgentWaitSubscriptionModel.findOne({
          team_id: actor.team.team_id,
          creation_command_key: commandKey,
        })
        if (!wait) {
          await assertWriteFence()
          wait = await AgentWaitSubscriptionModel.create({
            wait_id: ids.wait_id,
            team_id: actor.team.team_id,
            conversation_id: actor.team.conversation_id,
            user_id: actor.team.user_id,
            agent_id: actor.agent.agent_id,
            run_id: context.run_id,
            task_ids: taskIds,
            mode: input.mode,
            status: 'waiting',
            after_event_seq: actor.team.next_event_seq,
            deadline_at: new Date(Date.now() + timeoutMs),
            trigger_reason: null,
            triggered_event_seq: null,
            creation_command_key: commandKey,
            resolved_at: null,
            wake_delivered_at: null,
          })
        }
        await assertWriteFence()
        const started = await this.repository.appendEvent({
          teamId: actor.team.team_id,
          userId: actor.team.user_id,
          type: 'wait_started',
          actorAgentId: actor.agent.agent_id,
          runId: context.run_id,
          payload: { wait_id: wait.wait_id, task_ids: taskIds, mode: input.mode, deadline_at: wait.deadline_at },
          dedupeKey: `${commandKey}:wait_started`,
        })
        const currentTasks = await AgentTaskModel.find({ task_id: { $in: taskIds }, team_id: actor.team.team_id })
          .select('status').lean<Array<Pick<AgentTaskRecord, 'status'>>>()
        let wake: AgentWakeEvaluation | undefined
        if (taskWaitSatisfied(currentTasks.map(task => task.status), input.mode)) {
          await assertWriteFence()
          const resolved = await AgentWaitSubscriptionModel.findOneAndUpdate(
            { wait_id: wait.wait_id, status: 'waiting' },
            {
              $set: {
                status: 'triggered',
                trigger_reason: 'tasks_ready',
                triggered_event_seq: started.seq,
                resolved_at: new Date(),
              },
            },
            { returnDocument: 'after' },
          )
          if (resolved) {
            wait = resolved
            wake = {
              wait_id: wait.wait_id,
              agent_id: wait.agent_id,
              run_id: wait.run_id,
              status: 'triggered',
              reason: 'tasks_ready',
              event_seq: started.seq,
            }
          }
        }
        return { subscription: asRecord<AgentWaitSubscriptionRecord>(wait), ...(wake ? { wake } : {}) }
      },
    })
  }

  async evaluateWake(input: {
    conversationId?: string
    teamId?: string
    userId: string
    now?: Date
  }): Promise<AgentWakeEvaluation[]> {
    const team = await this.resolveTeam(input)
    const now = input.now ?? new Date()
    const waits = await AgentWaitSubscriptionModel.find({
      team_id: team.team_id,
      user_id: input.userId,
      status: 'waiting',
    }).sort({ created_at: 1 }).lean<AgentWaitSubscriptionRecord[]>()
    const outcomes: AgentWakeEvaluation[] = []
    for (const wait of waits) {
      let status: AgentWakeEvaluation['status'] | undefined
      let reason: string | undefined
      if (wait.deadline_at <= now) {
        status = 'timed_out'
        reason = 'timeout'
      } else {
        const tasks = await AgentTaskModel.find({
          team_id: team.team_id,
          user_id: input.userId,
          task_id: { $in: wait.task_ids },
        }).select('status').lean<Array<Pick<AgentTaskRecord, 'status'>>>()
        if (tasks.length === wait.task_ids.length
          && taskWaitSatisfied(tasks.map(task => task.status), wait.mode)) {
          status = 'triggered'
          reason = 'tasks_ready'
        }
      }
      if (!status || !reason) continue
      const updated = await AgentWaitSubscriptionModel.updateOne(
        { wait_id: wait.wait_id, status: 'waiting' },
        { $set: { status, trigger_reason: reason, resolved_at: now } },
      )
      if (updated.matchedCount !== 1) continue
      outcomes.push({
        wait_id: wait.wait_id,
        agent_id: wait.agent_id,
        run_id: wait.run_id,
        status,
        reason,
      })
      await this.repository.appendEvent({
        teamId: team.team_id,
        userId: input.userId,
        type: 'wait_resolved',
        subjectAgentId: wait.agent_id,
        runId: wait.run_id,
        payload: { wait_id: wait.wait_id, status, reason },
        dedupeKey: `wait_resolved:${wait.wait_id}:${status}`,
      })
    }
    return outcomes
  }

  async submitResult(
    context: AgentCommandContext,
    input: SubmitAgentResultInput,
  ): Promise<{
    result: AgentResultRecord
    proposals: WorkspaceProposalRecord[]
    wake_agent_ids: string[]
  }> {
    const actor = await this.loadActor(context)
    this.requireCapability(actor, 'can_submit_results')
    let task: AgentTaskRecord | null = null
    if (input.taskId) {
      task = await AgentTaskModel.findOne({
        team_id: actor.team.team_id,
        user_id: actor.team.user_id,
        task_id: input.taskId,
      }).lean<AgentTaskRecord>()
      if (!task) throw new AgentTaskNotFoundError(input.taskId)
      if (!actor.agent.is_root && task.assigned_agent_id !== actor.agent.agent_id) {
        throw new AgentPermissionError('submit_assigned_task_result')
      }
      if (['accepted', 'failed', 'cancelled'].includes(task.status)) {
        if (input.allowTerminalTaskFallback) task = null
        else {
          throw new InvalidAgentTeamOperationError(`Task ${task.task_id} is already terminal.`)
        }
      }
    }
    // A member may explicitly put its Task into a durable manual wait and
    // then naturally finish the turn. That turn still needs an immutable
    // result, but it is a blocked checkpoint rather than a submission for
    // Root acceptance and must not erase the waiting state.
    const preserveWaitingTask = Boolean(input.implicit && task?.status === 'waiting')
    const resultOutcome: AgentResultOutcome = preserveWaitingTask
      ? 'blocked'
      : (input.outcome ?? 'completed')
    const files = (input.files ?? []).slice(0, 500)
    if (!actor.agent.is_root) {
      const invalid = files.find(file => !isAgentPrivatePath(actor.agent.agent_id, file.source_path))
      if (invalid) {
        throw new AgentPermissionError(`private_workspace_source:${invalid.source_path}`)
      }
    }
    const reservations: Record<string, string> = { result_id: nextId('agent_result') }
    files.forEach((_, index) => {
      reservations[`proposal_${index}`] = nextId('workspace_proposal')
    })
    return this.withCommand({
      context,
      commandName: 'SubmitAgentResult',
      reservations,
      execute: async (commandKey, ids, assertWriteFence) => {
        let result = await AgentResultModel.findOne({
          team_id: actor.team.team_id,
          creation_command_key: commandKey,
        })
        const proposalIds = files.map((_, index) => ids[`proposal_${index}`])
        if (!result) {
          await assertWriteFence()
          result = await AgentResultModel.create({
            result_id: ids.result_id,
            team_id: actor.team.team_id,
            conversation_id: actor.team.conversation_id,
            user_id: actor.team.user_id,
            task_id: task?.task_id ?? null,
            agent_id: actor.agent.agent_id,
            run_id: context.run_id,
            outcome: resultOutcome,
            final_response: cleanText(input.finalResponse, 'finalResponse', 100_000),
            summary: input.summary ?? {},
            evidence_refs: (input.evidenceRefs ?? []).slice(0, 500),
            files,
            proposal_ids: proposalIds,
            implicit: input.implicit ?? false,
            creation_command_key: commandKey,
          })
        }
        const durableTaskId = result.task_id ?? task?.task_id ?? null
        for (let index = 0; index < files.length; index += 1) {
          if (index % 16 === 0) await assertWriteFence()
          const file = files[index]
          const target = cleanText(
            file.suggested_target_path ?? `output/${file.source_path.split('/').at(-1) ?? `agent-result-${index + 1}`}`,
            'suggested_target_path',
            1_000,
          )
          await WorkspaceProposalModel.updateOne(
            { proposal_id: proposalIds[index] },
            {
              $setOnInsert: {
                proposal_id: proposalIds[index],
                team_id: actor.team.team_id,
                conversation_id: actor.team.conversation_id,
                user_id: actor.team.user_id,
                result_id: result.result_id,
                task_id: durableTaskId,
                agent_id: actor.agent.agent_id,
                source_path: file.source_path,
                target_path: target,
                expected_target_revision: null,
                source_sha256: file.sha256 ?? null,
                status: 'pending',
              },
            },
            { upsert: true },
          )
        }
        if (task) {
          await assertWriteFence()
          if (preserveWaitingTask) {
            await AgentTaskModel.updateOne(
              {
                team_id: actor.team.team_id,
                task_id: task.task_id,
              },
              { $addToSet: { result_ids: result.result_id } },
            )
          } else {
            const submittedTaskStatus = resultOutcome === 'failed' ? 'failed' : 'submitted'
            await AgentTaskModel.updateOne(
              {
                team_id: actor.team.team_id,
                task_id: task.task_id,
                status: { $nin: ['accepted', 'failed', 'cancelled'] },
                last_command_key: { $ne: commandKey },
              },
              {
                $set: {
                  status: submittedTaskStatus,
                  waiting_kind: null,
                  active_result_id: result.result_id,
                  submitted_at: new Date(),
                  last_command_key: commandKey,
                },
                $addToSet: { result_ids: result.result_id },
              },
            )
          }
        }
        await assertWriteFence()
        const event = await this.repository.appendEvent({
          teamId: actor.team.team_id,
          userId: actor.team.user_id,
          type: 'result_submitted',
          actorAgentId: actor.agent.agent_id,
          subjectAgentId: actor.team.root_agent_id,
          taskId: durableTaskId ?? undefined,
          runId: context.run_id,
          payload: {
            result_id: result.result_id,
            outcome: result.outcome,
            implicit: result.implicit,
            proposal_count: proposalIds.length,
          },
          dedupeKey: `${commandKey}:result_submitted`,
        })
        await assertWriteFence()
        const evaluations = await this.evaluateWake({ teamId: actor.team.team_id, userId: actor.team.user_id })
        await assertWriteFence()
        const rootWoken = await this.triggerAgentWaits({
          teamId: actor.team.team_id,
          userId: actor.team.user_id,
          agentIds: [actor.team.root_agent_id],
          reason: `result:${result.result_id}`,
          eventSeq: event.seq,
        })
        const proposals = await WorkspaceProposalModel.find({
          result_id: result.result_id,
          team_id: actor.team.team_id,
        }).sort({ created_at: 1 }).lean<WorkspaceProposalRecord[]>()
        return {
          result: asRecord<AgentResultRecord>(result),
          proposals,
          wake_agent_ids: [...new Set([
            ...rootWoken,
            ...evaluations.map(item => item.agent_id),
          ])],
        }
      },
    })
  }

  async reviewResult(
    context: AgentCommandContext,
    input: ReviewAgentResultInput,
  ): Promise<{
    result: AgentResultRecord
    proposals: WorkspaceProposalRecord[]
    accepted_intents: AcceptedWorkspaceIntent[]
    task?: AgentTaskRecord
    feedback_delivery?: {
      message: AgentMailboxMessageRecord
      wake_agent_ids: string[]
    }
  }> {
    const actor = await this.loadActor(context)
    this.requireRoot(actor, 'can_review_results')
    if (input.taskDecision !== undefined
      && !['accepted', 'rework'].includes(input.taskDecision)) {
      throw new InvalidAgentTeamOperationError('taskDecision must be accepted or rework.')
    }
    const allowedActions = new Set(['accept', 'reject', 'retarget', 'request_changes'])
    if (input.items.some(item => !allowedActions.has(item.action))) {
      throw new InvalidAgentTeamOperationError('A file review action is invalid.')
    }
    if (input.items.some(item => item.action === 'request_changes') && input.taskDecision !== 'rework') {
      throw new InvalidAgentTeamOperationError(
        'request_changes requires taskDecision=rework so the author can submit a replacement.',
      )
    }
    const result = await AgentResultModel.findOne({
      team_id: actor.team.team_id,
      user_id: actor.team.user_id,
      result_id: input.resultId,
    }).lean<AgentResultRecord>()
    if (!result) throw new AgentResultNotFoundError(input.resultId)
    const proposalIds = uniqueStrings(input.items.map(item => item.proposalId), 500)
    const proposals = await WorkspaceProposalModel.find({
      team_id: actor.team.team_id,
      user_id: actor.team.user_id,
      result_id: result.result_id,
      proposal_id: { $in: proposalIds },
    }).lean<WorkspaceProposalRecord[]>()
    if (proposals.length !== proposalIds.length) {
      throw new InvalidAgentTeamOperationError('One or more proposals do not belong to this result.')
    }
    // `approved` is the durable publication outbox state. A process can die
    // after this review command commits but before the path-level publication
    // (or its outcome marker) completes. Recovery deliberately does not replay
    // arbitrary side-effecting tool calls, so a later Root Run must be able to
    // take over the *same* authorization with a new tool_use_id.
    //
    // Keep that takeover deliberately narrow: changing/rejecting an approved
    // target could race a publication that already committed but whose outcome
    // marker was not stored yet, producing an inconsistent audit trail or two
    // public targets. Reconciliation may only repeat the identical accept.
    for (const item of input.items) {
      const proposal = proposals.find(candidate => candidate.proposal_id === item.proposalId)
      if (!proposal || proposal.status !== 'approved') continue
      if (item.action !== 'accept') {
        throw new InvalidAgentTeamOperationError(
          'An approved Workspace proposal may only be retried with accept; publication must be reconciled before it can be changed or rejected.',
          { proposal_id: proposal.proposal_id },
        )
      }
      if (item.targetPath !== undefined
        && cleanText(item.targetPath, 'targetPath', 1_000) !== proposal.target_path) {
        throw new InvalidAgentTeamOperationError(
          'An approved Workspace proposal retry must keep the same target path.',
          { proposal_id: proposal.proposal_id, target_path: proposal.target_path },
        )
      }
      if (item.expectedTargetRevision !== undefined
        && item.expectedTargetRevision !== (proposal.expected_target_revision ?? null)) {
        throw new InvalidAgentTeamOperationError(
          'An approved Workspace proposal retry must keep the same expected target revision.',
          {
            proposal_id: proposal.proposal_id,
            expected_target_revision: proposal.expected_target_revision ?? null,
          },
        )
      }
    }
    return this.withCommand({
      context,
      commandName: 'ReviewAgentResult',
      reservations: {},
      execute: async (commandKey, _ids, assertWriteFence) => {
        const reviewedAt = new Date()
        let decisionTaskAlreadyApplied = false
        if (input.taskDecision !== undefined && result.task_id) {
          const currentTask = await AgentTaskModel.findOne({
            team_id: actor.team.team_id,
            user_id: actor.team.user_id,
            task_id: result.task_id,
          }).lean<AgentTaskRecord>()
          if (!currentTask) throw new AgentTaskNotFoundError(result.task_id)
          decisionTaskAlreadyApplied = currentTask.last_command_key === commandKey
            && currentTask.active_result_id === result.result_id
          if (!decisionTaskAlreadyApplied
            && (currentTask.status !== 'submitted'
              || currentTask.active_result_id !== result.result_id)) {
            throw new InvalidAgentTeamOperationError(
              'Task review is stale: only the currently submitted active result may change Task status. Review old Workspace proposals without taskDecision.',
              {
                task_id: currentTask.task_id,
                active_result_id: currentTask.active_result_id ?? null,
                reviewed_result_id: result.result_id,
                task_status: currentTask.status,
              },
            )
          }
        }
        for (const [index, item] of input.items.entries()) {
          if (index % 16 === 0) await assertWriteFence()
          const proposal = proposals.find(candidate => candidate.proposal_id === item.proposalId)
          if (!proposal) continue
          const targetPath = item.action === 'retarget'
            ? cleanText(item.targetPath ?? '', 'targetPath', 1_000)
            : proposal.target_path
          const status = item.action === 'reject' || item.action === 'request_changes'
            ? 'rejected'
            : 'approved'
          const approvedTakeoverFence = proposal.status === 'approved'
            ? {
                status: 'approved' as const,
                review_command_key: proposal.review_command_key ?? null,
                target_path: proposal.target_path,
                expected_target_revision: proposal.expected_target_revision ?? null,
              }
            : undefined
          await WorkspaceProposalModel.updateOne(
            {
              team_id: actor.team.team_id,
              proposal_id: proposal.proposal_id,
              $or: [
                { status: 'pending' },
                { status: 'conflict' },
                { review_command_key: commandKey },
                ...(approvedTakeoverFence ? [approvedTakeoverFence] : []),
              ],
            },
            {
              $set: {
                status,
                target_path: targetPath,
                expected_target_revision: item.expectedTargetRevision === undefined
                  ? proposal.expected_target_revision ?? null
                  : item.expectedTargetRevision,
                review_note: item.note?.trim() || null,
                reviewed_by_agent_id: actor.agent.agent_id,
                reviewed_at: reviewedAt,
                review_command_key: commandKey,
              },
            },
          )
        }
        const freshProposals = await WorkspaceProposalModel.find({
          result_id: result.result_id,
          team_id: actor.team.team_id,
        }).sort({ created_at: 1 }).lean<WorkspaceProposalRecord[]>()
        // Workspace review and Task review are deliberately independent. The
        // legacy ReviewAgentResult alias can still request acceptance in the
        // same command; while approved files await publication, its command
        // key is retained on the submitted Task as an explicit compatibility
        // marker. A workspace-only review omits taskDecision and never writes
        // that marker.
        const publicationPending = freshProposals.some(proposal => (
          proposal.status === 'pending'
          || proposal.status === 'approved'
          || proposal.status === 'conflict'
        ))
        const durableTaskDecision = input.taskDecision === 'accepted' && publicationPending
          ? 'submitted'
          : input.taskDecision
        if (durableTaskDecision && result.task_id) {
          await assertWriteFence()
          if (!decisionTaskAlreadyApplied) {
            const updatedTask = await AgentTaskModel.findOneAndUpdate(
              {
                team_id: actor.team.team_id,
                user_id: actor.team.user_id,
                task_id: result.task_id,
                status: 'submitted',
                active_result_id: result.result_id,
                last_command_key: { $ne: commandKey },
              },
              {
                $set: {
                  status: durableTaskDecision,
                  waiting_kind: null,
                  last_command_key: commandKey,
                  ...(durableTaskDecision === 'accepted'
                    ? { completed_at: reviewedAt }
                    : { completed_at: null }),
                },
              },
              { returnDocument: 'after' },
            ).lean<AgentTaskRecord>()
            if (!updatedTask) {
              const appliedAfterRace = await AgentTaskModel.findOne({
                team_id: actor.team.team_id,
                user_id: actor.team.user_id,
                task_id: result.task_id,
                active_result_id: result.result_id,
                last_command_key: commandKey,
              }).lean<AgentTaskRecord>()
              if (!appliedAfterRace) {
                throw new InvalidAgentTeamOperationError(
                  'Task review became stale before its status update; the active result was not changed.',
                  {
                    task_id: result.task_id,
                    reviewed_result_id: result.result_id,
                  },
                )
              }
            }
          }
        }
        await assertWriteFence()
        await this.repository.appendEvent({
          teamId: actor.team.team_id,
          userId: actor.team.user_id,
          type: 'result_reviewed',
          actorAgentId: actor.agent.agent_id,
          subjectAgentId: result.agent_id,
          taskId: result.task_id ?? undefined,
          runId: context.run_id,
          payload: {
            result_id: result.result_id,
            task_decision: input.taskDecision ?? null,
            durable_task_status: durableTaskDecision ?? null,
            approved_count: input.items.filter(item => (
              item.action === 'accept' || item.action === 'retarget'
            )).length,
            rejected_count: input.items.filter(item => (
              item.action === 'reject' || item.action === 'request_changes'
            )).length,
            note: input.taskNote?.trim() || null,
          },
          dedupeKey: `${commandKey}:result_reviewed`,
        })
        let feedbackDelivery: {
          message: AgentMailboxMessageRecord
          wake_agent_ids: string[]
        } | undefined
        const changeRequests = input.items.flatMap(item => {
          if (item.action !== 'request_changes') return []
          const proposal = proposals.find(candidate => candidate.proposal_id === item.proposalId)
          if (!proposal) return []
          return [{ item, proposal }]
        })
        if (changeRequests.length > 0 && result.agent_id !== actor.agent.agent_id) {
          // Standalone Mongo has no transaction spanning the Workspace review,
          // Task state and mailbox. Persist the author feedback as a nested,
          // independently idempotent command before completing this review
          // receipt. If the process dies later (including before the adapter
          // wakes the author), either command retry or the mailbox repair sweep
          // can recover the durable pending delivery without duplicating it.
          const feedbackLines = [
            `Root requested changes to Workspace result ${result.result_id}.`,
            ...(result.task_id ? [`Task: ${result.task_id}`] : []),
            ...(input.taskNote?.trim() ? [`Overall feedback: ${input.taskNote.trim()}`] : []),
            '',
            ...changeRequests.map(({ item, proposal }, index) => (
              `${index + 1}. ${proposal.source_path} -> ${proposal.target_path}\n`
              + `   Reason: ${item.note?.trim() || 'Root requested a revised file.'}`
            )),
            '',
            'Revise the private source file(s), then finish the turn so the replacement Workspace changes can be reviewed.',
          ]
          feedbackDelivery = await this.sendMessage(
            {
              ...context,
              tool_use_id: `${context.tool_use_id}:review-feedback:${result.result_id}`,
            },
            {
              recipientAgentId: result.agent_id,
              kind: 'review',
              summary: `Changes requested for result ${result.result_id}`,
              content: feedbackLines.join('\n'),
              taskId: result.task_id ?? undefined,
              correlationId: result.result_id,
              attachments: [
                {
                  kind: 'result',
                  value: result.result_id,
                  label: 'Reviewed turn result',
                },
                ...changeRequests.map(({ proposal }) => ({
                  kind: 'workspace_path' as const,
                  value: proposal.source_path,
                  label: `Revision source for ${proposal.target_path}`,
                })),
              ],
              suppressRootObserver: true,
            },
          )
          await assertWriteFence()
        }
        const freshTask = result.task_id
          ? await AgentTaskModel.findOne({
              task_id: result.task_id,
              team_id: actor.team.team_id,
            }).lean<AgentTaskRecord>()
          : null
        if (result.task_id && !freshTask) throw new AgentTaskNotFoundError(result.task_id)
        const acceptedIntents: AcceptedWorkspaceIntent[] = freshProposals
          .filter(proposal => proposal.review_command_key === commandKey && proposal.status === 'approved')
          .map(proposal => ({
            proposal_id: proposal.proposal_id,
            result_id: proposal.result_id,
            task_id: proposal.task_id,
            author_agent_id: proposal.agent_id,
            source_path: proposal.source_path,
            target_path: proposal.target_path,
            expected_target_revision: proposal.expected_target_revision,
            source_sha256: proposal.source_sha256,
          }))
        return {
          result,
          proposals: freshProposals,
          accepted_intents: acceptedIntents,
          ...(freshTask ? { task: freshTask } : {}),
          ...(feedbackDelivery ? { feedback_delivery: feedbackDelivery } : {}),
        }
      },
    })
  }

  async manageAgent(
    context: AgentCommandContext,
    input: { agentId: string; action: AgentManagementAction; reason?: string },
  ): Promise<ManageAgentResult> {
    const actor = await this.loadActor(context)
    this.requireRoot(actor, 'can_manage_agents')
    const target = await TeamAgentModel.findOne({
      team_id: actor.team.team_id,
      user_id: actor.team.user_id,
      agent_id: input.agentId,
    }).lean<TeamAgentRecord>()
    if (!target) throw new TeamAgentNotFoundError(input.agentId)
    if (target.is_root) {
      throw new InvalidAgentTeamOperationError(
        'The permanent Root coordinator cannot manage itself; manage member Agents instead.',
      )
    }
    return this.withCommand({
      context,
      commandName: 'ManageAgent',
      reservations: input.action === 'reopen' ? { session_id: nextId('agent_session') } : {},
      execute: async (commandKey, ids, assertWriteFence) => {
        const now = new Date()
        let session: AgentSessionRuntimeRecord | undefined
        if (input.action === 'interrupt') {
          if (!['running', 'idle', 'paused'].includes(target.status)) {
            throw new InvalidAgentTeamOperationError('Only an active Agent can be interrupted.')
          }
          await assertWriteFence()
          await TeamAgentModel.updateOne(
            { agent_id: target.agent_id, team_id: actor.team.team_id, last_command_key: { $ne: commandKey } },
            {
              $set: {
                status: 'paused',
                interrupt_requested_at: now,
                last_transition_at: now,
                last_command_key: commandKey,
              },
            },
          )
          await assertWriteFence()
          await this.repository.revokeAgentExecutionLeases({
            teamId: actor.team.team_id,
            userId: actor.team.user_id,
            agentId: target.agent_id,
            sessionId: target.current_session_id,
          })
          await requestAgentSessionRunCancellation(
            target.current_session_id,
            actor.team.user_id,
          )
          const interruptedTasks = await AgentTaskModel.find({
            team_id: actor.team.team_id,
            user_id: actor.team.user_id,
            assigned_agent_id: target.agent_id,
            $or: [
              { status: 'running' },
              { status: 'rework', last_command_key: commandKey },
            ],
          }).select('task_id').lean<Array<Pick<AgentTaskRecord, 'task_id'>>>()
          for (const [index, task] of interruptedTasks.entries()) {
            if (index % 16 === 0) await assertWriteFence()
            await AgentTaskModel.updateOne(
              {
                team_id: actor.team.team_id,
                user_id: actor.team.user_id,
                task_id: task.task_id,
                status: 'running',
                last_command_key: { $ne: commandKey },
              },
              {
                $set: {
                  status: 'rework',
                  waiting_kind: null,
                  completed_at: null,
                  last_command_key: commandKey,
                },
              },
            )
            await this.repository.appendEvent({
              teamId: actor.team.team_id,
              userId: actor.team.user_id,
              type: 'task_status_changed',
              actorAgentId: actor.agent.agent_id,
              subjectAgentId: target.agent_id,
              taskId: task.task_id,
              runId: context.run_id,
              payload: { status: 'rework', reason: 'agent_interrupted' },
              dedupeKey: `${commandKey}:task_interrupted:${task.task_id}`,
            })
          }
        } else if (input.action === 'close') {
          await assertWriteFence()
          await TeamAgentModel.updateOne(
            { agent_id: target.agent_id, team_id: actor.team.team_id, last_command_key: { $ne: commandKey } },
            {
              $set: {
                status: 'completed',
                completed_at: now,
                last_transition_at: now,
                last_command_key: commandKey,
              },
            },
          )
          await assertWriteFence()
          await this.repository.revokeAgentExecutionLeases({
            teamId: actor.team.team_id,
            userId: actor.team.user_id,
            agentId: target.agent_id,
            sessionId: target.current_session_id,
          })
          await requestAgentSessionRunCancellation(
            target.current_session_id,
            actor.team.user_id,
          )
          await assertWriteFence()
          await Promise.all([
            AgentTaskModel.updateMany(
              {
                team_id: actor.team.team_id,
                user_id: actor.team.user_id,
                assigned_agent_id: target.agent_id,
                status: { $in: ['queued', 'running', 'waiting', 'rework'] },
              },
              {
                $set: {
                  status: 'cancelled',
                  waiting_kind: null,
                  completed_at: now,
                  last_command_key: commandKey,
                },
              },
            ),
            AgentWaitSubscriptionModel.updateMany(
              {
                team_id: actor.team.team_id,
                user_id: actor.team.user_id,
                agent_id: target.agent_id,
                status: 'waiting',
              },
              {
                $set: {
                  status: 'cancelled',
                  trigger_reason: 'agent_closed',
                  resolved_at: now,
                },
              },
            ),
          ])
        } else {
          let reopened = await TeamAgentModel.findOne({
            agent_id: target.agent_id,
            team_id: actor.team.team_id,
            last_command_key: commandKey,
          })
          if (!reopened) {
            const currentTarget = await TeamAgentModel.findOne({
              agent_id: target.agent_id,
              team_id: actor.team.team_id,
              user_id: actor.team.user_id,
            }).lean<TeamAgentRecord>()
            if (!currentTarget || !['completed', 'failed', 'paused'].includes(currentTarget.status)) {
              throw new InvalidAgentTeamOperationError('Only a paused, completed, or failed Agent can be reopened.')
            }
            const oldSession = await AgentSessionRuntimeModel.findOne({
              session_id: currentTarget.current_session_id,
              active_run_id: { $type: 'string' },
              'run_lease.expires_at': { $gt: now },
            }).select('active_run_id').lean<{ active_run_id?: string | null }>()
            if (oldSession?.active_run_id) {
              throw new InvalidAgentTeamOperationError(
                'Agent still owns an active Run lease; interrupt it and wait for release before reopening.',
                { run_id: oldSession.active_run_id },
              )
            }
            await assertWriteFence()
            reopened = await TeamAgentModel.findOneAndUpdate(
              {
                agent_id: target.agent_id,
                team_id: actor.team.team_id,
                status: { $in: ['completed', 'failed', 'paused'] },
                last_command_key: { $ne: commandKey },
              },
              {
                $set: {
                  status: 'idle',
                  current_session_id: ids.session_id,
                  completed_at: null,
                  interrupt_requested_at: null,
                  last_transition_at: now,
                  last_command_key: commandKey,
                },
                $inc: { generation: 1 },
              },
              { returnDocument: 'after' },
            )
          }
          if (!reopened) throw new InvalidAgentTeamOperationError('Agent reopen lost its state fence.')
          await assertWriteFence()
          await AgentSessionRuntimeModel.updateOne(
            { session_id: reopened.current_session_id },
            {
              $setOnInsert: {
                session_id: reopened.current_session_id,
                team_id: actor.team.team_id,
                conversation_id: actor.team.conversation_id,
                user_id: actor.team.user_id,
                agent_id: reopened.agent_id,
                generation: reopened.generation,
                active_run_id: null,
                active_lease_owner_id: null,
                run_lease: null,
                revision: 0,
                messages: [],
                compacted_messages: [],
                hippocampus: {},
                model_snapshot: null,
              },
            },
            { upsert: true },
          )
          session = await AgentSessionRuntimeModel.findOne({
            session_id: reopened.current_session_id,
          }).lean<AgentSessionRuntimeRecord>() ?? undefined
        }
        const eventType = input.action === 'reopen' ? 'agent_reopened' : 'agent_status_changed'
        await assertWriteFence()
        await this.repository.appendEvent({
          teamId: actor.team.team_id,
          userId: actor.team.user_id,
          type: eventType,
          actorAgentId: actor.agent.agent_id,
          subjectAgentId: target.agent_id,
          runId: context.run_id,
          payload: { action: input.action, reason: input.reason?.trim() || null },
          dedupeKey: `${commandKey}:agent_management`,
        })
        const [freshAgent, freshTeam] = await Promise.all([
          TeamAgentModel.findOne({ agent_id: target.agent_id, team_id: actor.team.team_id }).lean<TeamAgentRecord>(),
          AgentTeamModel.findOne({ team_id: actor.team.team_id, user_id: actor.team.user_id }).lean<AgentTeamRecord>(),
        ])
        if (!freshAgent || !freshTeam) throw new AgentTeamNotFoundError()
        return { agent: freshAgent, ...(session ? { session } : {}), team_status: freshTeam.status }
      },
    })
  }

  async listEventsAfter(input: {
    conversationId?: string
    teamId?: string
    userId: string
    afterSeq?: number
    limit?: number
  }): Promise<TeamEventRecord[]> {
    const team = await this.resolveTeam(input)
    return this.repository.listEventsAfter({
      teamId: team.team_id,
      userId: input.userId,
      afterSeq: input.afterSeq,
      limit: input.limit,
    })
  }

  async updateProgressSnapshot(input: {
    teamId: string
    userId: string
    agentId: string
    sessionId: string
    runId: string
    leaseOwnerId: string
    fenceToken: string
    checkpointSeq?: number
    currentAction?: string
    taskId?: string
    summary?: string
  }): Promise<boolean> {
    await this.repository.connect()
    const session = await AgentSessionRuntimeModel.findOne({
      session_id: input.sessionId,
      team_id: input.teamId,
      user_id: input.userId,
      agent_id: input.agentId,
      active_run_id: input.runId,
      active_lease_owner_id: input.leaseOwnerId,
      'run_lease.fence_token': input.fenceToken,
      'run_lease.expires_at': { $gt: new Date() },
    }).select('session_id').lean()
    if (!session) return false
    const now = new Date()
    const result = await TeamAgentModel.updateOne(
      {
        team_id: input.teamId,
        user_id: input.userId,
        agent_id: input.agentId,
        current_session_id: input.sessionId,
      },
      {
        $set: {
          last_progress_at: now,
          progress_snapshot: {
            run_id: input.runId,
            task_id: input.taskId,
            checkpoint_seq: input.checkpointSeq,
            current_action: input.currentAction,
            summary: input.summary,
            updated_at: now,
          },
        },
      },
    )
    return result.matchedCount === 1
  }

  async recordWorkspaceProposalOutcome(input: {
    teamId: string
    userId: string
    proposalId: string
    status: 'published' | 'conflict'
    publishedRevision?: number
  }): Promise<WorkspaceProposalRecord | null> {
    await this.repository.connect()
    const proposal = await WorkspaceProposalModel.findOneAndUpdate(
      {
        team_id: input.teamId,
        user_id: input.userId,
        proposal_id: input.proposalId,
        status: 'approved',
      },
      {
        $set: {
          status: input.status,
          published_revision: input.publishedRevision ?? null,
        },
      },
      { returnDocument: 'after' },
    ).lean<WorkspaceProposalRecord>()
    if (!proposal) return null

    const proposals = await WorkspaceProposalModel.find({
      team_id: proposal.team_id,
      user_id: proposal.user_id,
      result_id: proposal.result_id,
    }).select('status').lean<Array<Pick<WorkspaceProposalRecord, 'status'>>>()
    const allPublishedOrRejected = proposals.every(candidate => (
      candidate.status === 'published' || candidate.status === 'rejected'
    ))
    if (allPublishedOrRejected && proposal.task_id && proposal.review_command_key) {
      await AgentTaskModel.updateOne(
        {
          team_id: proposal.team_id,
          user_id: proposal.user_id,
          task_id: proposal.task_id,
          status: 'submitted',
          // Only the legacy combined review command writes this exact marker.
          // Workspace-only reviews must never implicitly accept a Task.
          last_command_key: proposal.review_command_key,
        },
        { $set: { status: 'accepted', waiting_kind: null, completed_at: new Date() } },
      )
    }
    await this.repository.appendEvent({
      teamId: proposal.team_id,
      userId: proposal.user_id,
      type: 'workspace_proposal_outcome',
      subjectAgentId: proposal.agent_id,
      taskId: proposal.task_id ?? undefined,
      payload: {
        proposal_id: proposal.proposal_id,
        result_id: proposal.result_id,
        status: proposal.status,
        published_revision: proposal.published_revision ?? null,
      },
      dedupeKey: `workspace_proposal_outcome:${proposal.proposal_id}:${proposal.status}:${proposal.published_revision ?? 'none'}`,
    })
    return proposal
  }
}

export const agentTeamService = new AgentTeamService()
