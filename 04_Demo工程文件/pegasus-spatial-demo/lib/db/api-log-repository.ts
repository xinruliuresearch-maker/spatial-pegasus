import { connectDB } from './mongodb'
import { APICallLog, DailyUsage } from './api-log-models'
import type { DailyUsageDoc } from './api-log-models'
import { randomUUID } from 'crypto'
import { stripBase64Images, extractToolNames } from '../agent/api-log-utils'
import { getTotalInputTokens } from '../agent/compaction'
import { estimateCostCents } from '../agent/pricing'
import { tokenTracker, type TokenExecutionContext } from '../agent/token-tracker'
import type { LLMResponse, TokenUsage } from '../types'

// ==================== Input Types ====================

export interface LogAPICallInput {
  user_id: string
  conversation_id: string
  /** Optional fallback when this call is not running inside tokenTracker context. */
  team_id?: string
  agent_id?: string
  task_id?: string
  run_id?: string
  source: string
  model: string
  usage: TokenUsage
  duration_ms: number
  status: 'success' | 'error' | 'aborted'
  error_message?: string
  turn_number: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request_body: any
  response: LLMResponse | null
}

export interface APICallAttribution {
  team_id?: string
  agent_id?: string
  task_id?: string
  run_id?: string
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

/**
 * Resolve durable attribution before the first async boundary. The active
 * execution context is authoritative; explicit fields are a compatibility
 * fallback for callers that intentionally log outside an Agent Run.
 */
export function resolveAPICallAttribution(
  input: Pick<LogAPICallInput, 'team_id' | 'agent_id' | 'task_id' | 'run_id'>,
  context: Readonly<TokenExecutionContext> = tokenTracker.context,
): APICallAttribution {
  const values: APICallAttribution = {
    team_id: nonEmpty(context.teamId) ?? nonEmpty(input.team_id),
    agent_id: nonEmpty(context.agentId) ?? nonEmpty(input.agent_id),
    task_id: nonEmpty(context.taskId) ?? nonEmpty(input.task_id),
    run_id: nonEmpty(context.runId) ?? nonEmpty(input.run_id),
  }
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as APICallAttribution
}

// ==================== Write Operations ====================

/**
 * Record a single API call to the api_call_logs collection.
 * Strips base64 images from request_body to save storage.
 * Fire-and-forget — caller should .catch() errors.
 */
export async function logAPICall(input: LogAPICallInput): Promise<void> {
  // Capture synchronously: concurrent Agents may reach connectDB and model
  // writes in any order, but their AsyncLocalStorage attribution must not mix.
  const attribution = resolveAPICallAttribution(input)
  await connectDB()

  const sanitizedRequest = stripBase64Images(input.request_body)
  const requestBodySize = input.request_body
    ? JSON.stringify(input.request_body).length
    : 0

  const inputTokens = input.usage.input_tokens || 0
  const outputTokens = input.usage.output_tokens || 0
  const cacheCreation = input.usage.cache_creation_input_tokens || 0
  const cacheRead = input.usage.cache_read_input_tokens || 0
  // Currency is RMB 分, matching DailyUsage and the deployment pricing table.
  const costCents = estimateCostCents(input.model, inputTokens, outputTokens, cacheCreation, cacheRead)

  await APICallLog.create({
    api_call_log_id: randomUUID(),
    user_id: input.user_id,
    conversation_id: input.conversation_id,
    ...attribution,
    timestamp: new Date(),
    source: input.source,
    model: input.model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_tokens: cacheCreation,
    cache_read_tokens: cacheRead,
    total_effective_input_tokens: getTotalInputTokens(input.usage),
    duration_ms: input.duration_ms,
    status: input.status,
    error_message: input.error_message,
    tool_calls: input.response ? extractToolNames(input.response) : [],
    turn_number: input.turn_number,
    request_body: sanitizedRequest,
    response_content: input.response?.content ?? [],
    response_stop_reason: input.response?.stop_reason ?? input.status,
    request_body_size_bytes: requestBodySize,
    estimated_cost_cents: costCents,
  })

  // Increment daily usage atomically
  const today = new Date().toISOString().slice(0, 10)

  await DailyUsage.updateOne(
    { user_id: input.user_id, date: today, source: input.source, model: input.model },
    {
      $inc: {
        total_requests: 1,
        total_input_tokens: inputTokens,
        total_output_tokens: outputTokens,
        total_cache_creation: cacheCreation,
        total_cache_read: cacheRead,
        total_effective_input: getTotalInputTokens(input.usage),
        estimated_cost_cents: costCents,
      },
    },
    { upsert: true },
  )
}

// ==================== Read Operations ====================

/**
 * Get daily usage for a user within a date range, broken down by source + model.
 */
export async function getUserDailyUsage(
  userId: string,
  startDate: string,
  endDate: string,
): Promise<DailyUsageDoc[]> {
  await connectDB()
  return DailyUsage.find({
    user_id: userId,
    date: { $gte: startDate, $lte: endDate },
  }).sort({ date: -1 })
}

/**
 * Get monthly usage summary for a user.
 */
export async function getUserMonthlyUsage(
  userId: string,
  yearMonth: string, // e.g. "2026-04"
): Promise<{
  bySource: { source: string; model: string; requests: number; effective_input: number; output: number; cost_cents: number }[]
  total: { requests: number; effective_input: number; output: number; cost_cents: number }
}> {
  await connectDB()
  const rows = await DailyUsage.find({
    user_id: userId,
    date: { $gte: `${yearMonth}-01`, $lte: `${yearMonth}-31` },
  })

  // Aggregate by source + model
  const grouped = new Map<string, { source: string; model: string; requests: number; effective_input: number; output: number; cost_cents: number }>()
  let totalRequests = 0, totalInput = 0, totalOutput = 0, totalCost = 0

  for (const row of rows) {
    const key = `${row.source}|${row.model}`
    const existing = grouped.get(key)
    if (existing) {
      existing.requests += row.total_requests
      existing.effective_input += row.total_effective_input
      existing.output += row.total_output_tokens
      existing.cost_cents += row.estimated_cost_cents
    } else {
      grouped.set(key, {
        source: row.source,
        model: row.model,
        requests: row.total_requests,
        effective_input: row.total_effective_input,
        output: row.total_output_tokens,
        cost_cents: row.estimated_cost_cents,
      })
    }
    totalRequests += row.total_requests
    totalInput += row.total_effective_input
    totalOutput += row.total_output_tokens
    totalCost += row.estimated_cost_cents
  }

  return {
    bySource: [...grouped.values()],
    total: { requests: totalRequests, effective_input: totalInput, output: totalOutput, cost_cents: totalCost },
  }
}

/**
 * Get all API call logs for a specific conversation.
 */
export async function getConversationUsage(
  conversationId: string,
  userId: string,
) {
  await connectDB()
  return APICallLog.find({
    conversation_id: conversationId,
    user_id: userId,
  }).sort({ timestamp: 1 })
}
