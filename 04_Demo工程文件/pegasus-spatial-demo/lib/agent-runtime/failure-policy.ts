import { createHash } from 'node:crypto'
import type {
  AgentRunFailureCategory,
  AgentRunFailureRecoverability,
  AgentRunTerminationReason,
} from './types'

export interface AgentRunFailureMetadata {
  failureRecoverability: AgentRunFailureRecoverability
  failureCategory: AgentRunFailureCategory
  failureSignature: string
}

interface ErrorLike {
  name?: unknown
  message?: unknown
  code?: unknown
  cause?: unknown
}

function safeErrorProperty(candidate: ErrorLike | undefined, key: keyof ErrorLike): unknown {
  if (!candidate) return undefined
  try {
    return candidate[key]
  } catch {
    return undefined
  }
}

function errorPart(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function errorDescriptor(error: unknown): string {
  if (!error || typeof error !== 'object') return errorPart(error) || 'unknown error'
  const candidate = error as ErrorLike
  const rawCause = safeErrorProperty(candidate, 'cause')
  const cause = rawCause && typeof rawCause === 'object'
    ? rawCause as ErrorLike
    : undefined
  return [
    errorPart(safeErrorProperty(candidate, 'name')),
    errorPart(safeErrorProperty(candidate, 'code')),
    errorPart(safeErrorProperty(candidate, 'message')),
    errorPart(safeErrorProperty(cause, 'name')),
    errorPart(safeErrorProperty(cause, 'code')),
    errorPart(safeErrorProperty(cause, 'message')),
  ].filter(Boolean).join('\n') || 'unknown error'
}

/**
 * Remove per-attempt identities before hashing so the same underlying failure
 * opens one circuit even when its message embeds a fresh Run/lease/UUID.
 */
function normalizedSignatureMaterial(value: string): string {
  return value
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b(?:run|agent|session|team|lease|fence)_[a-z0-9_-]{12,}\b/gi, '<identity>')
    .replace(/\b[0-9a-f]{24,}\b/gi, '<hex>')
    .replace(/\b\d{4,}\b/g, '<number>')
    .replace(/\s+/g, ' ')
    .trim()
}

export function agentRunFailureSignature(
  error: unknown,
  category: AgentRunFailureCategory,
): string {
  const material = `${category}\u0000${normalizedSignatureMaterial(errorDescriptor(error))}`
  return `run_failure_${createHash('sha256').update(material).digest('hex').slice(0, 32)}`
}

const CONFIGURATION_FAILURE = /(?:not configured|configuration|config(?:uration)? error|missing (?:api )?key|required environment|environment variable .* required|invalid api key|authentication failed|unauthori[sz]ed|forbidden|unknown model|model .* not (?:allowed|available)|signing secret .* not configured|no provider)/i
const IDENTITY_OR_INVARIANT_FAILURE = /(?:identity belongs|stale .*session|teamagent .* no longer exists|team that is completed|incomplete team execution identity|fence lost|lost .* fence|state fence|invariant|corrupt|e11000|duplicate key|active key|impossible state|disappeared while|err_invalid_arg_type)/i
const MESSAGE_FORMAT_FAILURE = /(?:message format|invalid message|tool_use.*tool_result|tool_result.*tool_use|json|seriali[sz]|schema|cannot read properties of undefined|request body|malformed)/i

/**
 * Classify one Root Run failure. Unknown single-Run/runtime faults fail open
 * to a contained idle Root; only explicit configuration and identity/invariant
 * failures are fatal. Repeated transient supervision failures are fenced by
 * the Runner's persisted same-signature circuit breaker.
 */
export function classifyAgentRunFailure(
  error: unknown,
  terminationReason: AgentRunTerminationReason,
): AgentRunFailureMetadata {
  const descriptor = errorDescriptor(error)
  let failureCategory: AgentRunFailureCategory
  let failureRecoverability: AgentRunFailureRecoverability

  if (terminationReason === 'max_turns') {
    failureCategory = 'run_limit'
    failureRecoverability = 'transient'
  } else if (IDENTITY_OR_INVARIANT_FAILURE.test(descriptor)) {
    failureCategory = 'identity_invariant'
    failureRecoverability = 'fatal'
  } else if (CONFIGURATION_FAILURE.test(descriptor)) {
    failureCategory = 'configuration'
    failureRecoverability = 'fatal'
  } else if (MESSAGE_FORMAT_FAILURE.test(descriptor)) {
    failureCategory = 'message_format'
    failureRecoverability = 'transient'
  } else if (terminationReason === 'model_error') {
    failureCategory = 'provider_transient'
    failureRecoverability = 'transient'
  } else {
    failureCategory = 'runtime_transient'
    failureRecoverability = 'transient'
  }

  return {
    failureRecoverability,
    failureCategory,
    failureSignature: agentRunFailureSignature(error, failureCategory),
  }
}

export function fatalAgentRunFailure(
  error: unknown,
  category: Extract<AgentRunFailureCategory, 'configuration' | 'identity_invariant'> = 'identity_invariant',
): AgentRunFailureMetadata {
  return {
    failureRecoverability: 'fatal',
    failureCategory: category,
    failureSignature: agentRunFailureSignature(error, category),
  }
}

export function persistedFailureSignature(input: {
  failure_signature?: string | null
  failure_category?: AgentRunFailureCategory | null
  last_error?: string | null
  termination_reason?: AgentRunTerminationReason | null
}): string {
  if (input.failure_signature) return input.failure_signature
  const category = input.failure_category
    ?? (input.termination_reason === 'model_error' ? 'provider_transient' : 'runtime_transient')
  return agentRunFailureSignature(input.last_error ?? input.termination_reason ?? 'unknown error', category)
}
