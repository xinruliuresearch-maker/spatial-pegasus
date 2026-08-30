import { createHash, randomUUID } from 'node:crypto'
import type { AgentProvider } from '../agent/loop'
import { estimateCostCents } from '../agent/pricing'
import { validateAgentRunLeaseFence } from '../agent-runtime/repository'
import { connectDB } from '../db/mongodb'
import { DurableCompactionJobModel } from '../agent-compaction/models'
import type { TokenUsage } from '../types'
import {
  AgentBudgetAdmissionModel,
  AgentExecutionBudgetStateModel,
  AgentExecutionTelemetryModel,
  AgentTaskModel,
} from './models'
import { validateExecutionFence } from './repository'
import { agentTeamService } from './service'
import {
  AgentControlFenceLostError,
  AgentExecutionBudgetExceededError,
  InvalidAgentTeamOperationError,
} from './errors'
import type {
  AgentBudget,
  AgentBudgetActiveReservation,
  AgentBudgetAdmissionRecord,
  AgentBudgetUsageCounters,
  AgentExecutionBudgetState,
  AgentExecutionTelemetry,
  AgentTaskRecord,
} from './types'

export type AgentExternalCallKind = 'model' | 'compaction' | 'tool'

export interface AgentExecutionBudgetContext {
  teamId: string
  conversationId: string
  userId: string
  agentId: string
  taskId?: string
  runId: string
  executionOwnerId: string
  agentSessionId?: string
  teamFenceRequired: boolean
}

export interface AgentExecutionUsageDelta {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  cost_usd?: number
  tool_calls?: number
  download_bytes?: number
}

export type AgentExecutionUsageTotals = AgentBudgetUsageCounters

export interface AgentExternalCallAdmission {
  admissionId: string
  admissionKey: string
  reservationKey: string
  kind: AgentExternalCallKind
  label?: string
  attempt: number
  reservedToolCalls: number
}

export interface AgentExecutionBudgetGate {
  /**
   * Atomically admit one external call. `attemptKey` must be stable for a
   * logical ToolUse; model calls may omit it and receive a physical-attempt id.
   */
  reserveCall(
    context: AgentExecutionBudgetContext,
    kind: AgentExternalCallKind,
    label?: string,
    attemptKey?: string,
  ): Promise<AgentExternalCallAdmission>
  /** Boundary after which a tool-call reservation is permanently consumed. */
  markCallStarted(
    context: AgentExecutionBudgetContext,
    admission: AgentExternalCallAdmission,
  ): Promise<void>
  /** Fold authoritative post-call observations and close the reservation. */
  completeCall(
    context: AgentExecutionBudgetContext,
    admission: AgentExternalCallAdmission,
    delta: AgentExecutionUsageDelta,
    usageObserved?: boolean,
  ): Promise<AgentExecutionTelemetry>
  /** Release a reservation only when the external call never crossed start. */
  releaseCall(
    context: AgentExecutionBudgetContext,
    admission: AgentExternalCallAdmission,
    reason?: string,
  ): Promise<void>
  /** Read-only diagnostic gate. Execution paths must use reserveCall(). */
  assertCanCall(
    context: AgentExecutionBudgetContext,
    kind: AgentExternalCallKind,
    label?: string,
  ): Promise<void>
  recordUsage(
    context: AgentExecutionBudgetContext,
    delta: AgentExecutionUsageDelta,
  ): Promise<AgentExecutionTelemetry>
  recordModelUsage(
    context: AgentExecutionBudgetContext,
    model: string,
    usage: TokenUsage,
  ): Promise<AgentExecutionTelemetry>
}

export interface AgentExecutionFenceValidator {
  validateRun(runId: string, ownerId: string): Promise<boolean>
  validateTeam(input: {
    teamId: string
    userId: string
    agentId: string
    sessionId: string
    runId: string
    ownerId: string
  }): Promise<boolean>
}

/**
 * Detached compaction has a synthetic execution id and is fenced by its own
 * Job lease. The ordinary AgentRun that triggered it may already be complete;
 * treating that expired Run lease as authoritative would make maintenance
 * abandon a valid in-flight budget admission.
 */
async function validateBudgetRunFence(runId: string, ownerId: string): Promise<boolean> {
  const prefix = 'compaction:'
  if (!runId.startsWith(prefix)) return validateAgentRunLeaseFence(runId, ownerId)
  const jobId = runId.slice(prefix.length)
  if (!jobId) return false
  return Boolean(await DurableCompactionJobModel.exists({
    job_id: jobId,
    status: { $in: ['queued', 'summarizing', 'summary_ready', 'merge_prepared', 'retryable'] },
    'lease.owner_id': ownerId,
    'lease.expires_at': { $gt: new Date() },
  }))
}

const ZERO_TOTALS: AgentExecutionUsageTotals = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cost_usd: 0,
  tool_calls: 0,
  download_bytes: 0,
}

const USAGE_FIELDS = Object.keys(ZERO_TOTALS) as Array<keyof AgentExecutionUsageTotals>
const OBSERVED_FIELDS = USAGE_FIELDS.filter(field => field !== 'tool_calls')
const INSTRUMENTED = Symbol('sci-pegasus.execution-budget-instrumented')

interface LoadedBudgetScopes {
  teamBudget?: AgentBudget
  agentBudget?: AgentBudget
  taskBudget?: AgentBudget
  hasTask: boolean
}

function finiteNonNegative(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : 0
}

export function normalizedExecutionUsage(
  delta?: AgentExecutionUsageDelta | null,
): AgentExecutionUsageTotals {
  return {
    input_tokens: finiteNonNegative(delta?.input_tokens),
    output_tokens: finiteNonNegative(delta?.output_tokens),
    cache_creation_input_tokens: finiteNonNegative(delta?.cache_creation_input_tokens),
    cache_read_input_tokens: finiteNonNegative(delta?.cache_read_input_tokens),
    cost_usd: finiteNonNegative(delta?.cost_usd),
    tool_calls: finiteNonNegative(delta?.tool_calls),
    download_bytes: finiteNonNegative(delta?.download_bytes),
  }
}

