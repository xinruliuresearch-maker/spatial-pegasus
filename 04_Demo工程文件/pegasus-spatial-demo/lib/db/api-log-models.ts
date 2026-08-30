import mongoose, { Schema, type Model } from 'mongoose'

// ==================== API Call Log ====================

export interface APICallLogDoc {
  api_call_log_id: string
  user_id: string
  conversation_id: string
  /** Optional V1 multi-Agent attribution. Missing on pre-migration logs. */
  team_id?: string
  agent_id?: string
  task_id?: string
  run_id?: string
  timestamp: Date
  source: string
  model: string
  input_tokens: number
  output_tokens: number
  cache_creation_tokens: number
  cache_read_tokens: number
  total_effective_input_tokens: number
  duration_ms: number
  status: 'success' | 'error' | 'aborted'
  error_message?: string
  tool_calls: string[]
  turn_number: number
  request_body: unknown
  response_content: unknown[]
  response_stop_reason: string
  request_body_size_bytes: number
  /** Estimated cost in RMB 分. Missing on historical call-level records. */
  estimated_cost_cents?: number
}

const APICallLogSchema = new Schema<APICallLogDoc>(
  {
    api_call_log_id: { type: String, required: true, unique: true },
    user_id: { type: String, required: true },
    conversation_id: { type: String, required: true },
    team_id: { type: String, default: undefined },
    agent_id: { type: String, default: undefined },
    task_id: { type: String, default: undefined },
    run_id: { type: String, default: undefined },
    timestamp: { type: Date, default: Date.now },
    source: { type: String, required: true },
    model: { type: String, required: true },
    input_tokens: { type: Number, default: 0 },
    output_tokens: { type: Number, default: 0 },
    cache_creation_tokens: { type: Number, default: 0 },
    cache_read_tokens: { type: Number, default: 0 },
    total_effective_input_tokens: { type: Number, default: 0 },
    duration_ms: { type: Number, default: 0 },
    status: { type: String, enum: ['success', 'error', 'aborted'], default: 'success' },
    error_message: { type: String },
    tool_calls: { type: [String], default: [] },
    turn_number: { type: Number, default: 0 },
    request_body: { type: Schema.Types.Mixed },
    response_content: { type: [Schema.Types.Mixed], default: [] },
    response_stop_reason: { type: String, default: '' },
    request_body_size_bytes: { type: Number, default: 0 },
    estimated_cost_cents: { type: Number, default: 0 },
  },
  { timestamps: false }
)

APICallLogSchema.index({ user_id: 1, timestamp: -1 })
APICallLogSchema.index({ conversation_id: 1, timestamp: 1 })
APICallLogSchema.index({ timestamp: 1 })
APICallLogSchema.index(
  { team_id: 1, timestamp: -1 },
  { partialFilterExpression: { team_id: { $type: 'string' } } },
)
APICallLogSchema.index(
  { agent_id: 1, timestamp: -1 },
  { partialFilterExpression: { agent_id: { $type: 'string' } } },
)
APICallLogSchema.index(
  { task_id: 1, timestamp: -1 },
  { partialFilterExpression: { task_id: { $type: 'string' } } },
)
APICallLogSchema.index(
  { run_id: 1, timestamp: -1 },
  { partialFilterExpression: { run_id: { $type: 'string' } } },
)

function apiCallLogModel(): Model<APICallLogDoc> {
  const existing = mongoose.models.APICallLog as Model<APICallLogDoc> | undefined
  if (!existing) return mongoose.model<APICallLogDoc>('APICallLog', APICallLogSchema)

  // Next.js development keeps compiled models across module reloads. Patch
  // additive fields so strict mode does not silently discard V1 attribution
  // until the server is restarted.
  if (!existing.schema.path('team_id')) {
    existing.schema.add({ team_id: { type: String, default: undefined } })
  }
  if (!existing.schema.path('agent_id')) {
    existing.schema.add({ agent_id: { type: String, default: undefined } })
  }
  if (!existing.schema.path('task_id')) {
    existing.schema.add({ task_id: { type: String, default: undefined } })
  }
  if (!existing.schema.path('run_id')) {
    existing.schema.add({ run_id: { type: String, default: undefined } })
  }
  if (!existing.schema.path('estimated_cost_cents')) {
    existing.schema.add({ estimated_cost_cents: { type: Number, default: 0 } })
  }
  return existing
}

export const APICallLog = apiCallLogModel()

// ==================== Daily Usage ====================

export interface DailyUsageDoc {
  user_id: string
  date: string
  source: string
  model: string
  total_requests: number
  total_input_tokens: number
  total_output_tokens: number
  total_cache_creation: number
  total_cache_read: number
  total_effective_input: number
  estimated_cost_cents: number
}

const DailyUsageSchema = new Schema(
  {
    user_id: { type: String, required: true },
    date: { type: String, required: true },
    source: { type: String, required: true },
    model: { type: String, required: true },
    total_requests: { type: Number, default: 0 },
    total_input_tokens: { type: Number, default: 0 },
    total_output_tokens: { type: Number, default: 0 },
    total_cache_creation: { type: Number, default: 0 },
    total_cache_read: { type: Number, default: 0 },
    total_effective_input: { type: Number, default: 0 },
    estimated_cost_cents: { type: Number, default: 0 },
  },
  { timestamps: false }
)

DailyUsageSchema.index({ user_id: 1, date: 1, source: 1, model: 1 }, { unique: true })
DailyUsageSchema.index({ user_id: 1, date: -1 })

export const DailyUsage =
  mongoose.models.DailyUsage ||
  mongoose.model('DailyUsage', DailyUsageSchema)