const normalizedDelta = normalizedExecutionUsage

function addUsage(
  left: AgentExecutionUsageTotals,
  right: AgentExecutionUsageTotals,
): AgentExecutionUsageTotals {
  const result = { ...left }
  for (const field of USAGE_FIELDS) result[field] += right[field]
  return result
}

function scopeKey(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalAttemptValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalAttemptValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalAttemptValue(child)]),
    )
  }
  return value
}

/** Stable logical identity; a reused ToolUse id with different input is new work. */
export function budgetToolAttemptKey(
  runId: string,
  toolUseId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): string {
  const inputHash = scopeKey(JSON.stringify(canonicalAttemptValue(toolInput)))
  return `${runId}:tool:${toolUseId}:${scopeKey(`${toolName}\u0000${inputHash}`)}`
}

function admissionId(teamId: string, admissionKey: string): string {
  return `budget_admission_${scopeKey(`${teamId}\u0000${admissionKey}`)}`
}

function stateId(teamId: string): string {
  return `execution_budget_${scopeKey(teamId)}`
}

function sameTask(left: string | null | undefined, right: string | null | undefined): boolean {
  return (left ?? null) === (right ?? null)
}

export function agentBudgetCnyPerUsd(): number {
  const configured = Number.parseFloat(process.env.AGENT_BUDGET_CNY_PER_USD ?? '')
  return Number.isFinite(configured) && configured > 0 ? configured : 7.2
}

/** Convert the existing RMB 分 estimate into USD dollars for budget policy. */
export function budgetCostUsdFromCents(costCents: number): number {
  const usd = finiteNonNegative(costCents) / 100 / agentBudgetCnyPerUsd()
  return Math.round(usd * 1_000_000_000_000) / 1_000_000_000_000
}

export function totalExecutionTokens(usage: AgentExecutionUsageTotals): number {
  return usage.input_tokens
    + usage.output_tokens
    + usage.cache_creation_input_tokens
    + usage.cache_read_input_tokens
}

/**
 * `max_tool_calls` is a strict admission ceiling. Token, cost, and download
 * dimensions are observed stop limits: exact values only exist after an
 * external call returns, so one admitted call may cross the configured value.
 */
export function exhaustedBudget(input: {
  budget?: AgentBudget
  usage: AgentExecutionUsageTotals
  kind: AgentExternalCallKind
}): { dimension: 'tokens' | 'cost_usd' | 'tool_calls' | 'download_bytes'; limit: number; used: number } | null {
  const { budget, usage, kind } = input
  if (!budget) return null
  const tokenUsage = totalExecutionTokens(usage)
  if (budget.max_tokens !== undefined && tokenUsage >= budget.max_tokens) {
    return { dimension: 'tokens', limit: budget.max_tokens, used: tokenUsage }
  }
  if (budget.max_cost_usd !== undefined && usage.cost_usd >= budget.max_cost_usd) {
    return { dimension: 'cost_usd', limit: budget.max_cost_usd, used: usage.cost_usd }
  }
  if (kind === 'tool') {
    if (budget.max_tool_calls !== undefined && usage.tool_calls >= budget.max_tool_calls) {
      return { dimension: 'tool_calls', limit: budget.max_tool_calls, used: usage.tool_calls }
    }
    if (budget.max_download_bytes !== undefined && usage.download_bytes >= budget.max_download_bytes) {
      return {
        dimension: 'download_bytes',
        limit: budget.max_download_bytes,
        used: usage.download_bytes,
      }
    }
  }
  return null
}

export function exhaustedBudgetScope(input: {
  scopes: Array<{
    scope: 'team' | 'agent' | 'task'
    budget?: AgentBudget
    usage: AgentExecutionUsageTotals
  }>
  kind: AgentExternalCallKind
}): {
  scope: 'team' | 'agent' | 'task'
  dimension: 'tokens' | 'cost_usd' | 'tool_calls' | 'download_bytes'
  limit: number
  used: number
} | null {
  for (const item of input.scopes) {
    const exhausted = exhaustedBudget({
      budget: item.budget,
      usage: item.usage,
      kind: input.kind,
    })
    if (exhausted) return { scope: item.scope, ...exhausted }
  }
  return null
}

function modelUsageDelta(model: string, usage: TokenUsage): AgentExecutionUsageTotals {
  const inputTokens = finiteNonNegative(usage.input_tokens)
  const outputTokens = finiteNonNegative(usage.output_tokens)
  const cacheCreationTokens = finiteNonNegative(usage.cache_creation_input_tokens)
  const cacheReadTokens = finiteNonNegative(usage.cache_read_input_tokens)
  const costCents = estimateCostCents(
    model,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
  )
  return normalizedDelta({
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreationTokens,
    cache_read_input_tokens: cacheReadTokens,
    cost_usd: budgetCostUsdFromCents(costCents),
  })
}

function usageForScope(
  state: AgentExecutionBudgetState,
  context: Pick<AgentExecutionBudgetContext, 'agentId' | 'taskId'>,
): {
  team: AgentExecutionUsageTotals
  agent: AgentExecutionUsageTotals
  task: AgentExecutionUsageTotals
} {
  return {
    team: normalizedDelta(state.team_usage),
    agent: normalizedDelta(state.agent_usage?.[scopeKey(context.agentId)]),
    task: context.taskId
      ? normalizedDelta(state.task_usage?.[scopeKey(context.taskId)])
      : { ...ZERO_TOTALS },
  }
}

function scopePrefixes(context: AgentExecutionBudgetContext): string[] {
  return [
    'team_usage',
    `agent_usage.${scopeKey(context.agentId)}`,
    ...(context.taskId ? [`task_usage.${scopeKey(context.taskId)}`] : []),
  ]
}

function expressionValue(path: string): Record<string, unknown> {
  return { $ifNull: [`$${path}`, 0] }
}

function budgetExpressions(
  prefix: string,
  budget: AgentBudget | undefined,
  kind: AgentExternalCallKind,
): Record<string, unknown>[] {
  if (!budget) return []
  const expressions: Record<string, unknown>[] = []
  if (budget.max_tokens !== undefined) {
    expressions.push({
      $lt: [
        {
          $add: [
            expressionValue(`${prefix}.input_tokens`),
            expressionValue(`${prefix}.output_tokens`),
            expressionValue(`${prefix}.cache_creation_input_tokens`),
            expressionValue(`${prefix}.cache_read_input_tokens`),
          ],
        },
        budget.max_tokens,
      ],
    })
  }
  if (budget.max_cost_usd !== undefined) {
    expressions.push({
      $lt: [expressionValue(`${prefix}.cost_usd`), budget.max_cost_usd],
    })
  }
  if (kind === 'tool' && budget.max_tool_calls !== undefined) {
    expressions.push({
      $lt: [expressionValue(`${prefix}.tool_calls`), budget.max_tool_calls],
    })
  }
  if (kind === 'tool' && budget.max_download_bytes !== undefined) {
    expressions.push({
      $lt: [expressionValue(`${prefix}.download_bytes`), budget.max_download_bytes],
    })
  }
  return expressions
}

export class MongoAgentExecutionBudgetLedger implements AgentExecutionBudgetGate {
  constructor(private readonly fenceValidator: AgentExecutionFenceValidator = {
    validateRun: validateBudgetRunFence,
    validateTeam: validateExecutionFence,
  }) {}

  private async fenceValid(context: AgentExecutionBudgetContext): Promise<boolean> {
    if (!await this.fenceValidator.validateRun(context.runId, context.executionOwnerId)) {
      return false
    }
    if (!context.teamFenceRequired) return true
    return Boolean(context.agentSessionId && await this.fenceValidator.validateTeam({
      teamId: context.teamId,
      userId: context.userId,
      agentId: context.agentId,
      sessionId: context.agentSessionId,
      runId: context.runId,
      ownerId: context.executionOwnerId,
    }))
  }

  private async assertFence(context: AgentExecutionBudgetContext): Promise<void> {
    if (!await this.fenceValid(context)) throw new AgentControlFenceLostError(context.runId)
  }

  private contextFromReservation(
    teamId: string,
    reservation: AgentBudgetActiveReservation,
  ): AgentExecutionBudgetContext {
    return {
      teamId,
      conversationId: reservation.conversation_id,
      userId: reservation.user_id,
      agentId: reservation.agent_id,
      taskId: reservation.task_id ?? undefined,
      runId: reservation.run_id,
      executionOwnerId: reservation.execution_owner_id,
      agentSessionId: reservation.agent_session_id ?? undefined,
      teamFenceRequired: reservation.team_fence_required,
    }
  }

  private async loadBudgetScopes(
    context: AgentExecutionBudgetContext,
  ): Promise<LoadedBudgetScopes> {
    const [team, grant, task] = await Promise.all([
      agentTeamService.getTeam({ teamId: context.teamId, userId: context.userId }),
      agentTeamService.getActiveGrant({
        teamId: context.teamId,
        userId: context.userId,
        agentId: context.agentId,
      }),
      context.taskId
        ? AgentTaskModel.findOne({
            team_id: context.teamId,
            user_id: context.userId,
            task_id: context.taskId,
            assigned_agent_id: context.agentId,
          }).lean<AgentTaskRecord>()
        : Promise.resolve(null),
    ])
    if (team.conversation_id !== context.conversationId) {
      throw new InvalidAgentTeamOperationError(
        'Execution budget Conversation does not match its Team.',
      )
    }
    if (context.taskId && !task) {
      throw new InvalidAgentTeamOperationError(
        'Execution budget Task does not belong to this Agent.',
      )
    }
    return {
      teamBudget: team.policy.global_budget,
      agentBudget: grant.budget,
      taskBudget: task?.budget,
      hasTask: Boolean(task),
    }
  }

  private async initializeState(
    context: AgentExecutionBudgetContext,
  ): Promise<AgentExecutionBudgetState> {
    await connectDB()
    const existing = await AgentExecutionBudgetStateModel.findOne({
      team_id: context.teamId,
      user_id: context.userId,
    }).lean<AgentExecutionBudgetState>()
    if (existing) {
      if (existing.conversation_id !== context.conversationId) {
        throw new InvalidAgentTeamOperationError('Execution budget state identity conflicts with its Team.')
      }
      return existing
    }

    const rows = await AgentExecutionTelemetryModel.aggregate<{
      _id: { agent_id: string; task_id?: string | null }
      usage: AgentExecutionUsageTotals
    }>([
      { $match: { team_id: context.teamId, user_id: context.userId } },
      {
        $group: {
          _id: { agent_id: '$agent_id', task_id: '$task_id' },
          input_tokens: { $sum: '$input_tokens' },
          output_tokens: { $sum: '$output_tokens' },
          cache_creation_input_tokens: { $sum: '$cache_creation_input_tokens' },
          cache_read_input_tokens: { $sum: '$cache_read_input_tokens' },
          cost_usd: { $sum: '$cost_usd' },
          tool_calls: { $sum: '$tool_calls' },
          download_bytes: { $sum: '$download_bytes' },
        },
      },
      {
        $project: {
          _id: 1,
          usage: {
            input_tokens: '$input_tokens',
            output_tokens: '$output_tokens',
            cache_creation_input_tokens: '$cache_creation_input_tokens',
            cache_read_input_tokens: '$cache_read_input_tokens',
            cost_usd: '$cost_usd',
            tool_calls: '$tool_calls',
            download_bytes: '$download_bytes',
          },
        },
      },
    ])
    let teamUsage = { ...ZERO_TOTALS }
    const agentUsage: Record<string, AgentExecutionUsageTotals> = {}
    const taskUsage: Record<string, AgentExecutionUsageTotals> = {}
    for (const row of rows) {
      const usage = normalizedDelta(row.usage)
      teamUsage = addUsage(teamUsage, usage)
      const agentKey = scopeKey(row._id.agent_id)
      agentUsage[agentKey] = addUsage(agentUsage[agentKey] ?? { ...ZERO_TOTALS }, usage)
      if (row._id.task_id) {
        const taskKey = scopeKey(row._id.task_id)
        taskUsage[taskKey] = addUsage(taskUsage[taskKey] ?? { ...ZERO_TOTALS }, usage)
      }
    }
    const now = new Date()
    const initial: Omit<AgentExecutionBudgetState, 'created_at' | 'updated_at'> = {
      budget_state_id: stateId(context.teamId),
      team_id: context.teamId,
      conversation_id: context.conversationId,
      user_id: context.userId,
      team_usage: teamUsage,
      agent_usage: agentUsage,
      task_usage: taskUsage,
      active_reservations: {},
      initialized_at: now,
    }
    try {
      const state = await AgentExecutionBudgetStateModel.findOneAndUpdate(
        { team_id: context.teamId, user_id: context.userId },
        { $setOnInsert: initial },
        { upsert: true, returnDocument: 'after' },
      ).lean<AgentExecutionBudgetState>()
      if (!state) throw new Error('Execution budget state initialization returned no document.')
      return state
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error
      const winner = await AgentExecutionBudgetStateModel.findOne({
        team_id: context.teamId,
        user_id: context.userId,
      }).lean<AgentExecutionBudgetState>()
      if (!winner) throw error
      return winner
    }
  }

  private scopesFromState(
    state: AgentExecutionBudgetState,
    context: AgentExecutionBudgetContext,
    budgets: LoadedBudgetScopes,
  ) {
    const usage = usageForScope(state, context)
    return [
      { scope: 'team' as const, budget: budgets.teamBudget, usage: usage.team },
      { scope: 'agent' as const, budget: budgets.agentBudget, usage: usage.agent },
      ...(budgets.hasTask
        ? [{ scope: 'task' as const, budget: budgets.taskBudget, usage: usage.task }]
        : []),
    ]
  }

  private assertReceiptIdentity(
    record: AgentBudgetAdmissionRecord,
    context: AgentExecutionBudgetContext,
    kind: AgentExternalCallKind,
    key: string,
  ): void {
    if (
      record.team_id !== context.teamId
      || record.conversation_id !== context.conversationId
      || record.user_id !== context.userId
      || record.agent_id !== context.agentId
      || !sameTask(record.task_id, context.taskId)
      || record.run_id !== context.runId
      || record.kind !== kind
      || record.admission_key !== key
    ) {
      throw new InvalidAgentTeamOperationError(
        'Execution budget admission identity conflicts with an existing receipt.',
        { admission_id: record.admission_id },
      )
    }
  }

  private activeReservation(
    state: AgentExecutionBudgetState,
    reservationKey: string,
  ): AgentBudgetActiveReservation | undefined {
    return state.active_reservations?.[reservationKey]
  }

  private async reserveAtomic(input: {
    context: AgentExecutionBudgetContext
    budgets: LoadedBudgetScopes
    admissionId: string
    admissionKey: string
    reservationKey: string
    kind: AgentExternalCallKind
    label?: string
    attempt: number
    reservedToolCalls: number
    bypassBudgetGates?: boolean
  }): Promise<AgentExecutionBudgetState | null> {
    const { context, budgets } = input
    const now = new Date()
    const reservation: AgentBudgetActiveReservation = {
      admission_id: input.admissionId,
      admission_key: input.admissionKey,
      kind: input.kind,
      label: input.label ?? null,
      conversation_id: context.conversationId,
      user_id: context.userId,
      agent_id: context.agentId,
      task_id: context.taskId ?? null,
      run_id: context.runId,
      execution_owner_id: context.executionOwnerId,
      agent_session_id: context.agentSessionId ?? null,
      team_fence_required: context.teamFenceRequired,
      status: 'reserved',
      attempt: input.attempt,
      reserved_tool_calls: input.reservedToolCalls,
      created_at: now,
      started_at: null,
    }
    const reservationPath = `active_reservations.${input.reservationKey}`
    const expressions = input.bypassBudgetGates
      ? []
      : [
          ...budgetExpressions('team_usage', budgets.teamBudget, input.kind),
          ...budgetExpressions(
            `agent_usage.${scopeKey(context.agentId)}`,
            budgets.agentBudget,
            input.kind,
          ),
          ...(budgets.hasTask && context.taskId
            ? budgetExpressions(
                `task_usage.${scopeKey(context.taskId)}`,
                budgets.taskBudget,
                input.kind,
              )
            : []),
        ]
    const filter: Record<string, unknown> = {
      budget_state_id: stateId(context.teamId),
      team_id: context.teamId,
      conversation_id: context.conversationId,
      user_id: context.userId,
      [reservationPath]: { $exists: false },
      ...(expressions.length > 0 ? { $expr: { $and: expressions } } : {}),
    }
    const increments: Record<string, number> = {}
    if (input.reservedToolCalls > 0) {
      for (const prefix of scopePrefixes(context)) {
        increments[`${prefix}.tool_calls`] = input.reservedToolCalls
      }
    }
    return AgentExecutionBudgetStateModel.findOneAndUpdate(
      filter,
      {
        $set: { [reservationPath]: reservation },
        ...(Object.keys(increments).length > 0 ? { $inc: increments } : {}),
      },
      { returnDocument: 'after', strict: false },
    ).lean<AgentExecutionBudgetState>()
  }

  private async upsertReceiptFromReservation(
    teamId: string,
    reservationKey: string,
    reservation: AgentBudgetActiveReservation,
  ): Promise<AgentBudgetAdmissionRecord> {
    const existing = await AgentBudgetAdmissionModel.findOne({
      admission_id: reservation.admission_id,
    }).lean<AgentBudgetAdmissionRecord>()
    const historyEntry = existing && existing.attempt < reservation.attempt
      ? {
          attempt: existing.attempt,
          status: existing.status,
          execution_owner_id: existing.execution_owner_id,
          reserved_tool_calls: existing.reserved_tool_calls,
          usage_delta: normalizedDelta(existing.usage_delta),
          usage_observed: existing.usage_observed,
          started_at: existing.started_at ?? null,
          completed_at: existing.completed_at ?? null,
          released_at: existing.released_at ?? null,
          abandoned_at: existing.abandoned_at ?? null,
          release_reason: existing.release_reason ?? null,
          archived_at: new Date(),
        }
      : null
    const receipt = await AgentBudgetAdmissionModel.findOneAndUpdate(
      { admission_id: reservation.admission_id },
      {
        $set: {
          admission_key: reservation.admission_key,
          reservation_key: reservationKey,
          team_id: teamId,
          conversation_id: reservation.conversation_id,
          user_id: reservation.user_id,
          agent_id: reservation.agent_id,
          task_id: reservation.task_id ?? null,
          run_id: reservation.run_id,
          execution_owner_id: reservation.execution_owner_id,
          agent_session_id: reservation.agent_session_id ?? null,
          team_fence_required: reservation.team_fence_required,
          kind: reservation.kind,
          label: reservation.label ?? null,
          status: reservation.status,
          attempt: reservation.attempt,
          reserved_tool_calls: reservation.reserved_tool_calls,
          usage_delta: { ...ZERO_TOTALS },
          usage_observed: false,
          started_at: reservation.started_at ?? null,
          completed_at: null,
          released_at: null,
          abandoned_at: null,
          release_reason: null,
        },
        ...(historyEntry ? { $push: { attempt_history: historyEntry } } : {}),
      },
      { upsert: true, returnDocument: 'after' },
    ).lean<AgentBudgetAdmissionRecord>()
    if (!receipt) throw new Error('Execution budget admission receipt returned no document.')
    return receipt
  }

  private async releaseReservationInternal(
    teamId: string,
    reservationKey: string,
    reservation: AgentBudgetActiveReservation,
    reason: string,
  ): Promise<boolean> {
    await this.upsertReceiptFromReservation(teamId, reservationKey, reservation)
    await AgentBudgetAdmissionModel.updateOne(
      { admission_id: reservation.admission_id, attempt: reservation.attempt },
      { $set: { status: 'releasing', release_reason: reason } },
    )
    const path = `active_reservations.${reservationKey}`
    const increments: Record<string, number> = {}
    if (reservation.reserved_tool_calls > 0) {
      const context = this.contextFromReservation(teamId, reservation)
      for (const prefix of scopePrefixes(context)) {
        increments[`${prefix}.tool_calls`] = -reservation.reserved_tool_calls
      }
    }
    const released = await AgentExecutionBudgetStateModel.findOneAndUpdate(
      {
        budget_state_id: stateId(teamId),
        [`${path}.admission_id`]: reservation.admission_id,
        [`${path}.attempt`]: reservation.attempt,
        [`${path}.status`]: 'reserved',
      },
      {
        $unset: { [path]: 1 },
        ...(Object.keys(increments).length > 0 ? { $inc: increments } : {}),
      },
      { returnDocument: 'after', strict: false },
    ).lean<AgentExecutionBudgetState>()
    if (!released) {
      const state = await AgentExecutionBudgetStateModel.findOne({
        budget_state_id: stateId(teamId),
      }).lean<AgentExecutionBudgetState>()
      if (state && this.activeReservation(state, reservationKey)) return false
    }
    await AgentBudgetAdmissionModel.updateOne(
      { admission_id: reservation.admission_id, attempt: reservation.attempt },
      {
        $set: {
          status: 'released',
          released_at: new Date(),
          release_reason: reason,
          usage_observed: false,
        },
      },
    )
    return true
  }

  private async abandonStartedInternal(
    teamId: string,
    reservationKey: string,
    reservation: AgentBudgetActiveReservation,
    reason: string,
  ): Promise<boolean> {
    await this.upsertReceiptFromReservation(teamId, reservationKey, reservation)
    await AgentBudgetAdmissionModel.updateOne(
      { admission_id: reservation.admission_id, attempt: reservation.attempt },
      {
        $set: {
          status: 'abandoned',
          abandoned_at: new Date(),
          release_reason: reason,
          usage_delta: { ...ZERO_TOTALS },
          usage_observed: false,
        },
      },
    )
    const path = `active_reservations.${reservationKey}`
    const state = await AgentExecutionBudgetStateModel.findOneAndUpdate(
      {
        budget_state_id: stateId(teamId),
        [`${path}.admission_id`]: reservation.admission_id,
        [`${path}.attempt`]: reservation.attempt,
        [`${path}.status`]: 'started',
      },
      { $unset: { [path]: 1 } },
      { returnDocument: 'after', strict: false },
    ).lean<AgentExecutionBudgetState>()
    return Boolean(state)
  }

  async recoverStaleAdmissions(input?: {
    teamId?: string
    userId?: string
  }): Promise<{ released: number; abandoned: number }> {
    await connectDB()
    const states = await AgentExecutionBudgetStateModel.find({
      ...(input?.teamId ? { team_id: input.teamId } : {}),
      ...(input?.userId ? { user_id: input.userId } : {}),
    }).lean<AgentExecutionBudgetState[]>()
    let released = 0
    let abandoned = 0
    for (const state of states) {
      for (const [reservationKey, reservation] of Object.entries(
        state.active_reservations ?? {},
      )) {
        if (await this.fenceValid(this.contextFromReservation(state.team_id, reservation))) continue
        if (reservation.status === 'reserved') {
          if (await this.releaseReservationInternal(
            state.team_id,
            reservationKey,
            reservation,
            'execution_fence_lost_before_start',
          )) released += 1
        } else if (await this.abandonStartedInternal(
          state.team_id,
          reservationKey,
          reservation,
          'execution_fence_lost_after_start_usage_unobserved',
        )) {
          abandoned += 1
        }
      }
    }
    return { released, abandoned }
  }

  async reserveCall(
    context: AgentExecutionBudgetContext,
    kind: AgentExternalCallKind,
    label?: string,
    suppliedAttemptKey?: string,
  ): Promise<AgentExternalCallAdmission> {
    await this.assertFence(context)
    const budgets = await this.loadBudgetScopes(context)
    await this.initializeState(context)
    const key = suppliedAttemptKey?.trim()
      || `${context.runId}:${kind}:physical:${randomUUID()}`
    if (!key || key.length > 1024 || /\p{Cc}/u.test(key)) {
      throw new InvalidAgentTeamOperationError('Execution budget attempt key is invalid.')
    }
    const id = admissionId(context.teamId, key)
    const reservationKey = scopeKey(id)
    let prior = await AgentBudgetAdmissionModel.findOne({ admission_id: id })
      .lean<AgentBudgetAdmissionRecord>()
    if (prior) {
      this.assertReceiptIdentity(prior, context, kind, key)
      if (prior.status === 'settling') await this.finishSettlingReceipt(prior)
      if (prior.status === 'releasing') {
        const state = await this.initializeState(context)
        const active = this.activeReservation(state, reservationKey)
        if (active?.status === 'reserved') {
          await this.releaseReservationInternal(
            context.teamId,
            reservationKey,
            active,
            prior.release_reason ?? 'recovered_release',
          )
        }
      }
      prior = await AgentBudgetAdmissionModel.findOne({ admission_id: id })
        .lean<AgentBudgetAdmissionRecord>()
    }

    let priorConsumed = prior?.status === 'completed' || prior?.status === 'abandoned'
    if (prior?.status === 'reserved' || prior?.status === 'started') {
      const state = await this.initializeState(context)
      const active = this.activeReservation(state, reservationKey)
      if (active) {
        if (await this.fenceValid(this.contextFromReservation(context.teamId, active))) {
          throw new InvalidAgentTeamOperationError(
            'The same execution budget attempt is already in progress.',
            { admission_id: id, attempt: active.attempt },
          )
        }
        if (active.status === 'reserved') {
          await this.releaseReservationInternal(
            context.teamId,
            reservationKey,
            active,
            'stale_attempt_reclaimed_before_start',
          )
          priorConsumed = false
        } else {
          await this.abandonStartedInternal(
            context.teamId,
            reservationKey,
            active,
            'stale_started_attempt_usage_unobserved',
          )
          priorConsumed = true
        }
      }
      prior = await AgentBudgetAdmissionModel.findOne({ admission_id: id })
        .lean<AgentBudgetAdmissionRecord>()
    }

    const attempt = (prior?.attempt ?? 0) + 1
    const reservedToolCalls = kind === 'tool' && !priorConsumed ? 1 : 0
    // A completed/started-then-abandoned logical ToolUse already owns its one
    // strict admission. Crash replay must reach the command/tool idempotency
    // layer even when counters now equal the configured ceiling.
    const bypassBudgetGates = kind === 'tool' && priorConsumed
    await this.assertFence(context)
    let state = await this.reserveAtomic({
      context,
      budgets,
      admissionId: id,
      admissionKey: key,
      reservationKey,
      kind,
      label,
      attempt,
      reservedToolCalls,
      bypassBudgetGates,
    })
    if (!state) {
      const recovered = await this.recoverStaleAdmissions({
        teamId: context.teamId,
        userId: context.userId,
      })
      if (recovered.released > 0 || recovered.abandoned > 0) {
        await this.assertFence(context)
        state = await this.reserveAtomic({
          context,
          budgets,
          admissionId: id,
          admissionKey: key,
          reservationKey,
          kind,
          label,
          attempt,
          reservedToolCalls,
          bypassBudgetGates,
        })
      }
    }
    if (!state) {
      const current = await this.initializeState(context)
      if (this.activeReservation(current, reservationKey)) {
        throw new InvalidAgentTeamOperationError(
          'The same execution budget attempt is already in progress.',
          { admission_id: id, attempt },
        )
      }
      const exhausted = exhaustedBudgetScope({
        scopes: this.scopesFromState(current, context, budgets),
        kind,
      })
      if (exhausted) throw new AgentExecutionBudgetExceededError(exhausted)
      throw new InvalidAgentTeamOperationError('Execution budget admission CAS was not acquired.')
    }

    const reservation = this.activeReservation(state, reservationKey)
    if (!reservation) throw new Error('Execution budget reservation was not persisted.')
    await this.upsertReceiptFromReservation(context.teamId, reservationKey, reservation)
    if (!await this.fenceValid(context)) {
      await this.releaseReservationInternal(
        context.teamId,
        reservationKey,
        reservation,
        'execution_fence_lost_during_admission',
      )
      throw new AgentControlFenceLostError(context.runId)
    }
    return {
      admissionId: id,
      admissionKey: key,
      reservationKey,
      kind,
      label,
      attempt,
      reservedToolCalls,
    }
  }

  async markCallStarted(
    context: AgentExecutionBudgetContext,
    admission: AgentExternalCallAdmission,
  ): Promise<void> {
    await this.assertFence(context)
    const path = `active_reservations.${admission.reservationKey}`
    const startedAt = new Date()
    const state = await AgentExecutionBudgetStateModel.findOneAndUpdate(
      {
        budget_state_id: stateId(context.teamId),
        [`${path}.admission_id`]: admission.admissionId,
        [`${path}.attempt`]: admission.attempt,
        [`${path}.execution_owner_id`]: context.executionOwnerId,
        [`${path}.status`]: 'reserved',
      },
      {
        $set: {
          [`${path}.status`]: 'started',
          [`${path}.started_at`]: startedAt,
        },
      },
      { returnDocument: 'after', strict: false },
    ).lean<AgentExecutionBudgetState>()
    if (!state) {
      const receipt = await AgentBudgetAdmissionModel.findOne({
        admission_id: admission.admissionId,
        attempt: admission.attempt,
      }).lean<AgentBudgetAdmissionRecord>()
      if (receipt?.status === 'started') return
      throw new InvalidAgentTeamOperationError(
        'Execution budget reservation is no longer startable.',
        { admission_id: admission.admissionId, attempt: admission.attempt },
      )
    }
    await AgentBudgetAdmissionModel.updateOne(
      { admission_id: admission.admissionId, attempt: admission.attempt },
      { $set: { status: 'started', started_at: startedAt } },
    )
    if (!await this.fenceValid(context)) {
      const reservation = this.activeReservation(state, admission.reservationKey)
      if (reservation) {
        await this.abandonStartedInternal(
          context.teamId,
          admission.reservationKey,
          reservation,
          'execution_fence_lost_at_start_boundary_usage_unobserved',
        )
      }
      throw new AgentControlFenceLostError(context.runId)
    }
  }

  private stateSettlementIncrement(
    context: AgentExecutionBudgetContext,
    delta: AgentExecutionUsageTotals,
  ): Record<string, number> {
    const increments: Record<string, number> = {}
    for (const prefix of scopePrefixes(context)) {
      for (const field of OBSERVED_FIELDS) {
        if (delta[field] > 0) increments[`${prefix}.${field}`] = delta[field]
      }
    }
    return increments
  }

  private async applyTelemetryOnce(
    context: AgentExecutionBudgetContext,
    contributionId: string,
    delta: AgentExecutionUsageTotals,
  ): Promise<AgentExecutionTelemetry> {
    const telemetryId = `execution_telemetry_${context.runId}`
    const identity = {
      telemetry_id: telemetryId,
      team_id: context.teamId,
      conversation_id: context.conversationId,
      user_id: context.userId,
      agent_id: context.agentId,
      task_id: context.taskId ?? null,
      run_id: context.runId,
    }
    try {
      await AgentExecutionTelemetryModel.findOneAndUpdate(
        identity,
        { $setOnInsert: { ...identity, ...ZERO_TOTALS, applied_admission_ids: [] } },
        { upsert: true, returnDocument: 'after' },
      )
      const applied = await AgentExecutionTelemetryModel.findOneAndUpdate(
        { ...identity, applied_admission_ids: { $ne: contributionId } },
        {
          $inc: delta,
          $addToSet: { applied_admission_ids: contributionId },
        },
        { returnDocument: 'after' },
      ).lean<AgentExecutionTelemetry>()
      if (applied) return applied
      const replay = await AgentExecutionTelemetryModel.findOne(identity)
        .lean<AgentExecutionTelemetry>()
      if (!replay) throw new Error('Execution telemetry replay returned no document.')
      return replay
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        throw new InvalidAgentTeamOperationError(
          'Execution telemetry Run identity conflicts with an existing attribution.',
          { run_id: context.runId },
        )
      }
      throw error
    }
  }

  private async finishSettlingReceipt(
    receipt: AgentBudgetAdmissionRecord,
  ): Promise<AgentExecutionTelemetry> {
    const context: AgentExecutionBudgetContext = {
      teamId: receipt.team_id,
      conversationId: receipt.conversation_id,
      userId: receipt.user_id,
      agentId: receipt.agent_id,
      taskId: receipt.task_id ?? undefined,
      runId: receipt.run_id,
      executionOwnerId: receipt.execution_owner_id,
      agentSessionId: receipt.agent_session_id ?? undefined,
      teamFenceRequired: receipt.team_fence_required,
    }
    const path = `active_reservations.${receipt.reservation_key}`
    const delta = normalizedDelta(receipt.usage_delta)
    const increments = this.stateSettlementIncrement(context, delta)
    const settled = await AgentExecutionBudgetStateModel.findOneAndUpdate(
      {
        budget_state_id: stateId(receipt.team_id),
        [`${path}.admission_id`]: receipt.admission_id,
        [`${path}.attempt`]: receipt.attempt,
        [`${path}.status`]: 'started',
      },
      {
        $unset: { [path]: 1 },
        ...(Object.keys(increments).length > 0 ? { $inc: increments } : {}),
      },
      { returnDocument: 'after', strict: false },
    ).lean<AgentExecutionBudgetState>()
    if (!settled) {
      const current = await AgentExecutionBudgetStateModel.findOne({
        budget_state_id: stateId(receipt.team_id),
      }).lean<AgentExecutionBudgetState>()
      if (current && this.activeReservation(current, receipt.reservation_key)) {
        throw new InvalidAgentTeamOperationError(
          'Execution budget settlement lost its reservation.',
          { admission_id: receipt.admission_id, attempt: receipt.attempt },
        )
      }
    }
    const telemetry = await this.applyTelemetryOnce(
      context,
      `${receipt.admission_id}:attempt:${receipt.attempt}`,
      delta,
    )
    await AgentBudgetAdmissionModel.updateOne(
      { admission_id: receipt.admission_id, attempt: receipt.attempt },
      { $set: { status: 'completed', completed_at: new Date() } },
    )
    return telemetry
  }

  async completeCall(
    context: AgentExecutionBudgetContext,
    admission: AgentExternalCallAdmission,
    rawDelta: AgentExecutionUsageDelta,
    usageObserved = true,
  ): Promise<AgentExecutionTelemetry> {
    await this.assertFence(context)
    const delta = normalizedDelta({
      ...rawDelta,
      tool_calls: admission.reservedToolCalls,
    })
    let receipt = await AgentBudgetAdmissionModel.findOne({
      admission_id: admission.admissionId,
      attempt: admission.attempt,
    }).lean<AgentBudgetAdmissionRecord>()
    if (!receipt) {
      throw new InvalidAgentTeamOperationError('Execution budget admission receipt is missing.')
    }
    if (receipt.status === 'completed') {
      return this.applyTelemetryOnce(
        context,
        `${receipt.admission_id}:attempt:${receipt.attempt}`,
        normalizedDelta(receipt.usage_delta),
      )
    }
    if (receipt.status !== 'started' && receipt.status !== 'settling') {
      throw new InvalidAgentTeamOperationError(
        'Execution budget admission did not cross the start boundary.',
        { admission_id: admission.admissionId, status: receipt.status },
      )
    }
    if (receipt.status === 'started') {
      receipt = await AgentBudgetAdmissionModel.findOneAndUpdate(
        {
          admission_id: admission.admissionId,
          attempt: admission.attempt,
          status: 'started',
          execution_owner_id: context.executionOwnerId,
        },
        {
          $set: {
            status: 'settling',
            usage_delta: delta,
            usage_observed: usageObserved,
          },
        },
        { returnDocument: 'after' },
      ).lean<AgentBudgetAdmissionRecord>()
      if (!receipt) throw new AgentControlFenceLostError(context.runId)
    }
    return this.finishSettlingReceipt(receipt)
  }

  async releaseCall(
    context: AgentExecutionBudgetContext,
    admission: AgentExternalCallAdmission,
    reason = 'call_not_started',
  ): Promise<void> {
    await this.assertFence(context)
    const state = await this.initializeState(context)
    const reservation = this.activeReservation(state, admission.reservationKey)
    if (!reservation) return
    if (reservation.status !== 'reserved') {
      throw new InvalidAgentTeamOperationError('A started external call cannot release its budget.')
    }
    if (!await this.releaseReservationInternal(
      context.teamId,
      admission.reservationKey,
      reservation,
      reason,
    )) {
      throw new InvalidAgentTeamOperationError('Execution budget release lost its reservation.')
    }
  }

  async assertCanCall(
    context: AgentExecutionBudgetContext,
    kind: AgentExternalCallKind,
  ): Promise<void> {
    await this.assertFence(context)
    const budgets = await this.loadBudgetScopes(context)
    const state = await this.initializeState(context)
    const exhausted = exhaustedBudgetScope({
      scopes: this.scopesFromState(state, context, budgets),
      kind,
    })
    if (exhausted) throw new AgentExecutionBudgetExceededError(exhausted)
  }

  async recordUsage(
    context: AgentExecutionBudgetContext,
    rawDelta: AgentExecutionUsageDelta,
  ): Promise<AgentExecutionTelemetry> {
    const delta = normalizedDelta(rawDelta)
    await this.assertFence(context)
    await this.loadBudgetScopes(context)
    await this.initializeState(context)
    const increments: Record<string, number> = {}
    for (const prefix of scopePrefixes(context)) {
      for (const field of USAGE_FIELDS) {
        if (delta[field] > 0) increments[`${prefix}.${field}`] = delta[field]
      }
    }
    if (Object.keys(increments).length > 0) {
      await AgentExecutionBudgetStateModel.updateOne(
        {
          budget_state_id: stateId(context.teamId),
          team_id: context.teamId,
          user_id: context.userId,
        },
        { $inc: increments },
        { strict: false },
      )
    }
    return this.applyTelemetryOnce(context, `direct:${randomUUID()}`, delta)
  }

  recordModelUsage(
    context: AgentExecutionBudgetContext,
    model: string,
    usage: TokenUsage,
  ): Promise<AgentExecutionTelemetry> {
    return this.recordUsage(context, modelUsageDelta(model, usage))
  }
}

export const agentExecutionBudgetLedger = new MongoAgentExecutionBudgetLedger()

/** Standalone repair hook for the Runner/Team maintenance sweep. */
export function recoverStaleAgentBudgetAdmissions(): Promise<{
  released: number
  abandoned: number
}> {
  return agentExecutionBudgetLedger.recoverStaleAdmissions()
}

/**
 * Wrap one provider exactly once. Every external call reserves before start.
 * Tool calls are strict logical-attempt admissions; token/cost/download values
 * are settled from authoritative responses and therefore remain observed stop
 * limits rather than promises that an in-flight call cannot cross a ceiling.
 */
export function instrumentAgentProviderForBudget(
  provider: AgentProvider,
  input: {
    context: AgentExecutionBudgetContext
    model: string
    ledger?: AgentExecutionBudgetGate
  },
): AgentProvider {
  const marked = provider as AgentProvider & { [INSTRUMENTED]?: true }
  if (marked[INSTRUMENTED]) return provider
  Object.defineProperty(marked, INSTRUMENTED, { value: true })
  const ledger = input.ledger ?? agentExecutionBudgetLedger

  const callLLM = provider.callLLM.bind(provider)
  provider.callLLM = async request => {
    const admission = await ledger.reserveCall(input.context, 'model', input.model)
    await ledger.markCallStarted(input.context, admission)
    let response
    try {
      response = await callLLM(request)
    } catch (error) {
      await ledger.completeCall(input.context, admission, {}, false).catch(() => undefined)
      throw error
    }
    await ledger.completeCall(
      input.context,
      admission,
      modelUsageDelta(input.model, response.usage),
      true,
    )
    return response
  }

  const callLLMSilent = provider.callLLMSilent.bind(provider)
  provider.callLLMSilent = async (request, signal) => {
    const admission = await ledger.reserveCall(input.context, 'compaction', input.model)
    await ledger.markCallStarted(input.context, admission)
    let response
    try {
      response = await callLLMSilent(request, signal)
    } catch (error) {
      await ledger.completeCall(input.context, admission, {}, false).catch(() => undefined)
      throw error
    }
    await ledger.completeCall(
      input.context,
      admission,
      modelUsageDelta(input.model, response.usage),
      true,
    )
    return response
  }

  const executeTool = provider.executeTool.bind(provider)
  provider.executeTool = async (name, toolInput, invocation) => {
    const attemptKey = invocation?.toolUseId
      ? budgetToolAttemptKey(input.context.runId, invocation.toolUseId, name, toolInput)
      : `${input.context.runId}:tool:fallback:${randomUUID()}`
    const admission = await ledger.reserveCall(input.context, 'tool', name, attemptKey)
    await ledger.markCallStarted(input.context, admission)
    let result
    try {
      result = await executeTool(name, toolInput, invocation)
    } catch (error) {
      await ledger.completeCall(input.context, admission, {}, false).catch(() => undefined)
      throw error
    }
    await ledger.completeCall(input.context, admission, {
      download_bytes: finiteNonNegative(result.telemetry?.download_bytes),
    }, true)
    return result
  }
  return provider
}
